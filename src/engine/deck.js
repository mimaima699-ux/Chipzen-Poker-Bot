// Cards and deck. A card is an object { rank, suit }:
// rank: 2..14 (11=J 12=Q 13=K 14=A), suit: 'c'|'d'|'h'|'s'
//
// Copied verbatim from poker/server/src/game/deck.js for the Chipzen build.

export const SUITS = ['c', 'd', 'h', 's']
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]

export function createDeck() {
  const deck = []
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit })
    }
  }
  return deck
}

// Fisher–Yates shuffle; rng is injectable for testing
export function shuffle(deck, rng = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  return deck
}
