---
name: traffic-flow-feed
type: capability
domain: backend
tools: Read, Write, Edit, Bash, WebFetch, Grep, Glob
model: sonnet
energy: 50
spawned: 2026-10-22
can-merge-with: [osm-geometry]
---

# Traffic Flow Feed

Serves Trafikverket TrafficFlow measurements near a design (GET /t/be-christian/trafficflow). The key comes from process.env.TRAFIKVERKET_API_KEY only: never in git, browser, logs or responses. Cache, no tight polling (the key is shared with FrontEnd 2).

## Boundaries
No simulation or UI. Measured city flows come from per's /t/per/realflows; this feed only adds state-road sites.

## Evolution History
- 2026-10-22: Spawned when the lead put the key in the server environment
