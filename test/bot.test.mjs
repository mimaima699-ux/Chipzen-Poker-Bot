// Unit tests: adapter mapping, tracker bookkeeping, legality guarantees, and
// the SDK's protocol-conformance harness. Run with `npm test` (node --test).

import test from 'node:test'
import assert from 'node:assert/strict'
import { toEngineCard, positionFromSeats, decideAction, toAction } from '../src/adapter.js'
import { TableTracker } from '../src/tracker.js'
import { makeRng } from '../src/rng.js'
import { WolfBot } from '../src/wolfBot.js'

const C = (s) => ({ rank: s[0], suit: s[1] }) // 'Ah' → {rank:'A', suit:'h'}

function state(overrides = {}) {
  return {
    handNumber: 1,
    phase: 'preflop',
    holeCards: [C('Ah'), C('Ad')],
    board: [],
    pot: 15,
    yourStack: 990,
    opponentStacks: [985],
    yourSeat: 0,
    dealerSeat: 1,
    toCall: 5,
    minRaise: 20,
    maxRaise: 990,
    validActions: ['fold', 'call', 'raise'],
    actionHistory: [
      { seat: 0, action: 'post_small_blind', amount: 5 },
      { seat: 1, action: 'post_big_blind', amount: 10 },
    ],
    roundId: 'r-test',
    requestId: 'req-1',
    ...overrides,
  }
}

const rng = () => makeRng('test')

// --- card conversion --------------------------------------------------------

test('wire cards convert to engine cards', () => {
  assert.deepEqual(toEngineCard(C('Ah')), { rank: 14, suit: 'h' })
  assert.deepEqual(toEngineCard(C('Tc')), { rank: 10, suit: 'c' })
  assert.deepEqual(toEngineCard(C('2d')), { rank: 2, suit: 'd' })
  assert.throws(() => toEngineCard({ rank: 'X', suit: 'h' }))
})

// --- position ---------------------------------------------------------------

test('button acts last, small blind first', () => {
  assert.equal(positionFromSeats(0, 0, 6), 1) // button → 1
  assert.equal(positionFromSeats(1, 0, 6), 0) // SB → first postflop
  assert.ok(positionFromSeats(5, 0, 6) > 0.7) // cutoff → late
  assert.equal(positionFromSeats(1, 1, 2), 1) // HU: dealer=1 is the button/SB, acts last postflop
  assert.equal(positionFromSeats(0, 1, 2), 0) // HU BB (seat 0, dealer is 1) acts first postflop
})

// --- legality guarantees ----------------------------------------------------

function assertLegal(action, s) {
  assert.ok(s.validActions.includes(action.action), `action ${action.action} must be in validActions`)
  if (action.action === 'raise') {
    assert.ok(action.amount >= s.minRaise, `raise ${action.amount} >= minRaise ${s.minRaise}`)
    assert.ok(action.amount <= s.maxRaise, `raise ${action.amount} <= maxRaise ${s.maxRaise}`)
    assert.ok(Number.isInteger(action.amount), 'raise amount is an integer')
  }
}

test('never folds when check is legal', () => {
  const s = state({ toCall: 0, validActions: ['check', 'raise'] })
  const bot = new WolfBot()
  const a = bot.decide(s)
  assert.notEqual(a.action, 'fold')
  assertLegal(a, s)
})

test('premium pair preflop opens for a raise', () => {
  const s = state({ validActions: ['fold', 'call', 'raise'] })
  const { action } = decideAction(s, new TableTracker(), rng())
  assert.equal(action.action, 'raise')
  assertLegal(action, s)
})

test('trash folds facing a big bet, call stays legal-only', () => {
  const s = state({
    handNumber: 7,
    holeCards: [C('7d'), C('2c')],
    toCall: 400,
    pot: 600,
    validActions: ['fold', 'call', 'raise'],
  })
  const { action } = decideAction(s, new TableTracker(), rng())
  assertLegal(action, s)
  assert.equal(action.action, 'fold')
})

test('flop value bet on wet board stays within raise bounds', () => {
  const s = state({
    phase: 'flop',
    holeCards: [C('Ah'), C('Kh')],
    board: [C('Qh'), C('Jh'), C('2h')],
    pot: 30,
    toCall: 0,
    minRaise: 20,
    maxRaise: 980,
    validActions: ['check', 'raise'],
  })
  const { action } = decideAction(s, new TableTracker(), rng())
  assertLegal(action, s)
})

test('river facing shove with weak hand folds', () => {
  const s = state({
    phase: 'river',
    holeCards: [C('7d'), C('2c')],
    board: [C('Ah'), C('Kd'), C('9s'), C('5c'), C('3h')],
    pot: 800,
    toCall: 600,
    yourStack: 600,
    minRaise: 0,
    maxRaise: 0,
    validActions: ['fold', 'call'],
  })
  const { action } = decideAction(s, new TableTracker(), rng())
  assertLegal(action, s)
  assert.equal(action.action, 'fold')
})

test('6-max: raise clamped when maxRaise is a short stack', () => {
  const s = state({
    opponentStacks: [990, 500, 200, 100, 50],
    yourSeat: 3,
    dealerSeat: 0,
    toCall: 60,
    pot: 120,
    minRaise: 120,
    maxRaise: 180,
    validActions: ['fold', 'call', 'raise'],
  })
  const { action } = decideAction(s, new TableTracker(), rng())
  assertLegal(action, s)
})

test('toAction falls back safely when raise is not offered', () => {
  const s = state({ validActions: ['fold', 'call', 'check'], toCall: 10 })
  const a = toAction({ type: 'raise', amount: 999 }, s)
  assert.ok(['check', 'call', 'fold'].includes(a.action))
  assertLegal(a, s)
})

test('decide survives engine errors via fallback', () => {
  const bad = { holeCards: 'garbage' } // will throw inside the engine adapter
  const s = state(bad)
  const { action } = decideAction({ ...s, holeCards: 'garbage' }, new TableTracker(), rng())
  assert.ok(s.validActions.includes(action.action))
})

// --- tracker ----------------------------------------------------------------

test('tracker: actionHistory-driven profiles (the production channel)', () => {
  const t = new TableTracker()
  t.onMatch({ data: { game_config: { big_blind: 20, small_blind: 10 } } })
  t.newHand({ data: { num_players: 2, your_seat: 0 } })
  const preflop = [
    { seat: 0, action: 'post_small_blind', amount: 10 },
    { seat: 1, action: 'post_big_blind', amount: 20 },
    { seat: 0, action: 'raise', amount: 60 },
    { seat: 1, action: 'call', amount: 60 },
  ]
  // preflop request (empty board) then flop request carrying the full history
  t.ingestRequest({ handNumber: 3, board: [], actionHistory: preflop })
  const flopBoard = [{ rank: 14, suit: 'h' }, { rank: 13, suit: 'd' }, { rank: 2, suit: 'c' }]
  t.ingestRequest({
    handNumber: 3,
    board: flopBoard,
    actionHistory: [...preflop, { seat: 0, action: 'raise', amount: 40 }, { seat: 1, action: 'fold' }],
  })
  // next hand's first request commits the sequence into profiles
  t.ingestRequest({ handNumber: 4, board: [], actionHistory: [{ seat: 0, action: 'post_small_blind', amount: 10 }] })

  const p1 = t.profile(1)
  assert.equal(p1.hands, 1)
  assert.equal(p1.vpip, 1, 'preflop call counts as VPIP')
  assert.equal(p1.pfr, 0)
  assert.equal(p1.facedBet, 1, 'folding to the flop bet counts as faced')
  assert.equal(p1.foldedToBet, 1)
  const p0 = t.profile(0) // our own seat stays unprofiled
  assert.equal(p0.hands, 0)
  assert.equal(t.bigBlind, 20)
})

test('tracker: hook street bookkeeping still works for decision context', () => {
  const t = new TableTracker()
  t.onMatch({ data: { game_config: { big_blind: 20, small_blind: 10 } } })
  t.newHand({ data: { num_players: 2, your_seat: 0 } })
  t.record({ data: { seat: 0, action: 'post_small_blind', amount: 10 } })
  t.record({ data: { seat: 1, action: 'post_big_blind', amount: 20 } })
  assert.equal(t.streetMaxBet, 20, 'big blind sets the preflop street max')
  t.record({ data: { seat: 0, action: 'raise', amount: 60 } })
  t.record({ data: { seat: 1, action: 'call', amount: 60 } })
  t.setPhase({ data: { phase: 'flop' } })
  assert.equal(t.streetMaxBet, 0, 'phase change resets street bets')
  assert.equal(t.currentStreetBet({ phase: 'flop', toCall: 0 }), 0)
  t.record({ data: { seat: 0, action: 'bet', amount: 40 } })
  t.record({ data: { seat: 1, action: 'fold' } })
  const opps = t.opponentsFor(state({ yourSeat: 0 }))
  assert.equal(opps.length, 1)
  assert.equal(opps[0].seat, 1)
  assert.equal(opps[0].folded, true)
  assert.equal(opps[0].preflopRaised, false)
})

test('tracker: preflop currentBet falls back to big blind', () => {
  const t = new TableTracker()
  t.onMatch({ game_config: { big_blind: 50 } })
  assert.equal(t.currentStreetBet({ phase: 'preflop', toCall: 25 }), 50)
})

// --- conformance ------------------------------------------------------------

test('SDK conformance harness passes', { timeout: 60000 }, async () => {
  const { runConformanceChecks } = await import('@chipzen-ai/bot')
  const results = await runConformanceChecks(new WolfBot())
  for (const r of results) assert.notEqual(r.severity, 'fail', `${r.name}: ${r.message}`)
})
