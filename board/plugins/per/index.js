'use strict';
const { computeMetrics, compareRuns } = require('./metrics');

const cache = new Map(); // runId -> metrics

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Calls another team's plugin on this server, always via loopback (never from request headers).
async function call(method, path, body) {
  const base = 'http://127.0.0.1:' + (process.env.PORT || 8180);
  const opts = { method, headers: {}, signal: AbortSignal.timeout(30000) };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(base + path, opts);
  if (!resp.ok) throw new Error('upstream ' + resp.status + ' from ' + path);
  try { return await resp.json(); } catch (e) { throw new Error('upstream returned non-JSON from ' + path); }
}

async function metricsFor(runId) {
  if (cache.has(runId)) return cache.get(runId);
  const id = encodeURIComponent(runId);
  const ev = await call('GET', '/t/martin/runs/' + id + '/events');
  let frames = [];
  try { frames = (await call('GET', '/t/martin/runs/' + id + '/frames')).frames || []; } catch (e) { /* queues optional */ }
  let meta = {};
  try { meta = await call('GET', '/t/martin/runs/' + id); } catch (e) { /* optional */ }
  const durationSec = meta.durationSec || (meta.demand && meta.demand.durationSec);
  const out = Object.assign(
    { runId, design: meta.design || null, demand: meta.demand || null },
    computeMetrics(ev.events, frames, durationSec)
  );
  cache.set(runId, out);
  return out;
}

module.exports = {
  async handle(req, res, ctx) {
    const path = ctx.path || '/';
    try {
      if (req.method === 'GET' && (path === '/' || path === '/runs')) {
        sendJson(res, 200, { runs: Array.from(cache.values()) });
        return true;
      }
      if (req.method === 'POST' && path === '/metrics') {
        const { runId } = await readBody(req);
        if (!runId) { sendJson(res, 400, { error: 'runId required' }); return true; }
        sendJson(res, 200, await metricsFor(String(runId)));
        return true;
      }
      if (req.method === 'POST' && path === '/compare') {
        const body = await readBody(req);
        let runIds = body.runIds;
        if (!runIds && body.designs && body.demand) {
          const r = await call('POST', '/t/martin/compare', { designs: body.designs, demand: body.demand });
          runIds = (r.runs || []).map((x) => x.runId || x.id);
        }
        if (!Array.isArray(runIds) || runIds.length < 2) {
          sendJson(res, 400, { error: 'need at least two runIds' });
          return true;
        }
        const runs = [];
        for (const id of runIds) runs.push(await metricsFor(String(id)));
        const base = JSON.stringify(runs[0].demand);
        if (runs.some((r) => JSON.stringify(r.demand) !== base)) {
          sendJson(res, 400, { error: 'runs differ in demand or seed; not comparable' });
          return true;
        }
        sendJson(res, 200, Object.assign({ demand: runs[0].demand, runs }, compareRuns(runs)));
        return true;
      }
    } catch (err) {
      sendJson(res, 502, { error: String(err && err.message) });
      return true;
    }
    return false;
  },
};
