import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { PlayerId } from '../engine/types'
import { COMMAND_RADIUS, REPLACEMENT_TURNS, STRENGTH, inCommand } from '../games/kessel/game'
import { observed } from '../games/kessel/intel'
import { mapOf } from '../games/kessel/map'
import type { Province, ProvinceId, Terrain } from '../games/kessel/map'
import { reachable } from '../games/kessel/movement'
import { depthMap, liveDepots } from '../games/kessel/supply'
import type { Formation, FormationId, KesselState, Order, Sighting } from '../games/kessel/types'
import { playerColor } from './colors'

/** What a click on a highlighted province would do. */
export type TargetKind = 'move' | 'rail' | 'attack' | 'onward' | 'hq'

export interface KesselMapProps {
  state: KesselState
  /**
   * Whose eyes the board is seen through. Enemy counters out of this seat's sight
   * show what it last knew of them; the enemy's aims show only once given away.
   * Null sees everything — a war between bots, or a war being reviewed.
   */
  viewer: PlayerId | null
  selected: FormationId | null
  /** the viewer's headquarters being sent somewhere, by index */
  selectedHq?: number | null
  /** where the selected formation may go, and what happens when it gets there */
  targets: Map<ProvinceId, TargetKind>
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
/**
 * A stack fans like held cards rather than standing in a column. At the counter's
 * own height a three-stack is taller than the provinces around it in western
 * Europe, and the front line becomes a pile nobody can read.
 */
const STACK_DY = 7
const STACK_DX = 4

/**
 * Empty map added below the coastline, so the floating bar has something to sit
 * over. Without it the bar covers North Africa and the formations there are
 * unreachable — the map is fitted to the stage, and the stage runs under the bar.
 */
const BAR_ROOM = 122

/**
 * Zoom range. Counters ride the same transform as the ground, so 4× is where a
 * 27×18 counter stops being a counter and starts being a poster.
 */
const MIN_K = 1
const MAX_K = 4
const KEY_STEP = 1.35
/** How far the pointer may travel between press and release and still be a click. */
const DRAG_SLOP = 4
/** How far the graticule runs past the theatre, in map units — far enough that no pan finds its edge. */
const SHEET = 3000
/**
 * Where the coastline is clipped the ground dissolves into the sheet over this
 * many map units at 1×, instead of ending square. Divided by the zoom, so it is
 * the same hairline at 1× and at 4×.
 */
const FADE = 22

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

type ArrowKind = 'move' | 'rail' | 'attack' | 'onward' | 'late' | 'hq'

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

/** A client point in the svg's own coordinates, which is where the view transform lives. */
function atPointer(svg: SVGSVGElement, cx: number, cy: number) {
  const inv = svg.getScreenCTM()?.inverse()
  if (!inv) return null
  return { x: cx * inv.a + cy * inv.c + inv.e, y: cx * inv.b + cy * inv.d + inv.f }
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
  state, viewer, selected, selectedHq = null, targets, pockets, hover, onPick, onHover,
}: KesselMapProps) {
  const m = mapOf(state.mapId)
  const colorOf = (p: PlayerId) => playerColor(state.sides[p]?.color ?? p)

  /** Provinces the viewer can see into. Everything, when nobody in particular is looking. */
  const eyes = useMemo(
    () => (viewer === null ? null : observed(m, state, viewer)),
    [m, state, viewer],
  )

  /** The viewer's own formations beyond every headquarters: anything ordered to them arrives a turn late. */
  const adrift = useMemo(() => {
    const out = new Set<FormationId>()
    if (viewer === null) return out
    const commanded = inCommand(m, state, viewer)
    for (const f of state.formations) if (f.owner === viewer && !commanded.has(f.id)) out.add(f.id)
    return out
  }, [m, state, viewer])

  /** The clipped plate: the ground the map actually covers, before the bar's room. */
  const plate = useMemo(() => {
    const [x, y, w, h] = m.viewBox.split(/\s+/).map(Number)
    return { x, y, w, h }
  }, [m])
  const frameH = plate.h + BAR_ROOM
  const viewBox = `${plate.x} ${plate.y} ${plate.w} ${frameH}`

  const svgRef = useRef<SVGSVGElement>(null)
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const fade = FADE / view.k

  /**
   * A zoom and a pan that between them can't show anything but the map: at 1×
   * the fit is the only view, and no zoom can leave a strip of blank frame.
   */
  const fit = useCallback(
    (k: number, x: number, y: number) => {
      const kk = Math.min(MAX_K, Math.max(MIN_K, k))
      return {
        k: kk,
        x: Math.min(plate.x * (1 - kk), Math.max((plate.x + plate.w) * (1 - kk), x)),
        y: Math.min(plate.y * (1 - kk), Math.max((plate.y + frameH) * (1 - kk), y)),
      }
    },
    [plate, frameH],
  )

  /** Zoom about a fixed point of the frame, so what is under it stays under it. */
  const zoomAt = useCallback(
    (step: number, ax: number, ay: number) =>
      setView((v) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * step))
        return fit(k, ax - (k / v.k) * (ax - v.x), ay - (k / v.k) * (ay - v.y))
      }),
    [fit],
  )

  // React attaches wheel handlers passively, and a trackpad pinch that isn't
  // swallowed here zooms the browser instead of the map.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const at = atPointer(svg, e.clientX, e.clientY)
      // a pinch arrives as ctrl+wheel, with a delta an order of magnitude smaller
      if (at) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)), at.x, at.y)
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const drag = useRef<
    { id: number; sx: number; sy: number; x: number; y: number; unit: number; moved: boolean } | null
  >(null)
  /** Raised by a drag that actually moved, so the release doesn't also pick a province. */
  const swallow = useRef(false)

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    // one pointer drives the pan; a second finger must not take the map with it
    if (e.button !== 0 || drag.current) return
    swallow.current = false
    drag.current = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      x: view.x,
      y: view.y,
      // screen pixels per map unit, so a pan follows the cursor exactly
      unit: svgRef.current?.getScreenCTM()?.a || 1,
      moved: false,
    }
  }

  // On the window rather than the svg: a pan that runs off the map still has to
  // follow the cursor, and still has to end when the button comes up.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current
      if (!d || e.pointerId !== d.id) return
      const dx = e.clientX - d.sx
      const dy = e.clientY - d.sy
      if (!d.moved) {
        if (Math.hypot(dx, dy) < DRAG_SLOP) return
        d.moved = true
        setPanning(true)
      }
      setView((v) => fit(v.k, d.x + dx / d.unit, d.y + dy / d.unit))
    }
    const onUp = (e: PointerEvent) => {
      const d = drag.current
      if (!d || e.pointerId !== d.id) return
      swallow.current = d.moved
      if (d.moved) setPanning(false)
      drag.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [fit])

  // The view is the map's own business, so its keys are bound here. None of them
  // is one the bar wants: it takes Space, the arrows, G, H, R, ⌫, Esc and ⌘Z.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.key === '0') {
        e.preventDefault()
        setView({ k: 1, x: 0, y: 0 })
        return
      }
      const step = e.key === '+' || e.key === '=' ? KEY_STEP
        : e.key === '-' || e.key === '_' ? 1 / KEY_STEP
        : 0
      if (!step) return
      e.preventDefault()
      zoomAt(step, plate.x + plate.w / 2, plate.y + frameH / 2)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomAt, plate, frameH])

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

  /** Who is fighting for what — as far as the viewer knows. The enemy's aims appear as they are given away. */
  const claim = useMemo(() => {
    const out: Record<ProvinceId, PlayerId> = {}
    for (const side of state.sides) {
      const known = viewer === null || side.id === viewer ? side.aims : side.revealed
      for (const p of known) out[p] = side.id
    }
    return out
  }, [state.sides, viewer])

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

  /** Railheads still on a line home. A depot off it is a building with a name, and drawn as one. */
  const live = useMemo(() => {
    const out = new Set<ProvinceId>()
    for (const side of state.sides) for (const p of liveDepots(m, state, side.id)) out.add(p)
    return out
  }, [m, state])

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
              <g transform={`translate(${p.cx - 27},${p.cy - 21})`} className={live.has(p.id) ? '' : 'dead'}>
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
    [m, claim, live],
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
    const out: { key: string; d: string; kind: ArrowKind; c?: string }[] = []
    const depth: Partial<Record<PlayerId, Record<ProvinceId, number>>> = {}
    for (const f of state.formations) {
      const order = state.orders[f.id]
      if (!order || (order.type !== 'move' && order.type !== 'attack')) continue
      let kind: 'move' | 'rail' | 'attack' = order.type
      if (order.type === 'move') {
        depth[f.owner] ??= depthMap(m, state, f.owner)
        if (reachable(m, state, f, { depth: depth[f.owner] }).rail.has(order.to)) kind = 'rail'
      }
      out.push({ key: String(f.id), d: orderPath(m.province[f.at], m.province[order.to]), kind })
      if (order.type === 'attack' && order.onward) {
        out.push({
          key: `${f.id}:on`,
          d: orderPath(m.province[order.to], m.province[order.onward]),
          kind: 'onward',
        })
      }
    }
    // Orders on their way are the viewer's own business; the enemy's are not drawn.
    for (const f of state.formations) {
      if (viewer !== null && f.owner !== viewer) continue
      const late = state.delayed[f.id]
      if (late?.type !== 'move' && late?.type !== 'attack') continue
      out.push({ key: `${f.id}:late`, d: orderPath(m.province[f.at], m.province[late.to]), kind: 'late' })
    }
    if (viewer === null || viewer === state.current) {
      const hqs = state.sides[state.current].hqs
      for (const [hq, to] of Object.entries(state.hqOrders)) {
        const from = hqs[Number(hq)]
        if (from === undefined || from === to) continue
        out.push({
          key: `hq${hq}`,
          d: orderPath(m.province[from], m.province[to]),
          kind: 'hq',
          c: colorOf(state.current),
        })
      }
    }
    return out
    // colorOf reads only the seat palette, which is fixed for the whole game
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, state, viewer])

  const selectedAt = selected === null
    ? null
    : (state.formations.find((f) => f.id === selected)?.at ?? null)

  const readout = hover ?? selectedAt

  return (
    <>
      <svg
        ref={svgRef}
        className={`map kmap ${panning ? 'panning' : ''}`}
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
      >
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
          <marker
            id="k-head-rail" viewBox="0 0 10 10" refX={9} refY={5}
            markerWidth={4} markerHeight={4} orient="auto-start-reverse"
          >
            <path className="khead move" d="M0 1 L10 5 L0 9 L2.5 5 Z" />
          </marker>
          <marker
            id="k-head-onward" viewBox="0 0 10 10" refX={9} refY={5}
            markerWidth={4} markerHeight={4} orient="auto-start-reverse"
          >
            <path className="khead attack" d="M0 1 L10 5 L0 9 L2.5 5 Z" />
          </marker>

          {/* each vector points inwards, so stop 0 is always the plate edge */}
          {([['w', 0, 0, 1, 0], ['e', 1, 0, 0, 0], ['n', 0, 0, 0, 1]] as const).map(
            ([side, x1, y1, x2, y2]) => (
              <linearGradient key={side} id={`k-fade-${side}`} x1={x1} y1={y1} x2={x2} y2={y2}>
                <stop className="kfade-edge" offset="0" />
                <stop className="kfade-in" offset="1" />
              </linearGradient>
            ),
          )}
        </defs>

        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          <rect
            x={-SHEET} y={-SHEET} width={SHEET * 2 + plate.w} height={SHEET * 2 + frameH}
            fill="url(#kgrat)" pointerEvents="none"
          />

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
                onClick={() => !swallow.current && onPick(p.id)}
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
                    kind === 'attack' ? 'attack'
                      : kind === 'onward' ? 'onward'
                        : kind === 'rail' ? 'target rail'
                          : kind ? 'target' : '',
                    pockets.has(p.id) ? 'pocket' : '',
                    hover === p.id ? 'hot' : '',
                  ].join(' ')}
                  d={p.d}
                />
              )
            })}
          </g>

          <g pointerEvents="none">{marks}</g>

          {/* The coastline is clipped to a lon/lat box, so where the theatre ends
              the ground is cut square — and an ownership colour cut square reads as
              a bug. It dissolves into the sheet instead, except along the south,
              where the bar sits on the edge and the Maghreb is thin enough already.
              Above the ground and under the counters: a formation on the last
              province still has to be read. */}
          <g pointerEvents="none">
            <rect fill="url(#k-fade-w)" x={plate.x} y={plate.y} width={fade} height={plate.h} />
            <rect fill="url(#k-fade-e)" x={plate.x + plate.w - fade} y={plate.y} width={fade} height={plate.h} />
            <rect fill="url(#k-fade-n)" x={plate.x} y={plate.y} width={plate.w} height={fade} />
          </g>

          <g pointerEvents="none">
            {arrows.map((a) => (
              <path
                key={a.key}
                className={`korder ${a.kind}`}
                style={a.c ? { ['--c' as string]: a.c } : undefined}
                d={a.d}
                markerEnd={`url(#k-head-${a.kind === 'late' || a.kind === 'hq' ? 'move' : a.kind})`}
              />
            ))}
          </g>

          <g pointerEvents="none">
            {[...garrison].map(([at, all]) =>
              all.map((f, i) => {
                const hidden = eyes !== null && f.owner !== viewer && !eyes.has(f.at)
                return (
                  <Counter
                    key={f.id}
                    f={f}
                    x={m.province[at].cx + (i - (all.length - 1) / 2) * STACK_DX}
                    y={m.province[at].cy + (i - (all.length - 1) / 2) * STACK_DY}
                    color={colorOf(f.owner)}
                    selected={f.id === selected}
                    adrift={adrift.has(f.id)}
                    order={viewer === null || f.owner === viewer ? state.orders[f.id] : undefined}
                    sighting={hidden ? (viewer === null ? null : state.sides[viewer].seen[f.id] ?? null) : undefined}
                    turn={state.turn}
                  />
                )
              }),
            )}
          </g>

          {/* Headquarters are public — a staff is not hidden the way a counter's
              worth is — and sit off the stack's lower corner, clear of depots and
              objectives. */}
          <g pointerEvents="none">
            {state.sides.flatMap((side) =>
              side.hqs.map((at, i) => (
                <g
                  key={`${side.id}:${i}`}
                  className="khq"
                  transform={`translate(${m.province[at].cx - 20},${m.province[at].cy + 22})`}
                  style={{ ['--c' as string]: colorOf(side.id) }}
                >
                  {side.id === state.current && selectedHq === i && <circle className="ring" cx={3} cy={-7} r={10} />}
                  <path className="staff" d="M0 0 V-14" />
                  <path className="flag" d="M0 -14 H9 L6.5 -10.5 L9 -7 H0 Z" />
                </g>
              )),
            )}
          </g>

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
              ...state.sides
                .filter((side) => side.hqs.includes(readout))
                .map((side) => `${side.name} headquarters`),
            ].filter(Boolean).join(' · ')}
          </div>
          {(garrison.get(readout) ?? []).map((f) => {
            const hidden = eyes !== null && f.owner !== viewer && !eyes.has(f.at)
            const last = hidden && viewer !== null ? state.sides[viewer].seen[f.id] : undefined
            if (hidden) {
              return (
                <div className="f fog" key={f.id} style={{ ['--c' as string]: colorOf(f.owner) }}>
                  <span className="dot" />
                  {last ? (
                    <>
                      <span className="nm">{TYPE_NAME[last.type]}</span>
                      <span className="n">{last.strength} str · {Math.round(last.cohesion)} coh</span>
                      <span className="age">seen turn {last.turn}</span>
                    </>
                  ) : (
                    <span className="nm">Unseen</span>
                  )}
                </div>
              )
            }
            return (
              <div className="f" key={f.id} style={{ ['--c' as string]: colorOf(f.owner) }}>
                <span className="dot" />
                <span className="nm">{TYPE_NAME[f.type]}</span>
                <span className="n">
                  {f.strength} str · {Math.round(f.cohesion)} coh
                  {f.rest > 0 ? ` · rebuilding ${f.rest}/${REPLACEMENT_TURNS}` : ''}
                  {adrift.has(f.id) ? ' · out of command' : ''}
                </span>
                <span className={`sup s${f.supply}`}>{SUPPLY_NAME[f.supply]}</span>
              </div>
            )
          })}
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
        <span className="row hq">
          <i className="pip" />
          <b>Headquarters</b>
          <em>commands {COMMAND_RADIUS} around it</em>
        </span>
        {viewer !== null && (
          <span className="row adrift">
            <i className="pip" />
            <b>Out of command</b>
            <em>orders a turn late</em>
          </span>
        )}
        {viewer !== null && (
          <span className="row fog">
            <i className="pip" />
            <b>Unseen</b>
            <em>last known, if anything</em>
          </span>
        )}
      </div>
    </>
  )
}

function Counter({
  f, x, y, color, selected, adrift, order, sighting, turn,
}: {
  f: Formation
  x: number
  y: number
  color: string
  selected: boolean
  /** one of the viewer's own, beyond every headquarters */
  adrift: boolean
  order: Order | undefined
  /**
   * Set when the viewer cannot see this counter: what they last knew of it, or
   * null for a counter never observed. Undefined means it is in plain sight.
   */
  sighting: Sighting | null | undefined
  turn: number
}) {
  const x0 = x - CW / 2
  const y0 = y - CH / 2
  const sx = x0 + GUTTER + 7
  const sy = y0 + CH / 2 - 1

  // Out of sight: the counter is there — counts are public — but what it is
  // worth is what the viewer last saw, or nothing at all.
  if (sighting !== undefined) {
    const k = sighting
    return (
      <g className={`kcounter fog ${k ? `s${k.supply}` : ''} ${selected ? 'sel' : ''}`} style={{ ['--c' as string]: color }}>
        <rect className="body" x={x0} y={y0} width={CW} height={CH} rx={1.5} />
        {k && (
          <>
            {k.type === 'infantry' && (
              <path className="sym" d={`M${sx - 4.4},${sy - 3.4} L${sx + 4.4},${sy + 3.4} M${sx - 4.4},${sy + 3.4} L${sx + 4.4},${sy - 3.4}`} />
            )}
            {k.type === 'armour' && <ellipse className="sym" cx={sx} cy={sy} rx={4.6} ry={3.3} />}
            {k.type === 'recon' && <path className="sym" d={`M${sx - 4.4},${sy + 3.4} L${sx + 4.4},${sy - 3.4}`} />}
            <text className="str" x={x0 + CW - 6.5} y={y0 + CH / 2 + 2.2}>{k.strength}</text>
            <text className="age" x={x0 + CW - 1.5} y={y0 + CH - 1.5}>{turn - k.turn > 0 ? `−${turn - k.turn}` : ''}</text>
          </>
        )}
        {!k && <text className="str unknown" x={x0 + CW / 2} y={y0 + CH / 2 + 2.6}>?</text>}
      </g>
    )
  }

  const cut = f.supply === 0
  return (
    <g className={`kcounter s${f.supply} ${selected ? 'sel' : ''} ${adrift ? 'adrift' : ''}`} style={{ ['--c' as string]: color }}>
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
      {/* under strength: the steps it is missing, as hollow pips — and rebuilding, if it is */}
      {f.strength < STRENGTH[f.type] && (
        <text className={`str short ${f.rest > 0 ? 'rebuilding' : ''}`} x={x0 + CW - 1.5} y={y0 + 5.2}>
          {f.rest > 0 ? '+' : '−'}
        </text>
      )}

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
      {order?.type === 'hold' && <path className="ordmark" d={`M${x0 + 4},${y0 + CH + 4} H${x0 + CW - 4}`} />}
      {order?.type === 'refit' && (
        <path className="ordmark" d={`M${x - 4},${y0 + CH + 4} H${x + 4} M${x},${y0 + CH} V${y0 + CH + 8}`} />
      )}
    </g>
  )
}
