'use strict';
const fs = require('fs');
const path = require('path');
const PRESETS = require('./presets');

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
    const lanes = arms[a] && arms[a].inLanes;
    if (!Array.isArray(lanes) || lanes.length < 1 || lanes.length > 6) { errors.push(a + ': inLanes needs 1-6 lanes'); continue; }
    lanes.forEach((l, i) => {
      if (!l || !Array.isArray(l.turns) || !l.turns.length || !l.turns.every((t) => TURNS.includes(t))) errors.push(a + ' lane ' + i + ': turns must be a non-empty subset of L,S,R');
      else l.turns.forEach((t) => movements.add(a + ':' + t));
    });
  }
  if (armCount < 3) errors.push('at least 3 arms required');
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
  return errors;
}

module.exports = {
  init(ctx) {
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
      const m = p.match(/^\/designs\/([a-z0-9-]+)$/);
      if (req.method === 'GET' && m) {
        const d = this.all().find((x) => x.id === m[1]);
        return d ? send(200, d) : send(404, { error: 'not found' });
      }
      if (req.method === 'POST' && (p === '/designs' || p === '/validate')) {
        let body = '';
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) return send(413, { error: 'body too large' });
          body += chunk;
        }
        let d;
        try { d = JSON.parse(body); } catch (e) { return send(400, { error: 'invalid JSON' }); }
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
