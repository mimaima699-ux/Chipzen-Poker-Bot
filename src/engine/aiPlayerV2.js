// Medium-strategy AI decision making — V2 (Chipzen competition tuning).
// Input context (provided by the room layer):
//   { hole, community, toCall, currentBet, potSize, legal, position, bigBlind, opponents, rng,
//     deadline?, onInfo? }
// Output: { type: 'fold'|'check'|'call'|'raise', amount? }
//
// Based on poker/server/src/ai/aiPlayer.js. Chipzen-specific additions:
//   - `deadline` (absolute ms timestamp) is forwarded to the equity sampler
//     so a decision can never blow the platform's turn budget.
//   - optional `onInfo({ equity })` hook lets the caller log the computed
//     equity alongside the chosen action.
//
// V2 changes vs V1 (A/B-verified in scripts/selfplay.mjs):
//   1. Calls require equity ≥ pot odds — V1 accepted equity up to 6% below
//      price, a systematic leak against value bettors.
//   2. Preflop push/fold at effective stacks ≤ 9 BB: shove EV computed from
//      fold equity + equity vs a modeled call range. Chipzen blinds escalate,
//      so matches spend real time short-stacked.
//   3. River outs fix carried over (draws are dead once the board is full).
//
// Decisions are EV-driven: equity is computed against each opponent's hand
// range (built from their tracked VPIP/PFR and preflop aggression), weighed
// against the pot odds, and bluffs are gated on fold equity (their observed
// fold-to-bet rate) rather than a blind probability. Bet sizing still scales
// with board texture and stack-to-pot ratio.

import { equityVsRanges, countOuts } from './equity.js'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// Push/fold: the deepest effective stack (in BB) at which we switch from
// normal preflop play to solved shove-or-fold.
const PUSH_FOLD_MAX_BB = 9

// My total investable chips this hand (street investment + chips behind).
function myStackTotal(ctx) {
  return ctx.stack + Math.max(0, ctx.currentBet - ctx.toCall)
}

// Effective stack in chips: what the shorter side can put in the middle this
// hand, me vs. every live opponent. Used only for the all-in EV math.
function effectiveStackTotal(ctx) {
  let eff = myStackTotal(ctx)
  for (const o of ctx.opponents) {
    if (o.folded || !Number.isFinite(o.stack)) continue
    const theirs = o.stack + ctx.currentBet
    if (theirs < eff) eff = theirs
  }
  return eff
}

// Shove-or-fold decision. Returns an action, or null to fall through to the
// normal preflop logic (when raising isn't possible).
function pushOrFold(ctx) {
  const { hole, toCall, potSize, bigBlind, legal, rng } = ctx
  if (!legal.canRaise) return null

  const n = ctx.opponents.filter((o) => !o.folded).length
  // Push/fold is the short player's mode. Gate on OUR OWN stack — using the
  // table minimum here made deep stacks play 5BB poker whenever anyone else
  // was short (found via 6-max self-play: v2 seats busted first, always).
  if (myStackTotal(ctx) > PUSH_FOLD_MAX_BB * bigBlind) return null
  const T = effectiveStackTotal(ctx)

  // How often the field folds to a shove, and what they call with. Postflop
  // fold-to-bet stats don't predict shove-calling, so this stays a format
  // model: multiway fields fold more but call tighter.
  const foldChance = Math.min(0.85, 0.55 + 0.06 * Math.max(0, n - 1))
  const callRange = n === 1 ? 0.27 : 0.18

  // Equity vs the modeled calling range (preflop, board empty)
  const eq = equityVsRanges(hole, [], [callRange], { rng, iterations: 200, deadline: ctx.deadline })

  const myBet = Math.max(0, ctx.currentBet - ctx.toCall)
  const oppBet = Math.min(ctx.currentBet, T)
  const myRisk = T - myBet // additional chips the shove puts at risk
  const finalPot = potSize + (T - myBet) + (T - oppBet)
  const evCall = eq * finalPot - myRisk
  const evShove = foldChance * potSize + (1 - foldChance) * evCall

  // Small positive bar so borderline shoves don't buy pure variance
  if (evShove > 0.15 * bigBlind) return { type: 'raise', amount: legal.raiseMax }
  return toCall > 0 ? { type: 'fold' } : { type: 'check' }
}

export function decide(ctx) {
  const active = activeOpponents(ctx)
  const share = 1 / (active.length + 1) // an even split of the field
  const ranges = active.map(estimateRangePct)
  const equity = equityVsRanges(ctx.hole, ctx.community, ranges, { rng: ctx.rng, deadline: ctx.deadline })
  if (typeof ctx.onInfo === 'function') ctx.onInfo({ equity, ranges, share })
  // Bluff against the most call-happy opponent (lowest fold rate), so we don't
  // bluff into someone who never folds.
  const foldEq = active.length ? Math.min(...active.map(opponentFoldEquity)) : 0.35
  // How loose the loosest remaining opponent is (0 = nit, 1 = plays any two):
  // we widen our aggression against loose players and tighten against nits.
  const looseness = ranges.length ? Math.max(...ranges) : 0.5
  const enriched = { ...ctx, equity, share, foldEq, looseness }
  return ctx.community.length === 0 ? decidePreflop(enriched) : decidePostflop(enriched)
}

// Non-folded opponents still contesting the pot
function activeOpponents(ctx) {
  if (Array.isArray(ctx.opponents)) return ctx.opponents.filter((o) => !o.folded)
  return []
}

// Map an opponent's tracked stats → the fraction of starting hands we think
// they hold right now (1.0 = any two). No data → a middle-of-the-road 30%.
export function estimateRangePct(opp) {
  const prof = opp?.profile
  const raised = !!opp?.preflopRaised
  if (!prof || prof.hands < 5) {
    // No track record yet: lean on this hand's preflop action alone. Assume
    // opponents are on the loose side (casual games) so we don't fold too much
    // before we've actually read them.
    return raised ? 0.3 : 0.5
  }
  const vpip = prof.vpip / prof.hands
  const pfr = prof.pfr / prof.hands
  // Raised preflop → their strongest hands, roughly their raise frequency.
  if (raised) return Math.max(0.05, Math.min(0.6, pfr))
  return Math.max(0.1, Math.min(0.8, vpip))
}

// How often we expect a bet to win the pot right away (fold-to-bet rate).
export function opponentFoldEquity(opp) {
  const prof = opp?.profile
  if (!prof || prof.facedBet < 3) return 0.35
  return Math.min(0.9, Math.max(0.05, prof.foldedToBet / prof.facedBet))
}

// Build a legal raise (target total bet), clamped into [raiseMin, raiseMax]
function raiseTo(ctx, desiredTotal) {
  const { legal } = ctx
  return { type: 'raise', amount: Math.round(clamp(desiredTotal, legal.raiseMin, legal.raiseMax)) }
}

// Break-even check for a pure bluff: betting `amount` into `pot` is +EV only if
// the opponent folds more often than amount / (pot + amount).
function bluffProfitable(amount, pot, foldEq) {
  if (pot <= 0 || amount <= 0) return false
  return foldEq > amount / (pot + amount)
}

function decidePreflop(ctx) {
  const { toCall, currentBet, potSize, legal, position, bigBlind, rng, equity, share, foldEq, looseness } = ctx
  // Short-stacked: solved shove-or-fold replaces the normal open/3-bet logic
  const pushed = pushOrFold(ctx)
  if (pushed) return pushed
  // Edge over an even split of the field, nudged by position (later = looser)
  const edge = equity - share + position * 0.12

  if (toCall === 0) {
    // Free to see the flop — open/raise with a clear edge, else check along.
    // Charge loose callers more with a bigger open.
    if (edge > 0.12 && legal.canRaise) {
      return raiseTo(ctx, currentBet + Math.round(bigBlind * (2.5 + looseness * 0.5 + rng() * 0.5)))
    }
    if (edge > 0.02 && rng() < 0.12 && legal.canRaise) {
      return raiseTo(ctx, currentBet + Math.round(bigBlind * 2.5))
    }
    return { type: 'check' }
  }

  // Facing a bet — call when equity beats the price, 3-bet with a big edge.
  // Loose opponents raise wide, so we can 3-bet wider too; nits demand a
  // premium before we re-raise.
  const price = toCall / (potSize + toCall)
  const threeBetEdge = 0.26 - looseness * 0.14
  // V2: demand equity at or above the price — V1's negative margin called
  // hands that were provably -EV on pot odds alone.
  const callMargin = 0.01
  if (equity > price + callMargin) {
    if (edge > threeBetEdge && legal.canRaise) {
      return raiseTo(ctx, currentBet + toCall + Math.round(Math.max(bigBlind * 2, toCall * 2)))
    }
    return { type: 'call' }
  }
  // Below the price: only re-raise to bluff when it would actually work
  if (position > 0.6 && legal.canRaise) {
    const extra = toCall + Math.round(toCall * 1.5 + bigBlind)
    if (bluffProfitable(extra, potSize, foldEq)) {
      return raiseTo(ctx, currentBet + extra)
    }
  }
  return { type: 'fold' }
}

// How "draw-heavy" (wet) the board is, 0..1. Wet boards pay off to bet larger:
// they hold possible flush draws, straight draws, or multiple broadway cards
// that our made hands need to charge.
export function boardWetness(community) {
  if (community.length < 3) return 0.5
  const suits = {}
  for (const c of community) suits[c.suit] = (suits[c.suit] || 0) + 1
  const flushDraw = Math.max(...Object.values(suits)) >= 2

  const ranks = community.map((c) => c.rank).sort((a, b) => a - b)
  let straightDraw = false
  for (let i = 0; i + 2 < ranks.length; i++) {
    if (ranks[i + 2] - ranks[i] <= 4) straightDraw = true
  }
  const broadway = ranks.filter((r) => r >= 10).length >= 2

  return (flushDraw ? 0.5 : 0) + (straightDraw ? 0.3 : 0) + (broadway ? 0.2 : 0)
}

function decidePostflop(ctx) {
  const { hole, community, toCall, currentBet, potSize, legal, position, rng, equity, share, stack, foldEq } = ctx
  // No card is coming on the river — draws are dead there, so outs are 0.
  // (The original room AI shared this flaw; calling river shoves with a
  // gutshot-that-already-bricked bleeds chips.)
  const outs = community.length >= 5 ? 0 : countOuts(hole, community)
  const price = toCall > 0 ? toCall / (potSize + toCall) : 0
  const wet = boardWetness(community)
  const spr = potSize > 0 ? stack / potSize : Number.POSITIVE_INFINITY

  const strong = equity > share + 0.25 // clearly ahead of the field
  const medium = equity > share + 0.10
  const weak = !medium

  if (toCall === 0) {
    // No bet to face — value bet, semi-bluff a draw, or check behind
    if (strong && legal.canRaise) {
      const size = 0.5 + wet * 0.3 // bigger on wet boards to deny cheap cards
      return raiseTo(ctx, currentBet + Math.round(potSize * (size + rng() * 0.1)))
    }
    if (medium && outs >= 4 && rng() < 0.5 && legal.canRaise) {
      return raiseTo(ctx, currentBet + Math.round(potSize * (0.4 + wet * 0.2))) // semi-bluff
    }
    if (weak && position > 0.6 && legal.canRaise) {
      const bet = Math.round(potSize * (0.5 + wet * 0.2))
      if (bluffProfitable(bet, potSize, foldEq)) {
        return raiseTo(ctx, currentBet + bet) // pure bluff, only if it works
      }
    }
    return { type: 'check' }
  }

  // Facing a bet: call only when equity clears the pot odds (V2 — the old
  // -6% margin paid value bets for the privilege).
  if (equity > price + 0.01) {
    if (strong && spr < 2.5 && legal.canRaise) {
      return raiseTo(ctx, legal.raiseMax) // low stack-to-pot: get the money in
    }
    if (strong && rng() < 0.4 && legal.canRaise) {
      return raiseTo(ctx, currentBet + toCall + Math.round(potSize * (0.6 + wet * 0.2)))
    }
    return { type: 'call' }
  }

  // Below the price: still continue a halfway-decent draw — semi-bluff raise,
  // or a cheap call — instead of surrendering right away.
  if (outs >= 4) {
    const extra = toCall + Math.round(potSize * 0.6)
    if (legal.canRaise && (rng() < 0.25 || bluffProfitable(extra, potSize, foldEq))) {
      return raiseTo(ctx, currentBet + extra)
    }
    if (rng() < 0.7) return { type: 'call' }
  }
  return { type: 'fold' }
}
