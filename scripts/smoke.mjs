/**
 * Browser smoke test, end to end.
 *
 *   npm run build && npm run smoke
 *
 * The unit tests cover the engine and the reviewer's arithmetic; this covers the
 * parts only a browser has — that a game played through the UI actually reaches
 * localStorage, that a stored game replays and reviews, and that the review
 * screen's navigation works. Those are exactly the failures that don't show up
 * in `npm test` and do show up to a user immediately.
 *
 * Uses your installed Chrome, like the geometry solvers.
 */
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'

const PORT = 4173
const URL = `http://localhost:${PORT}/`

// ── a stored game to review, generated from the engine itself ──────
// Seat 0 is *recorded* as human while a bot actually played it, which is what
// gives the reviewer a full game of real decisions to judge.
const { BOT_BY_KEY } = await import('../src/bots/index.ts')
const { stepBot } = await import('../src/bots/play.ts')
const { RULES_VERSION, createGame } = await import('../src/engine/game.ts')
const { rngFrom } = await import('../src/engine/rng.ts')

// `age` keeps the listing order deterministic — it sorts newest first, and three
// records written in the same millisecond would otherwise come back in any order
function record(seed, seats, drivers, { rules = RULES_VERSION, age = 0 } = {}) {
  const rng = rngFrom((seed ^ 0x9e3779b9) >>> 0)
  let s = createGame({ seats, seed })
  while (s.phase !== 'gameOver' && s.turn < 200) {
    s = stepBot(s, BOT_BY_KEY[drivers[s.current]], () => rng.next())
  }
  return {
    id: `${seed}-smoke`, schema: 1, rules, seed, botSeed: seed ^ 0x9e3779b9,
    seats, moves: s.moves, assisted: [], winner: s.winner, turns: s.turn,
    finished: s.phase === 'gameOver', savedAt: Date.now() - age,
  }
}

const solo = record(
  20260806,
  [{ name: 'Crimson', bot: null }, { name: 'Azure', bot: 'general' }, { name: 'Amber', bot: 'colonel' }],
  ['colonel', 'general', 'colonel'],
)
const hotseat = record(
  777001,
  [{ name: 'Crimson', bot: null }, { name: 'Azure', bot: null }, { name: 'Amber', bot: 'general' }],
  ['colonel', 'general', 'general'],
  { age: 60_000 },
)
// same game, stamped with rules that no longer exist — must be quarantined, not replayed
const stale = {
  ...record(4242, solo.seats, ['colonel', 'general', 'colonel'], { rules: 'ANCIENT-RULES', age: 120_000 }),
  id: 'stale-smoke',
}

const seeded = JSON.stringify([solo, hotseat, stale])

// ── serve the build ────────────────────────────────────────────────
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT)], { stdio: 'ignore' })
const stop = () => { try { server.kill() } catch { /* already gone */ } }
process.on('exit', stop)

for (let i = 0; ; i++) {
  try { await fetch(URL); break } catch {
    if (i > 60) { console.error('preview server never came up — run npm run build first'); stop(); process.exit(1) }
    await new Promise((r) => setTimeout(r, 250))
  }
}

const browser = await chromium.launch({ channel: 'chrome' })
const errors = []
const failures = []
let checks = 0
const ok = (cond, what) => { checks++; if (!cond) failures.push(what) }

async function open(withHistory) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`) })
  if (withHistory) await page.addInitScript((v) => localStorage.setItem('risk.games.v1', v), seeded)
  await page.goto(URL, { waitUntil: 'networkidle' })
  return page
}

// ── A) a game played through the UI is recorded ────────────────────
{
  const page = await open(false)
  await page.getByRole('button', { name: '2', exact: true }).click()
  await page.getByRole('button', { name: 'Begin deployment' }).click()
  await page.getByRole('button', { name: /Auto-place rest/ }).click()

  // Driving a live game races the bots' own timers: a territory can stop being a
  // legal target, or the game can end, between reading the board and clicking it.
  // These clicks are only here to *generate* a game, so a stale one is skipped
  // rather than failed — every actual assertion is below, against the result.
  const nudge = (locator, opts) =>
    locator.first().click({ timeout: 1000, ...opts }).then(() => true, () => false)

  for (let i = 0; i < 220; i++) {
    if (await page.locator('.overlay .winner').count()) break
    const phase = await page.locator('.phase-pill.active').first().textContent().catch(() => null)
    const clickable = page.locator('.terr.clickable')
    const n = await clickable.count()
    if (phase === 'Deploy' && n) await nudge(clickable, { modifiers: ['Shift'] })
    else if (phase === 'Attack' && n && i % 3 === 0) await nudge(clickable)
    else await page.keyboard.press(' ')
    await page.waitForTimeout(8)
  }

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('risk.games.v1') ?? '[]'))
  ok(stored.length === 1, `exactly one game stored, got ${stored.length}`)
  ok(stored[0]?.moves?.length > 20, `the move list was recorded, got ${stored[0]?.moves?.length}`)
  ok(stored[0]?.assisted?.length > 0, 'auto-placed moves are marked as assisted')
  ok(stored[0]?.seed > 0 && !!stored[0]?.rules, 'the record carries its seed and rules fingerprint')
  await page.close()
}

// ── B) a stored game replays and reviews ───────────────────────────
{
  const page = await open(true)
  ok((await page.locator('.games .game').count()) === 3, 'all stored games are listed')
  ok(
    (await page.locator('.game.stale').count()) === 1,
    'the game played under other rules is marked, not offered',
  )
  ok(
    await page.locator('.game.stale .open').first().isDisabled(),
    'and it cannot be opened',
  )

  await page.locator('.games .game:not(.stale)').first().locator('.open').click()
  await page.waitForSelector('.rev-bar', { timeout: 60000 })
  await page.waitForTimeout(400)

  const ticks = await page.locator('.rev-bar .tick').count()
  ok(ticks > 20, `the tape has the seat's decisions on it, got ${ticks}`)
  ok((await page.locator('.review .stat').count()) === 2, 'accuracy and luck are reported separately')

  // the game-level read, alongside the per-decision one
  ok((await page.locator('.rev-habits .habit').count()) > 0, 'recurring faults are summarised')

  // stepping and jumping
  const at = () => page.locator('.topbar .mono-label').first().textContent()
  const t0 = await at()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  ok((await at()) !== t0, 'arrow keys step through the game')

  await page.getByRole('button', { name: /Next mistake/ }).click()
  await page.waitForTimeout(250)
  const grade = await page.locator('.rev-panel .grade').innerText()
  ok(/MISTAKE|BLUNDER/i.test(grade), `jumping lands on a mistake, got "${grade.split('\n')[0]}"`)
  ok(
    (await page.locator('.rev-panel .line.better').count()) === 1,
    'a mistake shows what would have been better',
  )
  ok(
    (await page.locator('.edge.sel, .edge.target').count()) > 0,
    'the recommendation is drawn on the map',
  )

  await page.locator('.rev-panel .line').first().click()
  await page.waitForTimeout(200)
  ok((await page.locator('.edge.sel, .edge.target').count()) > 0, 'and so is the move actually played')

  // A deploy is recommended with the rest of the turn behind it, which is the only
  // thing that makes "deploy 1 to Ural" readable. Scanned rather than jumped to:
  // which decisions have a continuation depends on the game.
  const marks = Math.min(await page.locator('.rev-bar .tick').count(), 80)
  let behind = 0
  for (let i = 0; i < marks && !behind; i++) {
    await page.locator('.rev-bar .tick').nth(i).click()
    await page.waitForTimeout(20)
    behind = await page.locator('.rev-panel .line.better .v em').count()
  }
  ok(behind > 0, 'a recommendation shows the turn it was for')

  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  ok((await page.locator('.panel h1').count()) > 0, 'escape returns to the setup screen')
  await page.close()
}

// ── C) a hotseat game keeps the two humans apart ───────────────────
{
  const page = await open(true)
  await page.locator('.games .game:not(.stale)').nth(1).locator('.open').click()
  await page.waitForSelector('.rev-bar', { timeout: 60000 })
  await page.waitForTimeout(400)

  ok((await page.locator('.seatpick .toggle button').count()) === 2, 'both human seats are offered')
  const first = await page.locator('.rev-bar .tick').count()
  const acc = () => page.locator('.review .stat .v').first().textContent()
  const a0 = await acc()

  await page.locator('.seatpick .toggle button').nth(1).click()
  await page.waitForTimeout(300)
  const second = await page.locator('.rev-bar .tick').count()
  const a1 = await acc()

  ok(first > 0 && second > 0, 'each seat has its own decisions')
  ok(a0 !== a1 || first !== second, 'switching seat changes whose game is being reported')
  await page.close()
}

// ── D) the recap, and replaying the turns it summarises ────────────
// The property is that Replay is a rewatch: the same board and the same
// generator produce the same turns, so the recorded move list after a replay is
// the one that was there before it. Nothing but a browser holds the two refs
// that have to survive the rewind.
{
  const page = await open(false)
  await page.getByRole('button', { name: 'Begin deployment' }).click()
  await page.getByRole('button', { name: /Auto-place rest/ }).click()
  await page.waitForSelector('.dock .amount', { timeout: 60000 })

  // your turn: place the lot, then hand over
  await page.locator('.terr.clickable').first().click({ modifiers: ['Shift'] })
  const primary = page.locator('.btn.primary')
  for (let i = 0; i < 6 && !/^Skip/i.test(await primary.innerText()); i++) {
    await primary.click()
    await page.waitForTimeout(120)
  }
  await primary.click()                                   // skip the bots' turns
  await page.waitForSelector('.recap', { timeout: 60000 })

  const lines = () => page.locator('.recap .lines').innerText()
  const moves = () => page.evaluate(() => JSON.parse(localStorage.getItem('risk.games.v1'))[0].moves)
  const said = await lines()
  const played = await moves()

  ok(/[+−]\d+ (army|armies)/.test(said), `the recap reports armies, got "${said.replace(/\n/g, ' / ')}"`)
  ok(!/attacked|traded a set/.test(said), 'and not the blow-by-blow')
  ok((await page.locator('.recap .line').count()) > 0, 'somebody is named in it')

  await page.locator('.recap .btn').click()
  ok((await page.locator('.recap').count()) === 0, 'replaying dismisses the recap it came from')
  await page.locator('.btn.primary').click()              // skip the same turns again
  await page.waitForSelector('.recap', { timeout: 60000 })

  ok((await lines()) === said, 'the replayed turns produce the same recap')
  ok(JSON.stringify(await moves()) === JSON.stringify(played), 'and exactly the same move list')
  await page.close()
}

await browser.close()
stop()

console.log(`${checks - failures.length}/${checks} browser checks passed`)
if (errors.length) console.error(`\nJS errors:\n  ${errors.join('\n  ')}`)
if (failures.length) console.error(`\nFAILED:\n  ${failures.join('\n  ')}`)
if (failures.length || errors.length) process.exit(1)
console.log('all green\n')
