import type { ReactNode } from 'react'
import type { PlayerId } from '../engine/types'
import { attackValue, defendValue, engage } from '../games/kessel/combat'
import {
  ACTIVATIONS, COMMAND_RADIUS, HQ_MOVE, REPLACEMENT_TURNS, WILL_FLOOR, activationsUsed, broken,
} from '../games/kessel/game'
import { mapOf } from '../games/kessel/map'
import type { GameMap, ProvinceId } from '../games/kessel/map'
import { RAIL_ALLOWANCE, allowance, isMud, reachable } from '../games/kessel/movement'
import { retreatOptions } from '../games/kessel/supply'
import type { Formation, FormationId, KesselState } from '../games/kessel/types'
import { playerColor } from './colors'
import type { PrimaryAction } from './Dock'
import { SUPPLY_NAME } from './KesselMap'
import { Settings } from './Settings'

/** The attack the bar is pricing: a target, and everyone who would go in with it. */
export interface AttackPreview {
  to: ProvinceId
  from: Formation[]
  /** whether this is a click away or already staged */
  staged: boolean
}

export interface KesselDockProps {
  state: KesselState
  me: PlayerId
  selected: FormationId | null
  selectedHq: number | null
  /** formations of the side to move whose orders are carried out the turn they are given */
  command: Set<FormationId>
  attack: AttackPreview | null
  /**
   * The board the staged orders would produce. Whether a defender can retreat is
   * a question about where everyone stands *after* this turn's moves, so a ring
   * closed by a move staged two clicks ago has to count.
   */
  projected: KesselState
  primary: PrimaryAction | null
  onClearOrder(): void
  onClearHq(): void
  onRejectTerms(): void
  /** play the turn out instead of asking for terms — a broken side's other choice */
  onCommit(): void
  onShowSettings(): void
  settingsOpen: boolean
  onCloseSettings(): void
  seed: number
}

const KESSEL_KEYS: [string, string][] = [
  ['Space', 'Press the highlighted button'],
  ['← →', 'Cycle your formations, the contact line first'],
  ['G', 'Select a headquarters — again for the other'],
  ['H', 'Hold — what a formation with no order does anyway'],
  ['R', 'Refit — stands until the formation is whole'],
  ['⌫', 'Clear the staged order'],
  ['Esc', 'Deselect / close'],
  ['⌘Z', 'Undo — until the turn is committed'],
  ['+ −', 'Zoom the map · scroll or drag it · 0 fits'],
]

const TYPE_NAME: Record<Formation['type'], string> = {
  infantry: 'Infantry',
  armour: 'Armour',
  recon: 'Recon',
}

interface Slots {
  counter?: ReactNode
  hint?: ReactNode
  say: ReactNode
  controls?: ReactNode
}

/**
 * Everything the bar needs to know about one attack. The frontage cap is applied
 * here exactly as the engine applies it, because "five formations, three of them
 * fit" is the difference between mass and a queue.
 */
export interface Odds {
  ratio: number
  committed: number
  brought: number
  defenders: number
  trapped: number
  fallback: ProvinceId | null
}

export function oddsFor(
  m: GameMap,
  s: KesselState,
  projected: KesselState,
  me: PlayerId,
  to: ProvinceId,
  attackers: Formation[],
): Odds | null {
  const defenders = s.formations.filter((f) => f.at === to && f.owner !== me)
  if (attackers.length === 0 || defenders.length === 0) return null

  const committed = engage(m, attackers, to)

  const ours = committed.reduce((n, f) => n + attackValue(f), 0)
  const theirs = defenders.reduce((n, f) => n + defendValue(m, f, to), 0)
  const ways = defenders.map((f) => retreatOptions(m, projected, f))

  return {
    ratio: theirs === 0 ? Infinity : ours / theirs,
    committed: committed.length,
    brought: attackers.length,
    defenders: defenders.length,
    trapped: ways.filter((w) => w.length === 0).length,
    fallback: ways.find((w) => w.length > 0)?.[0] ?? null,
  }
}

/**
 * Same footprint as the Risk bar, and for the same reason: the button you press
 * every turn cannot move because a formation happened to be selected.
 */
export function KesselDock(props: KesselDockProps) {
  const { state, me, primary, onShowSettings, settingsOpen, onCloseSettings, seed } = props
  const side = state.sides[state.current]
  const slots = side.bot ? botSlots(props) : phaseSlots(props)

  return (
    <div className="dock kdock">
      <div className="ident" style={{ ['--c' as string]: playerColor(side.color) }}>
        <span className="swatch" />
        <div className="who">
          <span className="nm">{side.name}</span>
          <span className="meta">{side.bot ? `Bot · ${side.bot.replace('kessel-', '')}` : 'You'}</span>
        </div>
      </div>

      <div className="mid">
        <div className="cell num">{slots.counter}</div>
        <div className="prompt">
          <span className="k">{slots.hint}</span>
          <span className="v">{slots.say}</span>
        </div>
        <div className="cell ctrl">
          {slots.controls}
          <OddsBlock {...props} />
          <Will state={state} me={me} />
        </div>
      </div>

      <div className="tail">
        <span className="slot act">
          {primary && !side.bot && state.phase === 'orders' && broken(state, me) && !state.offered && (
            <button className="btn ghost" onClick={props.onCommit}>Fight the turn out</button>
          )}
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
        {settingsOpen && (
          <Settings
            seed={seed}
            onClose={onCloseSettings}
            keys={KESSEL_KEYS}
            note="Beaten with a line of retreat, a formation is pushed back at full strength. Beaten without one, it surrenders."
          />
        )}
      </div>
    </div>
  )
}

/**
 * Both sides' will, against the line below which a side can only ask for terms.
 * The threshold is drawn rather than stated: how close you are to it is the
 * question, and a number needs a second number to answer that.
 */
function Will({ state }: { state: KesselState; me: PlayerId }) {
  return (
    <div className="kwill">
      {state.sides.map((s) => (
        <div
          key={s.id}
          className={`row ${s.will <= WILL_FLOOR ? 'broken' : ''} ${s.id === state.current ? 'on' : ''}`}
          style={{ ['--c' as string]: playerColor(s.color) }}
        >
          <span className="nm">{s.name}</span>
          <span className="track">
            <i style={{ width: `${s.will}%` }} />
            <b style={{ left: `${WILL_FLOOR}%` }} />
          </span>
          <span className="n">{Math.round(s.will)}</span>
        </div>
      ))}
      <span className="cap mono-label">Will · terms below {WILL_FLOOR}</span>
    </div>
  )
}

/**
 * The odds, and the one fact that decides whether an attack is worth making.
 * Force ratio moves a line; a defender with nowhere to go is an army destroyed,
 * so that line is the loud one.
 */
function OddsBlock({ state, projected, me, attack }: KesselDockProps) {
  const m = mapOf(state.mapId)
  const odds = attack ? oddsFor(m, state, projected, me, attack.to, attack.from) : null

  if (!attack || !odds) {
    return (
      <div className="kodds empty">
        <span className="mono-label">Odds</span>
        <span className="idle">Nothing lined up</span>
      </div>
    )
  }

  const band = odds.ratio >= 1.6 ? 'good' : odds.ratio >= 1.05 ? 'even' : 'bad'
  return (
    <div className={`kodds ${band}`}>
      <span className="mono-label">
        {m.province[attack.to].name} · {attack.staged ? 'staged' : 'preview'}
      </span>
      <span className="ratio">
        {odds.ratio === Infinity ? '—' : odds.ratio.toFixed(1)}<i>:1</i>
        {odds.committed < odds.brought && (
          <em>{odds.committed} of {odds.brought} fit the frontage</em>
        )}
      </span>
      {odds.trapped === odds.defenders ? (
        <span className="retreat none">No line of retreat</span>
      ) : odds.trapped > 0 ? (
        <span className="retreat some">{odds.trapped} of {odds.defenders} cannot retreat</span>
      ) : (
        <span className="retreat">Falls back to {m.province[odds.fallback as ProvinceId].name}</span>
      )}
    </div>
  )
}

function botSlots({ state }: KesselDockProps): Slots {
  return {
    hint: 'Thinking',
    say: state.phase === 'terms'
      ? `${state.sides[state.current].name} is weighing the terms`
      : `${state.sides[state.current].name} is writing this turn's orders`,
  }
}

function phaseSlots(props: KesselDockProps): Slots {
  const { state, me, selected, selectedHq, command, projected } = props
  const m = mapOf(state.mapId)

  if (state.phase === 'terms') {
    return {
      hint: `${state.sides[(1 - me) as PlayerId].name} offers terms`,
      say: <>Accept and the war ends on this line, scored against both sides' aims</>,
      controls: (
        <button className="btn ghost" onClick={props.onRejectTerms}>
          Fight on · −8 will
        </button>
      ),
    }
  }

  const mine = state.formations.filter((f) => f.owner === me)
  const f = selected === null ? null : mine.find((x) => x.id === selected)
  const spent = activationsUsed(state, me).size
  const counter = (
    <span className={`counter ${spent >= ACTIVATIONS ? 'spent' : ''}`}>{ACTIVATIONS - spent}</span>
  )

  const hq = selectedHq === null ? undefined : state.sides[me].hqs[selectedHq]
  if (selectedHq !== null && hq !== undefined) {
    const to = state.hqOrders[selectedHq]
    return {
      counter,
      hint: (
        <>
          Headquarters {selectedHq + 1} · {m.province[hq].name} · commands {COMMAND_RADIUS} provinces
          of your ground around it
        </>
      ),
      say: to !== undefined && to !== hq
        ? <>Going to <b>{m.province[to].name}</b> · it commands from there next turn</>
        : <>Click where it goes, up to {HQ_MOVE} through your own ground · it commands from there next turn</>,
      controls: to !== undefined
        ? <button className="btn ghost" onClick={props.onClearHq}>Call off <kbd>⌫</kbd></button>
        : undefined,
    }
  }

  if (broken(state, me) && !f) {
    return {
      counter,
      hint: 'Will spent',
      say: state.offered
        ? <>Terms refused · fight the turn out: hold, refit, move — <b>no attacks</b></>
        : <>Your army will not be ordered forward again · <b>ask for terms</b>, or hold the line</>,
    }
  }

  if (!f) {
    const adrift = mine.filter((x) => !command.has(x.id)).length
    return {
      counter,
      hint: (
        <>
          Provinces you can still set moving · <kbd>←</kbd><kbd>→</kbd> cycles the line ·{' '}
          <kbd>G</kbd> headquarters
        </>
      ),
      say: (
        <>
          Standing still digs in. Click a formation, then where you want it
          {isMud(state.turn) ? ' — mud: the march is half, the trains still run' : ''}
          {adrift > 0 ? <> · <b>{adrift}</b> out of command, a turn late</> : null}
        </>
      ),
    }
  }

  const order = state.orders[f.id]
  const late = state.delayed[f.id]
  const commanded = command.has(f.id)
  const trapped = retreatOptions(m, projected, f).length === 0
  const rail = reachable(m, state, f).rail
  const hint = (
    <>
      {TYPE_NAME[f.type]} · {m.province[f.at].name} · {f.strength} str · {Math.round(f.cohesion)} coh
      {' · moves '}{allowance(f.type, state.turn)}
      {rail.size > 0 ? ` · rail ${RAIL_ALLOWANCE}` : ''}
      {' · '}<b className={`sup s${f.supply}`}>{SUPPLY_NAME[f.supply]}</b>
      {f.rest > 0 && ` · rebuilding ${f.rest}/${REPLACEMENT_TURNS}`}
      {trapped && ' · encircled'}
      {!commanded && ' · out of command'}
    </>
  )

  if (late?.type === 'move' || late?.type === 'attack') {
    return {
      counter,
      hint,
      say: <>Carrying out last turn's order · {late.type === 'attack' ? 'attacking' : 'moving to'} <b>{m.province[late.to].name}</b></>,
    }
  }

  const controls = order ? (
    <button className="btn ghost" onClick={props.onClearOrder}>Clear order <kbd>⌫</kbd></button>
  ) : undefined
  const delayed = commanded ? null : <> · out of command, <b>carried out next turn</b></>

  if (order?.type === 'attack') {
    return {
      counter,
      hint,
      say: order.onward
        ? <>Attacking <b>{m.province[order.to].name}</b>, then on to <b>{m.province[order.onward].name}</b>{delayed}</>
        : <>Attacking <b>{m.province[order.to].name}</b>{delayed ?? (f.type !== 'infantry' && !isMud(state.turn) ? <> · click further on to <b>exploit</b></> : null)}</>,
      controls,
    }
  }
  if (order?.type === 'move') {
    return {
      counter,
      hint,
      say: <>Moving to <b>{m.province[order.to].name}</b>{rail.has(order.to) ? ' by rail' : ''}{delayed}</>,
      controls,
    }
  }
  if (order?.type === 'hold') {
    return { counter, hint, say: <>Holding · digging in</>, controls }
  }
  if (order?.type === 'refit') {
    return {
      counter,
      hint,
      say: <>Refitting · stands until whole{f.rest > 0 ? ', rebuilding a step on this railhead' : ''}</>,
      controls,
    }
  }

  return {
    counter,
    hint,
    say: !commanded
      ? <>Out of command · a move or an attack now is <b>carried out next turn</b> · <kbd>R</kbd> refit</>
      : f.supply >= 3 && !broken(state, me)
        ? <>Click a province · enemy-held <b>attacks</b>, anything else moves · <kbd>R</kbd> refit</>
        : broken(state, me)
          ? <>Will spent, so it <b>cannot attack</b> · move or <kbd>R</kbd> refit</>
          : <>Short of full supply, so it <b>cannot attack</b> · move or <kbd>R</kbd> refit</>,
    controls,
  }
}
