'use strict';
/**
 * GRIP-AND-PULL Kalibrierung (standalone, nur matter.min.js).
 *
 * Der einzig vorgesehene Antrieb:
 *   Saugnapf an festem Punkt verankern -> Arme einknicken -> Arme werden
 *   kürzer -> Rumpf wird herangezogen.
 *
 * Gelenkmomente drehen/knicken/entspannen NUR. Es wirkt keine Kraft auf den
 * Rumpf. Gemessen wird, welches Gelenkmoment nötig ist, um den Rumpf über eine
 * gegebene Masse zu ziehen, und wie weit er pro Zugzyklus kommt.
 */
const path=require('path');
const M=require(path.join(__dirname,'..','public','matter.min.js'));

const SL=13.5, NSEG=7, SHOULDER_R=24, DT2=277.78;

function build({coreMass, segMass, torque, jointLimit, toneKd, cycles, substeps}){
  const e=M.Engine.create({gravity:{x:0,y:0},positionIterations:12,velocityIterations:10,constraintIterations:8});
  const core=M.Bodies.circle(400,400,18,{mass:coreMass,frictionAir:0.075});
  M.Body.setInertia(core,core.inertia*2.5);
  M.World.add(e.world,core);

  const segs=[];
  for(let i=0;i<NSEG;i++){
    const t=(12-(i/(NSEG-1))*6)*0.99, cl=Math.max(t*1.02,SL);
    const m=segMass[0]+(segMass[1]-segMass[0])*(i/(NSEG-1));
    const b=M.Bodies.rectangle(0,0,cl,t,{mass:m,frictionAir:0.085,chamfer:{radius:Math.min(t*0.48,cl*0.48)}});
    segs.push(b); M.World.add(e.world,b);
  }
  // Pose: gestreckt nach rechts
  const th0=0;
  let jx=400+Math.cos(th0)*SHOULDER_R, jy=400+Math.sin(th0)*SHOULDER_R, th=th0;
  for(let i=0;i<NSEG;i++){
    const ux=Math.cos(th),uy=Math.sin(th);
    const cx=jx+ux*SL*0.5, cy=jy+uy*SL*0.5;
    M.Body.setAngle(segs[i],th); M.Body.setPosition(segs[i],{x:cx,y:cy});
    M.Body.setVelocity(segs[i],{x:0,y:0}); M.Body.setAngularVelocity(segs[i],0);
    jx=cx+ux*SL*0.5; jy=cy+uy*SL*0.5; th+=0;
  }
  M.Body.setVelocity(core,{x:0,y:0}); M.Body.setAngularVelocity(core,0);

  const sync=(c,A,pax,pay,B,pbx,pby)=>{
    const ca=Math.cos(A.angle),sa=Math.sin(A.angle);
    c.pointA.x=pax*ca-pay*sa; c.pointA.y=pax*sa+pay*ca; c.angleA=A.angle;
    if(B){const cb=Math.cos(B.angle),sb=Math.sin(B.angle);
      c.pointB.x=pbx*cb-pby*sb; c.pointB.y=pbx*sb+pby*cb; c.angleB=B.angle;}
    else { c.pointB.x=pbx; c.pointB.y=pby; }
  };
  const mk=(A,pax,pay,B,pbx,pby,stiff)=>{
    const c=M.Constraint.create({bodyA:A,bodyB:B,pointA:{x:pax,y:pay},pointB:{x:pbx,y:pby},
      length:0,stiffness:stiff,damping:0.12,angularStiffness:1});
    sync(c,A,pax,pay,B,pbx,pby); M.World.add(e.world,c); return c;
  };
  mk(core,SHOULDER_R,0,segs[0],-SL/2,0,1);
  for(let i=0;i<NSEG-1;i++) mk(segs[i],SL/2,0,segs[i+1],-SL/2,0,1);

  // Saugnapf-Anker am festen Weltpunkt = aktuelle Spitzenposition
  const tipX=segs[NSEG-1].position.x+Math.cos(segs[NSEG-1].angle)*SL/2;
  const tipY=segs[NSEG-1].position.y+Math.sin(segs[NSEG-1].angle)*SL/2;
  const anchorX=tipX, anchorY=tipY;
  const grip=mk(segs[NSEG-1],SL/2,0,null,anchorX,anchorY,0.9);
  const startDist=Math.hypot(core.position.x-anchorX,core.position.y-anchorY);

  // Zugzyklen: langsam strecken (Anker hält), schnell einknicken (zieht)
  let minDist=startDist, maxPull=0;
  const STEPS=cycles*60;
  for(let s=0;s<STEPS;s++){
    const ph=(s%60)/60*Math.PI*2;
    const pull=Math.pow(0.5+0.5*Math.sin(ph),1.8);          // 0..1, asymmetrisch
    const target=pull*jointLimit;
    for(let sub=0;sub<substeps;sub++){
      // Schulter
      {
        const rel=(segs[0].angle-core.angle);
        let t=Math.atan2(Math.sin(target*0-rel),Math.cos(target*0-rel)); // Schulter bleibt 0
        const av=segs[0].angularVelocity-core.angularVelocity;
        let tau=(1.0*(0-rel)-toneKd*av);
        tau=Math.max(-1,Math.min(1,tau))*torque*2.2*substeps;
        segs[0].torque+=tau; core.torque-=tau;
      }
      for(let i=1;i<NSEG;i++){
        const A=segs[i-1],B=segs[i];
        let rel=B.angle-A.angle; rel=Math.atan2(Math.sin(rel),Math.cos(rel));
        const av=B.angularVelocity-A.angularVelocity;
        let tau=(1.0*(target-rel)-toneKd*av);
        tau=Math.max(-1,Math.min(1,tau))*torque*substeps;
        B.torque+=tau; A.torque-=tau;
      }
      M.Engine.update(e,1000/60/substeps);
    }
    const d=Math.hypot(core.position.x-anchorX,core.position.y-anchorY);
    if(d<minDist)minDist=d;
    if(!Number.isFinite(d)){return {ok:false,reason:'NaN'};}
    maxPull=startDist-minDist;
  }
  return {ok:true,startDist:+startDist.toFixed(1),pull:+maxPull.toFixed(1),
          pct:+(maxPull/startDist*100).toFixed(0),
          endDist:+Math.hypot(core.position.x-anchorX,core.position.y-anchorY).toFixed(1)};
}

const coreMasses=[8,14,20,26,40];
const torques=[0.004,0.012,0.04,0.12,0.4,1.2];
console.log('Wie weit wird der Rumpf an einem verankerten Arm herangezogen?');
console.log('(6 Zugzyklen, Gelenkwinkel-Limit 0.42·pi = 75.6°, Segmentmasse 3.2..1.8)\n');
console.log('  Gelenkmoment |' + coreMasses.map(m=>(' Rumpf m='+m).padStart(15)).join('|'));
console.log('  '+'-'.repeat(14)+'+'+coreMasses.map(()=>'-'.repeat(15)).join('+'));
for(const tq of torques){
  const row=coreMasses.map(cm=>{
    const r=build({coreMass:cm,segMass:[3.2,1.8],torque:tq,jointLimit:Math.PI*0.42,toneKd:0.5,cycles:6,substeps:2});
    return r.ok ? (r.pull.toFixed(0)+'px ('+r.pct+'%)') : 'NaN';
  });
  console.log('  '+String(tq).padEnd(13)+'|'+row.map(c=>c.padStart(15)).join('|'));
}
console.log('\nReferenz: Rumpf-Schulter-Abstand zum Anker ≈ 24 + 7·13.5 = 118.5 px');
console.log('Eingeknickt (6 Gelenke à 75.6°) sollte die Spitze deutlich näher am Rumpf liegen.');
