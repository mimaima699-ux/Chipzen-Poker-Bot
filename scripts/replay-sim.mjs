// Replay simulator: drives the FULL production stack (GameState → adapter →
// tracker → engine) through a real platform replay, decision by decision.
// The selfplay harness calls the engine directly, so adapter/tracker bugs
// never show up there — this closes that gap with ground-truth matches.
//
//   node scripts/replay-sim.mjs replay-a447034b.json --me Mimaima699-Pro
//
// Reports the strategy profile OUR stack would have played (VPIP/PFR), which
// for the Fold-ver-3 loss should now show stealing instead of limping.

import { readFileSync } from 'node:fs'
import { TableTracker } from '../src/tracker.js'
import { decideAction } from '../src/adapter.js'
import { makeRng } from '../src/rng.js'

const file = process.argv.find((a) => a.startsWith('replay-'))
const meIdx = process.argv.indexOf('--me')
const ME = meIdx >= 0 ? process.argv[meIdx + 1] : 'Mimaima699-Pro'

const replay = JSON.parse(readFileSync(file, 'utf8'))
const players = replay.metadata.players
const me = players.find((p) => p.name === ME)
const opp = players.find((p) => p.name !== ME)
const START_STACK = 5000

// Reconstruct wire-ish GameStates at every point where WE had to act.
const tracker = new TableTracker()
tracker.onMatch({ data: { game_config: { small_blind: 50, big_blind: 100 } } })

let vpip = 0
let pfr = 0
let hands = 0
let lastHand = -1
const actionCounts = {}

for (const hand of replay.hands) {
  // per-hand reconstruction state
  const stacks = new Map(players.map((p) => [p.seat, START_STACK]))
  const committed = new Map() // seat → this-street chips
  const board = []
  let pot = 0
  let streetMax = 0
  let handCommitted = { me: false, meRaised: false }
  hands++
  tracker.newHand({ data: { num_players: players.length, your_seat: me.seat } })

  // flat chronological action list with street context
  const actions = []
  for (const st of hand.streets) {
    for (const a of st.actions) {
      actions.push({ ...a, street: st.street, boardLen: board.length })
    }
    // advance the board AFTER the street's actions (community_cards on the
    // street entry describe the cards dealt AT that street's start)
    if (st.street === 'flop') board.push(...(st.community_cards ?? []))
    if (st.street === 'turn' || st.street === 'river') board.push(...(st.community_cards ?? []))
  }

  // Rebuild the actionHistory the way turn_requests would expose it
  const history = []
  let lastStreet = 'preflop'

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]
    // simulate the broadcast channel: phase changes + one turn_result per action
    if (a.street !== lastStreet) {
      tracker.setPhase({ data: { phase: a.street } })
      lastStreet = a.street
    }
    tracker.record({ data: { seat: a.seat, action: a.action_type, amount: a.amount ?? 0 } })
    // feed history incrementally (as successive turn_requests would)
    history.push({ seat: a.seat, action: a.action_type, amount: a.amount ?? 0 })

    // apply the action to our reconstruction
    if (a.action_type.startsWith('post_') || a.action_type === 'raise' || a.action_type === 'call') {
      const isRaise = a.action_type === 'raise'
      const prev = committed.get(a.seat) ?? 0
      const put = isRaise ? Math.max(0, (a.amount ?? 0) - prev) : a.action_type === 'call' ? (a.amount ?? 0) : a.amount ?? 0
      stacks.set(a.seat, stacks.get(a.seat) - put)
      committed.set(a.seat, (committed.get(a.seat) ?? 0) + put)
      pot += put
      if (isRaise || a.action_type.startsWith('post_')) {
        streetMax = Math.max(streetMax, a.amount ?? 0)
      }
      if (a.action_type === 'raise') streetMax = Math.max(streetMax, a.amount ?? 0)
    }

    if (a.player !== ME || a.action_type.startsWith('post_')) continue
    // OUR decision point: build the GameState we would have received
    const myBet = committed.get(me.seat) ?? 0
    const toCall = Math.max(0, streetMax - myBet)
    const stack = stacks.get(me.seat)
    const canRaise = stack > toCall
    const valid = toCall > 0 ? ['fold', 'call', ...(canRaise ? ['raise'] : [])] : ['check', ...(canRaise ? ['raise'] : [])]
    const state = {
      handNumber: hand.hand_number,
      phase: a.street === 'preflop' ? 'preflop' : a.street,
      holeCards: hand.hole_cards[String(me.seat)].map((s) => ({ rank: s[0], suit: s[1] })),
      board: board.map((s) => ({ rank: s[0], suit: s[1] })),
      pot,
      yourStack: stack,
      opponentStacks: [stacks.get(opp.seat)],
      yourSeat: me.seat,
      dealerSeat: hand.streets[0].actions[0].seat === me.seat ? me.seat : opp.seat,
      toCall,
      minRaise: Math.min(streetMax + 100, myBet + stack),
      maxRaise: myBet + stack,
      validActions: valid,
      actionHistory: [...history],
      roundId: 'replay',
      requestId: 'r',
    }
    const { action } = decideAction(state, tracker, makeRng('sim', hand.hand_number, i))
    actionCounts[a.street] ??= {}
    actionCounts[a.street][action.action] = (actionCounts[a.street][action.action] ?? 0) + 1
    if (a.street === 'preflop' && action.action !== 'check') {
      if (action.action === 'raise') {
        vpip++
        pfr++
        handCommitted.meRaised = true
      } else if (action.action === 'call') vpip++
    }
    // no break: the replay continues with ITS action, and every later
    // broadcast still feeds the hook channel — hand-ending folds included
  }
  // hand over — round_result broadcast commits profiles
  tracker.commitHand({})
}

console.log(`\n[file] ${file} vs ${opp.name}: ${hands} hands`)
console.log('our action profile (production stack):', JSON.stringify(actionCounts))
console.log(`PFR: ${((pfr / hands) * 100).toFixed(0)}%  VPIP-rough: ${((vpip / hands) * 100).toFixed(0)}%`)
console.log('diag:', JSON.stringify(tracker.diag))
const o = tracker.profile(opp.seat)
console.log('opp profile:', JSON.stringify(o))
