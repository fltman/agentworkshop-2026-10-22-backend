// Traffic data loader: prerecorded Stockholm traffic served as demand for the simulation engine (team martin).
// Contract: projects/backend/CONTRACT.md
const data = require('./intersections.json');

const ARMS = ['N', 'E', 'S', 'W'];
const TURNS = ['L', 'S', 'R'];
const CLASSES = ['car', 'bus', 'truck'];
const DAYS = Object.keys(data.days);
const MAX_BODY = 64 * 1024;
const byId = new Map(data.intersections.map((i) => [i.id, i]));
const armsOf = (inter) => ARMS.filter((a) => inter.arms[a]);
const round3 = (x) => Math.round(x * 1000) / 1000;

class BadInput extends Error {}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

function num(value, key, def, min, max, int) {
  if (value === undefined || value === null || value === '') return def;
  const v = Number(value);
  if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
    throw new BadInput(`${key} must be ${int ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return v;
}

function flag(value, key) {
  if (value === undefined || value === null || value === '' || value === false || value === '0' || value === 'false') return false;
  if (value === true || value === '1' || value === 'true') return true;
  throw new BadInput(`${key} must be true or false`);
}

function options(src) {
  const inter = byId.get(src.intersection);
  if (!inter) throw new BadInput('intersection must be one of: ' + [...byId.keys()].join(', '));
  const day = src.day === undefined || src.day === null || src.day === '' ? 'weekday' : src.day;
  if (!DAYS.includes(day)) throw new BadInput('day must be one of: ' + DAYS.join(', '));
  return {
    inter,
    day,
    hour: num(src.hour, 'hour', 8, 0, 23, true),
    durationSec: num(src.durationSec, 'durationSec', 900, 60, 7200, true),
    seed: num(src.seed, 'seed', 42, 0, 2 ** 31 - 1, true),
    scale: num(src.scale, 'scale', 1, 0, 5, false),
    varying: flag(src.varying, 'varying'),
  };
}

function armDemand(arm, profile, hour, scale) {
  const active = profile.activeShare[hour] * profile.peds;
  return {
    vehPerHour: Math.round(arm.adtIn * profile.volume * profile.hourlyShare[hour] * scale),
    turning: { ...arm.turning },
    mix: { ...arm.mix },
    pedPerHour: Math.round(arm.pedPeak * active * scale),
    bikePerHour: Math.round(arm.bikePeak * active * scale),
  };
}

function armsAt(inter, day, hour, scale) {
  const arms = {};
  for (const a of armsOf(inter)) arms[a] = armDemand(inter.arms[a], data.days[day], hour, scale);
  return arms;
}

function demand({ inter, day, hour, durationSec, seed, scale, varying }) {
  const d = { durationSec, seed, arms: armsAt(inter, day, hour, scale) };
  if (varying) {
    d.schedule = [];
    for (let k = 0; k * 3600 < durationSec; k++) {
      d.schedule.push({ atSec: k * 3600, hour: (hour + k) % 24, arms: armsAt(inter, day, (hour + k) % 24, scale) });
    }
  }
  return d;
}

function shares(obj, keys, path) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new BadInput(`${path} must be an object`);
  const out = {};
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) throw new BadInput(`${path}.${k} is not allowed, use ${keys.join('/')}`);
  }
  let sum = 0;
  for (const k of keys) {
    out[k] = num(obj[k], `${path}.${k}`, 0, 0, 1e6, false);
    sum += out[k];
  }
  if (sum <= 0) throw new BadInput(`${path} must have at least one positive share`);
  for (const k of keys) out[k] = round3(out[k] / sum);
  return out;
}

const ARM_FIELDS = ['vehPerHour', 'turning', 'mix', 'pedPerHour', 'bikePerHour'];

function applyOverrides(d, overrides) {
  if (overrides === undefined || overrides === null) return d;
  if (typeof overrides !== 'object' || Array.isArray(overrides)) throw new BadInput('overrides must be an object of arms');
  overrideArms(d.arms, overrides);
  for (const step of d.schedule || []) overrideArms(step.arms, overrides);
  return d;
}

function overrideArms(arms, overrides) {
  for (const [a, o] of Object.entries(overrides)) {
    const arm = arms[a];
    if (!arm) throw new BadInput(`overrides.${a}: this intersection has arms ${Object.keys(arms).join(', ')}`);
    if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new BadInput(`overrides.${a} must be an object`);
    for (const k of Object.keys(o)) {
      if (!ARM_FIELDS.includes(k)) throw new BadInput(`overrides.${a}.${k} is not allowed, use ${ARM_FIELDS.join(', ')}`);
    }
    if (o.vehPerHour !== undefined) arm.vehPerHour = num(o.vehPerHour, `overrides.${a}.vehPerHour`, 0, 0, 5000, true);
    if (o.pedPerHour !== undefined) arm.pedPerHour = num(o.pedPerHour, `overrides.${a}.pedPerHour`, 0, 0, 10000, true);
    if (o.bikePerHour !== undefined) arm.bikePerHour = num(o.bikePerHour, `overrides.${a}.bikePerHour`, 0, 0, 10000, true);
    if (o.turning !== undefined) arm.turning = shares(o.turning, TURNS, `overrides.${a}.turning`);
    if (o.mix !== undefined) arm.mix = shares(o.mix, CLASSES, `overrides.${a}.mix`);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new BadInput('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new BadInput('body must be JSON')); }
    });
    req.on('error', reject);
  });
}

function summary(inter) {
  return { id: inter.id, name: inter.name, lat: inter.lat, lon: inter.lon, source: inter.source, estimated: inter.estimated, armIds: armsOf(inter) };
}

function detail(inter) {
  const arms = {};
  const vehPerHourByHour = {};
  for (const a of armsOf(inter)) {
    arms[a] = { road: inter.arms[a].road, adtIn: inter.arms[a].adtIn };
    vehPerHourByHour[a] = {};
    for (const day of DAYS) {
      const p = data.days[day];
      vehPerHourByHour[a][day] = p.hourlyShare.map((s) => Math.round(inter.arms[a].adtIn * p.volume * s));
    }
  }
  const activeShareByHour = {};
  for (const day of DAYS) activeShareByHour[day] = data.days[day].activeShare.map((s) => round3(s * data.days[day].peds));
  return { ...summary(inter), note: data.note, days: DAYS, arms, vehPerHourByHour, activeShareByHour };
}

async function route(req, res, path, params) {
  if (req.method === 'GET' && (path === '/' || path === '')) {
    return send(res, 200, {
      module: 'traffic data loader',
      endpoints: [
        'GET /t/backend/intersections',
        'GET /t/backend/intersections/ID',
        'GET /t/backend/demand?intersection=ID&day=weekday&hour=8&durationSec=900&seed=42&scale=1&varying=0',
        'POST /t/backend/demand {intersection, day, hour, durationSec, seed, scale, varying, overrides}',
      ],
      contract: 'projects/backend/CONTRACT.md',
    });
  }
  if (req.method === 'GET' && path === '/intersections') {
    return send(res, 200, { intersections: data.intersections.map(summary) });
  }
  const m = path.match(/^\/intersections\/([a-z0-9-]+)$/);
  if (req.method === 'GET' && m) {
    const inter = byId.get(m[1]);
    return inter ? send(res, 200, detail(inter)) : send(res, 404, { error: `unknown intersection ${m[1]}` });
  }
  if (path === '/demand') {
    if (req.method === 'GET') return send(res, 200, demand(options(Object.fromEntries(params))));
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadInput('body must be a JSON object');
      return send(res, 200, applyOverrides(demand(options(body)), body.overrides));
    }
  }
  return false;
}

module.exports = {
  async handle(req, res, { path, url }) {
    try {
      return await route(req, res, path, url.searchParams);
    } catch (err) {
      if (err instanceof BadInput) return send(res, 400, { error: err.message });
      console.error('[backend]', err && err.message);
      return send(res, 500, { error: 'internal error' });
    }
  },
};
