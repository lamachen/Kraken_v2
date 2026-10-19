#!/usr/bin/env node
/**
 * Headless test harness for public/sim.js
 * -------------------------------------------------------------
 * Runs the REAL simulation (real matter.min.js, real sim.js) inside a minimal
 * DOM stub so physics/AI behaviour can be MEASURED in Node instead of guessed
 * from a browser window.
 *
 * Usage:
 *   node tools/headless.js                 # full diagnostic report
 *   node tools/headless.js --quick         # short run
 *   node tools/headless.js --gens 30       # more evolution generations
 *   node tools/headless.js --baseline      # compare against git HEAD~ version
 *
 * Reads public/sim.js only. Never writes to it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SIM_PATH = process.env.SIM_PATH || path.join(ROOT, 'public', 'sim.js');
const MATTER_PATH = path.join(ROOT, 'public', 'matter.min.js');

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const QUICK = argv.includes('--quick');
const GENS = parseInt(getArg('gens', QUICK ? 4 : 14), 10);
const BOOT_STEPS = parseInt(getArg('boot-steps', QUICK ? 30 : 120), 10);
const MEASURE_STEPS = parseInt(getArg('measure-steps', QUICK ? 250 : 500), 10);
const SILENT = argv.includes('--silent');
const OUT = getArg('out', 'last-report.json');

// ─────────────────────────────────────────────────────────────
//  Minimal DOM stubs
// ─────────────────────────────────────────────────────────────
const NOOP = () => {};

function makeCtx2D(canvas) {
  const store = {
    canvas,
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', shadowColor: 'transparent',
    shadowBlur: 0, imageSmoothingEnabled: true, font: '10px sans-serif',
    textAlign: 'start', textBaseline: 'alphabetic', filter: 'none',
  };
  const gradient = { addColorStop: NOOP };
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'createRadialGradient' || k === 'createLinearGradient' || k === 'createPattern') return () => gradient;
      if (k === 'createImageData') return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
      if (k === 'getImageData') return (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
      if (k === 'measureText') return () => ({ width: 10 });
      return NOOP;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

function makeCanvas(w = 300, h = 150) {
  const c = {
    width: w, height: h, style: {}, nodeName: 'CANVAS',
    getContext: () => (c._ctx || (c._ctx = makeCtx2D(c))),
    addEventListener: NOOP, removeEventListener: NOOP,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h }),
    setAttribute: NOOP, appendChild: NOOP,
  };
  return c;
}

function makeElement(id) {
  return {
    id, nodeName: 'DIV', textContent: '', innerHTML: '', value: '0',
    style: new Proxy({}, { get: (t, k) => t[k] || '', set: (t, k, v) => { t[k] = v; return true; } }),
    classList: { add: NOOP, remove: NOOP, toggle: NOOP, contains: () => false },
    dataset: {},
    querySelector: () => makeElement(id + ':q'),
    querySelectorAll: () => [],
    addEventListener: NOOP, removeEventListener: NOOP,
    appendChild: NOOP, setAttribute: NOOP, focus: NOOP, click: NOOP,
    getContext: undefined,
  };
}

const elCache = new Map();
const documentStub = {
  readyState: 'complete',
  body: makeElement('body'),
  documentElement: makeElement('html'),
  createElement: (tag) => (String(tag).toLowerCase() === 'canvas' ? makeCanvas() : makeElement('created-' + tag)),
  createElementNS: () => makeCanvas(),
  getElementById: (id) => {
    if (!elCache.has(id)) elCache.set(id, String(id) === 'c' ? makeCanvas(1440, 810) : makeElement(id));
    return elCache.get(id);
  },
  querySelector: (s) => makeElement(String(s)),
  querySelectorAll: () => [],
  addEventListener: NOOP, removeEventListener: NOOP,
};

const windowStub = {
  innerWidth: 1440, innerHeight: 810, devicePixelRatio: 1,
  document: documentStub, console,
  performance: { now: () => Date.now() },
  Date, Math, JSON,
  addEventListener: NOOP, removeEventListener: NOOP,
  requestAnimationFrame: (fn) => { windowStub.__raf = fn; return ++windowStub.__rafId; },
  cancelAnimationFrame: NOOP,
  setTimeout: (fn) => { windowStub.__timeouts.push(fn); return windowStub.__timeouts.length; },
  clearTimeout: NOOP,
  __timeouts: [], __rafId: 0, __raf: null,
};
windowStub.window = windowStub; windowStub.self = windowStub;

// ─────────────────────────────────────────────────────────────
//  Load matter + sim
// ─────────────────────────────────────────────────────────────
const Matter = require(MATTER_PATH);
windowStub.__MTR__ = Matter; windowStub.Matter = Matter;

const sandbox = Object.assign(Object.create(null), windowStub, {
  window: windowStub, document: documentStub, console,
  performance: windowStub.performance,
  requestAnimationFrame: windowStub.requestAnimationFrame,
  cancelAnimationFrame: windowStub.cancelAnimationFrame,
  setTimeout: windowStub.setTimeout, clearTimeout: windowStub.clearTimeout,
  Math, Date, JSON, Float32Array, Uint8Array, Uint8ClampedArray, Int32Array,
  Array, Object, Number, String, Boolean, isNaN, parseInt, parseFloat,
  Proxy, Map, Set, Error, RegExp, Symbol, Promise, process,
});
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let simSrc = fs.readFileSync(SIM_PATH, 'utf8');
const tail = '})(window);';
const tailIdx = simSrc.lastIndexOf(tail);
if (tailIdx < 0) { console.error('IIFE tail not found in ' + SIM_PATH); process.exit(1); }
simSrc = simSrc.slice(0, tailIdx) +
  'window.__dbg = () => ({ evlv, playS, MAP, CHEM, WAVES, world, engine, OVR, simMode, Composite, Body, Vector, DT, PHASES, CONN_SEGS, CONN_SL, N_CONN, popSz,' +
  ' Matter: (typeof Matter!=="undefined"?Matter:(window.__MTR__||null)), SUBSTEPS: (typeof SUBSTEPS!=="undefined"?SUBSTEPS:1), MAX_LIN_V: (typeof MAX_LIN_V!=="undefined"?MAX_LIN_V:11),' +
  ' MAX_ANG_V: (typeof MAX_ANG_V!=="undefined"?MAX_ANG_V:0.3), JET_MAX: (typeof JET_MAX!=="undefined"?JET_MAX:0), MUSCLE_TMAX: (typeof MUSCLE_TMAX!=="undefined"?MUSCLE_TMAX:0) });\n' +
  tail;

// silence the sim's own chatter unless asked for
const realLog = console.log;
console.log = (...a) => { if (!SILENT && String(a[0]).indexOf('Matter object structure') < 0) realLog(...a); };
try { vm.runInContext(simSrc, sandbox, { filename: path.basename(SIM_PATH) }); }
catch (e) { console.error('\n❌ sim.js failed to load: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 5).join('\n')); process.exit(1); }

const log = (...a) => realLog(...a);
const results = { simPath: SIM_PATH };

try { sandbox.window.bootSimulation(); }
catch (e) { console.error('\n❌ bootSimulation() crashed: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 6).join('\n')); process.exit(1); }
// simulate the duplicate call page.tsx makes
try { sandbox.window.bootSimulation(); } catch (e) { /* guard should swallow this */ }

const dbg = sandbox.window.__dbg();
if (!dbg || !dbg.evlv) { console.error('\n❌ Evolver not created — boot aborted early.'); process.exit(1); }

let simT = 0;
function step(n = 1) {
  for (let i = 0; i < n; i++) {
    simT += 16.7;
    const fn = sandbox.window.__raf; sandbox.window.__raf = null;
    if (typeof fn === 'function') fn(simT);
    else if (dbg.evlv && dbg.simMode === 'TRAIN') dbg.evlv.step();
  }
}
function rawStep() { dbg.evlv.step(); }

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'NaN/Inf');
const bar = (t) => log('\n' + '═'.repeat(70) + '\n ' + t + '\n' + '═'.repeat(70));

function worldStats() {
  const bodies = dbg.Composite.allBodies(dbg.world);
  let nan = 0, maxAbs = 0, outOfBounds = 0, maxV = 0, maxAV = 0;
  for (const b of bodies) {
    const p = b.position, v = b.velocity;
    if (![p.x, p.y, v.x, v.y, b.angle, b.angularVelocity].every(Number.isFinite)) nan++;
    maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.y));
    maxV = Math.max(maxV, Math.hypot(v.x, v.y));
    maxAV = Math.max(maxAV, Math.abs(b.angularVelocity));
    if (p.x < -50 || p.x > 1490 || p.y < -50 || p.y > 860) outOfBounds++;
  }
  return { nBodies: bodies.length, nConstraints: dbg.Composite.allConstraints(dbg.world).length, nan, maxAbs, outOfBounds, maxV, maxAV };
}

// ── TEST 0a: double boot ──────────────────────────────────────
bar('TEST 0a — DOPPEL-BOOT / VERWAISTE POPULATION');
{
  const nBodies = dbg.Composite.allBodies(dbg.world).length;
  const nWalls = dbg.MAP.matterWalls.length;
  const nOrgs = dbg.evlv.orgs.length;
  const perOrg = 1 + dbg.N_CONN * dbg.CONN_SEGS;
  const expected = nWalls + nOrgs * perOrg;
  Object.assign(results, { bodiesActual: nBodies, bodiesExpected: expected, walls: nWalls });
  results.doubleBootOK = Math.abs(nBodies - expected) <= 2;
  log('  Bodies im World:      ' + nBodies);
  log('  Erwartet (1 Pop.):    ' + expected + '   (' + nWalls + ' Walls + ' + nOrgs + ' Kraken × ' + perOrg + ')');
  log('  Wände vorhanden:      ' + nWalls + (nWalls > 0 ? ' ✅' : ' ❌ KEINE — ohne Wände gibt es nichts zu greifen'));
  log(results.doubleBootOK && nWalls > 0 ? '  ✅ Genau eine Population, Karte intakt.'
    : '  ❌ ' + (nWalls === 0 ? 'Karte leer!' : (nBodies - expected) / perOrg + ' Kraken-Leichen im World.'));
}

// ── TEST 0b: spawn constraint violation ───────────────────────
bar('TEST 0b — SPAWN-SNAP: Constraint-Verletzung in Frame 0');
{
  const o = dbg.evlv.orgs[0];
  // Matter rotiert constraint.pointA/pointB selbst inkrementell (Constraint.solve),
  // der gespeicherte Wert ist also bereits WELT-ausgerichtet relativ zu body.position.
  // Zusätzliches Rotieren um body.angle würde die Verletzung vortäuschen.
  // Verifiziert gegen Matter.Constraint.pointAWorld/pointBWorld → Separation 0.000000.
  const rot = (b, p) => ({ x: b.position.x + p.x, y: b.position.y + p.y });
  let worstAnchor = 0, worstSeg = 0, nA = 0, nS = 0, angSync = true;
  for (const org of dbg.evlv.orgs) {
    if (Math.abs(org.ang - org.pt.body.angle) > 1e-6) angSync = false;
    for (const c of org.conns) {
      const a = c.anchor, p1 = rot(a.bodyA, a.pointA), p2 = rot(a.bodyB, a.pointB);
      worstAnchor = Math.max(worstAnchor, Math.hypot(p1.x - p2.x, p1.y - p2.y) - a.length); nA++;
      for (const k of c.constraints) {
        const q1 = rot(k.bodyA, k.pointA), q2 = rot(k.bodyB, k.pointB);
        worstSeg = Math.max(worstSeg, Math.hypot(q1.x - q2.x, q1.y - q2.y) - k.length); nS++;
      }
    }
  }
  Object.assign(results, { spawnAnchorErr: worstAnchor, spawnSegErr: worstSeg, angSync });
  results.spawnCleanOK = worstAnchor < 1 && worstSeg < 1 && angSync;
  log('  Organism.ang ≡ Core-Body.angle:  ' + (angSync ? '✅ ja' : '❌ NEIN (desynchron)'));
  log('  Grösste Schulter-Verletzung:     ' + fmt(worstAnchor, 3) + ' px   (über ' + nA + ' Schultern)');
  log('  Grösste Segment-Verletzung:      ' + fmt(worstSeg, 3) + ' px   (über ' + nS + ' Gelenke)');
  log(results.spawnCleanOK ? '  ✅ Spawn ist constraint-frei — kein Solver-Snap in Frame 1.'
    : '  ❌ Verletzung > 1 px → Solver reisst die Arme auseinander.');
}

// ── TEST 0c: velocity explosion ───────────────────────────────
bar('TEST 0c — GESCHWINDIGKEIT Frame für Frame (erste 15 Frames)');
{
  const trace = [];
  for (let i = 0; i < 15; i++) { step(1); trace.push({ i: i + 1, ...worldStats() }); }
  log(' frame | max|v| px/step |   px/s   | max|ω| rad/step | out-of-map');
  for (const r of trace) {
    log(String(r.i).padStart(6) + ' | ' + fmt(r.maxV, 2).padStart(14) + ' | ' + fmt(r.maxV * 60, 0).padStart(8) +
      ' | ' + fmt(r.maxAV, 4).padStart(15) + ' | ' + String(r.outOfBounds).padStart(10));
  }
  results.peakV = Math.max(...trace.map(r => r.maxV));
  results.peakAV = Math.max(...trace.map(r => r.maxAV));
  results.velocityOK = results.peakV <= (dbg.MAX_LIN_V || 6) * 1.35 && results.peakV < 20;
  log('  Peak |v| = ' + fmt(results.peakV, 2) + ' px/step (' + fmt(results.peakV * 60, 0) + ' px/s), Limit = ' + fmt(dbg.MAX_LIN_V, 2));
  log(results.velocityOK ? '  ✅ Im Limit.' : '  ❌ Weit über dem Limit — Clamp greift nicht.');
}

// ── TEST 1: long-run stability ────────────────────────────────
bar('TEST 1 — DAUERLAUF-STABILITÄT (' + BOOT_STEPS + ' Schritte)');
{
  const t1 = [];
  const t0 = Date.now();
  for (let i = 0; i < BOOT_STEPS; i++) { step(1); if (i < 5 || i % 25 === 24 || i === BOOT_STEPS - 1) t1.push({ step: i + 1, ...worldStats() }); }
  const ms = Date.now() - t0;
  log(' step | bodies | constr | NaN | out-of-map | max|v| | steps/s');
  for (const r of t1) log(String(r.step).padStart(5) + ' | ' + String(r.nBodies).padStart(6) + ' | ' + String(r.nConstraints).padStart(6) + ' | ' + String(r.nan).padStart(3) + ' | ' + String(r.outOfBounds).padStart(10) + ' | ' + fmt(r.maxV, 2).padStart(6) + ' | ' + fmt(BOOT_STEPS / (ms / 1000), 0).padStart(7));
  const last = t1[t1.length - 1];
  Object.assign(results, { longRun: last, stepsPerSec: BOOT_STEPS / (ms / 1000) });
  results.stableOK = last.nan === 0 && last.outOfBounds === 0 && last.maxAbs < 2000;
  log(results.stableOK ? '\n✅ Stabil über ' + BOOT_STEPS + ' Schritte: keine NaN, nichts ausserhalb der Karte.'
    : '\n❌ INSTABIL: ' + last.nan + ' NaN, ' + last.outOfBounds + ' ausserhalb, max|pos|=' + fmt(last.maxAbs, 1));
}

// ── TEST 2: matter world leak ─────────────────────────────────
bar('TEST 2 — MATTER-WORLD LEAK bei wiederholtem MAP.build()');
{
  // Die Wandanzahl ist pro Build zufällig → verglichen wird der Anteil
  // "Nicht-Wand-Bodies". Der darf bei wiederholtem build() NICHT wachsen.
  const nonWalls = () => dbg.Composite.allBodies(dbg.world).length - dbg.MAP.matterWalls.length;
  const rowsT = [];
  for (let k = 0; k < 4; k++) { dbg.MAP.build(); rowsT.push({ total: dbg.Composite.allBodies(dbg.world).length, walls: dbg.MAP.matterWalls.length, other: nonWalls() }); }
  results.wallLeak = rowsT[3].other - rowsT[0].other;
  results.wallLeakOK = Math.abs(results.wallLeak) <= 2;
  log('  build# | Bodies gesamt | davon Wände | Rest (Kraken/Beute)');
  rowsT.forEach((r, i) => log('    ' + (i + 1) + '    | ' + String(r.total).padStart(13) + ' | ' + String(r.walls).padStart(11) + ' | ' + String(r.other).padStart(19)));
  log(results.wallLeakOK ? '  ✅ Alte Wände werden entfernt, der World wächst nicht mit.'
    : '  ❌ LEAK: ' + results.wallLeak + ' Bodies bleiben pro Build liegen — Geisterwände stapeln sich.');
}

// ── helper: measure one organism ──────────────────────────────
function measureOrganism(o, steps, sharedTick) {
  const sx = o.x, sy = o.y;
  let path = 0, px = o.x, py = o.y, angAcc = 0, fwd = 0, gripTicks = 0, spinGrip = 0, jetFirings = 0;
  let prevJet = 0;
  const nets = [];
  for (let i = 0; i < steps; i++) {
    const ax = o.x, ay = o.y;
    if (!sharedTick) rawStep();
    const dx = o.x - ax, dy = o.y - ay;
    path += Math.hypot(dx, dy);
    angAcc += Math.abs(o.av);
    const fa = o.faceAng !== undefined ? o.faceAng : o.ang;
    const proj = dx * Math.cos(fa) + dy * Math.sin(fa);
    if (proj > 0) fwd += proj;
    const gripped = o.conns.some(c => c.alive && c.cups.some(s => s.gripped));
    if (gripped) { gripTicks++; if (Math.abs(o.av) > 0.04) spinGrip++; }
    if ((o.jetCharge || 0) < prevJet - 0.5) jetFirings++;
    prevJet = o.jetCharge || 0;
    if (i % 25 === 24) nets.push(Math.hypot(o.x - sx, o.y - sy));
    px = o.x; py = o.y;
  }
  const disp = Math.hypot(o.x - sx, o.y - sy);
  return {
    disp, path, angAcc, rotations: angAcc / (Math.PI * 2), gripTicks, spinGrip, jetFirings,
    straightness: path > 1 ? disp / path : 0,
    forwardProg: o.forwardProg || 0,
    maxDisp: o.maxDisplacement || 0,
    gripPullProg: o.gripPullProg || 0,
    energySpent: o.energySpent || 0,
    wallHits: o.wallHits || 0,
    score: o.score(0),
    meanNet: nets.reduce((a, b) => a + b, 0) / Math.max(1, nets.length),
    efficiency: (o.forwardProg || 0) / Math.max(0.5, o.energySpent || 0),
  };
}

function measureOrganismStatic(o, steps) {
  const disp = o.maxDisplacement || 0;
  const path = o.pathLen || 0;
  return {
    disp, path, angAcc: o.angularAccum || 0, rotations: (o.angularAccum || 0) / (Math.PI * 2),
    gripTicks: o.gripCount || 0, spinGrip: 0, jetFirings: Math.round(o.jetImpulse ? o.jetImpulse * 3 : 0),
    straightness: path > 1 ? disp / path : 0,
    forwardProg: o.forwardProg || 0, maxDisp: disp, gripPullProg: o.gripPullProg || 0,
    energySpent: o.energySpent || 0, wallHits: o.wallHits || 0, score: o.score(0), meanNet: disp,
    efficiency: (o.forwardProg || 0) / Math.max(0.5, o.energySpent || 0),
  };
}

// ── TEST 3: evolution ─────────────────────────────────────────
bar('TEST 3 — EVOLUTION: ' + GENS + ' Generationen Phase 0 (je ' + MEASURE_STEPS + ' Schritte)');
dbg.evlv.setPhase(0);
{
  const genLog = [];
  // WICHTIG: _evo() selektiert UND erzeugt die Folgepopulation (Eliten + Mutanten).
  // Ein zusätzliches _ng() VOR der Messung würde diese Eliten durch bestW-Mutanten
  // ersetzen und den kompletten Lernfortschritt zwischen den Generationen löschen.
  dbg.evlv._ng();
  for (let g = 0; g < GENS; g++) {
    for (let i = 0; i < MEASURE_STEPS; i++) rawStep();
    const ms = dbg.evlv.orgs.map(o => measureOrganismStatic(o, MEASURE_STEPS));
    const m = ms.reduce((a, b) => (b.score > a.score ? b : a));
    dbg.evlv._evo();          // Selektion auf die gerade gemessene Population
    genLog.push(m);
    log('  G' + String(g).padStart(2) +
      '  score=' + fmt(m.score, 1).padStart(8) +
      '  vorwärts=' + fmt(m.forwardProg, 0).padStart(7) +
      '  maxDist=' + fmt(m.maxDisp, 0).padStart(6) +
      '  Pfad=' + fmt(m.path, 0).padStart(6) +
      '  Umdreh.=' + fmt(m.rotations, 1).padStart(6) +
      '  Gerade=' + fmt(m.straightness * 100, 0).padStart(4) + '%' +
      '  Grip-Kriech=' + fmt(m.gripPullProg, 0).padStart(6) +
      '  Jet=' + String(m.jetFirings).padStart(3) +
      '  Wand=' + String(m.wallHits).padStart(3));
  }
  results.genLog = genLog;
  const first = genLog[0], lastG = genLog[genLog.length - 1];
  const bestFirst = genLog.slice(0, Math.max(1, Math.floor(GENS / 3))).reduce((a, b) => (b.forwardProg > a.forwardProg ? b : a));
  const bestLast = genLog.slice(-Math.max(1, Math.floor(GENS / 3))).reduce((a, b) => (b.forwardProg > a.forwardProg ? b : a));
  results.forwardStart = bestFirst.forwardProg; results.forwardEnd = bestLast.forwardProg;
  results.spinRotations = lastG.rotations;
  const firstScore = genLog.slice(0, Math.max(1, Math.floor(GENS/3))).reduce((a,b)=>(b.score>a.score?b:a));
  const lastScore  = genLog.slice(-Math.max(1, Math.floor(GENS/3))).reduce((a,b)=>(b.score>a.score?b:a));
  results.scoreStart = firstScore.score; results.scoreEnd = lastScore.score;
  results.maxDispStart = firstScore.maxDisp; results.maxDispEnd = lastScore.maxDisp;
  const slope = (arr) => {
    const n = arr.length; if (n < 3) return 0;
    const mx = (n - 1) / 2, my = arr.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - mx) * (arr[i] - my); den += (i - mx) * (i - mx); }
    return den ? num / den : 0;
  };
  const sScore = slope(genLog.map(g => g.score));
  const sFwd   = slope(genLog.map(g => g.forwardProg));
  const sDisp  = slope(genLog.map(g => g.maxDisp));
  results.slopeScore = sScore; results.slopeFwd = sFwd; results.slopeDisp = sDisp;
  results.learningOK = sScore > 0.5 && (sFwd > 0.3 || sDisp > 0.15);
  results.spinOK = lastG.rotations < 6;
  log('\n  Bester Score (erstes → letztes Drittel): ' + fmt(firstScore.score,1) + ' → ' + fmt(lastScore.score,1));
  log('  Netto-Distanz  (erstes → letztes Drittel): ' + fmt(firstScore.maxDisp,0) + ' → ' + fmt(lastScore.maxDisp,0) + ' px');
  log('  Vorwärts-Projektion: ' + fmt(bestFirst.forwardProg, 0) + ' → ' + fmt(bestLast.forwardProg, 0) + ' px');
  log('  Linearer Trend/Generation: Score ' + fmt(sScore,2) + ' | vorwärts ' + fmt(sFwd,2) + ' px | Netto ' + fmt(sDisp,2) + ' px');
  log('  Rotation des Letzten: ' + fmt(lastG.rotations, 2) + ' Umdrehungen');
  log(results.learningOK ? '  ✅ Positiver Trend: Evolution verbessert Score UND echte Fortbewegung.'
    : '  ⚠️  Trend flach über ' + GENS + ' Kurz-Episoden (echt: 100 s = 6000 Schritte/Gen).');
  log(results.spinOK ? '  ✅ Kein dominantes Kreiseln mehr.' : '  ❌ Kreiseln dominiert weiterhin.');
}

// ── TEST 4: propulsion ───────────────────────────────────────
bar('TEST 4 — JET-ANTRIEB (Verdrahtung + Physik)');
{
  const src = fs.readFileSync(SIM_PATH, 'utf8');
  // (a) Verdrahtung: out[0]/out[1] müssen den Jet steuern
  results.jetWired = /jetCmd\s*=\s*out\[0\]/.test(src) && /jetAim\s*=\s*[^;]*out\[1\]/.test(src);
  log('  (a) out[0]/out[1] → Jet verdrahtet: ' + (results.jetWired ? '✅' : '❌'));

  // (b) Physik: erzeugt ein Mantel-Stoß gerichtete Bewegung?
  dbg.evlv._ng();
  const o = dbg.evlv.orgs[0];
  for (const c of o.conns) { c.suctionOn = false; for (const s of c.cups) s.release(); }
  const sx = o.x, sy = o.y;
  let path = 0, px = o.x, py = o.y, pulses = 0;
  for (let i = 0; i < 300; i++) {
    rawStep();
    for (const c of o.conns) { c.suctionOn = false; for (const s of c.cups) if (s.gripped) s.release(); }
    if (i % 25 === 0) {   // Puls alle ~0.42 s wie JET_REFRACT
      const a = o.faceAng, F = dbg.JET_MAX * (dbg.SUBSTEPS || 1);
      dbg.Body.applyForce(o.pt.body, o.pt.body.position, { x: Math.cos(a) * F, y: Math.sin(a) * F });
      pulses++;
    }
    const d = Math.hypot(o.x - px, o.y - py); path += d; px = o.x; py = o.y;
  }
  const disp = Math.hypot(o.x - sx, o.y - sy);
  results.jetPath = path; results.jetDist = disp; results.jetDirected = path > 1 ? disp / path : 0;
  results.jetOK = results.jetWired && path > 150 && results.jetDirected > 0.35;
  log('  (b) ' + pulses + ' Mantel-Stöße → Pfad ' + fmt(path, 0) + ' px, Netto ' + fmt(disp, 0) +
    ' px, Gerichtetheit ' + fmt(results.jetDirected * 100, 0) + '%');
  log('      Ø Tempo: ' + fmt(path / 300 * 60, 0) + ' px/s  (Karte ist 1440 px breit)');
  log(results.jetOK ? '  ✅ Jet liefert gerichteten Antrieb — Schwimmen ohne Grip ist möglich.'
    : '  ❌ Jet zu schwach/ungerichtet.');
}

// ── TEST 5: tentacle collision ────────────────────────────────
bar('TEST 5 — TENTAKEL-KOLLISION & SENSORIK');
{
  const o = dbg.evlv.orgs[0];
  let seg = 0, masked = 0, sensor = 0, wallMask = 0;
  for (const c of o.conns) for (const p of c.pts) {
    seg++;
    if (p.body.collisionFilter.mask !== 0) masked++;
    if (p.body.collisionFilter.mask & 0x0001) wallMask++;
    if (p.body.isSensor) sensor++;
  }
  Object.assign(results, { tentacleSegments: seg, tentacleMasked: masked, tentacleWallMask: wallMask, tentacleSensors: sensor });
  results.tentacleOK = wallMask === seg && sensor === 0;
  log('  Segmente: ' + seg + ' | mit Wall-Maske: ' + wallMask + ' | isSensor: ' + sensor);
  log(results.tentacleOK ? '  ✅ Alle Segmente kollidieren echt mit Wänden — Abstützen & Tasten möglich.'
    : '  ❌ Tentakel geistern durch die Welt.');
}

// ── TEST 6: runtime errors ────────────────────────────────────
bar('TEST 6 — LAUFZEITFEHLER & UNGENUTZTE SYMBOLE');
{
  let err = null;
  try { rawStep(); } catch (e) { err = e; }
  results.stepError = err ? err.message : null;
  log(err ? '  ❌ evlv.step() wirft: ' + err.message + '\n     ' + (err.stack || '').split('\n')[1] : '  ✅ evlv.step() ohne Exception.');
  const srcRaw = fs.readFileSync(SIM_PATH, 'utf8');
  const src = srcRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');  // Kommentare raus
  const dead = [];
  if (!/DEBRIS\s*=/.test(src)) dead.push('DEBRIS undefiniert');
  if (/this\.stepCount\+\+/.test(src)) dead.push('Evolver.stepCount++ auf undefined');
  if (!/angularAccum\s*\+=/.test(src)) dead.push('angularAccum wird nie erhöht');
  if (!/wallHits\s*\+\+|wallHits\+=/.test(src)) dead.push('wallHits wird nie erhöht');
  if (!/o\.postPhysics|\.postPhysics\(\)/.test(src)) dead.push('postPhysics() wird nie aufgerufen');
  if (!/__simBooted/.test(src)) dead.push('kein Doppel-Boot-Guard');
  results.deadSymbols = dead;
  log(dead.length ? '  ❌ ' + dead.join(' | ') : '  ✅ Alle kritischen Pfade verdrahtet.');
}

// ── TEST 7: NN I/O wiring ─────────────────────────────────────
bar('TEST 7 — NN EINGÄNGE / AUSGÄNGE');
{
  const o = dbg.evlv.orgs[0];
  rawStep();
  const src = fs.readFileSync(SIM_PATH, 'utf8');
  const inputs = o.lIn;
  let constant = 0;
  for (let i = 0; i < inputs.length; i++) if (Math.abs(inputs[i]) < 1e-9) constant++;
  const deadOut = [];
  for (let k = 0; k < o.lOut.length; k++) {
    const re = new RegExp('out\\[' + k + '\\]');
    const re2 = new RegExp('out\\[2\\+k\\*4\\+' + (k - 2) + '\\]');
    if (!re.test(src) && !(k >= 2 && k <= 25 && /out\[2\+k\*4\+/.test(src))) deadOut.push(k);
  }
  results.deadOutputs = deadOut;
  results.inputUsage = { total: inputs.length, currentlyZero: constant };
  log('  Eingänge: ' + inputs.length + ' (davon gerade 0: ' + constant + ')');
  log('  Ausgänge: ' + o.lOut.length + ' | ungenutzt laut Quelltext: ' + (deadOut.length ? deadOut.join(',') : 'keine'));
  log('  out[0]=Jet-Intensität, out[1]=Jet-Richtung, out[2..25]=6 Arme ×(Schulter,Welle,Krümmung,Saug), out[26]=Echo');
  log(deadOut.length === 0 ? '  ✅ Alle Ausgänge verdrahtet.' : '  ⚠️  ' + deadOut.length + ' tote Ausgänge.');
}

// ── TEST 8: performance ───────────────────────────────────────
bar('TEST 8 — PERFORMANCE');
{
  const N = QUICK ? 120 : 300;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) rawStep();
  const ms = Date.now() - t0;
  results.sps = N / (ms / 1000);
  results.perfOK = results.sps > 100;   // 100 steps/s = Echtzeit (60 fps) + 1.7× Trainings-Headroom
  log('  ' + N + ' Sim-Schritte in ' + ms + ' ms → ' + fmt(results.sps, 0) + ' steps/s');
  log('  Bei 60 fps Echtzeit braucht es 60 steps/s. Training mit ' + fmt(results.sps / 60, 1) + '× möglich.');
  log(results.perfOK ? '  ✅ Schnell genug für beschleunigtes Training.' : '  ⚠️  Langsam — SUBSTEPS/Iterations reduzieren.');
}

// ── SUMMARY ───────────────────────────────────────────────────
bar('ZUSAMMENFASSUNG');
const rows = [
  ['0a  Genau eine Population + intakte Karte', results.doubleBootOK && results.walls > 0],
  ['0b  Spawn ohne Constraint-Verletzung', results.spawnCleanOK],
  ['0c  Geschwindigkeit im Limit (kein Rausfliegen)', results.velocityOK],
  ['1   Dauerlauf stabil (keine NaN / OOB)', results.stableOK],
  ['2   Kein Matter-World-Leak', results.wallLeakOK],
  ['3   Kein dominantes Kreiseln (< 6 Umdrehungen)', results.spinOK],
  ['3   Evolution steigert Vorwärtsbewegung', results.learningOK],
  ['4   Jet-Antrieb funktioniert', results.jetOK],
  ['5   Tentakel kollidieren mit der Welt', results.tentacleOK],
  ['6   step() ohne Exception', !results.stepError],
  ['6   Keine toten kritischen Pfade', (results.deadSymbols || []).length === 0],
  ['8   Performance > 100 steps/s (Echtzeit-tauglich)', results.perfOK],
];
let pass = 0;
for (const [name, ok] of rows) { log((ok ? '  ✅ ' : '  ❌ ') + name); if (ok) pass++; }
log('\n  ' + pass + '/' + rows.length + ' Checks bestanden.');
results.pass = pass; results.total = rows.length;
fs.writeFileSync(path.join(__dirname, OUT), JSON.stringify(results, null, 2));
process.exit(pass === rows.length ? 0 : 2);
