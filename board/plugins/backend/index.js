// Traffic data loader: prerecorded Stockholm traffic served as demand for the simulation engine (team martin).
// Contract: projects/backend/CONTRACT.md
const data = require('./intersections.json');

const ARMS = ['N', 'E', 'S', 'W'];
const byId = new Map(data.intersections.map((i) => [i.id, i]));
const armsOf = (inter) => ARMS.filter((a) => inter.arms[a]);

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function num(params, key, def, min, max, int) {
  const raw = params.get(key);
  if (raw === null || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
    throw new Error(`${key} must be ${int ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return v;
}

const round3 = (x) => Math.round(x * 1000) / 1000;

function armDemand(arm, hour, scale) {
  const peds = data.activeShare[hour];
  return {
    vehPerHour: Math.round(arm.adtIn * data.hourlyShare[hour] * scale),
    turning: { ...arm.turning },
    mix: { ...arm.mix },
    pedPerHour: Math.round(arm.pedPeak * peds * scale),
    bikePerHour: Math.round(arm.bikePeak * peds * scale),
  };
}

function demand(inter, { hour, durationSec, seed, scale }) {
  const arms = {};
  for (const a of armsOf(inter)) arms[a] = armDemand(inter.arms[a], hour, scale);
  return { durationSec, seed, arms };
}

function summary(inter) {
  return { id: inter.id, name: inter.name, lat: inter.lat, lon: inter.lon, source: inter.source, estimated: inter.estimated, armIds: armsOf(inter) };
}

function detail(inter) {
  const profile = {};
  for (const a of armsOf(inter)) {
    profile[a] = data.hourlyShare.map((s) => Math.round(inter.arms[a].adtIn * s));
  }
  const arms = {};
  for (const a of armsOf(inter)) arms[a] = { road: inter.arms[a].road, adtIn: inter.arms[a].adtIn };
  return { ...summary(inter), note: data.note, arms, vehPerHourByHour: profile, activeShareByHour: data.activeShare.map(round3) };
}

module.exports = {
  async handle(req, res, { path, url }) {
    if (req.method !== 'GET') return false;
    const params = url.searchParams;

    if (path === '/' || path === '') {
      return send(res, 200, {
        module: 'traffic data loader',
        endpoints: ['GET /t/backend/intersections', 'GET /t/backend/intersections/ID', 'GET /t/backend/demand?intersection=ID&hour=8&durationSec=900&seed=42&scale=1'],
        contract: 'projects/backend/CONTRACT.md',
      }), true;
    }

    if (path === '/intersections') {
      return send(res, 200, { intersections: data.intersections.map(summary) }), true;
    }

    const m = path.match(/^\/intersections\/([a-z0-9-]+)$/);
    if (m) {
      const inter = byId.get(m[1]);
      if (!inter) return send(res, 404, { error: `unknown intersection ${m[1]}` }), true;
      return send(res, 200, detail(inter)), true;
    }

    if (path === '/demand') {
      const id = params.get('intersection');
      const inter = byId.get(id);
      if (!inter) return send(res, 400, { error: 'intersection must be one of: ' + [...byId.keys()].join(', ') }), true;
      let opts;
      try {
        opts = {
          hour: num(params, 'hour', 8, 0, 23, true),
          durationSec: num(params, 'durationSec', 900, 60, 7200, true),
          seed: num(params, 'seed', 42, 0, 2 ** 31 - 1, true),
          scale: num(params, 'scale', 1, 0, 5, false),
        };
      } catch (err) {
        return send(res, 400, { error: err.message }), true;
      }
      return send(res, 200, demand(inter, opts)), true;
    }

    return false;
  },
};
