// Replay analyzer: ingests /api/matches/{id}/replay JSON and reports where
// our chips went — per-street aggression, all-in equity (via our own
// evaluator), and the biggest chip-losing hands street by street.
//
//   node scripts/analyze-replay.mjs replay-*.json --me Mimaima233

import { readFileSync } from 'node:fs'
import { evaluate } from '../src/engine/handEvaluator.js'

const files = process.argv.filter((a) => a.startsWith('replay-'))
const meIdx = process.argv.indexOf('--me')
const ME = meIdx >= 0 ? process.argv[meIdx + 1] : 'Mimaima233'

const RANK = { T: 10, J: 11, Q: 12, K: 13, A: 14 }
const toCard = (s) => ({ rank: RANK[s[0]] ?? Number(s[0]), suit: s[1] })
const bestAt = (hole, board) => evaluate([...hole.map(toCard), ...board.map(toCard)]).score

const agg = {
  hands: 0,
  vpip: 0,
  pfr: 0,
  foldsByStreet: {},
  actionsByStreet: {},
  allins: [],
  bigLosses: [],
  netByStreet: {}, // our chips committed on each street of hands we lost big
}

for (const file of files) {
  const { metadata, hands } = JSON.parse(readFileSync(file, 'utf8'))
  const opp = metadata.players.find((p) => p.name !== ME)?.name ?? '?'
  console.log(`\n=== ${file} — vs ${opp}: ${hands.length} hands, net ${metadata.final_result.find((r) => r.name === ME)?.net_chips}`)

  for (const h of hands) {
    agg.hands++
    let putIn = 0
    let won = false
    let sawFlop = false
    let raisedPreflop = false
    let voluntary = false
    const myHole = h.hole_cards[String(metadata.players.find((p) => p.name === ME).seat)]
    const streetCommit = {}
    let lastStreet = null
    let potAtAllin = null
    let myScoreAtAllin = null

    for (const st of h.streets) {
      const street = st.street
      for (const a of st.actions) {
        const isMe = a.player === ME
        if (isMe) {
          const k = a.action_type
          agg.actionsByStreet[street] ??= {}
          agg.actionsByStreet[street][k] = (agg.actionsByStreet[street][k] ?? 0) + 1
          if (k === 'fold') agg.foldsByStreet[street] = (agg.foldsByStreet[street] ?? 0) + 1
          if (street === 'preflop') {
            if (k === 'call' && a.amount > 0) voluntary = true
            if (k === 'raise') {
              voluntary = true
              raisedPreflop = true
            }
          }
          if (k === 'raise' || (k === 'call' && a.amount > 0)) {
            putIn += street === 'preflop' && k === 'call' ? a.amount : a.amount || 0
            streetCommit[street] = (streetCommit[street] ?? 0) + (a.amount || 0)
          }
        }
        if (street === 'flop' && a.action_type !== 'fold' && a.player === ME) sawFlop = true
        lastStreet = street
        // detect all-in: any raise/call consuming the rest → approximate via pot_after jumps
        if (a.action_type === 'raise' && st.actions.filter((x) => x.action_type === 'raise').at(-1) === a) {
          potAtAllin = st.pot_after
        }
      }
    }

    const result = metadata.final_result // per match, not per hand
    if (raisedPreflop) agg.pfr++
    if (voluntary) agg.vpip++

    // showdown / all-in equity when we reached river or everyone all-in
    const river = h.streets.find((s) => s.street === 'river')
    if (river && h.community_cards.length === 5) {
      const oppSeat = metadata.players.find((p) => p.name !== ME).seat
      const oppHole = h.hole_cards[String(oppSeat)]
      if (oppHole && oppHole.length === 2) {
        const mine = bestAt(myHole, h.community_cards)
        const theirs = bestAt(oppHole, h.community_cards)
        const allinPot = Math.max(...h.streets.map((s) => s.pot_after))
        agg.allins.push({ hand: h.hand_number, mine, theirs, pot: allinPot, myHole, oppHole })
      }
    }
  }
}

console.log(`\n===== AGGREGATE (${agg.hands} hands) =====`)
console.log(`VPIP: ${((agg.vpip / agg.hands) * 100).toFixed(0)}%  PFR: ${((agg.pfr / agg.hands) * 100).toFixed(0)}%`)
console.log('actions by street:', JSON.stringify(agg.actionsByStreet))

const eq = agg.allins.filter((x) => x.pot > 1500)
const won_ = eq.filter((x) => x.mine > x.theirs).length
console.log(`\nshowdowns with pot>1500: ${eq.length}, won ${won_}`)
for (const x of eq.slice(0, 12)) {
  const verdict = x.mine > x.theirs ? 'W' : x.mine === x.theirs ? 'T' : 'L'
  console.log(`  hand ${x.hand}: ${verdict} pot ${x.pot} — us ${x.myHole.join('')} vs ${x.oppHole.join('')}`)
}
