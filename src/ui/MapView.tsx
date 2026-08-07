import { useMemo } from 'react'
import {
  CONTINENTS,
  CONTINENT_LABEL_POS,
  CONTINENT_IDS,
  GEOMETRY,
  SEA_ROUTES,
  TERRITORIES_IN,
  TERRITORY_NAMES,
  VIEW_BOX,
  WRAP_STUBS,
} from '../engine/board'
import type { TerritoryId } from '../engine/board'
import type { GameState, PlayerId } from '../engine/types'
import { playerColor } from './colors'

interface Props {
  state: GameState
  selected: TerritoryId | null
  targets: Set<TerritoryId>
  clickable: Set<TerritoryId>
  /** dim every territory not owned by this player */
  focus: PlayerId | null
  flash: TerritoryId | null
  /** troop counts the pending move would produce, keyed by territory */
  preview: Record<TerritoryId, number> | null
  hover: TerritoryId | null
  onPick(t: TerritoryId, shift: boolean): void
  onHover(t: TerritoryId | null): void
}

const BY_ID = Object.fromEntries(GEOMETRY.map((g) => [g.id, g]))

/** Gentle arc across the water between two coastlines. */
function seaPath(pa: [number, number], pb: [number, number]) {
  const [x1, y1] = pa
  const [x2, y2] = pb
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const bow = Math.min(len * 0.16, 20)
  // perpendicular offset, so the route bows out instead of cutting straight through
  const mx = (x1 + x2) / 2 - (dy / len) * bow
  const my = (y1 + y2) / 2 + (dx / len) * bow
  return `M ${x1},${y1} Q ${mx},${my} ${x2},${y2}`
}

export function MapView({
  state, selected, targets, clickable, focus, flash, preview, hover, onPick, onHover,
}: Props) {
  const seaRoutes = useMemo(
    () => SEA_ROUTES.map((r) => ({ key: `${r.a}|${r.b}`, d: seaPath(r.pa, r.pb), pa: r.pa, pb: r.pb })),
    [],
  )

  /**
   * Who leads each continent and by how much. "One territory off Australia" is the
   * most decision-relevant fact on the board, so it belongs on the map itself
   * rather than in a panel.
   */
  const continents = useMemo(
    () =>
      CONTINENT_IDS.map((id) => {
        const members = TERRITORIES_IN[id]
        const counts = new Map<PlayerId, number>()
        for (const t of members) counts.set(state.owner[t], (counts.get(state.owner[t]) ?? 0) + 1)
        let leader: PlayerId | null = null
        let held = 0
        let tied = false
        for (const [pid, n] of counts) {
          if (n > held) { leader = pid; held = n; tied = false }
          else if (n === held) tied = true
        }
        return {
          id,
          total: members.length,
          held,
          leader: tied ? null : leader,
          complete: held === members.length,
        }
      }),
    [state.owner],
  )

  const dimmed = (t: TerritoryId) => focus !== null && state.owner[t] !== focus

  const arcs = selected && targets.size ? [...targets].map((t) => arcPath(selected, t)) : []

  const readout = hover ?? selected
  const readoutOwner = readout !== null ? state.players[state.owner[readout]] : null

  return (
    <>
      <svg className="map" viewBox={VIEW_BOX} preserveAspectRatio="xMidYMid meet">
        {/* The graticule runs past the viewBox on purpose. `meet` letterboxes the
            map inside the stage, and a grid that stopped at the box would draw its
            own edge across the screen — the paper has to reach the window. */}
        <defs>
          <pattern id="grat" x={10} y={0} width={60} height={60} patternUnits="userSpaceOnUse">
            <path className="grat" d="M 30 0 V 60 M 0 30 H 60" />
          </pattern>
        </defs>
        <rect x={-3000} y={-3000} width={6500} height={6500} fill="url(#grat)" pointerEvents="none" />

        {/* sea routes sit under the land so they tuck neatly beneath the coastlines */}
        <g className="sea-layer">
          {seaRoutes.map((r) => (
            <g key={r.key}>
              <path className="searoute" d={r.d} />
              <circle className="seanode" cx={r.pa[0]} cy={r.pa[1]} r={1.7} />
              <circle className="seanode" cx={r.pb[0]} cy={r.pb[1]} r={1.7} />
            </g>
          ))}
          {WRAP_STUBS.map((w) => (
            <g key={w.territory}>
              <path className="searoute" d={`M ${w.from[0]},${w.from[1]} L ${w.toX},${w.from[1]}`} />
              <circle className="seanode" cx={w.from[0]} cy={w.from[1]} r={1.7} />
            </g>
          ))}
        </g>

        {/* fills + hit targets */}
        <g>
          {GEOMETRY.map((t) => (
            <path
              key={t.id}
              className={['terr owned', clickable.has(t.id) ? 'clickable' : '', dimmed(t.id) ? 'dim' : ''].join(' ')}
              style={{ ['--c' as string]: playerColor(state.owner[t.id]) }}
              d={t.d}
              onClick={(e) => clickable.has(t.id) && onPick(t.id, e.shiftKey)}
              onMouseEnter={() => onHover(t.id)}
              onMouseLeave={() => onHover(null)}
            />
          ))}
        </g>

        {/* Outlines are their own layer, above every fill. Drawn per-territory they
            would be half-covered by whichever neighbour paints next. */}
        <g>
          {GEOMETRY.map((t) => (
            <path
              key={t.id}
              className={[
                'edge',
                selected === t.id ? 'sel' : '',
                targets.has(t.id) ? 'target' : '',
                flash === t.id ? 'flash' : '',
                dimmed(t.id) ? 'dim' : '',
              ].join(' ')}
              d={t.d}
            />
          ))}
        </g>

        <g>
          {continents.map((c) => {
            const [x, y] = CONTINENT_LABEL_POS[c.id]
            const tint = c.leader === null ? undefined : playerColor(state.players[c.leader].color)
            return (
              <g key={c.id} className={c.complete ? 'cont held' : 'cont'}>
                <text className="cont-label" x={x} y={y} style={tint ? { fill: tint } : undefined}>
                  {CONTINENTS[c.id].name}
                </text>
                <text className="cont-bonus" x={x} y={y + 11} style={tint ? { fill: tint } : undefined}>
                  {c.complete ? `held · +${CONTINENTS[c.id].bonus}` : `${c.held}/${c.total} · +${CONTINENTS[c.id].bonus}`}
                </text>
              </g>
            )
          })}
        </g>

        <g>{arcs.map((d, i) => <path key={i} className="arc" d={d} />)}</g>

        {/* Troop badges. Under a pending move these read as the count you'd end up
            with, plus the swing that gets you there — the number you're deciding
            about is the number on the map, not one you have to do sums for. */}
        <g>
          {GEOMETRY.map((t) => {
            const now = state.troops[t.id]
            const after = preview?.[t.id]
            const delta = after === undefined ? 0 : after - now
            return (
              <g
                key={t.id}
                className={`badge ${dimmed(t.id) ? 'dim' : ''} ${delta ? 'preview' : ''}`}
                style={{ ['--c' as string]: playerColor(state.owner[t.id]) }}
              >
                <circle cx={t.cx} cy={t.cy} r={10.5} />
                <text x={t.cx} y={t.cy + 4}>{after ?? now}</text>
                {!!delta && (
                  <text className="delta" x={t.cx} y={t.cy + 20}>{delta > 0 ? `+${delta}` : delta}</text>
                )}
              </g>
            )
          })}
        </g>
      </svg>

      {readout && readoutOwner && (
        <div className="readout">
          <div className="t">{TERRITORY_NAMES[readout]}</div>
          <div className="s">
            {CONTINENTS[BY_ID[readout].continent].name} · {readoutOwner.name} ·{' '}
            {state.troops[readout]} {state.troops[readout] === 1 ? 'army' : 'armies'}
          </div>
        </div>
      )}
    </>
  )
}

function arcPath(a: TerritoryId, b: TerritoryId) {
  const A = BY_ID[a]
  const B = BY_ID[b]
  const mx = (A.cx + B.cx) / 2
  const my = (A.cy + B.cy) / 2 - Math.abs(A.cx - B.cx) * 0.18 - 14
  return `M ${A.cx},${A.cy} Q ${mx},${my} ${B.cx},${B.cy}`
}
