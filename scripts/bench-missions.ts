/**
 * Every Kessel mission, played from the player's side by each doctrine.
 *
 *   npm run bench:missions            every mission, 100 games per doctrine
 *   npm run bench:missions -- sedan 300
 *   npm run bench:missions -- sedan --level 2   as it plays once mastered twice
 *
 * Two questions. Is the mission a contest — does some doctrine win it and some
 * lose it, and do the stars spread? And does the enemy learn — once it has adapted
 * to how a doctrine plays, does that doctrine win less? Each doctrine is played
 * first against the mission's own enemy, then against that enemy adapted to the
 * tells the first run recorded, on the same seeds, so the difference is the
 * adaptation and nothing else.
 */
import { adapt, meanTells } from '../src/games/kessel/adapt'
import type { Tells } from '../src/games/kessel/adapt'
import { DOCTRINES } from '../src/games/kessel/bot'
import { MISSIONS } from '../src/games/kessel/missions'
import type { Job, Outcome } from './match'
import { playGames } from './parallel'
import { wilson } from './stats'

const args = process.argv.slice(2)
const at = args.indexOf('--level')
const level = at === -1 ? 0 : Number(args.splice(at, 2)[1])
const games = Number(args.at(-1)) > 0 ? Number(args.pop()) : 100
const missions = MISSIONS.filter((m) => args.length === 0 || args.some((a) => m.id.startsWith(a)))

const pct = (x: number) => `${(x * 100).toFixed(0)}%`

function summarise(outcomes: Outcome[], player: number) {
  const won = outcomes.filter((o) => o.winner === player)
  const w = { p: won.length / outcomes.length, half: wilson(won.length, outcomes.length).half }
  const stars = [1, 2, 3].map((n) => won.filter((o) => o.stars === n).length)
  const turns = outcomes.reduce((n, o) => n + o.turns, 0) / outcomes.length
  const share = outcomes.reduce((n, o) => n + (o.aims?.[player] ?? 0), 0) / outcomes.length
  const tells = meanTells(outcomes.map((o) => o.tells?.[player]).filter((t): t is Tells => !!t))
  return { w, stars, turns, share, tells }
}

const t0 = Date.now()
for (const mission of MISSIONS.filter((m) => missions.includes(m))) {
  const base = DOCTRINES.find((d) => d.key === mission.enemy)!
  const player = mission.player
  const jobsFor = (d: string, enemy?: typeof base): Job[] =>
    Array.from({ length: games }, (_, i) => {
      const order = ['', '']
      order[player] = `kessel-${d}`
      order[1 - player] = enemy ? 'adapted' : `kessel-${base.key}`
      return {
        game: 'kessel',
        order,
        seed: i + 1,
        turnCap: 100,
        scenario: mission.id,
        level,
        ...(enemy && { doctrines: { adapted: enemy } }),
      }
    })

  console.log(`\n${mission.name} (${mission.id}, level ${level + 1}) — you are ${mission.sides[player]}, the enemy fights ${base.name}`)
  console.log('doctrine      win            ★/★★/★★★     held   turns  rings   adapted win   Δ')
  for (const d of DOCTRINES) {
    const first = summarise((await playGames(jobsFor(d.key))).outcomes, player)
    const { doctrine } = adapt(base, mission.destroy ? null : first.tells)
    const second = summarise((await playGames(jobsFor(d.key, doctrine))).outcomes, player)
    const delta = second.w.p - first.w.p
    console.log(
      `${d.name.padEnd(13)} ${pct(first.w.p).padStart(4)} ±${pct(first.w.half).padEnd(5)}   ` +
        `${first.stars.join("/").padEnd(12)} ${pct(first.share).padStart(4)}   ${first.turns.toFixed(1).padStart(5)}  ` +
        `${pct(first.tells?.rings ?? 0).padStart(5)}   ` +
        `${pct(second.w.p).padStart(4)} ±${pct(second.w.half).padEnd(5)} ${delta >= 0 ? '+' : ''}${pct(delta)}`,
    )
  }
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s`)
