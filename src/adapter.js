// Adapter between the Chipzen SDK's GameState/Action and the local engine's
// decide(ctx) interface.
//
//   GameState (camelCase SDK shape)  →  aiPlayer ctx  →  {type, amount}
//                                                        ↓
//   Action (legality-guarded)  ← ————————————————————————┘
//
// Chipzen card rank is a 2-char string ('Ah', 'Tc'); the engine uses numeric
// ranks 2..14. Chipzen raise amounts are TOTAL bet sizes ("raise to"), the
// same semantics as the engine's raiseTo — no translation needed there.
//
// Every returned Action is validated against state.validActions and
// [minRaise, maxRaise]; on any internal error we fall back to the safest
// legal action rather than throwing (an exception would burn the SDK's
// safe-fallback and surface a bot_error in the UI).

import { decide } from './engine/aiPlayer.js'
import { Action } from '@chipzen-ai/bot'

const RANK_MAP = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 }

export function toEngineCard(card) {
  const rank = RANK_MAP[card.rank]
  if (rank === undefined) throw new Error(`unknown rank ${JSON.stringify(card.rank)}`)
  return { rank, suit: card.suit }
}

// Seat offset from the button → 0..1 "how late do we act" (button = 1).
// Postflop order is SB, BB, ..., cutoff, button — the button acts last.
// Preflop the button also acts last (except heads-up, where the button/SB
// acts first preflop and last postflop; the proxy is still fine for the AI's
// aggression nudge).
export function positionFromSeats(yourSeat, dealerSeat, numPlayers) {
  if (numPlayers <= 1) return 0.5
  const offset = (yourSeat - dealerSeat + numPlayers) % numPlayers
  const actIndex = offset === 0 ? numPlayers - 1 : offset - 1
  return actIndex / (numPlayers - 1)
}

// Wall-clock budget handed to the Monte Carlo sampler. The platform's turn
// timeout is 500 ms for uploaded bots; 300 ms of sampling leaves headroom for
// parsing, hooks, and the adapter itself.
export const MC_BUDGET_MS = 300

export function buildCtx(state, tracker, rng, info) {
  const numPlayers = state.opponentStacks.length + 1
  return {
    hole: state.holeCards.map(toEngineCard),
    community: state.board.map(toEngineCard),
    toCall: state.toCall,
    currentBet: tracker.currentStreetBet(state),
    potSize: state.pot,
    stack: state.yourStack,
    legal: {
      canRaise:
        state.validActions.includes('raise') &&
        Number.isFinite(state.maxRaise) &&
        Number.isFinite(state.minRaise) &&
        state.maxRaise >= state.minRaise &&
        state.maxRaise > 0,
      raiseMin: state.minRaise,
      raiseMax: state.maxRaise,
    },
    position: positionFromSeats(state.yourSeat, state.dealerSeat, numPlayers),
    bigBlind: tracker.bigBlind,
    opponents: tracker.opponentsFor(state),
    rng,
    deadline: Date.now() + MC_BUDGET_MS,
    onInfo: info,
  }
}

// Map the engine's {type, amount} choice onto a strictly legal SDK Action.
export function toAction(choice, state) {
  const can = (kind) => state.validActions.includes(kind)
  const toCall = state.toCall

  if (choice?.type === 'raise' && can('raise') && state.maxRaise >= state.minRaise) {
    const amount = Math.round(Math.max(state.minRaise, Math.min(choice.amount ?? state.minRaise, state.maxRaise)))
    return Action.raiseTo(amount)
  }
  if (choice?.type === 'call') {
    if (can('call')) return Action.call()
    if (toCall === 0 && can('check')) return Action.check()
  }
  if (choice?.type === 'check' && can('check')) return Action.check()
  if (choice?.type === 'fold' && toCall > 0 && can('fold')) {
    // Folding is only ever chosen when facing a bet; if check is somehow
    // legal too (free card), checking strictly dominates folding.
    if (!can('check')) return Action.fold()
  }

  // Fallback ladder: check → call → fold
  if (can('check')) return Action.check()
  if (can('call') && toCall > 0) return Action.call()
  if (can('fold')) return Action.fold()
  return Action.check()
}

// Full decide pipeline for one turn_request. Returns { action, info }.
export function decideAction(state, tracker, rng) {
  const info = {}
  let choice = null
  try {
    tracker.ingestRequest(state) // hook-independent profile channel
    const ctx = buildCtx(state, tracker, rng, (x) => Object.assign(info, x))
    choice = decide(ctx)
    // diagnostics for the platform log — one glance shows whether the
    // opponent model is alive (position/foldEq/hands) or defaulted
    const opps = ctx.opponents.filter((o) => !o.folded)
    info.position = Math.round(ctx.position * 100) / 100
    info.foldEq = Math.round(infoFoldEq(opps) * 100) / 100
    info.oppHands = opps.reduce((m, o) => Math.max(m, o.profile?.hands ?? 0), 0)
  } catch (err) {
    info.error = String(err?.stack ?? err)
  }
  return { action: toAction(choice, state), info }
}

// Re-derive the fold equity the engine used, for logging only.
function infoFoldEq(activeOpponents) {
  if (!activeOpponents.length) return 0
  const rates = activeOpponents.map((o) => {
    const prof = o.profile
    if (!prof || prof.facedBet < 3) return 0.35
    return Math.min(0.9, Math.max(0.05, prof.foldedToBet / prof.facedBet))
  })
  return Math.min(...rates)
}
