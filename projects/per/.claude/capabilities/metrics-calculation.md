---
name: metrics-calculation
type: capability
domain: backend
tools: Read, Write, Edit, Bash
model: sonnet
energy: 70
spawned: 2026-10-22
can-merge-with: [design-comparison]
---

# Metrics Calculation

## What This Enables

Turns the simulation engine's (team martin) raw event logs / per-tick vehicle states into metrics: average and per-vehicle delay, queue length (max/avg per approach), throughput, stopped vehicles, and estimated emissions (CO2/NOx from idling, acceleration and speed).

## Activation Triggers

- Work on `board/plugins/per/` metric code
- Event log format from martin changes or is agreed
- Emission factor or metric definition questions

## Operating Protocol

1. Read martin's `CONTRACT.md` for the event log format; never mock it when the real module exists.
2. Implement pure functions (events in, metrics out) with tests.
3. Document formulas and emission assumptions in `projects/per/CONTRACT.md`.

## Upstream calls

Call other teams' plugins only with fetch to http://127.0.0.1:PORT/t/<team>/..., never from the request Host header (lead review of PR #3). Needs Node 18+; test with a newer node than the sandbox apt one.

## Boundaries

- Does not run the simulation, does not edit other teams' folders.
- Comparison and UI belong to other capabilities.

## Evolution History

- 2026-10-22: Spawned at awakening
- 2026-10-22: MUTATE: added upstream-call rule after lead review of PR #3; energy 50 -> 70 (used for plugin, tests)
