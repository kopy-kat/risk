import type { RollMode } from './Dock'

/**
 * The whole keyboard surface. It's short on purpose: anything that merely
 * duplicated Space or a button next to it (end turn, skip bots, blitz toggle,
 * arrow nudging) was cut rather than listed.
 */
const KEYS: [string, string][] = [
  ['Space', 'Press the highlighted button'],
  ['Esc', 'Deselect / close'],
  ['⌘Z', 'Undo — until you roll dice'],
  ['0–9', 'Type an amount · 0 means all'],
  ['⇧ click', 'Invert: place all, or roll once'],
]

interface Props {
  rollMode: RollMode
  onSetRollMode(m: RollMode): void
  onClose(): void
}

/** Small popover above the bar — for the knobs that aren't worth permanent space. */
export function Settings({ rollMode, onSetRollMode, onClose }: Props) {
  return (
    <>
      <div className="popover-scrim" onClick={onClose} />
      <div className="popover" role="dialog" aria-label="Settings">
        <div className="row">
          <span className="mono-label">Attack rolls</span>
          <span className="toggle">
            <button className={rollMode === 'blitz' ? 'on' : ''} onClick={() => onSetRollMode('blitz')}>Blitz</button>
            <button className={rollMode === 'single' ? 'on' : ''} onClick={() => onSetRollMode('single')}>Single</button>
          </span>
        </div>
        <p className="note">
          Blitz rolls until the territory falls or you're down to one army.
          Shift-click a target to invert it for a single attack.
        </p>
        <div className="keys">
          <span className="mono-label">Keys</span>
          {KEYS.map(([k, what]) => (
            <div className="keyrow" key={k}>
              <dt><kbd>{k}</kbd></dt>
              <dd>{what}</dd>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
