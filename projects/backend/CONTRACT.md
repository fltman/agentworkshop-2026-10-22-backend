# Contract: traffic data loader (team backend)

Serves prerecorded Stockholm weekday and weekend traffic as **demand** objects in exactly the format the simulation engine
(team martin) takes in `POST /t/martin/run`. Base URL: `/t/backend/`. All responses are JSON; errors are
`{"error": "..."}` with status 400 (bad input) or 404 (unknown id).

Conventions follow martin's contract: arms `N`/`E`/`S`/`W` are where traffic comes **from**, turns `L`/`S`/`R`,
classes `car`/`bus`/`truck`.

## GET /t/backend/intersections

```json
{"intersections":[{"id":"sveavagen-odengatan","name":"Sveavägen / Odengatan","lat":59.344,"lon":18.0556,
  "source":"Stockholm stad / NVDB open flow maps via /t/per/realflows (4 of 4 arms measured)","estimated":false,"armIds":["N","E","S","W"]}]}
```

Current ids, equal to be-christian's design ids: `sveavagen-odengatan`, `valhallavagen-birgerjarlsgatan`,
`hornsgatan-langholmsgatan`, `fridhemsplan`, `roundabout-medium` and `priority-tjunction` (arms E/S/W only, no turns
towards the missing north arm). The two generic ones have `lat`/`lon` null and synthetic volumes.

## GET /t/backend/intersections/ID

Summary plus `days` (`weekday`, `saturday`, `sunday`), per arm `road`, `adtIn` (inbound vehicles per weekday),
`source` (`measured` or `estimated`) and for measured arms `measured` {street, distM, adtAllDirections, heavyShare},
`vehPerHourByHour[arm][day]` (24 values) and `activeShareByHour[day]` (pedestrian/bicycle share of peak, 24 values).
Use it for time-of-day charts.

## GET /t/backend/demand

| param | default | range |
|---|---|---|
| `intersection` | required | an id from `/intersections` |
| `day` | `weekday` | `weekday`, `saturday` or `sunday` |
| `hour` | 8 | integer 0–23 (start hour) |
| `durationSec` | 900 | integer 60–7200 |
| `seed` | 42 | integer ≥ 0 |
| `scale` | 1 | 0–5, multiplies vehicle, pedestrian and bicycle volumes |
| `varying` | `0` | `1`/`true` adds `schedule` (see below) |

Example: `GET /t/backend/demand?intersection=sveavagen-odengatan&hour=17&durationSec=600&seed=7`

```json
{"durationSec":600,"seed":7,"arms":{
  "N":{"vehPerHour":702,"turning":{"L":0.15,"S":0.7,"R":0.15},"mix":{"car":0.84,"bus":0.06,"truck":0.1},"pedPerHour":900,"bikePerHour":350},
  "E":{"vehPerHour":468,"turning":{"L":0.2,"S":0.6,"R":0.2},"mix":{"car":0.82,"bus":0.09,"truck":0.09},"pedPerHour":800,"bikePerHour":250},
  "S":{"vehPerHour":741,"turning":{"L":0.15,"S":0.7,"R":0.15},"mix":{"car":0.84,"bus":0.06,"truck":0.1},"pedPerHour":1000,"bikePerHour":380},
  "W":{"vehPerHour":507,"turning":{"L":0.2,"S":0.6,"R":0.2},"mix":{"car":0.82,"bus":0.09,"truck":0.09},"pedPerHour":850,"bikePerHour":260}}}
```

Only the arms the intersection has are included. The body can be passed unchanged as `demand` to `POST /t/martin/run`.
UIs that let users tweak volumes, turning or mix can use the POST below; the same `seed` keeps comparisons identical.

### Time-varying demand (`varying=1`)

For runs longer than an hour. The top-level `arms` stay the first hour, so engines that ignore `schedule` work
unchanged. `schedule` has one step per started hour of `durationSec`, wrapping past midnight within the same `day`:

```json
{"durationSec":7200,"seed":42,"arms":{...},
 "schedule":[{"atSec":0,"hour":7,"arms":{...}},{"atSec":3600,"hour":8,"arms":{...}}]}
```

## POST /t/backend/demand

Same parameters as a JSON body (`varying` as a boolean), plus optional `overrides` per arm, applied to the top-level
arms and to every `schedule` step, for UIs where users change volume, turning, mix
or pedestrian/bicycle demand. Every field is optional. `turning` and `mix` are normalised to sum to 1, and keys that
are left out become 0. The answer has the same demand shape as the GET.

```json
{"intersection":"priority-tjunction","day":"saturday","hour":12,"seed":42,
 "overrides":{"E":{"vehPerHour":900,"turning":{"L":1,"S":3},"mix":{"car":9,"truck":1}}}}
```

| override field | range |
|---|---|
| `vehPerHour` | integer 0–5000 |
| `pedPerHour`, `bikePerHour` | integer 0–10000 |
| `turning` | `{L,S,R}`, non-negative, at least one positive |
| `mix` | `{car,bus,truck}`, non-negative, at least one positive |

Overriding an arm the intersection lacks, or an unknown field, gives 400.

## Data

Weekday arm volumes and heavy-vehicle shares are measured: Stockholm stad / NVDB open traffic flow maps via per's
`/t/per/realflows`, busiest segment of the arm's street within 60 m (side roads under 1000/day ignored), ADT all
directions halved to inbound. Exceptions: Fridhemsplan E (Fleminggatan, no segment in the extract) and the two generic
junctions stay estimated. Re-run with `node projects/backend/calibrate.mjs`. The daily profile, weekend shares (75 %
and 62 % of weekday), turning shares and pedestrian/bicycle peaks are assumptions; `"estimated": true` means at least
one arm volume is. Coordinates of the four real junctions are checked against OpenStreetMap. Source data lives in `board/plugins/backend/intersections.json`.
