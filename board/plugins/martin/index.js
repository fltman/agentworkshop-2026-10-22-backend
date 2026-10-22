'use strict';
// Team martin: simulation engine for the Stockholm Intersection Simulator.
// Contract: projects/martin/CONTRACT.md. Routes under /t/martin/.

const engine = require('./engine.js');

const MAX_RUNS = 40;
const MAX_BODY = 1024 * 1024;
const MAX_FRAMES_PER_CALL = 600;
const runs = new Map();
let runCounter = 0;

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function runPublic(r) {
  return {
    runId: r.runId, createdAt: r.createdAt, design: r.design, demand: r.demand, summary: r.summary, warnings: r.warnings, layout: r.layout,
    frameCount: r.frames.length, eventCount: r.events.length,
  };
}

function doRun(design, demand, options) {
  const out = engine.simulate(design, demand, options || {});
  if (out.errors) return { errors: out.errors };
  const runId = `r${Date.now().toString(36)}${(++runCounter).toString(36)}`;
  // Echo the full input design and demand (with defaults filled in) so consumers can check identical demand.
  const fullDesign = { ...design, ...out.design };
  const d = demand || {};
  const fullDemand = { ...d, durationSec: Number(d.durationSec) || 900, seed: d.seed == null ? 1 : Number(d.seed) | 0 };
  const r = { runId, createdAt: new Date().toISOString(), ...out, design: fullDesign, demand: fullDemand };
  runs.set(runId, r);
  while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value);
  return { run: r };
}

function num(q, k, d) {
  const v = q.get(k);
  return v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v);
}

module.exports = {
  async handle(req, res, { path }) {
    const url = new URL(req.url, 'http://x');
    const q = url.searchParams;
    const p = (path || '/').replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
      res.end();
      return true;
    }
    if (req.method === 'GET' && (p === '/' || p === '/health')) {
      send(res, 200, { ok: true, module: 'simulation-engine', team: 'martin', version: engine.VERSION, runs: runs.size, contract: 'projects/martin/CONTRACT.md' });
      return true;
    }
    if (req.method === 'GET' && p === '/examples') {
      send(res, 200, engine.examples());
      return true;
    }
    if (req.method === 'POST' && (p === '/run' || p === '/compare')) {
      let body;
      try { body = await readJson(req); } catch (e) { send(res, 400, { error: e.message }); return true; }
      if (p === '/run') {
        const { run, errors } = doRun(body.design, body.demand, body.options);
        if (errors) { send(res, 400, { error: 'invalid input', details: errors }); return true; }
        send(res, 200, runPublic(run));
        return true;
      }
      const designs = Array.isArray(body.designs) ? body.designs : null;
      if (!designs || !designs.length || designs.length > 8) { send(res, 400, { error: 'invalid input', details: ['designs must be an array of 1 to 8 designs'] }); return true; }
      const results = [];
      for (let i = 0; i < designs.length; i++) {
        const { run, errors } = doRun(designs[i], body.demand, body.options);
        if (errors) { send(res, 400, { error: 'invalid input', details: errors.map((e) => `designs[${i}]: ${e}`) }); return true; }
        results.push({ runId: run.runId, design: run.design, demand: run.demand, summary: run.summary });
      }
      send(res, 200, { demand: body.demand, results });
      return true;
    }
    if (req.method === 'GET' && p === '/runs') {
      const list = [...runs.values()].reverse().map((r) => ({ runId: r.runId, designId: r.design.id, name: r.design.name, origin: r.design.origin, type: r.design.type, createdAt: r.createdAt, summary: r.summary }));
      send(res, 200, list);
      return true;
    }
    const m = p.match(/^\/runs\/([A-Za-z0-9]+)(\/frames|\/events)?$/);
    if (req.method === 'GET' && m) {
      const r = runs.get(m[1]);
      if (!r) { send(res, 404, { error: 'unknown runId (runs are kept in memory, the last ' + MAX_RUNS + ')' }); return true; }
      const from = num(q, 'from', 0), to = num(q, 'to', Infinity);
      if (m[2] === '/frames') {
        const frames = r.frames.filter((f) => f.t >= from && f.t <= to).slice(0, MAX_FRAMES_PER_CALL);
        send(res, 200, { runId: r.runId, frames });
      } else if (m[2] === '/events') {
        const type = q.get('type');
        const events = r.events.filter((e) => e.t >= from && e.t <= to && (!type || e.type === type));
        send(res, 200, { runId: r.runId, events });
      } else send(res, 200, runPublic(r));
      return true;
    }
    return false;
  },
};
