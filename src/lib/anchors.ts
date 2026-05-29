/**
 * Named anchors — verified structural features from the handoff doc's
 * "Verified Data Inventory" section.
 *
 * These are NOT scoring units. They're identity pins on the map. Each entry
 * is a place a real angler would name and recognize: a built reef, a known
 * restoration site, a fishing pier. Tapping the pin opens a popup with
 * facts (depth, materials, year built) — no fishing-conditions score.
 *
 * Coordinates come straight from the handoff doc, which sourced them from
 * Alabama Marine Resources Division side-scan sonar imagery and NOAA / FDEP
 * project anchors.
 */

export type AnchorType =
  | 'amrd_reef'        // Alabama Marine Resources Division built reef
  | 'restoration'      // NOAA / FDEP restoration site
  | 'living_shoreline' // built living shoreline
  | 'park_reef'        // park-managed nearshore structures
  | 'launch'           // public launch point

export type NamedAnchor = {
  id: string
  name: string
  lat: number
  lon: number
  type: AnchorType
  depthFt?: number
  acres?: number
  material?: string
  yearBuilt?: number
  notes?: string
}

/**
 * Source: handoff doc's "Verified Data Inventory" section.
 * Updates here should keep that section in sync.
 */
export const NAMED_ANCHORS: NamedAnchor[] = [
  // ---- 4 AMRD Perdido Bay reefs (verified via Alabama ArcGIS + watermeat.com)
  {
    id: 'amrd:rockpile',
    name: 'Rockpile Reef',
    lat: 30.333517, lon: -87.498533,
    type: 'amrd_reef',
    acres: 14.1, depthFt: 9, yearBuilt: 2011,
    material: 'Long line of limestone rock along N boundary',
  },
  {
    id: 'amrd:ross-point',
    name: 'Ross Point Reef',
    lat: 30.323933, lon: -87.511133,
    type: 'amrd_reef',
    acres: 4.4, depthFt: 13, yearBuilt: 2005,
    material: 'Concrete bridge rubble, pilings, bridge spans',
  },
  {
    id: 'amrd:ono-island',
    name: 'Ono Island Reef',
    lat: 30.302783, lon: -87.490067,
    type: 'amrd_reef',
    acres: 9.3, depthFt: 11, yearBuilt: 2005,
    material: 'Rock rubble, red-clay bricks, concrete pilings',
  },
  {
    id: 'amrd:bayou-st-john',
    name: 'Bayou St John Reef',
    lat: 30.292683, lon: -87.532667,
    type: 'amrd_reef',
    acres: 5.3, depthFt: 11, yearBuilt: 2005,
    material: 'Rock rubble and concrete pilings',
  },

  // ---- Pensacola Bay system restoration / structure anchors
  {
    id: 'fl:greenshores-2',
    name: 'Project GreenShores Site II',
    lat: 30.4132, lon: -87.2007,
    type: 'restoration',
    notes:
      '4 acres oyster reef + 9 acres salt marsh (urban Pensacola, NOAA Project ID 26)',
  },
  {
    id: 'fl:garcon-pt',
    name: 'Garcon Point peninsula',
    lat: 30.5833, lon: -87.0580,
    type: 'restoration',
    notes:
      '866 intertidal reefs between Garcon and White Points (FDEP). Mostly private access.',
  },
  {
    id: 'fl:escribano-pt-wma',
    name: 'Escribano Point WMA',
    lat: 30.5103, lon: -86.9933,
    type: 'restoration',
    notes:
      'Anchor for TNC 33-reef corridor along 6.5 mi of E shore of East and Blackwater Bays. ~4 ft water, 200–500 ft offshore.',
  },
  {
    id: 'fl:navy-pt-park',
    name: 'Navy Point Park reefs',
    lat: 30.3817, lon: -87.2834,
    type: 'park_reef',
    notes: '87 structures (struggling/eroding per recent reports)',
  },
  {
    id: 'fl:white-island',
    name: 'White Island living shoreline',
    lat: 30.3765, lon: -87.2687,
    type: 'living_shoreline',
    notes: 'Bayou Grande mouth',
  },
  {
    id: 'fl:naval-live-oaks',
    name: 'Naval Live Oaks Fishing Trail',
    lat: 30.37, lon: -87.13,
    type: 'park_reef',
    notes: 'Santa Rosa Sound kayak access',
  },

  // ---- Verified launch points (so they're discoverable on the map)
  {
    id: 'launch:big-lagoon-sp',
    name: 'Big Lagoon State Park',
    lat: 30.3098, lon: -87.4029,
    type: 'launch',
    notes: 'Boat ramp + kayak launch',
  },
  {
    id: 'launch:johnson-beach',
    name: 'Johnson Beach Boat Launch (NPS)',
    lat: 30.3027, lon: -87.4148,
    type: 'launch',
  },
  {
    id: 'launch:galvez',
    name: 'Galvez Landing (24-hr)',
    lat: 30.3138, lon: -87.4420,
    type: 'launch',
  },
]
