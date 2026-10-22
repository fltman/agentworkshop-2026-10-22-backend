'use strict';
const { computeMetrics, compareRuns } = require('./metrics');

const fs = require('fs');
const nodePath = require('path');

const cache = new Map(); // runId -> metrics
let flowsCache = null;

// Measured Stockholm flows, extracted from the open GPKG flow maps into data/realflows.json
function realFlows() {
  if (!flowsCache) flowsCache = JSON.parse(fs.readFileSync(nodePath.join(__dirname, 'data', 'realflows.json'), 'utf8'));
  return flowsCache;
}

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

// Indicative measured inbound flow: busiest segment per street near the junction, 06-18 average per hour.
function observedFor(id) {
  const item = realFlows().intersections[id];
  if (!item) return null;
  const byStreet = {};
  for (const m of item.motor) {
    if (m.distM > 60 || !m.veh06_18 || m.street === 'Okänd gata') continue;
    byStreet[m.street] = Math.max(byStreet[m.street] || 0, m.veh06_18);
  }
  const streets = Object.entries(byStreet).map(([street, v]) => ({ street, vehPerHour: Math.round(v / 12) }));
  return { streets, inboundVehPerHour: streets.reduce((s, x) => s + x.vehPerHour, 0) };
}

function calibrationFor(out) {
  const id = out.design && out.design.id;
  const obs = id && observedFor(id);
  if (!obs || !obs.inboundVehPerHour) return null;
  const arms = (out.demand && out.demand.arms) || {};
  const demandVph = Object.values(arms).reduce((s, a) => s + (a.vehPerHour || 0), 0);
  const ratio = (x) => (x ? Math.round((x / obs.inboundVehPerHour) * 100) / 100 : null);
  return {
    intersection: id,
    observedInboundVehPerHour: obs.inboundVehPerHour,
    observedStreets: obs.streets,
    demandVehPerHour: Math.round(demandVph),
    demandVsObserved: ratio(demandVph),
    simulatedThroughputPerHour: out.throughput.perHour,
    throughputVsObserved: ratio(out.throughput.perHour),
    note: 'Indicative: measured is the 06-18 average of the busiest segment per street within 60 m; demand is for the simulated hour. Ratios near 1 mean realistic.',
  };
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
    computeMetrics(ev.events, frames, durationSec, meta.summary)
  );
  out.calibration = calibrationFor(out);
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
      if (req.method === 'GET' && path === '/realflows') {
        const id = new URL(req.url, 'http://x').searchParams.get('intersection');
        const all = realFlows();
        if (!id) { sendJson(res, 200, { source: all.source, intersections: Object.keys(all.intersections) }); return true; }
        if (!all.intersections[id]) { sendJson(res, 404, { error: 'no measured flows for ' + id }); return true; }
        sendJson(res, 200, Object.assign({ source: all.source }, all.intersections[id]));
        return true;
      }
      if (req.method === 'POST' && path === '/metrics') {
        const { runId } = await readBody(req);
        if (!runId) { sendJson(res, 400, { error: 'runId required' }); return true; }
        sendJson(res, 200, await metricsFor(String(runId)));
        return true;
      }
      if (req.method === 'POST' && path === '/compare-types') {
        const body = await readBody(req);
        const id = String(body.intersection || '');
        if (!/^[a-z0-9-]+$/.test(id)) { sendJson(res, 400, { error: 'intersection id required' }); return true; }
        const seed = Number(body.seed) || 7;
        const dur = Math.min(Number(body.durationSec) || 300, 600);
        const hour = Number.isInteger(body.hour) ? body.hour : 8;
        const demand = body.demand || (await call('GET', '/t/backend/demand?intersection=' + id + '&hour=' + hour + '&durationSec=' + dur + '&seed=' + seed));
        const base = await call('GET', '/t/be-christian/designs/' + id);
        const sug = await call('POST', '/t/be-christian/suggest', { design: base, demand });
        // one variant per junction type, the base design keeps its own type
        const byType = {};
        byType[base.type] = base;
        for (const d of sug.suggestions || []) if (d.type && !byType[d.type]) byType[d.type] = d;
        const types = Object.keys(byType);
        if (types.length < 2) { sendJson(res, 422, { error: 'no alternative junction types available for ' + id }); return true; }
        const r = await call('POST', '/t/martin/compare', { designs: types.map((t) => byType[t]), demand });
        const ids = (r.results || r.runs || []).map((x) => x.runId || x.id);
        const runs = [];
        for (let i = 0; i < ids.length; i++) runs.push(Object.assign({ junctionType: types[i] }, await metricsFor(ids[i])));
        const cmp = compareRuns(runs);
        const typeOf = (runId) => (runs.find((x) => x.runId === runId) || {}).junctionType || null;
        const bestType = {};
        for (const [k, v] of Object.entries(cmp.best)) bestType[k] = typeOf(v);
        sendJson(res, 200, { intersection: id, baseType: base.type, demand: runs[0].demand, runs, best: cmp.best, bestType, ranking: cmp.ranking, rankingTypes: cmp.ranking.map(typeOf) });
        return true;
      }
      if (req.method === 'POST' && path === '/compare') {
        const body = await readBody(req);
        let runIds = body.runIds;
        if (!runIds && body.designs && body.demand) {
          const r = await call('POST', '/t/martin/compare', { designs: body.designs, demand: body.demand });
          runIds = (r.results || r.runs || []).map((x) => x.runId || x.id);
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
