# CONTRACT: be-christian, Intersection Design

Base: `/t/be-christian/`. Design JSON follows martin's contract (arms N/E/S/W = where traffic comes FROM, metres).

## Endpoints

- `GET /designs` -> `{"designs":[{"id","name","origin","type","location"}]}` (summaries; `?origin=existing|user`)
- `GET /designs/:id` -> full design JSON
- `POST /designs` -> save a user design (origin forced to `user`), returns `{"id"}`
- `POST /validate` -> `{"ok":bool,"errors":[...]}`
- `POST /suggest` `{base:"<design id>" | design:{...}, demand:{arms:{N:{vehPerHour,turning:{L,S,R}},...}}}` -> `{"suggestions":[design,...]}`: unsaved variants (demand-balanced signal split, dedicated left lanes, roundabout conversion, larger roundabout), each with `origin:"user"`, `suggested:true`, `basedOn`, `rationale`. Save one with POST /designs.

## Design JSON

```json
{"id":"sergels-torg","name":"Sergels torg (preset)","origin":"existing","type":"signal",
 "arms":{"N":{"inLanes":[{"turns":["L"]},{"turns":["S"]},{"turns":["S","R"]}]},"E":{},"S":{},"W":{}},
 "phases":[{"durationSec":30,"green":["N:S","N:R","S:S","S:R"]},{"durationSec":25,"green":["E:S","E:R","W:S","W:R"]}],
 "radius":null,"bannedMovements":["N:L"]}
```

- type: `signal` | `roundabout` | `priority`; `radius` (m) only for roundabout; `phases` only for signal.
- Turns: L/S/R. Movement id: `N:L`. Every movement in `phases` or `bannedMovements` must exist.

Exact field names will be aligned with projects/martin/CONTRACT.md; martin's version wins on conflicts.
