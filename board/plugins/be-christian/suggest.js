'use strict';
// Heuristic design suggestions. Variants are returned unsaved with origin "user" and suggested:true.
const clone = (o) => JSON.parse(JSON.stringify(o));
const ARMS = ['N', 'E', 'S', 'W'];

function flow(demand, arm) {
  const a = demand && demand.arms && demand.arms[arm];
  return a && a.vehPerHour > 0 ? a.vehPerHour : 0;
}

function leftShare(demand, arm) {
  const a = demand && demand.arms && demand.arms[arm];
  return a && a.turning && a.turning.L > 0 ? a.turning.L : 0;
}

// Two-phase plan (N+S, then E+W) with green split in proportion to volume; only existing movements are listed.
function signalPhases(base, demand, cycle) {
  const arms = Object.keys(base.arms);
  const green = (set) => arms.filter((a) => set.includes(a)).flatMap((a) => base.arms[a].inLanes.flatMap((l) => l.turns.map((t) => a + ':' + t)))
    .filter((m, i, all) => all.indexOf(m) === i && !(base.bannedMovements || []).includes(m));
  const ns = green(['N', 'S']);
  const ew = green(['E', 'W']);
  const fns = flow(demand, 'N') + flow(demand, 'S');
  const few = flow(demand, 'E') + flow(demand, 'W');
  if (!ns.length || !ew.length) return [{ durationSec: cycle, green: ns.concat(ew) }];
  const nsDur = fns + few > 0 ? Math.min(cycle - 10, Math.max(10, Math.round((cycle * fns) / (fns + few)))) : cycle / 2;
  return [{ durationSec: nsDur, green: ns }, { durationSec: cycle - nsDur, green: ew }];
}

function variant(base, suffix, name, why) {
  const v = clone(base);
  v.id = (base.id + '-' + suffix).slice(0, 48);
  v.name = name;
  v.origin = 'user';
  v.suggested = true;
  v.basedOn = base.id;
  v.rationale = why;
  return v;
}

function suggest(base, demand) {
  const out = [];
  const arms = Object.keys(base.arms);
  const ns = flow(demand, 'N') + flow(demand, 'S');
  const ew = flow(demand, 'E') + flow(demand, 'W');

  if (base.type === 'signal' && ns + ew > 0 && Array.isArray(base.phases) && base.phases.length === 2) {
    const cycle = base.phases.reduce((s, p) => s + p.durationSec, 0);
    const usable = Math.max(20, cycle);
    const nsDur = Math.min(usable - 10, Math.max(10, Math.round((usable * ns) / (ns + ew))));
    const v = variant(base, 'balanced', base.name + ' (demand-balanced signals)',
      'Green time split ' + nsDur + '/' + (usable - nsDur) + ' s in proportion to N+S vs E+W volume.');
    v.phases[0].durationSec = nsDur;
    v.phases[1].durationSec = usable - nsDur;
    out.push(v);
  }

  const busyLeft = arms.filter((a) => leftShare(demand, a) >= 0.15 && flow(demand, a) >= 300);
  const needLane = base.type === 'roundabout' ? [] : busyLeft.filter((a) => !base.arms[a].inLanes.some((l) => l.turns.length === 1 && l.turns[0] === 'L') && base.arms[a].inLanes.length < 4);
  if (needLane.length) {
    const v = variant(base, 'leftlane', base.name + ' (dedicated left lanes)',
      'Added a left-only lane on ' + needLane.join(', ') + ' where left turns are heavy.');
    for (const a of needLane) {
      v.arms[a].inLanes.forEach((l) => { l.turns = l.turns.filter((t) => t !== 'L'); });
      v.arms[a].inLanes = v.arms[a].inLanes.filter((l) => l.turns.length);
      v.arms[a].inLanes.unshift({ turns: ['L'] });
      if (v.arms[a].inLanes.length === 1) v.arms[a].inLanes.push({ turns: ['S', 'R'] });
    }
    out.push(v);
  }

  if (base.type !== 'roundabout' && arms.length >= 3) {
    const v = variant(base, 'roundabout', base.name + ' (converted to roundabout)', 'Replaced control with a roundabout of radius 20 m.');
    v.type = 'roundabout';
    v.radius = 20;
    v.phases = null;
    out.push(v);
  }
  const multiLane = arms.some((a) => base.arms[a].inLanes.length >= 2);
  if (multiLane && (base.type !== 'roundabout' || !(base.roundabout && base.roundabout.lanes === 2))) {
    const v = variant(base, 'twolane', base.name + ' (two-lane roundabout)', 'Two circulating lanes, radius at least 20 m, for multi-lane approaches.');
    v.type = 'roundabout';
    v.radius = Math.max(20, base.type === 'roundabout' ? base.radius || 0 : 0);
    v.roundabout = { radius: v.radius, lanes: 2 };
    v.phases = null;
    out.push(v);
  }
  if (base.type !== 'signal' && arms.length >= 3) {
    const v = variant(base, 'tosignal', base.name + ' (converted to signals)', 'Signal control with a 60 s cycle split in proportion to N+S vs E+W volume.');
    v.type = 'signal';
    v.radius = null;
    delete v.roundabout;
    v.phases = signalPhases(base, demand, 60);
    if (v.phases.length) out.push(v);
  }
  if (base.type !== 'priority' && arms.length >= 3) {
    const ranked = arms.slice().sort((a, b) => flow(demand, b) - flow(demand, a));
    const opposite = { N: 'S', S: 'N', E: 'W', W: 'E' };
    const first = ranked[0];
    const major = arms.includes(opposite[first]) ? [first, opposite[first]] : [first, ranked[1]];
    const v = variant(base, 'topriority', base.name + ' (converted to priority junction)', 'Give-way control; major road ' + major.join('/') + ' (busiest approaches).');
    v.type = 'priority';
    v.radius = null;
    v.phases = null;
    delete v.roundabout;
    v.priority = { major };
    out.push(v);
  }
  if (base.type === 'roundabout') {
    const v = variant(base, 'bigger', base.name + ' (larger roundabout)', 'Radius increased by 6 m.');
    v.radius = Math.min(60, (base.radius || 18) + 6);
    out.push(v);
  }
  return out;
}

module.exports = { suggest };
