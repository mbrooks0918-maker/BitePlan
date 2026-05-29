/**
 * TEMPORARY placement (Step 10):
 *
 * 24-hour horizontal time slider, fixed near the bottom of the screen with a
 * dark translucent backdrop. Step 16 will move this component into the proper
 * bottom-sheet half-snap (per the handoff doc); for now it lives directly on
 * top of the map.
 *
 * Composition:
 *   - SVG layer: tide curve (smooth 6-minute predictions, fetched per day),
 *     hi/lo marker dots, a "now" indicator (dashed amber line + label), and
 *     subtle tick marks at each hi/lo event (snap targets).
 *   - Pointer-captured track: tap or drag anywhere on the track to scrub.
 *     During drag we throttle the store update to 100 ms; on release we snap
 *     to the nearest hi/lo event within 15 minutes.
 *   - Header row: scrubbed time read-out + "Reset to now" link.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { format, parseISO, startOfDay } from 'date-fns'
import {
  fetchTideCurve,
  synthesizeCurveFromHilo,
  type TideCurvePoint,
  type TidePrediction,
} from '@/lib/tides'
import { useBitePlanStore } from '@/store/useBitePlanStore'
// Step 16: ModeToggle moved to SheetContent.

const DAY_MS = 24 * 60 * 60 * 1000
const SNAP_WINDOW_MIN = 15

// SVG viewBox dimensions. Width is wide so percentages map smoothly to time
// (1 minute ≈ 0.694 viewBox units); height stays modest so the curve looks
// like a subtle background trace, not a hero chart.
const SVG_W = 1440
const SVG_H = 80
const CURVE_PAD_Y = 8

// Format keys --------------------------------------------------------------

function dayKey(d: Date): string {
  // Used as a useEffect dep so the curve refetches when the slider re-anchors
  // to a new calendar day (e.g. after a midnight crossing on reset-to-now).
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

// Snap helper --------------------------------------------------------------

function snapToNearestEvent(time: Date, events: TidePrediction[]): Date {
  if (events.length === 0) return time
  const ms = time.getTime()
  let best: { delta: number; t: number } | null = null
  for (const e of events) {
    const evtMs = parseISO(e.t).getTime()
    const delta = Math.abs(evtMs - ms)
    if (!best || delta < best.delta) best = { delta, t: evtMs }
  }
  if (best && best.delta <= SNAP_WINDOW_MIN * 60 * 1000) {
    return new Date(best.t)
  }
  return time
}

// --------------------------------------------------------------------------

function TimeSlider() {
  const currentTime = useBitePlanStore((s) => s.currentTime)
  const setCurrentTime = useBitePlanStore((s) => s.setCurrentTime)
  const currentStation = useBitePlanStore((s) => s.currentStation)
  const tidePredictions = useBitePlanStore((s) => s.tidePredictions)

  // Anchor the 24-hour window to midnight of `currentTime`'s day.
  const dayStart = useMemo(() => startOfDay(currentTime), [currentTime])

  // ----- tide curve fetch (per station + day) -----------------------------

  const [curve, setCurve] = useState<TideCurvePoint[]>([])
  useEffect(() => {
    let cancelled = false
    setCurve([])
    // Try NOAA's smooth interval=6 curve first (works on primary stations like
    // Pensacola). If empty (subordinate station — Nix Point's hi/lo offsets
    // don't ship a smooth curve), synthesize one from the hi/lo events we
    // already have so the user still sees a tide-shape reference.
    fetchTideCurve(currentStation.id, dayStart)
      .then((c) => {
        if (cancelled) return
        if (c.length > 0) {
          setCurve(c)
        } else {
          setCurve(synthesizeCurveFromHilo(tidePredictions, dayStart))
        }
      })
      .catch((e) => {
        if (cancelled) return
        console.warn('[TimeSlider] curve fetch failed, falling back to synth', e)
        setCurve(synthesizeCurveFromHilo(tidePredictions, dayStart))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStation.id, dayKey(dayStart), tidePredictions.length])

  // ----- "now" tick state (updates once a minute) -------------------------

  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // ----- pointer-driven scrubbing -----------------------------------------

  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [localPercent, setLocalPercent] = useState<number | null>(null)

  function ratioFromPointer(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 0
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left))
    return x / rect.width
  }

  function commitRatio(ratio: number) {
    const newTime = new Date(dayStart.getTime() + ratio * DAY_MS)
    setCurrentTime(newTime)
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!trackRef.current) return
    trackRef.current.setPointerCapture(e.pointerId)
    draggingRef.current = true
    const ratio = ratioFromPointer(e.clientX)
    setLocalPercent(ratio * 100)
    commitRatio(ratio)
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return
    const ratio = ratioFromPointer(e.clientX)
    setLocalPercent(ratio * 100)
    commitRatio(ratio)
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return
    draggingRef.current = false
    if (trackRef.current?.hasPointerCapture(e.pointerId)) {
      trackRef.current.releasePointerCapture(e.pointerId)
    }
    // Snap on release if we're close to a hi/lo event.
    const ratio = localPercent != null ? localPercent / 100 : ratioFromPointer(e.clientX)
    const released = new Date(dayStart.getTime() + ratio * DAY_MS)
    const snapped = snapToNearestEvent(released, tidePredictions)
    setCurrentTime(snapped)
    setLocalPercent(null)
  }

  // ----- derived geometry --------------------------------------------------

  const dayStartMs = dayStart.getTime()
  const currentRatio = Math.max(
    0,
    Math.min(1, (currentTime.getTime() - dayStartMs) / DAY_MS),
  )
  const thumbPercent = localPercent ?? currentRatio * 100

  const nowRatio = Math.max(0, Math.min(1, (nowTick - dayStartMs) / DAY_MS))
  const nowVisible = nowTick >= dayStartMs && nowTick < dayStartMs + DAY_MS
  const nowX = nowRatio * SVG_W
  const atNow = Math.abs(currentTime.getTime() - nowTick) < 60_000

  // Tide curve path (line + soft area fill)
  const { curvePath, fillPath, hiloCurveDots } = useMemo(() => {
    if (curve.length === 0) return { curvePath: '', fillPath: '', hiloCurveDots: [] as Array<{ x: number; y: number; type: 'H' | 'L' }> }
    const values = curve.map((p) => p.v)
    const minV = Math.min(...values)
    const maxV = Math.max(...values)
    const range = Math.max(0.1, maxV - minV)

    const pts = curve.map((p) => {
      const tMs = parseISO(p.t).getTime()
      const x = ((tMs - dayStartMs) / DAY_MS) * SVG_W
      const yRatio = (p.v - minV) / range
      const y = SVG_H - CURVE_PAD_Y - yRatio * (SVG_H - 2 * CURVE_PAD_Y)
      return { x, y }
    })

    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
    for (let i = 1; i < pts.length; i++) {
      d += ` L ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`
    }
    const fill = `${d} L ${pts[pts.length - 1].x.toFixed(1)} ${SVG_H} L ${pts[0].x.toFixed(1)} ${SVG_H} Z`

    // Map each hi/lo event to its position on the curve.
    const dots = tidePredictions
      .map((e) => {
        const tMs = parseISO(e.t).getTime()
        const x = ((tMs - dayStartMs) / DAY_MS) * SVG_W
        const yRatio = (e.v - minV) / range
        const y = SVG_H - CURVE_PAD_Y - yRatio * (SVG_H - 2 * CURVE_PAD_Y)
        return { x, y, type: e.type }
      })
      .filter((p) => p.x >= 0 && p.x <= SVG_W)

    return { curvePath: d, fillPath: fill, hiloCurveDots: dots }
  }, [curve, dayStartMs, tidePredictions])

  // Snap-target ticks at the bottom of the track.
  const eventTicks = useMemo(() => {
    return tidePredictions
      .map((e) => {
        const tMs = parseISO(e.t).getTime()
        const x = ((tMs - dayStartMs) / DAY_MS) * SVG_W
        return { x, type: e.type }
      })
      .filter((t) => t.x >= 0 && t.x <= SVG_W)
  }, [tidePredictions, dayStartMs])

  // ----- handlers ----------------------------------------------------------

  function resetToNow() {
    setCurrentTime(new Date())
  }

  // ----- render ------------------------------------------------------------

  return (
    <div
      // Step 16: embedded inside the BottomSheet's Half snap. The sheet
      // owns the surrounding card chrome (slate background, rounded
      // corners). The slider itself just lays out its own track + thumb.
      className="relative w-full"
    >
      {/* Header row — mode toggle moved to SheetContent so we don't render
          it here twice; this row keeps only the current-time readout. */}
      <div className="flex items-center justify-end mb-2 gap-3">
        <div className="flex items-baseline gap-3 ml-auto">
          <div className="text-slate-100 text-sm">
            <span className="text-slate-400 mr-2">
              {format(currentTime, 'EEE MMM d')}
            </span>
            <span className="font-semibold tabular-nums text-base">
              {format(currentTime, 'h:mm a')}
            </span>
          </div>
          {!atNow && (
            <button
              type="button"
              onClick={resetToNow}
              className="text-xs font-medium text-teal-400 hover:text-teal-300 underline underline-offset-2"
            >
              Reset to now
            </button>
          )}
        </div>
      </div>

      {/* Track */}
      <div
        ref={trackRef}
        role="slider"
        aria-label="Scrub time"
        aria-valuemin={0}
        aria-valuemax={1440}
        aria-valuenow={Math.round(currentRatio * 1440)}
        // Slider needs `touch-none` so a vertical-scroll gesture doesn't fight
        // with horizontal drags on mobile.
        className="relative h-16 select-none touch-none cursor-pointer"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <svg
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full pointer-events-none"
        >
          {/* Subtle track baseline */}
          <line
            x1={0}
            y1={SVG_H / 2}
            x2={SVG_W}
            y2={SVG_H / 2}
            stroke="#334155"
            strokeWidth={1}
          />

          {/* Tide curve: soft fill + line */}
          {fillPath && (
            <path d={fillPath} fill="#14b8a6" fillOpacity={0.12} />
          )}
          {curvePath && (
            <path
              d={curvePath}
              fill="none"
              stroke="#2dd4bf"
              strokeOpacity={0.6}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* Hi/lo dots on the curve */}
          {hiloCurveDots.map((d, i) => (
            <circle
              key={`hilo-dot-${i}`}
              cx={d.x}
              cy={d.y}
              r={3}
              fill={d.type === 'H' ? '#2dd4bf' : '#0ea5e9'}
              fillOpacity={0.8}
            />
          ))}

          {/* Hi/lo snap-target ticks at the bottom */}
          {eventTicks.map((e, i) => (
            <line
              key={`tick-${i}`}
              x1={e.x}
              y1={SVG_H - 10}
              x2={e.x}
              y2={SVG_H}
              stroke="#64748b"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* "Now" indicator */}
          {nowVisible && (
            <>
              <line
                x1={nowX}
                y1={0}
                x2={nowX}
                y2={SVG_H}
                stroke="#f59e0b"
                strokeWidth={1.5}
                strokeDasharray="3,3"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={nowX + 4}
                y={11}
                fontSize={10}
                fill="#f59e0b"
                fontWeight={600}
              >
                now
              </text>
            </>
          )}
        </svg>

        {/* Thumb */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-11 rounded-full bg-slate-100 ring-2 ring-slate-300 shadow-lg flex items-center justify-center cursor-grab active:cursor-grabbing"
          style={{ left: `${thumbPercent}%` }}
          aria-hidden
        >
          <div className="size-2.5 rounded-full bg-slate-700" />
        </div>
      </div>

      {/* Hour-axis hints — optional but readable */}
      <div className="mt-2 flex justify-between text-[10px] text-slate-400 tabular-nums px-1">
        <span>12 AM</span>
        <span>6 AM</span>
        <span>12 PM</span>
        <span>6 PM</span>
        <span>12 AM</span>
      </div>
    </div>
  )
}

export default TimeSlider
