// Decision latency benchmark. The platform's turn timeout is 500 ms for
// uploaded bots; we hard-assert max < 450 ms across representative spots,
// including cold-start preflop (worst case: Monte Carlo cache miss).

import assert from 'node:assert/strict'
import { WolfBot } from '../src/wolfBot.js'
import { makeRng } from '../src/rng.js'

const C = (s) => ({ rank: s[0], suit: s[1] })
const ER = { T: 10, J: 11, Q: 12, K: 13, A: 14 }

function state(overrides = {}) {
  return {
    handNumber: 1,
    phase: 'preflop',
    holeCards: [C('Ah'), C('7d')],
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
    actionHistory: [],
    roundId: 'r-bench',
    requestId: 'req-1',
    ...overrides,
  }
}

const spots = {
  'preflop HU (cold cache)': state({ holeCards: [C('Kd'), C('Qs')] }),
  'preflop 6max': state({
    holeCards: [C('9c'), C('8d')],
    opponentStacks: [980, 960, 940, 920, 900],
    yourSeat: 3,
    dealerSeat: 0,
    pot: 45,
    toCall: 15,
  }),
  'flop HU': state({
    phase: 'flop',
    holeCards: [C('Ah'), C('7d')],
    board: [C('Ad'), C('8c'), C('2s')],
    pot: 60,
    toCall: 0,
    minRaise: 30,
    validActions: ['check', 'raise'],
  }),
  'turn 6max': state({
    phase: 'turn',
    holeCards: [C('Jh'), C('Th')],
    board: [C('9h'), C('2d'), C('7c'), C('Ks')],
    opponentStacks: [880, 760, 640, 520, 400],
    yourSeat: 2,
    dealerSeat: 4,
    pot: 240,
    toCall: 80,
    minRaise: 160,
    validActions: ['fold', 'call', 'raise'],
  }),
  'river 6max shove': state({
    phase: 'river',
    holeCards: [C('Jh'), C('Th')],
    board: [C('9h'), C('2d'), C('7c'), C('Ks'), C('Qc')],
    opponentStacks: [500, 400, 300, 200, 100],
    yourSeat: 2,
    dealerSeat: 4,
    pot: 1200,
    toCall: 400,
    minRaise: 0,
    maxRaise: 0,
    validActions: ['fold', 'call'],
  }),
}

const bot = new WolfBot()
let worst = 0

for (const [name, s] of Object.entries(spots)) {
  const times = []
  const N = 30
  for (let i = 0; i < N; i++) {
    const t0 = performance.now()
    const a = bot.decide({ ...s, handNumber: s.handNumber + i, roundId: `r${i}` })
    times.push(performance.now() - t0)
    assert.ok(s.validActions.includes(a.action))
  }
  times.sort((a, b) => a - b)
  const p50 = times[Math.floor(N * 0.5)]
  const p95 = times[Math.floor(N * 0.95)]
  const max = times[N - 1]
  worst = Math.max(worst, max)
  console.log(
    `${name.padEnd(26)} p50 ${p50.toFixed(0).padStart(4)}ms  p95 ${p95.toFixed(0).padStart(4)}ms  max ${max.toFixed(0).padStart(4)}ms`,
  )
}

console.log(`\nworst overall: ${worst.toFixed(0)}ms`)
assert.ok(worst < 450, `worst decision ${worst.toFixed(0)}ms exceeds the 450ms safety line`)
console.log('OK — all spots comfortably inside the 500ms platform budget')
