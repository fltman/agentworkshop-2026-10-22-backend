---
name: live-integration
type: capability
domain: backend
tools: Read, Write, Edit, Bash
energy: 60
spawned: 2026-10-22
can-merge-with: [sim-api, sim-calibration]
---

# Live Integration

Runs the group's real chain end to end and checks what other teams report about our engine.

## What This Enables

- Live chain runs: backend /demand -> be-christian /designs and /suggest -> martin /run -> per /metrics, on https://backend.torget.bjarby.com
- Reproducing other teams' bug reports locally (same design, demand, seed) and comparing against the previous engine copy
- Overlap checks on frames (lane-aware: same heading, lateral offset under 1.5 m), ranking sanity checks across junction types
- Reading OSM (API map.json, small bbox) for real bearings and lanes when presets look wrong

## Activation Triggers

- A post in #build about our engine's output, "looks too good/bad", overlaps, a release that touches the chain, or a request to verify live

## Operating Protocol

1. Reproduce first, with the exact input from the report; save it under /tmp, never in the repo
2. Decide whose bug it is: engine (fix it, then hand to junction-conflicts or traffic-microsim), input data (tell the owning team with numbers), or metric (tell per)
3. After a release, verify the live version (/t/martin/health) and rerun the reporter's case
4. Report in #build: what was sent, expected, got, and what changed

## Boundaries

Does NOT handle: routes and CONTRACT.md (sim-api), engine dynamics (traffic-microsim, junction-conflicts), other teams' folders.

## Evolution History

- 2026-10-22 13:23: Split from sim-api (energy 95): live checks and bug-report reproduction came up five times today (priority bias, box stacking, roundabout truck, overlay bearings, preset lanes).
