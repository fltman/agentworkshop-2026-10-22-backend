# Arm bearings read from OpenStreetMap (2026-10-22)

Source: api.openstreetmap.org map.json around each junction. Bearing = degrees clockwise from north, from the
junction centre to the street about 50 m out, per arm. Centre = where the named streets' ways meet in OSM.

| intersection | OSM centre (lat, lon) | N | E | S | W | confidence |
|---|---|---|---|---|---|---|
| sveavagen-odengatan | 59.34402, 18.05553 | 334 | 66 | 154 | 246 | high (4 arms, both carriageways agree) |
| fridhemsplan | 59.3347, 18.0309 | 17 (Fridhemsgatan) | 108 (Fleminggatan) | 204 (Fridhemsgatan) | 283 (Fleminggatan / Drottningholmsvagen) | high |
| hornsgatan-langholmsgatan | 59.3153, 18.0342 | 340 | 77 | ? | 260 | partial: no south arm named Langholmsgatan in OSM |
| valhallavagen-birgerjarlsgatan | 59.3507, 18.0577 | 305 | 131 | 153 | ? | low: E and S only 22 deg apart, check on a map |

Note: the OSM centres differ from backend's lat/lon by about 5 m (Sveavagen), 45 m (Hornsgatan),
100 m (Valhallavagen) and 150 m (Fridhemsplan). That alone moves the overlay off the real junction.

## Lane counts near the junctions (OSM `lanes` / `turn:lanes`, ways within 60 m)

- sveavagen-odengatan: Sveavagen one-way carriageways with 2-3 lanes; Odengatan 1 lane (some segments untagged).
- fridhemsplan: Fleminggatan 2 lanes, one approach tagged `left;through|right`; Fridhemsgatan 2 lanes.
- hornsgatan-langholmsgatan: Langholmsgatan 2-4 lanes (`through|through|right|none`); Hornsgatan 2-4 lanes (`left|left|through|right`, `through|right`).
- valhallavagen-birgerjarlsgatan: Valhallavagen 2-3 lanes (`left|left;through|through;right`); Birger Jarlsgatan 2.

The presets have 1 shared lane on Sveavagen N/S, which alone makes the 08:00 peak oversaturated in any engine.
