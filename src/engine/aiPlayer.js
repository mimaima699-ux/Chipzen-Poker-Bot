// Medium-strategy AI decision making — V3 (replay-driven Chipzen tuning).
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
// V3 changes (driven by real platform replays — 1W-4L, VPIP 63% / PFR 11%):
//   1. Preflop seat-aware opening (kills the limp-call station profile):
//      raise-first-in thresholds by position, complete-zone discipline,
//      no bluff 3-bets.
//   2. Postflop bluff discipline: below-price check-raises REMOVED (V2
//      check-raised gutshots twice per hand and donated 5k pots); draws
//      continue only at cheap prices; oversized bets demand equity above
//      raw pot odds before calling.
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

  const n = (ctx.opponents?.filter((o) => !o.folded).length ?? 1) + 1
  const hu = n === 2

  // V3: open/defend thresholds by seat. V2's price-only logic limped and
  // called ~63% of hands (PFR 11%) — a station profile that postflop can't
  // carry. Position-aware raising kills the limp-call leak at the source.
  if (toCall === 0) {
    let openEq = hu
      ? position > 0.5
        ? share - 0.06 // HU button opens ~top 60%
        : share + 0.06 // HU BB vs a limp raises ~top 30%
      : // Multiway equity is diluted by the field (vs 5 opponents AA ≈ 0.55),
        // so thresholds ride on `share` (1/N) — absolute cutoffs priced us at
        // QQ+ from every seat and the blinds bled out (six-max regression).
        position > 0.66
        ? share + 0.13
        : position > 0.33
          ? share + 0.16
          : share + 0.19
    // Vs observed folders, open nearly everything — position + fold equity
    // beat raw hand strength (losing to fold-bots on the platform proved it).
    if (foldEq > 0.6) openEq -= 0.15
    if (foldEq > 0.75) openEq = -1 // their blinds are free; steal 100%
    if (equity > openEq && legal.canRaise) {
      const size = hu ? 3 : 2.5 + looseness * 0.5 + rng() * 0.5
      return raiseTo(ctx, currentBet + Math.round(bigBlind * Math.min(size, 3.5)))
    }
    return { type: 'check' }
  }

  const price = toCall / (potSize + toCall)
  // Oversized bets demand equity above raw pot odds — calling near-price
  // vs big raises was how stacks left in single hands (replay 72c11aa8 #2).
  const needMargin = 0.01 + 0.03 * Math.min(2, toCall / Math.max(1, potSize))

  if (toCall <= bigBlind) {
    // Limp-complete zone — in HU this is ALWAYS the button/SB (the button
    // never sees toCall===0 preflop), so the button's open threshold applies
    // here, not the tighter BB-vs-limp number.
    if (foldEq > 0.65 && legal.canRaise) {
      return raiseTo(ctx, currentBet + Math.round(bigBlind * 3)) // steal vs a folder
    }
    const raiseEq = hu ? (position > 0.5 ? share - 0.06 : share + 0.06) : 0.4
    if (equity > raiseEq && legal.canRaise) {
      return raiseTo(ctx, currentBet + Math.round(bigBlind * 3))
    }
    if (equity > (hu ? share - 0.1 : 0.3)) return { type: 'call' }
    return { type: 'fold' }
  }

  if (equity > price + needMargin) {
    const threeBetEq = hu ? share + 0.12 : 0.55
    if (equity > threeBetEq && legal.canRaise) {
      return raiseTo(ctx, currentBet + toCall + Math.round(Math.max(bigBlind * 2, toCall * 2.2)))
    }
    return { type: 'call' }
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

  // Vs a frequent folder, value thresholds collapse toward "bet anything
  // decent" — checked-down medium hands just flip coins for the blinds.
  const vsFolder = foldEq > 0.6
  const strong = equity > share + (vsFolder ? 0.05 : 0.18)
  const medium = equity > share + (vsFolder ? 0.0 : 0.08)
  const betFrac = toCall > 0 ? toCall / Math.max(1, potSize) : 0
  // V3: oversized bets demand equity above raw pot odds. Calling near-price
  // vs huge raises donated 5k+ pots with second-best hands (replay 72c11aa8).
  const needMargin = 0.01 + 0.03 * Math.min(2, betFrac)

  if (toCall === 0) {
    // No bet to face — value bet, semi-bluff a strong draw, or check behind
    if (strong && legal.canRaise) {
      const size = 0.5 + wet * 0.3 // bigger on wet boards to deny cheap cards
      return raiseTo(ctx, currentBet + Math.round(potSize * (size + rng() * 0.1)))
    }
    if (medium && outs >= 8 && rng() < 0.45 && legal.canRaise) {
      return raiseTo(ctx, currentBet + Math.round(potSize * 0.45)) // strong-draw bet only
    }
    if (!medium && position > 0.4 && legal.canRaise) {
      // Stab frequency scales with their observed fold rate: vs a station
      // almost never, vs a folder nearly always.
      const stabFreq = foldEq > 0.7 ? 0.8 : foldEq > 0.5 ? 0.5 : 0.18
      if (rng() < stabFreq) {
        const bet = Math.round(potSize * 0.5)
        if (bluffProfitable(bet, potSize, foldEq)) {
          return raiseTo(ctx, currentBet + bet) // single-street bluff
        }
      }
    }
    return { type: 'check' }
  }

  // Facing a bet: call only when equity clears the scaled pot odds.
  if (equity > price + needMargin) {
    if (strong && spr < 2.5 && legal.canRaise) {
      return raiseTo(ctx, legal.raiseMax) // low stack-to-pot: get the money in
    }
    if (strong && rng() < 0.35 && legal.canRaise) {
      return raiseTo(ctx, currentBet + toCall + Math.round(potSize * (0.55 + wet * 0.2)))
    }
    return { type: 'call' }
  }

  // Below the price: draws may continue at the RIGHT price only — V3 removed
  // the below-price check-raise entirely (multi-street bluff-raising with
  // gutshots burned ~5k/hand vs callers; replay e18925f9 #16).
  if (outs >= 8 && price < 0.45) return { type: 'call' }
  if (outs >= 4 && price < 0.28) return { type: 'call' }
  return { type: 'fold' }
}
