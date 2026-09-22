// Wolf Bot — Chipzen Season 7 entry point.
//
// Contract (DEV-MANUAL §Container): the platform runs this file with
// CHIPZEN_WS_URL (match WebSocket endpoint) and CHIPZEN_TOKEN in the
// environment. Strategy core is the equity-driven engine from the wolf game
// poker project; the adapter/tracker layer lives in src/.
//
// The WolfBot class is defined here (not in src/) because the platform's
// pre-upload validator greps the entry point for a class extending Bot.

import { Bot, runBot } from '@chipzen-ai/bot'
import { pathToFileURL } from 'node:url'
import { TableTracker } from './src/tracker.js'
import { decideAction } from './src/adapter.js'
import { makeRng } from './src/rng.js'

class WolfBot extends Bot {
  constructor() {
    super()
    this.tracker = new TableTracker()
    this.decisions = 0
  }

  onMatchStart(message) {
    this.tracker.onMatch(message)
    const d = message?.data ?? message
    console.log(JSON.stringify({ ev: 'match_start', config: d?.game_config ?? d?.gameConfig ?? null }))
  }

  onRoundStart(message) {
    this.tracker.newHand(message)
  }

  onPhaseChange(message) {
    this.tracker.setPhase(message)
  }

  onTurnResult(message) {
    this.tracker.record(message)
  }

  onRoundResult(message) {
    this.tracker.commitHand(message)
  }

  onDecisionLatency(latencyMs) {
    if (latencyMs > 400) console.error(JSON.stringify({ ev: 'slow_decide', latencyMs }))
  }

  decide(state) {
    // Seeded by round+hand+history length: reproducible in tests, unpredictable
    // enough in play (it only drives Monte Carlo sampling noise).
    const rng = makeRng(state.roundId, state.handNumber, state.actionHistory.length)
    const started = Date.now()
    const { action, info } = decideAction(state, this.tracker, rng)
    this.decisions++
    console.log(
      JSON.stringify({
        ev: 'act',
        hand: state.handNumber,
        phase: state.phase,
        toCall: state.toCall,
        pot: state.pot,
        equity: round3(info.equity),
        pos: info.position ?? null,
        foldEq: info.foldEq ?? null,
        oppHands: info.oppHands ?? 0,
        choice: { action: action.action, amount: action.amount ?? null },
        ms: Date.now() - started,
        diag: this.tracker.diag,
      })
    )
    if (info.error) console.error(JSON.stringify({ ev: 'decide_error', error: info.error }))
    return action
  }
}

function round3(x) {
  return typeof x === 'number' ? Math.round(x * 1000) / 1000 : null
}

export { WolfBot }

// --- entry (only when executed directly, not when imported by tests) --------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const url = process.env.CHIPZEN_WS_URL
  if (!url) {
    console.error('CHIPZEN_WS_URL is not set — the platform injects the match endpoint at runtime')
    process.exit(1)
  }
  try {
    await runBot(url, new WolfBot(), { token: process.env.CHIPZEN_TOKEN || null })
  } catch (err) {
    console.error(JSON.stringify({ ev: 'fatal', error: String(err?.stack ?? err) }))
    process.exit(1)
  }
}
