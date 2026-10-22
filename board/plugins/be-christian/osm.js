'use strict';
// Builds a draft intersection design from OpenStreetMap (Overpass API) around a coordinate.
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const ROAD = '^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)(_link)?$';
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();
let inflight = 0;

const rad = (d) => (d * Math.PI) / 180;

function toXY(lat0, lon0, p) {
  return { x: rad(p.lon - lon0) * 6371000 * Math.cos(rad(lat0)), y: rad(p.lat - lat0) * 6371000 };
}

// Bearing in degrees clockwise from north.
function bearing(p) { return (Math.atan2(p.x, p.y) * 180) / Math.PI + (p.x < 0 || (p.x === 0 && p.y < 0) ? 360 : 0); }

function cardinal(b) { return ['N', 'E', 'S', 'W'][Math.round((((b % 360) + 360) % 360) / 90) % 4]; }

function lanesFor(tags, inbound) {
  const n = parseInt(tags.lanes, 10);
  const fwd = parseInt(tags['lanes:forward'], 10);
  const bwd = parseInt(tags['lanes:backward'], 10);
  if (tags.oneway === 'yes' || tags.oneway === '-1') return Math.min(4, Math.max(1, n || 1));
  const own = inbound === 'forward' ? fwd : bwd;
  if (own > 0) return Math.min(4, own);
  return Math.min(4, Math.max(1, n ? Math.ceil(n / 2) : 1));
}

function laneTurns(count) {
  if (count === 1) return [{ turns: ['L', 'S', 'R'] }];
  if (count === 2) return [{ turns: ['L', 'S'] }, { turns: ['S', 'R'] }];
  const lanes = [{ turns: ['L'] }];
  for (let i = 1; i < count - 1; i++) lanes.push({ turns: ['S'] });
  lanes.push({ turns: ['S', 'R'] });
  return lanes;
}

function buildDesign(lat, lon, elements) {
  const signal = elements.some((e) => e.type === 'node' && e.tags && e.tags.highway === 'traffic_signals');
  const ways = elements.filter((e) => e.type === 'way' && e.geometry && e.geometry.length > 1);
  const roundabout = ways.some((w) => w.tags && w.tags.junction === 'roundabout');
  const candidates = [];

  for (const w of ways) {
    if (w.tags && w.tags.junction === 'roundabout') continue;
    const pts = w.geometry.map((g) => toXY(lat, lon, g));
    let ni = 0;
    pts.forEach((p, i) => { if (Math.hypot(p.x, p.y) < Math.hypot(pts[ni].x, pts[ni].y)) ni = i; });
    if (Math.hypot(pts[ni].x, pts[ni].y) > 35) continue;
    const ends = [];
    if (ni > 0) ends.push({ dir: -1, step: 'backward' });
    if (ni < pts.length - 1) ends.push({ dir: 1, step: 'forward' });
    for (const e of ends) {
      // First vertex along this direction that is at least 15 m from the centre gives a stable bearing.
      let j = ni;
      while (j + e.dir >= 0 && j + e.dir < pts.length && Math.hypot(pts[j].x, pts[j].y) < 15) j += e.dir;
      if (Math.hypot(pts[j].x, pts[j].y) < 8) continue;
      // Travelling towards the centre means moving from vertex j back to ni: against e.dir.
      const inbound = e.dir === -1 ? 'forward' : 'backward';
      const oneway = w.tags && w.tags.oneway;
      if (oneway === 'yes' && inbound === 'backward') continue;
      if (oneway === '-1' && inbound === 'forward') continue;
      candidates.push({ arm: cardinal(bearing(pts[j])), lanes: lanesFor(w.tags || {}, inbound), name: (w.tags && w.tags.name) || null, hw: w.tags && w.tags.highway });
    }
  }

  // Outbound-only arms still need an inbound lane to be valid designs; add them with one lane.
  const arms = {};
  for (const c of candidates) {
    if (!arms[c.arm] || c.lanes > arms[c.arm].lanes) arms[c.arm] = c;
  }
  const names = Object.keys(arms);
  if (names.length < 3) return { error: 'found fewer than 3 approach roads within 40 m of the point', arms: names };

  const design = {
    name: 'OSM draft ' + lat.toFixed(4) + ', ' + lon.toFixed(4),
    origin: 'user',
    type: roundabout ? 'roundabout' : signal ? 'signal' : 'priority',
    location: { lat, lon },
    arms: {},
    phases: null,
    radius: roundabout ? 18 : null,
    bannedMovements: [],
    osm: { roads: {}, attribution: 'Data from OpenStreetMap contributors (ODbL)' },
  };
  // Road centrelines in metres around the centre (x east, y north), same convention as the simulation engine.
  design.osm.geometry = ways.map((w) => ({
    name: (w.tags && w.tags.name) || null,
    highway: w.tags && w.tags.highway,
    oneway: !!(w.tags && w.tags.oneway === 'yes'),
    roundabout: !!(w.tags && w.tags.junction === 'roundabout'),
    points: w.geometry.map((g) => { const p = toXY(lat, lon, g); return [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]; }),
  }));
  for (const a of names) {
    design.arms[a] = { inLanes: laneTurns(arms[a].lanes) };
    design.osm.roads[a] = { name: arms[a].name, highway: arms[a].hw, lanes: arms[a].lanes };
  }
  if (design.type === 'signal') {
    const group = (set) => names.filter((a) => set.includes(a)).flatMap((a) => design.arms[a].inLanes.flatMap((l) => l.turns.map((t) => a + ':' + t)));
    const uniq = (l) => Array.from(new Set(l));
    const phases = [{ durationSec: 30, green: uniq(group(['N', 'S'])) }, { durationSec: 30, green: uniq(group(['E', 'W'])) }].filter((p) => p.green.length);
    design.phases = phases;
  }
  return { design };
}

async function fromOsm(lat, lon) {
  const key = lat.toFixed(4) + ',' + lon.toFixed(4);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  if (inflight >= 2) return { error: 'busy, try again in a moment', status: 429 };
  inflight++;
  try {
    const q = '[out:json][timeout:20];(way(around:50,' + lat + ',' + lon + ')[highway~"' + ROAD + '"];node(around:50,' + lat + ',' + lon + ')[highway=traffic_signals];);out geom tags;';
    let json = null;
    let status = 0;
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'agentworkshop-be-christian/1.0' },
          body: 'data=' + encodeURIComponent(q),
          signal: AbortSignal.timeout(15000),
        });
        status = res.status;
        if (res.ok) { json = await res.json(); break; }
      } catch (e) { status = 0; }
    }
    if (!json) return { error: 'Overpass unavailable (last status ' + status + ')', status: 502 };
    const v = buildDesign(lat, lon, json.elements || []);
    if (v.error) v.status = 422;
    if (cache.size > 200) cache.clear();
    cache.set(key, { t: Date.now(), v });
    return v;
  } catch (e) {
    return { error: 'Overpass unavailable: ' + (e && e.message), status: 502 };
  } finally {
    inflight--;
  }
}

module.exports = { fromOsm, buildDesign };
