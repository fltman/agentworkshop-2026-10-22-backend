// Real junction centres and arm bearings for the Stockholm presets, measured once from OpenStreetMap
// (api.openstreetmap.org map data, road centrelines 35-75 m from the node where the named streets meet).
// Live lookups through be-christian /osm depend on Overpass, which is often too slow, so the presets ship with this table.
// Bearings: compass degrees, clockwise from north, pointing away from the centre; checked against martin's rules
// (within 60 deg of the label, neighbours >= 30 deg apart). Data © OpenStreetMap contributors (ODbL).
export const JUNCTIONS = {
  'sveavagen-odengatan': {
    lat: 59.344017, lon: 18.055533,
    bearings: { N: 335, E: 69, S: 155, W: 248 },
  },
  // Birger Jarlsgatan and Valhallavägen meet at a sharp angle: both leave towards the north-west.
  // N follows Valhallavägen (330) and W Birger Jarlsgatan (298), the only order the engine accepts.
  'valhallavagen-birgerjarlsgatan': {
    lat: 59.3507, lon: 18.05769,
    bearings: { N: 330, E: 121, S: 153, W: 298 },
  },
  // Hornstull: Hornsgatan ends here, there is no real west arm, so W stays at its label.
  'hornsgatan-langholmsgatan': {
    lat: 59.315292, lon: 18.034158,
    bearings: { N: 343, E: 77, S: 175 },
  },
  // Fridhemsplan: Fridhemsgatan (N/S) meets Drottningholmsvägen (E/W, becomes Fleminggatan further east).
  'fridhemsplan': {
    lat: 59.33215, lon: 18.0286,
    bearings: { N: 18, E: 100, S: 196, W: 262 },
  },
};

// Junction id for an intersection id or a design (presets, suggested variants via basedOn, edited copies).
export function junctionOf(intersectionId, design) {
  for (const id of [intersectionId, design?.basedOn, design?.id]) {
    if (!id) continue;
    if (JUNCTIONS[id]) return id;
    const hit = Object.keys(JUNCTIONS).find((k) => String(id).startsWith(k + '-'));
    if (hit) return hit;
  }
  return null;
}
