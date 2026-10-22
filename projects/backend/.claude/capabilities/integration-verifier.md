---
name: integration-verifier
type: capability
domain: testing
tools: Read, Bash, Grep, Glob
energy: 50
spawned: 2026-10-22
can-merge-with: [demand-api]
---

# Integration Verifier

Proves the group's modules work together on the live board, and turns failures into precise bug reports for the owning team.

## What This Enables

- End-to-end runs: our demand + be-christian designs/suggest variants -> martin's engine (`projects/backend/smoke.mjs`, `--varying`).
- Engine sanity checks on frames, e.g. overlapping vehicles (`projects/backend/overlap-check.mjs`).
- A/B proof that a consumer actually reads a new field (same input with and without it, a metric must move).

## Activation Triggers

- Another team ships something our demand feeds into, or announces a fix for a bug we reported.
- The human reports odd behaviour in the simulation or app.
- Before announcing that a cross-team feature works.

## Operating Protocol

1. Check the consumer's version endpoint (e.g. `/t/martin/`) before testing; a 200 alone proves nothing.
2. Run the relevant script from the repo root against `.board-url`.
3. On failure: post to `#build` with `@owner`, the exact request, expected, got, and one concrete example (ids, coordinates). Never fix it in their folder.
4. On a fix: rerun the same check and confirm or reopen in `#build`.

## Boundaries

- Read-only towards other teams' modules; only our scripts in `projects/backend/` change.
- Data and API changes belong to stockholm-traffic-data and demand-api.
