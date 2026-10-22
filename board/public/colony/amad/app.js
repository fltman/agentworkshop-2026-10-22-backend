import * as api from './api.js';
import { Scene, demoFrames, CLS_COLOR, PED_COLOR, SIG_COLOR, STOP_COLOR } from './canvas.js';
import { TileMap } from './map.js';
import { getArmBearings, withBearings } from './geo.js';

const $ = (id) => document.getElementById(id);
const ARMS = ['N', 'E', 'S', 'W'];
const TURN_NAME = { L: 'Left', S: 'Straight', R: 'Right' };
const scene = new Scene($('cv'));
const tmap = new TileMap($('mapLayer'));
tmap.mountMarkers($('markerHost'));
scene.attachMap(tmap);
const MAP_ZOOM = 18.5; // ~75 m from the centre to the view edge

const state = {
  demand: null, design: null, designs: [], runId: null, hasFrames: false,
  demandQuery: null, // params of the backend demand being edited; null = manual (local-only) demand
  editedArms: new Set(), // arms the user changed, sent as overrides to POST /t/backend/demand
  intersections: [], activeArm: 'N', armStash: {}, compared: false,
  view: 'schematic', // 'map' (OpenStreetMap background) or 'schematic'
  overview: false,   // map zoomed out to show every intersection as a marker
  geo: { key: '', bearings: {}, source: 'none', geometry: null, pending: false }, // real arm bearings (geo.js)
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hh = (h) => `${String(h).padStart(2, '0')}:00`;
const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const setRadio = (name, v) => { const el = document.querySelector(`input[name="${name}"][value="${v}"]`); if (el) el.checked = true; };

// ---------- toasts (instead of an error banner) ----------
function toast(kind, title, msg = '', ms) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const ico = { error: '!', warn: '⚠', ok: '✓', info: 'i' }[kind] || 'i';
  el.innerHTML = `<span class="ti">${ico}</span><div class="tm"><b>${esc(title)}</b>${msg ? `<span>${esc(msg)}</span>` : ''}</div><button type="button" aria-label="Dismiss">×</button>`;
  const close = () => el.remove();
  el.querySelector('button').addEventListener('click', close);
  $('toasts').appendChild(el);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  setTimeout(close, ms ?? (kind === 'error' ? 9000 : 4500));
}
function errText(e) {
  const b = e?.body;
  if (b && typeof b === 'object' && b.error) return [b.error, ...(Array.isArray(b.details) ? b.details : [])].join(': ');
  return e && e.message ? e.message : String(e);
}
function showError(e, title) {
  console.error(e);
  toast('error', title || (e?.team ? `${e.team} module error` : 'Something went wrong'), errText(e));
}
const guard = (fn, title) => async (...a) => { try { return await fn(...a); } catch (e) { showError(e, title); } };
function setStatus(text) { $('status').textContent = text || ''; $('status').title = text || ''; }

// range inputs paint their filled part through a CSS variable
function paintRange(el) {
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty('--p', `${((+el.value - min) / (max - min || 1)) * 100}%`);
}

// ---------- module status ----------
async function refreshModules() {
  const st = await api.checkModules();
  $('modules').innerHTML = ['backend', 'be-christian', 'martin', 'per'].filter((t) => st[t]).map((t) => [t, st[t]])
    .map(([t, s]) => `<span class="${s.reachable ? 'ok' : 'down'}" title="${esc(t)}: ${s.reachable ? 'reachable' : 'unreachable'} (HTTP ${s.status})">${esc(t)}</span>`).join('');
}

// ---------- legend ----------
$('legend').innerHTML = [
  ...['car', 'bus', 'truck'].map((c) => `<span class="lg"><i class="sw" style="background:${CLS_COLOR[c]}"></i>${c}</span>`),
  `<span class="lg"><i class="sw bike" style="background:${CLS_COLOR.bike}"></i>bike</span>`,
  `<span class="lg"><i class="dot" style="background:${PED_COLOR}"></i>pedestrian</span>`,
  `<span class="lg"><i class="sw" style="background:transparent;border:2px solid ${STOP_COLOR}"></i>stopped</span>`,
  '<span class="sep"></span>',
  ...[['G', 'green'], ['A', 'amber'], ['R', 'red']].map(([k, n]) => `<span class="lg"><i class="dot" style="background:${SIG_COLOR[k]}"></i>${n}</span>`),
].join('');

// ---------- demand ----------
const emptyDemand = () => ({
  durationSec: +$('duration').value || 300, seed: +$('seed').value || 42,
  arms: Object.fromEntries(ARMS.map((a) => [a, {
    vehPerHour: 400, turning: { L: 0.2, S: 0.6, R: 0.2 },
    mix: { car: 0.85, bus: 0.05, truck: 0.1 }, pedPerHour: 60, bikePerHour: 30,
  }])),
});

// Arms shown/edited: backend demand only has the arms the intersection has (overriding others is a 400).
const demandArms = () => (state.demandQuery ? ARMS.filter((a) => state.demand.arms[a]) : ARMS);
const DEFAULT_MIX = { car: 0.85, bus: 0.05, truck: 0.1 };
const pct = (v) => Math.round((v ?? 0) * 100);

// Value an input should show for the current state.demand.
function inputValue(i) {
  const arms = state.demand.arms;
  if (i.dataset.mix) {
    const first = arms[demandArms()[0]] || {};
    return pct((first.mix || DEFAULT_MIX)[i.dataset.mix]);
  }
  const x = arms[i.dataset.a] || {};
  if (i.dataset.t) return pct(x.turning?.[i.dataset.t]);
  return x[i.dataset.k] ?? 0;
}

const numField = (label, attrs, unit, step = 1) =>
  `<label class="field"><span class="field-label">${label}</span><span class="input-unit"><input type="number" min="0" step="${step}" ${attrs}><em>${unit}</em></span></label>`;

function renderArmTabs() {
  const arms = demandArms();
  if (!arms.includes(state.activeArm)) state.activeArm = arms[0] || 'N';
  $('armTabs').innerHTML = ARMS.map((a) => {
    const on = arms.includes(a);
    const v = on ? state.demand.arms[a]?.vehPerHour ?? 0 : '–';
    return `<button type="button" role="tab" class="armtab${a === state.activeArm ? ' active' : ''}${state.editedArms.has(a) ? ' edited' : ''}" data-arm="${a}" aria-selected="${a === state.activeArm}" ${on ? '' : 'disabled title="This intersection has no ' + a + ' approach"'}><b>${a}</b><small>${v}${on ? '/h' : ''}</small></button>`;
  }).join('');
}

function renderDemand() {
  const d = state.demand;
  for (const a of demandArms()) if (!d.arms[a]) d.arms[a] = emptyDemand().arms[a];
  renderArmTabs();
  const a = state.activeArm;
  const max = Math.max(2400, Math.ceil(((d.arms[a]?.vehPerHour) || 0) / 100) * 100);
  $('demand').innerHTML = `
    <div class="field">
      <span class="field-label">Vehicles from ${a}</span>
      <div class="slider-num">
        <input type="range" min="0" max="${max}" step="10" data-a="${a}" data-k="vehPerHour" aria-label="Vehicles per hour from ${a}">
        <span class="input-unit"><input type="number" min="0" step="10" data-a="${a}" data-k="vehPerHour" aria-label="Vehicles per hour from ${a}"><em>veh/h</em></span>
      </div>
    </div>
    <div class="field">
      <span class="field-label">Turning split <span id="turnSum" class="field-val"></span></span>
      <div class="triple">${['L', 'S', 'R'].map((t) => `<label class="field"><span class="field-label">${TURN_NAME[t]}</span><span class="input-unit"><input type="number" min="0" max="100" step="5" data-a="${a}" data-t="${t}"><em>%</em></span></label>`).join('')}</div>
      <div class="stackbar" id="turnBar"></div>
      <div class="hint" id="turnHint"></div>
    </div>
    <div class="grid2">
      ${numField('Pedestrians', `data-a="${a}" data-k="pedPerHour"`, 'ped/h', 10)}
      ${numField('Cyclists', `data-a="${a}" data-k="bikePerHour"`, 'bike/h', 10)}
    </div>`;
  $('mix').innerHTML = ['car', 'bus', 'truck'].map((c) =>
    `<label class="field"><span class="field-label">${c[0].toUpperCase() + c.slice(1)}</span><span class="input-unit"><input data-mix="${c}" type="number" min="0" max="100" step="1"><em>%</em></span></label>`).join('');
  document.querySelectorAll('#demand input, #mix input').forEach((i) => {
    i.value = inputValue(i);
    i.addEventListener('input', onDemandInput);
    // a focused field is not overwritten while typing; resync it with the normalised value on blur
    i.addEventListener('blur', () => { i.value = inputValue(i); if (i.type === 'range') paintRange(i); });
  });
  decorateDemand();
}

// Update existing inputs in place (keeps focus/caret); the focused input is left as the user typed it.
function refreshDemandInputs() {
  document.querySelectorAll('#demand input, #mix input').forEach((i) => {
    if (i !== document.activeElement) i.value = inputValue(i);
  });
  decorateDemand();
}

// Visual feedback: tab volumes, turning sum + bar, mix sum, range fill, step summary.
function decorateDemand() {
  const d = state.demand;
  const a = d.arms[state.activeArm] || {};
  const tr = a.turning || {};
  const sum = pct(tr.L) + pct(tr.S) + pct(tr.R);
  const tot = (tr.L || 0) + (tr.S || 0) + (tr.R || 0) || 1;
  if ($('turnSum')) {
    $('turnSum').textContent = `Σ ${sum}%`;
    $('turnBar').innerHTML = [['L', '#4c8dff'], ['S', '#2fd27a'], ['R', '#ffc23d']]
      .map(([t, c]) => `<i style="width:${((tr[t] || 0) / tot) * 100}%;background:${c}" title="${TURN_NAME[t]} ${pct(tr[t])}%"></i>`).join('');
    const off = Math.abs(sum - 100) > 0;
    $('turnHint').className = 'hint' + (off ? ' warn' : '');
    $('turnHint').innerHTML = off ? `Turning adds up to ${sum}%, not 100%. It will be normalised. <button type="button" class="btn btn-ghost" id="normTurn" style="height:24px;padding:0 8px;margin-left:4px">Normalise</button>` : '';
    $('turnHint').querySelectorAll('#normTurn').forEach((b) => b.addEventListener('click', normaliseTurning));
    document.querySelectorAll('#demand [data-t]').forEach((i) => i.parentElement.classList.toggle('bad', off));
  }
  const mix = (d.arms[demandArms()[0]] || {}).mix || DEFAULT_MIX;
  const msum = pct(mix.car) + pct(mix.bus) + pct(mix.truck);
  $('mixHint').className = 'hint' + (msum !== 100 ? ' warn' : '');
  $('mixHint').textContent = msum !== 100 ? `Mix adds up to ${msum}%; it will be normalised to 100%.` : '';
  document.querySelectorAll('#demand input[type=range]').forEach(paintRange);
  document.querySelectorAll('#armTabs .armtab').forEach((b) => {
    const x = d.arms[b.dataset.arm];
    if (x && !b.disabled) b.querySelector('small').textContent = `${x.vehPerHour ?? 0}/h`;
    b.classList.toggle('edited', state.editedArms.has(b.dataset.arm));
  });
  updateSummaries();
}

function normaliseTurning() {
  const a = state.activeArm;
  const tr = { ...(state.demand.arms[a].turning || {}) };
  const s = (tr.L || 0) + (tr.S || 0) + (tr.R || 0);
  if (!s) return;
  const L = Math.round((tr.L || 0) / s * 100), S = Math.round((tr.S || 0) / s * 100);
  state.demand.arms[a].turning = { L: L / 100, S: S / 100, R: (100 - L - S) / 100 };
  state.editedArms.add(a);
  document.querySelectorAll('#demand [data-t]').forEach((i) => { i.value = inputValue(i); });
  decorateDemand();
  if (state.demandQuery) scheduleDemandPost();
}

function onDemandInput(e) {
  const i = e.target;
  const v = Math.max(0, Number(i.value) || 0);
  const dm = state.demand;
  if (i.dataset.mix) {
    for (const a of demandArms()) {
      dm.arms[a].mix = { ...(dm.arms[a].mix || DEFAULT_MIX), [i.dataset.mix]: v / 100 };
      state.editedArms.add(a);
    }
  } else if (i.dataset.t) {
    dm.arms[i.dataset.a].turning = { ...(dm.arms[i.dataset.a].turning || {}), [i.dataset.t]: v / 100 };
    state.editedArms.add(i.dataset.a);
  } else {
    dm.arms[i.dataset.a][i.dataset.k] = Math.round(v);
    state.editedArms.add(i.dataset.a);
  }
  if (i.type === 'range') paintRange(i);
  refreshDemandInputs();
  if (state.demandQuery) scheduleDemandPost(); // manual demand stays local-only
}

$('armTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.armtab');
  if (!b || b.disabled) return;
  state.activeArm = b.dataset.arm;
  renderDemand();
});
$('armTabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const arms = demandArms();
  const i = arms.indexOf(state.activeArm);
  state.activeArm = arms[(i + (e.key === 'ArrowRight' ? 1 : arms.length - 1)) % arms.length];
  renderDemand();
  $('armTabs').querySelector('.active')?.focus();
});

// ---------- demand overrides -> backend (debounced) ----------
let postTimer = null;
let postSeq = 0;

function scheduleDemandPost() {
  clearTimeout(postTimer);
  postTimer = setTimeout(() => { postTimer = null; postDemandOverrides(); }, 400);
}

const postDemandOverrides = guard(async () => {
  const q = state.demandQuery;
  if (!q || !state.editedArms.size) return;
  const overrides = {};
  for (const a of state.editedArms) {
    const x = state.demand.arms[a];
    if (!x) continue;
    overrides[a] = {
      vehPerHour: x.vehPerHour, turning: x.turning, mix: x.mix,
      pedPerHour: x.pedPerHour, bikePerHour: x.bikePerHour,
    };
  }
  const seq = ++postSeq;
  const res = await api.postDemand({ ...q, overrides });
  // drop stale answers, and answers that would clobber edits made while the request was in flight
  if (seq !== postSeq || postTimer || state.demandQuery !== q) return;
  state.demand = res;
  refreshDemandInputs();
}, 'Demand override rejected');

function syncDemandGlobals() {
  state.demand.durationSec = +$('duration').value || 300;
  state.demand.seed = +$('seed').value || 42;
}

const loadDemand = guard(async () => {
  clearTimeout(postTimer); postTimer = null; postSeq++;
  state.editedArms = new Set();
  $('loadDemand').classList.remove('pending');
  const id = $('intersection').value;
  if (!id) { state.demandQuery = null; state.demand = emptyDemand(); renderDemand(); return; }
  const q = {
    intersection: id, day: radio('day'), hour: +$('hour').value,
    durationSec: +$('duration').value, seed: +$('seed').value, scale: +$('scale').value,
  };
  state.demand = await api.getDemand(q.intersection, q.hour, q.durationSec, q.seed, q.scale, q.day);
  state.demandQuery = q;
  $('duration').value = state.demand.durationSec ?? $('duration').value;
  $('seed').value = state.demand.seed ?? $('seed').value;
  renderDemand();
  // design ids match intersection ids in be-christian's presets
  if ([...$('design').options].some((o) => o.value === id) && $('design').value !== id) { $('design').value = id; await loadDesign(); }
}, 'Could not load demand');

$('intersection').addEventListener('change', () => selectIntersection($('intersection').value));
$('loadDemand').addEventListener('click', loadDemand);
const markPending = () => { if (state.demandQuery) $('loadDemand').classList.add('pending'); };
$('hour').addEventListener('input', () => { $('hourOut').textContent = hh($('hour').value); paintRange($('hour')); markPending(); updateSummaries(); });
$('scale').addEventListener('input', () => { $('scaleOut').textContent = (+$('scale').value).toFixed(1) + '×'; paintRange($('scale')); markPending(); });
$('day').addEventListener('change', () => { markPending(); updateSummaries(); });
$('hour').addEventListener('change', loadDemand);
$('scale').addEventListener('change', loadDemand);
$('day').addEventListener('change', loadDemand);

// ---------- design ----------
const designArm = (a) => state.design?.arms?.[a];
const lanesToText = (arm) => (designArm(arm)?.inLanes || []).map((l) => (Array.isArray(l) ? l : l.turns || []).join('')).join(',');
const parseLanes = (txt) => txt.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  .map((s) => ({ turns: [...new Set([...s].filter((c) => 'LSR'.includes(c)))] })).filter((l) => l.turns.length);
const laneChips = (lanes) => (lanes.length
  ? lanes.map((l) => `<span class="lane-chip">${l.turns.join('')}</span>`).join('')
  : '<span class="lane-none">no approach</span>');

function renderDesignEditor() {
  const ds = state.design;
  if (!ds) return;
  setRadio('dtype', ds.type || 'signal');
  $('radius').value = ds.radius || ds.roundabout?.radius || 15;
  $('radiusOut').textContent = $('radius').value + ' m';
  paintRange($('radius'));
  renderOrigin();
  $('lanes').innerHTML = ARMS.map((a) => `<div class="lane-row"><b>${a}</b><input data-lane="${a}" value="${esc(lanesToText(a))}" placeholder="—" aria-label="Lanes on approach ${a}" spellcheck="false" autocomplete="off"><div class="lane-chips" data-chips="${a}">${laneChips(parseLanes(lanesToText(a)))}</div></div>`).join('');
  $('lanes').querySelectorAll('input').forEach((i) => i.addEventListener('input', () => {
    $('lanes').querySelector(`[data-chips="${i.dataset.lane}"]`).innerHTML = laneChips(parseLanes(i.value));
    readDesignEditor(true);
    renderBanned();
  }));
  renderPhases();
  renderBanned();
  designVisibility();
  scene.setDesign(ds);
  updateSummaries();
}

function renderOrigin() {
  const o = state.design?.origin || '';
  $('origin').textContent = o;
  $('origin').className = 'badge ' + o;
}

function designVisibility() {
  const t = radio('dtype');
  $('radiusField').hidden = t !== 'roundabout';
  $('phasesField').hidden = !(t === 'signal' && Array.isArray(state.design?.phases) && state.design.phases.length);
}

function renderPhases() {
  const ph = state.design?.phases;
  if (!Array.isArray(ph)) { $('phases').innerHTML = ''; return; }
  $('phases').innerHTML = ph.map((p, i) => {
    const mv = (p.green || p.movements || []).join(' ');
    return `<div class="phase-row"><span class="mv" title="${esc(mv)}">${i + 1}. ${esc(mv) || '—'}</span><span class="input-unit"><input type="number" min="5" max="180" step="1" data-phase="${i}" value="${p.durationSec ?? p.green ?? 30}" aria-label="Phase ${i + 1} duration"><em>s</em></span></div>`;
  }).join('');
  $('phases').querySelectorAll('input').forEach((i) => i.addEventListener('input', () => {
    const v = Math.max(1, Math.round(+i.value || 0));
    const p = state.design.phases[+i.dataset.phase];
    if ('durationSec' in p || !('green' in p) || Array.isArray(p.green)) p.durationSec = v; else p.green = v;
    readDesignEditor(true);
  }));
}

function renderBanned() {
  const ds = state.design;
  const banned = new Set(ds?.bannedMovements || []);
  const arms = ARMS.filter((a) => designArm(a)?.inLanes?.length);
  $('banned').innerHTML = arms.flatMap((a) => ['L', 'S', 'R'].map((t) => {
    const m = `${a}:${t}`;
    return `<button type="button" class="chip" data-mv="${m}" aria-pressed="${banned.has(m)}" title="${TURN_NAME[t]} from ${a}">${m}</button>`;
  })).join('');
}
$('banned').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b || !state.design) return;
  const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(on));
  readDesignEditor(true);
});

function readDesignEditor(edited = false) {
  const ds = state.design;
  if (!ds) return;
  ds.type = radio('dtype');
  ds.radius = ds.type === 'roundabout' ? +$('radius').value : null;
  ds.bannedMovements = [...$('banned').querySelectorAll('.chip[aria-pressed=true]')].map((b) => b.dataset.mv);
  ds.arms = ds.arms || {};
  $('lanes').querySelectorAll('input').forEach((i) => {
    const a = i.dataset.lane;
    const lanes = parseLanes(i.value);
    if (!lanes.length) { if (ds.arms[a]) state.armStash[a] = ds.arms[a]; delete ds.arms[a]; return; }
    ds.arms[a] = { ...(ds.arms[a] || state.armStash[a] || {}), inLanes: lanes };
  });
  const live = new Set(Object.keys(ds.arms));
  ds.bannedMovements = ds.bannedMovements.filter((m) => live.has(m.split(':')[0]));
  if (edited && ds.origin === 'existing') {
    ds.origin = 'user'; ds.id = (ds.id || 'design') + '-edit'; ds.name = (ds.name || 'Design') + ' (edited)';
    renderOrigin();
  }
  designVisibility();
  scene.setDesign(ds);
  updateSummaries();
}

const loadDesign = guard(async () => {
  const id = $('design').value;
  if (!id) return;
  state.design = clone(await api.getDesign(id));
  state.armStash = {};
  renderDesignEditor();
  resetPlayback();
  applyView();
}, 'Could not load design');

const loadDesigns = guard(async () => {
  state.designs = await api.listDesigns();
  const checked = new Set([...$('compareList').querySelectorAll('input:checked')].map((i) => i.value));
  const groups = [['existing', 'Existing junctions'], ['user', 'User designs']];
  $('design').innerHTML = groups.map(([o, label]) => {
    const xs = state.designs.filter((x) => (x.origin || 'user') === o);
    return xs.length ? `<optgroup label="${label}">${xs.map((x) => `<option value="${esc(x.id)}">${esc(x.name || x.id)}</option>`).join('')}</optgroup>` : '';
  }).join('') + state.designs.filter((x) => !['existing', 'user'].includes(x.origin || 'user'))
    .map((x) => `<option value="${esc(x.id)}">${esc(x.name || x.id)}</option>`).join('');
  $('compareList').innerHTML = state.designs.map((x) =>
    `<label class="check"><input type="checkbox" value="${esc(x.id)}" ${checked.has(x.id) ? 'checked' : ''}><span class="nm" title="${esc(x.name || x.id)}">${esc(x.name || x.id)}</span><span class="badge ${esc(x.origin)}">${esc(x.origin || '')}</span></label>`).join('')
    + `<label class="check"><input type="checkbox" value="__current" ${checked.has('__current') ? 'checked' : ''}><span class="nm">Current editor design</span><span class="badge">editor</span></label>`;
  updateSummaries();
  if (state.designs.length && !state.design) await loadDesign();
}, 'Could not list designs');

$('design').addEventListener('change', loadDesign);
$('dtype').addEventListener('change', () => { if (state.design) { readDesignEditor(true); renderPhases(); designVisibility(); } });
$('radius').addEventListener('input', () => { $('radiusOut').textContent = $('radius').value + ' m'; paintRange($('radius')); if (state.design) readDesignEditor(true); });
$('compareList').addEventListener('change', updateSummaries);

$('validate').addEventListener('click', guard(async () => {
  readDesignEditor();
  const r = await api.validateDesign(state.design);
  $('dmsg').className = 'hint ' + (r.ok ? 'good' : 'bad');
  $('dmsg').textContent = r.ok ? '✓ Design is valid.' : 'Invalid: ' + (r.errors || []).join('; ');
  toast(r.ok ? 'ok' : 'warn', r.ok ? 'Design is valid' : 'Design has problems', r.ok ? '' : (r.errors || []).join('; '));
}, 'Validation failed'));
$('save').addEventListener('click', guard(async () => {
  readDesignEditor();
  const ds = clone(state.design);
  ds.origin = 'user';
  const r = await api.saveDesign(ds);
  const id = r?.id || r?.design?.id || ds.id;
  $('dmsg').className = 'hint good';
  $('dmsg').textContent = '✓ Saved as ' + id;
  toast('ok', 'Design saved', id);
  state.design = null;
  await loadDesigns();
  if (id && [...$('design').options].some((o) => o.value === id)) $('design').value = id;
  await loadDesign();
}, 'Could not save design'));

// ---------- step summaries ----------
function updateSummaries() {
  const d = state.demand;
  if (d) {
    const it = state.intersections.find((x) => x.id === $('intersection').value);
    const total = demandArms().reduce((s, a) => s + (d.arms[a]?.vehPerHour || 0), 0);
    const day = radio('day');
    $('sumTraffic').textContent = it
      ? `${it.name || it.id} · ${day} ${hh($('hour').value)} · ${total} veh/h`
      : `Manual demand · ${total} veh/h`;
    $('stepTraffic').classList.add('done');
  }
  if (state.design) {
    $('sumDesign').textContent = `${state.design.name || state.design.id} · ${state.design.type}`;
    $('stepDesign').classList.add('done');
  }
  const n = $('compareList').querySelectorAll('input:checked').length;
  $('sumCompare').textContent = n ? `${n} selected · same demand & seed` : 'Same demand, same seed';
  $('stepCompare').classList.toggle('done', state.compared);
  const it = state.intersections.find((x) => x.id === $('intersection').value);
  scene.setTitle(state.design?.name || state.design?.id || '', it ? `${it.name || it.id} · ${radio('day')} ${hh($('hour').value)}` : 'manual demand');
}

// ---------- metrics ----------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const pick = (srcs, paths) => { for (const s of srcs) for (const p of paths) { const v = num(get(s, p)); if (v != null) return v; } return null; };
const armMap = (srcs, mapPaths, inner) => {
  for (const s of srcs) for (const p of mapPaths) {
    const m = get(s, p);
    if (m && typeof m === 'object') {
      const out = {};
      for (const [a, v] of Object.entries(m)) { const n = num(inner ? v?.[inner] : v); if (n != null) out[a] = n; }
      if (Object.keys(out).length) return out;
    }
  }
  return null;
};
const fmtN = (v, dec = 1) => (v == null ? '–' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : (Number.isInteger(v) ? String(v) : v.toFixed(dec)));

// Headline KPIs, picked defensively from per's metrics and martin's summary (whichever has the key).
const KPIS = [
  { key: 'delay', label: 'Mean delay', unit: 's', color: '#4c8dff', lower: true, get: (s) => pick(s, ['delay.avgSec', 'delay.meanSec', 'delay.mean']) },
  { key: 'p95', label: 'P95 delay', unit: 's', color: '#b98cff', lower: true, get: (s) => pick(s, ['delay.p95Sec', 'delay.p95']) },
  { key: 'throughput', label: 'Throughput', unit: 'veh/h', color: '#2fd27a', lower: false, dec: 0,
    get: (s) => pick(s, ['throughput.perHour', 'throughputVehPerHour', 'throughput.vehPerHour']),
    sub: (s) => { const n = pick(s, ['throughput.vehicles', 'vehicles.exited']); return n == null ? '' : `${fmtN(n, 0)} vehicles exited`; } },
  { key: 'stopped', label: 'Stopped vehicles', unit: 'veh', color: '#ff7a59', lower: true, dec: 0,
    get: (s) => pick(s, ['stopped.vehicles', 'stops.stoppedVehicles']),
    sub: (s) => { const sh = pick(s, ['stops.stoppedShare']); const st = pick(s, ['stopped.avgStopsPerVeh', 'stops.meanStopsPerVehicle']);
      return [sh != null ? `${Math.round(sh * 100)}% of vehicles` : '', st != null ? `${st.toFixed(2)} stops/veh` : ''].filter(Boolean).join(' · '); } },
  { key: 'queue', label: 'Max queue', unit: 'veh', color: '#ffc23d', lower: true, dec: 0,
    get: (s) => { const m = armMap(s, ['queue.maxByArm'], null) || armMap(s, ['queue.perArm'], 'maxVeh'); return m ? Math.max(...Object.values(m)) : null; },
    sub: (s) => { const m = armMap(s, ['queue.maxByArm'], null) || armMap(s, ['queue.perArm'], 'maxVeh'); if (!m) return ''; const w = Object.entries(m).sort((a, b) => b[1] - a[1])[0]; return `worst approach ${w[0]}`; } },
  { key: 'co2', label: 'CO₂', unit: 'kg', color: '#8b98a8', lower: true,
    get: (s) => { const kg = pick(s, ['emissions.co2Kg']); if (kg != null) return kg; const g = pick(s, ['emissions.co2G']); return g == null ? null : g / 1000; },
    sub: (s) => { const g = pick(s, ['emissions.co2GPerVeh', 'emissions.co2GPerVehicle']); return g == null ? '' : `${fmtN(g, 0)} g per vehicle`; } },
  { key: 'ped', label: 'Pedestrian wait', unit: 's', color: '#ff8fb8', lower: true, get: (s) => pick(s, ['pedestrians.avgWaitSec', 'pedestrians.meanWaitSec']) },
  { key: 'bike', label: 'Cyclist delay', unit: 's', color: '#3ddc97', lower: true, get: (s) => pick(s, ['bikes.meanDelaySec', 'bikes.avgDelaySec']) },
];

const SKIP = new Set(['runId', 'design', 'demand', 'note', 'location', 'createdAt', 'id', 'name', 'origin']);
const flatten = (o, p = '', out = {}) => {
  for (const [k, v] of Object.entries(o || {})) {
    if (!p && SKIP.has(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, p + k + '.', out);
    else if (typeof v === 'number') out[p + k] = v;
  }
  return out;
};
// "delay.perArm.N.meanSec" -> { label: "Delay · approach N · mean", unit: "s", v }
const WORD = { avg: 'mean', perArm: '', perMovement: '', maxByArm: 'max', avgByArm: 'mean', byArm: '', co2: 'CO₂', p95: 'p95', veh: 'vehicle', vehicles: 'vehicles' };
function humanize(path, v) {
  const parts = path.split('.');
  let last = parts[parts.length - 1];
  let unit = '';
  const rules = [[/Sec$/, 's'], [/Kg$/, 'kg'], [/GPerVeh(icle)?$/, 'g/veh'], [/G$/, 'g'], [/PerHour$/, 'veh/h', true], [/Share$/, '%'], [/Meters$/, 'm'], [/Veh$/, 'veh']];
  for (const [re, u, keep] of rules) if (re.test(last)) { unit = u; if (!keep) last = last.replace(re, '') || last; break; }
  if (last === 'perHour') { last = 'per hour'; unit = '/h'; }
  if (unit === '%') v = v * 100;
  const words = [...parts.slice(0, -1), last].map((w) => {
    if (/^[NESW]$/.test(w)) return `approach ${w}`;
    if (/^[NESW]:[LSR]$/.test(w)) return `${w[0]} ${TURN_NAME[w[2]].toLowerCase()}`;
    if (w in WORD) return WORD[w];
    return w.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  }).filter(Boolean);
  let label = words.join(' · ');
  label = label.charAt(0).toUpperCase() + label.slice(1);
  return { label, unit, v };
}

function allMetricsTable(sources) {
  const rows = [];
  for (const [name, src] of sources) {
    if (!src) continue;
    const f = flatten(src);
    const keys = Object.keys(f);
    if (!keys.length) continue;
    rows.push(`<tr><td colspan="2" style="color:var(--text-3);font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;padding-top:10px">${esc(name)}</td></tr>`);
    for (const k of keys) {
      const h = humanize(k, f[k]);
      rows.push(`<tr title="${esc(k)}"><td>${esc(h.label)}</td><td class="num">${fmtN(h.v, 2)} <span class="muted">${esc(h.unit)}</span></td></tr>`);
    }
  }
  return rows.length ? `<details class="all"><summary>All metrics</summary><div class="tbl-wrap"><table>${rows.join('')}</table></div></details>` : '';
}

function barsHtml(map, unit, color, dec = 1) {
  if (!map) return '';
  const max = Math.max(...Object.values(map), 1e-9);
  return `<div class="bars">${ARMS.filter((a) => a in map).map((a) =>
    `<div class="bar-row"><b>${a}</b><div class="bar"><i style="width:${(map[a] / max) * 100}%;background:${color}"></i></div><span class="v">${fmtN(map[a], dec)} ${unit}</span></div>`).join('')}</div>`;
}

function renderMetrics(perMetrics, summary, meta = {}) {
  const srcs = [perMetrics, summary].filter(Boolean);
  const cards = KPIS.map((k) => {
    const v = k.get(srcs);
    if (v == null) return '';
    const sub = k.sub ? k.sub(srcs) : '';
    return `<div class="kpi" style="--k:${k.color}"><div class="kpi-label">${k.label}</div><div class="kpi-val">${fmtN(v, k.dec ?? 1)}<small>${k.unit}</small></div>${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ''}</div>`;
  }).join('');
  const delayArm = armMap(srcs, ['delay.perArm', 'delay.byArm'], 'meanSec') || armMap(srcs, ['delay.avgByArm'], null);
  const qMax = armMap(srcs, ['queue.maxByArm'], null) || armMap(srcs, ['queue.perArm'], 'maxVeh');
  const qMean = armMap(srcs, ['queue.avgByArm'], null) || armMap(srcs, ['queue.perArm'], 'meanVeh');
  const warn = (meta.warnings || []).map((w) => `<div class="warn-item">⚠ ${esc(w)}</div>`).join('');
  const src = perMetrics ? 'metrics by per' : 'quick summary by martin (per unavailable)';
  $('metrics').innerHTML = `
    <div class="run-meta">${meta.demo ? '<span class="badge" style="color:var(--warn)">demo</span>' : ''}<b>${esc(meta.name || '')}</b> <span class="badge ${esc(meta.origin)}">${esc(meta.origin || '')}</span> <span>${meta.runId ? 'run ' + esc(meta.runId) + ' · ' : ''}${src}</span></div>
    ${cards ? `<div class="kpis">${cards}</div>` : '<div class="empty">No known metrics in the answer.</div>'}
    ${warn ? `<div class="warnings">${warn}</div>` : ''}
    ${delayArm ? `<div class="sec-title">Mean delay per approach <span class="muted">s</span></div>${barsHtml(delayArm, 's', '#4c8dff')}` : ''}
    ${qMax ? `<div class="sec-title">Max queue per approach <span class="muted">vehicles</span></div>${barsHtml(qMax, 'veh', '#ffc23d', 0)}` : ''}
    ${!qMax && qMean ? `<div class="sec-title">Mean queue per approach</div>${barsHtml(qMean, 'veh', '#ffc23d')}` : ''}
    ${allMetricsTable([['per · metrics', perMetrics], ['martin · summary', summary]])}`;
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
  $('paneMetrics').hidden = name !== 'metrics';
  $('paneCompare').hidden = name !== 'compare';
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ---------- run + playback ----------
function resetPlayback() {
  scene.clearFrames();
  scene.setLayout(null);   // the old run's layout (lanes, bearings) no longer applies
  state.hasFrames = false;
  $('scrub').max = 0; $('scrub').value = 0; $('scrub').disabled = true; $('play').disabled = true;
  $('tNow').textContent = '00:00'; $('tEnd').textContent = '00:00';
  $('play').textContent = '▶';
  paintRange($('scrub'));
  applyView();
}

function setFrames(frames) {
  scene.setFrames(frames);
  $('scrub').max = scene.duration;
  $('scrub').value = 0;
  $('tEnd').textContent = mmss(scene.duration);
  state.hasFrames = frames.length > 0;
  $('scrub').disabled = !state.hasFrames; $('play').disabled = !state.hasFrames;
  applyView();
}

// martin serves at most 600 frames per call: page through the run.
async function fetchAllFrames(runId, duration) {
  const out = new Map();
  for (let from = 0; from <= duration; from += 500) {
    const fr = await api.getFrames(runId, from, Math.min(duration, from + 499.999));
    for (const f of fr) out.set(f.t, f);
    if (!fr.length && from > 0) break;
  }
  return [...out.values()];
}

const runBtn = $('run');
const busy = (on, label) => {
  runBtn.disabled = on; runBtn.classList.toggle('busy', on);
  runBtn.innerHTML = on ? `<span class="run-ico">◌</span> ${label || 'Running…'}` : '<span class="run-ico">▶</span> Run simulation';
};

async function run() {
  if (runBtn.disabled) return;
  if (!state.design) { toast('warn', 'Pick a design first'); return; }
  readDesignEditor();
  syncDemandGlobals();
  if (state.overview) zoomToIntersection();
  busy(true);
  if (state.geo.pending && state.geoWait) {
    // give the OSM lookup a moment so the run uses the real bearings; Overpass can be slow, so do not block for long
    setStatus('Waiting for road bearings…');
    await Promise.race([state.geoWait, new Promise((r) => setTimeout(r, 8000))]);
  }
  setStatus('Simulating…');
  $('demoTag').hidden = true;
  try {
    let res;
    try {
      res = await api.runSim(simDesign(state.design), state.demand);
    } catch (e) {
      if (e.status && e.status >= 400 && e.status < 500) throw e; // our input is wrong: show it, no demo
      showError(e, 'Simulation engine unavailable');
      setFrames(demoFrames(state.design, state.demand));
      $('demoTag').hidden = false;
      setStatus('Showing synthetic demo frames');
      play();
      return;
    }
    state.runId = res.runId || res.id;
    scene.setLayout(res.layout);
    renderAlign();
    busy(true, 'Loading frames…');
    const frames = await fetchAllFrames(state.runId, res.demand?.durationSec ?? state.demand.durationSec);
    setFrames(frames);
    setStatus(`Run ${state.runId} · ${frames.length} frames`);
    play();
    const warnings = Array.isArray(res.warnings) ? res.warnings : [];
    if (warnings.length) toast('warn', `${warnings.length} engine warning${warnings.length > 1 ? 's' : ''}`, warnings[0]);
    const meta = { name: state.design.name || state.design.id, origin: state.design.origin, runId: state.runId, warnings };
    renderMetrics(null, res.summary, meta);
    showTab('metrics');
    renderAlign();
    try { renderMetrics(await api.getMetrics(state.runId), res.summary, meta); }
    catch (e) { showError(e, 'Metrics module unavailable, showing engine summary'); }
  } catch (e) {
    showError(e, 'Run failed');
    setStatus('Run failed');
  } finally {
    busy(false);
  }
}

function play() {
  if (!state.hasFrames) return;
  if (scene.t >= scene.duration) scene.seek(0);
  scene.play();
  $('play').textContent = '❚❚'; $('play').setAttribute('aria-label', 'Pause');
}
function pause() { scene.pause(); $('play').textContent = '▶'; $('play').setAttribute('aria-label', 'Play'); }
const togglePlay = () => (scene.playing ? pause() : play());

runBtn.addEventListener('click', run);
$('play').addEventListener('click', togglePlay);
$('scrub').addEventListener('input', () => { scene.seek(+$('scrub').value); paintRange($('scrub')); });
$('speed').addEventListener('change', () => scene.setSpeed(+radio('speed')));
scene.setSpeed(5);
scene.onTick = (t) => {
  $('scrub').value = t; paintRange($('scrub'));
  $('tNow').textContent = mmss(t);
  if (!scene.playing) { $('play').textContent = '▶'; $('play').setAttribute('aria-label', 'Play'); }
};
scene.onUnsupported = (fields) => toast('info', 'Frame fields not rendered', `The engine sent fields the canvas does not draw: ${fields.join(', ')}`);
$('zoomIn').addEventListener('click', () => scene.zoomBy(1.25));
$('zoomOut').addEventListener('click', () => scene.zoomBy(0.8));
$('zoomFit').addEventListener('click', () => { state.overview = false; scene.fit(); applyView(); });

// ---------- map (OpenStreetMap background) ----------
// Anchor: the selected intersection's lat/lon from backend, else the design's location from be-christian.
function geoAnchor() {
  const it = state.intersections.find((x) => x.id === $('intersection').value);
  if (it && num(it.lat) != null && num(it.lon) != null) return [it.lat, it.lon];
  const loc = state.design?.location;
  if (loc && num(loc.lat) != null && num(loc.lon) != null) return [loc.lat, loc.lon];
  return null;
}

function applyView() {
  const anchor = geoAnchor();
  const mapInput = document.querySelector('input[name="viewMode"][value="map"]');
  const canMap = !!anchor && !tmap._failed;
  mapInput.disabled = !canMap;
  mapInput.parentElement.title = canMap ? 'OpenStreetMap background' : (tmap._failed ? 'Map tiles could not be loaded' : 'No coordinates for this intersection/design');
  if (anchor && (anchor[0] !== tmap.lat0 || anchor[1] !== tmap.lon0)) {
    // in overview keep the same piece of map in view; otherwise follow the new intersection
    if (state.overview && tmap.lat0 != null) {
      const [dx, dy] = tmap.offsetMetres(anchor[0], anchor[1]);
      scene.pan = [scene.pan[0] - dx, scene.pan[1] - dy];
    }
    tmap.setAnchor(anchor[0], anchor[1]);
  }
  const on = state.view === 'map' && canMap;
  setRadio('viewMode', on ? 'map' : 'schematic');
  tmap.setEnabled(on);
  $('attribution').hidden = !on;
  $('overview').disabled = !on || !tmap.markers.length;
  if (!on && state.overview) { state.overview = false; scene.fit(); }
  tmap.showMarkers = on && (!state.hasFrames || state.overview);
  tmap.selectedId = $('intersection').value;
  tmap.hideSelected = !state.overview;
  scene.hint = on && state.overview ? 'Click an intersection marker to load it' : 'Press Run to simulate this design';
  scene.draw();
  refreshBearings();
  renderAlign();
}

// ---------- real arm bearings (bridge until designs carry bearingDeg) ----------
// The engine (martin >= 0.4) lays arms out along design.arms[X].bearingDeg; we inject the bearings we derive
// from OSM into a copy of every design we send. Older engines ignore the field; the canvas then warps the frames.
const simDesign = (d) => (d && state.geo.key === geoKey() ? withBearings(d, state.geo.bearings) : d);
function geoKey() {
  const a = geoAnchor();
  const own = ARMS.map((id) => state.design?.arms?.[id]?.bearingDeg ?? '').join(',');
  return a ? `${a[0]},${a[1]}|${own}` : (state.design?.location ? `${state.design.id}|${own}` : '');
}
let geoSeq = 0;
async function refreshBearings() {
  const key = geoKey();
  if (key === state.geo.key) return;
  const seq = ++geoSeq;
  state.geo = { key, bearings: {}, source: 'none', geometry: null, pending: !!key };
  scene.setBearings({}); scene.setOsmLines(null); renderAlign();
  if (!key || !state.design) { state.geo.pending = false; renderAlign(); return; }
  const p = getArmBearings(state.design, geoAnchor());
  state.geoWait = p;
  const r = await p;
  if (seq !== geoSeq) return;   // a newer intersection/design was picked meanwhile
  state.geo = { key, bearings: r.bearings, source: r.source, geometry: r.geometry, error: r.error, pending: false };
  if (!state.hasFrames) scene.setLayout(null);
  scene.setBearings(r.bearings);
  scene.setOsmLines(r.geometry);
  renderAlign();
}
function renderAlign() {
  const tag = $('alignTag');
  const g = state.geo;
  const arms = Object.entries(g.bearings || {}).map(([a, b]) => `${a} ${Math.round(b)}°`).join(' · ');
  const mode = scene.alignment;
  let text, cls, title;
  if (!g.key) { tag.hidden = true; return; }
  if (g.pending) { text = 'Aligning to OSM roads…'; cls = 'pending'; title = 'Fetching road centrelines from OpenStreetMap (can take ~30 s)'; }
  else if (g.source === 'none') { text = 'Approximate alignment'; cls = 'approx'; title = `Arms drawn at N/E/S/W: real road bearings unavailable (${g.error || 'no data'})`; }
  else if (mode === 'warp') { text = 'Aligned (client warp)'; cls = 'warp'; title = `Engine did not echo bearingDeg; frames warped onto the real bearings: ${arms}`; }
  else { text = g.source === 'design' ? 'Aligned (design bearings)' : 'Aligned to OSM roads'; cls = 'ok'; title = `Arm bearings: ${arms || 'all at their labels'}${mode === 'engine' ? ' · laid out by the engine' : ''}`; }
  tag.hidden = false;
  tag.className = 'align-tag ' + cls;
  tag.textContent = text;
  tag.title = title;
  $('osmLines').disabled = !g.geometry;
}
$('osmLines').addEventListener('change', () => scene.setShowOsm($('osmLines').checked));

function zoomToIntersection() {
  state.overview = false;
  scene.setView([0, 0], MAP_ZOOM);
  applyView();
}

function showOverview() {
  const v = tmap.fitMarkers(scene.w, scene.h);
  if (!v) return;
  state.overview = true;
  scene.setView(v.pan, v.zoom);
  applyView();
}

const selectIntersection = guard(async (id) => {
  $('intersection').value = id;
  resetPlayback();
  await loadDemand();
  zoomToIntersection();
});

tmap.onMarker = (id) => selectIntersection(id);
tmap.onFail = () => {
  toast('warn', 'Map tiles unavailable', 'Could not load OpenStreetMap tiles (offline?). Showing the schematic view.');
  state.view = 'schematic';
  applyView();
};
$('viewMode').addEventListener('change', () => {
  state.view = radio('viewMode');
  if (state.view === 'map' && !state.overview) scene.setView([0, 0], MAP_ZOOM);
  if (state.view === 'schematic') scene.fit();
  applyView();
});
$('overview').addEventListener('click', showOverview);

// ---------- compare ----------
async function compareDesigns(designs) {
  showTab('compare');
  $('compareOut').innerHTML = `<div class="cmp-meta">Running ${designs.length} designs under identical demand (seed ${state.demand.seed})…</div><div class="progress">${designs.map((d, i) =>
    `<div class="row" id="cmpRow${i}"><span>${esc(d.name || d.id)}</span><span class="spinner"></span></div>`).join('')}</div>`;
  const entries = [];
  for (const [i, design] of designs.entries()) {
    const res = await api.runSim(simDesign(design), state.demand);
    const runId = res.runId || res.id;
    let metrics = null;
    try { metrics = await api.getMetrics(runId); } catch (e) { /* fall back to martin's summary */ }
    entries.push({ name: design.name || design.id, origin: design.origin || 'user', suggested: !!design.suggested, current: i === 0 && design.__current, note: design.rationale, metrics, summary: res.summary || {}, runId });
    const row = $(`cmpRow${i}`); if (row) row.lastElementChild.outerHTML = '<span style="color:var(--good)">✓</span>';
  }
  renderCompare(entries);
  state.compared = true;
  updateSummaries();
}

function renderCompare(entries) {
  const vals = entries.map((e) => KPIS.map((k) => k.get([e.metrics, e.summary].filter(Boolean))));
  const rows = KPIS.map((k, ki) => ({ k, ki, vs: vals.map((v) => v[ki]) })).filter((r) => r.vs.some((v) => v != null));
  const wins = entries.map(() => 0);
  const best = rows.map((r) => {
    const present = r.vs.filter((v) => v != null);
    if (present.length < 2) return null;
    const b = r.k.lower ? Math.min(...present) : Math.max(...present);
    if (present.every((v) => v === b)) return null;
    r.vs.forEach((v, i) => { if (v === b) wins[i]++; });
    return b;
  });
  const top = wins.indexOf(Math.max(...wins));
  const L = (i) => String.fromCharCode(65 + i);
  const head = `<tr><th>Metric</th>${entries.map((e, i) => `<th class="num" title="${esc(e.name)}"><span class="letter${i === top && Math.max(...wins) > 0 ? ' win' : ''}">${L(i)}</span></th>`).join('')}</tr>`;
  const body = rows.map((r, ri) => {
    const max = Math.max(...r.vs.filter((v) => v != null), 1e-9);
    return `<tr><td>${r.k.label}<span class="unit">${r.k.unit} · ${r.k.lower ? 'lower' : 'higher'} is better</span></td>${r.vs.map((v) => {
      const isBest = v != null && best[ri] != null && v === best[ri];
      return `<td class="${isBest ? 'best' : ''}"><span class="cv">${fmtN(v, r.k.dec ?? 1)}</span><div class="mini"><i style="width:${v == null ? 0 : (v / max) * 100}%"></i></div></td>`;
    }).join('')}</tr>`;
  }).join('');
  const winner = Math.max(...wins) > 0
    ? `<div class="winner"><span class="trophy">🏆</span><div><b>${L(top)} · ${esc(entries[top].name)}</b><small>best on ${wins[top]} of ${rows.length} metrics</small></div></div>` : '';
  const key = entries.map((e, i) => `<div class="dkey"><span class="letter${i === top && Math.max(...wins) > 0 ? ' win' : ''}">${L(i)}</span><div><b>${esc(e.name)}</b><div class="dbadges"><span class="badge ${esc(e.origin)}">${esc(e.origin)}</span>${e.suggested ? '<span class="badge suggested">suggested</span>' : ''}</div>${e.note ? `<div class="rationale">${esc(e.note)}</div>` : ''}</div></div>`).join('');
  const allKeys = [...new Set(entries.flatMap((e) => Object.keys(flatten(e.metrics || e.summary))))];
  const allRows = allKeys.map((k) => {
    const vs = entries.map((e) => flatten(e.metrics || e.summary)[k]);
    const h = humanize(k, 0);
    return `<tr title="${esc(k)}"><td>${esc(h.label)} <span class="muted">${esc(h.unit)}</span></td>${vs.map((v) => `<td class="num">${v == null ? '' : fmtN(h.unit === '%' ? v * 100 : v, 2)}</td>`).join('')}</tr>`;
  }).join('');
  $('compareOut').innerHTML = `
    <div class="cmp-meta">Identical demand, seed ${esc(state.demand.seed)}, ${esc(state.demand.durationSec)} s. ★ marks the best value per metric.</div>
    ${winner}
    <div class="cmp-wrap"><table class="cmp">${head}${body}</table></div>
    <div class="sec-title">Designs</div>
    <div class="dkeys">${key}</div>
    ${allRows ? `<details class="all"><summary>All metrics</summary><div class="tbl-wrap"><table><tr><th></th>${entries.map((e, i) => `<th class="num" title="${esc(e.name)}">${L(i)}</th>`).join('')}</tr>${allRows}</table></div></details>` : ''}`;
}

$('compare').addEventListener('click', guard(async () => {
  readDesignEditor();
  syncDemandGlobals();
  const picks = [...$('compareList').querySelectorAll('input:checked')].map((i) => i.value);
  if (picks.length < 2) { toast('warn', 'Pick at least two designs', 'Tick two or more designs in step 3 to compare them.'); return; }
  const designs = [];
  for (const id of picks) designs.push(id === '__current' ? clone(state.design) : await api.getDesign(id));
  await compareDesigns(designs);
}, 'Comparison failed'));

$('suggest').addEventListener('click', guard(async () => {
  if (!state.design) { toast('warn', 'Pick a design first'); return; }
  readDesignEditor();
  syncDemandGlobals();
  showTab('compare');
  $('compareOut').innerHTML = '<div class="cmp-meta"><span class="spinner"></span> Asking the design module for variants…</div>';
  const base = clone(state.design);
  const variants = await api.suggestDesigns(simDesign(base), state.demand);
  if (!variants.length) { toast('info', 'No suggestions returned', 'The design module had no variants for this design.'); return; }
  await compareDesigns([base, ...variants]);
}, 'Suggest failed'));

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target.tagName;
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  if (typing && !(e.target.type === 'range' && e.target.id === 'scrub')) return;
  if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'SUMMARY') { e.preventDefault(); togglePlay(); }
  else if ((e.key === 'r' || e.key === 'R') && !typing) { e.preventDefault(); run(); }
  else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && state.hasFrames && (!typing || e.target.id === 'scrub')) {
    e.preventDefault(); scene.seek(scene.t + (e.key === 'ArrowRight' ? 5 : -5));
  } else if (e.key === '+' || e.key === '=') scene.zoomBy(1.2);
  else if (e.key === '-') scene.zoomBy(1 / 1.2);
});

// ---------- start ----------
const init = guard(async () => {
  ['hour', 'scale', 'radius', 'scrub'].forEach((id) => paintRange($(id)));
  state.demand = emptyDemand();
  renderDemand();
  refreshModules();
  setInterval(refreshModules, 15000);
  const ints = await api.listIntersections().catch((e) => { showError(e, 'Traffic data unavailable'); return []; });
  state.intersections = ints;
  $('intersection').innerHTML = '<option value="">Manual demand (no data)</option>' +
    ints.map((i) => `<option value="${esc(i.id)}">${esc(i.name || i.id)}${i.estimated ? ' · est.' : ''}</option>`).join('');
  tmap.markers = ints.filter((i) => num(i.lat) != null && num(i.lon) != null).map((i) => ({ id: i.id, name: i.name || i.id, lat: i.lat, lon: i.lon }));
  await loadDesigns();
  if (ints.length) { $('intersection').value = ints[0].id; await loadDemand(); }
  // default: Map when coordinates are known, else schematic; start with an overview of all intersections
  state.view = geoAnchor() ? 'map' : 'schematic';
  applyView();
  if (state.view === 'map' && tmap.markers.length > 1) showOverview();
  else if (state.view === 'map') zoomToIntersection();
  updateSummaries();
});
init();
