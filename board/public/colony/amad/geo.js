// Real arm bearings for a design (team amad).
// Bearings are compass degrees, clockwise from north, pointing AWAY from the centre (martin CONTRACT v0.4).
// Source order: design.arms[X].bearingDeg (if any arm has it) > be-christian /osm road centrelines > none (labels).
import * as api from './api.js';

export const ARMS = ['N', 'E', 'S', 'W'];
export const NOMINAL = { N: 0, E: 90, S: 180, W: 270 };
const MAX_OFF = 60;   // engine rule: within 60 deg of the label
const MIN_GAP = 30;   // engine rule: neighbours at least 30 deg apart, clockwise N, E, S, W
const LS_KEY = 'amad.bearings.v1:';
const FAIL_MS = 5 * 60 * 1000;

const norm = (b) => ((b % 360) + 360) % 360;
const diff = (a, b) => ((a - b + 540) % 360) - 180;               // signed a - b in -180..180
const cardinal = (b) => ARMS[Math.round(norm(b) / 90) % 4];       // same snap as be-christian
const compass = (x, y) => norm((Math.atan2(x, y) * 180) / Math.PI);
const circMean = (bs) => {
  const sx = bs.reduce((s, b) => s + Math.sin((b * Math.PI) / 180), 0);
  const cy = bs.reduce((s, b) => s + Math.cos((b * Math.PI) / 180), 0);
  return norm((Math.atan2(sx, cy) * 180) / Math.PI);
};

function armIdsOf(design) {
  const a = design?.arms;
  if (!a) return [];
  if (Array.isArray(a)) return ARMS.filter((id) => a.some((x) => x && x.id === id));
  return ARMS.filter((id) => a[id] && (!Array.isArray(a[id].inLanes) || a[id].inLanes.length));
}
function armOf(design, id) {
  const a = design?.arms;
  if (!a) return null;
  return Array.isArray(a) ? a.find((x) => x && x.id === id) || null : a[id] || null;
}

// Bearings per arm label from OSM centrelines (metres, x east, y north, origin at the junction).
// OSM splits ways at junction nodes, so walking a single way from its nearest vertex often stops a few metres
// out. Instead we find where every road centreline crosses circles around the centre (RINGS m): each crossing
// is a road leaving the junction. Crossings of the same street within CLUSTER deg are one road (dual
// carriageways, both rings). Roads are then assigned to the labels N/E/S/W with the engine's rules
// (within 60 deg of the label, clockwise order, >= 30 deg apart): the best-scoring assignment wins, where a
// major road scores more, a small deviation from the label scores more, and one street on opposite labels
// (a through road on N-S or E-W) gets a bonus. Plain nearest-cardinal snapping
// (be-christian's draft rule) breaks on diagonal streets: a road at 316 deg snaps to N although it is W.
const RINGS = [25, 40];
const CLUSTER = 35;
const RANK = { motorway: 0, trunk: 0, primary: 0, secondary: 1, tertiary: 2, unclassified: 3, residential: 3, living_street: 4 };
const rankOf = (hw) => { const base = String(hw || '').replace(/_link$/, ''); return (RANK[base] ?? 3) + (/_link$/.test(hw || '') ? 0.5 : 0); };

export function roadCrossings(geometry, rings = RINGS) {
  const out = [];
  for (const R of rings) {
    for (const w of Array.isArray(geometry) ? geometry : []) {
      if (!w || w.roundabout || !Array.isArray(w.points)) continue;
      const pts = w.points.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      for (let i = 0; i + 1 < pts.length; i++) {
        const [p, q] = [pts[i], pts[i + 1]];
        const dx = q[0] - p[0], dy = q[1] - p[1];
        // solve |p + t (q - p)| = R for t in [0, 1)
        const a = dx * dx + dy * dy, b = 2 * (p[0] * dx + p[1] * dy), c = p[0] * p[0] + p[1] * p[1] - R * R;
        const disc = b * b - 4 * a * c;
        if (a < 1e-9 || disc < 0) continue;
        for (const t of [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)]) {
          if (t < 0 || t >= 1) continue;
          out.push({ b: compass(p[0] + t * dx, p[1] + t * dy), rank: rankOf(w.highway), name: w.name || null, R });
        }
      }
    }
  }
  return out;
}

export function roadClusters(geometry) {
  const xs = roadCrossings(geometry).sort((p, q) => p.rank - q.rank || p.b - q.b);
  const clusters = [];
  for (const x of xs) {
    const c = clusters.find((k) => Math.abs(diff(x.b, k.b)) <= (k.name && k.name === x.name ? CLUSTER : 12));
    if (c) { c.items.push(x); c.b = circMean(c.items.map((i) => i.b)); c.rank = Math.min(c.rank, x.rank); }
    else clusters.push({ b: x.b, rank: x.rank, name: x.name, items: [x] });
  }
  return clusters;
}

const value = (c, id) => 120 - 20 * c.rank - Math.abs(diff(c.b, NOMINAL[id]));
const OPP = [[0, 2], [1, 3]];   // N-S, E-W: a through street should sit on opposite labels

export function bearingsFromGeometry(geometry) {
  const clusters = roadClusters(geometry);
  const opts = ARMS.map((id) => [null, ...clusters.filter((c) => Math.abs(diff(c.b, NOMINAL[id])) <= MAX_OFF && value(c, id) > 0)]);
  let best = null, bestScore = 0;
  const pick = [null, null, null, null];
  const walk = (k) => {
    if (k === 4) {
      const used = pick.filter(Boolean);
      if (new Set(used).size !== used.length) return;
      const eff = ARMS.map((id, i) => (pick[i] ? pick[i].b : NOMINAL[id]));
      for (let i = 0; i < 4; i++) if (norm(eff[(i + 1) % 4] - eff[i]) < MIN_GAP) return;
      const total = eff.reduce((s, b, i) => s + norm(eff[(i + 1) % 4] - b), 0);
      if (Math.round(total) !== 360) return;   // clockwise N, E, S, W order kept
      let score = pick.reduce((s, c, i) => s + (c ? value(c, ARMS[i]) : 0), 0);
      for (const [i, j] of OPP) if (pick[i] && pick[j] && pick[i].name && pick[i].name === pick[j].name) score += 25;
      if (score > bestScore) { bestScore = score; best = pick.slice(); }
      return;
    }
    for (const c of opts[k]) { pick[k] = c; walk(k + 1); }
    pick[k] = null;
  };
  walk(0);
  const out = {};
  (best || []).forEach((c, i) => { if (c) out[ARMS[i]] = Math.round(c.b * 10) / 10; });
  return out;
}

// Apply the engine's rules: within 60 deg of the label, >= 30 deg apart in clockwise order.
// Arms that break a rule fall back to their label bearing (dropped from the result).
export function sanitizeBearings(bearings, armIds) {
  const ids = (armIds && armIds.length ? armIds : ARMS).filter((id) => NOMINAL[id] != null);
  const out = {};
  for (const id of ids) {
    const b = Number(bearings?.[id]);
    if (Number.isFinite(b) && Math.abs(diff(norm(b), NOMINAL[id])) <= MAX_OFF) out[id] = norm(b);
  }
  const eff = (id) => (out[id] != null ? out[id] : NOMINAL[id]);
  for (let guard = 0; guard < 8; guard++) {
    let bad = null;
    ids.forEach((id, k) => {
      if (bad || ids.length < 2) return;
      const nx = ids[(k + 1) % ids.length];
      if (nx === id) return;
      const gap = norm(eff(nx) - eff(id));
      if (gap < MIN_GAP || gap > 360 - 1e-6) bad = [id, nx];
    });
    if (!bad) break;
    // drop the one that deviates most from its label (if both are at the label, nothing to drop)
    const dev = (id) => (out[id] == null ? -1 : Math.abs(diff(out[id], NOMINAL[id])));
    const drop = dev(bad[0]) >= dev(bad[1]) ? bad[0] : bad[1];
    if (out[drop] == null) break;
    delete out[drop];
  }
  return out;
}

// Copy of the design with arms[X].bearingDeg injected (only for arms that differ from the label by >= 0.5 deg).
export function withBearings(design, bearings) {
  if (!design || !bearings || !Object.keys(bearings).length) return design;
  const d = JSON.parse(JSON.stringify(design));
  for (const [id, b] of Object.entries(sanitizeBearings(bearings, armIdsOf(design)))) {
    const a = armOf(d, id);
    if (a && a.bearingDeg == null && Math.abs(diff(b, NOMINAL[id])) >= 0.5) a.bearingDeg = Math.round(b * 10) / 10;
  }
  return d;
}

const mem = new Map();       // key -> { bearings, geometry } | Promise
const failed = new Map();    // key -> time of the last failure (Overpass is slow, do not hammer it)

function lsGet(key) {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY + key) || 'null'); return v && v.bearings ? v : null; } catch { return null; }
}
function lsSet(key, v) {
  try { localStorage.setItem(LS_KEY + key, JSON.stringify(v)); } catch { /* quota or private mode: memory cache only */ }
}

// Trim centrelines to what can be on screen, for the debug overlay.
function trimGeometry(geometry) {
  return (Array.isArray(geometry) ? geometry : []).map((w) => ({
    name: w?.name || null, roundabout: !!w?.roundabout,
    points: (w?.points || []).filter((p) => Array.isArray(p) && Math.hypot(p[0], p[1]) < 250),
  })).filter((w) => w.points.length > 1);
}

/**
 * getArmBearings(design, anchor?) -> { bearings: {N?,E?,S?,W?}, source: 'design'|'osm'|'none', geometry, error? }
 * anchor = [lat, lon] (the map anchor, so the OSM origin matches the drawn origin); else design.location / design id.
 * Never throws: any error (502 Overpass down, 422 too few roads, offline) gives source 'none' and no bearings.
 */
export async function getArmBearings(design, anchor) {
  const ids = armIdsOf(design);
  const own = {};
  for (const id of ids) { const b = Number(armOf(design, id)?.bearingDeg); if (armOf(design, id)?.bearingDeg != null && Number.isFinite(b)) own[id] = b; }
  if (Object.keys(own).length) return { bearings: sanitizeBearings(own, ids), source: 'design', geometry: null };

  const loc = design?.location;
  const ll = anchor || (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon) ? [loc.lat, loc.lon] : null);
  if (!ll && !design?.id) return { bearings: {}, source: 'none', geometry: null, error: 'no location' };
  const key = ll ? `${ll[0].toFixed(5)},${ll[1].toFixed(5)}` : `design:${design.id}`;
  const done = (v) => ({ bearings: sanitizeBearings(v.bearings, ids), source: 'osm', geometry: v.geometry });

  const hit = mem.get(key) || lsGet(key);
  if (hit && !(hit instanceof Promise)) { mem.set(key, hit); return done(hit); }
  if (failed.has(key) && Date.now() - failed.get(key) < FAIL_MS) return { bearings: {}, source: 'none', geometry: null, error: 'OSM unavailable (cached failure)' };
  const p = hit instanceof Promise ? hit : (async () => {
    const r = await api.getOsm(ll ? { lat: ll[0], lon: ll[1] } : { design: design.id });
    const geometry = r?.design?.osm?.geometry;
    if (!Array.isArray(geometry) || !geometry.length) throw new Error('OSM answer has no osm.geometry');
    const v = { bearings: bearingsFromGeometry(geometry), geometry: trimGeometry(geometry) };
    mem.set(key, v);
    lsSet(key, v);
    return v;
  })();
  if (!(hit instanceof Promise)) mem.set(key, p);
  try {
    return done(await p);
  } catch (e) {
    mem.delete(key);
    failed.set(key, Date.now());
    return { bearings: {}, source: 'none', geometry: null, error: e?.message || String(e) };
  }
}
