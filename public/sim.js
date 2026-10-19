
'use strict';
(function(window) {
  console.log('sim.js executing...');
  window._simLoaded = true;

  // Hoisted function exports: make controls available to window immediately
  const earlyControls = {
    setMode, tryPlay, togglePause, setSp, toggleAutoSpeed, doReset,
    toggleEvo, forceMut, addPrey, clearPrey, newGen, nextPhase,
    setPhase, setPopSz, tog, rebuildMap, setMapRegen, exitPlay,
    bootSimulation, layoutTouch
  };
  window.__realHandlers = earlyControls;
  Object.assign(window, earlyControls);


let engine, world;
let Engine, World, Bodies, Body, Composite, Constraint, Vector;
const COL_WALL=0x0001, COL_CORE=0x0002, COL_TENTACLE=0x0004, COL_PREY=0x0008;

let matterMissingLogged = false;
function initMatter() {
  let MTR = window.__MTR__ || window.Matter;
  if (MTR && !MTR.Engine && MTR.default && MTR.default.Engine) {
    MTR = MTR.default;
  }
  if (!MTR || !MTR.Engine) {
    if (!matterMissingLogged) {
      matterMissingLogged = true;
      console.log('Matter.js initializing...');
    }
    return false;
  }
  matterMissingLogged = false;
  console.log('Matter object structure:', Object.keys(MTR));
  Engine = MTR.Engine;
  World = MTR.World;
  Bodies = MTR.Bodies;
  Body = MTR.Body;
  Composite = MTR.Composite;
  Constraint = MTR.Constraint;
  Vector = MTR.Vector;

  if (!Engine || !World || !Bodies) {
    console.error('Critical Matter components missing!');
    return false;
  }

  if (!engine) {
    try {
      engine = Engine.create({ 
        gravity: { x: 0, y: 0 }, 
        positionIterations: 12, 
        velocityIterations: 10, 
        constraintIterations: 8 
      });
      world = engine.world;
      console.log('Matter engine and world initialized successfully.');
    } catch (e) {
      console.error('Engine.create failed:', e);
      return false;
    }
  }
  return true;
}
const DT=1/60;

// ══════════════════════════════════════════════════════════════
//  PHYSIK-KALIBRIERUNG (gemessen an matter-js 0.20.0)
//  Matter integriert mit deltaTimeSquared = (delta[ms])² = 277.78
//    → Δv = (F / m) · 277.78   [px/step]
//    → Δω = (τ / I) · 277.78   [rad/step]
//  Alle Kräfte/Momente unten sind in diesen Einheiten kalibriert.
// ══════════════════════════════════════════════════════════════
const M_DT2      = 277.78;   // Matter's deltaTimeSquared bei 60 Hz
const SUBSTEPS   = 2;        // Physik-Substeps pro Sim-Step (Constraint-Relaxation)
const SUB_DT     = DT / SUBSTEPS;
const SUB_COMP   = SUBSTEPS; // Impuls-Kompensation: τ_pro_Substep · SUBSTEPS · (dt/SUBSTEPS)² = τ · dt²

const MAX_LIN_V  = 6.0;      // px/step  ≈ 360 px/s  — hartes Limit, verhindert "aus der Map fliegen"
const MAX_ANG_V  = 0.30;     // rad/step für Tentakelsegmente (sonst sättigt der
                             // stärkere Muskel dauernd am Clamp = Bang-Bang)
const MAX_ANG_V_CORE = 0.025; // Rumpf dreht träge (breite Auflagefläche → hohe Rotationsreibung).
// Ohne diese Dämpfung addieren sich die Reaktionsmomente der 6 Arme zu einer
// Dauerdrehung und das Tier schlägt Haken statt gerade zu ziehen
// (gemessen vorher: 1049 px Pfad bei 30 px Netto = geschlossene Bahn).
// ⚠ KEIN WASSER. Die Viecher kriechen auf einer Oberfläche (Draufsicht,
// gravity = 0). Es gibt keinen Auftrieb, keinen Strömungswiderstand und kein
// Rudern — Arme im freien Raum erzeugen keinerlei Vortrieb.
// Was es gibt: Reibung gegen den Untergrund. Die läuft über `frictionAir` im
// Matter-Integrator (constraint-konsistent), NICHT über nachträgliche
// setVelocity-Aufrufe — siehe Kommentar bei Pt.step().
const DRAG_CORE  = 0.075;    // Reibung Rumpf am Untergrund
const DRAG_SEG   = 0.085;    // Reibung Armsegmente am Untergrund
const DRAG_PREY  = 0.090;    // Reibung Beute am Untergrund
const DRAG_ANG   = 0.16;     // Reserve-Winkeldämpfung für Segmente
const CORE_ANG_DRAG = 0.40;  // Rotationsreibung des Rumpfes am Untergrund (echtes Drehmoment)

const MUSCLE_TMAX= 0.0135;   // max. Gelenkmoment. Per Sweep (tools/tune-grip.js) bestimmt:
                             // ×3 war in allen Top-Konfigurationen der gemeinsame Faktor —
                             // Ø Vortrieb 64 px → 166 px über 10 Inchworm-Zyklen.
const MUSCLE_KP  = 0.35;     // PD: proportional — per Sweep (tools/tune.js) bestimmt
const MUSCLE_KD  = 0.50;     // PD: differential — per Sweep bestimmt, dämpft den Grenzzyklus
const SHOULDER_TMAX = 0.042; // Schulter muss die ganze Armkette schwenken UND den Zug
                             // auf den Rumpf übertragen — zusammen mit MUSCLE_TMAX gesweept (eff. Trägheit ≈ 7×)

const N_CONN=6,N_AUD=8;
const CONN_SEGS=7,CONN_SL=13.5;
// Gelenkwinkel-Limits (rad) — echte Cephalopoden-Arme knicken nicht beliebig
const JOINT_LIMIT=Math.PI*0.42;
const SHOULDER_LIMIT=Math.PI*0.62;

// ─── CPG (Central Pattern Generator) ─────────────────────────
// Erzeugt die metachronale Welle über alle Arme. Ohne diesen Rhythmus-
// Prior muss die Evolution 27 chaotische Ausgänge gleichzeitig entdecken —
// die stabilste lokale Lösung ist dann "im Kreis zappeln".
// out[0] und out[1] steuern jetzt zwei GLOBALLE Arm-Parameter — beides reine
// Muskel-/Gelenk-Stellgrößen, niemals eine Kraft auf den Rumpf:
const TONE_MIN   = 0.30;     // out[1] = Muskeltonus: 0.30 = schlaff, 1.0 = steif
const CPG_HZ_MIN = 0.35;     // out[0] = Wellenfrequenz der metachronalen Welle
const CPG_HZ_MAX = 1.70;     //   (in Vielfachen von CPG_BASE_HZ)
const SUCK_ON    = 0.15;     // ab hier haftet der Saugnapf an
const SUCK_OFF   = -0.15;    // erst hierunter lässt er wieder los (Hysterese)
const GRIP_BREAK = 22;       // px — ab welcher Dehnung ein Saugnapf abreißt
const GRIP_MAX_TIME = 0;     // 0 = deaktiviert. Ein Saugnapf hat keinen Timer —
                             // automatisches Loslassen nach 3 s war reines Scripting
                             // und physikalisch unsinnig. Ein Anker hält jetzt, bis er
                             // mechanisch abreißt (GRIP_BREAK) oder die KI ihn über die
                             // SUCK_OFF-Hysterese selbst löst.
const CPG_BASE_HZ=1.15;      // Grundfrequenz der Armwelle
const CPG_WAVE_NUMBER=1.0;   // Phasenversatz pro Arm (1.0 = volle metachronale Welle)
const PULL_ASYM=1.8;         // >1 = langsam strecken, schnell ziehen.
                             // Eine symmetrische Sinuswelle zieht im Mittel genau-
                             // soweit zurück wie sie holt — der Gang braucht diese
                             // Asymmetrie, damit überhaupt Netto-Vortrieb entsteht.
const DEBRIS=[];             // war undefiniert → latenter Crash in _damTent/takeDamage
// Saugnäpfe sitzen bei echten Cephalopoden auf der GANZEN Arm-Unterseite.
// Der alte Wert [CONN_SEGS] = [7] lag außerhalb des Segmente-Arrays (0..6) und
// wurde außerdem gar nicht benutzt — es gab einen einzigen Napf ganz außen.
// Drei Näpfe pro Arm = 18 Ankerpunkte: zusammen mit OVR.floorGrip kann die KI
// damit auch mehrarmig koordiniert ziehen, nicht nur mit einer einzigen Spitze.
const SUCTION_IDX = [2, 4, CONN_SEGS-1];
// NI 64 → 104: 40 neue Eingänge sind PROPRIOZEPTION.
// Bisher standen Echolot, Chemie, Licht, Grip-Status, Tempo und Wandnähe drin —
// aber kein einziger Gelenkwinkel. Die KI war blind für die Pose ihrer eigenen
// Arme, ein Körpermodell konnte so nicht entstehen. Layout siehe buildInputs().
const NI=104,NH=32,NO=27;
const NSW=NI*NH+NH+NH*NH+NH+NH*NO+NO;   // war hartkodierte 64 → hätte abgeschnitten
const ARM_REACH=24+CONN_SEGS*CONN_SL;   // 118.5 px — Normierung der Propriozeption
let NEXT_GROUP = -1;

const PHASES=[
  {id:0,name:'MOTOR PRIMITIVES',  sub:'Grip & pull — anchor, curl, drag',   preyN:0, pSpd:0,  dur:100,gpp:12,mut:{r:.055,m:.16}},
  {id:1,name:'ECHOLOCATION',      sub:'Map corridors via echo pulses',      preyN:0, pSpd:0,  dur:90, gpp:10,mut:{r:.045,m:.13}},
  {id:2,name:'CHEMOTAXIS',        sub:'Follow scent trails',                preyN:2, pSpd:.4, dur:80, gpp:8, mut:{r:.04,m:.11}},
  {id:3,name:'ACTIVE PURSUIT',    sub:'Chase and grip prey',                preyN:3, pSpd:1.0,dur:80, gpp:8, mut:{r:.035,m:.10}},
  {id:4,name:'EVASIVE PREY',      sub:'High-speed prey — commit',           preyN:2, pSpd:2.0,dur:80, gpp:8, mut:{r:.03,m:.09}},
  {id:5,name:'FREE EMERGENCE',    sub:'All behaviors consolidate',          preyN:5, pSpd:1.3,dur:100,gpp:99,mut:{r:.025,m:.08}},
];

// ─── MATH ───────────────────────────────────────────────
class V2{
  constructor(x=0,y=0){this.x=x;this.y=y}
  clone(){return new V2(this.x,this.y)}
  add(v){return new V2(this.x+v.x,this.y+v.y)}
  sub(v){return new V2(this.x-v.x,this.y-v.y)}
  sc(s){return new V2(this.x*s,this.y*s)}
  len(){return Math.hypot(this.x,this.y)}
  norm(){const l=this.len();return l>1e-7?this.sc(1/l):new V2}
  static fa(a,l=1){return new V2(Math.cos(a)*l,Math.sin(a)*l)}
}
const lerp=(a,b,t)=>a+(b-a)*t;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const rnd=()=>Math.random();
const rng=(a,b)=>a+(b-a)*rnd();
function rgb(h){const r=h.replace('#','');return[parseInt(r.slice(0,2),16),parseInt(r.slice(2,4),16),parseInt(r.slice(4,6),16)]}
/**
 * Winkel-Differenz auf (-π, π].
 *
 * ⚠ PERFORMANCE-KRITISCH: Die alte Fassung normalisierte mit
 *     while(d>Math.PI) d-=Math.PI*2;
 * Matter.js normiert `body.angle` aber NIE — der Wert wächst unbegrenzt.
 * Nach ein paar hundert Schritten waren |angle| > 1e6 rad erreicht, die
 * Schleife lief dann ~284.000 Durchgänge PRO AUFRUF. Bei 432 Aufrufen pro
 * Sim-Schritt (6 Kraken × 6 Arme × 6 Gelenke × 2 Substeps) sind das über
 * 100 Mio. Iterationen/Schritt → applyMuscles kostete 50 ms statt 0.05 ms
 * und wurde mit jedem Frame langsamer.
 * Der Restmodulo macht das O(1), unabhängig von der Winkelgröße.
 */
const TAU=Math.PI*2;
function angDiff(a,b){
  let d=(a-b)%TAU;
  if(!Number.isFinite(d))return 0;
  if(d>Math.PI)d-=TAU;else if(d<-Math.PI)d+=TAU;
  return d;
}
/** Wickelt einen Winkel auf (-π, π] — für body.angle-Normalisierung. */
function wrapAngle(a){let d=a%TAU;if(d>Math.PI)d-=TAU;else if(d<-Math.PI)d+=TAU;return d}

// ─── NEURAL NETWORK ─────────────────────────────────────
function nnNew(){const w=new Float32Array(NSW);for(let i=0;i<w.length;i++)w[i]=(rnd()-.5)*1.6;return w}
// Geteilte Scratch-Puffer: nnFwd lief pro Sim-Schritt 8× und hat dabei je 3
// Float32Arrays allokiert — 24 Objekte/Step bzw. ~1440/s, die den GC beschäftigt
// und die Simulationsrate gedrückt haben.
// ACHTUNG: `out` ist damit GETEILT. Aufrufer müssen den Inhalt sofort sichern
// (Organism.tick macht this.lOut.set(out) / this.prevOut.set(out)).
const _NN_H1=new Float32Array(NH), _NN_H2=new Float32Array(NH), _NN_OUT=new Float32Array(NO);
function nnFwd(w,x){
  const o1=0,b1=NI*NH,o2=b1+NH,b2=o2+NH*NH,o3=b2+NH,b3=o3+NH*NO;
  const h1=_NN_H1,h2=_NN_H2,out=_NN_OUT;
  for(let j=0;j<NH;j++){let s=w[b1+j];for(let i=0;i<NI;i++)s+=x[i]*w[o1+j*NI+i];h1[j]=Math.tanh(s)}
  for(let j=0;j<NH;j++){let s=w[b2+j];for(let i=0;i<NH;i++)s+=h1[i]*w[o2+j*NH+i];h2[j]=Math.tanh(s)}
  for(let j=0;j<NO;j++){let s=w[b3+j];for(let i=0;i<NH;i++)s+=h2[i]*w[o3+j*NH+i];out[j]=Math.tanh(s)}
  return{out}
}
function nnMut(w,r,m){const c=w.slice();for(let i=0;i<c.length;i++){if(rnd()<r)c[i]+=(rnd()-.5)*2*m;if(rnd()<.003)c[i]=(rnd()-.5)*2.5}return c}
function nnCross(a,b){const c=new Float32Array(a.length);if(rnd()<.5)for(let i=0;i<c.length;i++)c[i]=rnd()<.5?a[i]:b[i];else{const p=~~(rnd()*c.length);for(let i=0;i<c.length;i++)c[i]=i<p?a[i]:b[i]}return c}

// ─── CANVAS ─────────────────────────────────────────────
function toLog(ex,ey){ return { x: (ex - vX)/viewScale, y: (ey - vY)/viewScale }; }

let cv, ctx;
let LC, lctx;
const LOGIC_W=1440, LOGIC_H=810;
let W=LOGIC_W, H=LOGIC_H, TH=42, BH=44, MBH=0;
let viewScale=1, vX=0, vY=0;
const MOB=window.innerWidth<768||('ontouchstart' in window);
function resize(){
  const ww=window.innerWidth, wh=window.innerHeight;
  console.log('resize() called. window size:', ww, wh);
  if (!cv) {
    cv = document.getElementById('c');
    if (!cv) {
      console.warn('Canvas #c not found in resize()');
      return;
    }
    ctx = cv.getContext('2d');
    LC = document.createElement('canvas');
    lctx = LC.getContext('2d');
    console.log('Canvas context initialized.');
  }
  if (ww <= 0 || wh <= 0) {
    console.warn('Invalid window size, skipping resize math.');
    return;
  }
  cv.width=LC.width=ww; cv.height=LC.height=wh;
  const sX=ww/LOGIC_W, sY=wh/LOGIC_H;
  viewScale=Math.min(sX,sY);
  if (viewScale <= 0 || isNaN(viewScale)) viewScale = 1;
  vX=(ww-LOGIC_W*viewScale)/2; vY=(wh-LOGIC_H*viewScale)/2;
  console.log('Resize complete. Scale:', viewScale, 'Offset:', vX, vY);
  MBH=MOB?16:0;
  WAVES.init(W,H);
  if(typeof MAP!=='undefined')WAVES.buildWalls(MAP);
}

// ─── VERLET (NOW MATTER.JS WRAPPER) ────────────────────────
class Pt{
  constructor(x,y,m=1,r=6,isStatic=false, options={}){
    // Use the global variables initialized in initMatter
    const cr = r; // Joints are small and non-colliding
    const mask = options.mask !== undefined ? options.mask : 0; // DEFAULT TO SENSOR
    const category = options.category || COL_TENTACLE;
    
    if (options.shape === 'capsule') {
      // ⚠ GEOMETRIE-BUG (Hauptursache der Instabilität):
      //   collisionLength = max(1, length - thickness) = max(1, 13.5 - 11.9) = 1.6 px
      //   bei 11.9 px Dicke, dazu chamfer radius = 5.95 > min(w,h)/2.
      //   Ergebnis: ein degenerierter 1.6×11.9-Splitter mit inertia = 0.2
      //   (korrekt wären ~9). Bei Rumpfmasse 30 ergab das ein Massen-/Trägheits-
      //   verhältnis von 250:1 — Sequential-Impulse-Solver schleudern so etwas weg:
      //   gemessen ω = 976 rad/step und |v| = 91 px/step im ALLERERSTEN Frame,
      //   bei komplett deaktivierten Aktuatoren.
      // Matter's chamfer rundet Ecken nach INNEN ab, es verlängert die Form nicht.
      // Eine Kapsel ist also rectangle(L, T) mit chamfer radius ≤ T/2.
      const collisionLength = Math.max(options.thickness * 1.02, options.length);
      this.body = Bodies.rectangle(x, y, collisionLength, options.thickness, {
        mass: m,
        frictionAir: options.frictionAir !== undefined ? options.frictionAir : 0.05,
        isStatic: isStatic,
        chamfer: { radius: Math.min(options.thickness * 0.48, collisionLength * 0.48) },
        collisionFilter: { category: category, mask: mask, group: options.group || 0 },
        ...options
      });
    } else {
      this.body = Bodies.circle(x, y, cr, {
        mass: m,
        frictionAir: options.frictionAir !== undefined ? options.frictionAir : 0.05,
        isStatic: isStatic,
        collisionFilter: { 
          category: category, 
          mask: mask, 
          group: options.group || 0
        },
        ...options
      });
    }
    World.add(world, this.body);
    this.r = r;
  }
  get x(){ return this.body.position.x }
  get y(){ return this.body.position.y }
  set x(v){ Body.setPosition(this.body, {x:v, y:this.body.position.y}) }
  set y(v){ Body.setPosition(this.body, {x:this.body.position.x, y:v}) }
  get px(){ return this.body.positionPrev.x }
  get py(){ return this.body.positionPrev.y }
  set px(v){ this.body.positionPrev.x = v }
  set py(v){ this.body.positionPrev.y = v }

  // KEIN force() mehr. Eine translationale Kraft am Schwerpunkt eines Arms ist
  // genau das Muster, das hier nicht vorkommen darf: eine von außen aufgedrückte
  // Schiebekraft, die über den Arm den ganzen Körper mitnimmt. Bewegung entsteht
  // ausschließlich aus Gelenkmomenten (Pt.torque) und aus Verankerung.
  /**
   * Echtes Drehmoment. `Body.applyForce(b, b.position, f)` erzeugt KEIN
   * Drehmoment (Hebelarm 0) — die alte "Muskel"-Implementierung hat also
   * nur translationell geschoben und die Segmente nie rotiert.
   */
  torque(t){
    if(!Number.isFinite(t))return;
    this.body.torque += clamp(t,-1,1);
  }
  /**
   * Sicherheitsnetz NACH Engine.update(): NaN-Guard, harte Limits, Winkel-Wrapping.
   *
   * ⚠ WICHTIG: Der Wasserwiderstand wird NICHT hier gemacht, sondern über
   * `body.frictionAir` direkt im Matter-Integrator. Früher stand hier ein
   * `Body.setVelocity(v * damp)` für JEDES der 258 Bodies in JEDEM Frame.
   * Das überschreibt die Verlet-Historie (positionPrev), aus der der
   * Constraint-Solver seine Impulse ableitet — bei einer Gelenkkette injectiert
   * man so permanent Energie. Messbar als Dauer-Oszillation von 276 px Pfad
   * bei einem komplett passiven Kraken. `frictionAir` dagegen wird von Matter
   * konsistent VOR der Constraint-Lösung angewendet.
   */
  step() {
    const maxAV = this.maxAV || MAX_ANG_V;
    const b=this.body, v=b.velocity;
    if(!Number.isFinite(v.x)||!Number.isFinite(v.y)||!Number.isFinite(b.position.x)||!Number.isFinite(b.position.y)
       ||!Number.isFinite(b.angle)||!Number.isFinite(b.angularVelocity)){
      Body.setPosition(b,{x:W*.5,y:(TH+H-BH)*.5});
      Body.setVelocity(b,{x:0,y:0});
      Body.setAngularVelocity(b,0);
      b.force.x=0;b.force.y=0;b.torque=0;
      return true; // repariert
    }
    // Harte Limits — greifen nur im Ausnahmefall, nicht jeden Frame
    const sp=Math.hypot(v.x,v.y);
    if(sp>MAX_LIN_V){ const s=MAX_LIN_V/sp; Body.setVelocity(b,{x:v.x*s,y:v.y*s}); }
    const av=b.angularVelocity;
    if(Math.abs(av)>maxAV) Body.setAngularVelocity(b,Math.sign(av)*maxAV);
    b.force.x=0;b.force.y=0;b.torque=0;
    // Winkel einwickeln: cos/sin bleiben identisch, aber angDiff und alle
    // Betragsvergleiche arbeiten mit kleinen Zahlen (numerisch sauberer).
    if(Math.abs(b.angle)>50){
      const wrapped=wrapAngle(b.angle);
      const delta=wrapped-b.angle;
      b.angle=wrapped;
      b.anglePrev+=delta;      // Winkelgeschwindigkeit unverändert lassen
    }
    return false;
  }
  /** Weiche Karte-Grenze: schiebt zurück statt hart abzuprallen. */
  contain(pad){
    const b=this.body, p=b.position;
    const x0=pad, x1=W-pad, y0=TH+MBH+pad, y1=H-BH-pad;
    if(p.x<x0||p.x>x1||p.y<y0||p.y>y1){
      const nx=clamp(p.x,x0,x1), ny=clamp(p.y,y0,y1);
      Body.setPosition(b,{x:nx,y:ny});
      const v=b.velocity;
      Body.setVelocity(b,{x:(p.x!==nx)?-v.x*0.25:v.x, y:(p.y!==ny)?-v.y*0.25:v.y});
      return true;
    }
    return false;
  }
  vx(){ return this.body.velocity.x }
  vy(){ return this.body.velocity.y }
  spd(){ return Vector.magnitude(this.body.velocity) }
}

function stick(ptA, ptB, length, stiffness = 0.4){
  const constraint = Constraint.create({
    bodyA: ptA.body,
    bodyB: ptB.body,
    length: length,
    stiffness: stiffness
  });
  World.add(world, constraint);
  return constraint;
}

// ─── GAME MAP ────────────────────────────────────────────
class GameMap{
  constructor(){this.walls=[];this.matterWalls=[];this.lights=[];this.t=0;this.spawnZones=[];this.mapGen=0}
  build(){
    console.log('MAP building...');
    this.mapGen++;
    if(this.matterWalls.length > 0) World.remove(world, this.matterWalls);
    this.walls=[];
    this.matterWalls=[];
    this.spawnZones=[];
    
    const top=TH+MBH,bot=H-BH,left=4,right=W-4;
    const pw=right-left,ph=bot-top,T=14;
    
    const addW = (x, y, w, h) => {
      this.walls.push({x, y, w, h});
      const b = Bodies.rectangle(x + w/2, y + h/2, w, h, { isStatic: true, collisionFilter: { category: COL_WALL } });
      this.matterWalls.push(b);
      World.add(world, b);
    };

    addW(left, top, pw, T);
    addW(left, bot-T, pw, T);
    addW(left, top, T, ph);
    addW(right-T, top, T, ph);
    
    const COLS=4,ROWS=3,cw=pw/COLS,ch=ph/ROWS;
    const _r=(x,y,w,h)=>{if(w>4&&h>4) addW(x, y, w, h)};
    for(let col=1;col<COLS;col++){
      const xl=left+T+col*cw;
      for(let row=0;row<ROWS;row++){
        if(rnd()>.52)continue;
        const ys=top+T+row*ch;
        const gSz=clamp(ch*(0.28+rnd()*.38),68,ph*.44);
        const gStart=ys+rnd()*(ch-gSz);
        const wt=10+~~(rnd()*10);
        if(gStart>ys+14)_r(xl-wt/2,ys,wt,gStart-ys);
        const gEnd=gStart+gSz;
        if(gEnd<ys+ch-14)_r(xl-wt/2,gEnd,wt,ys+ch-gEnd);
      }
    }
    for(let row=1;row<ROWS;row++){
      const yl=top+T+row*ch;
      for(let col=0;col<COLS;col++){
        if(rnd()>.52)continue;
        const xs=left+T+col*cw;
        const gSz=clamp(cw*(0.28+rnd()*.38),68,pw*.34);
        const gStart=xs+rnd()*(cw-gSz);
        const wt=10+~~(rnd()*10);
        if(gStart>xs+14)_r(xs,yl-wt/2,gStart-xs,wt);
        const gEnd=gStart+gSz;
        if(gEnd<xs+cw-14)_r(gEnd,yl-wt/2,xs+cw-gEnd,wt);
      }
    }
    this.spawnZones=[];
    for(let row=0;row<ROWS;row++)for(let col=0;col<COLS;col++){
      const cx=left+T+col*cw+cw*.5,cy=top+T+row*ch+ch*.5;
      this.spawnZones.push({x:cx-cw*.3,y:cy-ch*.3,w:cw*.6,h:ch*.6});
    }
    this.lights=[];
    const lc=[[185,255,150],[90,140,255],[255,215,120],[200,140,255]];
    for(let i=0;i<4;i++){
      const sp=this.randSpawn(5);
      this.lights.push({x:sp.x,y:sp.y,r:240+rnd()*60,ir:.72+rnd()*.1,c:lc[i],ph:rnd()*Math.PI*2,sp:.0018+rnd()*.001});
    }
    document.getElementById('hmg').textContent=this.mapGen; if(typeof WAVES!=='undefined')WAVES.buildWalls(this);
  }
  tick(){
    this.t+=DT;
    for(const l of this.lights){
      const a=this.t*l.sp+l.ph;
      l.x=clamp(l.x+Math.cos(a)*.3,60,W-60);
      l.y=clamp(l.y+Math.sin(a*.8)*.3,TH+MBH+40,H-BH-40);
    }
  }
  wallCollide(x,y,r){
    const r2=r*r;
    for(const w of this.walls){const cx=clamp(x,w.x,w.x+w.w),cy=clamp(y,w.y,w.y+w.h);const dx=x-cx,dy=y-cy;if(dx*dx+dy*dy<r2)return w}
    return null;
  }
  resolveBody(x,y,r){
    let iter=0;
    while(iter++<5){const w=this.wallCollide(x,y,r);if(!w)break;const cx=clamp(x,w.x,w.x+w.w),cy=clamp(y,w.y,w.y+w.h);const dx=x-cx,dy=y-cy,d=Math.hypot(dx,dy);if(d<.001){x+=r;continue}const push=r-d+.5;x+=dx/d*push;y+=dy/d*push}
    return{x,y};
  }
  resolvePoint(pt,r=4){
    const w=this.wallCollide(pt.x,pt.y,r);if(!w)return false;
    const cx=clamp(pt.x,w.x,w.x+w.w),cy=clamp(pt.y,w.y,w.y+w.h);
    const dx=pt.x-cx,dy=pt.y-cy,d=Math.hypot(dx,dy);
    if(d<.001){pt.x+=r;return true}
    const push=r-d+.5;pt.x+=dx/d*push;pt.y+=dy/d*push;
    pt.px=pt.x+pt.vx()*.08;pt.py=pt.y+pt.vy()*.08;
    return true;
  }
  randSpawn(r=24){
    if(this.spawnZones&&this.spawnZones.length>0){
      for(let attempt=0;attempt<60;attempt++){
        const zone=this.spawnZones[~~(rnd()*this.spawnZones.length)];
        const x=zone.x+r+rnd()*Math.max(0,zone.w-r*2);
        const y=zone.y+r+rnd()*Math.max(0,zone.h-r*2);
        if(x>r&&x<W-r&&y>TH+MBH+r&&y<H-BH-r&&!this.wallCollide(x,y,r+2))return{x,y};
      }
    }
    for(let attempt=0;attempt<80;attempt++){
      const x=rng(30+r,W-30-r),y=rng(TH+MBH+20+r,H-BH-20-r);
      if(!this.wallCollide(x,y,r+2))return{x,y};
    }
    return{x:W*.5,y:(TH+MBH+H-BH)*.5};
  }
  lightAt(x,y){let v=.04;for(const l of this.lights){const d=Math.hypot(x-l.x,y-l.y);v=Math.min(1,v+Math.max(0,1-d/l.r)*l.ir)}return v}
  sampleLight(x,y){return[this.lightAt(x+28,y),this.lightAt(x-28,y)]}
  draw(){
    ctx.save();ctx.strokeStyle='rgba(0,16,8,.08)';ctx.lineWidth=.5;
    const top=TH+MBH;
    for(let x=0;x<W;x+=50){ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,H-BH);ctx.stroke()}
    for(let y=top;y<H-BH;y+=50){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke()}
    ctx.restore();
    for(const w of this.walls){
      ctx.fillStyle='rgba(0,0,0,.5)';ctx.fillRect(w.x+3,w.y+3,w.w,w.h);
      ctx.fillStyle='#050f0a';ctx.fillRect(w.x,w.y,w.w,w.h);
      ctx.fillStyle='#0d2016';ctx.fillRect(w.x,w.y,w.w,3);
      ctx.fillStyle='#0a1810';ctx.fillRect(w.x,w.y,3,w.h);
      ctx.strokeStyle='#0a2212';ctx.lineWidth=1;ctx.strokeRect(w.x,w.y,w.w,w.h);
    }
  }
  applyLighting(){
    if(!OVR.lt)return;
    lctx.globalCompositeOperation='source-over';lctx.fillStyle='rgba(0,4,2,.86)';lctx.fillRect(0,0,W,H);
    lctx.globalCompositeOperation='destination-out';
    for(const l of this.lights){
      const g=lctx.createRadialGradient(l.x,l.y,0,l.x,l.y,l.r);
      g.addColorStop(0,`rgba(0,0,0,${l.ir})`);g.addColorStop(.55,`rgba(0,0,0,${(l.ir*.25).toFixed(2)})`);g.addColorStop(1,'rgba(0,0,0,0)');
      lctx.fillStyle=g;lctx.fillRect(0,0,W,H);
    }
    lctx.globalCompositeOperation='source-over';ctx.drawImage(LC,0,0);
    ctx.save();ctx.globalCompositeOperation='screen';
    for(const l of this.lights){
      const g2=ctx.createRadialGradient(l.x,l.y,0,l.x,l.y,l.r*.2);
      g2.addColorStop(0,`rgba(${l.c[0]},${l.c[1]},${l.c[2]},.4)`);g2.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle=g2;ctx.beginPath();ctx.arc(l.x,l.y,l.r*.22,0,Math.PI*2);ctx.fill();
    }
    ctx.restore();
  }
}

// ─── REALISTIC WAVE SYSTEM ────────────────────────────────
class WaveSystem {
  constructor(cs=6) {
    this.cs = cs; this.cols = 0; this.rows = 0;
    this.w0 = null; this.w1 = null; this.walls = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d',{willReadFrequently:true});
    this.imgData = null;
  }
  init(W, H) { if(W <= 0 || H <= 0 || isNaN(W) || isNaN(H)) return; this.cols = Math.ceil(W/this.cs); this.rows = Math.ceil(H/this.cs); if(this.cols <= 0 || this.rows <= 0) return;
    const len = this.cols * this.rows;
    this.w0 = new Float32Array(len); this.w1 = new Float32Array(len);
    this.walls = new Uint8Array(len);
    this.canvas.width = this.cols; this.canvas.height = this.rows;
    this.imgData = this.ctx.createImageData(this.cols, this.rows);
  }
  buildWalls(map) {
    if(!this.walls) return;
    this.walls.fill(0);
    for(let y=0; y<this.rows; y++) {
      for(let x=0; x<this.cols; x++) {
        if(map.wallCollide(x*this.cs + this.cs/2, y*this.cs + this.cs/2, this.cs/2)) {
          this.walls[y*this.cols + x] = 1;
        }
      }
    }
  }
  emit(x, y, amp) {
    if(!this.w0) return;
    const cx = Math.floor(x/this.cs), cy = Math.floor(y/this.cs);
    if(cx>1 && cx<this.cols-2 && cy>1 && cy<this.rows-2) {
      this.w0[cy*this.cols + cx] += amp;
      this.w0[cy*this.cols + cx + 1] += amp*0.5;
      this.w0[cy*this.cols + cx - 1] += amp*0.5;
      this.w0[(cy+1)*this.cols + cx] += amp*0.5;
      this.w0[(cy-1)*this.cols + cx] += amp*0.5;
    }
  }
  tick() {
    if(!this.w0) return;
    const {cols, rows, w0, w1, walls} = this;
    for(let y=1; y<rows-1; y++) {
      let i = y*cols + 1;
      for(let x=1; x<cols-1; x++, i++) {
        if(walls[i]) continue;
        w1[i] = (w0[i-1] + w0[i+1] + w0[i-cols] + w0[i+cols]) * 0.5 - w1[i];
        w1[i] *= 0.92; // Damping
      }
    }
    this.w0 = w1; this.w1 = w0;
  }
  sample(x, y) {
    if(!this.w0) return {s:0, dx:0, dy:0};
    const cx = Math.floor(x/this.cs), cy = Math.floor(y/this.cs);
    if(cx<=0 || cx>=this.cols-1 || cy<=0 || cy>=this.rows-1) return {s:0, dx:0, dy:0};
    const i = cy*this.cols + cx;
    const s = this.w0[i];
    const dx = (this.w0[i+1] - this.w0[i-1]) * 0.5;
    const dy = (this.w0[i+this.cols] - this.w0[i-this.cols]) * 0.5;
    return {s, dx, dy};
  }
  draw(ctx, W, H) {
    if(!OVR.sw || !this.imgData) return;
    const data = this.imgData.data, w0 = this.w0;
    for(let i=0; i<w0.length; i++) {
      const val = w0[i], idx = i * 4;
      const absVal = Math.abs(val);
      if(absVal > 0.015) {
        data[idx] = 40; data[idx+1] = 200; data[idx+2] = 255;
        data[idx+3] = Math.min(255, absVal * 1200);
      } else { data[idx+3] = 0; }
    }
    this.ctx.putImageData(this.imgData, 0, 0);
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.canvas, 0, 0, W, H);
    ctx.restore();
  }
}
const WAVES = new WaveSystem(6);
function emitSound(x,y,amp,type='ambient',reflLeft=1){ WAVES.emit(x,y,amp*3); }
function emitEchoPulse(x,y){ WAVES.emit(x,y,10); }
function tickSounds(map){ for(let i=0;i<3;i++) WAVES.tick(); }
function soundSample(px,py){ return WAVES.sample(px,py); }
function drawSounds(){ WAVES.draw(ctx, W, H); }
// ─── CHEM GRID ───────────────────────────────────────────
class ChemGrid{
  constructor(cs=40){this.cs=cs}
  init(){this.cols=Math.ceil(W/this.cs)+2;this.rows=Math.ceil(H/this.cs)+2;this.d=new Float32Array(this.cols*this.rows);this.d2=new Float32Array(this.cols*this.rows)}
  _ok(cx,cy){return cx>=0&&cy>=0&&cx<this.cols&&cy<this.rows}
  _i(cx,cy){return cy*this.cols+cx}
  dep(x,y,a){const cx=~~(x/this.cs),cy=~~(y/this.cs);if(!this._ok(cx,cy))return;this.d[this._i(cx,cy)]=Math.min(1,this.d[this._i(cx,cy)]+a);for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){if(!dx&&!dy)continue;const nx=cx+dx,ny=cy+dy;if(this._ok(nx,ny))this.d[this._i(nx,ny)]=Math.min(1,this.d[this._i(nx,ny)]+a*.13)}}
  at(x,y){const cx=~~(x/this.cs),cy=~~(y/this.cs);return this._ok(cx,cy)?this.d[this._i(cx,cy)]:0}
  arc(x,y,ang,n,range){const out=new Float32Array(n);for(let i=0;i<n;i++){const t=n>1?i/(n-1):.5;const a=ang+(t-.5)*Math.PI*1.75;let s=0;for(let st=1;st<=3;st++)s+=this.at(x+Math.cos(a)*range*(st/3),y+Math.sin(a)*range*(st/3));out[i]=s/3}return out}
  decay(){for(let i=0;i<this.d.length;i++)this.d[i]*=.992}
  diffuse(){const{cols,rows,d,d2}=this;for(let cy=1;cy<rows-1;cy++){for(let cx=1;cx<cols-1;cx++){const i=cy*cols+cx;let s=d[i]*.67;s+=d[i-1]*.036+d[i+1]*.036+d[i-cols]*.036+d[i+cols]*.036;s+=d[i-cols-1]*.036+d[i-cols+1]*.036+d[i+cols-1]*.036+d[i+cols+1]*.036;d2[i]=s>1?1:s}}this.d=d2;this.d2=d}
  draw(){if(!OVR.ch)return;for(let cy=0;cy<this.rows;cy++)for(let cx=0;cx<this.cols;cx++){const v=this.d[this._i(cx,cy)];if(v<.028)continue;ctx.fillStyle=`rgba(255,105,25,${(v*.12).toFixed(3)})`;ctx.fillRect(cx*this.cs,cy*this.cs,this.cs,this.cs)}}
}
const CHEM=new ChemGrid(40);

// ─── AUDITARCLE ──────────────────────────────────────────
class Auditarcle{
  constructor(relAng){
    this.relAng=relAng;
    this.wAng=relAng;this.pressure=0;this.echoP=0;this.age=0;
    this.sx=0; this.sy=0; this.sx2=0; this.sy2=0;
  }
  destroy(){} // No bodies to remove anymore
  setBase(bx,by,orgAng){
    const wa=orgAng+this.relAng;this.wAng=wa;
    // Math-only sampling positions relative to body
    const baseX = bx+Math.cos(wa)*12, baseY = by+Math.sin(wa)*12;
    this.sx = baseX+Math.cos(wa)*8; this.sy = baseY+Math.sin(wa)*8;
    this.sx2 = baseX+Math.cos(wa)*14; this.sy2 = baseY+Math.sin(wa)*14;
  }
  tick(map){
    const s1=soundSample(this.sx,this.sy);
    const s2=soundSample(this.sx2,this.sy2);
    const diff=(s2.s-s1.s)*4.5;
    this.pressure=clamp(this.pressure+diff*.15,0,1);
    this.echoP=clamp(this.echoP+diff*.12,0,1);
    this.pressure*=.92;this.echoP*=.92;
    this.age+=DT;
  }
  draw(col){
    const[r,g,b]=rgb(col);ctx.save();
    const ef=this.pressure;
    if(ef>.08){
      ctx.beginPath();ctx.moveTo(this.sx-Math.cos(this.wAng)*8,this.sy-Math.sin(this.wAng)*8);
      ctx.lineTo(this.sx2,this.sy2);
      ctx.strokeStyle=`rgba(${r},${g},${b},${(ef*.8).toFixed(2)})`;ctx.lineWidth=2;ctx.stroke();
    }
    ctx.restore();
  }
}

// ─── SUCTION CUP ──────────────────────────────────────────
class SuctionCup{
  constructor(si){this.si=si;this.active=false;this.gripped=false;this.gx=0;this.gy=0;this.gTarget=null;this.gTime=0;this.constraint=null;this.load=0;this.cd=0;}
  tryGrip(pt,map,preys){
    if(this.gripped)return;
    // BUG (war auch in ee24fb5 noch drin): `cd` wurde ausschließlich in
    // applyConstraint() dekrementiert — und das läuft nur, solange `gripped`.
    // Ein einziger Fehlversuch (z. B. Spitze zu schnell) setzte cd=0.05 und der
    // Saugnapf war damit DAUERHAFT gesperrt. Das erklärt, warum die Anker-Rate
    // trotz floorGrip bei ~30 % deckelte.
    if(this.cd>0){ this.cd-=DT; return; }
    const tipLen = CONN_SL / 2;
    const angle = pt.body.angle;
    // Calculate global tip position for distance checks
    const tx = pt.x + Math.cos(angle) * tipLen;
    const ty = pt.y + Math.sin(angle) * tipLen;

    // Ein Saugnapf kann nicht an einer rasenden Spitze haften. Der Wert ist kein
    // Flaschenhals (gemessen: Anker-Rate identisch für Gate 2.4 / 5 / 12 / 50 / ∞,
    // weil abreißende Anker über GRIP_BREAK limitieren, nicht über das Gate) —
    // 6.0 lässt der KI aber die Freiheit, im Gleiten anzusetzen.
    if(Vector.magnitude(pt.body.velocity) > 6.0) { this.cd=0.05; return; }

    let target = null;
    // Beute hat Vorrang (beweglicher Greifling)
    for(const pr of preys){if(pr&&Math.hypot(tx-pr.x,ty-pr.y)<pr.r+10){target=pr; break;}}

    // ⚠ ENTSCHEIDEND: Das Tier kriecht auf einer OBERFLÄCHE. Seine Saugnäpfe
    // können sich also am Untergrund festhalten — überall, nicht nur an Wänden.
    // Ohne das gäbe es im offenen Gelände buchstäblich nichts zu halten, und
    // "Grip and pull" wäre als Fortbewegung unmöglich.
    // Ein Wandkontakt ist ebenfalls ein gültiger Anker (fester, vertikaler Punkt).
    if(!target && !OVR.floorGrip && !map.wallCollide(tx, ty, 9)) { this.cd=0.08; return; }

    this.gripped=true;
    this.gTarget=target;
    this.gx=target?0:tx;
    this.gy=target?0:ty;
    this.gTime=0;
    this.load=0;

    this.constraint = Constraint.create({
      bodyA: pt.body,
      // PointA is the offset from body center. For a capsule, tip is at +length/2
      pointA: { x: tipLen, y: 0 },
      bodyB: target ? target.body : null,
      pointB: target ? {x:0,y:0} : {x: tx, y: ty},
      // 0.22 war Gummi: der Arm konnte 26 px ziehen ohne Halt.
      // stiffness 1 / length 0 = starrer Ankerpunkt, an dem man sich wirklich
      // abstützen und hochziehen kann. angularStiffness 1 verhindert die
      // Solver-Energieinjektion (siehe Hinweis bei Connectarcle).
      stiffness: 1,
      length: 0,
      damping: 0.15,
      angularStiffness: 1   // Saugnapf = Gelenk, keine Winkelkopplung
    });
    // Dieselbe Matter-Eigenheit wie bei den Arm-Gelenken: `pointA` muss zum
    // Erstellungszeitpunkt WELT-ausgerichtet sein, weil Matter es nur noch
    // inkrementell um (bodyAngle - angleA) weiterdreht. Sonst sitzt der
    // Grip-Anker um den Segmentwinkel verdreht neben der Spitze und der
    // Solver reißt beim ersten Durchlauf am Arm.
    {
      const ca=Math.cos(angle), sa=Math.sin(angle);
      this.constraint.pointA.x = tipLen*ca; this.constraint.pointA.y = tipLen*sa;
      this.constraint.angleA = angle;
      if (target && target.body) { this.constraint.pointB.x=0; this.constraint.pointB.y=0; this.constraint.angleB=target.body.angle; }
    }
    World.add(world, this.constraint);
  }
  release(){
    if(this.constraint) World.remove(world, this.constraint);
    this.constraint=null; this.gripped=false; this.gTarget=null; this.gTime=0; this.load=0; this.cd=0.12;
  }
  applyConstraint(pt,orgMass){
    if(!this.gripped)return false;
    this.gTime += DT;
    if(this.cd>0)this.cd-=DT;
    if(GRIP_MAX_TIME > 0 && this.gTime > GRIP_MAX_TIME) { this.release(); return false; }
    // Breaking force check from TIP position
    const tipLen = CONN_SL / 2;
    const tpos = { x: pt.x + Math.cos(pt.body.angle)*tipLen, y: pt.y + Math.sin(pt.body.angle)*tipLen };
    const anchor = this.gTarget ? this.gTarget.body.position : this.constraint.pointB;
    const bl = anchor ? Vector.magnitude(Vector.sub(tpos, anchor)) : 999;
    this.load = clamp(bl/GRIP_BREAK,0,1);   // 0 = entspannt, 1 = kurz vor dem Abriss
    if(bl > GRIP_BREAK) { this.release(); return false; }
    return true;
  }
  draw(pt,col,suctionOn){
    const[r,g,b]=rgb(col);ctx.save();
    const tipLen = CONN_SL / 2;
    const px = pt.x + Math.cos(pt.body.angle)*tipLen;
    const py = pt.y + Math.sin(pt.body.angle)*tipLen;
    
    if(this.gripped){
      const tx = this.gTarget ? this.gTarget.x : this.gx;
      const ty = this.gTarget ? this.gTarget.y : this.gy;
      ctx.strokeStyle=`rgba(${r},${g},${b},.3)`;ctx.lineWidth=1;ctx.setLineDash([2,3]);
      ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(tx,ty);ctx.stroke();ctx.setLineDash([]);
      
      // Core suction cup visual
      ctx.fillStyle=`rgba(${r},${g},${b},.7)`;
      ctx.beginPath();ctx.arc(px,py,4,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.stroke();
    }else{
      const sz=suctionOn?4:2.2;
      ctx.fillStyle=`rgba(${r},${g},${b},${suctionOn?.4:.15})`;
      ctx.beginPath();ctx.arc(px,py,sz,0,Math.PI*2);ctx.fill();
      if(suctionOn){
        ctx.strokeStyle=`rgba(${r},${g},${b},.6)`;ctx.lineWidth=0.5;
        ctx.beginPath();ctx.arc(px,py,sz+2,0,Math.PI*2);ctx.stroke();
      }
    }
    ctx.restore();
  }
}

class Connectarcle{
  constructor(relAng, parentBody, group = 0){
    this.relAng=relAng;
    this.pts=[];
    this.parent=parentBody;
    this.group=group;
    this.shoulderR=24;

    // Muskel-/CPG-Zustand
    this.nnTorques=[0,0,0];
    this.ctrl={shoulder:0,curl:0,wave:0,waveDirect:0};
    this.phase=0;
    this.tipContact=0;
    this.gripLoad=0;

    // MASSENVERTEILUNG. Bei reiner Arm-Fortbewegung sind die Arme zugleich
    // Aktuator und Reaktionsmasse. Zwei Grenzen gelten:
    //   • Rumpf : Segment₀ ≤ ~8:1 — Sequential-Impulse-Solver werden darüber instabil
    //   • Rumpf nicht zu schwer — sonst können die Arme ihn schlicht nicht ziehen
    // lerp(3.2, 1.8) über 7 Segmente = 17.5 pro Arm × 6 = 105, Rumpf 16.
    // Massen-Taper maximal ~1.8:1 über die Kette, und Rumpf:Segment0 ≈ 8:1.
    // Sequential-Impulse-Solver werden ab ~10:1 instabil.
    const m0=3.2;
    for(let i=0;i<CONN_SEGS;i++){
      const m=lerp(m0,1.8,i/(CONN_SEGS-1));
      const thickness=lerp(12,6,i/CONN_SEGS)*0.99;
      const p=new Pt(0,0,m,thickness/2,false,{
        shape:'capsule', length:CONN_SL, thickness,
        category:COL_TENTACLE,
        // Tentakel müssen die Welt SPÜREN können (Wände, Beute).
        // `group` ist negativ → Kollision mit dem eigenen Körper bleibt aus,
        // andere Kraken und Wände kollidieren aber normal.
        mask:COL_WALL|COL_PREY,
        group
      });
      p.body.friction=0.05;
      p.body.restitution=0;
      p.body.frictionAir=DRAG_SEG;   // Wasserwiderstand im Integrator (constraint-konsistent)
      p.body.friction=0.06; p.body.frictionStatic=0.12; p.body.restitution=0;
      p.maxAV=MAX_ANG_V;
      this.pts.push(p);
    }

    this.hp=new Float32Array(CONN_SEGS).fill(100);
    this.active=CONN_SEGS-1;this.alive=true;
    this.nnAng=[0,0,0];this.worldRestAng=relAng;this.col='#00ffb3';
    this.cups=SUCTION_IDX.map(idx=>new SuctionCup(idx));
    this.suctionOn=false;
    this.suckLatch=false;   // Hysterese-Zustand des Saugnapfs
    this.constraints=[];

    // Schulter-Anchor (pointA ist CORE-LOKAL, wird in layout() konsistent gesetzt)
    this.anchor=Constraint.create({
      bodyA:parentBody, bodyB:this.pts[0].body,
      pointA:{x:this.shoulderR,y:0}, pointB:{x:-CONN_SL/2,y:0},
      stiffness:1, length:0, damping:0.1,
      // ⚠ angularStiffness: 1 ist ENTSCHEIDEND.
      // Matters Default ist 0, und Constraint.solve() wendet dann eine
      // Winkelkorrektur `bodyA.angle -= cross(pointA,b)/w * (1-angularStiffness)`
      // an, die anglePrev NICHT mitnimmt → erzeugt Winkelgeschwindigkeit aus dem
      // Nichts. Bei einer gekrümmten Gelenkkette (curl != 0) schaukelt sich das
      // im allerersten Engine.update auf: gemessen max|v| = 69 px/step und
      // max|omega| = 95 rad/step aus einem exakt kräftefreien Ruhezustand.
      // angularStiffness: 1 schaltet den Term aus = echtes Scharnier
      // (positionsgekoppelt, rotationsfrei). Danach: max|v| = 0.41, |omega| = 0.013.
      angularStiffness: 1,
    });
    World.add(world,this.anchor);

    for(let i=0;i<this.pts.length-1;i++){
      const c=Constraint.create({
        bodyA:this.pts[i].body, bodyB:this.pts[i+1].body,
        pointA:{x:CONN_SL/2,y:0}, pointB:{x:-CONN_SL/2,y:0},
        length:0, stiffness:1, damping:0.1,
        angularStiffness: 1,   // siehe Hinweis beim Schulter-Anchor
      });
      this.constraints.push(c);
      World.add(world,c);
    }
    // Erst NACH dem Constraint-Aufbau legen → garantiert verletzungsfrei
    this.layout(parentBody.position.x,parentBody.position.y,parentBody.angle,0.28);
  }
  destroy() {
    for(const p of this.pts) World.remove(world, p.body);
    for(const c of this.constraints) World.remove(world, c);
    World.remove(world, this.anchor);
    for(const cup of this.cups) cup.release();
  }

  /**
   * Matter.js rotiert `constraint.pointA`/`pointB` nur INKREMENTELL um
   * (bodyAngle − constraint.angleA), wobei angleA/angleB bei Constraint.create()
   * eingefroren werden. Die Punkte sind also "welt-ausgerichtet relativ zum
   * Erstellungswinkel", NICHT echte Body-Lokalkoordinaten.
   *
   * Dieser Helper setzt beide Felder konsistent neu, damit layout() zu jedem
   * Zeitpunkt aufgerufen werden kann (Spawn, NaN-Reparatur) und die Constraints
   * danach exakt erfüllt sind. Ohne das war der Anchor um bis zu 48 px versetzt
   * → der Solver katapultierte die Körper im allerersten Frame auf 83 px/step.
   */
  static syncConstraint(c, bodyA, pAx, pAy, bodyB, pBx, pBy){
    const ca=Math.cos(bodyA.angle), sa=Math.sin(bodyA.angle);
    c.pointA.x=pAx*ca-pAy*sa; c.pointA.y=pAx*sa+pAy*ca;
    c.angleA=bodyA.angle;
    const cb=Math.cos(bodyB.angle), sb=Math.sin(bodyB.angle);
    c.pointB.x=pBx*cb-pBy*sb; c.pointB.y=pBx*sb+pBy*cb;
    c.angleB=bodyB.angle;
  }

  /**
   * Legt die Armkette so hin, dass ALLE Constraints exakt erfüllt sind.
   *
   * Der alte Code machte `pos += SL·u(θ)` und drehte θ danach um 0.35 rad —
   * bei einem length-0-Gelenk ist das geometrisch unmöglich erfüllbar
   * (gemessen: 12.4 px Schulter- + 2.4 px Segment-Fehler). Der Solver mit
   * stiffness .95 hat die Arme dann in Frame 1 auseinandergerissen
   * (gemessen: 63 px/step = 3800 px/s im allerersten Frame).
   *
   * Korrekt: halber Schritt zum Gelenk → drehen → halber Schritt zum nächsten Zentrum.
   */
  layout(bx,by,coreAngle,curl){
    const th0=coreAngle+this.relAng;
    // Schultergelenk in Weltkoordinaten
    let jx=bx+Math.cos(th0)*this.shoulderR, jy=by+Math.sin(th0)*this.shoulderR;
    let th=th0;
    for(let i=0;i<this.pts.length;i++){
      const ux=Math.cos(th), uy=Math.sin(th);
      const cx=jx+ux*CONN_SL*0.5, cy=jy+uy*CONN_SL*0.5;
      const p=this.pts[i];
      Body.setAngle(p.body,th);
      Body.setPosition(p.body,{x:cx,y:cy});
      Body.setVelocity(p.body,{x:0,y:0});
      Body.setAngularVelocity(p.body,0);
      p.body.force.x=0;p.body.force.y=0;p.body.torque=0;
      jx=cx+ux*CONN_SL*0.5; jy=cy+uy*CONN_SL*0.5;   // Gelenk i
      th+=curl;                                     // nächster Segmentwinkel
    }
    this.worldRestAng=th0;
    // Constraints NACH der Pose synchronisieren (Reihenfolge ist entscheidend)
    const H=CONN_SL*0.5;
    Connectarcle.syncConstraint(this.anchor, this.parent,
      Math.cos(this.relAng)*this.shoulderR, Math.sin(this.relAng)*this.shoulderR,
      this.pts[0].body, -H, 0);
    for(let i=0;i<this.constraints.length;i++){
      Connectarcle.syncConstraint(this.constraints[i], this.pts[i].body, H, 0, this.pts[i+1].body, -H, 0);
    }
  }
  /** Kompatibilitäts-Wrapper (wird von Organism aufgerufen). */
  initPos(bx,by,orgAng){ this.layout(bx,by,orgAng,0.28); }

  get tip(){return this.pts[Math.min(this.active,this.pts.length-1)]}
  get tipX(){const t=this.tip,a=t.body.angle,L=CONN_SL*0.5;return t.x+Math.cos(a)*L}
  get tipY(){const t=this.tip,a=t.body.angle,L=CONN_SL*0.5;return t.y+Math.sin(a)*L}
  get tipCupGripped(){return this.cups.some(c=>c.gripped)}

  setTorques(t1,t2,t3){ this.nnTorques=[t1,t2,t3]; }
  /** Neue Steuerung: Schulter-Ziel, Ruhekrümmung, Wellenamplitude, CPG-Phase. */
  setControl(shoulder,curl,wave,phase,waveDirect){
    this.ctrl.shoulder=shoulder;this.ctrl.curl=curl;this.ctrl.wave=wave;this.phase=phase;
    // waveDirect = der NN-Ausgang, der OHNE CPG den Gelenkwinkel direkt steuert.
    // Sonst wäre out[2+k*4+1] ein toter Ausgang.
    this.ctrl.waveDirect=waveDirect||0;
  }
  setBase(bx,by,orgAng){ this.worldRestAng=orgAng+this.relAng; }

  /**
   * Gelenkwinkelbeitrag der CPG-Welle.
   *
   * ⚠ `OVR.cpgWave` ist standardmäßig AUS — Absicht.
   * Diese Welle war eine HANDGESCHRIEBENE Gangkurve: ein Sinus, über PULL_ASYM
   * geformt zu „langsam strecken, schnell ziehen", dazu feste Phasenversätze
   * k·2π/6. Das Netz durfte nur die Amplitude skalieren — der Rhythmus selbst war
   * vorgegeben. Genau das soll dieses Projekt nicht sein.
   *
   * Mit cpgWave=false kommt der Zielwinkel jedes Gelenks ausschließlich aus
   * `ctrl.curl + ctrl.waveDirect`, zwei direkten NN-Ausgängen pro Arm. Den
   * Rhythmus muss das Netz selbst erzeugen: über die 27 rekurrenten Eingänge
   * (prevOut) hat es ein Gedächtnis, über [27]/[28] eine Phasenuhr als
   * Zeitreferenz. Eine Uhr ist keine Gangart.
   */
  waveAt(i){
    if(!OVR.cpgWave) return 0;
    const t=CONN_SEGS>1?i/(CONN_SEGS-1):0;
    const ph=this.phase-t*Math.PI*1.35;
    const s=0.5+0.5*Math.sin(ph);
    return (Math.pow(s,PULL_ASYM)*2-1)*this.ctrl.wave*JOINT_LIMIT;
  }

  /**
   * ECHTE Muskeln: PD-Regler schreibt `body.torque`.
   * Der alte Code benutzte `Body.applyForce(b, b.position, f)` — Hebelarm 0,
   * also NULL Drehmoment. Segmente wurden nur verschoben, nie gebeugt.
   */
  applyMuscles(tone){
    const n=this.active+1;
    if(n<1||!this.alive)return;
    const T=(tone===undefined?1:tone);            // globaler Muskeltonus 0.30..1.0
    const core=this.parent, s0=this.pts[0].body;

    // ── Schulter ──
    const relS=angDiff(s0.angle,core.angle);
    const tgtS=clamp(this.ctrl.shoulder,-SHOULDER_LIMIT,SHOULDER_LIMIT);
    const avS=s0.angularVelocity-core.angularVelocity;
    let tauS=(MUSCLE_KP*(tgtS-relS)-MUSCLE_KD*avS);
    tauS=clamp(tauS,-1,1)*SHOULDER_TMAX*T*SUB_COMP;
    s0.torque+=tauS;
    core.torque-=tauS;                    // Actio = Reactio: der Rumpf dreht gegen

    // ── Ellbogen-/Fingergelenke ──
    // Diese Paare sind INTERN zur Armkette: +tau an B, -tau an A. Sie erzeugen
    // kein Nettomoment auf den Körper und schon gar keine Nettokraft. Sie können
    // den Rumpf nur bewegen, indem sie den Arm verkürzen/verlängern — und das
    // zieht ausschließlich dann am Rumpf, wenn die Spitze verankert ist.
    for(let i=1;i<n;i++){
      const A=this.pts[i-1].body, B=this.pts[i].body;
      const rel=angDiff(B.angle,A.angle);
      const tgt=clamp(this.ctrl.curl+this.waveAt(i)+this.ctrl.waveDirect,-JOINT_LIMIT,JOINT_LIMIT);
      const av=B.angularVelocity-A.angularVelocity;
      let tau=(MUSCLE_KP*(tgt-rel)-MUSCLE_KD*av);
      tau=clamp(tau,-1,1)*MUSCLE_TMAX*T*SUB_COMP;
      B.torque+=tau;
      A.torque-=tau;
    }
  }

  tick(map,preys,orgMass,bodyX,bodyY){
    if(!this.active){this.alive=false;return}
    const n=this.active+1;

    // ── echter Tast-Sinn an der Spitze (vorher: tip.spd()*12 = Quatsch) ──
    const tx=this.tipX, ty=this.tipY;
    const nearWall=map.wallCollide(tx,ty,7)?1:0;
    let nearPrey=0;
    if(preys)for(const pr of preys){if(pr&&Math.hypot(tx-pr.x,ty-pr.y)<pr.r+9){nearPrey=1;break}}
    const contact=Math.max(nearWall,nearPrey);
    this.tipContact=this.tipContact*0.7+contact*0.3;

    // ── Saugnäpfe ──
    for(let ci=0;ci<this.cups.length;ci++){
      const cup=this.cups[ci];
      const si=Math.min(cup.si,n-1);const pt=this.pts[si];
      if(this.suctionOn&&!cup.gripped)cup.tryGrip(pt,map,preys);
      else if(!this.suctionOn&&cup.gripped)cup.release();
      if(cup.gripped){
        const held=cup.applyConstraint(pt,orgMass);
        this.gripLoad=cup.load||0;
        if(!held)this.gripLoad=0;
      }else this.gripLoad*=0.8;
    }
  }

  damage(at, amount) { return null; }
  _sever(at) { return null; }

  draw(){
    const n=this.active+1;if(n<2)return;
    const[r,g,b]=rgb(this.col);
    ctx.save();ctx.lineCap='round';ctx.lineJoin='round';
    const pts=this.pts.slice(0,n);

    // Tapered segment drawing
    for(let i=0;i<n-1;i++){
      const t=i/(n-1);
      const hp=i<this.hp.length?this.hp[i]/100:1;
      const lw=lerp(5.8,1.6,t);
      const dr=~~lerp(r,170,1-hp),dg=~~lerp(g,10,1-hp),db2=~~lerp(b,10,1-hp);
      ctx.strokeStyle=`rgb(${dr},${dg},${db2})`;
      
      ctx.lineWidth=lw;
      ctx.beginPath();
      if(pts[i] && pts[i+1]) {
        if(i===0){ctx.moveTo(pts[0].x,pts[0].y);ctx.lineTo(pts[1].x,pts[1].y)}
        else if(pts[i-1]){
          const mx0=(pts[i-1].x+pts[i].x)*.5,my0=(pts[i-1].y+pts[i].y)*.5;
          const mx1=(pts[i].x+pts[i+1].x)*.5,my1=(pts[i].y+pts[i+1].y)*.5;
          ctx.moveTo(mx0,my0);
          if(i<n-2)ctx.quadraticCurveTo(pts[i].x,pts[i].y,mx1,my1);
          else ctx.lineTo(pts[i+1].x,pts[i+1].y);
        }
      }
      ctx.stroke();
    }

    // ── TIP (Unified with Suction Cup) ──
    if(n>=2&&this.alive){
      const tip=pts[n-1];
      const ta=tip.body.angle;
      const tc=this.tipContact;
      const tr=3.2+tc*1.5;
      const tipLen = CONN_SL / 2;
      
      ctx.save();
      ctx.translate(tip.x + Math.cos(ta)*tipLen, tip.y + Math.sin(ta)*tipLen);
      ctx.rotate(ta);
      
      // Main bulb
      ctx.fillStyle=tc>.15?`rgba(255,255,255,${(.7+tc*.3).toFixed(2)})`:`rgba(${r},${g},${b},.9)`;
      ctx.beginPath();
      ctx.ellipse(0, 0, tr*1.4, tr, 0, 0, Math.PI*2);
      ctx.fill();
      
      // Gripped ring
      if(this.tipCupGripped){
        ctx.strokeStyle=`rgba(${r},${g},${b},.95)`;
        ctx.lineWidth=1.5;
        ctx.beginPath();ctx.arc(0,0,tr+3,0,Math.PI*2);ctx.stroke();
      }
      ctx.restore();
    }

    // Suction cups
    for(let ci=0;ci<this.cups.length;ci++){
      const cup=this.cups[ci];const si=Math.min(cup.si,n-1);
      if(pts[si]) cup.draw(pts[si],this.col,this.suctionOn);
    }
    ctx.restore();
  }
}

function tickDebris(map){}
function drawDebris(){}

// ─── PREY ─────────────────────────────────────────────────
class Prey{
  constructor(x,y,map,spd=1){
    this.map=map;this.spd=spd;this.r=10;this.seed=rnd()*100;this.panic=0;this._st=0;this.mass=1.5;this.hitCd=0;
    this.body = Bodies.circle(x, y, this.r, {
      mass: this.mass,
      frictionAir: DRAG_PREY,
      collisionFilter: { category: COL_PREY, mask: COL_WALL | COL_CORE | COL_TENTACLE }
    });
    World.add(world, this.body);
  }
  get x(){return this.body.position.x}
  get y(){return this.body.position.y}
  set x(v){Body.setPosition(this.body,{x:v,y:this.body.position.y})}
  set y(v){Body.setPosition(this.body,{x:this.body.position.x,y:v})}
  // Vorher fehlten diese Getter komplett: `p.vx += tip.vx()*2` hat nur eine
  // wirkungslose JS-Property erzeugt — der Tentakel-Schlag hat die Beute nie bewegt.
  get vx(){return this.body.velocity.x}
  get vy(){return this.body.velocity.y}
  set vx(v){Body.setVelocity(this.body,{x:v,y:this.body.velocity.y})}
  set vy(v){Body.setVelocity(this.body,{x:this.body.velocity.x,y:v})}
  tick(preds){
    let fx=0,fy=0;
    for(const p of preds){
      if(!p)continue;
      const dx=this.x-p.x,dy=this.y-p.y,d=Math.hypot(dx,dy);
      if(d<1||d>320)continue;
      this.panic=Math.min(1,this.panic+.045);
      const s=(0.0009+this.panic*0.0022)/d;   // ×5 schwächer: vorher war Beute schneller als der Kraken
      fx+=dx*s;fy+=dy*s;
    }
    this.panic=Math.max(0,this.panic-.012);
    // kleine Richtungs-Zufalls-Komponente → Beute wirkt lebendig, nicht wie eine Rakete
    Body.applyForce(this.body, this.body.position, {x: fx + (rnd()-.5)*0.00012, y: fy + (rnd()-.5)*0.00012});
    const v=this.body.velocity;
    const mv = Math.hypot(v.x,v.y);
    // Beute darf nie schneller sein als der Kraken (MAX_LIN_V), sonst ist
    // Phase 4/5 unlernbar. Wasserwiderstand kommt aus frictionAir.
    const ms = Math.min(MAX_LIN_V*0.55, this.spd*(this.panic>.3?2.1:1.25));
    if(mv > ms) Body.setVelocity(this.body, Vector.mult(Vector.normalise(this.body.velocity), ms));
    
    this._st-=DT;
    if(this._st<=0&&mv>.5){emitSound(this.x,this.y,(.08+this.panic*.38)*Math.min(mv*.18,1),'ambient');this._st=rng(.12,.28)-this.panic*.08}
  }
  destroy(){ World.remove(world, this.body); }
  draw(){
    const pulse=.5+.5*Math.sin(Date.now()*.005+this.seed);
    ctx.save();ctx.shadowColor='#ff8800';ctx.shadowBlur=9+pulse*12;
    if(this.panic>.12){ctx.beginPath();ctx.arc(this.x,this.y,this.r+3+this.panic*12,0,Math.PI*2);ctx.strokeStyle=`rgba(255,100,0,${(this.panic*.4).toFixed(2)})`;ctx.lineWidth=1.5;ctx.stroke()}
    ctx.beginPath();ctx.arc(this.x,this.y,this.r,0,Math.PI*2);
    const rg=ctx.createRadialGradient(this.x-3,this.y-3,1,this.x,this.y,this.r);rg.addColorStop(0,'#ffcc44');rg.addColorStop(.5,'#ff6600');rg.addColorStop(1,'#2a0800');ctx.fillStyle=rg;ctx.fill();ctx.restore();
  }
}

/**
 * Misst beim Spawn, wieviel Freiraum um den Kraken herum überhaupt verfügbar ist.
 *
 * Ohne das ist die Fitness reine Lotterie: wer in einer Nische mit der Wand im
 * Rücken spawnt, kann physikalisch nie weit kommen, und die Evolution selektiert
 * Spawn-Glück statt Fortbewegung (gemessen: Score-Streuung 150..220 ohne Trend
 * über 20 Generationen). `reach` normiert die zurückgelegte Distanz auf diesen
 * Freiraum und macht Individuen damit vergleichbar.
 */
function computeSpawnReach(map,x,y){
  let sum=0,best=0;const N=16;
  for(let k=0;k<N;k++){
    const a=k/N*Math.PI*2;let d=0;
    while(d<420){ d+=10; if(map.wallCollide(x+Math.cos(a)*d,y+Math.sin(a)*d,11))break; }
    sum+=d; if(d>best)best=d;
  }
  return Math.max(70,(sum/N)*0.55+best*0.45);
}

// ─── ORGANISM ─────────────────────────────────────────────
const OCOLS=['#00ffb3','#b060ff','#ff3a6e','#00c8ff','#ffdd00','#44ff88','#ff8040','#80a8ff','#ff60c0','#60ffdd','#ffb040','#b0ff60'];
const CONN_ANGS=Array.from({length:N_CONN},(_,i)=>(i/N_CONN)*Math.PI*2);
const AUD_ANGS=Array.from({length:N_AUD},(_,i)=>(i/N_AUD)*Math.PI*2);

class Organism{
  constructor(x,y,weights,ci,map){
    this.x=x;this.y=y;this.vx=0;this.vy=0;
    this.ang=rnd()*Math.PI*2;this.av=0;
    this.w=weights;this.col=OCOLS[ci%OCOLS.length];this.map=map;this.mass=8;
    this.group = NEXT_GROUP--; // Each alien gets a unique negative group to prevent self-collisions

    // Internal states
    this.energy=1;this.satiation=.5;this.discomfort=0;this.arousal=.4;
    this.surfPress=0;this.bodyPress=0;this.echoSense=0;
    // NN IO
    this.lIn=new Float32Array(NI);this.lOut=new Float32Array(NO);this.prevOut=new Float32Array(NO);
    this.prevVx=0;this.prevVy=0;   // Propriozeption: Eigenbeschleunigung
    this.meanExtension=1;          // 0 = ganz eingerollt, 1 = ganz gestreckt

    // PERFECT RIGID BODY PHYSICS
    // Rumpfmasse 16. Bei reiner Arm-Fortbewegung sind die Arme Aktuatoren UND
    // Reaktionsmasse — ein zu schwerer Rumpf ist von den Armen schlicht nicht
    // mehr zu ziehen. 16 : 3.2 (Segment 0) = 5:1, bleibt solver-stabil, und der
    // Sweep hat genau hier den meisten Vortrieb gemessen.
    this.pt = new Pt(x, y, 16, 18, false, {
      category: COL_CORE,
      mask: COL_WALL | COL_PREY,
      group: this.group // Share the same negative group as tentacles to avoid self-stuckness
    });
    this.pt.body.frictionAir=DRAG_CORE;
    this.pt.body.restitution=0.02;
    this.pt.body.friction=0.05;
    this.pt.maxAV=MAX_ANG_V_CORE;    // Mantel: träge Rotation
    // ⚠ KRITISCH: Der logische Winkel und der Matter-Winkel müssen IDENTISCH sein.
    // Vorher: this.ang = random, body.angle = 0 → die Arme wurden an
    // `orgAng+relAng` gespawnt, der Schulter-Anchor lag aber bei `relAng`.
    // Ergebnis: 12.4 px Constraint-Verletzung → Solver reißt alles auseinander.
    Body.setAngle(this.pt.body, this.ang);
    Body.setInertia(this.pt.body, this.pt.body.inertia*2.5); // Mantel ist träge → dreht nicht gleich mit
    this.constraints = [];

    // Body components - Tentacles anchored directly to coreBody
    this.conns=CONN_ANGS.map((a,i)=>{const c=new Connectarcle(a, this.pt.body, this.group);c.col=this.col;c.cpgOffset=i*(Math.PI*2/N_CONN)*CPG_WAVE_NUMBER;return c;});
    this.auds=AUD_ANGS.map(a=>new Auditarcle(a));
    // Echolocation
    this._echoT=rng(.5,1.5);this._echoInterval=rng(1.0,2.2);this._echoCooldown=0;
    // ── CPG / Muskeltonus ──
    this.cpg=rnd()*Math.PI*2;      // zentrale Uhr der metachronalen Welle
    this.cpgHz=CPG_BASE_HZ;
    this.waveCmd=0;                // out[0] → Wellenfrequenz
    this.tone=1;                   // out[1] → Muskeltonus 0.30..1.0
    this.faceAng=this.ang-Math.PI*0.5;
    this.age=0;
    this.anchorTicks=0;            // Steps mit ≥1 verankertem Arm
    this.grippedNow=0;             // aktuell verankerte Arme
    this.armReach=0;               // mittlere Schulter→Spitze-Distanz (Armstreckung)
    this.anchorAtSpawn=0;
    // Fitness metrics (comprehensive)
      this.fitness=0;this.hits=0;this.wallHits=0;this.chemSensed=0;this.stepCount=0;
    this.gripCount=0;this.echoResponses=0;
    // Locomotion quality tracking
    this.gripMoveDist=0;      // total distance moved while gripped (real locomotion)
    this.gripMoveCorr=0;      // ticks body moved meaningfully while gripped
    this.freeMoveDist=0;      // distance moved WITHOUT grip (penalized passive drift)
    this.angularAccum=0;      // total rotation (spinning penalty) — war NIE verdrahtet
    this.pathLen=0;           // tatsächlich gelaufene Pfadlänge
    this.forwardProg=0;       // Σ max(0, v·Richtung) — nur echte Vorwärtsbewegung
    this.gripPullProg=0;      // Vorwärtsbewegung während ≥2 Armen halten
    this.resets=0;
    // Exploration
    this.visited=new Uint8Array(28*20);
    this.spawnX=x;this.spawnY=y;this.spawnAng=this.ang;
    this.spawnReach=computeSpawnReach(map,x,y);   // verfügbarer Freiraum für faire Fitness
    this.maxDisplacement=0;this.totalDisplacement=0;
    this._preyMinDist=9999;this.idleTicks=0;this.effectiveIdlePenalty=0;this.energySpent=0; this.idlePenalty=0; this.wallHits=0;
    this.px=x;this.py=y;
  }
  destroy() {
    World.remove(world, this.pt.body);
    for(const c of this.constraints) World.remove(world, c);
    for(const conn of this.conns) conn.destroy();
    for(const aud of this.auds) aud.destroy();
  }

  emitPulse(){
    emitEchoPulse(this.x,this.y);
    emitSound(this.x+Math.cos(this.ang)*22,this.y+Math.sin(this.ang)*22,.85,'emit',2);
  }

  buildInputs(preys){
    // this.lIn wiederverwenden statt pro Step und Organismus ein neues Array(104)
    const x=this.lIn;x.fill(0);let i=0;
    // [0..7] Auditarcle deflections (echo + ambient sense)
    for(const a of this.auds)x[i++]=a.pressure||0;
    // [8] Peak echo pressure
    x[i++]=this.echoSense;
    // [9..14] Chemoreception arc
    const ch=CHEM.arc(this.x,this.y,this.ang,6,150);
    for(let k=0;k<6;k++){x[i++]=ch[k];this.chemSensed+=ch[k]}
    // [15..20] Suction grip status per tentacle
    for(const c of this.conns)x[i++]=c.alive&&c.cups.some(s=>s.gripped)?1:0;
    // [21..22] Photoreception L/R
    const[lA,lB]=this.map.sampleLight(this.x,this.y);x[i++]=lA;x[i++]=lB;
    // [23..26] Internal states
    x[i++]=this.energy;x[i++]=this.satiation;x[i++]=this.discomfort;x[i++]=this.arousal;
    // [27..28] CPG-Phase — damit das Netz sich auf die Armwelle PHASENLOCKEN kann.
    // (vorher: surfPress = duplikat von max([0..7]), bodyPress = immer 0 weil hx/hy hart auf false)
    x[i++]=Math.sin(this.cpg);
    x[i++]=Math.cos(this.cpg);
    // [29] Own speed
    x[i++]=clamp(Math.hypot(this.vx,this.vy)/4,0,1);
    // [30] Angular velocity
    x[i++]=clamp(this.av/3,-1,1);
    // [31] Mean tip contact
    let tc=0;for(const c of this.conns)tc+=c.alive?c.tipContact:0;
    x[i++]=clamp(tc/N_CONN,0,1);
    // [32] Total grips active
    let gc=0;for(const c of this.conns)for(const s of c.cups)gc+=s.gripped?1:0;
    x[i++]=clamp(gc/(N_CONN*SUCTION_IDX.length),0,1);
    // [33..34] Wall proximity
    const ar=H-BH-TH-MBH;
    x[i++]=clamp(1-Math.min(this.x,W-this.x)/W*4,0,1);
    x[i++]=clamp(1-Math.min(this.y-TH-MBH,H-BH-this.y)/ar*4,0,1);
    // [35] Displacement from spawn
    const diag=Math.hypot(W,H-TH-MBH-BH);
    x[i++]=clamp(Math.hypot(this.x-this.spawnX,this.y-this.spawnY)/diag*4,0,1);
    // [36] Prey proximity (0 if no prey)
    if(preys&&preys.length>0){
      let nd=9999;for(const p of preys){const d=Math.hypot(this.x-p.x,this.y-p.y);if(d<nd)nd=d}
      x[i++]=clamp(1-nd/500,0,1);this._preyMinDist=Math.min(this._preyMinDist,nd);
    }else x[i++]=0;

    // ══ [37..72] PROPRIOZEPTION: 6 Arme × 6 Werte ══════════════════════
    // Voraussetzung dafür, dass die KI ihren Körper verstehen kann. Sie muss
    // den Kausalzusammenhang selbst beobachten können:
    //   Arm einknicken → Zuglast steigt → Eigenbeschleunigung längs positiv.
    const ca=Math.cos(-this.ang), sa=Math.sin(-this.ang);   // Welt → Rumpf-System
    let anchored=0, extSum=0;
    for(let k=0;k<N_CONN;k++){
      const c=this.conns[k];
      if(!c||!c.alive){ for(let q=0;q<6;q++) x[i++]=0; extSum+=0; continue; }
      const s0=c.pts[0].body, tip=c.tip;
      x[i++]=clamp(angDiff(s0.angle,this.ang)/SHOULDER_LIMIT,-1,1);        // [0] Schulterwinkel
      let curlSum=0,cn=0;                                                  // [1] mittlere Krümmung
      for(let j=1;j<=Math.min(c.active,c.pts.length-1);j++){
        curlSum+=angDiff(c.pts[j].body.angle,c.pts[j-1].body.angle); cn++;
      }
      x[i++]=clamp((cn?curlSum/cn:0)/JOINT_LIMIT,-1,1);
      const dx=tip.x-this.x, dy=tip.y-this.y;                              // [2..3] Spitze im Rumpf-System
      x[i++]=clamp((dx*ca-dy*sa)/ARM_REACH,-1.2,1.2);
      x[i++]=clamp((dx*sa+dy*ca)/ARM_REACH,-1.2,1.2);
      x[i++]=clamp(c.tipContact||0,0,1);                                   // [4] Tastkontakt
      x[i++]=clamp(c.gripLoad||0,0,1);                                     // [5] Zuglast (0 lose, 1 kurz vor Abriss)
      if(c.cups.some(q=>q.gripped)) anchored++;
      extSum += clamp(Math.hypot(dx,dy)/ARM_REACH,0,1);
    }
    this.meanExtension=extSum/N_CONN;

    // ══ [73..76] globale Propriozeption ══
    const acx=(this.vx-this.prevVx)/DT, acy=(this.vy-this.prevVy)/DT;      // Eigenbeschleunigung
    x[i++]=clamp((acx*ca-acy*sa)/6,-1,1);      // längs — wird beim Ziehen deutlich positiv
    x[i++]=clamp((acx*sa+acy*ca)/6,-1,1);      // quer
    this.prevVx=this.vx; this.prevVy=this.vy;
    x[i++]=anchored/N_CONN;                    // wie viele Arme tragen gerade
    x[i++]=clamp(this.meanExtension,0,1);      // insgesamt gestreckt vs. eingerollt

    for(let k=0;k<NO;k++){ if(i<NI) x[i++]=this.prevOut[k]; }
    this.lIn=x;return x;
  }

  tick(preys){this.age=(this.age||0)+DT;
    this.x = this.pt.x; this.y = this.pt.y;
    this.vx = this.pt.body.velocity.x; this.vy = this.pt.body.velocity.y;
    this.ang = this.pt.body.angle; this.av = this.pt.body.angularVelocity;
    // Die Augen werden bei lokalem -y gezeichnet → das ist die "Blickrichtung".
    // Die Vorwärts-Fitness benutzt dieselbe Achse, sonst würde die Evolution
    // Fortbewegung in eine Richtung belohnen, die es optisch gar nicht gibt.
    this.faceAng = this.ang - Math.PI*0.5;
    const mv = this.pt.spd();

    const inp=this.buildInputs(preys);
    const{out}=nnFwd(this.w,inp);
    if(!OVR.ai) out.fill(0);
    // _NN_OUT ist ein GETEILTER Scratch-Puffer — Inhalt sofort in eigene Felder
    this.lOut.set(out);this.prevOut.set(out);

    if(this._echoCooldown > 0) this._echoCooldown -= DT;
    if(out[26] > 0.5 && this._echoCooldown <= 0 && OVR.ai) {
      this.emitPulse();
      this._echoCooldown = 0.5;
    }

    // ══ CPG: metachronale Welle ══════════════════════════════
    // Ohne diesen Rhythmus-Prior ist "im Kreis zappeln" die stabilste
    // Lösung die die Evolution findet (gemessen: 198 Umdrehungen/Gen).
    this.cpg = (this.cpg + Math.PI*2*this.cpgHz*DT) % (Math.PI*2);

    // ══ GLOBALE ARM-STELLGRÖSSEN (out[0], out[1]) ══
    // Beide sind reine Muskel-/Gelenk-Parameter. Es wird an keiner Stelle eine
    // Kraft auf den Rumpf ausgeübt — Fortbewegung entsteht ausschließlich daraus,
    // dass verankerte Arme sich einknicken und dabei kürzer werden.
    //   out[0] → Frequenz der metachronalen Welle
    //   out[1] → Muskeltonus (schlaff ↔ steif)
    this.waveCmd = OVR.ai ? out[0] : 0;
    this.tone    = OVR.ai ? (TONE_MIN + (1-TONE_MIN)*(0.5+0.5*clamp(out[1],-1,1))) : 0;
    if(this.energy<0.15) this.tone*=clamp(this.energy/0.15,0,1);   // erschöpft → Arme werden weich
    this.cpgHz = CPG_BASE_HZ*(CPG_HZ_MIN + (CPG_HZ_MAX-CPG_HZ_MIN)*(0.5+0.5*clamp(this.waveCmd,-1,1)));

    // ── Tentakel-Steuerung ──
    let gripNow=0;
    for(let k=0;k<N_CONN;k++){
      const c=this.conns[k];if(!c.alive)continue;
      const oShoulder = out[2+k*4+0]||0;   // Schulter-Zielwinkel
      const oWave     = out[2+k*4+1]||0;   // Amplitude der metachronalen Welle
      const oCurl     = out[2+k*4+2]||0;   // statische Ruhekrümmung
      // ── Saugnapf mit HYSTERESE (Latch) ──
      // Vorher: `suctionOn = out[..] > 0.1` und der Wert wird JEDEN Frame neu aus
      // dem Netz gelesen. Ein einziger Frame knapp unter der Schwelle ließ den
      // Anker sofort los (gemessen: 32 erfolgreiche Grips, aber nur 0.5 % der
      // Schritte mit Anker — jeder Grip wurde im selben Frame wieder gelöscht).
      // Für die Evolution ist das ein praktisch unlernbares Nadelöhr.
      // Echte Saugnäpfe haften passiv: Anhaften ist eine Entscheidung, Halten
      // kostet fast nichts, und gelöst wird erst durch bewusste Entspannung.
      const suckRaw = out[2+k*4+3]||0;
      if (suckRaw >  SUCK_ON)  c.suckLatch = true;
      else if (suckRaw < SUCK_OFF) c.suckLatch = false;
      let suctionOn = !!c.suckLatch;
      if (!OVR.ai) suctionOn = false;

      let eMult = 1.0;
      if (this.energy < 0.2) eMult = clamp(this.energy * 5, 0, 1);
      if (this.energy < 0.05) suctionOn = false;

      const effort = (Math.abs(oShoulder) + Math.abs(oWave) + Math.abs(oCurl)) / 3.0 * eMult;
      const gripCost = suctionOn ? (c.cups.some(sx=>sx.gripped) ? 0.00004 : 0.00022) : 0;
      const eCost = (effort * 0.00055) + gripCost;   // Halten ist billig, neu Ansaugen teuer
      this.energySpent += eCost * 10.0;
      this.energy -= eCost;

      c.setTorques(oShoulder*eMult, oWave*eMult, oCurl*eMult);   // (Legacy, wird noch gelesen)
      c.setControl(
        clamp(oShoulder*eMult,-1,1)*SHOULDER_LIMIT,
        clamp(oCurl*eMult,-1,1)*JOINT_LIMIT*0.8,
        clamp(0.5+oWave*eMult,0,1.6),                 // CPG-Amplitude — nur wenn OVR.cpgWave
        this.cpg + (c.cpgOffset||0),
        clamp(oWave*eMult,-1,1)*JOINT_LIMIT*0.85      // direkter Gelenkwinkel, ohne CPG
      );
      c.suctionOn=suctionOn;
      c.setBase(this.x,this.y,this.ang);
      c.tick(this.map,preys,this.mass,this.x,this.y);
      if(c.cups.some(s=>s.gripped)){this.gripCount++;gripNow++}
    }

    // ══ LOCOMOTION-QUALITÄT ══════════════════════════════════
    // Vorher wurde `mv` (Betrag der Geschwindigkeit) aufsummiert. Damit ist
    // KREISELN die optimale Strategie: konstante Geschwindigkeit, kein
    // Drift-Penalty, Score steigt. Jetzt zählt nur noch die Projektion auf
    // die Blickrichtung — Kreiseln liefert ≈ 0.
    const dx=this.x-this.px, dy=this.y-this.py;
    const stepDist=Math.hypot(dx,dy);
    const fwd=dx*Math.cos(this.faceAng)+dy*Math.sin(this.faceAng);
    this.pathLen+=stepDist;
    if(fwd>0) this.forwardProg+=fwd;
    this.angularAccum+=Math.abs(this.av);
    if(gripNow>0){
      this.gripMoveDist+=Math.max(0,fwd);
      if(fwd>.12)this.gripMoveCorr++;
      this.grippedNow=gripNow;
      this.anchorTicks++;
      if(fwd>0)this.gripPullProg+=fwd;   // bereits EIN Anker reicht zum Ziehen
    }else{
      this.grippedNow=0;
      if(stepDist>.3)this.freeMoveDist+=stepDist;
    }
    // Armreichweite jetzt (Schulter→Spitze gemittelt) — für Propriozeption/Debug
    let rSum=0,rN=0;
    for(const c of this.conns){ if(!c.alive)continue; rSum+=Math.hypot(c.tipX-this.x,c.tipY-this.y); rN++; }
    this.armReach=rN?rSum/rN:0;

    const hx=false, hy=false; // removed manual walls
    this.bodyPress*=0.83;

    // Displacement tracking
    const actualMv=stepDist;
    this.px=this.x;this.py=this.y;
    if(actualMv<.15)this.idleTicks++;else this.idleTicks=0;
    if(this.idleTicks>30)this.effectiveIdlePenalty+=.03;
    this.maxDisplacement=Math.max(this.maxDisplacement,Math.hypot(this.x-this.spawnX,this.y-this.spawnY));
    this.totalDisplacement+=stepDist;

    // Exploration grid
    const gx=~~(this.x/W*28),gy=~~((this.y-TH-MBH)/(H-BH-TH-MBH)*20);
    if(gx>=0&&gy>=0&&gx<28&&gy<20)this.visited[gy*28+gx]=1;

    // Auditarcles
    for(const a of this.auds){a.setBase(this.x,this.y,this.ang);a.tick(this.map)}
    this.surfPress=0;this.echoSense=0;
    for(const a of this.auds){this.surfPress=Math.max(this.surfPress,a.pressure);this.echoSense=Math.max(this.echoSense,a.echoP)}
    if(this.echoSense>.06)this.echoResponses++;

    // Self-sound from movement
    if(mv>.5){if(!this._sndT||this._sndT<=0){emitSound(this.x,this.y,mv*.025,'ambient');this._sndT=rng(.22,.42)}else this._sndT-=DT}
    CHEM.dep(this.x,this.y,.004);

    // Internal state updates
    this.energy=clamp(this.energy - mv*.00016 - Math.abs(this.av)*.0002 + .0022, 0, 1);
    this.satiation=clamp(this.satiation-.0002,0,1);
    this.discomfort=clamp(this.discomfort+((hx||hy)?.06:-.004),0,1);
    this.arousal=lerp(this.arousal,clamp(mv*.22+Math.abs(this.av)*.16+this.tone*.35,0,1),.05);
    this.fitness+=this.satiation*.36*DT+this.energy*.08*DT;
  }

  /**
   * Wird pro Physik-Substep aufgerufen.
   *
   * Es wirkt hier ABSICHTLICH keine Kraft auf den Rumpf. Der Rumpf bewegt sich
   * ausschließlich als Reaktion auf die Gelenkmomente der Arme — und zwar nur
   * dann nennenswert, wenn mindestens ein Arm irgendwo verankert ist. Dann
   * knickt der Arm ein, wird kürzer, und zieht den Rumpf an den Anker heran
   * (oder zieht einen leichten Greifling an den Rumpf heran — dieselbe Logik,
   * der Constraint-Solver teilt nur massengewichtet auf).
   */
  applyMuscles(){
    for(const c of this.conns) if(c.alive) c.applyMuscles(this.tone);
    // Rotationsreibung des Rumpfes am Untergrund — als echtes Drehmoment, damit
    // Matter es konsistent mit den Constraints integriert.
    // τ = -c·ω·I/Δt²  (mit SUB_COMP, weil pro Substep applied)
    this.pt.body.torque -= CORE_ANG_DRAG*this.pt.body.angularVelocity*this.pt.body.inertia/M_DT2*SUB_COMP;
  }

  /**
   * Sicherheitsnetz NACH Engine.update():
   * Wasserwiderstand, harte Velocity-Limits, NaN-Reparatur, Kartenrand.
   * `Pt.step()` existierte schon immer, wurde aber NIE aufgerufen —
   * deshalb flogen die Kraken mit 3800 px/s aus der Map.
   */
  postPhysics(){
    let repaired=false;
    if(this.pt.step()) { repaired=true; this.resets++; }
    if(this.pt.contain(14)) this.wallHits++;
    for(const c of this.conns){
      if(!c.alive)continue;
      for(const p of c.pts){ if(p.step()) repaired=true; p.contain(6); }
    }
    if(repaired){
      // nach einer NaN-Reparatur alle Gelenke sauber neu legen
      for(const c of this.conns) c.layout(this.pt.x,this.pt.y,this.pt.body.angle,0.2);
      Body.setVelocity(this.pt.body,{x:0,y:0});
      Body.setAngularVelocity(this.pt.body,0);
      this.px=this.pt.x;this.py=this.pt.y;
    }
    // Wandkontakt des Mantels spürbar machen
    const bp=this.map.wallCollide(this.x,this.y,15);
    if(bp){ this.bodyPress=Math.min(1,this.bodyPress+.25); this.discomfort=clamp(this.discomfort+.02,0,1); }
  }

  _damTent(){
    if ((this.age||0) < 3.0) return; // Prevent ripping off arms on spawn!
    const sp=Math.hypot(this.vx,this.vy);if(sp<1.5)return;
    for(const c of this.conns){if(!c.alive)continue;const tip=c.tip;if(this.map.wallCollide(tip.x,tip.y,12)){const deb=c.damage(c.active-1,sp*10);if(deb){DEBRIS.push(deb);spawnFX(tip.x,tip.y,c.col,6)}break}}
  }
  onHit(){this.satiation=Math.min(1,this.satiation+.36);this.hits++;this.fitness+=2.8}
  takeDamage(tx,ty,amt){
    let best=null,bd=9999;
    for(const c of this.conns){if(!c.alive)continue;const d=Math.hypot(c.tip.x-tx,c.tip.y-ty);if(d<bd){bd=d;best=c}}
    if(best&&bd<130){const deb=best.damage(best.active-1,amt);if(deb){DEBRIS.push(deb);spawnFX(best.tip.x,best.tip.y,best.col,9)}}
    this.discomfort=Math.min(1,this.discomfort+.55);
  }

  /**
   * Fitness — vollständig auf "Ankern, Arm einknicken, heranziehen" ausgerichtet.
   *
   * Warum die alte Formel Kreiseln erzeugt hat:
   *   gripLoco = gripMoveDist*3.5 mit gripMoveDist = Σ|v|, solange IRGENDEIN Arm
   *   hält. Drehen auf der Stelle liefert volles |v|, keinen Drift-Penalty und
   *   fast keinen Energieaufwand → Score steigt, Fortschritt = 0. Gemessen am
   *   Original: Score 3244 bei 109 px echter Distanz und 198.8 Umdrehungen.
   *   Dazu: `angularAccum` war als "spinning penalty" deklariert, wurde aber nie
   *   erhöht; `wallHits` ebenfalls nie; und
   *   `effectiveIdleP = max(0, idleP − energySpent*1.5)` belohnte Verschwendung.
   *
   * Alle Terme unten sind (a) lageunabhängig — kein Spawn-Glück — und (b) einzeln
   * nicht farmbar: Zappeln liefert weder pullRate noch reach noch expl.
   */
  score(phId){
    const steps = Math.max(1, Math.round((this.age||DT)/DT));
    const dur   = Math.max(1,(this.age||0));
    const expl  = this.visited.reduce((s,v)=>s+v,0)/560;

    const meanSpeed   = this.pathLen/steps;                                       // px/step
    const directed    = this.pathLen>1 ? this.maxDisplacement/this.pathLen : 0;   // 0=zappeln, 1=gerade
    const headingHold = 1 - clamp(this.angularAccum/(steps*MAX_ANG_V_CORE), 0, 1);
    // Anteil des beim Spawn vermessenen Freiraums, der erreicht wurde → spawn-fair
    const reach       = clamp(this.maxDisplacement/Math.max(70,this.spawnReach||400), 0, 1.2);

    // ── DER MECHANISMUS ──
    // pullRate = Vorwärts-px pro Step, die WÄHREND einer Verankerung zustande
    // kamen. Das ist exakt "Saunapf hält, Arm knickt ein, Rumpf wird herangezogen".
    // Ohne Anker gibt es keinen Beitrag; Anker ohne Ziehen zahlt nur `cost`.
    const pullRate  = (this.gripPullProg||0)/steps;
    const anchorUse = clamp(this.anchorTicks/steps, 0, 1);

    const travel = pullRate*1100          // Ziehen mit Anker  — Hauptanreiz
                 + reach*240              // Freiraum-Ausnutzung
                 + directed*95            // Geradlinigkeit
                 + headingHold*45         // ruhiger Kurs
                 + expl*1800              // neu betretene Rasterzellen (bounded, vergleichbar)
                 + meanSpeed*40           // überhaupt mobil sein (klein, sonst Zappel-Anreiz)
                 + anchorUse*12;          // Verankern allein zahlt fast nichts

    const spinP = this.angularAccum*0.55;             // endlich verdrahtet
    const wallP = this.wallHits*0.35;                 // endlich verdrahtet
    const idleP = this.effectiveIdlePenalty*4.0;
    const cost  = this.energySpent*0.30;
    const eff   = travel/Math.max(0.6,this.energySpent);   // Strecke pro Energie
    const echoBonus = Math.min(this.echoResponses, 600)*0.06;
    // Chemotaxis: mittlerer Geruchswert statt endlos aufsummierter Rohwerte
    const chemAvg  = (this.chemSensed/Math.max(1,this.stepCount||1))*dur*0.35;
    const preyNear = Math.max(0,(500-(this._preyMinDist||500))*0.06);

    switch(phId){
      case 0: // MOTOR PRIMITIVES — Ankern und Ziehen lernen
        return travel + eff*3 - spinP - wallP - idleP - cost;
      case 1: // ECHOLOCATION
        return travel + eff*2 + echoBonus*10 - spinP - wallP - idleP - cost;
      case 2: // CHEMOTAXIS
        return travel + chemAvg*6 + preyNear + eff*2 - spinP - wallP - idleP - cost;
      case 3:
      case 4: // ACTIVE PURSUIT / EVASIVE PREY
        return this.hits*25 + this.satiation*20 + travel*0.6 + preyNear*1.5 + eff*2
             - spinP - wallP - idleP - cost;
      default: // FREE EMERGENCE
        return this.hits*30 + this.satiation*22 + travel*0.8 + chemAvg*4 + echoBonus*6 + eff*3
             - spinP*1.2 - wallP - idleP - cost;
    }
  }

  draw(alpha=1){
    ctx.save();ctx.globalAlpha=alpha;
    const[r,g,b]=rgb(this.col);
    for(const c of this.conns)if(c.alive)c.draw();
    ctx.save();ctx.translate(this.x,this.y);
    const sp=this.surfPress,es=this.echoSense;
    
    const bs=24;
    ctx.beginPath();ctx.arc(0,0,bs,0,Math.PI*2);
    ctx.closePath();
    const ef=.28+this.energy*.72;
    const bg=ctx.createRadialGradient(0,-3,1,0,0,18);
    bg.addColorStop(0,`rgba(${~~(r*ef)},${~~(g*ef*1.1)},${~~(b*ef)},1)`);bg.addColorStop(.65,`rgba(${~~(r*ef*.38)},${~~(g*ef*.38)},${~~(b*ef*.38)},.9)`);bg.addColorStop(1,'#000706');
    ctx.fillStyle=bg;ctx.fill();ctx.strokeStyle=`rgba(${r},${g},${b},.55)`;ctx.lineWidth=1.5;ctx.stroke();
    ctx.rotate(this.ang);
    // Eyes: purple tint when detecting echo reflection
    const ec=this.discomfort>.35?`rgb(255,${~~(g*.2)},${~~(b*.2)})`:es>.12?'#c050ff':this.col;
    for(const ex of[-6,6]){ctx.beginPath();ctx.arc(ex,-5,3.8,0,Math.PI*2);ctx.fillStyle='#000';ctx.fill();ctx.beginPath();ctx.arc(ex,-5,2.2+this.arousal*.6+es*.5,0,Math.PI*2);ctx.fillStyle=ec;ctx.fill()}
    ctx.restore();ctx.restore();
  }
}

// ─── FX ──────────────────────────────────────────────────
const FX=[];
function spawnFX(x,y,col,n=10){for(let i=0;i<n;i++){const a=rnd()*Math.PI*2,s=1+rnd()*4;FX.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:1,col:i<n/2?col:'#fff'})}}
function tickFX(){for(let i=FX.length-1;i>=0;i--){const p=FX[i];p.x+=p.vx;p.y+=p.vy;p.vx*=.88;p.vy*=.88;p.life-=.03;if(p.life<=0)FX.splice(i,1)}}
function drawFX(){for(const p of FX){ctx.save();ctx.globalAlpha=p.life;ctx.shadowColor=p.col;ctx.shadowBlur=8;ctx.fillStyle=p.col;ctx.beginPath();ctx.arc(p.x,p.y,3*p.life,0,Math.PI*2);ctx.fill();ctx.restore()}}

// ─── PLAYER ──────────────────────────────────────────────
const KEYS={};
class Player{
  constructor(map){const sp=map.randSpawn(14);this.x=sp.x;this.y=sp.y;this.vx=0;this.vy=0;this.ang=0;this.hp=3;this.alive=true;this.atkCd=0;this.invT=0;this.atkF=0;this.map=map;this._st=0}
  tick(orgs){
    if(!this.alive)return;
    this.atkCd=Math.max(0,this.atkCd-DT);this.invT=Math.max(0,this.invT-DT);this.atkF=Math.max(0,this.atkF-DT);
    let ax=0,ay=0;const sp=3.2;
    if(KEYS['KeyW']||KEYS['ArrowUp'])ay-=sp;if(KEYS['KeyS']||KEYS['ArrowDown'])ay+=sp;
    if(KEYS['KeyA']||KEYS['ArrowLeft'])ax-=sp;if(KEYS['KeyD']||KEYS['ArrowRight'])ax+=sp;
    if(TCH.active){ax+=TCH.dx*sp;ay+=TCH.dy*sp}
    if(ax||ay){const l=Math.hypot(ax,ay);this.vx=ax/l*sp;this.vy=ay/l*sp;this.ang=Math.atan2(ay,ax)}else{this.vx*=.8;this.vy*=.8}
    const nx=this.x+this.vx,ny=this.y+this.vy;
    const cb=this.map.resolveBody(nx,ny,13);this.x=clamp(cb.x,13,W-13);this.y=clamp(cb.y,TH+MBH+13,H-BH-13);
    const mv=Math.hypot(this.vx,this.vy);
    if(mv>.5){CHEM.dep(this.x,this.y,.016);this._st-=DT;if(this._st<=0){emitSound(this.x,this.y,.25*mv,'ambient');this._st=rng(.1,.2)}}
    if(this.invT>0)return;
    for(const o of orgs){for(const c of o.conns){if(!c.alive)continue;const tip=c.tip;if(Math.hypot(tip.x-this.x,tip.y-this.y)<13&&tip.spd()>1.5){this.hp--;this.invT=2;spawnFX(this.x,this.y,'#aaddff',16);emitSound(this.x,this.y,1.5,'ambient');if(this.hp<=0){this.alive=false;spawnFX(this.x,this.y,'#fff',40)}break}}}
    document.getElementById('php').textContent='◆'.repeat(Math.max(0,this.hp))+'◇'.repeat(Math.max(0,3-this.hp));
  }
  atk(mx,my,orgs){
    if(!this.alive||this.atkCd>0)return;this.atkCd=.9;this.atkF=.28;
    emitSound(mx,my,2.0,'ambient');spawnFX(mx,my,'#fff',10);
    for(const o of orgs)if(Math.hypot(o.x-this.x,o.y-this.y)<130)o.takeDamage(mx,my,52+rnd()*28);
  }
  draw(){
    if(!this.alive){ctx.save();ctx.fillStyle='rgba(170,210,255,.2)';ctx.font='12px Orbitron,monospace';ctx.textAlign='center';ctx.fillText('PLAYER DEAD — R TO RESET',W/2,H/2);ctx.restore();return}
    if(this.invT>0&&Math.floor(Date.now()/80)%2)return;
    ctx.save();ctx.translate(this.x,this.y);ctx.rotate(this.ang);
    ctx.shadowColor='#aaddff';ctx.shadowBlur=16;ctx.beginPath();ctx.arc(0,0,13,0,Math.PI*2);
    const pg=ctx.createRadialGradient(0,-2,1,0,0,13);pg.addColorStop(0,'#fff');pg.addColorStop(.5,'#aaddff');pg.addColorStop(1,'#224466');ctx.fillStyle=pg;ctx.fill();ctx.strokeStyle='rgba(180,220,255,.65)';ctx.lineWidth=1.5;ctx.stroke();
    ctx.fillStyle='#88ccff';ctx.beginPath();ctx.moveTo(10,0);ctx.lineTo(18,0);ctx.lineTo(13,4);ctx.closePath();ctx.fill();
    if(this.atkF>0){ctx.globalAlpha=this.atkF/.28;ctx.strokeStyle='#fff';ctx.lineWidth=2.5;ctx.shadowBlur=22;ctx.beginPath();ctx.arc(0,0,80,-Math.PI*.3,Math.PI*.3);ctx.stroke()}
    ctx.restore();
  }
}
const TCH={active:false,dx:0,dy:0,id:-1};
const JOY={x:80,y:400,r:52};const ATK={x:0,y:0,r:38};
function layoutTouch(){JOY.x=80;JOY.y=H-BH-88;ATK.x=W-80;ATK.y=H-BH-88}
function drawTouchUI(){
  if(!MOB||simMode!=='PLAY')return;
  ctx.save();ctx.globalAlpha=.35;ctx.strokeStyle='#0f8';ctx.lineWidth=2;ctx.beginPath();ctx.arc(JOY.x,JOY.y,JOY.r,0,Math.PI*2);ctx.stroke();
  if(TCH.active){ctx.globalAlpha=.6;ctx.fillStyle='rgba(0,255,179,.18)';ctx.beginPath();ctx.arc(JOY.x,JOY.y,JOY.r,0,Math.PI*2);ctx.fill();ctx.globalAlpha=.75;ctx.fillStyle='rgba(0,255,179,.72)';ctx.beginPath();ctx.arc(JOY.x+TCH.dx*JOY.r,JOY.y+TCH.dy*JOY.r,JOY.r*.3,0,Math.PI*2);ctx.fill()}
  ctx.globalAlpha=.38;ctx.strokeStyle='#f44';ctx.lineWidth=2;ctx.beginPath();ctx.arc(ATK.x,ATK.y,ATK.r,0,Math.PI*2);ctx.stroke();ctx.fillStyle='rgba(255,50,50,.14)';ctx.beginPath();ctx.arc(ATK.x,ATK.y,ATK.r,0,Math.PI*2);ctx.fill();ctx.globalAlpha=.5;ctx.fillStyle='#f44';ctx.font='9px Share Tech Mono,monospace';ctx.textAlign='center';ctx.fillText('ATK',ATK.x,ATK.y+3);ctx.restore();
}

// ─── EVOLVER ─────────────────────────────────────────────
const MAP=new GameMap();

/**
 * Zentraler Physik-Schritt für TRAIN und PLAY.
 *
 * Reihenfolge ist wichtig:
 *   1. Wahrnehmung + NN + CPG + Muskel-Zielwerte  (60 Hz, 1× pro Step)
 *   2. Physik mit SUBSTEPS: Muskeln schreiben body.torque, dann Engine.update.
 *      Mehrere Relaxations-Durchläufe halten die 42 Gelenke pro Kraken stabil —
 *      das ist der Unterschied zwischen "organischer Arm" und "Peitschen-Explosion".
 *   3. Sicherheitsnetz: Wasserwiderstand, Velocity-Clamp, NaN-Reparatur, Kartenrand.
 *   4. Tentakel↔Beute-Kontakt.
 */
function stepPhysics(orgs, preys){
  for(const o of orgs) if(o) o.tick(preys);
  for(const p of preys) if(p) p.tick(orgs);

  for(let s=0;s<SUBSTEPS;s++){
    for(const o of orgs) if(o) o.applyMuscles();
    Engine.update(engine, SUB_DT*1000);
  }

  for(const o of orgs) if(o) o.postPhysics();

  // ── Tentakelspitze trifft Beute ──
  for(const o of orgs){
    if(!o) continue;
    for(const p of preys){
      if(!p) continue;
      if(p.hitCd>0){ p.hitCd-=DT; continue; }
      for(const c of o.conns){
        if(!c.alive)continue;
        const tip=c.tip; if(!tip) continue;
        if(Math.hypot(tip.x-p.x,tip.y-p.y) < p.r+9 && tip.spd()>0.9){
          // Kein Knockback per setVelocity mehr — das wäre eine von außen
          // aufgedrückte Geschwindigkeit. Tentakel und Beute kollidieren echt
          // (mask COL_PREY), der Impulsübergang kommt aus dem Solver.
          p.panic=1; p.hitCd=0.6;
          o.onHit();
          spawnFX(p.x,p.y,'#ffcc44',5);
          break;
        }
      }
    }
  }
}

class Evolver{
  constructor(popSz){this.pop=popSz;this.orgs=[];this.preys=[];this.gen=0;this.phIdx=0;this.phGenCnt=0;this.mapRegenCnt=0;this.genT=0;this.bestFit=0;this.bestW=null;this.fitHist=[];this.log=[];this.stepCount=0}
  get phase(){return PHASES[this.phIdx]}
  init(){CHEM.init();WAVES.w0&&WAVES.w0.fill(0);WAVES.w1&&WAVES.w1.fill(0);this._ng()}
  _ng(){
    for(const o of this.orgs) o.destroy(); this.orgs=[];
    for(let i=0;i<this.pop;i++){
      const sp=MAP.randSpawn(26);
      const w=this.bestW&&this.gen>0?nnMut(this.bestW,this.phase.mut.r*(1+rnd()*.5),this.phase.mut.m*(1+rnd()*.5)):nnNew();
      this.orgs.push(new Organism(sp.x,sp.y,w,i,MAP));
    }
    if(this.preys) for(const p of this.preys) p.destroy();
    this.preys=[];
    for(let i=0;i<this.phase.preyN;i++){const sp=MAP.randSpawn(14);this.preys.push(new Prey(sp.x,sp.y,MAP,this.phase.pSpd))}
    this.genT=0;
    updateAliensCollision();
  }
  _evo(){
    this.orgs.forEach(o=>o.fitness=o.score(this.phIdx));
    this.orgs.sort((a,b)=>b.fitness-a.fitness);
    const bf=this.orgs[0].fitness;
    const o0=this.orgs[0];
    if(bf>this.bestFit){this.bestFit=bf;this.bestW=o0.w.slice()}
    else if(this.gen>0&&bf>this.bestFit*0.55&&this.bestW===null){this.bestW=o0.w.slice()}
    this.fitHist.push(bf);if(this.fitHist.length>80)this.fitHist.shift();
    this.log.unshift(`G${this.gen} P${this.phIdx+1}: F=${bf.toFixed(1)} H=${o0.hits} GL=${o0.gripMoveDist.toFixed(0)} E=${o0.echoResponses}`);
    if(this.log.length>14)this.log.pop();
    this.gen++;this.phGenCnt++;this.mapRegenCnt++;
    if(this.mapRegenCnt>=mapRegenInterval){this.mapRegenCnt=0;MAP.build();CHEM.init();WAVES.w0&&WAVES.w0.fill(0);WAVES.w1&&WAVES.w1.fill(0);flashEp('MAP REGENERATED','adapting to new layout...')}
    const gpp=MOB?Math.max(3,this.phase.gpp-2):this.phase.gpp;
    if(this.phGenCnt>=gpp&&this.phIdx<PHASES.length-1){this.phIdx++;this.phGenCnt=0;this.bestFit=0;flashEp(this.phase.name,this.phase.sub);const ps=document.getElementById('psel');if(ps)ps.value=this.phIdx}
    if(!autoEvo){this._ng();return}
    const nw=[this.orgs[0].w.slice()];if(this.pop>1)nw.push(this.orgs[1].w.slice());
    while(nw.length<this.pop){
      if(rnd()<.05) nw.push(nnNew());
      else {
        const pi=~~(rnd()*Math.min(4,this.orgs.length));const pj=~~(rnd()*Math.min(4,this.orgs.length));
        nw.push(rnd()<.28&&pi!==pj?nnCross(this.orgs[pi].w,this.orgs[pj].w):nnMut(this.orgs[pi].w,this.phase.mut.r,this.phase.mut.m));
      }
    }
    this._ng();for(let i=0;i<this.orgs.length;i++)this.orgs[i].w=nw[i];
  }
  step(){
    // `this.stepCount++` auf undefined ergab NaN → `NaN % 12 === 0` ist false →
    // CHEM.diffuse() lief im TRAIN-Modus NIE. Die Chemorezeptoren der Kraken
    // haben also nie eine Diffusionsfahne gesehen (Phase 3 CHEMOTAXIS = tot).
    this.stepCount=(this.stepCount||0)+1;
    if(this.stepCount % 12 === 0) CHEM.diffuse();
    tickSounds(MAP);CHEM.decay();MAP.tick();
    stepPhysics(this.orgs,this.preys);
    tickFX();this.genT+=DT;
    if(this.genT>=this.phase.dur)this._evo();
  }
  getBest(){return this.orgs.reduce((b,o)=>o.fitness>b.fitness?o:b,this.orgs[0])}
  setPhase(idx){this.phIdx=clamp(idx,0,PHASES.length-1);this.phGenCnt=0;this.bestFit=0;this._ng();flashEp(this.phase.name,this.phase.sub)}
}

class PlaySession{
  constructor(w){
    const sp=MAP.randSpawn(24);
    this.org=new Organism(sp.x,sp.y,w,0,MAP);
    this.preys=[];
    for(let i=0;i<5;i++){const psp=MAP.randSpawn(14);this.preys.push(new Prey(psp.x,psp.y,MAP,1.1))}
    this.player=new Player(MAP);
  }
  step(){
    this.stepCount = (this.stepCount||0) + 1;
    if(this.stepCount % 12 === 0) CHEM.diffuse();
    tickSounds(MAP); CHEM.decay(); MAP.tick();
    if(this.preys.length<4){const psp=MAP.randSpawn(14);this.preys.push(new Prey(psp.x,psp.y,MAP,1.1))}
    // Player ist kein Matter-Body → eigene Beutelisten-Perspektive
    const orgs = this.org ? [this.org] : [];
    for(const p of this.preys) if(p) p.tick(this.player&&this.player.alive?[this.org,this.player]:orgs);
    if(this.org) this.org.tick(this.preys);
    for(let s=0;s<SUBSTEPS;s++){
      if(this.org) this.org.applyMuscles();
      Engine.update(engine, SUB_DT*1000);
    }
    if(this.org){
      this.org.postPhysics();
      for(const c of this.org.conns){
        if(!c || !c.alive)continue;
        const tip=c.tip; if(!tip) continue;
        for(const p of this.preys){
          if(!p) continue;
          if(p.hitCd>0){ p.hitCd-=DT; continue; }
          if(Math.hypot(tip.x-p.x,tip.y-p.y)<p.r+9&&tip.spd()>0.9){
            p.panic=1; p.hitCd=0.6; this.org.onHit();
            spawnFX(p.x,p.y,'#ffcc44',5);
          }
        }
      }
    }
    if(this.player) this.player.tick(orgs);
    tickFX();
  }
  draw(){MAP.draw();drawSounds();CHEM.draw();for(const p of this.preys)p.draw();this.org.draw(1);this.player.draw();MAP.applyLighting()}
}

// ─── GLOBAL STATE ─────────────────────────────────────────
let evlv=null,playS=null,simMode='TRAIN';
let paused=false,speed=1,autoEvo=true,popSz=MOB?6:8,mapRegenInterval=5;
// cpgWave = false ist DEFAULT und bleibt es: keine handgeschriebene Gangkurve.
// Der Schalter existiert nur, um den Unterschied messbar zu machen (A/B), nicht
// weil das Spiel ihn braucht.
const OVR={ch:true,sw:false,lt:false,col:false,ai:true,noCol:false,floorGrip:true,cpgWave:false};
let _spsAcc=0,_spsT=0,_sps=0;

function setMode(m){
  simMode=m;
  const tt = document.getElementById('tt');
  if(tt) tt.classList.toggle('on',m==='TRAIN');
  const tp = document.getElementById('tp');
  if(tp) tp.classList.toggle('on',m==='PLAY');
  const isP=m==='PLAY';
  const php = document.getElementById('php');
  if(php) php.style.display=isP?'block':'none';
  const pbk = document.getElementById('pbk');
  if(pbk) pbk.style.display=isP?'block':'none';
  const ftr = document.getElementById('ftr');
  if(ftr) ftr.style.display=isP?'none':'flex';
  const info = document.getElementById('info');
  if(info) info.style.display=isP?'none':'flex';
}
function tryPlay(){if(!evlv?.bestW){notify('Train first — no genome yet');return}CHEM.init();WAVES.w0&&WAVES.w0.fill(0);WAVES.w1&&WAVES.w1.fill(0);FX.length=0;playS=new PlaySession(evlv.bestW.slice());setMode('PLAY');layoutTouch();updateAliensCollision();notify('PLAY — ESC to return')}
function exitPlay(){ if(playS){ if(playS.org) playS.org.destroy(); for(const p of playS.preys) p.destroy(); if(playS.player && playS.player.destroy) playS.player.destroy(); } playS=null;WAVES.w0&&WAVES.w0.fill(0);WAVES.w1&&WAVES.w1.fill(0);setMode('TRAIN');notify('RESUMED TRAINING')}
function togglePause(){
  paused = !paused;
  if (window.__simState) window.__simState.paused = paused;
  const brun = document.getElementById('brun');
  if (brun) {
    brun.textContent = paused ? '▶ PLAY' : '▶ RUN';
    brun.classList.toggle('on', !paused);
  }
  const paus = document.getElementById('paus');
  if (paus) paus.style.opacity = paused ? 1 : 0;
}
let autoSpeed = false;
function setSp(v){speed=v;document.getElementById('sv').textContent=v+'×'; autoSpeed=false; document.getElementById('bauto')?.classList.remove('on');}
function toggleAutoSpeed(){
  autoSpeed = !autoSpeed;
  document.getElementById('bauto')?.classList.toggle('on', autoSpeed);
  if(autoSpeed) {
    speed = 9999;
    document.getElementById('sv').textContent = 'MAX';
  } else {
    speed = parseInt(document.getElementById('sr').value);
    document.getElementById('sv').textContent = speed + '×';
  }
}
function doReset(){CHEM.init();WAVES.w0&&WAVES.w0.fill(0);WAVES.w1&&WAVES.w1.fill(0);teardownWorld();playS=null;MAP.build();evlv=new Evolver(popSz);evlv.init();if(simMode==='PLAY')setMode('TRAIN');notify('RESET')}
function toggleEvo(){autoEvo=!autoEvo;const b=document.getElementById('bevo');if(b){b.textContent='EVO '+(autoEvo?'ON':'OFF');b.classList.toggle('on',autoEvo);}}
function forceMut(){if(!evlv)return;const bw=evlv.getBest().w;for(const o of evlv.orgs)o.w=nnMut(bw,.28,.45);notify('FORCED MUTATION')}
function addPrey(n){const m=simMode==='PLAY'&&playS?playS:evlv;if(!m)return;for(let i=0;i<n;i++){const sp=MAP.randSpawn(14);(simMode==='PLAY'?playS.preys:evlv.preys).push(new Prey(sp.x,sp.y,MAP,simMode==='PLAY'?1.1:evlv.phase.pSpd))}}
function clearPrey(){
  const m=simMode==='PLAY'&&playS?playS:evlv;
  if(!m)return;
  if(m.preys) for(const p of m.preys) p.destroy();
  m.preys=[];
}
function newGen(){if(evlv)evlv._evo()}
function nextPhase(){if(evlv)evlv.setPhase(evlv.phIdx+1)}
function setPhase(idx){if(evlv)evlv.setPhase(idx)}
function setPopSz(n){popSz=n;if(evlv){evlv.pop=n;evlv._ng()}const pc=document.getElementById('popc');if(pc)pc.textContent=n;}
function tog(k){
  OVR[k]=!OVR[k];
  document.getElementById('b'+k)?.classList.toggle('on',OVR[k]);
  if(k==='noCol') updateAliensCollision();
}

function updateAliensCollision() {
  const isNoCol = OVR.noCol;
  const bodyMask = isNoCol ? 0 : (COL_WALL | COL_PREY);
  // Tentakel MÜSSEN Wände und Beute spüren, sonst kann ein Kraken sich
  // nirgends abstützen und "Grip-and-pull"-Locomotion ist physikalisch unmöglich.
  // Vorher: mask=0 + isSensor=true für alle 42 Segmente → Arme geisterten durch alles.
  // Die negative `group` pro Organismus verhindert weiterhin Selbst-Kollision.
  const tentMask = isNoCol ? 0 : (COL_WALL | COL_PREY);
  const targets = [];
  if(evlv) targets.push(...evlv.orgs);
  if(playS && playS.org) targets.push(playS.org);

  for(const o of targets) {
    if(!o || !o.pt) continue;
    o.pt.body.isSensor = isNoCol;
    o.pt.body.collisionFilter.mask = bodyMask;

    for(const c of o.conns) {
      for(const p of c.pts) {
        p.body.isSensor = isNoCol;
        p.body.collisionFilter.mask = tentMask;
        p.body.collisionFilter.group = o.group;
      }
    }
  }
  notify('Collision ' + (isNoCol ? 'OFF' : 'ON'));
}
function rebuildMap(){MAP.build();CHEM.init();WAVES.w0&&WAVES.w0.fill(0);WAVES.w1&&WAVES.w1.fill(0);if(evlv)evlv._ng();notify('MAP REBUILT')}
function setMapRegen(v){mapRegenInterval=v}

function flashEp(n,s=''){const el=document.getElementById('flv');if(el){const elN=el.querySelector('#fln');const elS=el.querySelector('#fls');if(elN)elN.textContent=n;if(elS)elS.textContent=s;el.style.opacity=1;clearTimeout(el._t);el._t=setTimeout(()=>el.style.opacity=0,2400)}}
function notify(msg,t=2500){const el=document.getElementById('ntf');if(el){el.textContent=msg;el.style.opacity=1;clearTimeout(el._t);el._t=setTimeout(()=>el.style.opacity=0,t)}}

// ─── HUD ─────────────────────────────────────────────────
let hudT=0;
function updateHUD(){
  if(hudT++%3!==0||!evlv)return;
  const ph=evlv.phase;
  const elHgen = document.getElementById('hgen');
  if(elHgen) elHgen.textContent='G'+evlv.gen;
  const elHfit = document.getElementById('hfit');
  if(elHfit) elHfit.textContent=evlv.bestFit.toFixed(2);
  const elHsps = document.getElementById('hsps');
  if(elHsps) elHsps.textContent=_sps>0?~~_sps+'s/s':'—';
  const elPlbl = document.getElementById('plbl');
  if(elPlbl) elPlbl.textContent=ph.name;
  const elGbf = document.getElementById('gbf');
  if(elGbf) elGbf.style.width=Math.min(100,evlv.genT/ph.dur*100).toFixed(1)+'%';
  const elPc = document.getElementById('pc');
  if(elPc) elPc.textContent=(simMode==='PLAY'?playS?.preys.length:evlv.preys.length)||0;
  const elMg = document.getElementById('mg');
  if(elMg) elMg.textContent='G'+evlv.gen;
  const elMph = document.getElementById('mph');
  if(elMph) elMph.textContent=ph.name.split(' ')[0];
  const elMf = document.getElementById('mf');
  if(elMf) elMf.textContent='F:'+evlv.bestFit.toFixed(1);
  const elMs = document.getElementById('ms');
  if(elMs) elMs.textContent=~~_sps+'sps';
  
  if(MOB)return;
  const elPgn = document.getElementById('pgn');
  if(elPgn) elPgn.textContent='GEN '+evlv.gen;
  
  const sorted=[...evlv.orgs].sort((a,b)=>b.fitness-a.fitness);const bf=evlv.bestFit||1;
  const elPlist = document.getElementById('plist');
  if(elPlist) elPlist.innerHTML=sorted.map((o,i)=>{const f=o.score(evlv.phIdx);return `<div class="pr ${i===0?'best':''}"><div style="font-size:11px;font-weight:bold;width:20px;text-align:center;color:${o.col}">${i+1}</div><div style="flex:1"><div class="prb" style="width:${(f/Math.max(bf,f)*100).toFixed(0)}%;background:${o.col}"></div><div class="prm">F:${f.toFixed(1)} GL:${o.gripMoveDist.toFixed(0)} E:${o.echoResponses}</div></div>${i===0?'<div style="font-size:9px;color:#00ffb3;letter-spacing:1px;font-weight:bold">BEST</div>':''}</div>`}).join('');
  
  const elElog = document.getElementById('elog');
  if(elElog) elElog.innerHTML=evlv.log.map(l=>`<div style="margin-bottom:4px; font-weight: 500;">${l}</div>`).join('');
  
  const best=evlv.getBest();
  if(!best) return;
  function nNodes(id,vals,cfn,count){
    const el = document.getElementById(id);
    if(!el) return;
    let h='';for(let i=0;i<count;i++){const v=i<vals.length?vals[i]:0;const{bg,bc}=cfn(v);h+=`<div class="nn" style="background:${bg};border-color:${bc}"></div>`}
    el.innerHTML=h;
  }
  nNodes('nna',[...best.lIn.slice(0,8)],v=>{const a=Math.abs(v);const pos=v>0;return{bg:pos?`rgba(210,70,255,${(.06+a*.8).toFixed(2)})`:`rgba(50,180,255,${(.06+a*.8).toFixed(2)})`,bc:pos?`rgba(210,70,255,${(a*.6).toFixed(2)})`:`rgba(50,180,255,${(a*.6).toFixed(2)})`}},8);
  nNodes('nnc',[...best.lIn.slice(9,15)],v=>{const a=clamp(v,0,1);return{bg:`rgba(255,105,25,${(.06+a*.8).toFixed(2)})`,bc:`rgba(255,105,25,${(a*.6).toFixed(2)})`}},6);
  nNodes('nns',[...best.lIn.slice(15,21)],v=>{const a=clamp(v,0,1);return{bg:`rgba(0,255,179,${(.06+a*.9).toFixed(2)})`,bc:`rgba(0,255,179,${(a*.7).toFixed(2)})`}},6);
  const vs=[
    {n:'ENERGY',   v:best.energy,      c:'#00ffb3'},
    {n:'SATIATION',v:best.satiation,   c:'#ffaa00'},
    {n:'DISCOMFORT',v:best.discomfort, c:'#ff3a6e'},
    {n:'AROUSAL',  v:best.arousal,     c:'#b060ff'},
    {n:'ECHO SENSE',v:best.echoSense,  c:'#c050ff'},
    {n:'GRIP LOCO', v:clamp(best.gripMoveDist/200,0,1),c:'#00ffb3'},
    {n:'ANCHORS',  v:clamp((best.grippedNow||0)/N_CONN,0,1),c:'#7fe7ff'},
    {n:'ARM CURL', v:clamp((best.armReach||0)/118,0,1),      c:'#ff8040'},
  ];
  const elVit = document.getElementById('vit');
  if(elVit) elVit.innerHTML=vs.map(v=>`<div class="vr"><div class="vn">${v.n}</div><div class="vbx"><div class="vbf" style="width:${(v.v*100).toFixed(1)}%;background:${v.c}"></div></div></div>`).join('');
}

function drawDebugColliders(){
  const bodies = Composite.allBodies(world);
  ctx.save();
  ctx.lineWidth = 1.2;
  for(const b of bodies){
    ctx.beginPath();
    const parts = b.parts.length > 1 ? b.parts.slice(1) : [b];
    for(const p of parts){
      const verts = p.vertices;
      if(!verts || verts.length === 0) continue;
      ctx.moveTo(verts[0].x, verts[0].y);
      for(let i=1; i<verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
      ctx.lineTo(verts[0].x, verts[0].y);
    }
    // Color coding based on category/type
    if(b.isStatic) ctx.strokeStyle = 'rgba(255,255,255,0.8)'; // Wall
    else if(b.collisionFilter.category === COL_CORE) ctx.strokeStyle = 'rgba(0,180,255,0.9)'; // Core
    else if(b.collisionFilter.category === COL_TENTACLE) ctx.strokeStyle = 'rgba(0,255,179,0.7)'; // Tentacle
    else if(b.collisionFilter.category === COL_PREY) ctx.strokeStyle = 'rgba(255,170,0,0.8)'; // Prey
    else ctx.strokeStyle = 'rgba(255,0,255,0.5)';
    ctx.stroke();
  }
  // Draw Constraints
  const constraints = Composite.allConstraints(world);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.setLineDash([2, 5]);
  for(const c of constraints){
    if(!c.bodyA && !c.bodyB) continue;
    const p1 = c.bodyA ? Vector.add(c.bodyA.position, c.pointA) : c.pointA;
    const p2 = c.bodyB ? Vector.add(c.bodyB.position, c.pointB) : c.pointB;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
  ctx.restore();
}

// ─── MAIN LOOP ────────────────────────────────────────────
let lastT=0;
let loopErrorCount = 0;
function loop(ts){
  try {
    window._simLoopId = requestAnimationFrame(loop);
    const dt=Math.min((ts-lastT)/1000,.08);lastT=ts;
    _spsT+=dt;if(_spsT>.6){_sps=_spsAcc/_spsT;_spsAcc=0;_spsT=0}

      if(!paused&&evlv){
      if(simMode==='TRAIN'){
        const t0=performance.now();let s=0;
        while(s<speed&&performance.now()-t0<28){
          evlv.step();s++;_spsAcc++;
        }
      }else if(simMode==='PLAY'&&playS){
        const t0=performance.now();let s=0;
        while(s<Math.min(speed,4)&&performance.now()-t0<16){
          playS.step();s++;_spsAcc++;
        }
      }
    }

    if (!cv) {
      cv = document.getElementById('c');
      if (cv) ctx = cv.getContext('2d');
    }
    if (cv && (cv.width !== window.innerWidth || cv.height !== window.innerHeight || viewScale <= 0)) {
      resize();
    }
    if (!cv || !ctx) return;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle='#000';
    ctx.fillRect(0,0,cv.width,cv.height);
    
    if (viewScale <= 0) {
      ctx.fillStyle = '#0f8';
      ctx.font = '14px Orbitron';
      ctx.fillText('INVALID SCALE: ' + viewScale, 20, 40);
      return;
    }

    ctx.translate(vX,vY);
    ctx.scale(viewScale,viewScale);
    ctx.fillStyle='#000409';
    ctx.fillRect(0,0,W,H);

    if (world && Composite.allBodies(world).length === 0) {
      ctx.fillStyle = '#f44';
      ctx.font = '20px Orbitron';
      ctx.fillText('WORLD EMPTY', 50, 100);
    }

    if(simMode==='TRAIN'&&evlv){
    if(!autoSpeed || _spsAcc % 60 === 0) { // Only draw occasionally if in AUTO mode
      MAP.draw();drawSounds();CHEM.draw();
      for(const p of evlv.preys)p.draw();
      const best=evlv.getBest();
      for(const o of evlv.orgs)if(o!==best)o.draw(.25);
      best.draw(1);drawFX();
      MAP.applyLighting();
    } else {
      // Minimal draw to show it's running
      ctx.fillStyle='#00ffb3';
      ctx.font='14px Orbitron,monospace';
      ctx.fillText('AUTO SPEED ACTIVE: ' + ~~_sps + ' steps/sec', 20, H - 60);
    }
  }else if(simMode==='PLAY'&&playS){
    playS.draw();drawFX();drawTouchUI();
  }

  // Vignette + scanlines
  const vg=ctx.createRadialGradient(W/2,H/2,H*0.18,W/2,H/2,H*0.86);
  vg.addColorStop(0,'rgba(0,0,0,0)');vg.addColorStop(1,'rgba(0,0,0,.1)');
  ctx.fillStyle=vg;ctx.fillRect(0,0,W,H);
  ctx.save();ctx.globalAlpha=.005;ctx.fillStyle='#00ffb3';
  for(let y=TH;y<H-BH;y+=4)ctx.fillRect(0,y,W,1);
  ctx.restore();
  if(OVR.col) drawDebugColliders();
    updateHUD();
  } catch (e) {
    loopErrorCount++;
    if (loopErrorCount < 10) console.error("LOOP_CRASH:", e);
    if (loopErrorCount === 10) console.warn("Muting loop crashes.");
  }
}

// ─── BOOT ─────────────────────────────────────────────────
/**
 * Räumt den Matter-World komplett leer.
 * Ohne das stapeln sich bei jedem Reset/Re-Boot ganze Populationen:
 * gemessen 527 Bodies statt 269 — also 6 unsichtbare Geister-Kraken
 * (258 Bodies), die nie getickt, nie gezeichnet, aber immer kollidiert sind.
 */
function teardownWorld(){
  if(!world) return;
  try{
    if(evlv){ for(const o of evlv.orgs) if(o&&o.destroy)o.destroy(); for(const p of (evlv.preys||[])) if(p&&p.destroy)p.destroy(); }
    if(playS){ if(playS.org&&playS.org.destroy)playS.org.destroy(); for(const p of (playS.preys||[])) if(p&&p.destroy)p.destroy(); if(playS.player&&playS.player.destroy)playS.player.destroy(); }
  }catch(e){ /* Defensiv: Teardown darf nie den Boot blockieren */ }
  World.clear(world, false);
  MAP.walls=[]; MAP.matterWalls=[];
  FX.length=0; DEBRIS.length=0;
}

function bootSimulation() {
  // ── DOPPEL-BOOT-GUARD ──
  // sim.js bootet sich am Dateiende selbst (readyState ist in einer Next.js
  // Client-Component bereits 'interactive'), UND app/page.tsx ruft
  // bootSimulation() nochmal auf. Zwei Evolver im selben World = Geister-Kraken.
  if (window.__simBooted) {
    // Nicht einfach ignorieren: React StrictMode (next.config.ts reactStrictMode:true)
    // mountet Effekte im Dev-Build DOPPELT, und der Cleanup-Handler in app/page.tsx
    // ruft cancelAnimationFrame(window._simLoopId) auf. Ohne Neustart des Loops wäre
    // die Simulation im Dev-Modus nach dem zweiten Mount eingefroren.
    console.log('bootSimulation(): bereits gebootet — nur den Render-Loop neu gestartet.');
    if (window._simLoopId) cancelAnimationFrame(window._simLoopId);
    lastT = performance.now();
    window._simLoopId = requestAnimationFrame(loop);
    return;
  }
  console.log('sim.js bootSimulation starting...');
  if (!initMatter()) {
    console.warn("Matter not initialized yet, retrying in 100ms...");
    setTimeout(bootSimulation, 100);
    return;
  }
  const canvasElement = document.getElementById('c');
  if (!canvasElement) {
    console.warn("Canvas #c not found in DOM, retrying in 100ms...");
    setTimeout(bootSimulation, 100);
    return;
  }
  try {
    console.log('Calling initial resize...');
    resize();

    // Teardown MUSS vor MAP.build() laufen: World.clear() entfernt auch die
    // Wände. Vorher lag der Aufruf dahinter → die Simulation startete ohne
    // einzige Wand (nichts zum Festhalten = keine Fortbewegung möglich).
    teardownWorld();

    console.log('Building map...');
    MAP.build();
    
    console.log('Initializing grid systems...');
    CHEM.init();
    
    // Attach canvas event listeners after resize() ensures cv exists
    if (cv) {
      console.log('Attaching canvas event listeners...');
      cv.addEventListener('touchstart',e=>{e.preventDefault();for(const t of e.changedTouches){ const lp = toLog(t.clientX, t.clientY); if(Math.hypot(lp.x-JOY.x,lp.y-JOY.y)<JOY.r+22&&TCH.id===-1&&simMode==="PLAY"){TCH.active=true;TCH.id=t.identifier;TCH.dx=0;TCH.dy=0}if(Math.hypot(lp.x-ATK.x,lp.y-ATK.y)<ATK.r+22&&simMode==="PLAY")playS?.player.atk(JOY.x+TCH.dx*180,JOY.y+TCH.dy*180,playS?[playS.org]:[])}},{passive:false});
      cv.addEventListener('touchmove',e=>{e.preventDefault();for(const t of e.changedTouches){if(t.identifier===TCH.id){ const lp = toLog(t.clientX, t.clientY); const dx=(lp.x-JOY.x)/JOY.r,dy=(lp.y-JOY.y)/JOY.r;const l=Math.hypot(dx,dy);TCH.dx=l>1?dx/l:dx;TCH.dy=l>1?dy/l:dy}}},{passive:false});
      cv.addEventListener('touchend',e=>{for(const t of e.changedTouches)if(t.identifier===TCH.id){TCH.active=false;TCH.dx=0;TCH.dy=0;TCH.id=-1}});
      cv.addEventListener("click",e=>{ const lp = toLog(e.clientX, e.clientY); if(simMode==="PLAY"&&playS?.player.alive){playS.player.atk(lp.x,lp.y,[playS.org]);return} if(simMode==="TRAIN")addPrey(1)});
    }
    
    window.__simBooted = true;
    console.log('Initializing evolver with pop size:', popSz);
    evlv=new Evolver(popSz);
    evlv.init();
    
    console.log('Simulation ready, starting loop.');
    const popSel = document.getElementById('popsel');
    if (popSel) popSel.value = popSz;
    const popC = document.getElementById('popc');
    if (popC) popC.textContent = popSz;
    
    setMode('TRAIN');
    const bEvo = document.getElementById('bevo');
    if (bEvo) bEvo.classList.add('on');
    
    if (window.__simState && typeof window.__simState.paused === 'boolean') {
      paused = window.__simState.paused;
      const brun = document.getElementById('brun');
      if (brun) {
        brun.textContent = paused ? '▶ PLAY' : '▶ RUN';
        brun.classList.toggle('on', !paused);
      }
      const paus = document.getElementById('paus');
      if (paus) paus.style.opacity = paused ? '1' : '0';
    }

    layoutTouch();
    setTimeout(()=>flashEp(PHASES[0].name,PHASES[0].sub),600);
    
    lastT = performance.now();
    if (window._simLoopId) cancelAnimationFrame(window._simLoopId);
    window._simLoopId = requestAnimationFrame(loop);
  } catch (e) {
    console.error("BOOT_CRASH:", e);
    const ntf = document.getElementById('ntf');
    if (ntf) {
      ntf.textContent = "BOOT_CRASH: " + e.message;
      ntf.style.opacity = "1";
    }
  }
}

    // Export symbols to window for HTML handlers
    const simControls = {
      setMode, tryPlay, togglePause, setSp, toggleAutoSpeed, doReset,
      toggleEvo, forceMut, addPrey, clearPrey, newGen, nextPhase,
      setPhase, setPopSz, tog, rebuildMap, setMapRegen, exitPlay,
      bootSimulation, layoutTouch
    };
    window.__realHandlers = simControls;
    Object.assign(window, simControls);

    console.log('Attaching window event listeners...');
    window.addEventListener("resize",()=>{resize(); layoutTouch()});
    window.addEventListener('keydown',e=>{KEYS[e.code]=true;if(e.code==='Space'){e.preventDefault();togglePause()}if(e.code==='KeyR')doReset();if(e.code==='BracketRight')setSp(Math.min(200,speed+5));if(e.code==='BracketLeft')setSp(Math.max(1,speed-3));if(e.code==='KeyF')tryPlay();if(e.code==='Escape'&&simMode==='PLAY')exitPlay()});
    window.addEventListener('keyup',e=>KEYS[e.code]=false);

    if (window.__simBooted) {
      console.log('Simulation already booted by page.tsx — self-boot übersprungen.');
    } else if (document.readyState === 'complete' || document.readyState === 'interactive') {
      console.log('Document already ready, booting simulation...');
      bootSimulation();
    } else {
      console.log('Waiting for load event to boot simulation...');
      window.addEventListener('load', bootSimulation);
    }

  })(window);
console.log('sim.js file end reached.');

    
