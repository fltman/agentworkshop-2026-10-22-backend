// Bakes measured flows from per's /t/per/realflows into board/plugins/backend/intersections.json.
// Usage: node projects/backend/calibrate.mjs [boardUrl]   (default: contents of .board-url)
// Per arm: busiest segment (rank 0) or nth busiest distinct value of the mapped street within maxDistM, minus side
// roads under 1000/day; adtIn = ADT all directions / 2, heavy share replaces bus+truck keeping their ratio.
import { readFileSync, writeFileSync } from 'node:fs';

const base = (process.argv[2] || readFileSync(new URL('../../.board-url', import.meta.url), 'utf8')).trim().replace(/\/$/, '');
const file = new URL('../../board/plugins/backend/intersections.json', import.meta.url);
const MIN_ADT = 1000;

const MAP = {
  'sveavagen-odengatan': { N: { street: 'Sveavägen' }, S: { street: 'Sveavägen' }, E: { street: 'Odengatan' }, W: { street: 'Odengatan' } },
  'valhallavagen-birgerjarlsgatan': {
    N: { street: 'Birger Jarlsgatan' }, S: { street: 'Birger Jarlsgatan' },
    E: { street: 'Valhallavägen' }, W: { street: 'Valhallavägen' },
  },
  // South of the junction Långholmsgatan continues as Hornstull/Liljeholmsbron; west Hornsgatan is the local part.
  'hornsgatan-langholmsgatan': {
    N: { street: 'Långholmsgatan' }, S: { street: 'Hornstull' },
    E: { street: 'Hornsgatan' }, W: { street: 'Hornsgatan', rank: 1 },
  },
  // Fleminggatan has no segment in per's 150 m extract and stays estimated.
  fridhemsplan: { N: { street: 'Fridhemsgatan' }, S: { street: 'Fridhemsgatan' }, W: { street: 'Drottningholmsvägen', maxDistM: 150 } },
};

const data = JSON.parse(readFileSync(file, 'utf8'));
for (const inter of data.intersections) {
  const map = MAP[inter.id];
  if (!map) continue;
  const r = await fetch(`${base}/t/per/realflows?intersection=${inter.id}`);
  if (!r.ok) throw new Error(`realflows ${inter.id}: ${r.status}`);
  const { motor = [] } = await r.json();
  let measured = 0;
  for (const [armId, arm] of Object.entries(inter.arms)) {
    const m = map[armId];
    if (!m) { arm.source = 'estimated'; continue; }
    const segs = motor
      .filter((s) => s.street === m.street && s.distM <= (m.maxDistM ?? 60) && s.adtAllDirections >= MIN_ADT)
      .sort((a, b) => b.adtAllDirections - a.adtAllDirections || a.distM - b.distM);
    const distinct = segs.filter((s, i) => i === 0 || s.adtAllDirections !== segs[i - 1].adtAllDirections);
    const seg = distinct[m.rank ?? 0];
    if (!seg) throw new Error(`${inter.id} ${armId}: no ${m.street} segment`);
    const before = arm.adtIn;
    arm.adtIn = Math.round(seg.adtAllDirections / 2);
    const heavy = arm.mix.bus + arm.mix.truck;
    const bus = +(arm.mix.bus * seg.heavyShare / heavy).toFixed(3);
    arm.mix = { car: +(1 - seg.heavyShare).toFixed(3), bus, truck: +(seg.heavyShare - bus).toFixed(3) };
    arm.source = 'measured';
    arm.measured = { street: seg.street, distM: seg.distM, adtAllDirections: seg.adtAllDirections, heavyShare: seg.heavyShare };
    measured++;
    console.log(`${inter.id} ${armId}: ${before} -> ${arm.adtIn} (${seg.street} ${seg.adtAllDirections}/day at ${seg.distM} m)`);
  }
  inter.estimated = measured < Object.keys(inter.arms).length;
  inter.source = `Stockholm stad / NVDB open flow maps via /t/per/realflows (${measured} of ${Object.keys(inter.arms).length} arms measured)`;
}
data.note = 'Arm volumes marked source "measured" come from Stockholm stad / NVDB open traffic flow maps (ADT all directions halved to inbound, heavy share as bus+truck), via /t/per/realflows. Arms marked "estimated", turning shares, pedestrian/bicycle peaks and day profiles are assumptions. Every arm value is inbound traffic (arm = where traffic comes FROM).';
writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
