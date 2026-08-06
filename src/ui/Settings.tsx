/**
 * The whole keyboard surface. It's short on purpose: anything that merely
 * duplicated Space or a button next to it (end turn, skip bots, typing amounts)
 * was cut rather than listed.
 */
const KEYS: [string, string][] = [
  ['Space', 'Press the highlighted button'],
  ['Esc', 'Deselect / close'],
  ['⌘Z', 'Undo — until you roll dice'],
  ['⇧ click', 'Deploy everything at once'],
]

interface Props {
  seed: number
  onClose(): void
}

/** Small popover above the bar — for the knobs that aren't worth permanent space. */
export function Settings({ seed, onClose }: Props) {
  return (
    <>
      <div className="popover-scrim" onClick={onClose} />
      <div className="popover" role="dialog" aria-label="Settings">
        <p className="note">
          Attacks roll until the territory falls or you're down to one army.
        </p>
        <div className="row seedrow">
          <span className="mono-label">Seed</span>
          <button
            className="seedval"
            title="Copy — paste it on the setup screen to replay this exact game"
            onClick={() => navigator.clipboard?.writeText(String(seed))}
          >{seed}</button>
        </div>
        <p className="note">
          One number behind the whole game: the deal, every die, every bot choice.
          Copy it to play the same game again.
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
