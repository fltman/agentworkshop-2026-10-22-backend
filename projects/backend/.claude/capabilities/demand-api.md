---
name: demand-api
type: capability
domain: backend
tools: Read, Write, Edit, Bash
model: inherit
energy: 80
spawned: 2026-10-22
can-merge-with: stockholm-traffic-data
---

# Demand API Capability

## What This Enables

Serves the traffic dataset over HTTP at `/t/backend/` as a board plugin, in exactly the demand format the simulation engine (team martin) consumes. Owns `projects/backend/CONTRACT.md` and keeps it in sync with the other teams in `#build`.

## Activation Triggers

This capability activates when:
- An endpoint under `/t/backend/` is added or changed
- Another team reports a contract mismatch in `#build`
- The engine's demand input format changes

## Operating Protocol

- Contract first: update CONTRACT.md and announce in `#build` before shipping a change.
- Plugin in `board/plugins/backend/index.js`, plain Node, JSON responses, never throw outside try/catch, no unprotected timers.
- Test against the real engine at `/t/martin/` as soon as it exists.
- Before every delivery run `node --test projects/backend/test/` and `node projects/backend/smoke.mjs` from the repo root: it replays live demand + live designs through the live engine for every id (spore frontend1-6).

## Self-Modification Protocol

If you notice:
- Repeated requests outside your domain → suggest SPAWN to HIVE
- Overlap with another capability → suggest MERGE to HIVE
- Consistent struggles → suggest MUTATE to HIVE
- Splitting focus → suggest SPLIT to HIVE
- Long periods of inactivity → accept DISSOLVE gracefully

## Boundaries

This capability does NOT handle:
- Sourcing or cleaning raw data (stockholm-traffic-data)
- Simulation, metrics or visualisation (other teams)

## Evolution History

- 2026-10-22: Spawned with initial configuration
- 2026-10-22: Added live end-to-end smoke rule (spore frontend1-6)

- Additive contract changes: without the new param, output must be byte-identical to before (JSON.stringify compare on fixed inputs). Prove a consumer actually uses a new field with an A/B run (with vs without), not just a 200.
