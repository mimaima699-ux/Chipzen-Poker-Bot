// A/B self-play harness: drives the wolf-game poker engine with two decision
// functions playing against each other, mimicking Chipzen's format
// (escalating blinds, play until one side has all the chips).
//
// Both sides receive IDENTICAL context (no profiles) and IDENTICAL wall-clock
// equity budgets, so measured differences come from decision logic only.
//
//   node scripts/selfplay.mjs --mode hu --matches 20 --tag run1
//   node scripts/selfplay.mjs --mode sixmax --matches 8

import { PokerGame } from '../../poker/server/src/game/gameEngine.js'
import * as v1mod from '../src/engine/aiPlayerV1.js'
import * as v2mod from '../src/engine/aiPlayerV2.js'
import * as v3mod from '../src/engine/aiPlayer.js'
import * as v5mod from '../src/engine/aiPlayerV5.js'
import { makeRng } from '../src/rng.js'

// A minimal "Fold-ver-2" style opponent: folds to any bet, checks otherwise.
// Any serious bot must crush this ~100% — losing to it on the platform was
// the original red flag.
const foldBot = () => (ctx) => (ctx.toCall > 0 ? { type: 'fold' } : { type: 'check' })

const VERSIONS = { v1: v1mod.decide, v2: v2mod.decide, v3: v3mod.decide, v5: v5mod.decide, fold: foldBot() }

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter((x) => x.length),
)
const MODE = args.mode === 'sixmax' ? 'sixmax' : 'hu'
const MATCHES = Number(args.matches ?? 20)
const SIDE_A = args.a ?? 'v2'
const SIDE_B = args.b ?? 'v3'
const TAG = args.tag ?? `${MODE}`
const BLIND_LEVEL_HANDS = 40
const HAND_CAP = 600
// Equal, tight equity budgets keep a full A/B session under ~15 min.
const DECIDE_BUDGET_MS = 12

function buildCtx(game, p, rng, profiles, raisedPreflop) {
  const n = game.players.length
  const dealerIdx = game.dealerIndex
  const offset = (game.players.indexOf(p) - dealerIdx + n) % n
  const actIndex = offset === 0 ? n - 1 : offset - 1
  const legal = game.getLegalActions(p.id)
  return {
    hole: p.hole,
    community: game.community,
    toCall: legal.toCall,
    currentBet: game.streetBet,
    potSize: game.potForDisplay(),
    stack: p.chips,
    legal: { canRaise: legal.canRaise, raiseMin: legal.raiseMin, raiseMax: legal.raiseMax },
    position: actIndex / (n - 1),
    bigBlind: game.bigBlind,
    opponents: game.players
      .filter((q) => q.id !== p.id)
      .map((q) => ({
        seat: q.seat,
        stack: q.chips,
        folded: q.folded,
        profile: profiles.get(q.id) ?? null,
        preflopRaised: raisedPreflop.has(q.id),
        betThisStreet: game.community.length > 0 && q.bet > 0,
        raisedThisStreet: game.community.length > 0 && q.bet >= game.streetBet && game.streetBet > 0,
      })),
    rng,
    deadline: Date.now() + DECIDE_BUDGET_MS,
  }
}

function playersFor(mode) {
  if (mode === 'hu') {
    // Seat parity alternates across matches so dealer-button asymmetry cancels
    return [
      { id: 'A', name: SIDE_A, seat: 0, chips: 1000, version: 1 },
      { id: 'B', name: SIDE_B, seat: 1, chips: 1000, version: 2 },
    ]
  }
  return [
    { id: 'A1', name: SIDE_A, seat: 0, chips: 1000, version: 1 },
    { id: 'B1', name: SIDE_B, seat: 1, chips: 1000, version: 2 },
    { id: 'A2', name: SIDE_A, seat: 2, chips: 1000, version: 1 },
    { id: 'B2', name: SIDE_B, seat: 3, chips: 1000, version: 2 },
    { id: 'A3', name: SIDE_A, seat: 4, chips: 1000, version: 1 },
    { id: 'B3', name: SIDE_B, seat: 5, chips: 1000, version: 2 },
  ]
}

function playMatch(mode, matchIndex) {
  const decideFor = { 1: VERSIONS[SIDE_A], 2: VERSIONS[SIDE_B] }
  const spec = playersFor(mode).map((p) => (matchIndex % 2 === 1 && mode === 'hu' ? { ...p, version: p.version === 1 ? 2 : 1 } : p))
  let game = new PokerGame({
    players: spec.map(({ id, name, seat, chips }) => ({ id, name, seat, chips })),
    smallBlind: 5,
    bigBlind: 10,
    rng: makeRng(TAG, 'deck', matchIndex),
  })
  const versionOf = new Map(spec.map((p) => [p.id, p.version]))

  let hands = 0
  let v2NetBB = 0
  const bustOrder = [] // ids as they busted — first out gets the worst rank
  // Minimal opponent profiles — same shape the Chipzen tracker feeds the bot,
  // so fold-EQ/range modeling is exercised here exactly as in production.
  const profiles = new Map(game.players.map((p) => [p.id, { hands: 0, vpip: 0, pfr: 0, facedBet: 0, foldedToBet: 0 }]))
  while (hands < HAND_CAP) {
    game.smallBlind = 5 * 2 ** Math.floor(hands / BLIND_LEVEL_HANDS)
    game.bigBlind = 2 * game.smallBlind
    game.minRaise = game.bigBlind
    const before = game.players.reduce((s, p) => s + p.chips, 0)
    const v2Before = game.players.filter((p) => versionOf.get(p.id) === 2).reduce((s, p) => s + p.chips, 0)
    game.startHand()
    hands++
    const raisedPreflop = new Set()
    const dealt = game.players.map((p) => p.id)
    const handProfiles = dealt.map((id) => profiles.get(id)).filter(Boolean)
    for (const prof of handProfiles) prof.hands++

    let guard = 0
    while (game.phase !== 'handEnd') {
      const actor = game.currentActor
      if (!actor) break
      const rng = makeRng(TAG, matchIndex, hands, game.handNumber, actor.id, guard)
      const ctx = buildCtx(game, actor, rng, profiles, raisedPreflop)
      let choice = null
      try {
        choice = decideFor[versionOf.get(actor.id)](ctx)
      } catch (err) {
        console.error(`decide error match=${matchIndex} hand=${hands} ${actor.id}:`, String(err))
        choice = { type: 'check' }
      }
      const phaseBefore = game.phase // act() may advance the street
      const res = game.act(actor.id, choice)
      if (!res.ok) {
        // Should never happen — abort the match loudly rather than poison data
        throw new Error(`illegal action ${actor.id} ${JSON.stringify(choice)}: ${res.error}`)
      }
      // observe for profiling
      const prof = profiles.get(actor.id)
      if (prof) {
        const t = choice.type
        if (phaseBefore === 'preflop') {
          if (t === 'raise') {
            prof.vpip++
            prof.pfr++
            raisedPreflop.add(actor.id)
          } else if (t === 'call') prof.vpip++
          if (ctx.toCall > 0 && t === 'fold') {
            // preflop fold facing a bet — the stat fold-vs-folder models
            // hinge on (mirrors the tracker.js fix)
            prof.facedBet++
            prof.foldedToBet++
          }
        } else if (ctx.toCall > 0) {
          // count folds-to-bet on every street, matching the tracker's fix
          prof.facedBet++
          if (t === 'fold') prof.foldedToBet++
        }
      }
      if (++guard > 500) throw new Error('action loop guard tripped')
    }

    const after = game.players.reduce((s, p) => s + p.chips, 0)
    if (before !== after) throw new Error(`chip conservation violated hand=${hands} ${before}→${after}`)
    const v2After = game.players.filter((p) => versionOf.get(p.id) === 2).reduce((s, p) => s + p.chips, 0)
    v2NetBB += (v2After - v2Before) / game.bigBlind

    const alive = game.players.filter((p) => p.chips > 0)
    if (alive.length <= 1) break
    if (alive.length < game.players.length) {
      // Someone busted but the match continues (6-max): rebuild without them,
      // keeping dealer rotation continuous
      for (const gone of game.players.filter((p) => p.chips <= 0)) bustOrder.push(gone.id)
      game = new PokerGame({
        players: alive.map((p) => ({ id: p.id, name: p.name, seat: p.seat, chips: p.chips })),
        smallBlind: game.smallBlind,
        bigBlind: game.bigBlind,
        rng: makeRng(TAG, 'deck', matchIndex),
        initialDealerIndex: game.dealerIndex + 1,
      })
      game.minRaise = game.bigBlind
      // keep the same blind level across the rebuild
      game.smallBlind = 5 * 2 ** Math.floor((hands - 1) / BLIND_LEVEL_HANDS)
      game.bigBlind = 2 * game.smallBlind
      game.minRaise = game.bigBlind
      game.handNumber = hands
    }
  }

  // Rank everyone: survivors by chips, then bust-out order reversed
  const survivors = [...game.players].sort((a, b) => b.chips - a.chips)
  const ranked = [
    ...survivors.map((p, i) => ({ id: p.id, version: versionOf.get(p.id), rank: i + 1, chips: p.chips })),
    ...[...bustOrder].reverse().map((id, i) => ({ id, version: versionOf.get(id), rank: survivors.length + 1 + i, chips: 0 })),
  ]
  return { hands, finals: ranked, v2NetBB }
}

// --- run -------------------------------------------------------------------

const matchResults = []
const t0 = Date.now()
for (let m = 0; m < MATCHES; m++) {
  const r = playMatch(MODE, m)
  matchResults.push(r)
  if (MODE === 'hu') {
    const [a, b] = r.finals
    const winner = a.chips > b.chips ? a : b
    console.log(`match ${m + 1}/${MATCHES}: v${winner.version} wins, ${r.hands} hands, final ${a.chips}/${b.chips}`)
  } else {
    console.log(`match ${m + 1}/${MATCHES}: ${r.hands} hands, finals ${r.finals.map((f) => `v${f.version}:${f.chips}`).join(' ')}`)
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(0)
const totalHands = matchResults.reduce((s, r) => s + r.hands, 0)
const netBB = matchResults.reduce((s, r) => s + r.v2NetBB, 0)
const bb100 = (netBB / totalHands) * 100
// Rough standard error for bb/100: per-hand bb std ≈ 8 HU / 6 six-max
const seBB100 = ((MODE === 'hu' ? 8 : 6) * 100) / Math.sqrt(totalHands)
if (MODE === 'hu') {
  const bWins = matchResults.filter((r) => r.finals.find((f) => f.version === 2).chips > r.finals.find((f) => f.version === 1).chips).length
  const ties = matchResults.filter((r) => r.finals[0].chips === r.finals[1].chips).length
  const p = bWins / MATCHES
  const ci = 1.96 * Math.sqrt(Math.max(p * (1 - p), 1e-6) / MATCHES)
  console.log(`\n[HU] ${SIDE_B} match wins: ${bWins}/${MATCHES} (ties ${ties}) = ${(p * 100).toFixed(1)}% ± ${(ci * 100).toFixed(1)}%`)
  console.log(`${SIDE_B} win rate: ${bb100.toFixed(1)} bb/100 ± ${seBB100.toFixed(1)} (0 = parity)`)
  console.log(`total hands: ${totalHands}, wall time: ${secs}s`)
  console.log(p - ci > 0.5 ? `=> ${SIDE_B} is SIGNIFICANTLY stronger` : p + ci < 0.5 ? `=> ${SIDE_A} is SIGNIFICANTLY stronger` : '=> no significant difference yet')
} else {
  // v2 average finishing position (1 = most chips); parity is 3.5
  const seats = matchResults.flatMap((r) => r.finals.map((f) => ({ version: f.version, rank: f.rank })))
  const avgB = seats.filter((s) => s.version === 2).reduce((s, x) => s + x.rank, 0) / seats.filter((s) => s.version === 2).length
  const avgA = seats.filter((s) => s.version === 1).reduce((s, x) => s + x.rank, 0) / seats.filter((s) => s.version === 1).length
  console.log(`\n[6MAX] avg finish — ${SIDE_A}: ${avgA.toFixed(2)}  ${SIDE_B}: ${avgB.toFixed(2)}  (parity = 3.50)`)
  console.log(`${SIDE_B} win rate: ${bb100.toFixed(1)} bb/100 ± ${seBB100.toFixed(1)} (0 = parity)`)
  console.log(`wall time: ${secs}s`)
}
