import type { ReactNode } from 'react'
import { TERRITORY_NAMES } from '../engine/board'
import type { TerritoryId } from '../engine/board'
import { cashValue } from '../engine/cards'
import { HAND_LIMIT, bestTradeIn } from '../engine/game'
import type { GameState } from '../engine/types'
import { SUIT_GLYPH, playerColor } from './colors'
import { amountRange } from './decide'
import { Settings } from './Settings'

/** The one dark button in the bar. Space always presses it. */
export interface PrimaryAction {
  label: string
  run(): void
}

export interface DockProps {
  state: GameState
  selected: TerritoryId | null
  /** chosen fortify destination, awaiting an amount */
  fortifyTo: TerritoryId | null
  amount: number
  primary: PrimaryAction | null
  setAmount(n: number): void
  onTrade(): void
  onShowSettings(): void
  settingsOpen: boolean
  onCloseSettings(): void
  seed: number
}

/**
 * What goes in the bar's middle, split by role rather than by phase. The three
 * land in fixed cells, so the number, the sentence and the controls each keep
 * their spot from one phase to the next.
 */
interface Slots {
  /** the one big number this phase is about, if it has one */
  counter?: ReactNode
  /** a quiet label above the sentence — context the phase pills don't carry */
  hint?: ReactNode
  say: ReactNode
  controls?: ReactNode
}

const nm = (t: TerritoryId) => TERRITORY_NAMES[t]

/**
 * A deploy in the middle of a turn is the spoils rule: an elimination pushed the
 * hand over the limit and it has to come down before the attack goes on. Nothing
 * else can conquer and then deploy in the same turn, so the flag identifies it —
 * see `forceSpoilsTrade`.
 */
const cashingSpoils = (s: GameState) => s.phase === 'deploy' && s.conqueredThisTurn

/**
 * One control for every "how many armies?" question. Deliberately not a text
 * input: a focusable field would own the Space key, which belongs to Confirm.
 * ← → drive it from App's global handler instead, so the amount is reachable
 * without leaving the keyboard.
 */
function Amount({
  value, min, max, onChange, disabled = false,
}: {
  value: number
  min: number
  max: number
  onChange(n: number): void
  disabled?: boolean
}) {
  const v = Math.min(Math.max(value, min), max)
  return (
    <div className="amount">
      <button className="preset" disabled={disabled || v <= min} onClick={() => onChange(min)}>Min</button>
      <button className="nudge" disabled={disabled || v <= min} onClick={() => onChange(v - 1)}>−</button>
      <span className="n">{v}</span>
      <button className="nudge" disabled={disabled || v >= max} onClick={() => onChange(v + 1)}>+</button>
      <button className="preset" disabled={disabled || v >= max} onClick={() => onChange(max)}>Max</button>
    </div>
  )
}

/**
 * The bar's footprint never changes — same width, same height, every phase and
 * every bot move. What varies goes inside the middle cells; what you aim at
 * (the name, the sentence, Undo, the dark button, the gear) does not move. A bar
 * that resized itself around its contents jittered on every bot decision, which
 * is a lot of motion to pay for a few pixels of snugness.
 */
export function Dock(props: DockProps) {
  const { state, primary, onShowSettings } = props
  const { settingsOpen, onCloseSettings, seed } = props
  const me = state.players[state.current]
  const slots = me.bot ? botSlots(state) : phaseSlots(props)

  return (
    <div className="dock">
      <Identity state={state} />

      <div className="mid">
        <div className="cell num">{slots.counter}</div>
        <div className="prompt">
          <span className="k">{slots.hint}</span>
          <span className="v">{slots.say}</span>
        </div>
        <div className="cell ctrl">{slots.controls}</div>
      </div>

      {/* The slot holds its width empty, so a phase with nothing for Space to
          press doesn't slide the gear out from under the cursor. */}
      <div className="tail">
        <span className="slot act">
          {primary && (
            <button className="btn primary wide" onClick={primary.run}>
              {primary.label} <kbd>Space</kbd>
            </button>
          )}
        </span>
        <button
          className={`btn help ${settingsOpen ? 'on' : ''}`}
          onClick={onShowSettings}
          title="Settings and shortcuts"
          aria-label="Settings"
        >⚙</button>

        {settingsOpen && <Settings seed={seed} onClose={onCloseSettings} />}
      </div>
    </div>
  )
}

/**
 * Just whose turn it is. The territory and army totals that used to hang off the
 * name are in the scoreboard for every player, which is where you'd compare them
 * anyway; the only thing not shown up there is which bot is on the clock.
 */
function Identity({ state }: { state: GameState }) {
  const me = state.players[state.current]
  return (
    <div className="ident" style={{ ['--c' as string]: playerColor(me.color) }}>
      <span className="swatch" />
      <div className="who">
        <span className="nm">{me.name}</span>
        <span className="meta">{me.bot ? `Bot · ${me.bot}` : 'You'}</span>
      </div>
    </div>
  )
}

function botSlots(s: GameState): Slots {
  return {
    hint: 'Thinking',
    say: describeBotPhase(s),
    controls: s.lastBattle && s.phase !== 'setup' ? <Dice state={s} /> : null,
  }
}

function describeBotPhase(s: GameState) {
  switch (s.phase) {
    case 'setup': return 'placing an army'
    case 'deploy': return cashingSpoils(s) ? 'cashing the spoils' : `deploying ${s.toDeploy}`
    case 'attack': return 'looking for a fight'
    case 'occupy': return 'advancing'
    case 'fortify': return 'shuffling the line'
    default: return ''
  }
}

/**
 * The hand, plus one button that cashes it. Picking the three cards by hand was
 * busywork — there's one best set (see bestTradeIn), so the bar just highlights
 * the cards it's about to spend and hands you the payout.
 *
 * Deploy only: it's the one phase you can trade in, and the scoreboard already
 * carries everyone's card count for the turns in between.
 */
function Cards({ state, onTrade }: DockProps) {
  const me = state.players[state.current]
  if (!me.cards.length) return null

  const set = bestTradeIn(state, me.id)
  const going = new Set(set?.cards ?? [])

  return (
    <>
      <div className="cardbar">
        <div className="chips">
          {me.cards.map((c) => (
            <span
              key={c.id}
              className={`chip ${going.has(c.id) ? 'sel' : ''} ${c.suit === 'wild' ? 'wild' : ''}`}
              title={c.territory ? TERRITORY_NAMES[c.territory] : 'Wild'}
            >
              {SUIT_GLYPH[c.suit]}
            </span>
          ))}
        </div>
        {/* with no set in hand the button still names the next cash-in, so the
            escalating value is visible while you decide whether to hold. The +2
            match bonus is called out separately because it isn't yours to place —
            it garrisons the pictured territory the moment you trade */}
        <button
          className="btn trade"
          disabled={!set}
          onClick={onTrade}
          title={
            set?.bonusAt
              ? `Cash the highlighted set · 2 more garrison ${TERRITORY_NAMES[set.bonusAt]}`
              : 'Cash the highlighted set'
          }
        >
          Trade +{set?.value ?? cashValue(state.setsTraded)}
          {set?.bonusAt && <span className="bonus">+2 {TERRITORY_NAMES[set.bonusAt]}</span>}
        </button>
      </div>
      <div className="div" />
    </>
  )
}

function phaseSlots(props: DockProps): Slots {
  switch (props.state.phase) {
    case 'setup': return setupSlots(props)
    case 'deploy': return deploySlots(props)
    case 'attack': return attackSlots(props)
    case 'occupy': return occupySlots(props)
    case 'fortify': return fortifySlots(props)
    default: return { say: null }
  }
}

/**
 * The phase pills in the top bar already name the phase, so the hint line only
 * carries what they don't — "Took Peru", or the key that backs out of here.
 */
function setupSlots({ state }: DockProps): Slots {
  return {
    counter: <span className="counter">{state.players[state.current].reserve}</span>,
    hint: 'To place',
    say: <>Click a territory · <b>1</b> at a time</>,
  }
}

function deploySlots(props: DockProps): Slots {
  const { state, amount, setAmount } = props
  const me = state.players[state.current]
  const range = amountRange(state, null, null)
  const blocked = me.cards.length >= HAND_LIMIT
  const spoils = cashingSpoils(state)

  return {
    counter: <span className="counter">{state.toDeploy}</span>,
    // mid-turn, the deploy is an interruption — say why it's there, or it reads
    // as the game having lost track of the attack
    hint: spoils ? 'Spoils' : 'Shift-click places the lot',
    say: blocked
      ? spoils
        ? <>The cards you took put you over <b>{HAND_LIMIT}</b> · trade a set</>
        : 'Trade a set to continue'
      : <>Click a territory to place <b>{range ? clamp(amount, range.min, range.max) : 1}</b></>,
    controls: (
      <>
        <Cards {...props} />
        <Amount
          value={amount}
          min={range?.min ?? 1}
          max={range?.max ?? 1}
          onChange={setAmount}
          disabled={!range}
        />
      </>
    ),
  }
}

function attackSlots({ state, selected }: DockProps): Slots {
  return {
    say: selected
      ? <>From {nm(selected)} · <b>{state.troops[selected]}</b> · click an outlined target</>
      : <>Click one of your territories with <b>2+</b> armies</>,
    controls: state.lastBlitz || state.lastBattle ? <Dice state={state} /> : null,
  }
}

function occupySlots({ state, amount, setAmount }: DockProps): Slots {
  const occ = state.pendingOccupation!
  const range = amountRange(state, null, null)
  return {
    // the map badges carry the arithmetic — both sides of the move show the count
    // they'd end on, so spelling it out here would just be a second copy
    hint: `Took ${nm(occ.to)}`,
    say: <><b>{occ.moved}</b> advanced · send more from {nm(occ.from)}?</>,
    controls: (
      <Amount
        value={amount}
        min={range?.min ?? occ.min}
        max={range?.max ?? occ.max}
        onChange={setAmount}
        disabled={occ.max === 0}
      />
    ),
  }
}

function fortifySlots({ state, selected, fortifyTo, amount, setAmount }: DockProps): Slots {
  const range = amountRange(state, selected, fortifyTo)
  if (range && selected && fortifyTo) {
    return {
      say: <>{nm(selected)} → {nm(fortifyTo)}</>,
      controls: <Amount value={amount} min={range.min} max={range.max} onChange={setAmount} />,
    }
  }
  return {
    say: !state.canFortify
      ? 'Already fortified this turn'
      : selected
        ? <>From {nm(selected)} · click a connected territory</>
        : <>Move armies between two territories or end your turn</>,
  }
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

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)
