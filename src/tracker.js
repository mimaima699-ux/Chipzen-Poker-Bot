// Table state tracker: feeds the aiPlayer's opponent context from Chipzen
// lifecycle hooks.
//
// The GameState in a turn_request only carries the raw action history (whole
// hand, no street boundaries) and opponent stacks in seat order — the AI wants
// street-scoped facts (who folded, current street's max bet, who raised
// preflop) plus long-term reads (VPIP / PFR / fold-to-bet per seat). This
// class accumulates both from the broadcast hooks:
//
//   onRoundStart  → newHand()      reset per-hand state
//   onPhaseChange → setPhase()     reset per-street bets
//   onTurnResult  → record()       fold/raise/bet/call bookkeeping
//   onRoundResult → commitHand()   fold per-hand reads into long-term profiles
//
// Every hook body is O(1) allocations — hooks run before the next decide()
// and eat into its time budget (DEV-MANUAL §6 "queue drain").

const POST_ACTIONS = new Set(['post_small_blind', 'post_big_blind', 'post_ante'])
const PHASE_BOARD_LEN = { preflop: 0, flop: 3, turn: 4, river: 5 }

function emptyProfile() {
  return { hands: 0, vpip: 0, pfr: 0, facedBet: 0, foldedToBet: 0 }
}

export class TableTracker {
  constructor() {
    // Match-level config (filled from match_start)
    this.bigBlind = 10
    this.numPlayers = 0
    this.yourSeat = null
    this.profiles = new Map() // seat → long-term stats
    // Per-hand state
    this.phase = 'preflop'
    this.foldedThisHand = new Set()
    this.raisedPreflop = new Set()
    this.calledPreflop = new Set()
    this.streetBet = new Map() // seat → total contributed on the current street
    this.streetMaxBet = 0
    // Per-hand profile channels: hookSeq (primary — sees post-decision
    // actions incl. hand-ending folds) and seq (actionHistory fallback).
    this.hookSeq = []
    this.handNumber = 0
    this.seq = []
    this.committedHand = -1
    this.diag = { requests: 0, handsCommitted: 0, turnResults: 0, parsed: 0, phaseChanges: 0, rounds: 0, committed: 0 }
  }

  profile(seat) {
    let p = this.profiles.get(seat)
    if (!p) {
      p = emptyProfile()
      this.profiles.set(seat, p)
    }
    return p
  }

  // --- lifecycle -----------------------------------------------------------

  // match_start payload (snake_case wire or already-parsed camelCase)
  onMatch(message) {
    const d = unwrap(message)
    const cfg = d?.game_config ?? d?.gameConfig ?? {}
    const bb = Number(cfg.big_blind ?? cfg.bigBlind)
    if (Number.isFinite(bb) && bb > 0) this.bigBlind = bb
    const seats = d?.seats ?? d?.state?.seats
    const num = Number(d?.num_players ?? d?.numPlayers ?? (Array.isArray(seats) ? seats.length : 0))
    if (Number.isFinite(num) && num > 0) this.numPlayers = num
  }

  // --- diagnostics + hook-independent profiling --------------------------------
  //
  // Platform replays showed the shipped v3 playing 61/11 station poker while
  // the same engine in selfplay plays 40+ PFR — the hook-driven profile path
  // is suspect. `ingestRequest` derives the SAME long-term stats straight
  // from turn_request.actionHistory (the one channel guaranteed to work) and
  // the counters below tell us from the bot log whether the hooks ever fired.

  ingestRequest(state) {
    this.diag.requests++
    // New hand? Commit the previous hand's accumulated sequence — unless the
    // round_result hook already committed it (hookSeq is the richer source).
    if (this.handNumber !== state.handNumber) {
      if (this.committedHand !== this.handNumber) this.commitSeq()
      this.handNumber = state.handNumber
      this.seq = []
    }
    const boardLen = state.board.length
    const seen = this.seq.length
    for (let i = seen; i < state.actionHistory.length; i++) {
      const e = state.actionHistory[i]
      if (!e || typeof e.seat !== 'number') continue
      this.seq.push({ seat: e.seat, action: e.action, amount: e.amount ?? 0, boardLen })
    }
  }

  // Fold the actionHistory-channel sequence into profiles.
  commitSeq() {
    this.commitActionSeq(this.seq)
  }

  // Shared commit: entries are {seat, action, amount, boardLen} in order.
  // Street tag is board length (preflop = 0); entries racing a board flip
  // between requests can mislabel a tail as postflop — rare and unbiased.
  commitActionSeq(entries) {
    if (!entries || entries.length === 0) return
    this.diag.handsCommitted++
    const stats = new Map() // seat → per-hand aggregates
    const streetMax = new Map() // boardLen → max raise/call total on it
    const contributed = new Map() // `${seat}:${boardLen}` → chips in this street
    for (const e of entries) {
      const key = `${e.seat}:${e.boardLen}`
      if (e.action === 'post_small_blind' || e.action === 'post_big_blind' || e.action === 'post_ante') {
        contributed.set(key, (contributed.get(key) ?? 0) + e.amount)
        streetMax.set(e.boardLen, Math.max(streetMax.get(e.boardLen) ?? 0, e.amount))
        continue
      }
      if (e.action === 'raise') {
        // a raise to `amount` (total) — contributed becomes amount. `faced`
        // must be evaluated BEFORE this raise lifts the street max, or the
        // first bettor gets credited with facing their own bet.
        const prev = contributed.get(key) ?? 0
        const faced = (streetMax.get(e.boardLen) ?? 0) > prev
        if (e.amount > (streetMax.get(e.boardLen) ?? 0)) streetMax.set(e.boardLen, e.amount)
        if (e.boardLen === 0) note(stats, e.seat, (s) => { s.vpip++; s.pfr++ })
        else if (faced) note(stats, e.seat, (s) => s.facedBet++)
        contributed.set(key, e.amount)
      } else if (e.action === 'call') {
        const prev = contributed.get(key) ?? 0
        const to = Math.min(e.amount || streetMax.get(e.boardLen) || 0, streetMax.get(e.boardLen) ?? 0)
        if (e.boardLen === 0 && to > prev) note(stats, e.seat, (s) => s.vpip++)
        else if (e.boardLen > 0 && (streetMax.get(e.boardLen) ?? 0) > prev) note(stats, e.seat, (s) => s.facedBet++)
        contributed.set(key, Math.max(prev, to))
      } else if (e.action === 'fold') {
        const prev = contributed.get(key) ?? 0
        if ((streetMax.get(e.boardLen) ?? 0) > prev) note(stats, e.seat, (s) => { s.facedBet++; s.foldedToBet++ })
      }
    }
    for (const [seat, s] of stats) {
      if (this.yourSeat !== null && seat === this.yourSeat) continue
      const p = this.profile(seat)
      p.hands++
      p.vpip += s.vpip > 0 ? 1 : 0
      p.pfr += s.pfr > 0 ? 1 : 0
      p.facedBet += s.facedBet
      p.foldedToBet += s.foldedToBet
    }
  }

  // round_start payload — also fires for hand #1 of a match
  newHand(message) {
    this.diag.rounds++
    const d = unwrap(message)
    this.phase = 'preflop'
    this.foldedThisHand.clear()
    this.raisedPreflop.clear()
    this.calledPreflop.clear()
    this.streetBet.clear()
    this.streetMaxBet = 0
    this.hookSeq = []
    const num = Number(d?.num_players ?? d?.numPlayers)
    if (Number.isFinite(num) && num > 0) this.numPlayers = num
    const seat = d?.your_seat ?? d?.yourSeat
    if (Number.isFinite(Number(seat))) this.yourSeat = Number(seat)
  }

  setPhase(message) {
    this.diag.phaseChanges++
    const d = unwrap(message)
    const phase = d?.phase
    if (!phase) return
    this.phase = phase
    // A new street means fresh contributed-to-the-pot-this-street bookkeeping
    this.streetBet.clear()
    this.streetMaxBet = 0
  }

  // turn_result broadcast (one per participant action, ours included).
  // Besides the street bookkeeping, every parseable action appends to
  // `hookSeq` — the PRIMARY profile channel, because it is the only one that
  // sees actions after our last decision of the hand (HU: the fold that ends
  // the hand happens exactly there, and those folds are the whole signal
  // against fold-bots).
  record(message) {
    this.diag.turnResults++
    const d = unwrap(message)
    if (this.diag.turnResults <= 5) {
      console.log(JSON.stringify({ ev: 'raw_turn_result', n: this.diag.turnResults, msg: truncate(message) }))
    }
    const seat = Number(d?.seat)
    const action = d?.action
    const amount = Number(d?.amount ?? 0)
    if (!Number.isFinite(seat) || !action) return
    this.diag.parsed++
    this.hookSeq.push({ seat, action, amount, boardLen: PHASE_BOARD_LEN[this.phase] ?? 0 })

    const contributed = this.streetBet.get(seat) ?? 0
    const facingBet = action !== 'check' && this.streetMaxBet > contributed

    if (action === 'fold') {
      this.foldedThisHand.add(seat)
      return
    }
    if (POST_ACTIONS.has(action)) {
      this.streetBet.set(seat, amount)
      if (amount > this.streetMaxBet) this.streetMaxBet = amount
      return
    }
    if (action === 'raise' || action === 'bet') {
      if (this.phase === 'preflop') {
        this.raisedPreflop.add(seat)
        this.calledPreflop.add(seat) // a raise is also voluntary money in
      }
      const total = Math.max(amount, contributed)
      this.streetBet.set(seat, total)
      if (total > this.streetMaxBet) this.streetMaxBet = total
      return
    }
    if (action === 'call') {
      if (this.phase === 'preflop') this.calledPreflop.add(seat)
      const total = Math.max(Math.min(amount || this.streetMaxBet, this.streetMaxBet), contributed)
      this.streetBet.set(seat, total)
    }
    // 'check' and unknown actions carry no bookkeeping
  }

  // round_result — hand over. Prefer the hook channel (it saw the whole
  // hand); the actionHistory channel commits later via ingestRequest only if
  // hooks never parsed anything this hand.
  commitHand(message) {
    this.diag.committed++
    if (this.hookSeq.length > 0) {
      this.commitActionSeq(this.hookSeq)
      this.committedHand = this.handNumber
    } else {
      this.commitSeq()
      this.committedHand = this.handNumber
    }
    this.hookSeq = []
  }

  // --- query side used by the adapter --------------------------------------

  // Opponent context for the AI, one entry per non-busted opponent seat,
  // ordered by seat (matching opponentStacks ordering: "indexed by seat order
  // excluding you"). Seats are assumed dense 0..N-1.
  opponentsFor(state) {
    const n = state.opponentStacks.length + 1
    if (n > this.numPlayers && this.numPlayers > 0) this.numPlayers = n
    const seats = []
    for (let s = 0; s < n; s++) if (s !== state.yourSeat) seats.push(s)
    return seats.map((seat, i) => ({
      seat,
      stack: state.opponentStacks[i] ?? 0,
      folded: this.foldedThisHand.has(seat) || (state.opponentStacks[i] ?? 0) <= 0,
      profile: this.profiles.get(seat) ?? null,
      preflopRaised: this.raisedPreflop.has(seat),
      // Postflop aggression this street — flags the aggression-weighted
      // equity blend in the engine (v6): a bettor's range beats random.
      betThisStreet: this.phase !== 'preflop' && (this.streetBet.get(seat) ?? 0) > 0,
      raisedThisStreet: this.phase !== 'preflop' && (this.streetBet.get(seat) ?? 0) >= this.streetMaxBet && this.streetMaxBet > 0,
    }))
  }

  // Highest total bet on the current street (0 postflop until someone bets;
  // the big blind preflop). Falls back to toCall-derived values if a hook was
  // missed, so sizing still behaves.
  currentStreetBet(state) {
    if (this.streetMaxBet > 0) return this.streetMaxBet
    return state.phase === 'preflop' ? Math.max(this.bigBlind, state.toCall) : state.toCall
  }
}

function unwrap(message) {
  if (!message || typeof message !== 'object') return message
  if (typeof message.data === 'object' && message.data !== null) return message.data
  return message
}

function note(map, seat, fn) {
  let s = map.get(seat)
  if (!s) {
    s = { vpip: 0, pfr: 0, facedBet: 0, foldedToBet: 0 }
    map.set(seat, s)
  }
  fn(s)
}

function truncate(x) {
  try {
    const s = JSON.stringify(x)
    return s && s.length > 300 ? s.slice(0, 300) + '…' : s
  } catch {
    return String(x)
  }
}

