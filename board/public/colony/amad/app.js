import * as api from './api.js';
import { Scene, demoFrames } from './canvas.js';

const $ = (id) => document.getElementById(id);
const ARMS = ['N', 'E', 'S', 'W'];
const scene = new Scene($('cv'));

const state = {
  demand: null, design: null, designs: [], runId: null, hasFrames: false,
  demandQuery: null, // params of the backend demand being edited; null = manual (local-only) demand
  editedArms: new Set(), // arms the user changed, sent as overrides to POST /t/backend/demand
};

function showError(e) {
  const el = $('error');
  el.hidden = false;
  el.textContent = e && e.message ? e.message : String(e);
  console.error(e);
}
const clearError = () => { $('error').hidden = true; };
const guard = (fn) => async (...a) => { try { clearError(); return await fn(...a); } catch (e) { showError(e); } };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------- module status ----------
async function refreshModules() {
  const st = await api.checkModules();
  $('modules').innerHTML = Object.entries(st)
    .map(([t, s]) => `<span class="${s.reachable ? 'ok' : 'down'}" title="HTTP ${s.status}">${t}</span>`).join('');
}

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

function renderDemand() {
  const d = state.demand;
  const arms = demandArms();
  const head = '<div class="armrow head"><span></span><span>veh/h</span><span>L%</span><span>S%</span><span>R%</span><span>ped/h</span><span>bike/h</span></div>';
  const rows = arms.map((a) => {
    if (!d.arms[a]) d.arms[a] = emptyDemand().arms[a];
    return `<div class="armrow"><b>${a}</b>
      <input data-a="${a}" data-k="vehPerHour" type="number" min="0" step="1">
      ${['L', 'S', 'R'].map((t) => `<input data-a="${a}" data-t="${t}" type="number" min="0">`).join('')}
      <input data-a="${a}" data-k="pedPerHour" type="number" min="0" step="1">
      <input data-a="${a}" data-k="bikePerHour" type="number" min="0" step="1"></div>`;
  }).join('');
  const mix = `<div class="armrow"><b>mix</b>${['car', 'bus', 'truck'].map((c) =>
    `<input data-mix="${c}" type="number" min="0" title="${c} %">`).join('')}<span>% car/bus/truck</span></div>`;
  $('demand').innerHTML = head + rows + mix;
  $('demand').querySelectorAll('input').forEach((i) => {
    i.value = inputValue(i);
    i.addEventListener('input', onDemandInput);
    // a focused field is not overwritten while typing; resync it with the normalised value on blur
    i.addEventListener('blur', () => { i.value = inputValue(i); });
  });
}

// Update existing inputs in place (keeps focus/caret); the focused input is left as the user typed it.
function refreshDemandInputs() {
  $('demand').querySelectorAll('input').forEach((i) => {
    if (i !== document.activeElement) i.value = inputValue(i);
  });
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
  if (state.demandQuery) scheduleDemandPost(); // manual demand stays local-only
}

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
});

function syncDemandGlobals() {
  state.demand.durationSec = +$('duration').value || 300;
  state.demand.seed = +$('seed').value || 42;
}

const loadDemand = guard(async () => {
  clearTimeout(postTimer); postTimer = null; postSeq++;
  state.editedArms = new Set();
  const id = $('intersection').value;
  if (!id) { state.demandQuery = null; state.demand = emptyDemand(); renderDemand(); return; }
  const q = {
    intersection: id, day: $('day').value, hour: +$('hour').value,
    durationSec: +$('duration').value, seed: +$('seed').value, scale: +$('scale').value,
  };
  state.demand = await api.getDemand(q.intersection, q.hour, q.durationSec, q.seed, q.scale, q.day);
  state.demandQuery = q;
  $('duration').value = state.demand.durationSec ?? $('duration').value;
  $('seed').value = state.demand.seed ?? $('seed').value;
  renderDemand();
  // design ids match intersection ids in be-christian's presets
  if ([...$('design').options].some((o) => o.value === id)) { $('design').value = id; await loadDesign(); }
});

// ---------- design ----------
const lanesToText = (arm) => (state.design.arms?.[arm]?.inLanes || []).map((l) => (l.turns || []).join('')).join(',');

function renderDesignEditor() {
  const ds = state.design;
  if (!ds) return;
  $('dtype').value = ds.type || 'signal';
  $('radius').value = ds.radius || 15;
  $('origin').textContent = ds.origin || '';
  $('origin').className = 'badge ' + (ds.origin || '');
  $('banned').value = (ds.bannedMovements || []).join(', ');
  $('lanes').innerHTML = ARMS.map((a) =>
    `<label>${a} lanes <input data-lane="${a}" value="${lanesToText(a)}" placeholder="L,S,SR"></label>`).join('');
  $('lanes').querySelectorAll('input').forEach((i) => i.addEventListener('input', () => readDesignEditor(true)));
  scene.setDesign(ds);
}

function readDesignEditor(edited = false) {
  const ds = state.design;
  ds.type = $('dtype').value;
  ds.radius = ds.type === 'roundabout' ? +$('radius').value : null;
  ds.bannedMovements = $('banned').value.split(/[,\s]+/).filter(Boolean);
  ds.arms = ds.arms || {};
  $('lanes').querySelectorAll('input').forEach((i) => {
    const lanes = i.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
      .map((s) => ({ turns: [...s].filter((c) => 'LSR'.includes(c)) }));
    ds.arms[i.dataset.lane] = { ...(ds.arms[i.dataset.lane] || {}), inLanes: lanes };
  });
  if (edited && ds.origin === 'existing') { ds.origin = 'user'; ds.id = (ds.id || 'design') + '-edit'; ds.name = (ds.name || 'Design') + ' (edited)'; $('origin').textContent = 'user'; $('origin').className = 'badge user'; }
  scene.setDesign(ds);
}

const loadDesign = guard(async () => {
  const id = $('design').value;
  if (!id) return;
  state.design = clone(await api.getDesign(id));
  renderDesignEditor();
});

const loadDesigns = guard(async () => {
  state.designs = await api.listDesigns();
  $('design').innerHTML = state.designs.map((x) =>
    `<option value="${x.id}">${x.name || x.id} [${x.origin || '?'}]</option>`).join('');
  $('compareList').innerHTML = state.designs.map((x) =>
    `<label><span><input type="checkbox" value="${x.id}"> ${x.name || x.id}</span><span class="badge ${x.origin}">${x.origin || ''}</span></label>`).join('')
    + '<label><span><input type="checkbox" value="__current"> current editor design</span></label>';
  if (state.designs.length) await loadDesign();
});

$('design').addEventListener('change', loadDesign);
['dtype', 'radius', 'banned'].forEach((id) => $(id).addEventListener('input', () => state.design && readDesignEditor(true)));
$('validate').addEventListener('click', guard(async () => {
  const r = await api.validateDesign(state.design);
  $('dmsg').className = 'msg' + (r.ok ? '' : ' bad');
  $('dmsg').textContent = r.ok ? 'Design is valid.' : 'Invalid: ' + (r.errors || []).join('; ');
}));
$('save').addEventListener('click', guard(async () => {
  const ds = clone(state.design);
  ds.origin = 'user';
  const r = await api.saveDesign(ds);
  $('dmsg').className = 'msg';
  $('dmsg').textContent = 'Saved as ' + (r.id || ds.id);
  await loadDesigns();
  if (r.id) { $('design').value = r.id; await loadDesign(); }
}));
$('loadDemand').addEventListener('click', loadDemand);

// ---------- run + playback ----------
const flatten = (o, p = '', out = {}) => {
  for (const [k, v] of Object.entries(o || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, p + k + '.', out);
    else if (typeof v === 'number') out[p + k] = v;
  }
  return out;
};
const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(2));

function renderMetrics(m) {
  const f = flatten(m);
  const rows = Object.entries(f).map(([k, v]) => `<tr><td>${k}</td><td>${fmt(v)}</td></tr>`).join('');
  $('metrics').className = 'msg';
  $('metrics').innerHTML = rows ? `<table>${rows}</table>` : 'No numeric metrics returned.';
}

function setFrames(frames) {
  scene.setFrames(frames);
  $('scrub').max = Math.floor(scene.duration);
  $('scrub').value = 0;
  state.hasFrames = frames.length > 0;
}

const run = guard(async () => {
  readDesignEditor();
  syncDemandGlobals();
  $('status').className = 'msg';
  $('status').textContent = 'Running…';
  let res;
  try {
    res = await api.runSim(state.design, state.demand);
  } catch (e) {
    showError(e);
    $('status').className = 'msg bad';
    $('status').textContent = 'Simulation engine unavailable: showing synthetic demo frames.';
    setFrames(demoFrames(state.design, state.demand));
    scene.play();
    return;
  }
  state.runId = res.runId || res.id;
  const frames = await api.getFrames(state.runId, 0, state.demand.durationSec);
  setFrames(frames);
  $('status').textContent = `Run ${state.runId}: ${frames.length} frames`;
  scene.play();
  $('play').textContent = 'Pause';
  try { renderMetrics(await api.getMetrics(state.runId)); }
  catch (e) { showError(e); if (res.summary) renderMetrics(res.summary); }
});

$('run').addEventListener('click', run);
$('play').addEventListener('click', () => {
  if (scene.playing) { scene.pause(); $('play').textContent = 'Play'; }
  else { if (scene.t >= scene.duration) scene.seek(0); scene.play(); $('play').textContent = 'Pause'; }
});
$('scrub').addEventListener('input', () => scene.seek(+$('scrub').value));
$('speed').addEventListener('change', () => scene.setSpeed(+$('speed').value));
scene.setSpeed(5);
scene.onTick = (t) => { $('scrub').value = Math.floor(t); if (!scene.playing) $('play').textContent = 'Play'; };

// ---------- compare ----------
const LOWER_BETTER = (k) => !/throughput/i.test(k);

const compareDesigns = async (designs) => {
  $('compareOut').textContent = 'Running…';
  const entries = [];
  for (const design of designs) {
    const res = await api.runSim(design, state.demand);
    const runId = res.runId || res.id;
    let metrics;
    try { metrics = await api.getMetrics(runId); } catch (e) { metrics = res.summary || {}; }
    entries.push({ name: design.name || design.id, origin: design.origin || 'user', note: design.rationale, metrics: flatten(metrics) });
  }
  const keys = [...new Set(entries.flatMap((e) => Object.keys(e.metrics)))];
  const best = {};
  for (const k of keys) {
    const vals = entries.map((e) => e.metrics[k]).filter((v) => v != null);
    if (vals.length) best[k] = LOWER_BETTER(k) ? Math.min(...vals) : Math.max(...vals);
  }
  const head = `<tr><th>metric</th>${entries.map((e) => `<th>${e.name}<br><span class="badge ${e.origin}">${e.origin}</span></th>`).join('')}</tr>`;
  const body = keys.map((k) => `<tr><td>${k}</td>${entries.map((e) => {
    const v = e.metrics[k];
    return `<td class="${v != null && v === best[k] ? 'best' : ''}">${v == null ? '' : fmt(v)}</td>`;
  }).join('')}</tr>`).join('');
  const notes = entries.filter((e) => e.note).map((e) => `<li><b>${e.name}</b>: ${e.note}</li>`).join('');
  $('compareOut').innerHTML = `<div class="msg">Identical demand, seed ${state.demand.seed}. Best per metric highlighted.</div><table>${head}${body}</table>${notes ? `<ul class="msg">${notes}</ul>` : ''}`;
};

$('compare').addEventListener('click', guard(async () => {
  readDesignEditor();
  syncDemandGlobals();
  const picks = [...$('compareList').querySelectorAll('input:checked')].map((i) => i.value);
  if (picks.length < 2) throw new Error('Pick at least two designs to compare.');
  const designs = [];
  for (const id of picks) designs.push(id === '__current' ? clone(state.design) : await api.getDesign(id));
  await compareDesigns(designs);
}));

$('suggest').addEventListener('click', guard(async () => {
  readDesignEditor();
  syncDemandGlobals();
  $('compareOut').textContent = 'Asking for suggestions…';
  const base = clone(state.design);
  const variants = await api.suggestDesigns(base, state.demand);
  if (!variants.length) throw new Error('No suggestions returned.');
  await compareDesigns([base, ...variants]);
}));

// ---------- start ----------
const init = guard(async () => {
  state.demand = emptyDemand();
  renderDemand();
  refreshModules();
  setInterval(refreshModules, 15000);
  const ints = await api.listIntersections().catch((e) => { showError(e); return []; });
  $('intersection').innerHTML = '<option value="">(manual demand)</option>' +
    ints.map((i) => `<option value="${i.id}">${i.name || i.id}${i.estimated ? ' (est.)' : ''}</option>`).join('');
  await loadDesigns();
  if (ints.length) { $('intersection').value = ints[0].id; await loadDemand(); }
});
init();
