/**
 * mulberry32 — small, fast, and seedable. The generator state lives inside
 * GameState so a game (and any bot simulation of it) replays exactly.
 */
export interface Rng {
  state: number
  next(): number
}

export function rngFrom(state: number): Rng {
  return {
    state,
    next() {
      this.state = (this.state + 0x6d2b79f5) | 0
      let t = this.state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

export const rollDie = (rng: Rng) => 1 + Math.floor(rng.next() * 6)

export function shuffle<T>(items: T[], rng: Rng): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
