/**
 * Reviewing a finished war.
 *
 * Same screen as Risk's review and deliberately so — a player should not have to
 * learn a second interface to be told the same two things. What changes is the
 * unit: Risk grades a move, Kessel grades a turn, so a tick on the tape is one
 * whole order set and the map shows that order set the way the live game shows
 * staged orders. A recommendation and an intention are the same thing at
 * different times, so they are drawn the same way.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlayerId } from '../engine/types'
import { mapOf } from '../games/kessel/map'
import type { ProvinceId } from '../games/kessel/map'
import { retreatOptions } from '../games/kessel/supply'
import type { KesselState, Order } from '../games/kessel/types'
import { projectMoves } from '../review/kessel/price'
import type { OrderSet } from '../review/kessel/price'
import {
  KESSEL_FAULT_LABEL,
  describeOrders,
  isNotableTurn,
} from '../review/kessel/review'
import type { KesselGameReview } from '../review/kessel/review'
import type { FromKesselReviewWorker } from '../review/kessel/review.worker'
import { replay } from '../review/replay'
import { getGame } from '../review/store'
import type { Grade } from '../review/review'
import { playerColor } from './colors'
import { KesselMap } from './KesselMap'

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

const NO_TARGETS = new Map<ProvinceId, Order['type']>()

export function KesselReview({ id, onExit }: Props) {
  const record = useMemo(() => getGame(id), [id])
  const [review, setReview] = useState<KesselGameReview | null>(null)
  const [subject, setSubject] = useState<PlayerId | null>(null)
  /** which judgement the screen is on */
  const [cursor, setCursor] = useState(0)
  /** whether the map is showing the orders given or the ones that were better */
  const [showing, setShowing] = useState<'played' | 'better'>('better')
  const [hover, setHover] = useState<ProvinceId | null>(null)
  const [progress, setProgress] = useState<number | null>(0)

  useEffect(() => {
    if (!record) return
    let live = true
    setProgress(0)
    const worker = new Worker(new URL('../review/kessel/review.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = ({ data }: MessageEvent<FromKesselReviewWorker>) => {
      if (!live) return
      if (data.kind === 'progress') {
        setProgress(data.total ? data.done / data.total : 1)
        return
      }
      // The boards are replayed here rather than sent back: a war is a thousand
      // full positions and rebuilding them from the record is milliseconds.
      const r = replay<KesselState>(record)
      setReview({ ...data.verdicts, replay: r, error: r.error })
      setSubject(data.verdicts.reviewed[0] ?? null)
      setCursor(0)
    }
    worker.onerror = () => {
      if (live) setProgress(null)
    }
    worker.postMessage(record)
    return () => {
      live = false
      worker.terminate()
    }
  }, [record])

  const judgements = useMemo(
    () => (review?.judgements ?? []).filter((j) => subject === null || j.player === subject),
    [review, subject],
  )
  const here = judgements[Math.min(cursor, judgements.length - 1)] ?? null
  const notable = useMemo(() => judgements.filter((j) => isNotableTurn(j.grade)), [judgements])

  const states = review?.replay.states ?? []
  const board: KesselState | null = here ? (states[here.index] ?? null) : (states[0] ?? null)
  const shown = useMemo<OrderSet>(
    () => (here ? (showing === 'better' ? here.best : here.orders) : {}),
    [here, showing],
  )

  /**
   * The board the shown orders would produce, so a ring closed by this turn's
   * moves is drawn as closed — the same reading the live game gives before the
   * button is pressed.
   */
  const painted = useMemo(
    () => (board ? { ...projectMoves(board, shown), orders: shown } : null),
    [board, shown],
  )
  const pockets = useMemo(() => {
    const out = new Set<ProvinceId>()
    if (!painted) return out
    const m = mapOf(painted.mapId)
    for (const f of painted.formations) {
      if (retreatOptions(m, painted, f).length === 0) out.add(f.at)
    }
    return out
  }, [painted])

  const step = (d: number) =>
    setCursor((c) => Math.min(Math.max(c + d, 0), Math.max(0, judgements.length - 1)))
  const jump = (d: number) => {
    if (!notable.length) return
    const at = judgements.indexOf(
      d > 0
        ? (notable.find((j) => judgements.indexOf(j) > cursor) ?? notable[0])
        : ([...notable].reverse().find((j) => judgements.indexOf(j) < cursor) ??
            notable[notable.length - 1]),
    )
    if (at >= 0) setCursor(at)
  }

  /** The tape is longer than the bar, so the cursor has to carry the view with it. */
  const tape = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = tape.current
    if (!el) return
    const tick = el.children[cursor] as HTMLElement | undefined
    if (!tick) return
    const box = el.getBoundingClientRect()
    const t = tick.getBoundingClientRect()
    const pad = 26
    const left = t.left - box.left
    const right = left + t.width
    let to = el.scrollLeft
    if (left < pad) to = el.scrollLeft + left - pad
    else if (right > box.width - pad) to = el.scrollLeft + right - box.width + pad
    if (Math.abs(to - el.scrollLeft) > 1) el.scrollTo({ left: to, behavior: 'smooth' })
  }, [cursor])

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

  if (!record) return <Shell onExit={onExit}><Empty>That war is no longer stored.</Empty></Shell>
  if (!review) {
    return (
      <Shell onExit={onExit}>
        {progress === null ? (
          <Empty>The analysis stopped before it finished.</Empty>
        ) : (
          <Empty>
            Analysing… {Math.round(progress * 100)}%
            <div className="bar"><i style={{ width: `${progress * 100}%` }} /></div>
          </Empty>
        )}
      </Shell>
    )
  }
  if (!board || !painted) {
    return <Shell onExit={onExit}><Empty>{review.error ?? 'Nothing to replay.'}</Empty></Shell>
  }

  const m = mapOf(board.mapId)
  const summary = review.byPlayer.find((b) => b.player === subject) ?? review.byPlayer[0]

  return (
    <div className="app review">
      <div className="topbar">
        <div className="wordmark">REVIEW<span>.</span></div>
        <div className="mono-label">
          {here ? `Turn ${String(here.turn).padStart(2, '0')}` : 'No orders of yours'}
          {' · '}order set {Math.min(cursor + 1, judgements.length)} / {judgements.length}
        </div>
        <div className="spacer" />

        {review.reviewed.length > 1 && (
          <div className="seatpick">
            <span className="mono-label">Reviewing</span>
            <div className="toggle">
              {review.reviewed.map((p) => (
                <button
                  key={p}
                  className={p === subject ? 'on' : ''}
                  onClick={() => { setSubject(p); setCursor(0) }}
                >
                  {record.seats[p].name}
                </button>
              ))}
            </div>
          </div>
        )}

        {summary && (
          <div className="verdict">
            {/* Deliberately side by side and deliberately separate. One is the
                part you chose; the other is what the resolution did about it.
                Merging them is how a review starts lying. */}
            <div className="stat">
              <span className="k">Given up</span>
              <span className="v">{summary.meanLoss.toFixed(1)}</span>
              <span className="u">steps / turn</span>
            </div>
            <div className="stat">
              <span className="k">Resolution</span>
              <span className={`v ${summary.luck >= 0 ? 'up' : 'down'}`}>
                {summary.luck >= 0 ? '+' : ''}{summary.luck.toFixed(0)}
              </span>
              <span className="u">steps vs expected</span>
            </div>
          </div>
        )}
        <button className="btn ghost" onClick={onExit}>Done ⎋</button>
      </div>

      <main className="stage">
        <KesselMap
          state={painted}
          acting={null}
          selected={null}
          targets={NO_TARGETS}
          pockets={pockets}
          hover={hover}
          onPick={noop}
          onHover={setHover}
        />

        {review.error && <div className="replay-warn mono-label">{review.error}</div>}

        {summary && summary.decisions > 0 && (
          <div className="rev-habits">
            {/* A hundred verdicts is a transcript. What someone can act on is the
                two or three things they did wrong over and over. */}
            <div className="mono-label">Cost you more than once</div>
            {summary.habits.slice(0, 3).map((h) => (
              <div className="habit" key={h.fault}>
                <span className="v">{KESSEL_FAULT_LABEL[h.fault]}</span>
                <span className="n">{h.count}× · −{h.cost.toFixed(0)}</span>
              </div>
            ))}
            {!summary.habits.length && (
              <div className="habit"><span className="v">Nothing that cost you twice.</span></div>
            )}
          </div>
        )}

        <div className="rev-panel">
          {here ? (
            <>
              <div className={`grade ${here.grade}`}>
                {GRADE_LABEL[here.grade]}
                {here.loss >= 0.5 && <em>−{here.loss.toFixed(1)}</em>}
              </div>

              <button
                className={`line ${showing === 'played' ? 'on' : ''}`}
                onClick={() => setShowing('played')}
              >
                <span className="k">You ordered</span>
                <span className="v">{describeOrders(m, board, here.orders, here.player)}</span>
              </button>

              {here.grade !== 'best' && (
                <button
                  className={`line better ${showing === 'better' ? 'on' : ''}`}
                  onClick={() => setShowing('better')}
                >
                  <span className="k">Better</span>
                  <span className="v">
                    {here.bestLabel}
                    <em>{describeOrders(m, board, here.best, here.player)}</em>
                  </span>
                </button>
              )}

              <p className="note">{here.note}</p>

              {/* Each line is the player's own orders with one thing changed,
                  priced on the same resolutions — so the number beside it is what
                  fixing that alone was worth, not a share of the turn's loss. */}
              {here.findings.length > 0 && (
                <div className="fixes">
                  <div className="mono-label">Worth changing</div>
                  {here.findings.slice(0, 3).map((f) => (
                    <div className="fix" key={f.fault}>
                      <span className="n">−{f.cost.toFixed(1)}</span>
                      <span className="v">{f.advice}</span>
                    </div>
                  ))}
                </div>
              )}

              {Math.abs(here.luck) > 1 && (
                <p className={`luck ${here.luck >= 0 ? 'up' : 'down'}`}>
                  {here.luck >= 0
                    ? `The resolution went your way here: ${here.luck.toFixed(1)} steps better than the orders were worth.`
                    : `The resolution went against you here: ${Math.abs(here.luck).toFixed(1)} steps worse than the orders were worth. That isn't on you.`}
                </p>
              )}
            </>
          ) : (
            <p className="note idle">Nothing of yours to review in this war.</p>
          )}
        </div>

        <div className="rev-bar">
          <button className="nav" onClick={() => step(-1)} aria-label="Previous turn">←</button>
          <div className="tape" ref={tape}>
            {judgements.map((j, i) => (
              <button
                key={j.index}
                className={`tick ${j.grade} ${i === cursor ? 'on' : ''}`}
                style={{ ['--c' as string]: playerColor(record.seats[j.player].color ?? j.player) }}
                onClick={() => setCursor(i)}
                title={`Turn ${j.turn} · ${GRADE_LABEL[j.grade]}`}
                aria-label={`Turn ${j.turn}, ${GRADE_LABEL[j.grade]}`}
              />
            ))}
          </div>
          <button className="nav" onClick={() => step(1)} aria-label="Next turn">→</button>
          <div className="div" />
          <button className="btn ghost" onClick={() => jump(1)} disabled={!notable.length}>
            Next mistake ↓
          </button>
        </div>
      </main>
    </div>
  )
}

const noop = () => {}

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
