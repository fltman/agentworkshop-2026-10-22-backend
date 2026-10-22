'use strict';
const http = require('http');
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

// Calls another team's plugin on the same server.
function call(req, method, path, body) {
  return new Promise((resolve, reject) => {
    const [host, port] = String(req.headers.host || 'localhost').split(':');
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      : {};
    const r = http.request({ host, port: port || 80, method, path, headers, timeout: 30000 }, (resp) => {
      let d = '';
      resp.on('data', (c) => (d += c));
      resp.on('end', () => {
        if (resp.statusCode >= 400) return reject(new Error('upstream ' + resp.statusCode + ' from ' + path));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('upstream returned non-JSON from ' + path)); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('upstream timeout')));
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function metricsFor(req, runId) {
  if (cache.has(runId)) return cache.get(runId);
  const id = encodeURIComponent(runId);
  const ev = await call(req, 'GET', '/t/martin/runs/' + id + '/events');
  let frames = [];
  try { frames = (await call(req, 'GET', '/t/martin/runs/' + id + '/frames')).frames || []; } catch (e) { /* queues optional */ }
  let meta = {};
  try { meta = await call(req, 'GET', '/t/martin/runs/' + id); } catch (e) { /* optional */ }
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
        sendJson(res, 200, await metricsFor(req, String(runId)));
        return true;
      }
      if (req.method === 'POST' && path === '/compare') {
        const body = await readBody(req);
        let runIds = body.runIds;
        if (!runIds && body.designs && body.demand) {
          const r = await call(req, 'POST', '/t/martin/compare', { designs: body.designs, demand: body.demand });
          runIds = (r.runs || []).map((x) => x.runId || x.id);
        }
        if (!Array.isArray(runIds) || runIds.length < 2) {
          sendJson(res, 400, { error: 'need at least two runIds' });
          return true;
        }
        const runs = [];
        for (const id of runIds) runs.push(await metricsFor(req, String(id)));
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
