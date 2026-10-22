'use strict';
const fs = require('fs');
const path = require('path');
const PRESETS = require('./presets');
const { suggest } = require('./suggest');
const { fromOsm } = require('./osm');

const BEARING_RETRY_MS = 5 * 60 * 1000;
let lastBearingFail = 0;

async function postJson(port, urlPath, body) {
  const res = await fetch('http://127.0.0.1:' + port + urlPath, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
  });
  return { status: res.status, json: await res.json() };
}

// Lower is better: mean delay, with unserved vehicles weighted as heavy delay.
function score(summary) {
  const v = summary.vehicles || {};
  const unserved = (v.inNetwork || 0) + (v.backlog || 0);
  return (summary.delay && summary.delay.meanSec || 0) + 120 * (v.generated ? unserved / v.generated : 0);
}

const ARMS = ['N', 'E', 'S', 'W'];
const TURNS = ['L', 'S', 'R'];
const TYPES = ['signal', 'roundabout', 'priority'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_BODY = 64 * 1024;

function validate(d) {
  const errors = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['design must be an object'];
  if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 80) errors.push('name: 1-80 chars required');
  if (!TYPES.includes(d.type)) errors.push('type must be one of ' + TYPES.join('|'));
  const arms = d.arms;
  if (!arms || typeof arms !== 'object') return errors.concat('arms required');
  const movements = new Set();
  let armCount = 0;
  for (const a of Object.keys(arms)) {
    if (!ARMS.includes(a)) { errors.push('unknown arm ' + a); continue; }
    armCount++;
    const bd = arms[a] && arms[a].bearingDeg;
    if (bd !== undefined) {
      const label = { N: 0, E: 90, S: 180, W: 270 }[a];
      const diff = Math.abs(bd - label) % 360;
      if (typeof bd !== 'number' || !(bd >= 0 && bd < 360) || Math.min(diff, 360 - diff) > 60) errors.push(a + ': bearingDeg must be 0-359 and within 60 degrees of the arm label');
    }
    const lanes = arms[a] && arms[a].inLanes;
    if (!Array.isArray(lanes) || lanes.length < 1 || lanes.length > 6) { errors.push(a + ': inLanes needs 1-6 lanes'); continue; }
    lanes.forEach((l, i) => {
      if (!l || !Array.isArray(l.turns) || !l.turns.length || !l.turns.every((t) => TURNS.includes(t))) errors.push(a + ' lane ' + i + ': turns must be a non-empty subset of L,S,R');
      else l.turns.forEach((t) => movements.add(a + ':' + t));
    });
  }
  if (armCount < 3) errors.push('at least 3 arms required');
  const withB = ARMS.filter((a) => arms[a] && typeof arms[a].bearingDeg === 'number');
  for (let i = 0; i < withB.length; i++) for (let j = i + 1; j < withB.length; j++) {
    const x = Math.abs(arms[withB[i]].bearingDeg - arms[withB[j]].bearingDeg) % 360;
    if (Math.min(x, 360 - x) < 30) errors.push('arms ' + withB[i] + ' and ' + withB[j] + ' must be at least 30 degrees apart');
  }
  if (d.bannedMovements !== undefined) {
    if (!Array.isArray(d.bannedMovements)) errors.push('bannedMovements must be an array');
    else d.bannedMovements.forEach((m) => { if (!movements.has(m)) errors.push('bannedMovements: unknown movement ' + m); });
  }
  if (d.type === 'signal') {
    if (!Array.isArray(d.phases) || !d.phases.length) errors.push('signal needs phases');
    else d.phases.forEach((p, i) => {
      if (!p || !(p.durationSec >= 5 && p.durationSec <= 180)) errors.push('phase ' + i + ': durationSec 5-180');
      if (!p || !Array.isArray(p.green) || !p.green.length) errors.push('phase ' + i + ': green list required');
      else p.green.forEach((m) => { if (!movements.has(m)) errors.push('phase ' + i + ': unknown movement ' + m); });
    });
  }
  if (d.type === 'roundabout' && !(d.radius >= 8 && d.radius <= 60)) errors.push('roundabout needs radius 8-60 m');
  if (d.type === 'roundabout' && d.roundabout && d.roundabout.lanes !== undefined) {
    if (d.roundabout.lanes !== 1 && d.roundabout.lanes !== 2) errors.push('roundabout.lanes must be 1 or 2');
    else if (d.roundabout.lanes === 2 && !(d.radius >= 12)) errors.push('a 2-lane roundabout needs radius of at least 12 m');
  }
  return errors;
}

module.exports = {
  init(ctx) {
    this.dataRoot = ctx.dataDir;
    this.dir = path.join(ctx.dataDir, 'designs');
    fs.mkdirSync(this.dir, { recursive: true });
  },

  userDesigns() {
    const out = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'))); } catch (e) { /* skip corrupt file */ }
    }
    return out;
  },

  all() { return PRESETS.concat(this.userDesigns()); },

  loadBearings() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dataRoot, 'bearings.json'), 'utf8')); } catch (e) { return {}; }
  },

  // Adds real street bearings (from OpenStreetMap, cached on disk) to a preset when they are known.
  async withBearings(d) {
    if (!d.location || d.origin !== 'existing') return d;
    const cache = this.loadBearings();
    // Fetch in the background so a slow Overpass never delays the design request; the next call gets the bearings.
    if (!cache[d.id] && !this.fetching && Date.now() - lastBearingFail > BEARING_RETRY_MS) {
      this.fetching = true;
      fromOsm(d.location.lat, d.location.lon).then((out) => {
        if (out.error) { lastBearingFail = Date.now(); return; }
        const c = this.loadBearings();
        c[d.id] = {};
        for (const a of Object.keys(out.design.arms)) if (out.design.arms[a].bearingDeg !== undefined) c[d.id][a] = out.design.arms[a].bearingDeg;
        fs.writeFileSync(path.join(this.dataRoot, 'bearings.json'), JSON.stringify(c));
      }).catch((e) => { lastBearingFail = Date.now(); console.error('[be-christian]', e && e.message); })
        .finally(() => { this.fetching = false; });
    }
    const b = cache[d.id];
    if (!b) return d;
    const v = JSON.parse(JSON.stringify(d));
    for (const a of Object.keys(v.arms)) if (b[a] !== undefined) v.arms[a].bearingDeg = b[a];
    if (validate(v).length) return d;
    return v;
  },

  async handle(req, res, ctx) {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(obj));
      return true;
    };
    const p = (ctx.path || '/').replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && (p === '/' || p === '/designs')) {
        const url = new URL(req.url, 'http://x');
        const origin = url.searchParams.get('origin');
        const list = this.all().filter((d) => !origin || d.origin === origin)
          .map((d) => ({ id: d.id, name: d.name, origin: d.origin, type: d.type, location: d.location || null }));
        return send(200, { designs: list });
      }
      if (req.method === 'GET' && p === '/osm') {
        const url = new URL(req.url, 'http://x');
        let lat = parseFloat(url.searchParams.get('lat'));
        let lon = parseFloat(url.searchParams.get('lon'));
        const ref = url.searchParams.get('design');
        if (ref) {
          const d = this.all().find((x) => x.id === ref);
          if (!d || !d.location) return send(404, { error: 'design has no location' });
          lat = d.location.lat; lon = d.location.lon;
        }
        if (!(lat >= 55 && lat <= 70 && lon >= 10 && lon <= 25)) return send(400, { error: 'lat 55-70 and lon 10-25 (Sweden) required, or design=<id>' });
        const out = await fromOsm(lat, lon);
        if (out.error) return send(out.status || 502, { error: out.error });
        const errors = validate(out.design);
        return send(200, { design: out.design, valid: !errors.length, errors });
      }
      const m = p.match(/^\/designs\/([a-z0-9-]+)$/);
      if (req.method === 'GET' && m) {
        const d = this.all().find((x) => x.id === m[1]);
        return d ? send(200, await this.withBearings(d)) : send(404, { error: 'not found' });
      }
      if (req.method === 'DELETE' && m) {
        const file = path.join(this.dir, m[1] + '.json');
        if (PRESETS.some((x) => x.id === m[1])) return send(403, { error: 'existing designs cannot be deleted' });
        if (!fs.existsSync(file)) return send(404, { error: 'not found' });
        fs.unlinkSync(file);
        return send(200, { deleted: m[1] });
      }
      if (req.method === 'POST' && (p === '/designs' || p === '/validate' || p === '/suggest')) {
        let body = '';
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) return send(413, { error: 'body too large' });
          body += chunk;
        }
        let d;
        try { d = JSON.parse(body); } catch (e) { return send(400, { error: 'invalid JSON' }); }
        if (p === '/suggest') {
          const base = typeof d.base === 'string' ? this.all().find((x) => x.id === d.base) : d.design;
          if (!base) return send(404, { error: 'base design not found' });
          const berr = validate(base);
          if (berr.length) return send(400, { ok: false, errors: berr });
          const suggestions = suggest(base, d.demand).filter((s) => !validate(s).length);
          if (d.evaluate) {
            const dem = Object.assign({}, d.demand);
            dem.durationSec = Math.min(Number(dem.durationSec) || 300, 600);
            const r = await postJson(Number(process.env.PORT || 8180), '/t/martin/compare', { designs: [base].concat(suggestions), demand: dem });
            if (r.status !== 200 || !Array.isArray(r.json.results)) return send(502, { error: 'simulation engine failed', details: r.json });
            const ranking = r.json.results.map((x) => ({ designId: x.design.id, runId: x.runId, score: Math.round(score(x.summary) * 10) / 10, delayMeanSec: x.summary.delay.meanSec, throughputVehPerHour: x.summary.throughputVehPerHour, backlog: x.summary.vehicles.backlog, co2Kg: x.summary.emissions && x.summary.emissions.co2Kg }))
              .sort((a, b) => a.score - b.score);
            return send(200, { base: base.id || null, suggestions, ranking, demand: r.json.demand });
          }
          return send(200, { base: base.id || null, suggestions });
        }
        const errors = validate(d);
        if (p === '/validate') return send(200, { ok: !errors.length, errors });
        if (errors.length) return send(400, { ok: false, errors });
        const id = d.id && ID_RE.test(d.id) ? d.id : 'user-' + Date.now().toString(36);
        if (PRESETS.some((x) => x.id === id)) return send(409, { error: 'id belongs to an existing design' });
        const saved = Object.assign({}, d, { id, origin: 'user' });
        fs.writeFileSync(path.join(this.dir, id + '.json'), JSON.stringify(saved, null, 1));
        return send(201, { id });
      }
    } catch (err) {
      console.error('[be-christian]', err && err.message);
      return send(500, { error: 'internal error' });
    }
    return false;
  },
};

module.exports.validate = validate;
