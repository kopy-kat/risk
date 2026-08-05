import { CONTINENTS, TERRITORY_NAMES } from '../engine/board'
import type { TerritoryId } from '../engine/board'
import { cashValue, isValidSet } from '../engine/cards'
import { HAND_LIMIT, continentsHeldBy, territoriesOf } from '../engine/game'
import type { GameState } from '../engine/types'
import { SUIT_GLYPH, playerColor } from './colors'
import { Settings } from './Settings'

/** The one dark button in the bar. Space always presses it. */
export interface PrimaryAction {
  label: string
  run(): void
}

export type RollMode = 'blitz' | 'single'

export interface DockProps {
  state: GameState
  selected: TerritoryId | null
  /** chosen fortify destination, awaiting an amount */
  fortifyTo: TerritoryId | null
  amount: number
  selectedCards: number[]
  rollMode: RollMode
  primary: PrimaryAction | null
  setAmount(n: number): void
  onToggleCard(id: number): void
  onTrade(): void
  onCancel(): void
  onShowSettings(): void
  settingsOpen: boolean
  onSetRollMode(m: RollMode): void
  onCloseSettings(): void
  seed: number
  onUndo(): void
  canUndo: boolean
}

const nm = (t: TerritoryId) => TERRITORY_NAMES[t]

/**
 * One control for every "how many armies?" question. Deliberately not a text
 * input: a focusable field would own the Space key, which belongs to Confirm.
 * Digits are typed straight into it via the global key handler instead.
 */
function Amount({
  label, value, min, max, onChange, disabled = false,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange(n: number): void
  disabled?: boolean
}) {
  const v = Math.min(Math.max(value, min), max)
  return (
    <div className="amount">
      <span className="mono-label">{label}</span>
      <button className="preset" disabled={disabled || v <= min} onClick={() => onChange(min)}>Min</button>
      <button className="nudge" disabled={disabled || v <= min} onClick={() => onChange(v - 1)}>−</button>
      <span className="n">{v}</span>
      <button className="nudge" disabled={disabled || v >= max} onClick={() => onChange(v + 1)}>+</button>
      <button className="preset" disabled={disabled || v >= max} onClick={() => onChange(max)}>All</button>
      <span className="mono-label hint"><kbd>0–9</kbd></span>
    </div>
  )
}

export function Dock(props: DockProps) {
  const { state, primary, onShowSettings, onUndo, canUndo } = props
  const { settingsOpen, rollMode, onSetRollMode, onCloseSettings, seed } = props
  const me = state.players[state.current]
  const showUndo = !me.bot && state.phase !== 'setup'

  return (
    <div className="dock">
      <Identity state={state} />
      <div className="div" />

      {me.bot ? (
        <>
          <div className="prompt">
            <span className="k">Thinking</span>
            <span className="v">{describeBotPhase(state)}</span>
          </div>
          {state.lastBattle && state.phase !== 'setup' && (
            <><div className="div" /><Dice state={state} /></>
          )}
        </>
      ) : (
        <>
          {state.phase !== 'setup' && <Cards {...props} />}
          <PhaseControls {...props} />
        </>
      )}

      {showUndo && (
        <>
          <div className="div" />
          <button
            className="btn ghost"
            disabled={!canUndo}
            onClick={onUndo}
            title="Undo deploys and fortifies — closes once you roll dice"
          >
            Undo <kbd>⌘Z</kbd>
          </button>
        </>
      )}

      {primary && (
        <>
          <div className="div" />
          <button className="btn primary" onClick={primary.run}>
            {primary.label} <kbd>␣</kbd>
          </button>
        </>
      )}
      <button
        className={`btn help ${settingsOpen ? 'on' : ''}`}
        onClick={onShowSettings}
        title="Settings and shortcuts"
        aria-label="Settings"
      >⚙</button>

      {settingsOpen && (
        <Settings
          rollMode={rollMode}
          onSetRollMode={onSetRollMode}
          seed={seed}
          onClose={onCloseSettings}
        />
      )}
    </div>
  )
}

function Identity({ state }: { state: GameState }) {
  const me = state.players[state.current]
  const owned = territoriesOf(state, me.id)
  const armies = owned.reduce((n, t) => n + state.troops[t], 0)
  return (
    <div className="ident" style={{ ['--c' as string]: playerColor(me.color) }}>
      <span className="swatch" />
      <div className="who">
        <span className="nm">{me.name}</span>
        <span className="meta">
          {me.bot ? `Bot · ${me.bot}` : 'You'} · {owned.length}t · {armies}a
          {state.phase === 'setup' && ` · ${me.reserve} left`}
        </span>
      </div>
    </div>
  )
}

function describeBotPhase(s: GameState) {
  switch (s.phase) {
    case 'setup': return 'placing an army'
    case 'deploy': return `deploying ${s.toDeploy}`
    case 'attack': return 'looking for a fight'
    case 'occupy': return 'advancing'
    case 'fortify': return 'shuffling the line'
    default: return ''
  }
}

function Cards({ state, selectedCards, onToggleCard, onTrade }: DockProps) {
  const me = state.players[state.current]
  if (!me.cards.length) return null

  const chosen = me.cards.filter((c) => selectedCards.includes(c.id))
  const canTrade = chosen.length === 3 && isValidSet(chosen) && state.phase === 'deploy'
  const mustTrade = state.phase === 'deploy' && me.cards.length >= HAND_LIMIT

  return (
    <>
      <div className="cardbar">
        <span className="mono-label">{mustTrade ? 'Must trade' : 'Cards'}</span>
        <div className="chips">
          {me.cards.map((c) => (
            <button
              key={c.id}
              className={`chip ${selectedCards.includes(c.id) ? 'sel' : ''} ${c.suit === 'wild' ? 'wild' : ''}`}
              onClick={() => onToggleCard(c.id)}
              title={c.territory ? TERRITORY_NAMES[c.territory] : 'Wild'}
            >
              {SUIT_GLYPH[c.suit]}
            </button>
          ))}
        </div>
        <button className="btn trade" disabled={!canTrade} onClick={onTrade}>
          +{cashValue(state.setsTraded)}
        </button>
      </div>
      <div className="div" />
    </>
  )
}

function PhaseControls(props: DockProps) {
  switch (props.state.phase) {
    case 'setup': return <SetupControls {...props} />
    case 'deploy': return <DeployControls {...props} />
    case 'attack': return <AttackControls {...props} />
    case 'occupy': return <OccupyControls {...props} />
    case 'fortify': return <FortifyControls {...props} />
    default: return null
  }
}

function SetupControls({ state }: DockProps) {
  return (
    <>
      <div className="counter">{state.players[state.current].reserve}</div>
      <div className="prompt">
        <span className="k">To place</span>
        <span className="v">Click a territory · <b>1</b> at a time</span>
      </div>
    </>
  )
}

function DeployControls({ state, amount, setAmount }: DockProps) {
  const me = state.players[state.current]
  const held = continentsHeldBy(state, me.id)
  const capped = Math.min(Math.max(1, amount), Math.max(1, state.toDeploy))
  const blocked = me.cards.length >= HAND_LIMIT

  return (
    <>
      <div className="counter">{state.toDeploy}</div>
      <div className="prompt">
        <span className="k">
          Deploy{held.length ? ` · ${held.map((c) => `${CONTINENTS[c].name} +${CONTINENTS[c].bonus}`).join(', ')}` : ''}
        </span>
        <span className="v">
          {blocked ? 'Trade a set to continue' : <>Click a territory to place <b>{capped}</b> · shift-click for all</>}
        </span>
      </div>
      <div className="div" />
      <Amount
        label="Per click"
        value={capped}
        min={1}
        max={Math.max(1, state.toDeploy)}
        onChange={setAmount}
        disabled={blocked}
      />
    </>
  )
}

function AttackControls({ state, selected, onCancel }: DockProps) {
  return (
    <>
      <div className="prompt">
        <span className="k">Attack</span>
        <span className="v">
          {selected
            ? <>From {nm(selected)} · <b>{state.troops[selected]}</b> · click an outlined target</>
            : <>Click one of your territories with <b>2+</b> armies</>}
        </span>
      </div>
      {(state.lastBlitz || state.lastBattle) && <><div className="div" /><Dice state={state} /></>}
      {selected && <><div className="div" /><button className="btn ghost" onClick={onCancel}>Deselect <kbd>Esc</kbd></button></>}
    </>
  )
}

function OccupyControls({ state, amount, setAmount }: DockProps) {
  const occ = state.pendingOccupation!
  const extra = Math.min(Math.max(amount, occ.min), occ.max)
  return (
    <>
      <div className="prompt">
        <span className="k">Took {nm(occ.to)}</span>
        <span className="v"><b>{occ.moved}</b> advanced · leaves {state.troops[occ.from] - extra} in {nm(occ.from)}</span>
      </div>
      <div className="div" />
      <Amount label="Move" value={extra} min={occ.min} max={occ.max} onChange={setAmount} disabled={occ.max === 0} />
    </>
  )
}

function FortifyControls({ state, selected, fortifyTo, amount, setAmount, onCancel }: DockProps) {
  if (state.canFortify && selected && fortifyTo) {
    const max = state.troops[selected] - 1
    const n = Math.min(Math.max(amount, 1), max)
    return (
      <>
        <div className="prompt">
          <span className="k">Fortify</span>
          <span className="v">{nm(selected)} → {nm(fortifyTo)}</span>
        </div>
        <div className="div" />
        <Amount label="Move" value={n} min={1} max={max} onChange={setAmount} />
        <div className="div" />
        <button className="btn ghost" onClick={onCancel}>Cancel <kbd>Esc</kbd></button>
      </>
    )
  }
  return (
    <>
      <div className="prompt">
        <span className="k">Fortify</span>
        <span className="v">
          {!state.canFortify
            ? 'Already fortified this turn'
            : selected
              ? <>From {nm(selected)} · click a connected territory</>
              : <>Move armies between two of yours, or end your turn</>}
        </span>
      </div>
      {selected && <><div className="div" /><button className="btn ghost" onClick={onCancel}>Deselect <kbd>Esc</kbd></button></>}
    </>
  )
}

function Dice({ state }: { state: GameState }) {
  const b = state.lastBattle!
  const blitz = state.lastBlitz
  const attackerId = state.owner[b.from]
  const defenderId = b.captured ? null : state.owner[b.to]
  const aColor = playerColor(state.players[attackerId]?.color ?? 0)
  const dColor = defenderId !== null ? playerColor(state.players[defenderId].color) : 'var(--ink-3)'
  const pairs = Math.min(b.attackerDice.length, b.defenderDice.length)

  return (
    <div className="dice">
      <div className="side">
        <span className="mono-label">Atk</span>
        <div className="row">
          {b.attackerDice.map((d, i) => (
            <span
              key={i}
              className={`die ${i < pairs && d <= b.defenderDice[i] ? 'lost' : ''}`}
              style={{ borderColor: aColor, color: aColor, background: `color-mix(in srgb, ${aColor} 10%, var(--paper))` }}
            >{d}</span>
          ))}
        </div>
      </div>
      <span className="verdict">
        {blitz
          ? `${blitz.rounds}× · −${blitz.attackerLoss}/−${blitz.defenderLoss}${blitz.captured ? ' · taken' : ''}`
          : b.captured ? 'taken' : `−${b.attackerLoss}/−${b.defenderLoss}`}
      </span>
      <div className="side">
        <span className="mono-label">Def</span>
        <div className="row">
          {b.defenderDice.map((d, i) => (
            <span
              key={i}
              className={`die ${i < pairs && d < b.attackerDice[i] ? 'lost' : ''}`}
              style={{ borderColor: dColor, color: dColor, background: `color-mix(in srgb, ${dColor} 10%, var(--paper))` }}
            >{d}</span>
          ))}
        </div>
      </div>
    </div>
  )
}
