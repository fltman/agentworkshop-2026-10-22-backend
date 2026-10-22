// amad UI API client: plain ES module, same-origin, no deps.
const ROOT = (() => {
  const m = location.pathname.match(/^(.*?)\/colony\//);
  return m ? m[1] : '';
})();
const T = (team) => `${ROOT}/t/${team}`;

async function call(team, path, { method = 'GET', body, query } = {}) {
  let url = T(team) + path;
  if (query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
    const s = q.toString();
    if (s) url += '?' + s;
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error(`[${team}] network error calling ${method} ${url}: ${e.message}`);
    err.team = team; err.status = 0; err.body = null;
    throw err;
  }
  const text = await res.text();
  let data = null;
  let parseFailed = false;
  if (text) { try { data = JSON.parse(text); } catch { parseFailed = true; } }
  if (!res.ok) {
    const err = new Error(`[${team}] ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    err.team = team; err.status = res.status; err.body = data ?? text;
    throw err;
  }
  if (parseFailed) {
    const err = new Error(`[${team}] ${method} ${path} returned malformed JSON: ${text.slice(0, 200)}`);
    err.team = team; err.status = res.status; err.body = text;
    throw err;
  }
  return data;
}

// backend (traffic data)
export const listIntersections = async () => {
  const r = await call('backend', '/intersections');
  return Array.isArray(r) ? r : (r?.intersections ?? []);
};
export const getIntersection = (id) => call('backend', `/intersections/${encodeURIComponent(id)}`);
export const getDemand = (intersection, hour, durationSec, seed, scale = 1, day = 'weekday') =>
  call('backend', '/demand', { query: { intersection, day, hour, durationSec, seed, scale } });
// overrides: { E: { vehPerHour, turning:{L,S,R}, mix:{car,bus,truck}, pedPerHour, bikePerHour } }
// Backend validates and normalises turning/mix; answer has the same demand shape as getDemand.
export const postDemand = ({ intersection, day = 'weekday', hour, durationSec, seed, scale = 1, overrides } = {}) =>
  call('backend', '/demand', { method: 'POST', body: { intersection, day, hour, durationSec, seed, scale, overrides } });

// be-christian (designs); tolerate {design:..} / {designs:[..]} / bare
const unwrapDesign = (r) => (r && r.design && typeof r.design === 'object' ? r.design : r);
export const listDesigns = async (origin) => {
  const r = await call('be-christian', '/designs', { query: { origin } });
  return Array.isArray(r) ? r : (r?.designs ?? []);
};
export const getDesign = async (id) => unwrapDesign(await call('be-christian', `/designs/${encodeURIComponent(id)}`));
export const saveDesign = (design) => call('be-christian', '/designs', { method: 'POST', body: design });
export const validateDesign = (design) => call('be-christian', '/validate', { method: 'POST', body: design });
export const suggestDesigns = async (design, demand) => {
  const r = await call('be-christian', '/suggest', { method: 'POST', body: { design, demand } });
  return Array.isArray(r) ? r : (r?.suggestions ?? []);
};

// martin (simulation)
export const runSim = (design, demand) => call('martin', '/run', { method: 'POST', body: { design, demand } });
export const getFrames = async (runId, from, to) => {
  const r = await call('martin', `/runs/${encodeURIComponent(runId)}/frames`, { query: { from, to } });
  return Array.isArray(r) ? r : (r?.frames ?? []);
};
export const getEvents = async (runId, { type, from, to } = {}) => {
  const r = await call('martin', `/runs/${encodeURIComponent(runId)}/events`, { query: { type, from, to } });
  return Array.isArray(r) ? r : (r?.events ?? []);
};
export const compareRuns = (designs, demand) => call('martin', '/compare', { method: 'POST', body: { designs, demand } });

// per (metrics)
export const getMetrics = (runId) => call('per', '/metrics', { method: 'POST', body: { runId } });
export const compareMetrics = (runIds) => call('per', '/compare', { method: 'POST', body: { runIds } });

export async function checkModules() {
  const probes = { backend: '/intersections', 'be-christian': '/designs', martin: '/', per: '/runs' };
  const out = {};
  await Promise.all(Object.entries(probes).map(async ([team, p]) => {
    try {
      const res = await fetch(T(team) + p);
      let down = res.status === 502 || res.status === 503 || res.status === 504;
      if (res.status === 404) down = /no plugin/i.test(await res.text());
      out[team] = { reachable: !down, status: res.status };
    } catch (e) {
      out[team] = { reachable: false, status: 0, error: e.message };
    }
  }));
  return out;
}
