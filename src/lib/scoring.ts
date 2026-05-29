/**
 * BitePlan scoring engine — Step 13.5 audit (Rules Calibration v2).
 *
 * Every rule in the handoff doc's "Scoring rules" section + the
 * "SCORING AUDIT (Rules Calibration v2)" memo is implemented here. For every
 * rule, on every call, a ScoringFactor is generated — either fired (positive
 * contribution toward the score) or missing (zero or negative, with a
 * description of what would improve it). The popup surfaces those factors
 * verbatim; this file is the source of truth for "why" a zone scores what
 * it does.
 *
 * Architecture preserved from Step 12.5 v3:
 *   - factors are additive (the "trust layer"),
 *   - convergence acts as an UNLOCK gate — a unit needs at least two tags
 *     of DIFFERENT types ('point' / 'creek_mouth' / 'transition' /
 *     'chokepoint' / 'confluence') to clear driveby.
 *
 * Audit changes (v2) summarized:
 *   - habitat: oyster bumped to +2.5
 *   - season: month-by-month panhandle calibration; June = 0 baseline
 *   - tide: species-differentiated rules; 'all' uses pre-averaged values
 *   - moon: halved (0.25) — most signal is already in tide range
 *   - wind: direction modifier added on top of the speed-only rule
 *   - tide range: thresholds shifted to 0.8 / 1.5 ft
 *   - NEW: water temperature factor (estimated from air temp via seasonal lag)
 *   - NEW: barometric pressure trend factor (with trout boost on falling)
 *   - NEW: frontal-passage compound factor
 *
 * scoreUnit() is pure and synchronous so it can be batched cheaply on map
 * move.
 */

import type {
  FactorCategory,
  ScoringContext,
  ScoringFactor,
  ScoringResult,
  ScoringUnit,
  Species,
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

// ---- Step 13.5 audit: season table ---------------------------------------
//
// Panhandle-specific monthly calibration from the audit memo. `grass` covers
// seagrass + (plain) wetland units; `deep` covers oyster bars + any unit
// carrying a chokepoint or confluence convergence tag. The split only
// matters during the cold-push months (Jan / Feb / Dec) — every other month
// the two columns are equal.
type SeasonRow = { grass: number; deep: number; desc: string }
const SEASON_TABLE: Record<number, SeasonRow> = {
  1:  { grass: -1,  deep: 0,   desc: 'January cold push — fish hold deeper' },
  2:  { grass: -1,  deep: 0,   desc: 'February cold push — fish hold deeper' },
  3:  { grass: 1,   deep: 1,   desc: 'March — spring warming' },
  4:  { grass: 1,   deep: 1,   desc: 'April — warming continues' },
  5:  { grass: 1,   deep: 1,   desc: 'May — transition, flounder returning from Gulf' },
  6:  { grass: 0,   deep: 0,   desc: 'June — shoulder season (panhandle)' },
  7:  { grass: 0,   deep: 0,   desc: 'July — shoulder season (panhandle)' },
  8:  { grass: 0,   deep: 0,   desc: 'August — shoulder season (panhandle)' },
  9:  { grass: 2,   deep: 2,   desc: 'September — fall transition, bull redfish arriving' },
  10: { grass: 2.5, deep: 2.5, desc: 'October — PEAK inshore month' },
  11: { grass: 2,   deep: 2,   desc: 'November — still peak' },
  12: { grass: -1,  deep: 0,   desc: 'December cold push — fish hold deeper' },
}
const SUMMER_MIDDAY_MONTHS = new Set([6, 7, 8])

// ---- Step 13.5 audit: species-differentiated tide rules ------------------
//
// We bucket each unit into one of five "tide-rule kinds" based on habitat
// type + convergence tags:
//   - chokepoint: any unit with a chokepoint convergence tag — strongest
//     flow signal, dominates the bucket
//   - drainage:   wetland unit with a creek_mouth OR confluence tag — the
//     "drainage mouth" archetype the audit calls out
//   - marsh:      bare wetland (no creek/confluence tag, no chokepoint)
//   - oyster:     oyster bar
//   - grass:      seagrass
//
// The 'all'-species column is hardcoded as the rounded average of the three
// species rules per (kind × tideState), avoiding runtime division. Where a
// species has no rule for a (kind, state) combo, that species contributes 0
// to the average for that cell. Documented inline below.

type TideKind = 'grass' | 'marsh' | 'oyster' | 'drainage' | 'chokepoint'
type TideState = ScoringContext['tideState']
type TideEntry = { delta: number; description: string }
type TideMatrix = Record<TideKind, Record<TideState, TideEntry>>

const TIDE_REDFISH: TideMatrix = {
  grass:      {
    rising:  { delta: 1,    description: 'Rising tide on seagrass edge — redfish cruise' },
    falling: { delta: 0,    description: 'Falling tide on seagrass edge — redfish neutral' },
    slack:   { delta: -1,   description: 'Slack tide — no flow for redfish' },
  },
  marsh:      {
    rising:  { delta: 2,    description: 'Rising tide flooding marsh — prime redfish window' },
    falling: { delta: 0.5,  description: 'Falling tide pulling bait off marsh — redfish stage' },
    slack:   { delta: -1,   description: 'Slack tide on marsh — no flow' },
  },
  oyster:     {
    rising:  { delta: 1,    description: 'Rising tide on oyster bar — redfish patrol' },
    falling: { delta: 1,    description: 'Falling tide on oyster bar — redfish patrol' },
    slack:   { delta: -1,   description: 'Slack tide on oyster — no flow' },
  },
  drainage:   {
    rising:  { delta: 2,    description: 'Rising tide flooding drainage mouth (redfish)' },
    falling: { delta: 0.5,  description: 'Falling tide draining mouth (redfish)' },
    slack:   { delta: -1,   description: 'Slack tide on drainage — no flow' },
  },
  chokepoint: {
    rising:  { delta: 1,    description: 'Rising tide through chokepoint (redfish)' },
    falling: { delta: 1,    description: 'Falling tide through chokepoint (redfish)' },
    slack:   { delta: -1,   description: 'Slack at chokepoint — no flow' },
  },
}

const TIDE_TROUT: TideMatrix = {
  grass:      {
    // "Any moving water" per the audit — trout seam preference is strong.
    rising:  { delta: 1.5,  description: 'Moving water on grass edge (trout seam +1.5)' },
    falling: { delta: 1.5,  description: 'Moving water on grass edge (trout seam +1.5)' },
    slack:   { delta: -1,   description: 'Slack tide on grass — no seam pressure' },
  },
  marsh:      {
    rising:  { delta: 0,    description: 'Marsh edge — trout neutral (prefers grass seams)' },
    falling: { delta: 0,    description: 'Marsh edge — trout neutral (prefers grass seams)' },
    slack:   { delta: -1,   description: 'Slack tide on marsh — no flow' },
  },
  oyster:     {
    // Downcurrent side is the documented preference; we can't truly
    // distinguish upcurrent vs downcurrent at this scale, so we approximate
    // by applying +1.5 on any moving water (over-counts the upcurrent side
    // by ~+0.5, accepted for now).
    rising:  { delta: 1.5,  description: 'Oyster bar with current (trout downcurrent side, approx.)' },
    falling: { delta: 1.5,  description: 'Oyster bar with current (trout downcurrent side, approx.)' },
    slack:   { delta: -1,   description: 'Slack tide on oyster — no flow' },
  },
  drainage:   {
    rising:  { delta: 1,    description: 'Drainage mouth with current (trout)' },
    falling: { delta: 1,    description: 'Drainage mouth with current (trout)' },
    slack:   { delta: -1,   description: 'Slack tide on drainage — no flow' },
  },
  chokepoint: {
    rising:  { delta: 1.5,  description: 'Chokepoint with current (trout)' },
    falling: { delta: 1.5,  description: 'Chokepoint with current (trout)' },
    slack:   { delta: -1,   description: 'Slack at chokepoint — no flow' },
  },
}

const TIDE_FLOUNDER: TideMatrix = {
  grass:      {
    rising:  { delta: 1,    description: 'Moving water on grass edge (flounder)' },
    falling: { delta: 1,    description: 'Moving water on grass edge (flounder)' },
    slack:   { delta: -1,   description: 'Slack tide on grass — flounder won\'t ambush' },
  },
  marsh:      {
    rising:  { delta: 0.5,  description: 'Marsh edge rising — flounder neutral' },
    falling: { delta: 1.5,  description: 'Falling tide pulling bait off marsh — flounder ambush' },
    slack:   { delta: -1,   description: 'Slack tide on marsh — no flow' },
  },
  oyster:     {
    rising:  { delta: 0,    description: 'Oyster bar — flounder rarely keys here' },
    falling: { delta: 0,    description: 'Oyster bar — flounder rarely keys here' },
    slack:   { delta: -1,   description: 'Slack tide on oyster — no flow' },
  },
  drainage:   {
    rising:  { delta: 1,    description: 'Drainage mouth rising — flounder moving in' },
    falling: { delta: 2.5,  description: 'Falling tide draining the mouth — FLOUNDER PRIME' },
    slack:   { delta: -1,   description: 'Slack tide on drainage — no flow' },
  },
  chokepoint: {
    rising:  { delta: 2,    description: 'Chokepoint with current — flounder stack' },
    falling: { delta: 2,    description: 'Chokepoint with current — flounder stack' },
    slack:   { delta: -1,   description: 'Slack at chokepoint — no flow' },
  },
}

/**
 * Pre-averaged ALL-species values. Computed once below from the three
 * species matrices to keep the runtime path branch-free. The rounding to
 * nearest 0.25 keeps scores landing on tidy half/quarter-point boundaries
 * for popup display.
 */
function avg3Q(a: number, b: number, c: number): number {
  // Round to nearest 0.25.
  return Math.round(((a + b + c) / 3) * 4) / 4
}
const TIDE_ALL: TideMatrix = (() => {
  const matrix = {} as TideMatrix
  const kinds: TideKind[] = ['grass', 'marsh', 'oyster', 'drainage', 'chokepoint']
  const states: TideState[] = ['rising', 'falling', 'slack']
  const kindLabel: Record<TideKind, string> = {
    grass: 'seagrass edge',
    marsh: 'marsh edge',
    oyster: 'oyster bar',
    drainage: 'drainage mouth',
    chokepoint: 'chokepoint',
  }
  for (const k of kinds) {
    matrix[k] = {} as Record<TideState, TideEntry>
    for (const s of states) {
      const d = avg3Q(
        TIDE_REDFISH[k][s].delta,
        TIDE_TROUT[k][s].delta,
        TIDE_FLOUNDER[k][s].delta,
      )
      const stateLabel =
        s === 'slack' ? 'Slack tide' : s === 'rising' ? 'Rising tide' : 'Falling tide'
      matrix[k][s] = {
        delta: d,
        description: `${stateLabel} on ${kindLabel[k]} (all species avg)`,
      }
    }
  }
  return matrix
})()

function getTideMatrix(species: Species): TideMatrix {
  switch (species) {
    case 'redfish':  return TIDE_REDFISH
    case 'trout':    return TIDE_TROUT
    case 'flounder': return TIDE_FLOUNDER
    default:         return TIDE_ALL
  }
}

function classifyTideKind(unit: ScoringUnit): TideKind {
  const tagTypes = new Set(unit.convergence.map((t) => t.type))
  // Chokepoint dominates — strongest flow signal across species.
  if (tagTypes.has('chokepoint')) return 'chokepoint'
  if (unit.habitatType === 'wetland') {
    if (tagTypes.has('creek_mouth') || tagTypes.has('confluence')) return 'drainage'
    return 'marsh'
  }
  if (unit.habitatType === 'oyster') return 'oyster'
  return 'grass'
}

// ---- Step 13.5 audit: water-temperature factor --------------------------
function waterTempDelta(species: Species, tempF: number): {
  delta: number
  desc: string
} {
  if (tempF <= 0) return { delta: 0, desc: 'Water temp unavailable — neutral' }
  if (tempF < 55) return {
    delta: -2,
    desc: `Water temp ${tempF.toFixed(0)}°F — cold-stunned territory`,
  }
  if (tempF < 65) {
    const isFlounder = species === 'flounder'
    return {
      delta: isFlounder ? 0 : -1,
      desc: `Water temp ${tempF.toFixed(0)}°F — cool${isFlounder ? ' (flounder tolerant)' : ''}`,
    }
  }
  if (tempF < 72) return {
    delta: 1,
    desc: `Water temp ${tempF.toFixed(0)}°F — optimal range`,
  }
  if (tempF < 80) return {
    delta: 0.5,
    desc: `Water temp ${tempF.toFixed(0)}°F — peak range`,
  }
  if (tempF < 85) return {
    delta: 0,
    desc: `Water temp ${tempF.toFixed(0)}°F — warm`,
  }
  return {
    delta: -1,
    desc: `Water temp ${tempF.toFixed(0)}°F — heat stress`,
  }
}

// ---- Step 13.5 audit: pressure trend factor -----------------------------
function pressureDelta(
  species: Species,
  pressureInHg: number,
  trendPer3h: number,
): { delta: number; desc: string } {
  // Sustained high (bluebird) — pressure > 30.30 AND trend ~ stable.
  if (pressureInHg > 30.3 && Math.abs(trendPer3h) <= 0.02) {
    return {
      delta: -0.5,
      desc: `Bluebird high (${pressureInHg.toFixed(2)} inHg, stable) — bite slow`,
    }
  }
  if (trendPer3h < -0.05) {
    const isTrout = species === 'trout'
    return {
      delta: isTrout ? 1.5 : 1,
      desc: `Pressure falling fast (${trendPer3h.toFixed(2)} inHg/3h) — pre-front bite${isTrout ? ' (trout favorite)' : ''}`,
    }
  }
  if (trendPer3h > 0.05) {
    return {
      delta: -0.5,
      desc: `Pressure rising (${trendPer3h.toFixed(2)} inHg/3h) — post-front`,
    }
  }
  return {
    delta: 0,
    desc: `Pressure ${pressureInHg.toFixed(2)} inHg, stable — neutral`,
  }
}

// ---- Step 13.5 audit: frontal-phase factor -------------------------------
//
// v2.1 (post-launch tuning, per audit memo update): pre-frontal +1.5 was
// flipping otherwise-7 units to 8/fire on a single NWS "showers" keyword.
// Reduced to +1.0 (+1.25 for trout) so pre-front is still the strongest
// single environmental modifier but can't single-handedly cross the fire
// threshold. Post-frontal magnitude eased to -0.75 for symmetry.
function frontalDelta(
  species: Species,
  phase: ScoringContext['frontalPhase'],
): { delta: number; desc: string } {
  switch (phase) {
    case 'pre': {
      const isTrout = species === 'trout'
      return {
        delta: isTrout ? 1.25 : 1,
        desc: `Pre-frontal window — fish feeding ahead of storm${isTrout ? ' (trout favorite)' : ''}`,
      }
    }
    case 'during':
      return {
        delta: 0,
        desc: 'Front passing — chaotic, treat as neutral',
      }
    case 'post':
      return {
        delta: -0.75,
        desc: 'Post-frontal high pressure — bite slow',
      }
    default:
      return {
        delta: 0,
        desc: 'Stable conditions — no frontal influence',
      }
  }
}

// ---- Step 13.5 audit: wind direction modifier ----------------------------
function windDirectionDelta(
  species: Species,
  month: number,
  habitatType: ScoringUnit['habitatType'],
  tideState: TideState,
  compass: string | undefined,
): { delta: number; desc: string } | null {
  if (!compass) return null
  // Capped at ±1 total (audit memo). The branches below already stay
  // within that envelope.
  const winter = month === 12 || month === 1 || month === 2
  const cardinal = compass.toUpperCase()
  if (cardinal === 'N' || cardinal === 'NE') {
    if (winter && species === 'trout') {
      // Net: cold push −0.5 + clarity +0.5 = 0
      return {
        delta: 0,
        desc: `${cardinal} wind — cold push offset by winter clarity for trout`,
      }
    }
    return {
      delta: -0.5,
      desc: `${cardinal} wind — post-frontal cold push`,
    }
  }
  if (cardinal === 'E' || cardinal === 'SE') {
    return {
      delta: 0,
      desc: `${cardinal} wind — most stable inshore direction`,
    }
  }
  if (cardinal === 'S' || cardinal === 'SW') {
    const baitBoost = habitatType === 'wetland' || species === 'redfish'
    if (baitBoost) {
      // Net: clarity penalty -0.5 + bait concentration +0.5 = 0
      return {
        delta: 0,
        desc: `${cardinal} wind — clarity loss offset by bait concentration on shoreline`,
      }
    }
    return {
      delta: -0.5,
      desc: `${cardinal} wind — clarity penalty`,
    }
  }
  if (cardinal === 'W' || cardinal === 'NW') {
    if (tideState === 'falling') {
      return {
        delta: -1,
        desc: `${cardinal} wind on falling tide — pushing water out of bay`,
      }
    }
    return {
      delta: 0,
      desc: `${cardinal} wind — neutral on this tide`,
    }
  }
  return null
}

// =========================================================================
// scoreUnit
// =========================================================================

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

  // ----- 1) Habitat baseline (audit v2: oyster bumped to +2.5) -----------
  if (unit.habitatType === 'seagrass') {
    add(factor(true, 2, 'Seagrass edge', 'habitat'))
  } else if (unit.habitatType === 'oyster') {
    add(factor(true, 2.5, 'Oyster bed — #1 inshore structure', 'habitat'))
  } else {
    add(factor(true, 2, 'Marsh edge', 'habitat'))
  }

  // ----- 2) Tide stage (species-differentiated, audit v2) -----------------
  const tideKind = classifyTideKind(unit)
  const tideMatrix = getTideMatrix(ctx.species)
  const tideEntry = tideMatrix[tideKind][ctx.tideState]
  add(
    factor(
      tideEntry.delta > 0,
      tideEntry.delta,
      tideEntry.description,
      'tide',
    ),
  )

  // ----- 3) Time of day ---------------------------------------------------
  //
  // Bands across a full 24 h cycle, in order of check:
  //   Dawn / Dusk: ±1.5 h of sunrise/sunset                       +2
  //   Morning:     sunrise+1.5h → 10:00                           +1
  //   Midday:      10:00 → 16:00                                   0   (audit v2:
  //                                                                    summer
  //                                                                    midday
  //                                                                    moved into
  //                                                                    season block)
  //   Afternoon:   16:00 → sunset−1.5h                             0
  //   Night:       sunset+1.5h → sunrise−1.5h                     −2
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
    case 'midday':
      add(factor(false, 0, 'Midday — neutral time of day', 'time'))
      break
    case 'afternoon':
      add(factor(false, 0, 'Afternoon — neutral time of day', 'time'))
      break
    case 'night':
      add(factor(false, -2, 'Night — low activity', 'time'))
      break
  }

  // ----- 4) Season (audit v2: month-by-month panhandle calibration) -------
  //
  // "deep structure" = oyster habitat OR a unit with a chokepoint/confluence
  // tag (the cold-month columns differ for these). Everything else is
  // "grass flats" — seagrass + plain wetland (audit's note: "Wetlands behave
  // like grass flats for season purposes (cold-sensitive shallow).").
  const isDeepStructure =
    unit.habitatType === 'oyster' || tideKind === 'chokepoint' || tideKind === 'drainage'
  const season = SEASON_TABLE[ctx.month]
  const seasonDelta = isDeepStructure ? season.deep : season.grass
  if (seasonDelta !== 0) {
    add(factor(seasonDelta > 0, seasonDelta, season.desc, 'season'))
  } else {
    add(factor(false, 0, season.desc, 'season'))
  }

  // Summer midday penalty lives here per audit memo (moved out of the time
  // block, which is now neutral at midday).
  if (SUMMER_MIDDAY_MONTHS.has(ctx.month) && inMidday) {
    add(
      factor(
        false,
        -1.5,
        'Jun–Aug midday — heat stress on the flats',
        'season',
      ),
    )
  }

  // ----- 5) Species preference --------------------------------------------
  //
  // Kept from the prior model — it complements the species-differentiated
  // tide rules above by also recognising the SPECIES × HABITAT affinity
  // independent of tide state. The two layers are intentionally separate so
  // the popup explains both why the time/tide window is good AND why this
  // habitat suits the chosen species.
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
      add(factor(true, 1, 'Flounder prefers sand-adjacent grass', 'species'))
      speciesFired = true
    }
    if (!speciesFired) {
      add(factor(false, 0, `Not preferred habitat for ${ctx.species}`, 'species'))
    }
  }

  // ----- 6) Moon (audit v2: halved to +0.25) ------------------------------
  //
  // Moon's effect is mostly mediated via spring tides, already captured by
  // the tide range factor; reduced to +0.25 to avoid double-counting per
  // the audit memo.
  const illum = ctx.moonIllumination
  if (illum > 0.9) {
    add(factor(true, 0.25, 'Full moon', 'moon'))
  } else if (illum < 0.1) {
    add(factor(true, 0.25, 'New moon', 'moon'))
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

  // ----- 7) Wind (speed + audit v2 direction modifier) -------------------
  //
  // Speed-only rule from the original model stays; the audit adds a
  // separate direction modifier (capped ±1) layered on top.
  const w = ctx.windSpeedKt
  const dirSuffix = ctx.windDirectionCompass ? ` ${ctx.windDirectionCompass}` : ''
  if (w < 10) {
    const label = w < 3 ? 'calm' : 'light wind'
    add(factor(false, 0, `Wind ${w.toFixed(0)} kt${dirSuffix} — ${label}`, 'wind'))
  } else if (w <= 15) {
    add(factor(false, -0.5, `Wind ${w.toFixed(0)} kt${dirSuffix} — light chop`, 'wind'))
  } else if (w <= 20) {
    add(factor(false, -1, `Wind ${w.toFixed(0)} kt${dirSuffix} — choppy`, 'wind'))
  } else {
    add(factor(false, -2, `Wind ${w.toFixed(0)} kt${dirSuffix} — blown out`, 'wind'))
  }

  const dirMod = windDirectionDelta(
    ctx.species,
    ctx.month,
    unit.habitatType,
    ctx.tideState,
    ctx.windDirectionCompass,
  )
  if (dirMod) {
    add(factor(dirMod.delta > 0, dirMod.delta, dirMod.desc, 'wind'))
  }

  // ----- 8) Daily tide range (audit v2 thresholds: 0.8 / 1.5) ------------
  const r = ctx.dailyTideRangeFt
  if (r > 1.5) {
    add(factor(true, 0.5, `Strong tide range (${r.toFixed(1)} ft)`, 'tide'))
  } else if (r < 0.8) {
    add(factor(false, -0.5, `Weak tide range (${r.toFixed(1)} ft)`, 'tide'))
  } else {
    add(factor(false, 0, `Moderate tide range (${r.toFixed(1)} ft)`, 'tide'))
  }

  // ----- 9) Water temperature (audit v2: new factor) ---------------------
  //
  // Estimate-based; the store derives waterTempF from air temp via a
  // seasonal lag model. Replace with NDBC station #42012 buoy data in a
  // future step for true water temp.
  const tempInfo = waterTempDelta(ctx.species, ctx.waterTempF)
  if (tempInfo.delta !== 0) {
    add(factor(tempInfo.delta > 0, tempInfo.delta, tempInfo.desc, 'temperature'))
  } else {
    add(factor(false, 0, tempInfo.desc, 'temperature'))
  }

  // ----- 10) Pressure trend (audit v2: new factor) -----------------------
  const pInfo = pressureDelta(ctx.species, ctx.pressureInHg, ctx.pressureTrendInHgPer3h)
  if (pInfo.delta !== 0) {
    add(factor(pInfo.delta > 0, pInfo.delta, pInfo.desc, 'pressure'))
  } else {
    add(factor(false, 0, pInfo.desc, 'pressure'))
  }

  // ----- 11) Frontal phase (audit v2.1: species-aware) -------------------
  const frInfo = frontalDelta(ctx.species, ctx.frontalPhase)
  if (frInfo.delta !== 0) {
    add(factor(frInfo.delta > 0, frInfo.delta, frInfo.desc, 'front'))
  } else {
    add(factor(false, 0, frInfo.desc, 'front'))
  }

  // ----- 12) Convergence (Step 12.5 v3 + Step 13.5 subtypes) -------------
  //
  // The unlock model: a unit needs ≥ 2 convergence tags of DIFFERENT types
  // ('point' / 'creek_mouth' / 'transition' / 'chokepoint' / 'confluence')
  // to clear driveby. Tags fire with delta 0 — they communicate "why this
  // score is allowed to climb", not "what's adding to it".
  //
  // Step 13.5 v2.1 + Step 13.6: CHOKEPOINTS AND DEPTH_BREAKS SELF-UNLOCK.
  // Both are inherently fishing convergences per the literature —
  // chokepoints stack flounder + run bull reds on tidal flows; depth
  // breaks (channel edges, drop-offs, holes) hold every inshore species
  // along the contour. The 2-different-types rule incorrectly gated these
  // out when they appear alone. Other subtypes still require the
  // 2-different-types rule to ensure "structure meets structure".
  const tagTypes = new Set(unit.convergence.map((t) => t.type))
  const hasSelfUnlocker = tagTypes.has('chokepoint') || tagTypes.has('depth_break')
  const hasMultiConvergence = tagTypes.size >= 2
  const isUnlocked = hasSelfUnlocker || hasMultiConvergence

  for (const tag of unit.convergence) {
    add(factor(true, 0, tag.description, 'convergence'))
  }

  if (!isUnlocked) {
    if (tagTypes.size === 0) {
      add(
        factor(
          false,
          0,
          'No structural feature here — needs at least 2 feature types to unlock',
          'convergence',
        ),
      )
    } else {
      const onlyType = Array.from(tagTypes)[0]
      const label =
        onlyType === 'point' ? 'point' :
        onlyType === 'creek_mouth' ? 'creek mouth' :
        onlyType === 'transition' ? 'habitat transition' :
        onlyType === 'chokepoint' ? 'chokepoint' :
        onlyType === 'depth_break' ? 'depth break' :
        'confluence'
      add(
        factor(
          false,
          0,
          `Only one feature type (${label} only) — needs a second type ` +
            `(e.g. point + transition, drainage mouth + chokepoint) to unlock`,
          'convergence',
        ),
      )
    }
  }

  // ----- Final tally ------------------------------------------------------
  // GATING RULE: either a chokepoint (self-unlocking) OR ≥ 2 DIFFERENT
  // convergence tag types unlock above driveby.
  let score = Math.max(0, Math.min(10, total))
  if (!isUnlocked) score = Math.min(score, 4.0)
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
