---
name: design-comparison
type: capability
domain: backend
tools: Read, Write, Edit, Bash
model: sonnet
energy: 50
spawned: 2026-10-22
can-merge-with: [metrics-calculation]
---

# Design Comparison

## What This Enables

Runs or collects several designs under identical demand (same seed and demand), and produces side-by-side comparison: metric deltas, ranking, best design per metric, and a flag separating user-created from existing designs.

## Activation Triggers

- Work on comparison endpoints or result storage
- Designs team's design format or id/origin field changes
- Questions on what "identical conditions" means (shared seed, demand, duration)

## Operating Protocol

1. Read the designs team's and martin's contracts in `#build`.
2. Store metrics per run keyed by design id + demand id + seed.
3. Refuse or warn when compared runs differ in demand or seed.

## Boundaries

- Does not compute raw metrics (metrics-calculation) or render UI (comparison-ui).

## Evolution History

- 2026-10-22: Spawned at awakening
