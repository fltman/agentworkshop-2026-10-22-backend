# per: Metrics & Comparison (draft)

Served at `/t/per/`. Input is martin's `/t/martin/runs/RUNID/events` (see projects/martin/CONTRACT.md).

## POST /t/per/metrics
Body: `{"runId":"abc"}`
Response:
```json
{"runId":"abc","design":{"id":"d1","name":"Sveavägen","origin":"existing"},
 "durationSec":900,
 "delay":{"avgSec":12.4,"p95Sec":31.0,"totalSec":4100},
 "queue":{"maxByArm":{"N":9,"E":4,"S":7,"W":3},"avgByArm":{"N":3.1,"E":1.2,"S":2.4,"W":0.8}},
 "throughput":{"vehicles":331,"perHour":1324},
 "stopped":{"vehicles":120,"avgStopsPerVeh":0.8},
 "pedestrians":{"avgWaitSec":14.2},
 "emissions":{"co2G":29100,"co2GPerVeh":88}}
```
Metrics are per run and cached by runId.

## POST /t/per/compare
Body: `{"runIds":["abc","def"]}` (or `{"designs":[...],"demand":{...}}`; we then call POST /t/martin/compare).
Rejects with 400 if the runs have different demand or seed.
Response: `{"demand":{...},"runs":[<metrics>...],"best":{"delay":"abc","queue":"def","throughput":"abc","stopped":"def","emissions":"abc"},"ranking":["abc","def"]}`
Each run keeps `design.origin` (existing|user).

## GET /t/per/runs
List of metrics computed so far.

Definitions: delay = delaySec on exit events; throughput = exit count; stopped = vehicles with stops > 0; queue from `q` in frames; emissions = sum of co2G.

## GET /t/per/realflows?intersection=ID
Measured Stockholm flows near a junction, extracted from the open GPKG flow maps (motor within 150 m, bike/ped within 400 m). Without `intersection`: the list of available ids. Fields: `motor[]` {street, distM, adtAllDirections, heavyShare, veh06_18, veh18_22, veh22_06}, `bike[]`/`ped[]` {street, distM, weekdayFlow, year}. Ids match /t/backend/intersections (4 of the 6 have data; bike/ped only cover the inner city). Use it to replace estimated demand or to sanity-check simulated throughput.

## calibration (in POST /t/per/metrics and each run in /compare)
When the run's design id has measured flows (see realflows), the metrics carry `calibration`: `observedInboundVehPerHour` (busiest segment per street within 60 m, 06-18 average), `demandVehPerHour` (sum of arm demand), `simulatedThroughputPerHour`, and the ratios `demandVsObserved` and `throughputVsObserved` (about 1 means realistic). Otherwise `calibration` is null. Indicative only.

## Delay fields (changed for engine 0.5)
`delay.avgSec` stays the mean over EXITED vehicles. New: `delay.meanSec` = mean delay including unserved vehicles (martin summary.delay.meanSec, falls back to avgSec on older runs), `delay.unservedShare`, and `vehicles` {generated, exited, inNetwork, backlog}. `best.delay` and `ranking` now use `meanSec`, so a design that leaves traffic unserved no longer wins on delay.
