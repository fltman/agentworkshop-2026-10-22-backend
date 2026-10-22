// Finds overlapping vehicles in martin's frames: same-heading pairs closer than 60 % of their mean length, or any pair
// within 1.5 m; bikes are skipped since bike lanes run beside cars. Uses martin's /examples designs with our 08:00 demand.
// Usage: node projects/backend/overlap-check.mjs [boardUrl]
import { readFileSync } from 'node:fs';

const base = (process.argv[2] || readFileSync(new URL('../../.board-url', import.meta.url), 'utf8')).trim().replace(/\/$/, '');
const get = async (p, init) => (await fetch(base + p, init)).json();
const LEN = { car: 4.5, bus: 12, truck: 10 };
const DEMAND_FOR = { signal: 'sveavagen-odengatan', roundabout: 'roundabout-medium', priority: 'priority-tjunction' };

const { designs } = await get('/t/martin/examples');
let bad = 0;
for (const design of designs) {
  const demand = await get(`/t/backend/demand?intersection=${DEMAND_FOR[design.type] || 'sveavagen-odengatan'}&hour=8&durationSec=300`);
  const run = await get('/t/martin/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ design, demand }) });
  if (!run.runId) { console.log(`FAIL ${design.type}: ${JSON.stringify(run).slice(0, 200)}`); bad++; continue; }
  const { frames } = await get(`/t/martin/runs/${run.runId}/frames?from=0&to=300`);
  let framesHit = 0, stacked = 0, worst = null;
  for (const f of frames) {
    const v = (f.v || []).filter((x) => x[1] !== 'bike');
    let hit = false;
    for (let a = 0; a < v.length; a++) for (let b = a + 1; b < v.length; b++) {
      const [, ca, xa, ya, ha] = v[a], [, cb, xb, yb, hb] = v[b];
      const dist = Math.hypot(xa - xb, ya - yb);
      const dh = Math.abs(((ha - hb + 540) % 360) - 180);
      if ((dh < 30 && dist < ((LEN[ca] ?? 4.5) + (LEN[cb] ?? 4.5)) / 2 * 0.6) || dist < 1.5) {
        hit = true;
        if (dist === 0) stacked++;
        if (!worst || dist < worst.dist) worst = { t: f.t, dist: +dist.toFixed(2), a: v[a], b: v[b] };
      }
    }
    if (hit) framesHit++;
  }
  if (framesHit) bad++;
  console.log(`${framesHit ? 'BAD ' : 'ok  '} ${design.type}: ${framesHit}/${frames.length} frames overlap, ${stacked} identical-position pairs, run ${run.runId}, worst ${JSON.stringify(worst)}`);
}
process.exit(bad ? 1 : 0);
