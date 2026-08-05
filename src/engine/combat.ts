/**
 * Exact battle mathematics.
 *
 * A bot that only knows "is this attack better than 50%?" plays badly, because
 * that says nothing about what the win *costs*. These functions give both the
 * chance of taking a territory and the armies expected to be left standing.
 *
 * Everything is derived from the single-exchange distribution rather than
 * hardcoded, and `scripts/test.ts` pins the results against the known closed-form
 * values (15/36 for 1v1, 2890/7776 for 3v2, and so on).
 */

/** Outcome of one exchange: attacker losses, defender losses, probability. */
export interface Exchange {
  attackerLoss: number
  defenderLoss: number
  p: number
}

function allRolls(n: number): number[][] {
  if (n === 0) return [[]]
  return allRolls(n - 1).flatMap((r) => [1, 2, 3, 4, 5, 6].map((v) => [...r, v]))
}

/** Distribution of one exchange for a given number of dice on each side. */
function exchangeTable(attackerDice: number, defenderDice: number): Exchange[] {
  const A = allRolls(attackerDice)
  const D = allRolls(defenderDice)
  const acc = new Map<string, number>()
  const total = A.length * D.length
  for (const ar of A) {
    const as = [...ar].sort((x, y) => y - x)
    for (const dr of D) {
      const ds = [...dr].sort((x, y) => y - x)
      let al = 0
      let dl = 0
      for (let i = 0; i < Math.min(as.length, ds.length); i++) {
        // ties go to the defender
        if (as[i] > ds[i]) dl++
        else al++
      }
      const k = `${al}:${dl}`
      acc.set(k, (acc.get(k) ?? 0) + 1 / total)
    }
  }
  return [...acc].map(([k, p]) => {
    const [attackerLoss, defenderLoss] = k.split(':').map(Number)
    return { attackerLoss, defenderLoss, p }
  })
}

// six combinations, computed once: 1-3 attacking dice against 1-2 defending
const EXCHANGE: Exchange[][][] = [[], [], [], []]
for (let a = 1; a <= 3; a++) {
  EXCHANGE[a] = [[], [], []]
  for (let d = 1; d <= 2; d++) EXCHANGE[a][d] = exchangeTable(a, d)
}

export const exchangeOdds = (attackerDice: number, defenderDice: number): Exchange[] =>
  EXCHANGE[attackerDice][defenderDice]

/** Dice each side rolls, given armies present. */
export const attackerDice = (armies: number) => Math.min(3, Math.max(0, armies - 1))
export const defenderDice = (armies: number) => Math.min(2, armies)

// ─────────────────────────── full battle ───────────────────────────

const winMemo = new Map<number, number>()
const survMemo = new Map<number, number>()
const key = (a: number, d: number) => a * 4096 + d

/**
 * Above this, stop computing exactly.
 *
 * The recursion visits every (a, d) pair below the starting one, so an unbounded
 * table blows past V8's Map limit once late-game stacks reach the thousands — and
 * would be ruinously slow long before that. Battle dynamics are near
 * scale-invariant at these sizes, so both sides are scaled into range instead.
 * The approximation is slightly *conservative*: shrinking the numbers adds
 * relative variance, so a lopsided fight reads as marginally less certain than it
 * really is.
 */
const EXACT_CAP = 220

/** Scale a matchup into the exact range, returning the factor used. */
function inRange(a: number, d: number): { a: number; d: number; k: number } {
  if (a <= EXACT_CAP && d <= EXACT_CAP) return { a, d, k: 1 }
  const k = Math.max(a, d) / EXACT_CAP
  return { a: Math.max(2, Math.round(a / k)), d: Math.max(1, Math.round(d / k)), k }
}

/**
 * Probability the attacker takes the territory, fighting until the defender is
 * wiped out or the attacker is down to its last (immovable) army.
 *
 * `a` is armies in the attacking territory, `d` armies defending.
 */
export function winProb(a: number, d: number): number {
  if (d <= 0) return 1
  if (a <= 1) return 0
  if (a > EXACT_CAP || d > EXACT_CAP) {
    const s = inRange(a, d)
    return winProb(s.a, s.d) // probability is scale-free
  }
  const k = key(a, d)
  const hit = winMemo.get(k)
  if (hit !== undefined) return hit
  let p = 0
  for (const e of exchangeOdds(attackerDice(a), defenderDice(d)))
    p += e.p * winProb(a - e.attackerLoss, d - e.defenderLoss)
  winMemo.set(k, p)
  return p
}

/**
 * Expected armies left in the attacking territory *given the attack succeeds*.
 * Always at least 1 — that army can't advance, which is what makes marginal
 * attacks so expensive: you win the territory and can't hold it.
 */
export function expectedSurvivors(a: number, d: number): number {
  if (d <= 0) return a
  if (a <= 1) return 0
  if (a > EXACT_CAP || d > EXACT_CAP) {
    const s = inRange(a, d)
    return expectedSurvivors(s.a, s.d) * s.k // survivors are a count, so scale back up
  }
  const k = key(a, d)
  const hit = survMemo.get(k)
  if (hit !== undefined) return hit
  const pWin = winProb(a, d)
  if (pWin === 0) {
    survMemo.set(k, 0)
    return 0
  }
  // E[survivors · 1{win}] accumulated, then divided by P(win)
  let acc = 0
  for (const e of exchangeOdds(attackerDice(a), defenderDice(d))) {
    const a2 = a - e.attackerLoss
    const d2 = d - e.defenderLoss
    if (d2 <= 0) acc += e.p * a2
    else if (a2 > 1) acc += e.p * winProb(a2, d2) * expectedSurvivors(a2, d2)
  }
  const out = acc / pWin
  survMemo.set(k, out)
  return out
}

/** Expected armies the attacker loses, win or lose. */
export function expectedLoss(a: number, d: number): number {
  if (d <= 0 || a <= 1) return 0
  const p = winProb(a, d)
  // on a loss the attacker is always ground down to exactly 1
  return p * (a - expectedSurvivors(a, d)) + (1 - p) * (a - 1)
}

/**
 * Smallest attacking stack that takes a `d`-army territory with at least
 * `confidence` probability. Capped so a hopeless ask returns Infinity rather
 * than looping.
 */
export function armiesNeededFor(d: number, confidence = 0.7, cap = 200): number {
  for (let a = 2; a <= cap; a++) if (winProb(a, d) >= confidence) return a
  return Infinity
}

/**
 * Odds of clearing a whole sequence of territories with one stack, carrying the
 * expected survivors forward. Approximate — it follows the expected case rather
 * than the full distribution — but good enough to compare candidate routes.
 */
export function chainOdds(a: number, defenders: number[]): { p: number; survivors: number } {
  let p = 1
  let armies = a
  for (const d of defenders) {
    const step = winProb(armies, d)
    if (step === 0) return { p: 0, survivors: 0 }
    p *= step
    // the dice that won advance, so the stack carries on minus its losses
    armies = Math.max(1, Math.round(expectedSurvivors(armies, d)))
  }
  return { p, survivors: armies }
}
