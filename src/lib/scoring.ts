/**
 * BitePlan scoring engine.
 *
 * Every rule in the handoff doc's "Scoring rules" section is implemented here.
 * For every rule, on every call, a ScoringFactor is generated — either fired
 * (positive contribution toward the score) or missing (zero or negative, with
 * a description of what would improve it). The popup in Step 8 surfaces those
 * factors verbatim; this file is the source of truth for "why" a zone scores
 * what it does.
 *
 * scoreUnit() is pure and synchronous so it can be batched cheaply on map move.
 */

import type {
  FactorCategory,
  ScoringContext,
  ScoringFactor,
  ScoringResult,
  ScoringUnit,
  Tier,
} from '@/types'

const TIER_TIME_INVESTMENT: Record<Tier, string> = {
  fire: '30+ minutes',
  hot: '15-30 minutes',
  driveby: '5-10 minutes',
}

// Time windows are in minutes-from-midnight (local time).
const MIDDAY_START_MIN = 10 * 60 // 10:00
const MIDDAY_END_MIN = 16 * 60 // 16:00
const TIME_WINDOW_MIN = 90 // ±1.5h for dawn / dusk

function factor(
  fired: boolean,
  delta: number,
  description: string,
  category: FactorCategory,
): ScoringFactor {
  return { fired, delta, description, category }
}

function tierFor(score: number): Tier {
  if (score >= 8) return 'fire'
  if (score >= 5) return 'hot'
  return 'driveby'
}

export function scoreUnit(unit: ScoringUnit, ctx: ScoringContext): ScoringResult {
  const all: ScoringFactor[] = []
  let total = 0
  const add = (f: ScoringFactor) => {
    all.push(f)
    total += f.delta
  }

  const nowMin = ctx.hour * 60 + ctx.time.getMinutes()
  const sunriseMin = ctx.sunrise.getHours() * 60 + ctx.sunrise.getMinutes()
  const sunsetMin = ctx.sunset.getHours() * 60 + ctx.sunset.getMinutes()
  const inMidday = nowMin >= MIDDAY_START_MIN && nowMin < MIDDAY_END_MIN

  // ----- 1) Habitat baseline ---------------------------------------------
  // Restored to +2 after Step 12.5 v2: the additive-convergence model failed
  // (dense habitat overlap produced thousands of fires). New model is
  // "convergence as unlock" — bare conditions sum naturally; without a
  // convergence tag the final score is clamped to driveby (≤ 4); with one
  // the natural sum applies. So we want the original magnitudes back.
  if (unit.habitatType === 'seagrass') {
    add(factor(true, 2, 'Seagrass edge', 'habitat'))
  } else if (unit.habitatType === 'oyster') {
    add(factor(true, 2, 'Oyster bed', 'habitat'))
  } else {
    // wetland
    add(factor(true, 2, 'Marsh edge', 'habitat'))
  }

  // ----- 2) Tide stage ----------------------------------------------------
  // NB: the handoff doc lists separate rules for "drainage mouths" (wetland-
  // to-open-water transitions) with different deltas. We don't yet detect
  // that subtype, so all wetland units fall under marsh-edge rules.
  if (unit.habitatType === 'wetland') {
    if (ctx.tideState === 'rising') {
      add(factor(true, 2, 'Rising tide on marsh edge', 'tide'))
    } else if (ctx.tideState === 'falling') {
      add(factor(false, 0, 'Falling tide on marsh — rising would add +2', 'tide'))
    } else {
      add(factor(false, -1, 'Slack tide on marsh — moving water would lift this', 'tide'))
    }
  } else if (unit.habitatType === 'oyster') {
    if (ctx.tideState === 'slack') {
      add(factor(false, -1, 'Slack tide on oyster — moving water would add +1', 'tide'))
    } else {
      const dir = ctx.tideState === 'rising' ? 'Rising' : 'Falling'
      add(factor(true, 1, `${dir} tide on oyster bar`, 'tide'))
    }
  } else {
    // seagrass
    if (ctx.tideState === 'slack') {
      add(factor(false, 0, 'Slack tide on seagrass — moving water would add +1', 'tide'))
    } else {
      const dir = ctx.tideState === 'rising' ? 'Rising' : 'Falling'
      add(factor(true, 1, `${dir} tide on seagrass edge`, 'tide'))
    }
  }

  // ----- 3) Time of day ---------------------------------------------------
  //
  // Bands across a full 24 h cycle, in order of check:
  //
  //   Dawn       |sunrise ± 1.5h|                                +2  fired
  //   Dusk       |sunset  ± 1.5h|                                +2  fired
  //   Morning    sunrise+1.5h  →  10:00                          +1  fired
  //   Midday     10:00          →  16:00       (summer = -1)     -1/0 missing
  //   Afternoon  16:00          →  sunset−1.5h                    0  missing
  //   Night      sunset+1.5h    →  sunrise−1.5h                  -2  missing
  //
  // The afternoon band exists so daylight hours between the midday window
  // end (16:00) and the dusk window start (sunset−1.5h) don't accidentally
  // fall into the night branch. On a summer day with a 19:50 sunset, that
  // gap is 16:00–18:20 — three hours of bright daylight that were getting
  // hit with a −2 night penalty before this fix.
  type TimeBand = 'dawn' | 'dusk' | 'morning' | 'midday' | 'afternoon' | 'night'
  let band: TimeBand
  if (Math.abs(nowMin - sunriseMin) <= TIME_WINDOW_MIN) band = 'dawn'
  else if (Math.abs(nowMin - sunsetMin) <= TIME_WINDOW_MIN) band = 'dusk'
  else if (nowMin > sunriseMin + TIME_WINDOW_MIN && nowMin < MIDDAY_START_MIN) band = 'morning'
  else if (inMidday) band = 'midday'
  else if (nowMin >= MIDDAY_END_MIN && nowMin < sunsetMin - TIME_WINDOW_MIN) band = 'afternoon'
  else band = 'night'

  switch (band) {
    case 'dawn':
      add(factor(true, 2, 'Dawn window (within 1.5h of sunrise)', 'time'))
      break
    case 'dusk':
      add(factor(true, 2, 'Dusk window (within 1.5h of sunset)', 'time'))
      break
    case 'morning':
      add(factor(true, 1, 'Mid-morning bite window', 'time'))
      break
    case 'midday': {
      const isSummer = ctx.month >= 5 && ctx.month <= 9
      add(
        isSummer
          ? factor(false, -1, 'Midday in summer — heat penalty', 'time')
          : factor(false, 0, 'Midday outside summer — neutral', 'time'),
      )
      break
    }
    case 'afternoon':
      add(factor(false, 0, 'Afternoon — neutral time of day', 'time'))
      break
    case 'night':
      add(factor(false, -2, 'Night — low activity', 'time'))
      break
  }

  // ----- 4) Season --------------------------------------------------------
  const m = ctx.month
  if (m === 5 || m === 6) {
    add(factor(true, 1, 'Peak inshore season (May–Jun)', 'season'))
  } else if (m === 7 || m === 8) {
    if (inMidday) {
      add(factor(false, -2, 'Jul–Aug midday — heat penalty', 'season'))
    } else {
      add(factor(false, 0, 'Jul–Aug outside midday — neutral', 'season'))
    }
  } else if (m === 9 || m === 10) {
    add(factor(true, 2, 'Fall transition (Sep–Oct)', 'season'))
  } else if (m === 12 || m === 1 || m === 2) {
    if (unit.habitatType === 'seagrass') {
      add(factor(false, -1, 'Winter on grass flats', 'season'))
    } else {
      add(factor(false, 0, 'Winter — no penalty for this habitat', 'season'))
    }
  } else {
    // Mar, Apr, Nov: handoff doesn't list a modifier.
    add(factor(false, 0, 'Off-peak month — no seasonal modifier', 'season'))
  }

  // ----- 5) Species filter -----------------------------------------------
  if (ctx.species !== 'all') {
    let speciesFired = false
    if (
      ctx.species === 'redfish' &&
      (unit.habitatType === 'wetland' || unit.habitatType === 'oyster')
    ) {
      add(factor(true, 1, 'Redfish prefers marsh / oyster', 'species'))
      speciesFired = true
    } else if (ctx.species === 'trout' && unit.habitatType === 'seagrass') {
      add(factor(true, 1, 'Trout prefers seagrass edges', 'species'))
      speciesFired = true
    } else if (ctx.species === 'flounder' && unit.habitatType === 'seagrass') {
      // The handoff doc specifies "sand-adjacent grass" — we don't yet
      // detect sand-vs-mud bottom, so we approximate with all seagrass.
      add(factor(true, 1, 'Flounder prefers sand-adjacent grass', 'species'))
      speciesFired = true
    }
    if (!speciesFired) {
      add(factor(false, 0, `Not preferred habitat for ${ctx.species}`, 'species'))
    }
  }

  // ----- 6) Moon ----------------------------------------------------------
  const illum = ctx.moonIllumination
  if (illum > 0.9) {
    add(factor(true, 0.5, 'Full moon', 'moon'))
  } else if (illum < 0.1) {
    add(factor(true, 0.5, 'New moon', 'moon'))
  } else if (illum >= 0.4 && illum <= 0.6) {
    add(factor(false, 0, 'Quarter moon — neutral', 'moon'))
  } else {
    add(
      factor(
        false,
        0,
        `Moon ${Math.round(illum * 100)}% — between quarter and new/full`,
        'moon',
      ),
    )
  }

  // ----- 7) Wind ----------------------------------------------------------
  // Note: until Step 13 wires NWS, ctx.windSpeedKt is always 0. That falls
  // into the "<10 kt — calm" bucket, which is the correct default.
  const w = ctx.windSpeedKt
  if (w < 10) {
    add(factor(false, 0, `Wind ${w.toFixed(0)} kt — calm`, 'wind'))
  } else if (w <= 15) {
    add(factor(false, -0.5, `Wind ${w.toFixed(0)} kt — mild chop`, 'wind'))
  } else if (w <= 20) {
    add(factor(false, -1, `Wind ${w.toFixed(0)} kt — choppy`, 'wind'))
  } else {
    add(factor(false, -2, `Wind ${w.toFixed(0)} kt — rough`, 'wind'))
  }

  // ----- 8) Daily tide range ---------------------------------------------
  const r = ctx.dailyTideRangeFt
  if (r > 1.2) {
    add(factor(true, 0.5, `Strong tide range (${r.toFixed(1)} ft)`, 'tide'))
  } else if (r < 0.5) {
    add(factor(false, -0.5, `Weak tide range (${r.toFixed(1)} ft)`, 'tide'))
  } else {
    add(factor(false, 0, `Moderate tide range (${r.toFixed(1)} ft)`, 'tide'))
  }

  // ----- 9) Convergence (Step 12.5 v3: multi-tag UNLOCK) ----------------
  //
  // v3 raises the bar: a unit needs at least TWO convergence tags of
  // DIFFERENT types ('point' + 'transition', 'creek_mouth' + 'point', etc.)
  // to clear the gate. A unit with only one tag — or multiple tags of the
  // same type — stays clamped at driveby no matter how good the conditions.
  //
  // The reasoning, straight from the design directive: a grass bed near
  // oysters isn't a convergence by itself; a grass bed near oysters AT A
  // POINT or AT A DRAINAGE MOUTH is. Real fishing convergences are where
  // structure meets structure.
  //
  // Tags fire with delta 0 — they exist to communicate "why this score is
  // allowed to climb", not to add to it. The natural-sum semantics from v2
  // are preserved.
  const tagTypes = new Set(unit.convergence.map((t) => t.type))
  const hasMultiConvergence = tagTypes.size >= 2

  for (const tag of unit.convergence) {
    const label = hasMultiConvergence ? 'structural feature' : 'partial structure'
    add(factor(true, 0, `${tag.description} — ${label}`, 'convergence'))
  }

  // Surface a single combined "missing" line so the popup explains WHY the
  // unit's score is capped. Three states:
  //   1) No tags at all                → "No structural feature here"
  //   2) One tag (or multiple same-type) → "Only X here — needs a different type to unlock"
  //   3) Two+ different types          → no missing line (unit unlocked)
  if (!hasMultiConvergence) {
    if (tagTypes.size === 0) {
      add(
        factor(
          false,
          0,
          'No structural feature here — capped at driveby',
          'convergence',
        ),
      )
    } else {
      const onlyType = Array.from(tagTypes)[0]
      const label =
        onlyType === 'point'
          ? 'a point'
          : onlyType === 'creek_mouth'
            ? 'a creek mouth'
            : 'a habitat transition'
      add(
        factor(
          false,
          0,
          `Only ${label} here — needs a second convergence type to unlock`,
          'convergence',
        ),
      )
    }
  }

  // ----- Final tally ------------------------------------------------------
  // GATING RULE (v3): unit needs ≥ 2 DIFFERENT convergence tag types to
  // unlock above driveby. Otherwise score caps at 4.0 regardless of how
  // good the additive conditions look.
  let score = Math.max(0, Math.min(10, total))
  if (!hasMultiConvergence) score = Math.min(score, 4.0)
  const tier = tierFor(score)

  return {
    score,
    tier,
    timeInvestment: TIER_TIME_INVESTMENT[tier],
    firedFactors: all.filter((f) => f.fired),
    missingFactors: all.filter((f) => !f.fired),
    projectedNextFire: null,
  }
}
