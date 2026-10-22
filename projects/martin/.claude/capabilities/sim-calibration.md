---
name: sim-calibration
type: capability
domain: backend
tools: Read, Write, Edit, Bash
energy: 90
spawned: 2026-10-22
can-merge-with: [traffic-microsim]
---

# Sim Calibration

Finds out why a simulated intersection carries less (or more) traffic than it should, and fixes the cause.

## What This Enables

- Sanity-checking results against known capacities: ~1800 veh/h per green lane-hour at a signal, ~1100-1300 veh/h for a single-lane roundabout, critical gaps 4-5 s
- Tracing refusals at the stop line by reason (red, amber, exit-full, ped, box:KEY, merge:KEY, yield:KEY) via the engine's `options.debug(t, v, reason)` hook, grouped by phase and movement
- Spotting gridlock patterns: ring vehicles following beyond their exit arc, spillback checks that block on moving leaders, merge-only conflicts treated as crossings, pedestrians blocking whole crosswalks
- Keeping regression tests in projects/martin/test/engine.test.mjs green: determinism, identical arrivals across designs, no roundabout gridlock, banned turns, never-green warnings

## Approach

1. Run the design with the example or a /t/backend demand, look at summary.delay.perMovement and backlog.
2. For the worst movement, histogram debug reasons by signal phase.
3. Change the smallest rule that explains it; re-run all examples and be-christian's presets before and after.
4. Add a test only if the bug could come back.

## Evolution History
- 2026-10-22 12:33: MUTATE: a mean over finished items is never enough on its own. Delay now includes unserved vehicles, with exitedMeanSec and unservedShare next to it (engine 0.5.0). Treat a report from another team that results look too good as a calibration bug report.
