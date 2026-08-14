import { useMemo } from 'react'
import type { PlayerId } from '../engine/types'
import { mapOf } from '../games/kessel/map'
import type { Province, ProvinceId, Terrain } from '../games/kessel/map'
import type { Formation, FormationId, KesselState, Order } from '../games/kessel/types'
import { playerColor } from './colors'

export interface KesselMapProps {
  state: KesselState
  /** the seat with orders to give, or null while a bot has the board */
  acting: PlayerId | null
  selected: FormationId | null
  /** where the selected formation may go, and what happens when it gets there */
  targets: Map<ProvinceId, Order['type']>
  /**
   * Provinces holding a formation with no line of retreat, measured on the board
   * the staged orders would produce. A ring closed by this turn's moves is the
   * one thing worth knowing before the button is pressed, so it is drawn against
   * the projected board rather than the one on screen.
   */
  pockets: Set<ProvinceId>
  hover: ProvinceId | null
  onPick(p: ProvinceId): void
  onHover(p: ProvinceId | null): void
}

/** Counter geometry, in map units. */
const CW = 27
const CH = 18
const GUTTER = 3.6
const STACK_DY = 20

/**
 * Empty map added below the coastline, so the floating bar has something to sit
 * over. Without it the bar covers North Africa and the formations there are
 * unreachable — the map is fitted to the stage, and the stage runs under the bar.
 */
const BAR_ROOM = 122

const TEXTURE: Partial<Record<Terrain, string>> = {
  mountain: 'kt-mountain',
  hill: 'kt-hill',
  forest: 'kt-forest',
  marsh: 'kt-marsh',
  urban: 'kt-urban',
}

export const TERRAIN_NAME: Record<Terrain, string> = {
  plain: 'Plain',
  forest: 'Forest',
  hill: 'Hill',
  mountain: 'Mountain',
  marsh: 'Marsh',
  urban: 'Urban',
}

/**
 * The four supply states, in the words that say what they cost you. Anything
 * short of full supply cannot start an attack, but only the top band of that is
 * a culminating point rather than a death sentence — which is why "cannot
 * attack" is attached to strained and not repeated below it.
 */
export const SUPPLY_NAME = ['Cut off', 'Failing', 'Strained', 'Supplied'] as const
export const SUPPLY_COST_NAME = ['dying', 'combat halved', 'cannot attack', ''] as const

const TYPE_NAME: Record<Formation['type'], string> = {
  infantry: 'Infantry',
  armour: 'Armour',
  recon: 'Recon',
}

/** Gentle arc across the water, the way the Risk map draws a sea route. */
function seaPath(pa: [number, number], pb: [number, number]) {
  const [x1, y1] = pa
  const [x2, y2] = pb
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const bow = Math.min(len * 0.16, 18)
  const mx = (x1 + x2) / 2 - (dy / len) * bow
  const my = (y1 + y2) / 2 + (dx / len) * bow
  return `M ${x1},${y1} Q ${mx},${my} ${x2},${y2}`
}

/** An order arrow, pulled back at both ends so it starts and finishes clear of the counters. */
function orderPath(a: Province, b: Province) {
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  const len = Math.hypot(dx, dy) || 1
  const back = Math.min(15, len * 0.3)
  return `M ${a.cx + (dx / len) * back},${a.cy + (dy / len) * back} L ${b.cx - (dx / len) * back},${b.cy - (dy / len) * back}`
}

export function KesselMap({
  state, acting, selected, targets, pockets, hover, onPick, onHover,
}: KesselMapProps) {
  const m = mapOf(state.mapId)
  const colorOf = (p: PlayerId) => playerColor(state.sides[p]?.color ?? p)

  const viewBox = useMemo(() => {
    const [x, y, w, h] = m.viewBox.split(/\s+/).map(Number)
    return `${x} ${y} ${w} ${h + BAR_ROOM}`
  }, [m])

  const sea = useMemo(
    () =>
      m.edges
        .filter((e) => e.sea)
        .map((e) => ({
          key: `${e.a}|${e.b}`,
          d: seaPath(
            [m.province[e.a].cx, m.province[e.a].cy],
            [m.province[e.b].cx, m.province[e.b].cy],
          ),
        })),
    [m],
  )

  /** Who is fighting for what. Aims are dealt once, so this outlives every turn. */
  const claim = useMemo(() => {
    const out: Record<ProvinceId, PlayerId> = {}
    for (const side of state.sides) for (const p of side.aims) out[p] = side.id
    return out
  }, [state.sides])

  const terrain = useMemo(
    () =>
      m.provinces
        .filter((p) => TEXTURE[p.terrain])
        .map((p) => (
          <path key={p.id} className="ktex" d={p.d} fill={`url(#${TEXTURE[p.terrain]})`} />
        )),
    [m],
  )

  const claimed = useMemo(
    () =>
      m.provinces
        .filter((p) => claim[p.id] !== undefined)
        .map((p) => (
          <path key={p.id} className="kaim" d={p.d} fill={`url(#ka-${claim[p.id]})`} />
        )),
    [m, claim],
  )

  /** Depots and objective values — fixed to the ground, not to whoever holds it. */
  const marks = useMemo(
    () =>
      m.provinces
        .filter((p) => p.depot > 0 || p.vp > 0)
        .map((p) => (
          <g key={p.id} className="kmark">
            {/* both sit clear of the counter box and of the pip in its corner —
                a depot under a stack is a depot nobody reads */}
            {p.depot > 0 && (
              <g transform={`translate(${p.cx - 27},${p.cy - 21})`}>
                <rect className="kdepot" x={0} y={0} width={12} height={9} rx={1} />
                {Array.from({ length: p.depot }, (_, i) => (
                  <rect key={i} className="kdepot-pip" x={1.8 + i * 3} y={2.2} width={1.8} height={4.6} />
                ))}
              </g>
            )}
            {p.vp > 0 && (
              <g transform={`translate(${p.cx + 22},${p.cy - 17})`}>
                <path
                  className={claim[p.id] === undefined ? 'kvp' : 'kvp aim'}
                  style={claim[p.id] === undefined ? undefined : { fill: colorOf(claim[p.id]) }}
                  d="M0,-6.5 L6.5,0 L0,6.5 L-6.5,0 Z"
                />
                <text className="kvp-n" x={0} y={2.8}>{p.vp}</text>
              </g>
            )}
          </g>
        )),
    // colorOf reads only the seat palette, which is fixed for the whole game
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [m, claim],
  )

  const garrison = useMemo(() => {
    const out = new Map<ProvinceId, Formation[]>()
    for (const f of state.formations) {
      const at = out.get(f.at)
      if (at) at.push(f)
      else out.set(f.at, [f])
    }
    return out
  }, [state.formations])

  const arrows = useMemo(() => {
    const out: { key: string; d: string; kind: Order['type'] }[] = []
    for (const f of state.formations) {
      const order = state.orders[f.id]
      if (!order || (order.type !== 'move' && order.type !== 'attack')) continue
      out.push({
        key: String(f.id),
        d: orderPath(m.province[f.at], m.province[order.to]),
        kind: order.type,
      })
    }
    return out
  }, [m, state.formations, state.orders])

  const selectedAt = selected === null
    ? null
    : (state.formations.find((f) => f.id === selected)?.at ?? null)

  const readout = hover ?? selectedAt

  return (
    <>
      <svg className="map kmap" viewBox={viewBox} preserveAspectRatio="xMidYMid meet">
        <defs>
          <pattern id="kgrat" x={10} y={0} width={60} height={60} patternUnits="userSpaceOnUse">
            <path className="grat" d="M 30 0 V 60 M 0 30 H 60" />
          </pattern>

          {/* Terrain is a texture rather than a hue: ownership owns colour on this
              map, and a second colour scale competing with it would cost more than
              knowing a province is hilly is worth. */}
          <pattern id="kt-mountain" width={14} height={14} patternUnits="userSpaceOnUse">
            <path className="ktex-line" d="M1 10 L4.5 4 L8 10 M7 13.5 L10 9.5 L13 13.5" />
          </pattern>
          <pattern id="kt-hill" width={15} height={15} patternUnits="userSpaceOnUse">
            <path className="ktex-line" d="M1.5 9 Q5 5.5 8.5 9 M9 14 Q11.5 11.5 14 14" />
          </pattern>
          <pattern id="kt-forest" width={12} height={12} patternUnits="userSpaceOnUse">
            <path className="ktex-fill" d="M3 8 L4.8 3.8 L6.6 8 Z M8.4 12 L9.9 9 L11.4 12 Z" />
          </pattern>
          <pattern id="kt-marsh" width={14} height={11} patternUnits="userSpaceOnUse">
            <path className="ktex-line" d="M1 3.5 H6 M8 8.5 H13" />
          </pattern>
          <pattern id="kt-urban" width={10} height={10} patternUnits="userSpaceOnUse">
            <path className="ktex-fill" d="M2 2 h2.6 v2.6 h-2.6 Z M6.2 6.2 h2.2 v2.2 h-2.2 Z" />
          </pattern>

          {/* war aims, hatched in the colour of whoever is fighting for the ground */}
          {state.sides.map((side) => (
            <pattern
              key={side.id}
              id={`ka-${side.id}`}
              width={10}
              height={10}
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <path className="kaim-line" style={{ stroke: colorOf(side.id) }} d="M0 0 V10" />
            </pattern>
          ))}

          <pattern
            id="k-cut"
            width={5}
            height={5}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <path className="kcut-line" d="M0 0 V5" />
          </pattern>

          <marker
            id="k-head-attack" viewBox="0 0 10 10" refX={9} refY={5}
            markerWidth={4.5} markerHeight={4.5} orient="auto-start-reverse"
          >
            <path className="khead attack" d="M0 0 L10 5 L0 10 Z" />
          </marker>
          <marker
            id="k-head-move" viewBox="0 0 10 10" refX={9} refY={5}
            markerWidth={4} markerHeight={4} orient="auto-start-reverse"
          >
            <path className="khead move" d="M0 1 L10 5 L0 9 L2.5 5 Z" />
          </marker>
        </defs>

        <rect x={-3000} y={-3000} width={7500} height={7500} fill="url(#kgrat)" pointerEvents="none" />

        {/* The real coastline under the provinces: the parts of Europe nobody is
            fighting over still have to be there, or the front line floats. */}
        <path className="kcoast" d={m.coast} />

        <g className="sea-layer">
          {sea.map((r) => <path key={r.key} className="searoute" d={r.d} />)}
        </g>

        <g>
          {m.provinces.map((p) => (
            <path
              key={p.id}
              className={`kterr ${state.owner[p.id] === undefined ? 'neutral' : 'owned'}`}
              style={
                state.owner[p.id] === undefined
                  ? undefined
                  : { ['--c' as string]: colorOf(state.owner[p.id]) }
              }
              d={p.d}
              onClick={() => onPick(p.id)}
              onMouseEnter={() => onHover(p.id)}
              onMouseLeave={() => onHover(null)}
            />
          ))}
        </g>

        <g pointerEvents="none">{terrain}</g>
        <g pointerEvents="none">{claimed}</g>

        {/* Outlines are their own layer above every fill, so a stroke isn't
            half-painted over by whichever neighbour draws next. */}
        <g pointerEvents="none">
          {m.provinces.map((p) => {
            const kind = targets.get(p.id)
            return (
              <path
                key={p.id}
                className={[
                  'kedge',
                  selectedAt === p.id ? 'sel' : '',
                  kind === 'attack' ? 'attack' : kind ? 'target' : '',
                  pockets.has(p.id) ? 'pocket' : '',
                  hover === p.id ? 'hot' : '',
                ].join(' ')}
                d={p.d}
              />
            )
          })}
        </g>

        <g pointerEvents="none">{marks}</g>

        <g pointerEvents="none">
          {arrows.map((a) => (
            <path
              key={a.key}
              className={`korder ${a.kind}`}
              d={a.d}
              markerEnd={`url(#k-head-${a.kind})`}
            />
          ))}
        </g>

        <g pointerEvents="none">
          {[...garrison].map(([at, all]) =>
            all.map((f, i) => (
              <Counter
                key={f.id}
                f={f}
                x={m.province[at].cx}
                y={m.province[at].cy + (i - (all.length - 1) / 2) * STACK_DY}
                color={colorOf(f.owner)}
                selected={f.id === selected}
                pending={f.owner === acting && !state.orders[f.id]}
                order={state.orders[f.id]}
              />
            )),
          )}
        </g>
      </svg>

      {readout && (
        <div className="kreadout">
          <div className="t">{m.province[readout].name}</div>
          <div className="s">
            {[
              TERRAIN_NAME[m.province[readout].terrain],
              state.owner[readout] === undefined ? 'neutral' : state.sides[state.owner[readout]].name,
              m.province[readout].depot > 0 ? `depot ${m.province[readout].depot}` : null,
              m.province[readout].vp > 0 ? `${m.province[readout].vp} vp` : null,
              claim[readout] !== undefined ? `${state.sides[claim[readout]].name} war aim` : null,
            ].filter(Boolean).join(' · ')}
          </div>
          {(garrison.get(readout) ?? []).map((f) => (
            <div className="f" key={f.id} style={{ ['--c' as string]: colorOf(f.owner) }}>
              <span className="dot" />
              <span className="nm">{TYPE_NAME[f.type]}</span>
              <span className="n">{f.strength} str · {Math.round(f.cohesion)} coh</span>
              <span className={`sup s${f.supply}`}>{SUPPLY_NAME[f.supply]}</span>
            </div>
          ))}
          {pockets.has(readout) && <div className="kpocket-say">No line of retreat</div>}
        </div>
      )}

      {/* Four bands with four different consequences is more than a border style
          can carry unaided, so the key lives on the map — as one thin strip, since
          anything taller buys legibility by hiding the ground it explains. */}
      <div className="klegend">
        {[3, 2, 1, 0].map((n) => (
          <span className={`row s${n}`} key={n}>
            <i className="pip" />
            <b>{SUPPLY_NAME[n]}</b>
            {SUPPLY_COST_NAME[n] && <em>{SUPPLY_COST_NAME[n]}</em>}
          </span>
        ))}
        <span className="row pocket">
          <i className="pip" />
          <b>Encircled</b>
          <em>surrenders if beaten</em>
        </span>
      </div>
    </>
  )
}

function Counter({
  f, x, y, color, selected, pending, order,
}: {
  f: Formation
  x: number
  y: number
  color: string
  selected: boolean
  pending: boolean
  order: Order | undefined
}) {
  const x0 = x - CW / 2
  const y0 = y - CH / 2
  const cut = f.supply === 0
  const sx = x0 + GUTTER + 7
  const sy = y0 + CH / 2 - 1

  return (
    <g className={`kcounter s${f.supply} ${selected ? 'sel' : ''}`} style={{ ['--c' as string]: color }}>
      {selected && <rect className="halo" x={x0 - 3} y={y0 - 3} width={CW + 6} height={CH + 6} rx={3} />}
      <rect className="body" x={x0} y={y0} width={CW} height={CH} rx={1.5} />
      {cut && <rect className="cut" x={x0} y={y0} width={CW} height={CH} rx={1.5} fill="url(#k-cut)" />}

      {/* the supply gutter: how full it is, is how supplied the formation is */}
      <rect className="gutter-bg" x={x0} y={y0} width={GUTTER} height={CH} />
      {f.supply > 0 && (
        <rect
          className="gutter"
          x={x0}
          y={y0 + CH * (1 - f.supply / 3)}
          width={GUTTER}
          height={CH * (f.supply / 3)}
        />
      )}

      {f.type === 'infantry' && (
        <path className="sym" d={`M${sx - 4.4},${sy - 3.4} L${sx + 4.4},${sy + 3.4} M${sx - 4.4},${sy + 3.4} L${sx + 4.4},${sy - 3.4}`} />
      )}
      {f.type === 'armour' && <ellipse className="sym" cx={sx} cy={sy} rx={4.6} ry={3.3} />}
      {f.type === 'recon' && <path className="sym" d={`M${sx - 4.4},${sy + 3.4} L${sx + 4.4},${sy - 3.4}`} />}

      <text className="str" x={x0 + CW - 6.5} y={y0 + CH / 2 + 2.2}>{f.strength}</text>

      <rect className="coh-bg" x={x0 + GUTTER + 1} y={y0 + CH - 4} width={CW - GUTTER - 2.5} height={2.4} />
      <rect
        className={`coh ${f.cohesion < 30 ? 'low' : ''}`}
        x={x0 + GUTTER + 1}
        y={y0 + CH - 4}
        width={((CW - GUTTER - 2.5) * Math.max(0, Math.min(100, f.cohesion))) / 100}
        height={2.4}
      />

      {cut && (
        <path className="strike" d={`M${x0 + 2},${y0 + 2} L${x0 + CW - 2},${y0 + CH - 2} M${x0 + 2},${y0 + CH - 2} L${x0 + CW - 2},${y0 + 2}`} />
      )}
      {/* what is left to give an order to, marked on the board rather than counted
          in the bar — twenty-six formations is too many to find by name */}
      {pending && <circle className="pending" cx={x0 + CW - 1.5} cy={y0 + 1.5} r={2.6} />}
      {order?.type === 'hold' && <path className="ordmark" d={`M${x0 + 4},${y0 + CH + 4} H${x0 + CW - 4}`} />}
      {order?.type === 'refit' && (
        <path className="ordmark" d={`M${x - 4},${y0 + CH + 4} H${x + 4} M${x},${y0 + CH} V${y0 + CH + 8}`} />
      )}
    </g>
  )
}
