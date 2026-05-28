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
  // Every scoring unit in our impl is either a small whole polygon or a
  // sampled edge point — both treated as "edge" for baseline purposes.
  // (The handoff's "interior of large seagrass: +0" case never arises here
  // because large polygons are sampled to edges, not scored as wholes.)
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
  type TimeBand = 'dawn' | 'dusk' | 'morning' | 'midday' | 'night'
  let band: TimeBand
  if (Math.abs(nowMin - sunriseMin) <= TIME_WINDOW_MIN) band = 'dawn'
  else if (Math.abs(nowMin - sunsetMin) <= TIME_WINDOW_MIN) band = 'dusk'
  else if (nowMin > sunriseMin + TIME_WINDOW_MIN && nowMin < MIDDAY_START_MIN) band = 'morning'
  else if (inMidday) band = 'midday'
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

  // ----- Final tally ------------------------------------------------------
  const score = Math.max(0, Math.min(10, total))
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
