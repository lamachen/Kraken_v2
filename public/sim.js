
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
const N_CONN=6,N_AUD=8;
const CONN_SEGS=7,CONN_SL=13.5;
// Suction cups at tip, 57%, 28% of tentacle length
const SUCTION_IDX = [CONN_SEGS];
const NI=64,NH=32,NO=27;
const NSW=64*NH+NH+NH*NH+NH+NH*NO+NO;
let NEXT_GROUP = -1;

const PHASES=[
  {id:0,name:'MOTOR PRIMITIVES',  sub:'Grip-and-pull locomotion',           preyN:0, pSpd:0,  dur:100,gpp:12,mut:{r:.18,m:.36}},
  {id:1,name:'ECHOLOCATION',      sub:'Map corridors via echo pulses',      preyN:0, pSpd:0,  dur:90, gpp:10,mut:{r:.14,m:.28}},
  {id:2,name:'CHEMOTAXIS',        sub:'Follow scent trails',                preyN:2, pSpd:.4, dur:80, gpp:8, mut:{r:.12,m:.22}},
  {id:3,name:'ACTIVE PURSUIT',    sub:'Chase and grip prey',                preyN:3, pSpd:1.0,dur:80, gpp:8, mut:{r:.10,m:.18}},
  {id:4,name:'EVASIVE PREY',      sub:'High-speed prey — commit',           preyN:2, pSpd:2.0,dur:80, gpp:8, mut:{r:.09,m:.16}},
  {id:5,name:'FREE EMERGENCE',    sub:'All behaviors consolidate',          preyN:5, pSpd:1.3,dur:100,gpp:99,mut:{r:.07,m:.13}},
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
function angDiff(a,b){let d=a-b;while(d>Math.PI)d-=Math.PI*2;while(d<-Math.PI)d+=Math.PI*2;return d}

// ─── NEURAL NETWORK ─────────────────────────────────────
function nnNew(){const w=new Float32Array(NSW);for(let i=0;i<w.length;i++)w[i]=(rnd()-.5)*1.6;return w}
function nnFwd(w,x){
  const o1=0,b1=NI*NH,o2=b1+NH,b2=o2+NH*NH,o3=b2+NH,b3=o3+NH*NO;
  const h1=new Float32Array(NH);
  for(let j=0;j<NH;j++){let s=w[b1+j];for(let i=0;i<NI;i++)s+=x[i]*w[o1+j*NI+i];h1[j]=Math.tanh(s)}
  const h2=new Float32Array(NH);
  for(let j=0;j<NH;j++){let s=w[b2+j];for(let i=0;i<NH;i++)s+=h1[i]*w[o2+j*NH+i];h2[j]=Math.tanh(s)}
  const out=new Float32Array(NO);
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
      // Subtract thickness from length because chamfer adds it back, 
      // preventing the segments from overlapping at the joints.
      const collisionLength = Math.max(1, options.length - options.thickness);
      this.body = Bodies.rectangle(x, y, collisionLength, options.thickness, {
        mass: m,
        frictionAir: 0.05,
        isStatic: isStatic,
        chamfer: { radius: options.thickness / 2 },
        collisionFilter: { category: category, mask: mask, group: options.group || 0 },
        ...options
      });
    } else {
      this.body = Bodies.circle(x, y, cr, {
        mass: m,
        frictionAir: 0.05,
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
  force(fx,fy){
    const maxF = 350;
    const cfx = clamp(fx, -maxF, maxF);
    const cfy = clamp(fy, -maxF, maxF);
    Body.applyForce(this.body, this.body.position, {x: cfx * 0.0006, y: cfy * 0.0006});
  }
  step() {
    const maxV = 11;
    const v = this.body.velocity;
    const spd = Math.hypot(v.x, v.y);
    if(spd > maxV) {
      Body.setVelocity(this.body, { x: (v.x / spd) * maxV, y: (v.y / spd) * maxV });
    }
    const av = this.body.angularVelocity;
    if(Math.abs(av) > 0.3) {
      Body.setAngularVelocity(this.body, Math.sign(av) * 0.3);
    }
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
  constructor(si){this.si=si;this.active=false;this.gripped=false;this.gx=0;this.gy=0;this.gTarget=null;this.gTime=0;this.constraint=null;}
  tryGrip(pt,map,preys){
    if(this.gripped)return;
    let target = null;
    const tipLen = CONN_SL / 2;
    const angle = pt.body.angle;
    // Calculate global tip position for distance checks
    const tx = pt.x + Math.cos(angle) * tipLen;
    const ty = pt.y + Math.sin(angle) * tipLen;

    // Check preys first
    for(const pr of preys){if(Math.hypot(tx-pr.x,ty-pr.y)<pr.r+12){target=pr; break;}}
    
    // If no prey, must be near a wall to grip
    if(!target && !map.wallCollide(tx, ty, 8)) return;
    
    this.gripped=true;
    this.gTarget=target;
    this.gx=target?0:tx;
    this.gy=target?0:ty;
    this.gTime=0;
    
    this.constraint = Constraint.create({
      bodyA: pt.body,
      // PointA is the offset from body center. For a capsule, tip is at +length/2
      pointA: { x: tipLen, y: 0 }, 
      bodyB: target ? target.body : null,
      pointB: target ? {x:0,y:0} : {x: tx, y: ty},
      stiffness: 0.22,
      length: 2,
      damping: 0.25
    });
    World.add(world, this.constraint);
  }
  release(){
    if(this.constraint) World.remove(world, this.constraint);
    this.constraint=null; this.gripped=false; this.gTarget=null; this.gTime=0;
  }
  applyConstraint(pt,orgMass){ 
    if(!this.gripped)return false;
    this.gTime += DT;
    if(this.gTime > 2.2) { this.release(); return false; }
    // Breaking force check from TIP position
    const tipLen = CONN_SL / 2;
    const tpos = { x: pt.x + Math.cos(pt.body.angle)*tipLen, y: pt.y + Math.sin(pt.body.angle)*tipLen };
    const bl = this.gTarget ? Vector.magnitude(Vector.sub(tpos, this.gTarget.body.position)) : (this.constraint ? Vector.magnitude(Vector.sub(tpos, this.constraint.pointB)) : 999);
    if(bl > 26) { this.release(); return false; }
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
    const ox = Math.cos(relAng)*24, oy = Math.sin(relAng)*24;
    const startX = parentBody.position.x + ox, startY = parentBody.position.y + oy;

    for(let i=0;i<CONN_SEGS;i++){
      const m=lerp(2, 0.5, i/CONN_SEGS);
      const thickness = lerp(12, 6, i/CONN_SEGS) * 0.99;
      // mask: 0 means NO collision with anything (as requested: "entferne sämtliche collider bis auf körper")
      const mask = 0; 
      
      const wa = relAng;
      const distFromCenter = 24 + i * CONN_SL; 
      let startX = parentBody.position.x + Math.cos(wa) * distFromCenter; 
      let startY = parentBody.position.y + Math.sin(wa) * distFromCenter;
      
      const p = new Pt(startX, startY, m, thickness/2, false, { 
        shape: 'capsule',
        length: CONN_SL,
        thickness: thickness,
        group: group, 
        mask: mask 
      });
      // Set the initial angle of the capsule to match the radial direction
      Body.setAngle(p.body, wa);
      this.pts.push(p);
    }
    
    this.hp=new Float32Array(CONN_SEGS).fill(100);
    this.active=CONN_SEGS - 1;this.alive=true;
    this.nnAng=[0,0,0];this.worldRestAng=relAng;this.col='#00ffb3';
    this.cups=[new SuctionCup(6)]; // Only one suction cup at the end for clarity
    this.suctionOn=false;

    this.constraints = [];
    
    // Anchor start of pts[0] to CORE
    const shoulderR = 24; 
    const ax = Math.cos(relAng)*shoulderR, ay = Math.sin(relAng)*shoulderR;
    this.anchor = Constraint.create({
      bodyA: parentBody, bodyB: this.pts[0].body,
      pointA: { x: ax, y: ay }, pointB: { x: -CONN_SL/2, y: 0 },
      stiffness: 0.9, length: 0
    });
    World.add(world, this.anchor);

    for(let i=0;i<this.pts.length-1;i++) {
      const c = Constraint.create({
        bodyA: this.pts[i].body, bodyB: this.pts[i+1].body,
        pointA: { x: CONN_SL/2, y: 0 }, pointB: { x: -CONN_SL/2, y: 0 },
        length: 0, stiffness: 0.95
      });
      this.constraints.push(c);
      World.add(world, c);
    }
  }
  destroy() {
    for(const p of this.pts) World.remove(world, p.body);
    for(const c of this.constraints) World.remove(world, c);
    World.remove(world, this.anchor);
    for(const cup of this.cups) cup.release();
  }
  initPos(bx, by, orgAng) {
    const wa = orgAng + this.relAng;
    this.worldRestAng = wa;
    
    // Start slightly further out to avoid core overlap
    let currentX = bx + Math.cos(wa) * 32;
    let startY = by + Math.sin(wa) * 32;
    let currentAng = wa;

    for(let i=0; i<this.pts.length; i++) {
        this.pts[i].x = currentX;
        this.pts[i].y = startY;
        Body.setAngle(this.pts[i].body, currentAng);
        
        // Gentle curl instead of tight shell to prevent self-collision on spawn
        currentAng += 0.35; 
        currentX += Math.cos(currentAng) * CONN_SL;
        startY += Math.sin(currentAng) * CONN_SL;
    }
  }
  get tip(){return this.pts[Math.min(this.active,this.pts.length-1)]}
  get tipContact(){return clamp(this.tip.spd()*12,0,1)}
  get tipCupGripped(){return this.cups[0]&&this.cups[0].gripped}

  setTorques(t1,t2,t3){
    this.nnTorques=[t1,t2,t3];
  }
  setBase(bx,by,orgAng){
    const wa=orgAng+this.relAng;this.worldRestAng=wa;
  }

  tick(map,preys,orgMass,bodyX,bodyY){
    if(!this.active){this.alive=false;return}
    const n = this.active + 1;

    // 1. Shoulder Joint (Base to Segment 1)
    if(n > 1) {
      const aBase = Math.atan2(this.pts[1].y - this.pts[0].y, this.pts[1].x - this.pts[0].x);
      let baseAngle = angDiff(aBase, this.worldRestAng);
      
      let shoulderTorque = clamp(this.nnTorques[0], -1, 1) * 220; 
      
      const isAI = typeof OVR !== 'undefined' ? OVR.ai : true;
      if (isAI) {
        const shoulderLimit = Math.PI * 0.55;
        if(baseAngle > shoulderLimit) shoulderTorque += (shoulderLimit - baseAngle) * 500;
        if(baseAngle < -shoulderLimit) shoulderTorque += (-shoulderLimit - baseAngle) * 500;
      } else {
        shoulderTorque = 0;
      }
      shoulderTorque = clamp(shoulderTorque, -320, 320);
      
      const nxBase = -Math.sin(aBase), nyBase = Math.cos(aBase);
      this.pts[1].force(nxBase * shoulderTorque, nyBase * shoulderTorque);
      this.pts[0].force(-nxBase * shoulderTorque, -nyBase * shoulderTorque);
    }

    // 2. Elbow and Wrist Joints
    for(let i=1;i<n-1;i++){
      const pr=this.pts[i-1],cu=this.pts[i],nx2=this.pts[i+1];
      if(!pr || !cu || !nx2) continue;
      const a1=Math.atan2(cu.y-pr.y,cu.x-pr.x);
      const a2=Math.atan2(nx2.y-cu.y,nx2.x-cu.x);
      let angle=angDiff(a2,a1);
      
      let aiTorque=0;
      const isAI = typeof OVR !== 'undefined' ? OVR.ai : true;
      if (isAI) {
        if(i===1 || i===2) aiTorque = clamp(this.nnTorques[1], -1, 1) * 160;
        else aiTorque = clamp(this.nnTorques[2], -1, 1) * 110;
        
        let limitTorque=0;
        const limit=Math.PI/2;
        if(angle>limit)limitTorque=(limit-angle)*400;
        if(angle<-limit)limitTorque=(-limit-angle)*400;
        
        const totalTorque=clamp(aiTorque+limitTorque, -250, 250);
        const nx=-Math.sin(a2),ny=Math.cos(a2);
        nx2.force(nx*totalTorque,ny*totalTorque);
        const px=-Math.sin(a1),py=Math.cos(a1);
        pr.force(-px*totalTorque,-py*totalTorque);
      }
    }

    for(let ci=0;ci<this.cups.length;ci++){
      const cup=this.cups[ci];
      const si=Math.min(cup.si,n-1);const pt=this.pts[si];
      if(this.suctionOn&&!cup.gripped)cup.tryGrip(pt,map,preys);
      else if(!this.suctionOn&&cup.gripped)cup.release();
      if(cup.gripped) cup.applyConstraint(pt, orgMass);
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
    this.map=map;this.spd=spd;this.r=10;this.seed=rnd()*100;this.panic=0;this._st=0;this.mass=1.5;
    this.body = Bodies.circle(x, y, this.r, {
      mass: this.mass,
      frictionAir: 0.05,
      collisionFilter: { category: COL_PREY, mask: COL_WALL | COL_CORE | COL_TENTACLE }
    });
    World.add(world, this.body);
  }
  get x(){return this.body.position.x}
  get y(){return this.body.position.y}
  set x(v){Body.setPosition(this.body,{x:v,y:this.body.position.y})}
  set y(v){Body.setPosition(this.body,{x:this.body.position.x,y:v})}
  tick(preds){
    let fx=0,fy=0;
    for(const p of preds){const dx=this.x-p.x,dy=this.y-p.y,d=Math.hypot(dx,dy);if(d<1||d>320)continue;this.panic=Math.min(1,this.panic+.045);const s=(0.005+this.panic*0.01)/d;fx+=dx*s;fy+=dy*s}
    this.panic=Math.max(0,this.panic-.012);
    Body.applyForce(this.body, this.body.position, {x: fx + (rnd()-.5)*0.001, y: fy + (rnd()-.5)*0.001});
    const mv = Vector.magnitude(this.body.velocity);
    const ms = this.spd*(this.panic>.3?5:2.2);
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

    // PERFECT RIGID BODY PHYSICS
    this.pt = new Pt(x, y, 12, 18, false, { 
      category: COL_CORE, 
      mask: COL_WALL | COL_PREY,
      group: this.group // Share the same negative group as tentacles to avoid self-stuckness
    });
    this.constraints = [];

    // Body components - Tentacles anchored directly to coreBody
    this.conns=CONN_ANGS.map((a,i)=>{const c=new Connectarcle(a, this.pt.body, this.group);c.col=this.col;c.initPos(this.x,this.y,this.ang);return c;});
    this.auds=AUD_ANGS.map(a=>new Auditarcle(a));
    // Echolocation
    this._echoT=rng(.5,1.5);this._echoInterval=rng(1.0,2.2);this._echoCooldown=0;
    // Fitness metrics (comprehensive)
      this.fitness=0;this.hits=0;this.wallHits=0;this.chemSensed=0;this.stepCount=0;
    this.gripCount=0;this.echoResponses=0;
    // Locomotion quality tracking
    this.gripMoveDist=0;      // total distance moved while gripped (real locomotion)
    this.gripMoveCorr=0;      // ticks body moved meaningfully while gripped
    this.freeMoveDist=0;      // distance moved WITHOUT grip (penalized passive drift)
    this.angularAccum=0;      // total rotation (spinning penalty)
    // Exploration
    this.visited=new Uint8Array(28*20);
    this.spawnX=x;this.spawnY=y;
    this.maxDisplacement=0;this.totalDisplacement=0;
    this._preyMinDist=9999;this.idleTicks=0;this.effectiveIdlePenalty=0;this.energySpent=0; this.idlePenalty=0; this.wallHits=0;
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
    const x=new Float32Array(NI);let i=0;
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
    // [27] Surface pressure
    x[i++]=this.surfPress;
    // [28] Body-wall pressure
    x[i++]=this.bodyPress;
    // [29] Own speed
    x[i++]=clamp(Math.hypot(this.vx,this.vy)/4,0,1);
    // [30] Angular velocity
    x[i++]=clamp(this.av/3,-1,1);
    // [31] Mean tip contact
    let tc=0;for(const c of this.conns)tc+=c.alive?c.tipContact:0;
    x[i++]=clamp(tc/N_CONN,0,1);
    // [32] Total grips active
    let gc=0;for(const c of this.conns)for(const s of c.cups)gc+=s.gripped?1:0;
    x[i++]=clamp(gc/12,0,1);
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
    for(let k=0;k<NO;k++){ if(i<NI) x[i++]=this.prevOut[k]; }
    this.lIn=x;return x;
  }

  tick(preys){this.age=(this.age||0)+DT;
    this.x = this.pt.x; this.y = this.pt.y;
    this.vx = this.pt.body.velocity.x; this.vy = this.pt.body.velocity.y;
    this.ang = this.pt.body.angle; this.av = this.pt.body.angularVelocity;
    const mv = this.pt.spd();
    // ── ECHOLOCATION PULSE TIMER ──
    

    const inp=this.buildInputs(preys);
    const{out}=nnFwd(this.w,inp);
    if(!OVR.ai) out.fill(0);
    this.lOut=out;this.prevOut.set(out);
    
    if(this._echoCooldown > 0) this._echoCooldown -= DT;
    if(out[26] > 0.5 && this._echoCooldown <= 0) {
      this.emitPulse();
      this._echoCooldown = 0.5;
    }

    
    

    // Tentacle control
    let gripNow=0;

    for(let k=0;k<N_CONN;k++){
      const c=this.conns[k];if(!c.alive)continue;
      const baseT1 = out[2+k*4+0]||0;
      const baseT2 = out[2+k*4+1]||0;
      const baseT3 = out[2+k*4+2]||0;
      let suctionOn = (out[2+k*4+3]||0) > 0.1;
      if (!OVR.ai) suctionOn = false;

      let eMult = 1.0;
      if (this.energy < 0.2) eMult = clamp(this.energy * 5, 0, 1);
      if (this.energy < 0.05) suctionOn = false;

      // Energy calculation directly impacts cost! If tired, they expend less.
      const effort = (Math.abs(baseT1) + Math.abs(baseT2) + Math.abs(baseT3)) / 3.0 * eMult;
      const eCost = (effort * 0.0008) + (suctionOn ? 0.0002 : 0);
      this.energySpent += eCost * 10.0;
      this.energy -= eCost;
      
      c.setTorques(baseT1 * eMult, baseT2 * eMult, baseT3 * eMult);
      c.suctionOn=suctionOn;
      c.setBase(this.x,this.y,this.ang);
      c.tick(this.map,preys,this.mass,this.x,this.y);
      if(c.cups.some(s=>s.gripped)){this.gripCount++;gripNow++}
    }

    
    // ── MATTER.JS PHYSICS ──
    // (Constraints & positions updated by engine)
    
    // ── LOCOMOTION QUALITY TRACKING ──
    if(gripNow>0){
      this.gripMoveDist+=mv;
      if(mv>.12)this.gripMoveCorr++;
    }else{
      if(mv>.3)this.freeMoveDist+=mv; // body drifting without grip = penalized
    }

    const hx=false, hy=false; // removed manual walls
    this.bodyPress*=0.83;

    // Displacement tracking
    const actualMv=Math.hypot(this.x-(this.px||this.x),this.y-(this.py||this.y));
    this.px=this.x;this.py=this.y;
    if(actualMv<.15)this.idleTicks++;else this.idleTicks=0;
    if(this.idleTicks>30)this.effectiveIdlePenalty+=.03;
    this.maxDisplacement=Math.max(this.maxDisplacement,Math.hypot(this.x-this.spawnX,this.y-this.spawnY));
    this.totalDisplacement+=mv;

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
    
    // Passive recovery is high, but active drain (handled in tentacle loop) is severe. This forces burst movements.
    this.energy=clamp(this.energy - mv*.0002 - Math.abs(this.av)*.0002 + .002, 0, 1);

    this.satiation=clamp(this.satiation-.0002,0,1);
    this.discomfort=clamp(this.discomfort+((hx||hy)?.06:-.004),0,1);
    this.arousal=lerp(this.arousal,mv*.2+Math.abs(this.av)*.14,.05);
    this.fitness+=this.satiation*.36*DT+this.energy*.08*DT;
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

  score(phId){
    const expl = this.visited.reduce((s,v)=>s+v,0)/560;
    const echoBonus = this.echoResponses * 0.1;
    const gripLoco = this.gripMoveDist * 3.5; // High reward for moving while gripped
    const dispS = (this.maxDisplacement||0) * 0.5 + (this.totalDisplacement||0) * 0.02;
    const driftPenalty = this.freeMoveDist * 0.2;
    const wallP = this.wallHits * 0.5;
    const idleP = this.effectiveIdlePenalty * 5.0; // Strong penalty for doing nothing
    
    // ENERGY PENALTY:
    // This is the core of the efficiency learning.
    // If energySpent is high but gripLoco is low, the score will be negative.
    const energyPenalty = this.energySpent * 0.6;
    
    // If they are spending energy, they are at least trying. Reduce idle penalty so 'Try and fail' is better than 'Do nothing'.
    const effectiveIdleP = Math.max(0, idleP - this.energySpent * 1.5);

    switch(phId){
      case 0: // Locomotion focus
        return gripLoco + dispS + expl * 2 - energyPenalty - driftPenalty - wallP - effectiveIdleP;
      case 1: // Echo focus
        return gripLoco + dispS + echoBonus * 15 + expl * 5 - energyPenalty - driftPenalty - wallP - effectiveIdleP;
      case 2: // Hunting focus
        const preyQ = this.hits * 15.0 + Math.max(0,(500-(this._preyMinDist||500))*0.1);
        return this.chemSensed * 2.0 + preyQ + gripLoco + expl * 5 - energyPenalty - driftPenalty - wallP - effectiveIdleP;
      case 3:
      case 4:
      default:
        return this.hits * 25.0 + this.satiation * 20.0 + gripLoco * 2.0 - energyPenalty - wallP - effectiveIdleP;
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

class Evolver{
  constructor(popSz){this.pop=popSz;this.orgs=[];this.preys=[];this.gen=0;this.phIdx=0;this.phGenCnt=0;this.mapRegenCnt=0;this.genT=0;this.bestFit=0;this.bestW=null;this.fitHist=[];this.log=[]}
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
    this.fitHist.push(bf);if(this.fitHist.length>80)this.fitHist.shift();
    this.log.unshift(`G${this.gen} P${this.phIdx+1}: F=${bf.toFixed(1)} H=${o0.hits} GL=${o0.gripMoveDist.toFixed(0)} E=${o0.echoResponses}`);
    if(this.log.length>14)this.log.pop();
    this.gen++;this.phGenCnt++;this.mapRegenCnt++;
    if(this.mapRegenCnt>=mapRegenInterval){this.mapRegenCnt=0;MAP.build();CHEM.init();WAVES.w0&&WAVES.w0.fill(0);WAVES.w1&&WAVES.w1.fill(0);flashEp('MAP REGENERATED','adapting to new layout...')}
    const gpp=MOB?Math.max(3,this.phase.gpp-2):this.phase.gpp;
    if(this.phGenCnt>=gpp&&this.phIdx<PHASES.length-1){this.phIdx++;this.phGenCnt=0;flashEp(this.phase.name,this.phase.sub);document.getElementById('psel').value=this.phIdx}
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
    this.stepCount++;
    if(this.stepCount % 12 === 0) CHEM.diffuse();
    Engine.update(engine, DT * 1000);
    tickSounds(MAP);CHEM.decay();MAP.tick();
    for(const p of this.preys) {
      if(p) p.tick(this.orgs);
    }
    for(const o of this.orgs){
      if(!o) continue;
      o.tick(this.preys);
      for(const p of this.preys){
        if(!p) continue;
        for(const c of o.conns){if(!c.alive)continue;const tip=c.tip;if(tip && Math.hypot(tip.x-p.x,tip.y-p.y)<p.r+8&&tip.spd()>1.0){p.vx+=tip.vx()*2;p.vy+=tip.vy()*2;p.panic=1;o.onHit()}}
      }
    }
    tickFX();this.genT+=DT;
    if(this.genT>=this.phase.dur)this._evo();
  }
  getBest(){return this.orgs.reduce((b,o)=>o.fitness>b.fitness?o:b,this.orgs[0])}
  setPhase(idx){this.phIdx=clamp(idx,0,PHASES.length-1);this.phGenCnt=0;this._ng();flashEp(this.phase.name,this.phase.sub)}
}

class PlaySession{
  constructor(w){
    const sp=MAP.randSpawn(24);
    this.org=new Organism(sp.x,sp.y,w,0,MAP);
    this.preys=[];
    for(let i=0;i<5;i++){const psp=MAP.randSpawn(14);this.preys.push(new Prey(psp.x,psp.y,MAP,1.1))}
    this.player=new Player(MAP);
  }
  step(){ this.stepCount = (this.stepCount||0) + 1; if(this.stepCount % 12 === 0) CHEM.diffuse(); Engine.update(engine, DT * 1000); tickSounds(MAP); CHEM.decay(); MAP.tick();
    for(const p of this.preys) if(p) p.tick([this.org,this.player]);
    if(this.org) {
      for(const c of this.org.conns){
        if(!c || !c.alive)continue;
        for(const p of this.preys){
          if(!p) continue;
          const tip=c.tip;
          if(tip && Math.hypot(tip.x-p.x,tip.y-p.y)<p.r+8&&tip.spd()>1.0){p.vx+=tip.vx()*2.2;p.vy+=tip.vy()*2.2;p.panic=1;this.org.onHit()}
        }
      }
    }
    if(this.preys.length<4){const psp=MAP.randSpawn(14);this.preys.push(new Prey(psp.x,psp.y,MAP,1.1))}
    if(this.org) this.org.tick(this.preys);
    if(this.player) this.player.tick([this.org]);
    tickFX();
  }
  draw(){MAP.draw();drawSounds();CHEM.draw();for(const p of this.preys)p.draw();this.org.draw(1);this.player.draw();MAP.applyLighting()}
}

// ─── GLOBAL STATE ─────────────────────────────────────────
let evlv=null,playS=null,simMode='TRAIN';
let paused=false,speed=1,autoEvo=true,popSz=MOB?4:6,mapRegenInterval=5;
const OVR={ch:true,sw:false,lt:false,col:false,ai:true,noCol:false};
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
function doReset(){CHEM.init();WAVES.w0&&WAVES.w0.fill(0);WAVES.w1&&WAVES.w1.fill(0);FX.length=0; if(evlv&&evlv.preys)for(const p of evlv.preys)p.destroy();if(playS&&playS.preys)for(const p of playS.preys)p.destroy();World.clear(world, false); MAP.build();evlv=new Evolver(popSz);evlv.init();playS=null;if(simMode==='PLAY')setMode('TRAIN');notify('RESET')}
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
  const mask = isNoCol ? 0 : (COL_WALL | COL_PREY | COL_TENTACLE);
  const targets = [];
  if(evlv) targets.push(...evlv.orgs);
  if(playS && playS.org) targets.push(playS.org);
  
  for(const o of targets) {
    if(!o || !o.pt) continue;
    // Essential: set isSensor to true to completely bypass physical resolving
    o.pt.body.isSensor = isNoCol;
    o.pt.body.collisionFilter.mask = mask;
    
    for(const c of o.conns) {
      for(const p of c.pts) {
        p.body.isSensor = true; // Tentacles are always sensors currently, but enforced here
        p.body.collisionFilter.mask = 0;
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
function bootSimulation() {
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

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      console.log('Document already ready, booting simulation...');
      bootSimulation();
    } else {
      console.log('Waiting for load event to boot simulation...');
      window.addEventListener('load', bootSimulation);
    }

  })(window);
console.log('sim.js file end reached.');

    
