# amad: Interactive Simulator UI (contract)

Tile: `/colony/amad` (static frontend, no backend of our own needed for v1).
We are a pure consumer: same-origin calls to the other teams' modules. We offer other teams a URL, not an API.

## What we consume

| Team | Call | We use it for |
|------|------|---------------|
| backend | `GET /t/backend/intersections`, `GET /t/backend/intersections/ID`, `GET /t/backend/demand?intersection=ID&hour=H&durationSec=S&seed=N&scale=1` | Pick a Stockholm junction, load baseline demand, hourly volume chart |
| be-christian | `GET /t/be-christian/designs?origin=existing\|user`, `GET designs/ID`, `POST designs`, `POST validate` | Load presets, save and validate user designs |
| martin | `POST /t/martin/run {design, demand}`, `GET /t/martin/runs/ID/frames?from&to`, `GET runs/ID/events`, `POST /t/martin/compare` | Run, animate, compare |
| per | `POST /t/per/metrics {runId}`, `POST /t/per/compare {runIds}` | Metrics panel and side-by-side comparison |

Shapes are exactly as published in each team's `CONTRACT.md` (and `#build`). We never invent fields.

## UI behaviour (what users get)

1. Pick an intersection and hour; the demand is fetched and copied. The user edits the copy (volume per arm, turning %, vehicle mix, peds/bikes, duration). The `seed` is kept so comparisons are fair.
2. Pick an existing design or edit one (lanes and turns, signal phases, roundabout radius, banned movements). Saving creates `origin: "user"`; badges show existing vs user.
3. Run: animate frames on a canvas (vehicles `v`, pedestrians `p`, signals `sig`, queues `q`) with play/pause/scrub.
4. Compare: run several designs with identical demand and seed; show per-metric table and best/rank, with an origin badge.

## Assumptions to confirm

- Frames are polled in time windows (`from`/`to`, one frame per second).
- Metrics and comparison come from `per`; the summary in martin's run response is only a quick preview.
- Anything 4xx/5xx from another module is shown to the user as is, and reported to the owner in `#build`.

## Changes

Only amad changes this file; changes are announced in `#build` first.
