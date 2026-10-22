// Unit tests for the traffic data loader plugin. Run from the repo root: node --test projects/backend/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../../../board/plugins/backend/index.js');
const data = require('../../../board/plugins/backend/intersections.json');

async function call(method, pathAndQuery, body) {
  const url = new URL('http://x/t/backend' + pathAndQuery);
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  const res = {
    status: 0, text: '',
    writeHead(s) { this.status = s; },
    end(t) { this.text = t || ''; },
  };
  const handled = await plugin.handle(req, res, { path: url.pathname.replace('/t/backend', '') || '/', url });
  return { handled, status: res.status, json: res.text ? JSON.parse(res.text) : null };
}

const demandUrl = (q) => '/demand?' + new URLSearchParams(q);

test('every intersection has valid arms, shares and profiles', () => {
  for (const day of Object.values(data.days)) {
    assert.equal(day.hourlyShare.length, 24);
    assert.equal(day.activeShare.length, 24);
    assert.ok(Math.abs(day.hourlyShare.reduce((a, b) => a + b) - 1) < 0.01);
  }
  for (const i of data.intersections) {
    const arms = Object.keys(i.arms);
    assert.ok(arms.length >= 2 && arms.every((a) => 'NESW'.includes(a)), i.id);
    for (const a of arms) {
      const t = i.arms[a].turning, m = i.arms[a].mix;
      assert.ok(Math.abs(t.L + t.S + t.R - 1) < 1e-9, `${i.id} ${a} turning`);
      assert.ok(Math.abs(m.car + m.bus + m.truck - 1) < 1e-9, `${i.id} ${a} mix`);
    }
  }
});

test('T-junction demand has no arm and no turns towards the missing north arm', async () => {
  const { status, json } = await call('GET', demandUrl({ intersection: 'priority-tjunction' }));
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(json.arms), ['E', 'S', 'W']);
  assert.equal(json.arms.E.turning.R, 0);
  assert.equal(json.arms.S.turning.S, 0);
  assert.equal(json.arms.W.turning.L, 0);
});

test('GET demand matches the engine shape and applies defaults', async () => {
  const { status, json } = await call('GET', demandUrl({ intersection: 'sveavagen-odengatan' }));
  assert.equal(status, 200);
  assert.equal(json.durationSec, 900);
  assert.equal(json.seed, 42);
  for (const arm of Object.values(json.arms)) {
    assert.deepEqual(Object.keys(arm).sort(), ['bikePerHour', 'mix', 'pedPerHour', 'turning', 'vehPerHour']);
    assert.ok(Number.isInteger(arm.vehPerHour));
  }
});

test('weekend has less traffic than the weekday at the same hour', async () => {
  const q = { intersection: 'fridhemsplan', hour: 8 };
  const total = (j) => Object.values(j.arms).reduce((s, a) => s + a.vehPerHour, 0);
  const wd = (await call('GET', demandUrl({ ...q, day: 'weekday' }))).json;
  const su = (await call('GET', demandUrl({ ...q, day: 'sunday' }))).json;
  assert.ok(total(su) < total(wd));
});

test('scale multiplies volumes', async () => {
  const base = (await call('GET', demandUrl({ intersection: 'fridhemsplan', scale: 1 }))).json;
  const dbl = (await call('GET', demandUrl({ intersection: 'fridhemsplan', scale: 2 }))).json;
  assert.ok(Math.abs(dbl.arms.N.vehPerHour - 2 * base.arms.N.vehPerHour) <= 1);
  assert.equal((await call('GET', demandUrl({ intersection: 'fridhemsplan', scale: 0 }))).json.arms.N.vehPerHour, 0);
});

test('bad GET parameters give 400 with the field name', async () => {
  for (const [q, field] of [
    [{}, 'intersection'],
    [{ intersection: 'nope' }, 'intersection'],
    [{ intersection: 'fridhemsplan', hour: 24 }, 'hour'],
    [{ intersection: 'fridhemsplan', hour: 1.5 }, 'hour'],
    [{ intersection: 'fridhemsplan', durationSec: 59 }, 'durationSec'],
    [{ intersection: 'fridhemsplan', scale: 'x' }, 'scale'],
    [{ intersection: 'fridhemsplan', day: 'friday' }, 'day'],
  ]) {
    const r = await call('GET', demandUrl(q));
    assert.equal(r.status, 400, JSON.stringify(q));
    assert.match(r.json.error, new RegExp(field));
  }
});

test('POST overrides are applied and normalised', async () => {
  const { status, json } = await call('POST', '/demand', {
    intersection: 'priority-tjunction', day: 'saturday', hour: 12, seed: 7,
    overrides: { E: { vehPerHour: 900, turning: { L: 1, S: 3 }, mix: { car: 9, truck: 1 } } },
  });
  assert.equal(status, 200);
  assert.equal(json.seed, 7);
  assert.equal(json.arms.E.vehPerHour, 900);
  assert.deepEqual(json.arms.E.turning, { L: 0.25, S: 0.75, R: 0 });
  assert.deepEqual(json.arms.E.mix, { car: 0.9, bus: 0, truck: 0.1 });
});

test('POST rejects bad bodies and overrides with 400', async () => {
  const cases = [
    '{oops',
    [1],
    { intersection: 'priority-tjunction', overrides: { N: { vehPerHour: 10 } } },
    { intersection: 'fridhemsplan', overrides: { N: { speed: 10 } } },
    { intersection: 'fridhemsplan', overrides: { N: { turning: { L: 0 } } } },
    { intersection: 'fridhemsplan', overrides: { N: { vehPerHour: -1 } } },
    { intersection: 'fridhemsplan', overrides: { N: { mix: { bike: 1 } } } },
  ];
  for (const body of cases) {
    const r = await call('POST', '/demand', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const big = await call('POST', '/demand', 'x'.repeat(70 * 1024));
  assert.equal(big.status, 400);
});

test('intersection detail has per-day hourly profiles', async () => {
  const { status, json } = await call('GET', '/intersections/priority-tjunction');
  assert.equal(status, 200);
  assert.deepEqual(json.armIds, ['E', 'S', 'W']);
  assert.equal(json.vehPerHourByHour.E.sunday.length, 24);
  assert.equal((await call('GET', '/intersections/nope')).status, 404);
});

test('unknown routes fall through to the server 404', async () => {
  assert.equal((await call('GET', '/nothing')).handled, false);
  assert.equal((await call('PUT', '/demand')).handled, false);
});

test('varying=1 adds an hourly schedule that ramps and keeps top-level arms as the first hour', async () => {
  const plain = (await call('GET', demandUrl({ intersection: 'fridhemsplan', hour: 6, durationSec: 7200 }))).json;
  assert.equal(plain.schedule, undefined);
  const { status, json } = await call('GET', demandUrl({ intersection: 'fridhemsplan', hour: 6, durationSec: 7200, varying: 1 }));
  assert.equal(status, 200);
  assert.deepEqual(json.arms, plain.arms);
  assert.deepEqual(json.schedule.map((s) => [s.atSec, s.hour]), [[0, 6], [3600, 7]]);
  assert.deepEqual(json.schedule[0].arms, json.arms);
  assert.ok(json.schedule[1].arms.W.vehPerHour > json.schedule[0].arms.W.vehPerHour);
  const wrap = (await call('GET', demandUrl({ intersection: 'fridhemsplan', hour: 23, durationSec: 3601, varying: 'true' }))).json;
  assert.deepEqual(wrap.schedule.map((s) => s.hour), [23, 0]);
  assert.equal((await call('GET', demandUrl({ intersection: 'fridhemsplan', varying: 'yes' }))).status, 400);
});

test('POST overrides apply to every schedule step', async () => {
  const { json } = await call('POST', '/demand', {
    intersection: 'fridhemsplan', hour: 7, durationSec: 7200, varying: true, overrides: { N: { turning: { S: 1 } } },
  });
  for (const step of json.schedule) assert.deepEqual(step.arms.N.turning, { L: 0, S: 1, R: 0 });
  assert.deepEqual(json.arms.N.turning, { L: 0, S: 1, R: 0 });
});
