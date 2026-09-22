// Deterministic seeded PRNG (mulberry32 + FNV-1a seed). Deterministic per
// (round, hand, action index) so tests are reproducible; in play the seed is
// unknowable to opponents and only drives Monte Carlo sampling noise.

export function makeRng(...parts) {
  const s = parts.join('|')
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let a = h >>> 0
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
