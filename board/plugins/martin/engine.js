'use strict';
// Stockholm Intersection Simulator - simulation engine (team martin).
// Pure, deterministic microsimulation: design + demand + seed -> summary, frames, events.
// No I/O here; index.js wraps it in HTTP.

const VERSION = '0.5.1';
const ARMS = ['N', 'E', 'S', 'W'];
const TURNS = ['L', 'S', 'R'];
const TURN_RANK = { S: 3, R: 2, L: 1 };

const CLASSES = {
  car:   { len: 4.5, aMax: 1.5, b: 2.0, T: 1.2, s0: 2.0, e0: 0.5, e1: 0.12, e2: 0.05 },
  bus:   { len: 12,  aMax: 1.0, b: 1.5, T: 1.5, s0: 2.5, e0: 2.0, e1: 0.90, e2: 0.40 },
  truck: { len: 10,  aMax: 0.8, b: 1.5, T: 1.6, s0: 2.5, e0: 1.8, e1: 0.75, e2: 0.35 },
  bike:  { len: 1.8, aMax: 1.0, b: 1.5, T: 1.0, s0: 1.0, e0: 0,   e1: 0,    e2: 0, vMax: 5 },
};

// ---------------------------------------------------------------- helpers

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed, salt) {
  let h = (Number(seed) | 0) ^ 0x9E3779B9;
  for (let i = 0; i < salt.length; i++) h = Math.imul(h ^ salt.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const vec = (deg) => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180)];
const rightOf = ([x, y]) => [y, -x];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];

function exitArmOf(arm, turn) {
  const i = ARMS.indexOf(arm);
  return ARMS[(i + (turn === 'L' ? 1 : turn === 'S' ? 2 : 3)) % 4];
}

function pickWeighted(u, weights) {
  const keys = Object.keys(weights);
  let sum = 0;
  for (const k of keys) sum += weights[k];
  let x = u * sum;
  for (const k of keys) { x -= weights[k]; if (x <= 0) return k; }
  return keys[keys.length - 1];
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function makePath(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  return { points, cum, length: cum[cum.length - 1] };
}

function pointAt(path, s) {
  const { points, cum } = path;
  if (s <= 0) s = 0;
  if (s >= path.length) s = path.length - 1e-6;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const seg = cum[hi] - cum[lo] || 1;
  const f = (s - cum[lo]) / seg;
  const a = points[lo], b = points[hi];
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, h: Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI };
}

function segIntersect(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

// First distance along `path` (between sFrom and sTo) where it crosses polyline `pts`.
// The polyline without its last `d` meters, so paths that only meet at the exit do not count as crossing.
// (Dropping the last point instead left straight paths, which have two box points, with no segment at all.)
function trimEnd(pts, d) {
  const out = pts.slice();
  while (out.length >= 2) {
    const a = out[out.length - 2], b = out[out.length - 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L > d) { const k = (L - d) / L; out[out.length - 1] = [a[0] + k * (b[0] - a[0]), a[1] + k * (b[1] - a[1])]; return out; }
    out.pop(); d -= L;
  }
  return out;
}

function crossingS(path, sFrom, sTo, pts) {
  const { points, cum } = path;
  for (let i = 1; i < points.length; i++) {
    if (cum[i] < sFrom || cum[i - 1] > sTo) continue;
    for (let j = 1; j < pts.length; j++) {
      const t = segIntersect(points[i - 1], points[i], pts[j - 1], pts[j]);
      if (t !== null) {
        const s = cum[i - 1] + t * (cum[i] - cum[i - 1]);
        if (s >= sFrom && s <= sTo) return s;
      }
    }
  }
  return null;
}

function quadBezier(p0, c, p1, n) {
  const out = [];
  for (let i = 1; i < n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
  return out;
}

function lineIntersection(p, d, q, e) {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

// ---------------------------------------------------------------- validation / normalisation

function defaultInLanes(n) {
  if (n <= 1) return [['L', 'S', 'R']];
  if (n === 2) return [['L', 'S'], ['S', 'R']];
  const lanes = [['L']];
  for (let i = 1; i < n - 1; i++) lanes.push(['S']);
  lanes.push(['S', 'R']);
  return lanes;
}

// Accept common variants of the design shape (arms as a map, lanes as {turns}, top-level phases/radius).
function canonicalDesign(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const d = { ...raw };
  if (d.arms && !Array.isArray(d.arms) && typeof d.arms === 'object') {
    d.arms = Object.entries(d.arms).map(([id, a]) => ({ id, ...(a || {}) }));
  }
  if (Array.isArray(d.arms)) {
    d.arms = d.arms.map((a) => {
      if (!a || !Array.isArray(a.inLanes)) return a;
      return { ...a, inLanes: a.inLanes.map((l) => (l && !Array.isArray(l) && typeof l === 'object' ? l.turns : l)) };
    });
  }
  if (!d.signal && Array.isArray(d.phases)) {
    d.signal = { phases: d.phases.map((p) => ({
      green: p.green != null && !Array.isArray(p.green) ? p.green : p.durationSec,
      amber: p.amber, allRed: p.allRed,
      movements: p.movements || (Array.isArray(p.green) ? p.green : []),
    })) };
  }
  if (!d.roundabout && d.radius != null) d.roundabout = { radius: d.radius };
  return d;
}

function normalizeDesign(raw, errors) {
  raw = canonicalDesign(raw);
  const d = raw && typeof raw === 'object' ? raw : {};
  if (!raw || typeof raw !== 'object') errors.push('design must be an object');
  const type = d.type || 'signal';
  if (!['signal', 'roundabout', 'priority'].includes(type)) errors.push('design.type must be signal, roundabout or priority');
  const laneWidth = Number(d.laneWidth) || 3.5;
  if (laneWidth < 2.5 || laneWidth > 5) errors.push('design.laneWidth must be 2.5 to 5');
  const rawArms = Array.isArray(d.arms) ? d.arms : [];
  if (!Array.isArray(d.arms)) errors.push('design.arms must be an array or a map of N, E, S, W');
  const arms = {};
  rawArms.forEach((a, i) => {
    if (!a || !ARMS.includes(a.id)) { errors.push(`arms[${i}].id must be N, E, S or W`); return; }
    if (arms[a.id]) { errors.push(`arms[${i}].id ${a.id} appears twice`); return; }
    let inLanes = a.inLanes;
    if (typeof inLanes === 'number') inLanes = defaultInLanes(inLanes);
    if (!Array.isArray(inLanes) || !inLanes.length) inLanes = defaultInLanes(1);
    inLanes = inLanes.map((l) => (Array.isArray(l) ? l : [l]).filter((t) => TURNS.includes(t)));
    if (inLanes.length > 4) errors.push(`arms[${i}].inLanes: at most 4 lanes`);
    if (inLanes.some((l) => !l.length)) errors.push(`arms[${i}].inLanes: every lane needs at least one of L, S, R`);
    const outLanes = Math.max(1, Math.min(4, Number(a.outLanes) || inLanes.length));
    const speedLimit = Number(a.speedLimit) || 50;
    if (speedLimit < 10 || speedLimit > 110) errors.push(`arms[${i}].speedLimit must be 10 to 110 km/h`);
    const length = Number(a.length) || 150;
    if (length < 40 || length > 600) errors.push(`arms[${i}].length must be 40 to 600 m`);
    // Optional real-world compass bearing of the arm (clockwise from north). Turns still follow the N/E/S/W labels.
    const nominal = { N: 0, E: 90, S: 180, W: 270 }[a.id];
    let bearing = nominal;
    if (a.bearingDeg != null) {
      bearing = ((Number(a.bearingDeg) % 360) + 360) % 360;
      const off = ((bearing - nominal + 540) % 360) - 180;
      if (!Number.isFinite(off) || Math.abs(off) > 60) errors.push(`arms[${i}].bearingDeg must be within 60 degrees of ${nominal} for arm ${a.id}`);
    }
    arms[a.id] = {
      id: a.id, inLanes, outLanes, speedLimit, v0: speedLimit / 3.6, length, bearing, angle: 90 - bearing <= -180 ? 450 - bearing : 90 - bearing,
      crosswalk: a.crosswalk !== false, bikeLane: a.bikeLane !== false,
    };
  });
  const armIds = ARMS.filter((id) => arms[id]);
  if (armIds.length < 2 && Array.isArray(d.arms)) errors.push('design needs at least 2 arms');
  if (armIds.length >= 2) {
    let total = 0;
    armIds.forEach((id, k) => {
      const gap = (arms[armIds[(k + 1) % armIds.length]].bearing - arms[id].bearing + 360) % 360;
      total += gap;
      if (gap < 30 && armIds.length > 1) errors.push(`arms ${id} and ${armIds[(k + 1) % armIds.length]} must be at least 30 degrees apart, in clockwise N, E, S, W order`);
    });
    if (Math.round(total) !== 360 && !errors.some((e) => e.includes('30 degrees'))) errors.push('arm bearings must keep the clockwise N, E, S, W order');
  }
  const banned = new Set(Array.isArray(d.bannedMovements) ? d.bannedMovements : []);
  for (const b of banned) if (!/^[NESW]:[LSR]$/.test(b)) errors.push(`bannedMovements: bad movement id ${b}`);

  let phases = null;
  if (type === 'signal') {
    const rp = d.signal && Array.isArray(d.signal.phases) ? d.signal.phases : null;
    if (rp && rp.length) {
      phases = rp.map((p, i) => {
        const green = Number(p.green), amber = p.amber == null ? 3 : Number(p.amber), allRed = p.allRed == null ? 2 : Number(p.allRed);
        if (!(green >= 3 && green <= 180)) errors.push(`signal.phases[${i}].green must be 3 to 180 s`);
        if (!(amber >= 0 && amber <= 6)) errors.push(`signal.phases[${i}].amber must be 0 to 6 s`);
        if (!(allRed >= 0 && allRed <= 10)) errors.push(`signal.phases[${i}].allRed must be 0 to 10 s`);
        const mv = Array.isArray(p.movements) ? p.movements : [];
        for (const m of mv) if (!/^([NESW]:[LSR]|ped:[NESW])$/.test(m)) errors.push(`signal.phases[${i}]: bad movement id ${m}`);
        return { green, amber, allRed, movements: new Set(mv) };
      });
    } else {
      const ns = [], ew = [];
      for (const a of ['N', 'S']) for (const t of TURNS) ns.push(`${a}:${t}`);
      for (const a of ['E', 'W']) for (const t of TURNS) ew.push(`${a}:${t}`);
      phases = [
        { green: 30, amber: 3, allRed: 2, movements: new Set(ns) },
        { green: 30, amber: 3, allRed: 2, movements: new Set(ew) },
      ];
    }
    // Pedestrians: if no phase mentions ped:*, walk with the parallel straight movements.
    if (phases.every((p) => ![...p.movements].some((m) => m.startsWith('ped:')))) {
      for (const p of phases) {
        if (p.movements.has('E:S') || p.movements.has('W:S')) { p.movements.add('ped:N'); p.movements.add('ped:S'); }
        if (p.movements.has('N:S') || p.movements.has('S:S')) { p.movements.add('ped:E'); p.movements.add('ped:W'); }
      }
    }
  }
  let radius = 15, ringLanes = 1;
  if (type === 'roundabout') {
    radius = Number(d.roundabout && d.roundabout.radius) || 15;
    if (radius < 8 || radius > 40) errors.push('roundabout.radius must be 8 to 40 m');
    const rl = d.roundabout && (d.roundabout.lanes != null ? d.roundabout.lanes : d.roundabout.circulatingLanes);
    ringLanes = rl == null ? 1 : Number(rl);
    if (ringLanes !== 1 && ringLanes !== 2) errors.push('roundabout.lanes must be 1 or 2');
    else if (ringLanes === 2 && radius < 12) errors.push('a 2-lane roundabout needs roundabout.radius of at least 12 m');
  }
  const major = new Set(d.priority && Array.isArray(d.priority.major) ? d.priority.major : ['N', 'S']);

  return {
    id: String(d.id || 'design'), name: String(d.name || d.id || 'Unnamed design'),
    origin: d.origin === 'existing' ? 'existing' : 'user',
    type, laneWidth, arms, armIds, banned, phases, radius, ringLanes, major,
  };
}

function normalizeDemand(raw, design, errors, warnings = []) {
  const d = raw && typeof raw === 'object' ? raw : {};
  if (!raw || typeof raw !== 'object') errors.push('demand must be an object');
  const durationSec = Number(d.durationSec) || 900;
  if (durationSec < 60 || durationSec > 7200) errors.push('demand.durationSec must be 60 to 7200');
  const seed = d.seed == null ? 1 : Number(d.seed) | 0;
  const arms = normalizeArms(d.arms, design, errors, warnings, 'demand.arms');
  // Optional time-varying demand: schedule [{ atSec, arms }] replaces the arm rates from atSec on.
  const steps = [{ atSec: 0, arms }];
  if (d.schedule != null) {
    if (!Array.isArray(d.schedule) || d.schedule.length > 48) errors.push('demand.schedule must be an array of at most 48 steps');
    else {
      d.schedule.forEach((st, i) => {
        const at = Number(st && st.atSec);
        if (!(at >= 0) || at < steps[steps.length - 1].atSec || (at === steps[steps.length - 1].atSec && i > 0)) { errors.push(`demand.schedule[${i}].atSec must be >= 0 and increasing`); return; }
        const stepArms = normalizeArms(st.arms, design, errors, warnings, `demand.schedule[${i}].arms`);
        if (at === 0) steps[0] = { atSec: 0, arms: stepArms }; else steps.push({ atSec: at, arms: stepArms });
      });
    }
  }
  return { durationSec, seed, arms: steps[0].arms, steps };
}

function normalizeArms(srcArms, design, errors, warnings, where) {
  const arms = {};
  const warn = (m) => { if (!warnings.includes(m)) warnings.push(m); };
  const src = srcArms && typeof srcArms === 'object' ? srcArms : {};
  for (const id of design.armIds) {
    const a = src[id] || {};
    const num = (x, name, max) => {
      const v = x == null ? 0 : Number(x);
      if (!(v >= 0 && v <= max)) { errors.push(`${where}.${id}.${name} must be 0 to ${max}`); return 0; }
      return v;
    };
    const vehPerHour = num(a.vehPerHour, 'vehPerHour', 3000);
    const pedPerHour = num(a.pedPerHour, 'pedPerHour', 3000);
    const bikePerHour = num(a.bikePerHour, 'bikePerHour', 2000);
    const arm = design.arms[id];
    const reachable = new Set(arm.inLanes.flat());
    const allowed = (t) => design.arms[exitArmOf(id, t)] && !design.banned.has(`${id}:${t}`);
    const turning = {}, bikeTurning = {};
    const tw = a.turning || { L: 0.2, S: 0.6, R: 0.2 };
    for (const t of TURNS) {
      const w = Number(tw[t]) || 0;
      if (w < 0) errors.push(`${where}.${id}.turning.${t} must be >= 0`);
      if (w > 0 && allowed(t)) { bikeTurning[t] = w; if (reachable.has(t)) turning[t] = w; }
      if (w > 0 && vehPerHour > 0) {
        if (!design.arms[exitArmOf(id, t)]) warn(`${id}:${t} has demand but the design has no arm ${exitArmOf(id, t)}; spread over the other turns`);
        else if (design.banned.has(`${id}:${t}`)) warn(`${id}:${t} is banned; its demand is spread over the other turns`);
        else if (!reachable.has(t)) warn(`${id}:${t} has demand but no lane on arm ${id} allows ${t}; spread over the other turns`);
        else if (design.phases && !design.phases.some((p) => p.movements.has(`${id}:${t}`))) warn(`${id}:${t} never gets green in any phase; vehicles will wait forever`);
      }
    }
    const mix = {};
    const mw = a.mix || { car: 0.9, bus: 0.04, truck: 0.06 };
    for (const c of ['car', 'bus', 'truck']) { const w = Number(mw[c]) || 0; if (w > 0) mix[c] = w; }
    if (!Object.keys(mix).length) mix.car = 1;
    arms[id] = {
      vehPerHour: Object.keys(turning).length ? vehPerHour : 0, turning, mix,
      pedPerHour: arm.crosswalk ? pedPerHour : 0,
      bikePerHour: arm.bikeLane && Object.keys(bikeTurning).length ? bikePerHour : 0, bikeTurning,
    };
  }
  return arms;
}

// ---------------------------------------------------------------- geometry

function buildGeometry(design) {
  const W = design.laneWidth;
  const geo = { paths: {}, crosswalks: {} };
  let maxHalf = 0;
  for (const id of design.armIds) {
    const a = design.arms[id];
    const bk = a.bikeLane ? 0.6 : 0;
    maxHalf = Math.max(maxHalf, (a.inLanes.length + bk) * W, (a.outLanes + bk) * W);
  }
  const box = maxHalf + 1;
  const isRb = design.type === 'roundabout';
  const R = design.radius;
  // Arms meeting at a sharp angle need the stop lines further out so the approaches do not overlap.
  let minGap = 90;
  design.armIds.forEach((id, k) => {
    const next = design.armIds[(k + 1) % design.armIds.length];
    if (next !== id) minGap = Math.min(minGap, (design.arms[next].bearing - design.arms[id].bearing + 360) % 360);
  });
  const sharp = box / Math.tan((Math.max(30, minGap) * Math.PI) / 360);
  const stopDist = isRb ? Math.max(R + W * 1.2 + 6, sharp + 4) : Math.max(box + 4, sharp + 4);
  geo.stopDist = stopDist;
  geo.box = box;

  for (const id of design.armIds) {
    const a = design.arms[id];
    if (!a.crosswalk) continue;
    const u = vec(design.arms[id].angle);
    const inRight = rightOf(mul(u, -1));
    const outRight = rightOf(u);
    const halfIn = (a.inLanes.length + (a.bikeLane ? 0.6 : 0)) * W;
    const halfOut = (a.outLanes + (a.bikeLane ? 0.6 : 0)) * W;
    const c = mul(u, stopDist - 2.5);
    geo.crosswalks[id] = [add(c, mul(inRight, halfIn + 0.5)), add(c, mul(outRight, halfOut + 0.5))];
  }

  for (const from of design.armIds) {
    const a = design.arms[from];
    const u = vec(design.arms[from].angle);
    const inDir = mul(u, -1);
    const inRight = rightOf(inDir);
    const lanesSpec = a.inLanes.map((turns, i) => ({ key: i, turns, off: W * (i + 0.5) }));
    if (a.bikeLane) lanesSpec.push({ key: 'bike', turns: TURNS, off: W * a.inLanes.length + 0.9 });
    for (const lane of lanesSpec) {
      for (const turn of lane.turns) {
        const to = exitArmOf(from, turn);
        const b = design.arms[to];
        if (!b) continue;
        const v = vec(design.arms[to].angle);
        const outRight = rightOf(v);
        let outLane;
        if (lane.key === 'bike') outLane = null;
        else if (turn === 'R') outLane = b.outLanes - 1;
        else if (turn === 'L') outLane = 0;
        else outLane = Math.min(b.outLanes - 1, Math.round(lane.key * (b.outLanes - 1) / Math.max(1, a.inLanes.length - 1)));
        const outOff = outLane === null ? W * b.outLanes + 0.9 : W * (outLane + 0.5);
        const start = add(mul(u, stopDist + a.length), mul(inRight, lane.off));
        const stop = add(mul(u, stopDist), mul(inRight, lane.off));
        const exit = add(mul(v, stopDist), mul(outRight, outOff));
        const end = add(mul(v, stopDist + 100), mul(outRight, outOff));
        let mid, ringLane = null, ringR = 0;
        if (isRb) {
          // Counter-clockwise ring (right-hand traffic).
          // Two-lane ring: the leftmost entry lane of a multi-lane arm circulates on the inner lane.
          ringLane = lane.key === 'bike' ? 'bike' : (design.ringLanes === 2 && a.inLanes.length > 1 && lane.key === 0 ? 1 : 0);
          ringR = ringLane === 'bike' ? R + W * 1.2 : R - (ringLane === 1 ? W : 0);
          const thIn = Math.atan2(u[1], u[0]) + Math.min(0.6, (lane.off + 2) / ringR);
          let thOut = Math.atan2(v[1], v[0]) - Math.min(0.6, (outOff + 2) / ringR);
          while (thOut <= thIn + 0.2) thOut += 2 * Math.PI;
          mid = [];
          const n = Math.max(6, Math.ceil((thOut - thIn) * ringR / 2));
          for (let i = 0; i <= n; i++) {
            const th = thIn + (thOut - thIn) * i / n;
            mid.push([ringR * Math.cos(th), ringR * Math.sin(th)]);
          }
        } else if (turn === 'S') {
          mid = [];
        } else {
          const c = lineIntersection(stop, inDir, exit, mul(v, -1)) || mul(add(stop, exit), 0.5);
          mid = quadBezier(stop, c, exit, 10);
        }
        const path = makePath([start, stop, ...mid, exit, end]);
        if (isRb) {
          const last = mid[mid.length - 1];
          path.thRingStart = Math.atan2(mid[0][1], mid[0][0]);
          path.thRingEnd = Math.atan2(last[1], last[0]);
          path.ringLane = ringLane; path.ringR = ringR;
        }
        path.sStop = a.length;
        path.sExit = path.length - 100;
        if (isRb) {
          path.sRingStart = a.length + Math.hypot(mid[0][0] - stop[0], mid[0][1] - stop[1]);
          const last = mid[mid.length - 1];
          path.sRingEnd = path.sExit - Math.hypot(exit[0] - last[0], exit[1] - last[1]);
        }
        path.from = from; path.to = to; path.turn = turn; path.lane = lane.key;
        path.key = `${from}:${turn}:${lane.key}`;
        path.movement = `${from}:${turn}`;
        path.isBike = lane.key === 'bike';
        path.outKey = path.isBike ? `bikeout:${to}` : `out:${to}:${outLane}`;
        path.inKey = path.isBike ? `bikein:${from}` : `in:${from}:${lane.key}`;
        geo.paths[path.key] = path;
      }
    }
  }

  const pathList = Object.values(geo.paths);
  for (const p of pathList) {
    p.cross = {};
    for (const [arm, cw] of Object.entries(geo.crosswalks)) {
      const s = crossingS(p, p.sStop - 3, p.sExit + 3, cw);
      if (s !== null) { p.cross[arm] = s; const q = pointAt(p, s); (p.crossPt || (p.crossPt = {}))[arm] = [q.x, q.y]; }
    }
    p.boxPts = p.points.filter((_, k) => p.cum[k] >= p.sStop - 0.01 && p.cum[k] <= p.sExit + 0.01);
  }
  // Conflicts between movements: box parts cross, or they merge into the same exit lane.
  geo.conflict = {};
  geo.crosses = {};
  for (const p of pathList) { geo.conflict[p.key] = new Set(); geo.crosses[p.key] = new Set(); }
  for (let i = 0; i < pathList.length; i++) {
    for (let j = i + 1; j < pathList.length; j++) {
      const p = pathList[i], q = pathList[j];
      if (p.from === q.from) continue;
      const crosses = crossingS(p, p.sStop, p.sExit - 0.5, trimEnd(q.boxPts, 0.5)) !== null;
      if (crosses || p.outKey === q.outKey) { geo.conflict[p.key].add(q.key); geo.conflict[q.key].add(p.key); }
      if (crosses) { geo.crosses[p.key].add(q.key); geo.crosses[q.key].add(p.key); }
    }
  }
  return geo;
}

function layoutOf(design, geo) {
  const paths = {};
  for (const [k, p] of Object.entries(geo.paths)) {
    const pts = p.points.filter((_, i) => i === 0 || i === p.points.length - 1 || p.points.length < 12 || i % 2 === 0);
    paths[k] = pts.map(([x, y]) => [r2(x), r2(y)]);
  }
  return {
    type: design.type, laneWidth: design.laneWidth, stopDist: r2(geo.stopDist), box: r2(geo.box),
    arms: design.armIds.map((id) => {
      const a = design.arms[id];
      return { id, angleDeg: a.angle, bearingDeg: a.bearing, inLanes: a.inLanes.length, inLaneTurns: a.inLanes, outLanes: a.outLanes,
        length: a.length, speedLimit: a.speedLimit, crosswalk: a.crosswalk, bikeLane: a.bikeLane };
    }),
    roundabout: design.type === 'roundabout' ? { radius: design.radius, lanes: design.ringLanes } : null,
    crosswalks: Object.entries(geo.crosswalks).map(([arm, [p, q]]) => ({ arm, x1: r2(p[0]), y1: r2(p[1]), x2: r2(q[0]), y2: r2(q[1]) })),
    bannedMovements: [...design.banned],
    signal: design.phases ? { phases: design.phases.map((p) => ({ green: p.green, amber: p.amber, allRed: p.allRed, movements: [...p.movements] })) } : null,
    paths,
  };
}

// ---------------------------------------------------------------- signal control

function signalPlan(design) {
  if (design.type !== 'signal') return null;
  const phases = design.phases;
  const cycle = phases.reduce((s, p) => s + p.green + p.amber + p.allRed, 0);
  return {
    cycle,
    state(movement, t) {
      if (design.banned.has(movement)) return 'R';
      let tc = ((t % cycle) + cycle) % cycle;
      for (let i = 0; i < phases.length; i++) {
        const p = phases[i];
        const next = phases[(i + 1) % phases.length];
        const has = p.movements.has(movement), nextHas = next.movements.has(movement);
        if (tc < p.green) return has ? 'G' : 'R';
        tc -= p.green;
        if (tc < p.amber) {
          if (!has) return 'R';
          if (nextHas) return 'G';
          return movement.startsWith('ped:') ? 'R' : 'A';
        }
        tc -= p.amber;
        if (tc < p.allRed) return has && nextHas ? 'G' : 'R';
        tc -= p.allRed;
      }
      return 'R';
    },
  };
}

// ---------------------------------------------------------------- simulation

function simulate(rawDesign, rawDemand, options = {}) {
  const errors = [];
  const design = normalizeDesign(rawDesign, errors);
  const warnings = [];
  const demand = errors.length ? null : normalizeDemand(rawDemand, design, errors, warnings);
  if (errors.length) return { errors };

  const dt = Math.min(1, Math.max(0.1, Number(options.dt) || 0.5));
  const frameEvery = Math.max(dt, Number(options.frameEverySec) || 1);
  const geo = buildGeometry(design);
  const plan = signalPlan(design);
  const T = demand.durationSec;
  const isRb = design.type === 'roundabout';

  // Arrivals are drawn per (arm, stream) from the seed only, so every design sees the same traffic.
  const arrivals = [];
  // Piecewise-constant rates per schedule step; a single step reproduces a plain Poisson stream.
  const dSteps = demand.steps || [{ atSec: 0, arms: demand.arms }];
  for (const id of ARMS) {
    if (!demand.arms[id]) continue;
    for (const [kind, key] of [['veh', 'vehPerHour'], ['bike', 'bikePerHour'], ['ped', 'pedPerHour']]) {
      if (!dSteps.some((st) => st.arms[id][key] > 0)) continue;
      const rng = mulberry32(hashSeed(demand.seed, `${id}:${kind}`));
      const minGap = kind === 'veh' ? 1.0 : 0.3;
      let k = 0, t = 0, first = true;
      while (t < T) {
        const end = k + 1 < dSteps.length ? Math.min(T, dSteps[k + 1].atSec) : T;
        const rate = dSteps[k].arms[id][key] / 3600;
        if (!(rate > 0)) { t = end; k++; continue; }
        const gap = -Math.log(1 - rng()) / rate;
        const nt = t + (first ? gap : Math.max(minGap, gap));
        if (nt >= end) { t = end; k++; continue; }
        t = nt; first = false;
        arrivals.push({ t, arm: id, kind, step: k, u1: rng(), u2: rng(), u3: rng() });
      }
    }
  }
  arrivals.sort((x, y) => x.t - y.t || x.arm.localeCompare(y.arm) || x.kind.localeCompare(y.kind));
  arrivals.forEach((r, i) => { r.id = i + 1; });

  const vehicles = [];
  const peds = [];
  const backlog = {};
  for (const id of design.armIds) backlog[id] = [];
  const events = [];
  const frames = [];
  const finished = [];
  const pedWaits = [];
  const queueStats = {};
  for (const id of design.armIds) queueStats[id] = { maxVeh: 0, sumVeh: 0, maxMeters: 0 };
  let ai = 0, generated = 0, bikesGenerated = 0, pedsGenerated = 0;

  function boxSpeed(path) {
    const vMin = Math.min(design.arms[path.from].v0, design.arms[path.to].v0);
    if (isRb) return Math.min(vMin, Math.sqrt(0.25 * 9.81 * design.radius) + 1);
    if (path.turn === 'S') return vMin;
    return Math.min(vMin, path.turn === 'L' ? 8 : 6);
  }

  function spawnVehicle(r) {
    const a = dSteps[r.step || 0].arms[r.arm];
    const isBike = r.kind === 'bike';
    const turn = pickWeighted(r.u1, isBike ? a.bikeTurning : a.turning);
    const clsName = isBike ? 'bike' : pickWeighted(r.u2, a.mix);
    let path;
    if (isBike) path = geo.paths[`${r.arm}:${turn}:bike`];
    else {
      let best = null, bestN = Infinity;
      design.arms[r.arm].inLanes.forEach((turns, i) => {
        if (!turns.includes(turn)) return;
        const key = `in:${r.arm}:${i}`;
        const n = vehicles.reduce((s, v) => s + (v.path.inKey === key && v.s < v.path.sStop ? 1 : 0), 0);
        if (n < bestN || (n === bestN && r.u3 < 0.5)) { bestN = n; best = i; }
      });
      path = geo.paths[`${r.arm}:${turn}:${best}`];
    }
    if (!path) return null;
    const cls = CLASSES[clsName];
    const cap = (x) => Math.min(x, cls.vMax || 99);
    const v0In = cap(design.arms[r.arm].v0), v0Out = cap(design.arms[path.to].v0), vBox = cap(boxSpeed(path));
    return {
      id: r.id, clsName, cls, path, arm: r.arm, movement: path.movement, s: 0, v: 0, a: 0,
      tArrive: r.t, ff: path.sStop / v0In + (path.sExit - path.sStop) / vBox + 100 / v0Out,
      stops: 0, stopped: false, moved: false, co2: 0, v0In, v0Out, vBox,
    };
  }

  const inBox = (v) => v.s >= v.path.sStop && v.s < v.path.sExit;
  function trackOf(v) {
    if (v.s < v.path.sStop) return v.path.inKey;
    if (v.s >= v.path.sExit) return v.path.outKey;
    return isRb ? (v.path.isBike ? 'ringbike' : 'ring' + v.path.ringLane) : null;
  }
  const trackPos = (v) => (v.s >= v.path.sExit ? v.s - v.path.sExit : v.s);

  function idmAcc(v, v0, gap, vLead) {
    const c = v.cls;
    const sStar = c.s0 + Math.max(0, v.v * c.T + v.v * (v.v - vLead) / (2 * Math.sqrt(c.aMax * c.b)));
    const g = Math.max(0.1, gap);
    return Math.max(-9, c.aMax * (1 - Math.pow(v.v / Math.max(0.1, v0), 4) - (sStar / g) * (sStar / g)));
  }

  // Has vehicle w already passed the point where its path crosses path p? false = not yet.
  function crossedBy(w, p) {
    const sc = crossingS(w.path, w.path.sStop, w.path.sExit, p.boxPts);
    return sc === null || w.s - w.cls.len > sc + 1;
  }

  const timeToBox = (w) => (w.s >= w.path.sStop ? (w.s < w.path.sExit ? 0 : Infinity) : (w.path.sStop - w.s) / Math.max(w.v, 2));
  // Where along a pedestrian's walk (0..1 from p0) a vehicle path crosses it.
  const crossFrac = (p, path) => {
    const c = path.crossPt && path.crossPt[p.arm];
    if (!c) return -1;
    const dx = p.p1[0] - p.p0[0], dy = p.p1[1] - p.p0[1];
    return ((c[0] - p.p0[0]) * dx + (c[1] - p.p0[1]) * dy) / (p.len * p.len);
  };
  // No vehicle about to drive over the part [from, to] of this pedestrian's crosswalk.
  const zebraClear = (p, from, to) => !vehicles.some((v) => {
    const sc = v.path.cross[p.arm];
    if (sc == null) return false;
    const k = crossFrac(p, v.path);
    if (k < from - 0.05 || k > to + 0.05) return false;
    const d = sc - v.s;
    return d > -v.cls.len - 1 && d < Math.max(4, v.v * 1.5);
  });
  // A walking pedestrian near the point where `path` crosses the crosswalk on `arm`.
  const pedsNear = (path, arm) => {
    const c = path.crossPt[arm];
    return peds.some((p) => {
      if (p.arm !== arm || !p.walking) return false;
      const k = Math.min(p.len, p.pos) / p.len;
      const x = p.p0[0] + (p.p1[0] - p.p0[0]) * k, y = p.p0[1] + (p.p1[1] - p.p0[1]) * k;
      const d = Math.hypot(x - c[0], y - c[1]);
      if (d < 3) return true;
      // Walking towards the crossing point and arriving within about 2 s.
      const toward = (c[0] - x) * (p.p1[0] - p.p0[0]) + (c[1] - y) * (p.p1[1] - p.p0[1]) > 0;
      return toward && d < 3 + p.speed * 2;
    });
  };
  const angleOf = (v) => { const q = pointAt(v.path, v.s); return Math.atan2(q.y, q.x); };
  const wrap = (a) => { while (a < -Math.PI) a += 2 * Math.PI; while (a > Math.PI) a -= 2 * Math.PI; return a; };

  let lastReason = '';
  function mayEnter(v, t) {
    const p = v.path;
    lastReason = '';
    if (plan) {
      const sig = plan.state(v.movement, t);
      if (sig === 'R') { lastReason = 'red'; return false; }
      // Amber: go only if too close to stop comfortably (or already waiting at the line: a "sneaker").
      if (sig === 'A' && p.sStop - v.s > Math.max(4, v.v * v.v / (2 * 3.5))) { lastReason = 'amber'; return false; }
    }
    // Room on the exit lane: do not enter the box if the exit is queued back to it.
    for (const w of vehicles) {
      if (w !== v && w.v < 3 && trackOf(w) === p.outKey && w.s - w.path.sExit - w.cls.len < v.cls.len + 2) { lastReason = 'exit-full'; return false; }
    }
    // Crosswalks right after the stop line; later ones are handled inside the box.
    for (const [arm, sc] of Object.entries(p.cross)) if (sc - p.sStop < 12 && pedsNear(p, arm)) { lastReason = 'ped'; return false; }

    if (isRb) {
      // Yield to circulating traffic that will pass our merge point on the ring.
      const thE = p.thRingStart;
      for (const w of vehicles) {
        if (w === v || w.path.isBike !== p.isBike || !inBox(w)) continue;
        if (w.path.from === p.from) {
          // Same inbound lane: car-following handles it. Other lane on the same arm: do not merge side by side.
          if (w.path.lane !== p.lane && w.path.ringLane === p.ringLane && w.s < w.path.sRingStart + 6) { lastReason = 'yield:' + w.path.key; return false; }
          continue;
        }
        if (w.s < w.path.sRingStart - 3 || w.s > w.path.sRingEnd) continue;
        const thW = angleOf(w);
        const arc = wrap(thE - thW) * p.ringR;
        if (arc > -3 && arc < Math.max(10, w.v * 3.5)) {
          // Does it still circulate when it reaches our merge point?
          let rem = w.path.thRingEnd - thW; while (rem < -0.3) rem += 2 * Math.PI;
          if (rem > arc / p.ringR - 0.05) { lastReason = 'yield:' + w.path.key; return false; }
        }
      }
      return true;
    }

    const conflicts = geo.conflict[p.key];
    for (const w of vehicles) {
      if (w === v || !conflicts.has(w.path.key)) continue;
      if (inBox(w)) {
        // Crossing paths: wait until the box is clear. Merging only: wait if they are slow near the merge.
        if (geo.crosses[p.key].has(w.path.key)) { if (crossedBy(w, p) === false) { lastReason = 'box:' + w.path.key; return false; } continue; }
        if (w.v < 3) { lastReason = 'merge:' + w.path.key; return false; }
        continue;
      }
      if (w.s >= w.path.sStop) continue;
      let theyHavePriority;
      if (plan) {
        const ws = plan.state(w.movement, t);
        if (ws === 'R') continue;
        if (ws === 'A' && w.path.sStop - w.s > Math.max(2, w.v * w.v / (2 * 3.5))) continue;
        theyHavePriority = TURN_RANK[w.path.turn] > TURN_RANK[p.turn];
      } else {
        const meMajor = design.major.has(p.from), themMajor = design.major.has(w.path.from);
        if (meMajor !== themMajor) theyHavePriority = themMajor;
        else if (TURN_RANK[w.path.turn] !== TURN_RANK[p.turn]) theyHavePriority = TURN_RANK[w.path.turn] > TURN_RANK[p.turn];
        else theyHavePriority = ARMS.indexOf(w.path.from) === (ARMS.indexOf(p.from) + 3) % 4; // yield to the right
      }
      if (theyHavePriority && timeToBox(w) < (plan ? 4.5 : 5)) { lastReason = 'yield:' + w.path.key; return false; }
    }
    return true;
  }

  let nextFrame = 0;
  const steps = Math.round(T / dt);
  for (let step = 0; step <= steps; step++) {
    const t = step * dt;

    // 1. Arrivals.
    while (ai < arrivals.length && arrivals[ai].t <= t) {
      const r = arrivals[ai++];
      if (r.kind === 'ped') {
        const cw = geo.crosswalks[r.arm];
        if (!cw) continue;
        pedsGenerated++;
        const [p0, p1] = r.u1 < 0.5 ? cw : [cw[1], cw[0]];
        peds.push({ id: r.id, arm: r.arm, p0, p1, len: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), pos: 0, walking: false, tArrive: r.t, speed: 1.1 + r.u2 * 0.5 });
        events.push({ t: r1(r.t), type: 'ped_arrive', id: r.id, arm: r.arm });
        continue;
      }
      if (r.kind === 'bike') bikesGenerated++; else generated++;
      backlog[r.arm].push(r);
      const ev = { t: r1(r.t), type: 'arrive', id: r.id, arm: r.arm };
      if (r.kind === 'bike') ev.cls = 'bike';
      events.push(ev);
    }

    // 2. Enter from the backlog when the start of the lane is free.
    for (const id of design.armIds) {
      const q = backlog[id];
      let tries = 0;
      while (q.length && tries++ < 4) {
        const v = spawnVehicle(q[0]);
        if (!v) { q.shift(); continue; }
        let last = null;
        for (const w of vehicles) if (w.path.inKey === v.path.inKey && w.s < w.path.sStop && (!last || w.s < last.s)) last = w;
        const gap = last ? last.s - last.cls.len : Infinity;
        if (gap < v.cls.s0 + v.cls.len + 2) break;
        v.v = last ? Math.max(0, Math.min(v.v0In, last.v, (gap - v.cls.s0) / Math.max(0.5, v.cls.T))) : v.v0In;
        vehicles.push(v);
        q.shift();
        events.push({ t: r1(t), type: 'enter', id: v.id, cls: v.clsName, arm: v.arm, movement: v.movement });
      }
    }

    // 3. Pedestrians.
    for (const p of peds) {
      if (!p.walking) {
        let go;
        if (plan) go = plan.state(`ped:${p.arm}`, t) === 'G';
        else {
          // Zebra crossing with a refuge island: each half starts when no vehicle is about to drive over that half.
          go = zebraClear(p, p.pos < p.len / 2 ? 0 : 0.5, p.pos < p.len / 2 ? 0.5 : 1);
        }
        if (go && p.atIsland) { p.walking = true; p.atIsland = false; }
        else if (go) {
          p.walking = true; p.tStart = t;
          pedWaits.push(t - p.tArrive);
          events.push({ t: r1(t), type: 'ped_start', id: p.id, arm: p.arm, waitSec: r1(t - p.tArrive) });
        }
      } else {
        const before = p.pos;
        p.pos += p.speed * dt;
        if (!plan && before < p.len / 2 && p.pos >= p.len / 2) {
          p.pos = p.len / 2;
          if (!zebraClear(p, 0.5, 1)) { p.walking = false; p.atIsland = true; }
        }
        if (p.pos >= p.len) {
          p.done = true;
          events.push({ t: r1(t), type: 'ped_done', id: p.id, arm: p.arm, waitSec: r1(p.tStart - p.tArrive) });
        }
      }
    }
    for (let i = peds.length - 1; i >= 0; i--) if (peds[i].done) peds.splice(i, 1);

    // 4. Leaders per track.
    const tracks = new Map();
    for (const v of vehicles) {
      const k = trackOf(v);
      if (!k) continue;
      if (!tracks.has(k)) tracks.set(k, []);
      tracks.get(k).push(v);
    }
    const leader = new Map();
    for (const [k, list] of tracks) {
      if (k.startsWith('ring')) {
        // Ring = circulating plus the short entry/exit connectors. Only vehicles actually on the ring lead
        // ring traffic; connector vehicles follow their own lane, exiting ones also the outbound lane.
        const onRing = (x) => x.s >= x.path.sRingStart - 1 && x.s <= x.path.sRingEnd + 1;
        // Leaving vehicles still overlap the ring for a few metres.
        const onFoot = (x) => x.s >= x.path.sRingStart - 1 && x.s <= x.path.sRingEnd + 4;
        const ang = list.map((v) => ({ v, th: angleOf(v), on: onRing(v), foot: onFoot(v) }));
        for (const a of ang) {
          const av = a.v, ap = av.path;
          let best = null, bestGap = Infinity;
          const consider = (b, gap) => { if (gap < bestGap) { bestGap = gap; best = b; } };
          if (av.s > ap.sRingEnd + 1) {
            for (const b of ang) {
              if (b !== a && b.v.path.outKey === ap.outKey && b.v.s > ap.sRingEnd && b.v.s - b.v.path.sExit > av.s - ap.sExit) consider(b.v, (b.v.s - b.v.path.sExit) - (av.s - ap.sExit) - b.v.cls.len);
            }
            // Exits from the other ring lane can merge into the same outbound lane.
            for (const [k2, l2] of tracks) if (k2 !== k && k2.startsWith('ring')) for (const b of l2) if (b.path.outKey === ap.outKey && b.s > b.path.sRingEnd && b.s - b.path.sExit > av.s - ap.sExit) consider(b, (b.s - b.path.sExit) - (av.s - ap.sExit) - b.cls.len);
            for (const b of tracks.get(ap.outKey) || []) consider(b, (b.s - b.path.sExit) + (ap.sExit - av.s) - b.cls.len);
          } else {
            let rem = ap.thRingEnd - a.th; while (rem < -0.3) rem += 2 * Math.PI;
            for (const b of ang) {
              if (a === b) continue;
              const bp = b.v.path;
              if (!a.on && bp.from === ap.from && bp.lane === ap.lane && b.v.s > av.s && b.v.s < bp.sRingStart + 3) { consider(b.v, b.v.s - av.s - b.v.cls.len); continue; }
              if (!b.foot && !(b.v.s > bp.sRingEnd && bp.outKey === ap.outKey)) continue;
              let d = b.th - a.th; while (d <= 0) d += 2 * Math.PI;
              if (d > rem + 0.3) continue;
              consider(b.v, d * ap.ringR - b.v.cls.len);
            }
          }
          if (best && bestGap < 40) leader.set(av, { gap: bestGap, v: best.v });
        }
      } else {
        list.sort((x, y) => trackPos(y) - trackPos(x));
        for (let i = 1; i < list.length; i++) {
          leader.set(list[i], { gap: trackPos(list[i - 1]) - list[i - 1].cls.len - trackPos(list[i]), v: list[i - 1].v });
        }
      }
    }
    // The head of each approach queue also follows the last vehicle from its lane that just passed the stop line.
    for (const [k, list] of tracks) {
      const head = list.find((x) => x.s < x.path.sStop && x.path.inKey === k);
      if (!head || list[0] !== head) continue;
      let best = null;
      for (const w of vehicles) {
        if (w.path.inKey !== k || w.s < w.path.sStop || w.s >= w.path.sExit || w.s - w.cls.len - w.path.sStop > 3) continue;
        if (!best || w.s < best.s) best = w;
      }
      if (best) leader.set(head, { gap: best.s - best.cls.len - head.s, v: best.v });
    }

    // Inside a non-roundabout box vehicles have no track: follow the nearest vehicle ahead on the same path or
    // heading for the same exit lane (inside the box or already on it), so queues in the box keep their spacing.
    if (!isRb) {
      const boxed = vehicles.filter((v) => inBox(v) && !v.path.isBike);
      for (const v of boxed) {
        const p = v.path, toExit = p.sExit - v.s;
        let best = null, bestGap = Infinity;
        for (const w of boxed) {
          if (w === v) continue;
          let gap = null;
          if (w.path.key === p.key) { if (w.s > v.s) gap = w.s - w.cls.len - v.s; }
          else if (w.path.outKey === p.outKey) { const wt = w.path.sExit - w.s; if (wt < toExit) gap = toExit - wt - w.cls.len; }
          if (gap !== null && gap < bestGap) { bestGap = gap; best = w; }
        }
        for (const w of tracks.get(p.outKey) || []) {
          const gap = toExit + (w.s - w.path.sExit) - w.cls.len;
          if (gap < bestGap) { bestGap = gap; best = w; }
        }
        if (best && bestGap < 60) {
          const cur = leader.get(v);
          if (!cur || bestGap < cur.gap) leader.set(v, { gap: bestGap, v: best.v });
        }
      }
    }

    // 5. Acceleration.
    for (const v of vehicles) {
      const p = v.path;
      let v0;
      if (v.s < p.sStop) {
        const dStop = p.sStop - v.s;
        v0 = dStop < 70 ? Math.min(v.v0In, v.vBox + dStop * 0.12) : v.v0In;
      } else if (v.s < p.sExit) v0 = v.vBox;
      else v0 = v.v0Out;
      const ld = leader.get(v);
      let acc = ld ? idmAcc(v, v0, ld.gap, ld.v) : idmAcc(v, v0, Infinity, v.v);
      if (v.s < p.sStop) {
        const dStop = p.sStop - v.s;
        if (dStop < 60 && !mayEnter(v, t)) {
          if (options.debug && dStop < 3) options.debug(t, v, lastReason);
          acc = Math.min(acc, idmAcc(v, v0, dStop - 0.5, 0));
        }
      } else if (v.s < p.sExit) {
        for (const [arm, sc] of Object.entries(p.cross)) {
          if (sc - v.s > 1 && sc - v.s < 15 && pedsNear(p, arm)) acc = Math.min(acc, idmAcc(v, v0, sc - v.s - 1.5, 0));
        }
      }
      v.a = acc;
    }

    // 6. Move, stops, emissions, exits.
    for (const v of vehicles) {
      const vNew = Math.max(0, v.v + v.a * dt);
      const ds = Math.max(0, (v.v + vNew) / 2 * dt);
      const c = v.cls;
      v.co2 += c.e0 * dt + c.e1 * ds + c.e2 * Math.max(0, v.a) * ds * 2;
      v.s += ds;
      v.v = vNew;
      if (v.v < 0.5) {
        if (!v.stopped) {
          v.stopped = true; v.stops++;
          const q = pointAt(v.path, v.s);
          events.push({ t: r1(t), type: 'stop', id: v.id, cls: v.clsName, arm: v.arm, movement: v.movement, x: r1(q.x), y: r1(q.y) });
        }
      } else if (v.v > 2) v.stopped = false;
    }
    for (let i = vehicles.length - 1; i >= 0; i--) {
      const v = vehicles[i];
      if (v.s >= v.path.length - 0.5) {
        const delay = Math.max(0, t - v.tArrive - v.ff);
        finished.push({ v, delay });
        events.push({ t: r1(t), type: 'exit', id: v.id, cls: v.clsName, arm: v.arm, movement: v.movement, delaySec: r1(delay), stops: v.stops, co2G: r1(v.co2) });
        vehicles.splice(i, 1);
      }
    }

    // 7. Queues.
    const qNow = {};
    for (const id of design.armIds) {
      const a = design.arms[id];
      const waiting = backlog[id].filter((r) => r.kind !== 'bike').length;
      let nVeh = waiting, maxM = 0;
      for (let li = 0; li < a.inLanes.length; li++) {
        const list = (tracks.get(`in:${id}:${li}`) || []).slice().sort((x, y) => y.s - x.s);
        let k = 0, lastBack = null;
        for (const v of list) {
          if (v.v >= 2) break;
          if (lastBack !== null && lastBack - v.s > 15) break;
          k++;
          lastBack = v.s - v.cls.len;
        }
        nVeh += k;
        if (k) maxM = Math.max(maxM, a.length - lastBack);
      }
      maxM += waiting * 6.5;
      qNow[id] = nVeh;
      const qs = queueStats[id];
      qs.maxVeh = Math.max(qs.maxVeh, nVeh);
      qs.sumVeh += nVeh * dt;
      qs.maxMeters = Math.max(qs.maxMeters, maxM);
    }

    // 8. Frames.
    if (t + 1e-9 >= nextFrame) {
      nextFrame += frameEvery;
      const f = { t: r1(t), v: [], p: [], q: qNow };
      for (const v of vehicles) {
        const q = pointAt(v.path, v.s - v.cls.len / 2);
        f.v.push([v.id, v.clsName, r2(q.x), r2(q.y), Math.round(q.h), r1(v.v)]);
      }
      for (const p of peds) {
        const dx = (p.p1[0] - p.p0[0]) / p.len, dy = (p.p1[1] - p.p0[1]) / p.len;
        const along = p.walking ? Math.min(p.len, p.pos) : -1.2;
        f.p.push([p.id, r2(p.p0[0] + dx * along), r2(p.p0[1] + dy * along)]);
      }
      if (plan) {
        f.sig = {};
        for (const id of design.armIds) {
          for (const tr of TURNS) if (design.arms[exitArmOf(id, tr)]) f.sig[`${id}:${tr}`] = plan.state(`${id}:${tr}`, t);
          if (geo.crosswalks[id]) f.sig[`ped:${id}`] = plan.state(`ped:${id}`, t);
        }
      }
      frames.push(f);
    }
  }

  // ---------------------------------------------------------------- summary
  const cars = finished.filter((f) => f.v.clsName !== 'bike');
  const bikes = finished.filter((f) => f.v.clsName === 'bike');
  const motorLeft = vehicles.filter((v) => v.clsName !== 'bike');
  const backlogCount = design.armIds.reduce((s, id) => s + backlog[id].filter((r) => r.kind !== 'bike').length, 0);
  // Delay counts every vehicle that arrived, not only those that got out: vehicles still inside or still waiting
  // to enter carry the delay they have had so far. Otherwise a blocked minor road would look fast.
  const unserved = motorLeft.map((v) => ({ arm: v.arm, movement: v.movement, delay: Math.max(0, T - v.tArrive - v.ff * Math.min(1, v.s / v.path.length)) }))
    .concat(design.armIds.flatMap((id) => backlog[id].filter((r) => r.kind !== 'bike').map((r) => ({ arm: id, movement: null, delay: Math.max(0, T - r.t) }))));
  const exitedDelays = cars.map((f) => f.delay);
  const all = cars.map((f) => ({ arm: f.v.arm, movement: f.v.movement, delay: f.delay })).concat(unserved);
  const delays = all.map((x) => x.delay);
  const perArm = {}, perMovement = {};
  for (const f of all) {
    for (const [o, k] of [[perArm, f.arm], [perMovement, f.movement]]) {
      if (k == null) continue;
      const x = o[k] || (o[k] = { sum: 0, count: 0 });
      x.sum += f.delay; x.count++;
    }
  }
  const fin = (o) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, { meanSec: r1(x.sum / x.count), count: x.count }]));
  const allMotor = cars.map((f) => f.v).concat(motorLeft);
  const nMotor = allMotor.length || 1;
  const stoppedVehicles = allMotor.filter((v) => v.stops > 0).length;
  const co2 = allMotor.reduce((s, v) => s + v.co2, 0);
  const summary = {
    durationSec: T,
    vehicles: { generated, exited: cars.length, inNetwork: motorLeft.length, backlog: backlogCount },
    throughputVehPerHour: Math.round(cars.length * 3600 / T),
    delay: {
      meanSec: r1(delays.reduce((s, x) => s + x, 0) / (delays.length || 1)), p95Sec: r1(percentile(delays, 0.95)),
      exitedMeanSec: r1(exitedDelays.reduce((s, x) => s + x, 0) / (exitedDelays.length || 1)),
      unservedShare: r2(unserved.length / (all.length || 1)),
      perArm: fin(perArm), perMovement: fin(perMovement),
    },
    queue: { perArm: Object.fromEntries(design.armIds.map((id) => [id, { maxVeh: queueStats[id].maxVeh, meanVeh: r1(queueStats[id].sumVeh / T), maxMeters: Math.round(queueStats[id].maxMeters) }])) },
    stops: { stoppedVehicles, stoppedShare: r2(stoppedVehicles / nMotor), meanStopsPerVehicle: r2(allMotor.reduce((s, v) => s + v.stops, 0) / nMotor) },
    emissions: { co2Kg: r1(co2 / 1000), co2GPerVehicle: Math.round(co2 / nMotor), note: 'rough estimate' },
    pedestrians: { generated: pedsGenerated, crossed: pedWaits.length, meanWaitSec: r1(pedWaits.reduce((s, x) => s + x, 0) / (pedWaits.length || 1)) },
    bikes: { generated: bikesGenerated, exited: bikes.length, meanDelaySec: r1(bikes.reduce((s, f) => s + f.delay, 0) / (bikes.length || 1)) },
  };
  return {
    design: { id: design.id, name: design.name, origin: design.origin, type: design.type },
    summary, warnings, layout: layoutOf(design, geo), frames, events,
  };
}

// ---------------------------------------------------------------- examples

function examples() {
  const arm = (id, extra = {}) => ({ id, inLanes: [['L', 'S'], ['S', 'R']], outLanes: 2, speedLimit: 50, length: 150, crosswalk: true, bikeLane: true, ...extra });
  return {
    designs: [
      {
        id: 'example-signal-2phase', name: 'Example 4-arm signal, 2 phases', origin: 'existing', type: 'signal', laneWidth: 3.5,
        arms: ARMS.map((id) => arm(id)),
        signal: { phases: [
          { green: 30, amber: 3, allRed: 2, movements: ['N:L', 'N:S', 'N:R', 'S:L', 'S:S', 'S:R'] },
          { green: 25, amber: 3, allRed: 2, movements: ['E:L', 'E:S', 'E:R', 'W:L', 'W:S', 'W:R'] },
        ] },
      },
      {
        id: 'example-roundabout', name: 'Example single-lane roundabout', origin: 'user', type: 'roundabout', laneWidth: 3.5,
        arms: ARMS.map((id) => arm(id, { inLanes: [['L', 'S', 'R']], outLanes: 1 })), roundabout: { radius: 16 },
      },
      {
        id: 'example-priority-tjunction', name: 'Example T-junction, E gives way', origin: 'user', type: 'priority', laneWidth: 3.5,
        arms: [arm('N', { inLanes: [['S', 'R']], outLanes: 1 }), arm('S', { inLanes: [['L', 'S']], outLanes: 1 }), arm('E', { inLanes: [['L', 'R']], outLanes: 1 })],
        priority: { major: ['N', 'S'] },
      },
    ],
    demand: {
      durationSec: 900, seed: 42,
      arms: {
        N: { vehPerHour: 500, turning: { L: 0.2, S: 0.6, R: 0.2 }, mix: { car: 0.88, bus: 0.05, truck: 0.07 }, pedPerHour: 120, bikePerHour: 80 },
        S: { vehPerHour: 450, turning: { L: 0.2, S: 0.6, R: 0.2 }, mix: { car: 0.88, bus: 0.05, truck: 0.07 }, pedPerHour: 100, bikePerHour: 60 },
        E: { vehPerHour: 300, turning: { L: 0.3, S: 0.4, R: 0.3 }, mix: { car: 0.9, bus: 0.03, truck: 0.07 }, pedPerHour: 80, bikePerHour: 40 },
        W: { vehPerHour: 350, turning: { L: 0.3, S: 0.4, R: 0.3 }, mix: { car: 0.9, bus: 0.03, truck: 0.07 }, pedPerHour: 80, bikePerHour: 40 },
      },
    },
  };
}

module.exports = { simulate, examples, VERSION };
