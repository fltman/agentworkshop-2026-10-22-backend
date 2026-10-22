# Contract: traffic data loader (team backend)

Serves prerecorded Stockholm weekday traffic as **demand** objects in exactly the format the simulation engine
(team martin) takes in `POST /t/martin/run`. Base URL: `/t/backend/`. All responses are JSON; errors are
`{"error": "..."}` with status 400 (bad input) or 404 (unknown id).

Conventions follow martin's contract: arms `N`/`E`/`S`/`W` are where traffic comes **from**, turns `L`/`S`/`R`,
classes `car`/`bus`/`truck`.

## GET /t/backend/intersections

```json
{"intersections":[{"id":"sveavagen-odengatan","name":"Sveavägen / Odengatan","lat":59.3431,"lon":18.056,
  "source":"Stockholm stad traffic counts (ADT, estimated)","estimated":true,"armIds":["N","E","S","W"]}]}
```

Current ids, equal to be-christian's design ids: `sveavagen-odengatan`, `valhallavagen-birgerjarlsgatan`,
`hornsgatan-langholmsgatan`, `fridhemsplan`, `roundabout-medium` and `priority-tjunction` (arms E/S/W only, no turns
towards the missing north arm). The two generic ones have `lat`/`lon` null and synthetic volumes.

## GET /t/backend/intersections/ID

Summary plus per arm `road` and `adtIn` (inbound vehicles per weekday), `vehPerHourByHour` (24 values per arm)
and `activeShareByHour` (pedestrian/bicycle share of peak, 24 values). Use it for time-of-day charts.

## GET /t/backend/demand

| param | default | range |
|---|---|---|
| `intersection` | required | an id from `/intersections` |
| `hour` | 8 | integer 0–23 (start hour of the recorded weekday) |
| `durationSec` | 900 | integer 60–7200 |
| `seed` | 42 | integer ≥ 0 |
| `scale` | 1 | 0–5, multiplies vehicle, pedestrian and bicycle volumes |

Example: `GET /t/backend/demand?intersection=sveavagen-odengatan&hour=17&durationSec=600&seed=7`

```json
{"durationSec":600,"seed":7,"arms":{
  "N":{"vehPerHour":702,"turning":{"L":0.15,"S":0.7,"R":0.15},"mix":{"car":0.84,"bus":0.06,"truck":0.1},"pedPerHour":900,"bikePerHour":350},
  "E":{"vehPerHour":468,"turning":{"L":0.2,"S":0.6,"R":0.2},"mix":{"car":0.82,"bus":0.09,"truck":0.09},"pedPerHour":800,"bikePerHour":250},
  "S":{"vehPerHour":741,"turning":{"L":0.15,"S":0.7,"R":0.15},"mix":{"car":0.84,"bus":0.06,"truck":0.1},"pedPerHour":1000,"bikePerHour":380},
  "W":{"vehPerHour":507,"turning":{"L":0.2,"S":0.6,"R":0.2},"mix":{"car":0.82,"bus":0.09,"truck":0.09},"pedPerHour":850,"bikePerHour":260}}}
```

Only the arms the intersection has are included. The body can be passed unchanged as `demand` to `POST /t/martin/run`. UIs that let users tweak volumes, turning
or mix should fetch this as the baseline and edit the copy; the same `seed` keeps comparisons identical.

## Data

Weekday volumes are estimated from Stockholm stad's published annual average daily traffic per street, spread over
the day with a typical urban weekday profile. Turning shares, vehicle mix and pedestrian/bicycle peaks are
assumptions, hence `"estimated": true`. Source data lives in `board/plugins/backend/intersections.json`.
