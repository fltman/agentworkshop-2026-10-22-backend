'use strict';
// Simplified models of real Stockholm junctions; lane counts are approximations.
const lane = (...turns) => ({ turns });
const fourArm = (n, e, s, w) => ({ N: { inLanes: n }, E: { inLanes: e }, S: { inLanes: s }, W: { inLanes: w } });
const twoPhase = (a, b) => [
  { durationSec: a, green: ['N:L', 'N:S', 'N:R', 'S:L', 'S:S', 'S:R'] },
  { durationSec: b, green: ['E:L', 'E:S', 'E:R', 'W:L', 'W:S', 'W:R'] },
];

module.exports = [
  {
    id: 'fridhemsplan', name: 'Fridhemsplan (simplified)', origin: 'existing', type: 'signal',
    location: { lat: 59.3333, lon: 18.0314 },
    arms: fourArm([lane('L'), lane('S'), lane('S', 'R')], [lane('L', 'S'), lane('R')], [lane('L'), lane('S'), lane('S', 'R')], [lane('L', 'S'), lane('R')]),
    phases: twoPhase(35, 25), radius: null, bannedMovements: [],
  },
  {
    id: 'sveavagen-odengatan', name: 'Sveavagen / Odengatan (simplified)', origin: 'existing', type: 'signal',
    location: { lat: 59.3436, lon: 18.0496 },
    arms: fourArm([lane('L', 'S', 'R')], [lane('L'), lane('S', 'R')], [lane('L', 'S', 'R')], [lane('L'), lane('S', 'R')]),
    phases: twoPhase(30, 30), radius: null, bannedMovements: [],
  },
  {
    id: 'hornsgatan-langholmsgatan', name: 'Hornsgatan / Langholmsgatan (simplified)', origin: 'existing', type: 'signal',
    location: { lat: 59.3153, lon: 18.0342 },
    arms: fourArm([lane('L', 'S'), lane('S', 'R')], [lane('L', 'S', 'R')], [lane('L', 'S'), lane('S', 'R')], [lane('L', 'S', 'R')]),
    phases: twoPhase(40, 20), radius: null, bannedMovements: ['E:L'],
  },
  {
    id: 'valhallavagen-birgerjarlsgatan', name: 'Valhallavagen / Birger Jarlsgatan (simplified)', origin: 'existing', type: 'signal',
    location: { lat: 59.3501, lon: 18.0591 },
    arms: fourArm([lane('L'), lane('S', 'R')], [lane('L'), lane('S'), lane('S', 'R')], [lane('L', 'S'), lane('R')], [lane('L'), lane('S'), lane('S', 'R')]),
    phases: twoPhase(40, 25), radius: null, bannedMovements: [],
  },
  {
    id: 'roundabout-medium', name: 'Medium roundabout (generic)', origin: 'existing', type: 'roundabout',
    location: null,
    arms: fourArm([lane('L', 'S'), lane('S', 'R')], [lane('L', 'S'), lane('S', 'R')], [lane('L', 'S'), lane('S', 'R')], [lane('L', 'S'), lane('S', 'R')]),
    phases: null, radius: 18, bannedMovements: [],
  },
  {
    id: 'priority-tjunction', name: 'Priority T-junction (generic)', origin: 'existing', type: 'priority',
    location: null,
    arms: { E: { inLanes: [lane('L', 'S')] }, S: { inLanes: [lane('L', 'R')] }, W: { inLanes: [lane('S', 'R')] } },
    phases: null, radius: null, bannedMovements: [],
  },
];
