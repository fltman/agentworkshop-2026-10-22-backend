// Top-down intersection renderer + frame playback (team amad).
// World: metres, origin at the centre, x east, y north (martin's CONTRACT.md).
// Heading is math degrees (0 = east, counter-clockwise), as in martin's frames.
// Rendering is independent of UI controls: the app only calls the public methods below.
const LW = 3.5;                 // default lane width (overridden by layout.laneWidth)
const BIKE_W = 0.6;             // bike lane width in lane widths (martin: 0.6 * W)
const ARMS = ['N', 'E', 'S', 'W'];
const DIR = { N: [0, 1], E: [1, 0], S: [0, -1], W: [-1, 0] };
const NOMINAL = { N: 0, E: 90, S: 180, W: 270 };   // compass bearing of each label
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
const FRAME_KEYS = new Set(['t', 'v', 'p', 'q', 'sig']);

export const CLS_COLOR = { car: '#5aa9ff', bus: '#ffb547', truck: '#b98cff', bike: '#3ddc97' };
export const PED_COLOR = '#ff8fb8';
export const SIG_COLOR = { G: '#2fd27a', A: '#ffc23d', R: '#ff4d4f' };
export const STOP_COLOR = '#ff4d4f';
const CLS_SIZE = { car: [4.5, 1.9], bus: [12, 2.55], truck: [10, 2.5], bike: [1.8, 0.7] };

const C = {
  bg: '#0d1218', grid: 'rgba(255,255,255,0.035)', gridMajor: 'rgba(255,255,255,0.06)',
  walk: '#1c232d', asphalt: '#2b323d', asphaltEdge: '#3a4352', bike: '#24453a',
  mark: 'rgba(236,241,247,0.88)', markDim: 'rgba(236,241,247,0.55)', island: '#1f3b2c', islandEdge: '#3f6b4f',
};

const lerp = (a, b, k) => a + (b - a) * k;
const lerpDeg = (a, b, k) => a + ((((b - a) % 360) + 540) % 360 - 180) * k;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export class Scene {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.design = null;
    this.layout = null;
    this.frames = [];
    this.t = 0;
    this.speed = 1;
    this.playing = false;
    this.zoom = 1;
    this.pan = [0, 0];
    this.title = '';
    this.subtitle = '';
    this.onTick = null;
    this.onUnsupported = null;   // (fields: string[]) => void, called once per setFrames
    this.map = null;             // optional TileMap (map.js); when ready, it sets the metre scale
    this.bearings = {};          // real arm bearings (compass, away from centre) known to the app (geo.js)
    this.osmLines = null;        // OSM centrelines [{points:[[x,y]...]}] for the debug overlay
    this.showOsm = false;
    this.hint = 'Press Run to simulate this design';
    this.w = 1; this.h = 1; this.dpr = 1;
    this._last = 0;
    this._dirty = true;
    this._bindPointer();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement || canvas);
    this.resize();
    requestAnimationFrame((ts) => this._loop(ts));
  }

  // ---------- public API ----------
  setDesign(d) { this.design = d; this.layout = null; this._dirty = true; }
  setLayout(l) { this.layout = l && typeof l === 'object' ? l : null; this._dirty = true; }
  setTitle(title, subtitle = '') { this.title = title || ''; this.subtitle = subtitle || ''; this._dirty = true; }
  setFrames(frames) {
    this.frames = (frames || []).filter((f) => f && typeof f.t === 'number').sort((a, b) => a.t - b.t);
    this.t = this.frames.length ? this.frames[0].t : 0;
    const unknown = new Set();
    for (const f of this.frames.slice(0, 50)) for (const k of Object.keys(f)) if (!FRAME_KEYS.has(k)) unknown.add(k);
    if (unknown.size && this.onUnsupported) this.onUnsupported([...unknown]);
    this._dirty = true;
  }
  clearFrames() { this.frames = []; this.t = 0; this.playing = false; this._dirty = true; }
  get duration() { return this.frames.length ? this.frames[this.frames.length - 1].t : 0; }
  play() { this.playing = true; }
  pause() { this.playing = false; this._dirty = true; }
  seek(t) { this.t = clamp(t, 0, this.duration); this._dirty = true; if (this.onTick) this.onTick(this.t); }
  setSpeed(s) { this.speed = s; }
  // Real arm bearings (compass degrees, clockwise from north, away from the centre). Used to draw the arms
  // before a run, and as a fallback warp when the engine's layout does not echo bearingDeg (engine < 0.4).
  setBearings(b) { this.bearings = b && typeof b === 'object' ? { ...b } : {}; this._dirty = true; }
  setOsmLines(g) { this.osmLines = Array.isArray(g) ? g : null; this._dirty = true; }
  setShowOsm(on) { this.showOsm = !!on; this._dirty = true; }
  // 'engine' = engine laid the arms out along bearingDeg; 'warp' = frames are cardinal, warped on the client;
  // 'design' = no frames yet, arms drawn along known bearings; 'cardinal' = labels only.
  get alignment() {
    if (this._engineBearings()) return 'engine';
    if (!this._bearingsKnown()) return 'cardinal';
    return this.frames.length ? 'warp' : 'design';
  }
  attachMap(map) { this.map = map; this._dirty = true; }
  get mapOn() { return !!this.map?.ready; }
  zoomBy(f) {
    if (this.mapOn) this.map.setZoom(this.map.zoom + Math.log2(f));
    else this.zoom = clamp(this.zoom * f, 0.35, 6);
    this._dirty = true;
  }
  fit() { if (this.mapOn) this.map.setZoom(18.5); this.zoom = 1; this.pan = [0, 0]; this._dirty = true; }
  setView(pan, zoom) { this.pan = pan.slice(); if (this.mapOn && zoom != null) this.map.setZoom(zoom); this._dirty = true; }
  draw() { this._dirty = true; }

  resize() {
    const host = this.c.parentElement || this.c;
    const r = host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, Math.floor(r.width));
    this.h = Math.max(1, Math.floor(r.height));
    this.dpr = dpr;
    this.c.width = Math.round(this.w * dpr);
    this.c.height = Math.round(this.h * dpr);
    this.c.style.width = this.w + 'px';
    this.c.style.height = this.h + 'px';
    this._render();
  }

  // ---------- loop ----------
  _loop(ts) {
    const dt = this._last ? Math.min(0.25, (ts - this._last) / 1000) : 0;
    this._last = ts;
    if (this.playing && this.frames.length) {
      this.t += dt * this.speed;
      if (this.t >= this.duration) { this.t = this.duration; this.playing = false; }
      if (this.onTick) this.onTick(this.t);
      this._dirty = true;
    }
    if (this._dirty) { this._dirty = false; this._render(); }
    requestAnimationFrame((n) => this._loop(n));
  }

  _bindPointer() {
    const c = this.c;
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    let drag = null;
    c.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY, ...this.pan]; c.setPointerCapture(e.pointerId); c.classList.add('dragging'); });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const s = this._scale();
      this.pan = [drag[2] - (e.clientX - drag[0]) / s, drag[3] + (e.clientY - drag[1]) / s];
      this._dirty = true;
    });
    const up = () => { drag = null; c.classList.remove('dragging'); };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', () => this.fit());
  }

  // ---------- geometry ----------
  get lw() { return this.layout?.laneWidth || LW; }

  // Per-arm geometry from martin's layout when present, else derived from the design (same rules as the engine).
  _arms() {
    const out = {};
    const la = Array.isArray(this.layout?.arms) ? this.layout.arms : null;
    for (const id of ARMS) {
      let turns = null, outN = null, bike = true, cross = true;
      const l = la?.find((a) => a.id === id);
      if (l) {
        turns = Array.isArray(l.inLaneTurns) ? l.inLaneTurns : Array.from({ length: l.inLanes || 1 }, () => ['L', 'S', 'R']);
        outN = l.outLanes; bike = l.bikeLane !== false; cross = l.crosswalk !== false;
      } else {
        const d = this._designArm(id);
        if (!d) continue;
        const lanes = Array.isArray(d.inLanes) ? d.inLanes : [];
        turns = lanes.map((x) => (Array.isArray(x) ? x : x?.turns || []));
        if (!turns.length) continue;
        outN = d.outLanes; bike = d.bikeLane !== false; cross = d.crosswalk !== false;
      }
      if (!turns || !turns.length) continue;
      const lw = this.lw;
      const bw = bike ? BIKE_W * lw : 0;
      const inN = turns.length;
      outN = outN || inN;
      out[id] = { id, turns, inN, outN, bike, bw, cross, inHW: inN * lw, outHW: outN * lw };
    }
    return out;
  }

  _designArm(id) {
    const a = this.design?.arms;
    if (!a) return null;
    if (Array.isArray(a)) return a.find((x) => x.id === id) || null;
    return a[id] || null;
  }

  _geo(arms) {
    const d = this.design || {};
    const type = this.layout?.type || d.type || 'signal';
    const lw = this.lw;
    const maxHalf = Math.max(lw, ...Object.values(arms).map((a) => Math.max(a.inHW, a.outHW) + a.bw));
    const box = this.layout?.box ?? maxHalf + 1;
    const R = this.layout?.roundabout?.radius ?? d.roundabout?.radius ?? d.radius ?? 15;
    const round = type === 'roundabout';
    // engine 0.4: arms meeting at a sharp angle push the stop lines out
    const ids = ARMS.filter((id) => arms[id]);
    let minGap = 90;
    ids.forEach((id, k) => { const nx = ids[(k + 1) % ids.length]; if (nx !== id) minGap = Math.min(minGap, ((this._bearing(nx) - this._bearing(id)) % 360 + 360) % 360); });
    const sharp = box / Math.tan((Math.max(30, minGap) * Math.PI) / 360);
    const stop = this.layout?.stopDist ?? (round ? Math.max(R + lw * 1.2 + 6, sharp + 4) : Math.max(box + 4, sharp + 4));
    const major = this.layout?.priority?.major || d.priority?.major || ['N', 'S'];
    return { type, round, R, box, stop, major, lw };
  }

  _scale() {
    if (this.mapOn) return this.map.pxPerMetre();
    const arms = this._arms();
    const g = this._geo(arms);
    const extent = Math.max(55, g.stop + 42);   // whole junction plus the queues closest to it
    return (Math.min(this.w, this.h) / (2 * extent)) * this.zoom;
  }

  _frameAt() {
    const f = this.frames;
    if (!f.length) return null;
    let lo = 0, hi = f.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (f[m].t <= this.t) lo = m; else hi = m - 1; }
    const a = f[lo], b = f[Math.min(lo + 1, f.length - 1)];
    const k = b.t > a.t ? clamp((this.t - a.t) / (b.t - a.t), 0, 1) : 0;
    return { a, b, k };
  }

  // ---------- render ----------
  _render() {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const onMap = this.mapOn;
    if (onMap) ctx.clearRect(0, 0, this.w, this.h);
    else { ctx.fillStyle = C.bg; ctx.fillRect(0, 0, this.w, this.h); }
    const s = this._scale();
    const cx = this.w / 2, cy = this.h / 2;
    const X = (x) => cx + (x - this.pan[0]) * s;
    const Y = (y) => cy - (y - this.pan[1]) * s;
    const T = { s, X, Y, P: (x, y) => [X(x), Y(y)] };
    if (onMap) this.map.render(this.pan, this.w, this.h);
    else this._grid(T);

    if (!this.design) { this._empty('Pick a design to start'); return; }
    const arms = this._arms();
    if (!Object.keys(arms).length) { this._empty('This design has no approach lanes'); return; }
    const g = this._geo(arms);
    const fr = this._frameAt();
    const sig = fr?.a?.sig || {};
    const far = (Math.hypot(this.w, this.h) / s) + Math.hypot(...this.pan) + 10;

    // On the map the overlay is drawn to geographic scale; when zoomed far out it is too small to draw.
    this._osm(T);
    if (s >= 0.6) {
      const ctx = this.ctx;
      ctx.save();
      if (onMap) ctx.globalAlpha = 0.6;  // semi-transparent roads: the real streets stay visible
      this._ground(T, arms, g, onMap ? Math.min(far, 150) : far, onMap);
      ctx.globalAlpha = onMap ? 0.85 : 1;
      this._markings(T, arms, g, onMap ? Math.min(far, 150) : far, sig);
      ctx.restore();
      this._warp = fr && !this._engineBearings() && this._bearingsKnown() ? this._buildWarp(arms) : null;
      if (fr) this._agents(T, fr);
      this._signals(T, arms, g, sig);
      if (s >= 2) this._armLabels(T, arms, g, fr?.a?.q || {});
    }
    this._hud(fr, g);
    if (!fr && this.hint) this._hint(this.hint);
  }

  _grid({ s, X, Y }) {
    const { ctx } = this;
    const step = 10;
    const x0 = Math.floor((this.pan[0] - this.w / 2 / s) / step) * step;
    const x1 = this.pan[0] + this.w / 2 / s;
    const y0 = Math.floor((this.pan[1] - this.h / 2 / s) / step) * step;
    const y1 = this.pan[1] + this.h / 2 / s;
    ctx.lineWidth = 1;
    for (let x = x0; x <= x1; x += step) {
      ctx.strokeStyle = x % 50 === 0 ? C.gridMajor : C.grid;
      ctx.beginPath(); ctx.moveTo(Math.round(X(x)) + 0.5, 0); ctx.lineTo(Math.round(X(x)) + 0.5, this.h); ctx.stroke();
    }
    for (let y = y0; y <= y1; y += step) {
      ctx.strokeStyle = y % 50 === 0 ? C.gridMajor : C.grid;
      ctx.beginPath(); ctx.moveTo(0, Math.round(Y(y)) + 0.5); ctx.lineTo(this.w, Math.round(Y(y)) + 0.5); ctx.stroke();
    }
  }

  _engineBearings() { return Array.isArray(this.layout?.arms) && this.layout.arms.some((a) => a && a.bearingDeg != null); }
  _bearingsKnown() { return Object.entries(this.bearings).some(([id, b]) => Number.isFinite(b) && Math.abs(angDiff(b, NOMINAL[id])) >= 0.5); }

  // Compass bearing the arm is drawn along.
  _bearing(arm) {
    if (this._engineBearings()) {
      const l = this.layout.arms.find((a) => a.id === arm);
      if (l && Number.isFinite(l.bearingDeg)) return l.bearingDeg;
      if (l && Number.isFinite(l.angleDeg)) return 90 - l.angleDeg;
      return NOMINAL[arm];
    }
    const b = this.bearings[arm];
    return Number.isFinite(b) ? b : NOMINAL[arm];
  }

  _u(arm) { const b = (this._bearing(arm) * Math.PI) / 180; return [Math.sin(b), Math.cos(b)]; }

  // Fallback only (engine frames at cardinal angles, real arms at known bearings): piecewise-linear polar warp.
  // Radius is kept. Around each arm there is a plateau (the road's angular footprint at that radius) that is
  // rotated rigidly, so lanes keep their metric offsets; between plateaus the rotation is interpolated linearly.
  _buildWarp(arms) {
    const knots = ARMS.map((id) => {
      const e = 90 - NOMINAL[id];                                       // engine math angle
      const d = arms[id] ? -angDiff(this._bearing(id), NOMINAL[id]) : 0;   // math rotation (deg), CCW positive
      const hw = arms[id] ? Math.max(arms[id].inHW, arms[id].outHW) + arms[id].bw + 3 : 0;
      return { e: ((e % 360) + 360) % 360, d, hw };
    }).sort((a, b) => a.e - b.e);
    const n = knots.length;
    knots.forEach((k, i) => {
      const nx = knots[(i + 1) % n], pv = knots[(i - 1 + n) % n];
      const gapN = ((nx.e - k.e + 360) % 360) || 360, gapP = ((k.e - pv.e + 360) % 360) || 360;
      k.wmax = 0.4 * Math.min(gapN, gapP, gapN + nx.d - k.d, gapP + k.d - pv.d);
    });
    if (knots.every((k) => Math.abs(k.d) < 0.01)) return null;
    return (x, y) => {
      const r = Math.hypot(x, y);
      if (r < 1e-6) return [x, y];
      const th = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
      const w = knots.map((k) => (k.hw ? Math.min(k.wmax, (Math.atan(k.hw / r) * 180) / Math.PI) : 0));
      let rot = 0;
      for (let i = 0; i < n; i++) {
        const a = knots[i], b = knots[(i + 1) % n];
        const lo = a.e - w[i];
        let span = (b.e - a.e + 360) % 360 || 360;
        let rel = (th - lo + 360) % 360;
        if (rel <= 2 * w[i]) { rot = a.d; break; }                     // on arm a's plateau
        const s0 = 2 * w[i], s1 = w[i] + span - w[(i + 1) % n];        // interpolation zone, relative to lo
        if (rel < s1) { rot = a.d + (b.d - a.d) * ((rel - s0) / Math.max(1e-6, s1 - s0)); break; }
      }
      const t = ((th + rot) * Math.PI) / 180;
      return [r * Math.cos(t), r * Math.sin(t)];
    };
  }

  // Arm frame: along = distance from centre along u (outwards), lat = offset to the inbound side (right of travel).
  // u follows the arm's bearing; lateral offsets stay in metres along the arm's own normal.
  _af(arm) {
    const [ux, uy] = this._u(arm);
    const [rx, ry] = [-uy, ux];  // right of the inbound travel direction (-u)
    return (along, lat) => [ux * along + rx * lat, uy * along + ry * lat];
  }

  _poly(T, pts, fill) {
    const { ctx } = this;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(T.X(x), T.Y(y)) : ctx.moveTo(T.X(x), T.Y(y))));
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
  }

  _rectArm(T, arm, a0, a1, l0, l1, fill) {
    const f = this._af(arm);
    this._poly(T, [f(a0, l0), f(a1, l0), f(a1, l1), f(a0, l1)], fill);
  }

  // Junction surface: polygon through each arm's mouth corners (works for any arm angles).
  _boxPoly(arms, g, extra = 0) {
    const along = Math.max(g.box, g.stop - 3.5);
    const pts = [];
    for (const id of ARMS) {
      const a = arms[id];
      if (!a) continue;
      const f = this._af(id);
      // counter-clockwise order around the centre: out side (left of u) first, then in side
      pts.push(f(along, a.inHW + a.bw + extra), f(along, -(a.outHW + a.bw + extra)));
    }
    pts.sort((p, q) => Math.atan2(p[1], p[0]) - Math.atan2(q[1], q[0]));
    return pts.length >= 3 ? pts : [[-g.box, g.box], [g.box, g.box], [g.box, -g.box], [-g.box, -g.box]];
  }

  // Add a polygon to the current path with a fixed (screen-clockwise) winding, so nonzero union fills have no holes.
  _addPath(T, pts) {
    const { ctx } = this;
    let area = 0;
    pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; area += p[0] * q[1] - q[0] * p[1]; });
    const seq = area < 0 ? pts : pts.slice().reverse();   // always clockwise in world coordinates
    seq.forEach(([x, y], i) => (i ? ctx.lineTo(T.X(x), T.Y(y)) : ctx.moveTo(T.X(x), T.Y(y))));
    ctx.closePath();
  }

  _osm(T) {
    if (!this.showOsm || !this.osmLines) return;
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,229,255,0.9)'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    for (const w of this.osmLines) {
      ctx.beginPath();
      w.points.forEach(([x, y], i) => (i ? ctx.lineTo(T.X(x), T.Y(y)) : ctx.moveTo(T.X(x), T.Y(y))));
      ctx.stroke();
    }
    ctx.restore();
  }

  _ground(T, arms, g, far, onMap = false) {
    const { ctx } = this;
    const SW = 2.5;
    // sidewalks (the map already shows them)
    if (!onMap) for (const a of Object.values(arms)) this._rectArm(T, a.id, 0, far, -(a.outHW + a.bw + SW), a.inHW + a.bw + SW, C.walk);
    if (onMap) { /* no sidewalk */ } else if (g.round) {
      ctx.fillStyle = C.walk; ctx.beginPath(); ctx.arc(T.X(0), T.Y(0), (g.R + g.lw * 1.9 + SW) * T.s, 0, Math.PI * 2); ctx.fill();
    } else {
      this._poly(T, this._boxPoly(arms, g, SW), C.walk);
    }
    if (onMap) {
      // one union path (consistent clockwise winding) so the translucent surface does not darken where pieces overlap
      ctx.beginPath();
      for (const a of Object.values(arms)) {
        const f = this._af(a.id);
        const l0 = -(a.outHW + a.bw), l1 = a.inHW + a.bw;
        this._addPath(T, [f(0, l1), f(far, l1), f(far, l0), f(0, l0)]);
      }
      if (g.round) {
        // a circle via polygon so its winding matches the arms
        const rr = g.R + g.lw * 1.9;
        this._addPath(T, Array.from({ length: 64 }, (_, i) => [rr * Math.cos((i * Math.PI) / 32), rr * Math.sin((i * Math.PI) / 32)]));
      } else this._addPath(T, this._boxPoly(arms, g));
      ctx.fillStyle = C.asphalt; ctx.fill('nonzero');
      return;
    }
    // asphalt
    for (const a of Object.values(arms)) this._rectArm(T, a.id, 0, far, -(a.outHW + a.bw), a.inHW + a.bw, C.asphalt);
    if (g.round) {
      ctx.fillStyle = C.asphalt; ctx.beginPath(); ctx.arc(T.X(0), T.Y(0), (g.R + g.lw * 1.9) * T.s, 0, Math.PI * 2); ctx.fill();
    } else {
      this._poly(T, this._boxPoly(arms, g), C.asphalt);
    }
    // bike lanes (coloured strips on the outer edge of each approach)
    const from = g.round ? g.R + g.lw * 1.9 : g.box;
    for (const a of Object.values(arms)) {
      if (!a.bike) continue;
      this._rectArm(T, a.id, from, far, a.inHW, a.inHW + a.bw, C.bike);
      this._rectArm(T, a.id, from, far, -(a.outHW + a.bw), -a.outHW, C.bike);
    }
  }

  _line(T, p, q, color, width, dash = []) {
    const { ctx } = this;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(T.X(p[0]), T.Y(p[1])); ctx.lineTo(T.X(q[0]), T.Y(q[1])); ctx.stroke();
    ctx.setLineDash([]);
  }

  _markings(T, arms, g, far, sig) {
    const { ctx } = this;
    const s = T.s;
    const lw = g.lw;
    const mw = Math.max(1, 0.15 * s);
    const dash = [3 * s, 3 * s];
    for (const a of Object.values(arms)) {
      const f = this._af(a.id);
      const start = g.stop;
      // centre line (solid near the junction, dashed beyond)
      this._line(T, f(start, 0), f(start + 25, 0), C.mark, mw * 1.4);
      this._line(T, f(start + 25, 0), f(far, 0), C.markDim, mw, dash);
      // inbound lane dividers: solid for the last 15 m, dashed beyond
      for (let i = 1; i < a.inN; i++) {
        this._line(T, f(start, i * lw), f(start + 15, i * lw), C.mark, mw);
        this._line(T, f(start + 15, i * lw), f(far, i * lw), C.markDim, mw, dash);
      }
      for (let i = 1; i < a.outN; i++) this._line(T, f(g.round ? start : g.box, -i * lw), f(far, -i * lw), C.markDim, mw, dash);
      // edge lines between car lanes and bike lanes
      if (a.bike) {
        this._line(T, f(start, a.inHW), f(far, a.inHW), C.markDim, mw);
        this._line(T, f(start, -a.outHW), f(far, -a.outHW), C.markDim, mw);
      }
      // crosswalk (zebra), martin puts it 2.5 m inside the stop line
      if (a.cross) {
        const cw = start - 2.5;
        const l0 = -(a.outHW + a.bw), l1 = a.inHW + a.bw;
        ctx.fillStyle = 'rgba(236,241,247,0.7)';
        for (let l = l0 + 0.25; l < l1 - 0.3; l += 1.0) {
          const p = [f(cw - 1.3, l), f(cw + 1.3, l), f(cw + 1.3, l + 0.55), f(cw - 1.3, l + 0.55)];
          this._poly(T, p, 'rgba(236,241,247,0.62)');
        }
      }
      // stop line or give-way teeth
      const giveWay = g.round || (g.type === 'priority' && !g.major.includes(a.id));
      if (giveWay) {
        ctx.fillStyle = C.mark;
        for (let l = 0.2; l < a.inHW - 0.3; l += 1.2) {
          this._poly(T, [f(start, l), f(start, l + 0.8), f(start + 1.1, l + 0.4)], C.mark);
        }
      } else {
        this._line(T, f(start, 0), f(start, a.inHW), C.mark, Math.max(2, 0.45 * s));
      }
      // lane arrows
      a.turns.forEach((turns, i) => this._arrow(T, f(start + 6.5, (i + 0.5) * lw), a.id, turns));
    }
    if (g.round) {
      const { ctx: c2 } = this;
      c2.fillStyle = C.island; c2.strokeStyle = C.islandEdge; c2.lineWidth = Math.max(1.5, 0.35 * s);
      c2.beginPath(); c2.arc(T.X(0), T.Y(0), Math.max(1, g.R - lw * 0.7) * s, 0, Math.PI * 2); c2.fill(); c2.stroke();
      c2.strokeStyle = C.markDim; c2.lineWidth = mw; c2.setLineDash([2 * s, 2 * s]);
      c2.beginPath(); c2.arc(T.X(0), T.Y(0), (g.R + lw * 0.75) * s, 0, Math.PI * 2); c2.stroke(); c2.setLineDash([]);
    }
    // banned movements: small red marker near each arm's stop line
    for (const m of this.design?.bannedMovements || []) {
      const [arm, turn] = String(m).split(':');
      const a = arms[arm];
      if (!a) continue;
      const f = this._af(arm);
      const [x, y] = f(g.stop + 12, a.inHW + a.bw + 3.5 + 'LSR'.indexOf(turn) * 0);
      this._pill(T.X(x), T.Y(y), `no ${turn}`, '#ff4d4f', '#2a0f12');
    }
  }

  // Vector lane arrow in the lane's local frame (travel = local up), then rotated onto the approach.
  _arrow(T, [wx, wy], arm, turns) {
    const { ctx } = this;
    const s = T.s;
    const [ux, uy] = this._u(arm);
    const dx = -ux, dy = -uy;                  // travel direction (world)
    const theta = Math.atan2(dx, dy);          // screen rotation that maps local up to travel
    const k = s * 0.55;                        // arrow unit in px (~0.55 m)
    if (k < 2) return;
    ctx.save();
    ctx.translate(T.X(wx), T.Y(wy));
    ctx.rotate(theta);
    ctx.strokeStyle = 'rgba(236,241,247,0.75)'; ctx.fillStyle = 'rgba(236,241,247,0.75)';
    ctx.lineWidth = Math.max(1.2, k * 0.42); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const head = (x, y, ang) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      ctx.beginPath(); ctx.moveTo(0, -k * 1.1); ctx.lineTo(k * 0.85, k * 0.2); ctx.lineTo(-k * 0.85, k * 0.2); ctx.closePath(); ctx.fill();
      ctx.restore();
    };
    ctx.beginPath(); ctx.moveTo(0, k * 3); ctx.lineTo(0, 0); ctx.stroke();
    const set = new Set(turns);
    if (set.has('S') || !set.size) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -k * 1.6); ctx.stroke(); head(0, -k * 1.9, 0); }
    if (set.has('L')) { ctx.beginPath(); ctx.moveTo(0, k * 0.4); ctx.quadraticCurveTo(0, -k * 0.9, -k * 1.4, -k * 0.9); ctx.stroke(); head(-k * 1.7, -k * 0.9, -Math.PI / 2); }
    if (set.has('R')) { ctx.beginPath(); ctx.moveTo(0, k * 0.4); ctx.quadraticCurveTo(0, -k * 0.9, k * 1.4, -k * 0.9); ctx.stroke(); head(k * 1.7, -k * 0.9, Math.PI / 2); }
    ctx.restore();
  }

  _laneState(sig, arm, turns) {
    const st = (turns.length ? turns : ['S']).map((t) => sig[`${arm}:${t}`]).filter(Boolean);
    if (!st.length) return null;
    return st.includes('G') ? 'G' : st.includes('A') ? 'A' : 'R';
  }

  _signals(T, arms, g, sig) {
    if (g.type !== 'signal') return;
    const { ctx } = this;
    const s = T.s;
    const r = clamp(0.75 * s, 3.5, 9);
    const noFrames = !Object.keys(sig).length;
    for (const a of Object.values(arms)) {
      const f = this._af(a.id);
      // one signal head per inbound lane, just inside the stop line
      a.turns.forEach((turns, i) => {
        const st = noFrames ? null : this._laneState(sig, a.id, turns);
        const [x, y] = f(g.stop - 0.2, (i + 0.5) * g.lw);
        const px = T.X(x), py = T.Y(y);
        ctx.fillStyle = '#0b0f14'; ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(px, py, r + 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        const col = st ? SIG_COLOR[st] : '#4a5563';
        if (st) { ctx.shadowColor = col; ctx.shadowBlur = r * 1.6; }
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      });
      // pedestrian signal at both ends of the crosswalk
      const ps = sig[`ped:${a.id}`];
      if (a.cross && ps) {
        const cw = g.stop - 2.5;
        for (const l of [-(a.outHW + a.bw) - 1.2, a.inHW + a.bw + 1.2]) {
          const [x, y] = f(cw, l);
          const q = clamp(0.55 * s, 2.5, 6);
          ctx.fillStyle = '#0b0f14'; ctx.fillRect(T.X(x) - q - 1.5, T.Y(y) - q - 1.5, 2 * q + 3, 2 * q + 3);
          ctx.fillStyle = SIG_COLOR[ps] || '#4a5563'; ctx.fillRect(T.X(x) - q, T.Y(y) - q, 2 * q, 2 * q);
        }
      }
    }
  }

  _agents(T, { a, b, k }) {
    const { ctx } = this;
    const s = T.s;
    const next = new Map((b.v || []).map((v) => [v[0], v]));
    const vs = Array.isArray(a.v) ? a.v : [];
    // draw big vehicles first so cars/bikes stay visible on top
    const order = { bus: 0, truck: 1, car: 2, bike: 3 };
    const sorted = vs.slice().sort((p, q) => (order[p[1]] ?? 2) - (order[q[1]] ?? 2));
    for (const v of sorted) {
      if (!Array.isArray(v) || v.length < 4) continue;
      const n = next.get(v[0]);
      let x = n ? lerp(v[2], n[2], k) : v[2];
      let y = n ? lerp(v[3], n[3], k) : v[3];
      let hd = n && v[4] != null && n[4] != null ? lerpDeg(v[4], n[4], k) : (v[4] || 0);
      const sp = n && v[5] != null && n[5] != null ? lerp(v[5], n[5], k) : v[5];
      const cls = v[1];
      if (this._warp) [x, y, hd] = this._warpPose(x, y, hd);
      const [L, W] = CLS_SIZE[cls] || CLS_SIZE.car;
      const lp = Math.max(cls === 'bike' ? 5 : 8, L * s), wp = Math.max(cls === 'bike' ? 2.5 : 4, W * s);
      ctx.save();
      ctx.translate(T.X(x), T.Y(y));
      ctx.rotate(-(hd * Math.PI) / 180);
      const rr = Math.min(wp / 2, cls === 'bike' ? wp / 2 : 0.35 * s + 1);
      ctx.fillStyle = CLS_COLOR[cls] || '#cfd8e3';
      this._rr(-lp / 2, -wp / 2, lp, wp, rr); ctx.fill();
      if (cls !== 'bike') {
        // windscreen at the front so heading is readable
        ctx.fillStyle = 'rgba(8,12,18,0.45)';
        this._rr(lp / 2 - Math.min(lp * 0.32, wp * 0.9), -wp / 2 + wp * 0.14, Math.min(lp * 0.2, wp * 0.55), wp * 0.72, 1.5); ctx.fill();
      }
      if (sp != null && sp < 0.5) {
        ctx.strokeStyle = STOP_COLOR; ctx.lineWidth = Math.max(1.5, 0.22 * s);
        this._rr(-lp / 2, -wp / 2, lp, wp, rr); ctx.stroke();
      }
      ctx.restore();
    }
    const nextP = new Map((b.p || []).map((p) => [p[0], p]));
    const pr = Math.max(2.4, 0.45 * s);
    for (const p of Array.isArray(a.p) ? a.p : []) {
      const n = nextP.get(p[0]);
      let x = n ? lerp(p[1], n[1], k) : p[1];
      let y = n ? lerp(p[2], n[2], k) : p[2];
      if (this._warp) [x, y] = this._warp(x, y);
      ctx.fillStyle = PED_COLOR; ctx.strokeStyle = '#0b0f14'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(T.X(x), T.Y(y), pr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  // Warp a vehicle pose: transform p and p + 0.5 m along the heading, take the direction of the difference.
  _warpPose(x, y, hd) {
    const h = (hd * Math.PI) / 180;
    const [px, py] = this._warp(x, y);
    const [qx, qy] = this._warp(x + 0.5 * Math.cos(h), y + 0.5 * Math.sin(h));
    return [px, py, (Math.atan2(qy - py, qx - px) * 180) / Math.PI];
  }

  _rr(x, y, w, h, r) {
    const { ctx } = this;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  _pill(x, y, text, color, bg, opts = {}) {
    const { ctx } = this;
    ctx.font = `600 ${opts.size || 11}px ui-sans-serif, system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 14, h = (opts.size || 11) + 9;
    ctx.fillStyle = bg; ctx.strokeStyle = color; ctx.lineWidth = 1;
    this._rr(x - w / 2, y - h / 2, w, h, h / 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
  }

  _armLabels(T, arms, g, q) {
    const vr = Math.min(this.w, this.h) / 2 / T.s;     // visible radius in metres
    for (const a of Object.values(arms)) {
      const f = this._af(a.id);
      const along = clamp(vr - 14, g.stop + 8, vr * 0.9);
      const [lx, ly] = f(along, -(a.outHW + a.bw) - 4);
      this._pill(T.X(lx), T.Y(ly), a.id, '#cfd8e3', 'rgba(13,18,24,0.85)', { size: 12 });
      if (q[a.id] != null) {
        const n = q[a.id];
        const col = n >= 10 ? '#ff4d4f' : n >= 5 ? '#ffc23d' : '#2fd27a';
        const [x, y] = f(along, a.inHW + a.bw + 5.5);
        this._pill(T.X(x), T.Y(y), `queue ${n}`, col, 'rgba(13,18,24,0.88)');
      }
    }
  }

  _hud(fr, g) {
    const { ctx } = this;
    const pad = 14;
    const lines = [];
    const title = this.title || this.design?.name || this.design?.id || '';
    const typeTxt = { signal: 'Signalised', roundabout: `Roundabout · r ${g.R} m`, priority: 'Priority (give way)' }[g.type] || g.type;
    const greens = fr ? [...new Set(Object.entries(fr.a.sig || {}).filter(([m, v]) => v === 'G' && !m.startsWith('ped:')).map(([m]) => m.split(':')[0]))] : [];
    ctx.font = '600 15px ui-sans-serif, system-ui, sans-serif';
    const w1 = ctx.measureText(title).width;
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    const sub = [typeTxt, this.subtitle].filter(Boolean).join(' · ');
    const w2 = ctx.measureText(sub).width;
    const clock = fr ? `${mmss(this.t)} / ${mmss(this.duration)}` : '--:-- / --:--';
    ctx.font = '600 22px ui-monospace, SFMono-Regular, Menlo, monospace';
    const w3 = ctx.measureText(clock).width;
    const W = Math.max(w1, w2, w3 + 70) + 28;
    const H = 92;
    ctx.fillStyle = 'rgba(13,18,24,0.82)'; ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    this._rr(pad, pad, W, H, 10); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#eef3f8'; ctx.font = '600 15px ui-sans-serif, system-ui, sans-serif'; ctx.fillText(title, pad + 14, pad + 24);
    ctx.fillStyle = '#8b98a8'; ctx.font = '12px ui-sans-serif, system-ui, sans-serif'; ctx.fillText(sub, pad + 14, pad + 42);
    ctx.fillStyle = '#eef3f8'; ctx.font = '600 22px ui-monospace, SFMono-Regular, Menlo, monospace'; ctx.fillText(clock, pad + 14, pad + 76);
    if (fr) {
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif'; ctx.fillStyle = '#8b98a8';
      ctx.fillText(`${(fr.a.v || []).length} veh`, pad + 22 + w3, pad + 66);
      if (g.type === 'signal') {
        ctx.fillStyle = greens.length ? SIG_COLOR.G : '#8b98a8';
        ctx.fillText(greens.length ? `green ${greens.join(' ')}` : 'all red', pad + 22 + w3, pad + 81);
      }
    }
    lines.length = 0;
  }

  _empty(msg) {
    const { ctx } = this;
    ctx.fillStyle = '#8b98a8'; ctx.font = '15px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(msg, this.w / 2, this.h / 2);
  }

  _hint(msg) {
    this._pill(this.w / 2, this.h - 110, msg, '#cfd8e3', 'rgba(13,18,24,0.85)', { size: 13 });
  }
}

// Synthetic frames so the canvas works when martin's API is unreachable (clearly labelled as demo by the app).
export function demoFrames(design, demand) {
  const dur = Math.min(demand?.durationSec || 120, 300);
  const armLanes = (a) => {
    const x = Array.isArray(design?.arms) ? design.arms.find((y) => y.id === a) : design?.arms?.[a];
    return x?.inLanes?.length || 0;
  };
  const arms = ARMS.filter((a) => armLanes(a));
  const frames = [];
  let id = 1, cars = [];
  let seed = demand?.seed || 1;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let t = 0; t <= dur; t++) {
    const phaseNS = Math.floor(t / 30) % 2 === 0;
    const sig = {};
    for (const a of arms) for (const m of ['L', 'S', 'R']) sig[`${a}:${m}`] = (a === 'N' || a === 'S') === phaseNS ? 'G' : 'R';
    for (const a of arms) {
      const vph = demand?.arms?.[a]?.vehPerHour ?? 400;
      if (rnd() < vph / 3600) {
        const [ux, uy] = DIR[a];
        cars.push({ id: id++, a, d: 90, cls: rnd() < 0.1 ? 'truck' : rnd() < 0.05 ? 'bus' : 'car', ux, uy, lane: Math.floor(rnd() * armLanes(a)) });
      }
    }
    const q = {};
    for (const c of cars) {
      const stopD = 16 + cars.filter((o) => o.a === c.a && o.d < c.d && o.d > 14).length * 7;
      const green = sig[`${c.a}:S`] === 'G';
      const target = green || c.d < 14 ? -100 : stopD;
      const gap = c.d - target;
      c.sp = gap > 0 ? Math.min(11, Math.max(0, gap)) : 11;
      c.d -= c.sp;
      if (c.sp < 0.5) q[c.a] = (q[c.a] || 0) + 1;
    }
    cars = cars.filter((c) => c.d > -90);
    frames.push({
      t, sig, q,
      v: cars.map((c) => {
        const [ux, uy] = [c.ux, c.uy], rx = -uy, ry = ux;
        const off = (c.lane + 0.5) * LW;
        return [c.id, c.cls, ux * c.d + rx * off, uy * c.d + ry * off, (Math.atan2(-uy, -ux) * 180) / Math.PI, c.sp];
      }),
      p: [],
    });
  }
  return frames;
}
