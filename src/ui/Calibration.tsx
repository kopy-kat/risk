/**
 * The calibration report, facing the per-move verdicts across the review screen.
 *
 * The move review answers "was that the best move?". This answers a question the
 * board cannot: "when you say 80%, how often are you right?" — which is why the
 * two live on separate tabs rather than competing for the same panel.
 */
import type { Bias, Bucket, Scored, TrendPoint, TurnRead } from '../coach/calibration'
import { driftOf } from '../coach/calibration'

export interface CoachReport {
  scored: Scored[]
  buckets: Bucket[]
  brier: number | null
  bias: Bias | null
  trend: TrendPoint[]
  turns: TurnRead[]
}

const DRIFT_NOTE: Record<'sharpening' | 'holding' | 'slipping', string> = {
  sharpening: 'your reads are getting closer to the truth',
  holding: 'no movement either way yet',
  slipping: 'your reads are drifting away from the truth',
}

const signed = (n: number) => `${n > 0 ? '+' : '−'}${Math.abs(Math.round(n))}`

export function Calibration({ report }: { report: CoachReport }) {
  const { scored, buckets, brier, bias, trend, turns } = report
  const drift = driftOf(trend)

  return (
    <div className="calib">
      <div className="calib-sheet">
        <header>
          <div className="stat">
            <span className="k">Brier</span>
            <span className="v">{brier === null ? '—' : brier.toFixed(3)}</span>
            <span className="u">0 perfect · .25 a coin flip</span>
          </div>
          <div className="stat">
            <span className="k">Settled</span>
            <span className="v">{scored.length}</span>
            <span className="u">predictions, all games</span>
          </div>
          <p className="lead">
            {bias
              ? bias.sentence
              : scored.length
                ? 'Nothing yet runs the same way often enough to call a bias. Keep logging.'
                : 'No prediction has reached its horizon yet.'}
          </p>
        </header>

        <section>
          <h2 className="mono-label">Reliability</h2>
          {buckets.length ? (
            <table className="calib-table">
              <thead>
                <tr><th>Said</th><th>Claims</th><th>Right</th><th>Gap</th><th /></tr>
              </thead>
              <tbody>
                {buckets.map((b) => {
                  const right = Math.round((b.correct / b.claims) * 100)
                  return (
                    <tr key={b.confidence}>
                      <td className="n">{b.confidence}%</td>
                      <td className="n">{b.claims}</td>
                      <td className="n">{right}%</td>
                      <td className={`n gap ${b.gap > 0 ? 'over' : b.gap < 0 ? 'under' : ''}`}>
                        {b.gap === 0 ? '—' : signed(-b.gap)}
                      </td>
                      {/* the row in words, because a signed number is not a lesson */}
                      <td className="say">
                        At {b.confidence}% you were right {right}% of the time
                        {b.gap >= 10 ? ' — overconfident' : b.gap <= -10 ? ' — you sold yourself short' : ''}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <p className="idle">Buckets fill as predictions settle.</p>
          )}
        </section>

        <section>
          <h2 className="mono-label">Across games</h2>
          {trend.length ? (
            <>
              <div className="calib-trend">
                {trend.map((t, i) => (
                  <div className="pt" key={t.gameId}>
                    <span className="g">Game {i + 1}</span>
                    <span className="b">{t.brier.toFixed(3)}</span>
                    <span className="c">{t.claims} settled</span>
                  </div>
                ))}
              </div>
              {drift && <p className="idle">{DRIFT_NOTE[drift]}</p>}
            </>
          ) : (
            <p className="idle">One game's worth so far — a trend needs two.</p>
          )}
        </section>

        <section>
          <h2 className="mono-label">This game, turn by turn</h2>
          {turns.length ? (
            <div className="calib-turns">
              {turns.map((t) => (
                <div className="entry" key={t.turn}>
                  <span className="turn">{String(t.turn).padStart(2, '0')}</span>
                  <div className="body">
                    {t.intent && <p className="intent">“{t.intent}”</p>}
                    <p className="was">{t.happened}</p>
                    {t.claim && (
                      <p className={`call ${t.correct === null ? 'open' : t.correct ? 'hit' : 'miss'}`}>
                        {t.confidence}% · {t.claim} ·{' '}
                        {t.correct === null ? 'still open' : t.correct ? 'right' : 'wrong'}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="idle">Nothing was logged this game.</p>
          )}
        </section>
      </div>
    </div>
  )
}
