'use strict';

function round(n, d = 1) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

// events: martin event list, frames: optional per-second frames (for queues)
function computeMetrics(events, frames, durationSec, summary) {
  events = events || [];
  const exits = events.filter((e) => e.type === 'exit');
  const delays = exits.map((e) => Number(e.delaySec) || 0).sort((a, b) => a - b);
  const totalDelay = delays.reduce((s, d) => s + d, 0);
  const stoppedVeh = exits.filter((e) => (e.stops || 0) > 0).length;
  const totalStops = exits.reduce((s, e) => s + (e.stops || 0), 0);
  const co2 = exits.reduce((s, e) => s + (Number(e.co2G) || 0), 0);
  const pedWaits = events.filter((e) => e.type === 'ped_done').map((e) => Number(e.waitSec) || 0);

  const maxByArm = {};
  const sumByArm = {};
  let n = 0;
  for (const f of frames || []) {
    n++;
    for (const [arm, q] of Object.entries(f.q || {})) {
      maxByArm[arm] = Math.max(maxByArm[arm] || 0, q);
      sumByArm[arm] = (sumByArm[arm] || 0) + q;
    }
  }
  const avgByArm = {};
  for (const arm of Object.keys(sumByArm)) avgByArm[arm] = round(sumByArm[arm] / n);

  const sm = summary || {};
  let dur = Number(durationSec) || 0;
  if (!dur) dur = events.reduce((m, e) => Math.max(m, e.t || 0), 0);

  return {
    durationSec: dur,
    delay: {
      avgSec: round(exits.length ? totalDelay / exits.length : 0),
      // meanSec counts unserved vehicles (engine 0.5+); falls back to the exited mean
      meanSec: round(sm.delay && sm.delay.meanSec != null ? sm.delay.meanSec : exits.length ? totalDelay / exits.length : 0),
      unservedShare: sm.delay && sm.delay.unservedShare != null ? sm.delay.unservedShare : null,
      p95Sec: round(percentile(delays, 0.95)),
      totalSec: round(totalDelay),
    },
    vehicles: sm.vehicles || null,
    queue: { maxByArm, avgByArm },
    throughput: {
      vehicles: exits.length,
      perHour: dur ? Math.round((exits.length * 3600) / dur) : 0,
    },
    stopped: {
      vehicles: stoppedVeh,
      avgStopsPerVeh: round(exits.length ? totalStops / exits.length : 0, 2),
    },
    pedestrians: {
      crossed: pedWaits.length,
      avgWaitSec: round(pedWaits.length ? pedWaits.reduce((s, w) => s + w, 0) / pedWaits.length : 0),
    },
    emissions: {
      co2G: Math.round(co2),
      co2GPerVeh: Math.round(exits.length ? co2 / exits.length : 0),
    },
  };
}

// Lower is better, except throughput (negated).
const METRIC_KEYS = {
  delay: (m) => m.delay.meanSec,
  queue: (m) => Math.max(0, ...Object.values(m.queue.maxByArm)),
  throughput: (m) => -m.throughput.vehicles,
  stopped: (m) => m.stopped.vehicles,
  emissions: (m) => m.emissions.co2G,
};

function compareRuns(runs) {
  const best = {};
  for (const [key, fn] of Object.entries(METRIC_KEYS)) {
    let b = null;
    for (const r of runs) if (b === null || fn(r) < fn(b)) b = r;
    best[key] = b ? b.runId : null;
  }
  const ranking = runs
    .slice()
    .sort((a, b) => METRIC_KEYS.delay(a) - METRIC_KEYS.delay(b) || METRIC_KEYS.emissions(a) - METRIC_KEYS.emissions(b))
    .map((r) => r.runId);
  return { best, ranking };
}

module.exports = { computeMetrics, compareRuns };
