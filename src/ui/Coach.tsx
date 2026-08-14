/**
 * The commander's log, as a strip on the bottom bar.
 *
 * It is an offer, never a step. Closed, it is one line you can ignore: the bar
 * underneath keeps every key and every button it had, and the first move of the
 * turn takes the strip away. Only once you open it deliberately does it hold the
 * keyboard — the same bargain the seat-name fields make in setup — and `Esc` puts
 * it back at any point without writing anything.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { GameState, PlayerId } from '../engine/types'
import { CONFIDENCE_STEPS, claimChip, describeClaim, offerClaims } from '../coach/claims'
import type { Claim } from '../coach/claims'

export interface CoachProps {
  state: GameState
  open: boolean
  onOpen(): void
  onDismiss(): void
  onSave(intent: string, claim: Claim | null, confidence: number): void
}

const DEFAULT_CONFIDENCE = CONFIDENCE_STEPS.indexOf(70)

export function Coach({ state, open, onOpen, onDismiss, onSave }: CoachProps) {
  const me = state.current
  const claims = useMemo(() => offerClaims(state, me), [state, me])
  const [intent, setIntent] = useState('')
  /** the intent is typed, the prediction is picked — and they can't share the arrows */
  const [step, setStep] = useState<'intent' | 'predict'>('intent')
  const [pick, setPick] = useState(0)
  const [conf, setConf] = useState(DEFAULT_CONFIDENCE)
  const field = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const name = (p: PlayerId) => state.players[p].name

  useEffect(() => {
    if (!open) return
    if (step === 'intent') field.current?.focus()
    else box.current?.focus()
  }, [open, step])

  if (!open) {
    return (
      <div className="coach shut">
        <span className="mono-label">Commander's log</span>
        <button className="offer" onClick={onOpen}>
          What's the plan for turn {state.turn}, and what do you expect back? <kbd>L</kbd>
        </button>
        <button className="pass" onClick={onDismiss}>Not now <kbd>Esc</kbd></button>
      </div>
    )
  }

  const save = () => onSave(intent.trim(), claims[pick] ?? null, CONFIDENCE_STEPS[conf])

  /**
   * While the log is open it owns every key it names, and `stopPropagation` is
   * what keeps that promise — App's handler is on `window`, so an unconsumed
   * arrow would size a deploy behind the strip.
   */
  const onKey = (e: ReactKeyboardEvent) => {
    const take = () => { e.preventDefault(); e.stopPropagation() }
    if (e.key === 'Escape') { take(); onDismiss(); return }
    if (e.key === 'Enter') {
      take()
      if (step === 'intent' && claims.length) setStep('predict')
      else save()
      return
    }
    if (step !== 'predict') return
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      take()
      const d = e.key === 'ArrowRight' ? 1 : -1
      setConf((c) => Math.min(Math.max(c + d, 0), CONFIDENCE_STEPS.length - 1))
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      take()
      const d = e.key === 'ArrowDown' ? 1 : claims.length - 1
      setPick((p) => (p + d) % claims.length)
    } else if (e.key === ' ') {
      // Space presses the one dark button in the bar, and while the log is open
      // that button is Log it — anything else would make the label a half-truth
      take()
      save()
    }
  }

  return (
    <div className="coach open" ref={box} tabIndex={-1} onKeyDown={onKey}>
      <div className={`crow ${step === 'intent' ? 'live' : ''}`}>
        <span className="mono-label">Intent</span>
        <input
          ref={field}
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onFocus={() => setStep('intent')}
          placeholder="Take Australia and hold the Siam chokepoint"
          aria-label="What you mean to do this turn"
        />
        <span className="mono-label hint">
          {step === 'intent' ? <><kbd>⏎</kbd> next</> : <><kbd>Esc</kbd> put it away</>}
        </span>
      </div>

      {claims.length > 0 && (
        <div className={`crow ${step === 'predict' ? 'live' : ''}`}>
          <span className="mono-label">Predict</span>
          <div className="picks">
            {claims.map((c, i) => (
              <button
                key={claimChip(c, name)}
                className={`pill ${i === pick ? 'on' : ''}`}
                title={describeClaim(c, name)}
                onClick={() => { setPick(i); setStep('predict') }}
              >
                {claimChip(c, name)}
              </button>
            ))}
          </div>
          <div className="conf">
            {CONFIDENCE_STEPS.map((p, i) => (
              <button
                key={p}
                className={`pill ${i === conf ? 'on' : ''}`}
                onClick={() => { setConf(i); setStep('predict') }}
              >
                {p}%
              </button>
            ))}
          </div>
          <button className="btn primary" onClick={save}>Log it <kbd>⏎</kbd></button>
        </div>
      )}
    </div>
  )
}
