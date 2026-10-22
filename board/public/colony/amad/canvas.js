// Top-down intersection renderer + frame playback. Metres, origin at centre, x east, y north.
// Heading is treated as math degrees (0 = east, counter-clockwise), which matches martin's example frame.
const LANE_W = 3.5;
const DIR = { N: [0, 1], E: [1, 0], S: [0, -1], W: [-1, 0] };
const CLS_COLOR = { car: '#4aa3ff', bus: '#ffb020', truck: '#c78bff', bike: '#3ddc97' };
const CLS_SIZE = { car: [4.4, 1.9], bus: [11, 2.5], truck: [8, 2.5], bike: [1.8, 0.7] };
const SIG_COLOR = { G: '#2ecc71', A: '#f1c40f', R: '#e74c3c' };

export class Scene {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.design = null;
    this.frames = [];
    this.t = 0;
    this.speed = 1;
    this.playing = false;
    this.extent = 70;
    this.onTick = null;
    this._last = 0;
    requestAnimationFrame((ts) => this._loop(ts));
  }

  setDesign(d) { this.design = d; this.draw(); }
  setFrames(frames) {
    this.frames = (frames || []).slice().sort((a, b) => a.t - b.t);
    this.t = this.frames.length ? this.frames[0].t : 0;
    this.draw();
  }
  get duration() { return this.frames.length ? this.frames[this.frames.length - 1].t : 0; }
  play() { this.playing = true; }
  pause() { this.playing = false; }
  seek(t) { this.t = Math.max(0, Math.min(this.duration, t)); this.draw(); }
  setSpeed(s) { this.speed = s; }

  _loop(ts) {
    const dt = this._last ? (ts - this._last) / 1000 : 0;
    this._last = ts;
    if (this.playing && this.frames.length) {
      this.t += dt * this.speed;
      if (this.t >= this.duration) { this.t = this.duration; this.playing = false; }
      if (this.onTick) this.onTick(this.t);
      this.draw();
    }
    requestAnimationFrame((n) => this._loop(n));
  }

  _tx() {
    const w = this.c.width, h = this.c.height, s = Math.min(w, h) / (2 * this.extent);
    return { s, X: (x) => w / 2 + x * s, Y: (y) => h / 2 - y * s };
  }

  _frameAt() {
    const f = this.frames;
    if (!f.length) return null;
    let lo = 0, hi = f.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (f[m].t <= this.t) lo = m; else hi = m - 1; }
    const a = f[lo], b = f[Math.min(lo + 1, f.length - 1)];
    const k = b.t > a.t ? Math.min(1, Math.max(0, (this.t - a.t) / (b.t - a.t))) : 0;
    return { a, b, k };
  }

  _lanes(arm) {
    const l = this.design?.arms?.[arm]?.inLanes;
    return Array.isArray(l) && l.length ? l : null;
  }

  draw() {
    const { ctx, c } = this;
    const { s, X, Y } = this._tx();
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#1b2430';
    ctx.fillRect(0, 0, c.width, c.height);
    if (!this.design) { this._text('Select a design', c.width / 2, c.height / 2); return; }

    const d = this.design;
    const round = d.type === 'roundabout';
    const R = round ? (d.radius || 15) : 0;

    // roads
    ctx.fillStyle = '#3a4350';
    for (const arm of Object.keys(DIR)) {
      const n = this._lanes(arm)?.length || 0;
      if (!n) continue;
      const [ux, uy] = DIR[arm];
      const hw = n * LANE_W;
      const len = this.extent;
      const x0 = ux ? (ux > 0 ? 0 : -len) : -hw, x1 = ux ? (ux > 0 ? len : 0) : hw;
      const y0 = uy ? (uy > 0 ? 0 : -len) : -hw, y1 = uy ? (uy > 0 ? len : 0) : hw;
      ctx.fillRect(X(Math.min(x0, x1)), Y(Math.max(y0, y1)), Math.abs(x1 - x0) * s, Math.abs(y1 - y0) * s);
    }
    const maxHw = Math.max(1, ...Object.keys(DIR).map((a) => (this._lanes(a)?.length || 1) * LANE_W));
    const box = round ? R : maxHw;
    ctx.fillStyle = '#3a4350';
    ctx.beginPath();
    if (round) ctx.arc(X(0), Y(0), (R + LANE_W * 1.5) * s, 0, Math.PI * 2);
    else ctx.rect(X(-box), Y(box), box * 2 * s, box * 2 * s);
    ctx.fill();
    if (round) {
      ctx.fillStyle = '#2d5a3a';
      ctx.beginPath(); ctx.arc(X(0), Y(0), Math.max(1, R - LANE_W * 1.5) * s, 0, Math.PI * 2); ctx.fill();
    }

    // lane dividers and signal stop lines
    const sig = this._frameAt()?.a?.sig || {};
    for (const arm of Object.keys(DIR)) {
      const lanes = this._lanes(arm);
      if (!lanes) continue;
      const [ux, uy] = DIR[arm];
      const [dx, dy] = [-ux, -uy];
      const [rx, ry] = [dy, -dx];
      const stop = (round ? R + LANE_W * 1.5 : box) + 1;
      ctx.strokeStyle = '#8a95a3'; ctx.lineWidth = 1; ctx.setLineDash([6, 6]);
      for (let i = 1; i < lanes.length; i++) {
        ctx.beginPath();
        ctx.moveTo(X(ux * stop + rx * i * LANE_W), Y(uy * stop + ry * i * LANE_W));
        ctx.lineTo(X(ux * this.extent + rx * i * LANE_W), Y(uy * this.extent + ry * i * LANE_W));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      lanes.forEach((lane, i) => {
        const col = d.type === 'signal' ? this._laneSignal(sig, arm, lane.turns || []) : null;
        ctx.strokeStyle = col || '#e8edf2'; ctx.lineWidth = col ? 4 : 2;
        const cx = ux * stop + rx * i * LANE_W, cy = uy * stop + ry * i * LANE_W;
        ctx.beginPath();
        ctx.moveTo(X(cx), Y(cy));
        ctx.lineTo(X(cx + rx * LANE_W), Y(cy + ry * LANE_W));
        ctx.stroke();
        this._arrow(X(ux * (stop + 6) + rx * (i + 0.5) * LANE_W), Y(uy * (stop + 6) + ry * (i + 0.5) * LANE_W), lane.turns || [], arm, s);
      });
      // crosswalk
      const cw = stop + 2.5;
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 3; ctx.setLineDash([3, 3]);
      const hw = lanes.length * LANE_W;
      ctx.beginPath();
      ctx.moveTo(X(ux * cw + rx * -hw), Y(uy * cw + ry * -hw));
      ctx.lineTo(X(ux * cw + rx * hw), Y(uy * cw + ry * hw));
      ctx.stroke(); ctx.setLineDash([]);
    }

    // banned movements
    const banned = d.bannedMovements || [];
    ctx.fillStyle = '#ff6b6b'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    banned.forEach((m, i) => this._text('no ' + m, 60 + i * 52, c.height - 14, '#ff6b6b'));

    const fr = this._frameAt();
    if (!fr) return;
    const { a, b, k } = fr;

    // queues
    for (const arm of Object.keys(DIR)) {
      const q = a.q && a.q[arm];
      if (q == null) continue;
      const [ux, uy] = DIR[arm];
      this._text('q ' + q, X(ux * (this.extent - 8) + uy * 8), Y(uy * (this.extent - 8) + ux * 8), '#fff');
    }

    // vehicles (interpolated by id)
    const prev = new Map((b.v || []).map((v) => [v[0], v]));
    for (const v of a.v || []) {
      const nx = prev.get(v[0]);
      const x = nx ? v[2] + (nx[2] - v[2]) * k : v[2];
      const y = nx ? v[3] + (nx[3] - v[3]) * k : v[3];
      const [L, W] = CLS_SIZE[v[1]] || CLS_SIZE.car;
      ctx.save();
      ctx.translate(X(x), Y(y));
      ctx.rotate(-(v[4] * Math.PI) / 180);
      ctx.fillStyle = CLS_COLOR[v[1]] || '#ccc';
      ctx.fillRect(-L * s / 2, -W * s / 2, L * s, W * s);
      if (v[5] < 0.5) { ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = 1.5; ctx.strokeRect(-L * s / 2, -W * s / 2, L * s, W * s); }
      ctx.restore();
    }
    ctx.fillStyle = '#f5f5f5';
    for (const p of a.p || []) {
      ctx.beginPath(); ctx.arc(X(p[1]), Y(p[2]), Math.max(1.5, 0.5 * s), 0, Math.PI * 2); ctx.fill();
    }
    this._text(`t = ${this.t.toFixed(0)} s   vehicles: ${(a.v || []).length}`, 8, 16, '#cfd8e3', 'left');
  }

  // Signal for a lane: G if any of its turn movements is green, A if amber, else R.
  _laneSignal(sig, arm, turns) {
    const states = (turns.length ? turns : ['S']).map((t) => sig[`${arm}:${t}`]).filter(Boolean);
    if (!states.length) return null;
    const st = states.includes('G') ? 'G' : states.includes('A') ? 'A' : 'R';
    return SIG_COLOR[st];
  }

  _arrow(x, y, turns, arm, s) {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = `${Math.max(9, 2.4 * s)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(turns.join(''), x, y);
  }

  _text(t, x, y, color = '#cfd8e3', align = 'center') {
    const { ctx } = this;
    ctx.fillStyle = color; ctx.font = '12px sans-serif'; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    ctx.fillText(t, x, y);
  }
}

// Synthetic frames so the canvas works when martin's API is unreachable.
export function demoFrames(design, demand) {
  const dur = Math.min(demand?.durationSec || 120, 300);
  const arms = Object.keys(DIR).filter((a) => design?.arms?.[a]?.inLanes?.length);
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
        cars.push({ id: id++, a, d: 70, cls: rnd() < 0.1 ? 'truck' : rnd() < 0.05 ? 'bus' : 'car', ux, uy, lane: Math.floor(rnd() * design.arms[a].inLanes.length) });
      }
    }
    const q = {};
    for (const c of cars) {
      const stopD = 8 + cars.filter((o) => o.a === c.a && o.d < c.d).length * 6;
      const green = sig[`${c.a}:S`] === 'G';
      const target = green || c.d < 0 ? -80 : stopD;
      const gap = c.d - target;
      c.sp = gap > 0 ? Math.min(11, Math.max(0, gap)) : 11;
      c.d -= c.sp;
      if (c.sp < 0.5) q[c.a] = (q[c.a] || 0) + 1;
    }
    cars = cars.filter((c) => c.d > -70);
    frames.push({
      t, sig, q,
      v: cars.map((c) => {
        const [ux, uy] = [c.ux, c.uy], rx = -uy, ry = ux;
        const off = (c.lane + 0.5) * LANE_W;
        return [c.id, c.cls, ux * c.d + rx * off, uy * c.d + ry * off, (Math.atan2(-uy, -ux) * 180) / Math.PI, c.sp];
      }),
      p: [],
    });
  }
  return frames;
}
