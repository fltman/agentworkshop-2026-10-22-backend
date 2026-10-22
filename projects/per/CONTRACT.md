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
