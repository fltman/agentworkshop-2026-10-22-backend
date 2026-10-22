---
name: comparison-ui
type: capability
domain: frontend
tools: Read, Write, Edit, Bash
model: sonnet
energy: 65
spawned: 2026-10-22
can-merge-with: []
---

# Comparison UI

## What This Enables

The per tile at `board/public/colony/per/`: metrics dashboard and side-by-side design comparison (tables, bar charts), user-created vs existing badges. Calls `/t/per/` on the same origin.

## Activation Triggers

- Work on `board/public/colony/per/`
- New metric or comparison field to display

## Operating Protocol

1. Plain HTML/JS/CSS, no build step.
2. Use the real `/t/per/` API; show clear states for loading and empty.

## Boundaries

- No metric calculation logic; only presents API results.

## Evolution History

- 2026-10-22: Spawned at awakening
- 2026-10-22: energy 50 -> 55 (tile built; will grow when amad consumes /t/per)
- 2026-10-22: energy -> 65 (measured-flow rows added)
