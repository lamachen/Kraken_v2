'use strict';
/**
 * Sweep für Grip-and-pull: welches Zusammenspiel aus Grip-Tempogate,
 * Muskelmoment und Rumpfmasse ergibt den meisten Vortrieb pro Inchworm-Zyklus?
 * Gemessen wird TEST 4 aus tools/headless.js (gripPullBest = px in Zielrichtung).
 *
 *   node tools/tune-grip.js
 */
const fs=require('fs'), path=require('path'), {spawnSync}=require('child_process');
const ROOT=path.resolve(__dirname,'..');
const base=fs.readFileSync(path.join(ROOT,'public/sim.js'),'utf8');
const H=path.join(ROOT,'tools','headless.js');

const GATE=[2.4,4.5,8.0];
const MMUL=[1,3,7];            // Multiplikator auf MUSCLE_TMAX und SHOULDER_TMAX
const CORE=[26,16,10];

const rows=[];
for(const gate of GATE) for(const mm of MMUL) for(const cm of CORE){
  let src=base
    .replace(/if\(Vector\.magnitude\(pt\.body\.velocity\) > [0-9.]+\) \{ this\.cd=0\.05; return; \}/,
             'if(Vector.magnitude(pt.body.velocity) > '+gate+') { this.cd=0.05; return; }')
    .replace(/const MUSCLE_TMAX= [0-9.]+;/, 'const MUSCLE_TMAX= '+(0.0045*mm).toFixed(5)+';')
    .replace(/const SHOULDER_TMAX = [0-9.]+;/, 'const SHOULDER_TMAX = '+(0.014*mm).toFixed(5)+';')
    .replace('this.pt = new Pt(x, y, 26, 18, false, {', 'this.pt = new Pt(x, y, '+cm+', 18, false, {');
  if(src===base) { console.log('!! unwirksam', gate, mm, cm); continue; }
  fs.writeFileSync(path.join(ROOT,'tools','.gripsweep.js'),src);
  const r=spawnSync('node',[H,'--silent','--quick','--gens','1','--measure-steps','20','--boot-steps','20','--out','gs.json'],
    {env:Object.assign({},process.env,{SIM_PATH:path.join(ROOT,'tools','.gripsweep.js')}),encoding:'utf8',timeout:600000});
  let j=null;
  try{ j=JSON.parse(fs.readFileSync(path.join(ROOT,'tools','gs.json'),'utf8')); }catch(e){}
  if(!j||!j.gripPull){ console.log('  gate='+gate+' mm='+mm+' core='+cm+' → keine Messung'); continue; }
  const along=j.gripPull.map(g=>g.along);
  const mean=along.reduce((a,b)=>a+b,0)/along.length;
  const anch=j.gripPull.reduce((a,g)=>a+g.anchoredPct,0)/j.gripPull.length;
  rows.push({gate,mm,cm,best:j.gripPullBest,mean:+mean.toFixed(1),anchoredPct:+(anch*100).toFixed(1)});
  process.stdout.write('  gate='+String(gate).padEnd(4)+' muskel×'+String(mm).padEnd(3)+' rumpf='+String(cm).padEnd(3)+
    ' | Ø Vortrieb='+mean.toFixed(0).padStart(5)+'px  best='+String(j.gripPullBest.toFixed(0)).padStart(4)+'px'+
    '  verankert='+(anch*100).toFixed(0).padStart(3)+'%\n');
}
console.log('\n── Sortiert nach Ø Vortrieb über alle 3 Zielrichtungen ──');
rows.sort((a,b)=>b.mean-a.mean);
rows.slice(0,8).forEach((r,i)=>console.log('  '+(i+1)+'. gate='+r.gate+' muskel×'+r.mm+' rumpfmasse='+r.cm+
  '   →  Ø '+r.mean+'px  best '+r.best.toFixed(0)+'px  verankert '+r.anchoredPct+'%'));
fs.writeFileSync(path.join(ROOT,'tools','gripsweep-result.json'),JSON.stringify(rows,null,2));
