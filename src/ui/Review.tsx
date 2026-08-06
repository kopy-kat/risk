/**
 * Reviewing a finished game.
 *
 * The screen has one job that the rest of the app doesn't: showing a move that
 * *wasn't* played. That's why the recommendation renders through the same
 * `selected` / `targets` / `preview` props the live game uses for a move you're
 * about to make — a suggestion and an intention should look identical, because
 * they're the same thing at different times.
 */
import { useEffect, useMemo, useState } from 'react'
import type { TerritoryId } from '../engine/board'
import type { GameState, Move, PlayerId } from '../engine/types'
import { describeMove, isNotable, reviewGame } from '../review/review'
import type { GameReview, Grade } from '../review/review'
import { getGame } from '../review/store'
import { MapView } from './MapView'
import { playerColor } from './colors'

interface Props {
  id: string
  onExit(): void
}

const GRADE_LABEL: Record<Grade, string> = {
  best: 'Best',
  good: 'Good',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
}

export function Review({ id, onExit }: Props) {
  const record = useMemo(() => getGame(id), [id])
  const [review, setReview] = useState<GameReview | null>(null)
  const [cursor, setCursor] = useState(0)
  /** whether the map is showing what you played or what was better */
  const [showing, setShowing] = useState<'played' | 'better'>('better')
  const [hover, setHover] = useState<TerritoryId | null>(null)

  // Analysis is a second or so of arithmetic. Kicking it to a timeout lets the
  // shell paint first, so the screen never appears to hang on open.
  useEffect(() => {
    if (!record) return
    let live = true
    const t = setTimeout(() => {
      const r = reviewGame(record)
      if (live) {
        const first = r.reviewed[0] ?? null
        setReview(r)
        setSubject(first)
        setCursor(r.judgements.find((j) => j.player === first)?.index ?? 0)
      }
    }, 0)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [record])

  /**
   * Whose game this is. Every human seat gets reviewed, but only one at a time is
   * on screen — a hotseat game would otherwise mix two people's decisions into one
   * tape and report the first seat's accuracy as though it were both.
   */
  const [subject, setSubject] = useState<PlayerId | null>(null)
  const judgements = useMemo(
    () => (review?.judgements ?? []).filter((j) => subject === null || j.player === subject),
    [review, subject],
  )
  /** the decision sitting at the cursor, if the cursor is on one */
  const here = useMemo(
    () => judgements.find((j) => j.index === cursor) ?? null,
    [judgements, cursor],
  )
  const notable = useMemo(() => judgements.filter((j) => isNotable(j.grade)), [judgements])

  const states = review?.replay.states ?? []
  const state: GameState | null = states[Math.min(cursor, states.length - 1)] ?? null

  const step = (d: number) => setCursor((c) => clamp(c + d, 0, Math.max(0, states.length - 1)))
  const jump = (d: number) => {
    if (!notable.length) return
    const next =
      d > 0
        ? notable.find((j) => j.index > cursor) ?? notable[0]
        : [...notable].reverse().find((j) => j.index < cursor) ?? notable[notable.length - 1]
    setCursor(next.index)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onExit() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); jump(-1) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); jump(1) }
      else if (e.key === ' ') {
        e.preventDefault()
        setShowing((v) => (v === 'better' ? 'played' : 'better'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // What to draw over the map: the move under consideration, rendered exactly the
  // way the live game renders a move you're lining up.
  const shown: Move | null = here ? (showing === 'better' ? here.best : here.played) : null
  const overlay = useMemo(() => paint(state, shown), [state, shown])

  if (!record) return <Shell onExit={onExit}><Empty>That game is no longer stored.</Empty></Shell>
  if (!review) return <Shell onExit={onExit}><Empty>Analysing…</Empty></Shell>
  if (!state) {
    return (
      <Shell onExit={onExit}>
        <Empty>{review.error ?? 'Nothing to replay.'}</Empty>
      </Shell>
    )
  }

  const summary = review.byPlayer.find((b) => b.player === subject) ?? review.byPlayer[0]

  return (
    <div className="app review">
      <div className="topbar">
        <div className="wordmark">REVIEW<span>.</span></div>
        <div className="mono-label">
          {state.phase === 'setup' ? 'Initial deployment' : `Turn ${String(state.turn).padStart(2, '0')}`}
          {' · '}move {cursor} / {states.length - 1}
        </div>
        <div className="spacer" />

        {/* only when there's someone to choose between — a solo game shouldn't
            grow a control that has one option */}
        {review.reviewed.length > 1 && (
          <div className="seatpick">
            <span className="mono-label">Reviewing</span>
            <div className="toggle">
              {review.reviewed.map((p) => (
                <button
                  key={p}
                  className={p === subject ? 'on' : ''}
                  onClick={() => {
                    setSubject(p)
                    setCursor(
                      review.judgements.find((j) => j.player === p)?.index ?? 0,
                    )
                  }}
                >
                  {record.seats[p].name}
                </button>
              ))}
            </div>
          </div>
        )}

        {summary && (
          <div className="verdict">
            {/* The two numbers are deliberately side by side and deliberately
                separate. One is the part you chose; the other is the part the
                dice chose. Merging them is how a review starts lying. */}
            <div className="stat">
              <span className="k">Given up</span>
              <span className="v">{summary.meanLoss.toFixed(1)}</span>
              <span className="u">armies / decision</span>
            </div>
            <div className="stat">
              <span className="k">Dice</span>
              <span className={`v ${summary.luck >= 0 ? 'up' : 'down'}`}>
                {summary.luck >= 0 ? '+' : ''}{summary.luck.toFixed(0)}
              </span>
              <span className="u">armies vs expected</span>
            </div>
          </div>
        )}
        <button className="btn ghost" onClick={onExit}>Done ⎋</button>
      </div>

      <main className="stage">
        <MapView
          state={state}
          selected={overlay.selected}
          targets={overlay.targets}
          clickable={EMPTY}
          focus={null}
          flash={null}
          preview={overlay.preview}
          hover={hover}
          onPick={noop}
          onHover={setHover}
        />

        {review.error && <div className="replay-warn mono-label">{review.error}</div>}

        <div className="rev-panel">
          {here ? (
            <>
              <div className={`grade ${here.grade}`}>
                {GRADE_LABEL[here.grade]}
                {here.loss >= 0.75 && <em>−{here.loss.toFixed(1)}</em>}
              </div>

              <button
                className={`line ${showing === 'played' ? 'on' : ''}`}
                onClick={() => setShowing('played')}
              >
                <span className="k">You played</span>
                <span className="v">{describeMove(state, here.played)}</span>
              </button>

              {here.grade !== 'best' && (
                <button
                  className={`line better ${showing === 'better' ? 'on' : ''}`}
                  onClick={() => setShowing('better')}
                >
                  <span className="k">Better</span>
                  <span className="v">{describeMove(state, here.best)}</span>
                </button>
              )}

              <p className="note">{here.note}</p>

              {here.luck !== null && Math.abs(here.luck) > 1 && (
                <p className={`luck ${here.luck >= 0 ? 'up' : 'down'}`}>
                  {here.luck >= 0
                    ? `The dice went your way here: ${here.luck.toFixed(1)} armies better than expected.`
                    : `The dice went against you here: ${Math.abs(here.luck).toFixed(1)} armies worse than expected. That isn't on you.`}
                </p>
              )}
            </>
          ) : (
            <p className="note idle">
              {judgements.length
                ? 'No decision of yours here — ↑ ↓ jumps to the ones worth seeing.'
                : 'Nothing of yours to review in this game.'}
            </p>
          )}
        </div>

        <div className="rev-bar">
          <button className="nav" onClick={() => step(-1)} aria-label="Previous move">←</button>
          <div className="tape">
            {/* every decision you made, in order, coloured by how it graded.
                It doubles as the scrubber — the shape of a game is legible from it */}
            {judgements.map((j) => (
              <button
                key={j.index}
                className={`tick ${j.grade} ${j.index === cursor ? 'on' : ''}`}
                style={{ ['--c' as string]: playerColor(j.player) }}
                onClick={() => setCursor(j.index)}
                title={`Turn ${j.turn} · ${GRADE_LABEL[j.grade]}`}
                aria-label={`Turn ${j.turn}, ${GRADE_LABEL[j.grade]}`}
              />
            ))}
          </div>
          <button className="nav" onClick={() => step(1)} aria-label="Next move">→</button>
          <div className="div" />
          <button className="btn ghost" onClick={() => jump(1)} disabled={!notable.length}>
            Next mistake ↓
          </button>
        </div>
      </main>
    </div>
  )
}

// ─────────────────────────── overlay ───────────────────────────

interface Overlay {
  selected: TerritoryId | null
  targets: Set<TerritoryId>
  preview: Record<TerritoryId, number> | null
}

const EMPTY: Set<TerritoryId> = new Set()
const noop = () => {}
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/** Draw a move on the map using the same vocabulary the live game uses. */
function paint(s: GameState | null, m: Move | null): Overlay {
  const none: Overlay = { selected: null, targets: EMPTY, preview: null }
  if (!s || !m) return none
  switch (m.type) {
    case 'attack':
    case 'blitz':
      // no troop preview: an attack is dice, so the map keeps showing what's
      // really there rather than a number it can't promise
      return { selected: m.from, targets: new Set([m.to]), preview: null }
    case 'fortify':
      return {
        selected: m.from,
        targets: new Set([m.to]),
        preview: { [m.from]: s.troops[m.from] - m.count, [m.to]: s.troops[m.to] + m.count },
      }
    case 'deploy':
      return { ...none, preview: { [m.territory]: s.troops[m.territory] + m.count } }
    case 'placeInitial':
      return { ...none, preview: { [m.territory]: s.troops[m.territory] + 1 } }
    case 'occupy': {
      const occ = s.pendingOccupation
      if (!occ) return none
      return {
        selected: occ.from,
        targets: new Set([occ.to]),
        preview: {
          [occ.from]: s.troops[occ.from] - m.count,
          [occ.to]: s.troops[occ.to] + m.count,
        },
      }
    }
    default:
      return none
  }
}

// ─────────────────────────── chrome ───────────────────────────

function Shell({ children, onExit }: { children: React.ReactNode; onExit(): void }) {
  return (
    <div className="app review">
      <div className="topbar">
        <div className="wordmark">REVIEW<span>.</span></div>
        <div className="spacer" />
        <button className="btn ghost" onClick={onExit}>Done ⎋</button>
      </div>
      <main className="stage">{children}</main>
    </div>
  )
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="rev-empty">{children}</div>
)
