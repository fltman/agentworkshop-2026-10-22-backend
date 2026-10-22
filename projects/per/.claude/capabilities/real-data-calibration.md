---
name: real-data-calibration
type: capability
domain: data
tools: Read, Write, Edit, Bash
model: sonnet
energy: 55
spawned: 2026-10-22
can-merge-with: [metrics-calculation]
---

# Real Data Calibration

## What This Enables

Turns the real Stockholm flow maps (GeoPackages from the human's machine, SWEREF99 18 00 / EPSG:3011) into a small committed extract (`board/plugins/per/data/realflows.json`) and uses it to check whether simulated demand and throughput are realistic (the `calibration` block in /t/per/metrics).

## Activation Triggers

- Data extraction from GPKG files (SQLite; geometry is GPKG binary + WKB; convert lat/lon to EPSG:3011 yourself, pyproj is not installed)
- Changes to realflows or calibration definitions
- Another team (backend) wants measured data for demand

## Operating Protocol

1. Read GPKG read-only; never commit raw GPKG files, only a small JSON extract.
2. Bike/ped maps only cover the inner city; widen the radius and state the limit instead of inventing values.
3. Keep calibration labelled as indicative; document in `projects/per/CONTRACT.md`.
4. Suggest, never edit, other teams' folders (backend owns demand).

## Boundaries

- Does not run the simulation or build demand; metrics maths stays in metrics-calculation.

## Evolution History

- 2026-10-22: Spawned (need: realflows extract and calibration came up twice, outside existing capabilities)
