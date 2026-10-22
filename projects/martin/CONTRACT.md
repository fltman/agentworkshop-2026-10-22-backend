# Simulation engine contract (team martin)

Owner: **martin**. Base URL: `/t/martin/` on the group's Square. All bodies are JSON.
Changes are announced in `#build` before they ship.

The engine runs a **design** (the intersection) under a **demand** (the traffic) and returns
a summary of measurements, per-frame vehicle positions for animation, and an event log.
The same `demand` with the same `seed` gives identical arrivals for every design, which makes
designs comparable.

## Coordinates and conventions

- Metres. Origin at the centre of the intersection. `x` east, `y` north. Right-hand traffic.
- Arms are `N`, `E`, `S`, `W`. Arm `N` means traffic **coming from** the north.
- Movements: `L` (left), `S` (straight), `R` (right). A movement id is `"<arm>:<turn>"`, e.g. `"N:L"`
  means from the north arm, turning left (towards east).
- Pedestrian crossings are `"ped:<arm>"`, the crosswalk across that arm.
- Vehicle classes: `car`, `bus`, `truck`, `bike`.

## Design (input)

```json
{
  "id": "sveav-kungsg-signal",
  "name": "Example 4-arm signal",
  "origin": "existing",
  "type": "signal",
  "laneWidth": 3.5,
  "arms": [
    { "id": "N", "inLanes": [["L","S"],["S","R"]], "outLanes": 2, "speedLimit": 50, "length": 150,
      "crosswalk": true, "bikeLane": true }
  ],
  "bannedMovements": ["E:L"],
  "signal": {
    "phases": [
      { "green": 30, "amber": 3, "allRed": 2, "movements": ["N:L","N:S","N:R","S:L","S:S","S:R","ped:E","ped:W"] },
      { "green": 25, "amber": 3, "allRed": 2, "movements": ["E:S","E:R","W:L","W:S","W:R","ped:N","ped:S"] }
    ]
  },
  "roundabout": { "radius": 16 },
  "priority": { "major": ["N","S"] }
}
```

| field | meaning | default |
|---|---|---|
| `origin` | `"existing"` or `"user"`, passed through untouched | `"user"` |
| `type` | `"signal"`, `"roundabout"` or `"priority"` (give-way, no lights) | required |
| `arms[]` | 2 to 4 arms. Missing arms do not exist (T-junction etc.) | required |
| `arms[].inLanes` | one array per inbound lane, leftmost first, listing the allowed turns | 1 lane `[L,S,R]` |
| `arms[].outLanes` | number of outbound lanes | same as the number of inbound lanes |
| `arms[].speedLimit` | km/h | 50 |
| `arms[].bearingDeg` | optional real compass bearing of the arm, degrees clockwise from north, pointing away from the centre (v0.4). Must be within 60° of the label (N 0, E 90, S 180, W 270), arms at least 30° apart in clockwise N, E, S, W order. Geometry, crosswalks and frames follow it; turns still follow the labels (from N, L goes to E). Sharp angles push the stop lines out. Layout echoes `bearingDeg` and `angleDeg` = 90 - bearingDeg (math degrees, 0 = east, counter-clockwise, -180..180) | label's bearing |
| `arms[].length` | approach length modelled, metres | 150 |
| `arms[].crosswalk`, `bikeLane` | whether pedestrians / bikes exist on this arm | true / true |
| `bannedMovements` | movement ids that are not allowed; their demand is spread over the remaining turns | `[]` |
| `signal.phases[]` | used when `type` = `signal`. Seconds. If no `ped:*` is listed anywhere, crosswalks get green with the parallel straight movements | 2-phase N-S / E-W |
| `roundabout.radius` | used when `type` = `roundabout`. Centre-line radius of the ring, metres (8 to 40) | 15 |
| `roundabout.lanes` | circulating lanes, 1 or 2 (alias `circulatingLanes`). With 2, the leftmost entry lane of a multi-lane arm circulates on the inner lane (radius - laneWidth), the others on the outer lane; needs radius >= 12 | 1 |
| `priority.major` | used when `type` = `priority`. Arms on the major road; the others give way | `["N","S"]` |

Also accepted (the design module's shape): `arms` as a map `{ "N": {...} }`, `inLanes` as
`[{ "turns": ["L","S"] }]`, top-level `phases: [{ "durationSec": 30, "green": ["N:S", ...] }]` and top-level `radius`.

Fixed in v0.5: crossing straight-on movements did not see each other as conflicts, and some left turns missed the
opposing straight traffic. Priority junctions therefore let the minor road cross busy major roads freely, and signal
boxes did not clear between phases. Expect higher, more realistic delay at busy priority and signal junctions;
roundabouts are unchanged.

Fixed in v0.5.1: vehicles waiting inside a signal or priority box (for pedestrians or a crossing stream) had no
leader there and could stack on the same point. They now keep their spacing to the vehicle ahead on the same path or
heading for the same exit lane.

Known limits (v0.5): arms with `bearingDeg` far from 90° apart show somewhat more brief vehicle overlaps inside a signal box. the ring has at most 2 circulating lanes (`roundabout.lanes`, default 1). Inner-lane exits
cross the outer lane without a lane-change model. Unsignalised crosswalks are zebras with a refuge island: pedestrians cross each half separately. Left turns on a signal are permissive unless they have their own phase: they yield to
opposing straight and right traffic.

## Demand (input)

```json
{
  "durationSec": 900,
  "seed": 42,
  "arms": {
    "N": { "vehPerHour": 600, "turning": { "L": 0.2, "S": 0.6, "R": 0.2 },
           "mix": { "car": 0.85, "bus": 0.05, "truck": 0.1 },
           "pedPerHour": 120, "bikePerHour": 60 }
  }
}
```

`durationSec` is 60 to 7200. Arms in the demand that the design lacks are ignored. Turning and mix
are normalised, so they do not have to sum to exactly 1.

Optional `schedule` (v0.3, matches backend `varying=1`): `[{ "atSec": 3600, "arms": { ... } }, ...]`, at most 48
steps, `atSec` increasing. From each `atSec` the step's arms (same shape as `arms`) replace the rates, turning and
mix; top-level `arms` apply before the first step, and a step at 0 replaces them. Other keys in a step (such as
`hour`) are ignored. Arrivals before a step are identical to a run without the schedule.

## Endpoints

| method | path | body / query | answer |
|---|---|---|---|
| GET | `/t/martin/health` | | `{ ok, version }` |
| GET | `/t/martin/examples` | | `{ designs: [...], demand }` examples ready to POST |
| POST | `/t/martin/run` | `{ design, demand, options? }` | `{ runId, design, demand, summary, warnings, layout, frameCount, eventCount }`. `design` and `demand` echo the input (defaults for `origin`, `durationSec`, `seed` filled in) |
| GET | `/t/martin/runs` | | the last runs, newest first: `[{ runId, designId, name, origin, createdAt, summary }]` |
| GET | `/t/martin/runs/<runId>` | | same as the POST /run answer |
| GET | `/t/martin/runs/<runId>/frames` | `?from=<sec>&to=<sec>` | `{ frames: [...] }` (max 600 frames per call) |
| GET | `/t/martin/runs/<runId>/events` | `?type=<type>&from=<sec>&to=<sec>` | `{ events: [...] }` |
| POST | `/t/martin/compare` | `{ designs: [d1, d2, ...], demand }` | `{ demand, results: [{ runId, design, summary }] }` |

`options`: `{ "frameEverySec": 1, "dt": 0.5 }`. Runs are kept in memory (the last 40). Stored frames are capped at about 1800 per run: runs longer than 1800 s get frameEverySec of at least ceil(durationSec / 1800).
`warnings` lists things in the input that the engine had to work around, e.g.
`"E:L never gets green in any phase; vehicles will wait forever"` or `"N:L is banned; its demand is spread over the other turns"`.
Errors: HTTP 400 `{ "error": "invalid input", "details": ["arms[0].id must be N, E, S or W"] }`.

## Summary (output)

```json
{
  "durationSec": 900,
  "vehicles": { "generated": 512, "exited": 489, "inNetwork": 21, "backlog": 2 },
  "throughputVehPerHour": 1956,
  "delay": { "meanSec": 18.4, "p95Sec": 52.1, "exitedMeanSec": 16.9, "unservedShare": 0.04,
             "perArm": { "N": { "meanSec": 15.2, "count": 130 } },
             "perMovement": { "N:L": { "meanSec": 24.0, "count": 26 } } },
  "queue": { "perArm": { "N": { "maxVeh": 9, "meanVeh": 2.7, "maxMeters": 61 } } },
  "stops": { "stoppedVehicles": 301, "stoppedShare": 0.62, "meanStopsPerVehicle": 0.81 },
  "emissions": { "co2Kg": 61.2, "co2GPerVehicle": 125, "note": "rough estimate" },
  "pedestrians": { "generated": 120, "crossed": 117, "meanWaitSec": 21.3 },
  "bikes": { "generated": 60, "exited": 58, "meanDelaySec": 12.0 }
}
```

- **delay**: actual travel time minus free-flow travel time, bikes excluded (v0.5). `meanSec`, `p95Sec`, `perArm` and
  `perMovement` count every vehicle that arrived: vehicles still inside or still waiting to enter at the end carry
  the delay they have had so far (waiting vehicles count per arm only). This keeps a blocked approach from looking fast.
  `exitedMeanSec` is the old number (exited vehicles only). `unservedShare` is the share of arrived vehicles that did
  not get out; above about 0.1 the design is oversaturated and a longer run would show even more delay.
- **queue**: vehicles slower than 2 m/s lined up behind the stop line, plus vehicles waiting to enter the model.
- **stops**: a vehicle is stopped when its speed drops below 0.5 m/s.
- **emissions**: CO2 from a simple per-class model (idle + distance + acceleration). Good for comparing designs, not absolute truth.

## Layout (output, for drawing)

```json
{
  "type": "signal", "laneWidth": 3.5, "stopDist": 14,
  "arms": [{ "id": "N", "angleDeg": 90, "bearingDeg": 0, "inLanes": 2, "inLaneTurns": [["L","S"],["S","R"]], "outLanes": 2,
             "length": 150, "crosswalk": true, "bikeLane": true }],
  "roundabout": null,      // roundabouts: { "radius": 20, "lanes": 2 }
  "signal": { "phases": [{ "green": 30, "amber": 3, "allRed": 2, "movements": ["N:L", "..."] }] },
  "crosswalks": [{ "arm": "N", "x1": -7, "y1": 11.5, "x2": 7, "y2": 11.5 }],
  "paths": { "N:L:0": [[-1.75, 164], [-1.75, 14], [3.1, 2.1], [14, 1.75], [114, 1.75]] }
}
```

`paths` has one polyline per movement and lane (`"<arm>:<turn>:<lane>"`, `"<arm>:<turn>:bike"` for bikes).

## Frame (output)

```json
{ "t": 12, "v": [[17, "car", -1.75, 40.2, 270, 8.3]], "p": [[3, -6.1, 11.5]], "q": { "N": 4, "E": 0 }, "sig": { "N:L": "G", "ped:E": "R" } }
```

- `v`: vehicles `[id, class, x, y, headingDeg, speed m/s]`. Heading in degrees, 0 = east, 90 = north.
- `p`: pedestrians `[id, x, y]`.
- `q`: queued vehicles per arm right now (same definition as `summary.queue`).
- `sig`: state per movement, `G`, `A` (amber) or `R`. Only for signals.

## Event (output)

```json
{ "t": 31.5, "type": "exit", "id": 17, "cls": "car", "arm": "N", "movement": "N:L", "delaySec": 12.4, "stops": 1, "co2G": 98 }
```

Types: `arrive` (scheduled arrival, may wait to enter), `enter`, `stop`, `exit` (with `delaySec`, `stops`, `co2G`),
`ped_arrive`, `ped_start`, `ped_done` (with `waitSec`).

## Example

```bash
curl -s $BOARD/t/martin/examples > ex.json
curl -s -X POST $BOARD/t/martin/run -H 'content-type: application/json' \
  -d '{"design": <a design from ex.json>, "demand": <the demand from ex.json>}'
```
