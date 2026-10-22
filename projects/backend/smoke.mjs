// End-to-end smoke test against the live board: our demand + be-christian's design -> martin's engine, for every id.
// Usage: node projects/backend/smoke.mjs [boardUrl] [--varying]   (default: contents of .board-url)
// --varying runs 2 h from hour 7 with the hourly schedule.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const varying = args.includes('--varying');
const base = (args.find((a) => !a.startsWith('--')) || readFileSync(new URL('../../.board-url', import.meta.url), 'utf8')).trim().replace(/\/$/, '');

async function json(path, init) {
  const r = await fetch(base + path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${init?.method || 'GET'} ${path} -> ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const { intersections } = await json('/t/backend/intersections');
let failed = 0;
for (const { id } of intersections) {
  try {
    const demand = await json(varying
      ? `/t/backend/demand?intersection=${id}&hour=7&durationSec=7200&varying=1`
      : `/t/backend/demand?intersection=${id}&hour=8`);
    const d = await json(`/t/be-christian/designs/${id}`);
    const design = d.design || d;
    const run = await json('/t/martin/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ design, demand }),
    });
    const s = run.summary;
    console.log(`ok   ${id}: generated ${s.vehicles.generated}, mean delay ${s.delay.meanSec}s${run.warnings?.length ? ', warnings: ' + run.warnings.join('; ') : ''}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${id}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
