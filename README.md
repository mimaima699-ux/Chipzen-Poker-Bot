# Chipzen Poker Bot

An open, equity-driven No Limit Hold'em bot for the
[Chipzen](https://chipzen.ai) AI poker arena — built by evolving the engine
from [Texas-Hold-em-Platform](https://github.com/mimaima699-ux/Texas-Hold-em-Platform)
into a competition bot, then tuning it against real platform match data.

Everything is public: engine parameters, opponent-modeling heuristics, and
the full debugging history of how each version leaked chips and how it was
fixed. Seasons run weekly — the tooling here matters more than any single
set of thresholds.

## How it plays

- **Range-aware Monte Carlo equity** — every decision samples opponent hole
  cards from ranges inferred from their tracked VPIP / PFR / fold-to-bet,
  wall-clock budgeted so a decision never blows the platform's timeout
  (measured worst case ~40ms of a 500ms budget)
- **Position-aware preflop** — seat-relative open thresholds, complete-zone
  discipline, push/fold (solved from shove EV, not a hardcoded table) once
  the effective stack drops below 9BB
- **Adaptive aggression** — steal frequency, value thresholds, and bluff
  gating all scale with each opponent's observed fold rate
- **Dual-channel opponent tracking** — lifecycle-hook broadcasts are the
  primary profile feed; `turn_request.actionHistory` is a guaranteed
  fallback (see post-mortem #1 for why both exist)

## The replay-driven loop

The core methodology this repo demonstrates:

```
Chipzen API  ──▶  replay-*.json  ──▶  analyze-replay.mjs  ──▶  leak profile
                                                                │
 selfplay A/B  ◀──  engine fix  ◀───────────────────────────────┘
      │
      ▼
 replay-sim.mjs  ──▶  regression vs the REAL lost match  ──▶  docker image
```

`replay-sim.mjs` is the piece most bot projects are missing: it drives the
**full production stack** (GameState → adapter → tracker → engine) through a
real platform replay, decision by decision. Bugs that live in the glue layer
— not the strategy — only reproduce there.

## Version history (all measured on the platform)

| Version | Record | Profile | What changed |
|---|---|---|---|
| v3 | 1W–4L | VPIP 61% / PFR 11% | Replay-driven rewrite; strategy right, plumbing broken |
| v4 | 5W–2L | VPIP 33%, big-pot showdowns 37%→57% | Dual-channel opponent tracking |
| v5 | — | PFR 11%→47% on the same replays | Button-seat dead-code fix |

### Post-mortems

1. **The dead hook channel** — opponent stats accumulated from lifecycle
   broadcasts never parsed on the real server, so every opponent read as a
   0.35-fold-equity random range and the bot collapsed into a limp-call
   station (61/11). Selfplay couldn't catch it because the harness fed
   profiles directly, bypassing the glue. Fix: the actionHistory fallback
   channel plus `replay-sim.mjs` as a permanent regression layer.
2. **Preflop folds never counted** — fold-to-bet was a postflop-only stat,
   so a bot that folds to every preflop raise was modeled as a strong-range
   nit instead of a fold-bot. That's how a pure folding bot beat us.
3. **The button branch that never ran** — HU button = small blind, which
   always faces a toCall, so the "button opens top 60%" path (written for
   toCall === 0) was dead code and PFR stayed at 11%.

## Quick start

```bash
npm install
npm test                 # 14 tests incl. the SDK protocol-conformance harness
npm run bench            # decision-latency benchmark

# A/B one engine version against another (selfplay, equal info + clock budget)
node scripts/selfplay.mjs --mode hu --matches 50 --a v2 --b v3
node scripts/selfplay.mjs --mode sixmax --matches 8 --a v2 --b v3

# Analyze real platform replays (public API, no auth)
curl -s "https://chipzen.ai/api/matches?limit=20&game_type=poker" -o cz.json
# ... find a match id, fetch /api/matches/{id}/replay, then:
node scripts/analyze-replay.mjs replay-XXXX.json --me YourBotName

# Regression-test the production stack against a replay
node scripts/replay-sim.mjs replay-XXXX.json --me YourBotName

# Build the upload image (gzip'd docker archive, ~46MB)
npm run bundle
npm run package          # or: docker build -t bot . && docker save bot | gzip > bot.tar.gz
```

## Layout

```
bot.js                 entry point (WolfBot + container bootstrap)
src/engine/            hand evaluator, Monte Carlo equity, decision engine
                       (aiPlayer.js = current; aiPlayerV1/V2 kept for A/B)
src/adapter.js         GameState ⇄ engine translation + legality guards
src/tracker.js         dual-channel opponent profiling
test/                  unit tests + SDK conformance
scripts/               selfplay / replay analysis / replay simulation / bench
Dockerfile             node:20-alpine + zero-dependency esbuild bundle
```

The engine itself was ported from the
[Texas-Hold-em-Platform](https://github.com/mimaima699-ux/Texas-Hold-em-Platform)
server; the poker-room integration was stripped and competition-specific
layers (adapter, tracker, tooling) were built on top.

## License

[MIT](LICENSE)
