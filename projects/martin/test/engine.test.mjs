// Engine tests: node --test projects/martin/test/engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const engine = require('../../../board/plugins/martin/engine.js');
const ex = engine.examples();
const [signal, roundabout] = ex.designs;

const oneArm = (turning, vehPerHour = 400) => ({
  durationSec: 600, seed: 7,
  arms: { N: { vehPerHour, turning, mix: { car: 1 } } },
});

test('same input gives identical output', () => {
  const a = engine.simulate(signal, ex.demand);
  const b = engine.simulate(signal, ex.demand);
  assert.deepEqual(a.summary, b.summary);
  assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
});

test('different designs see the same arrivals under the same demand', () => {
  const arrivals = (r) => r.events.filter((e) => e.type === 'arrive').map((e) => `${e.t}:${e.arm}`);
  assert.deepEqual(arrivals(engine.simulate(signal, ex.demand)), arrivals(engine.simulate(roundabout, ex.demand)));
});

test('invalid input is rejected with readable errors', () => {
  const r = engine.simulate({ type: 'tunnel', arms: [{ id: 'X' }] }, {});
  assert.ok(r.errors.some((e) => e.includes('design.type')));
  assert.ok(r.errors.some((e) => e.includes('arms[0].id')));
});

test('a movement that never gets green does not pass, and is warned about', () => {
  const d = { ...signal, signal: { phases: [{ green: 30, movements: ['S:S'] }, { green: 30, movements: ['E:S', 'W:S'] }] } };
  const r = engine.simulate(d, oneArm({ S: 1 }));
  assert.equal(r.summary.vehicles.exited, 0);
  assert.ok(r.warnings.some((w) => w.startsWith('N:S never gets green')));
});

test('signal serves a single approach close to its demand', () => {
  const r = engine.simulate(signal, oneArm({ L: 0.2, S: 0.6, R: 0.2 }));
  assert.equal(r.summary.vehicles.backlog, 0);
  assert.ok(r.summary.delay.meanSec < 40, `mean delay ${r.summary.delay.meanSec}`);
});

test('roundabout does not gridlock under moderate four-way demand', () => {
  const demand = { ...ex.demand, arms: Object.fromEntries(Object.entries(ex.demand.arms).map(([k, a]) => [k, { ...a, vehPerHour: a.vehPerHour * 0.6, pedPerHour: 0, bikePerHour: 0 }])) };
  const r = engine.simulate(roundabout, demand);
  assert.ok(r.summary.vehicles.exited > 0.8 * r.summary.vehicles.generated, JSON.stringify(r.summary.vehicles));
});

test('accepts the design-module variant (arms map, lanes as {turns}, top-level phases)', () => {
  const d = {
    id: 'v', type: 'signal', origin: 'existing',
    arms: { N: { inLanes: [{ turns: ['L', 'S'] }, { turns: ['S', 'R'] }] }, S: {}, E: {}, W: {} },
    phases: [{ durationSec: 30, green: ['N:L', 'N:S', 'N:R', 'S:L', 'S:S', 'S:R'] }, { durationSec: 25, green: ['E:L', 'E:S', 'E:R', 'W:L', 'W:S', 'W:R'] }],
  };
  const r = engine.simulate(d, ex.demand);
  assert.equal(r.errors, undefined);
  assert.ok(r.summary.vehicles.exited > 0);
});

test('a banned turn gets no traffic', () => {
  const r = engine.simulate({ ...signal, bannedMovements: ['N:L'] }, oneArm({ L: 0.5, S: 0.5 }));
  assert.ok(!r.events.some((e) => e.movement === 'N:L'));
  assert.ok(r.events.some((e) => e.movement === 'N:S'));
});

test('single-lane roundabout carries moderate four-way traffic without collisions', () => {
  const arms = Object.fromEntries(['N', 'E', 'S', 'W'].map((id) => [id, { vehPerHour: 370, turning: { L: 0.25, S: 0.5, R: 0.25 }, mix: { car: 1 }, pedPerHour: 100, bikePerHour: 0 }]));
  const r = engine.simulate(roundabout, { durationSec: 900, seed: 42, arms });
  assert.ok(r.summary.vehicles.exited > 0.85 * r.summary.vehicles.generated, JSON.stringify(r.summary.vehicles));
  let overlaps = 0;
  for (const f of r.frames) {
    for (let i = 0; i < f.v.length; i++) for (let j = i + 1; j < f.v.length; j++) {
      if (Math.hypot(f.v[i][2] - f.v[j][2], f.v[i][3] - f.v[j][3]) < 1.5) overlaps++;
    }
  }
  assert.ok(overlaps < 20, `vehicles overlapped in ${overlaps} frame pairs`);
});
