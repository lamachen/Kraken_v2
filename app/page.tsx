'use client';
import React, { useEffect, useRef } from 'react';

// Pre-define handlers on window immediately when client evaluation starts
if (typeof window !== 'undefined') {
  const simState = ((window as any).__simState = (window as any).__simState || { paused: false });
  const fns = [
    'setMode', 'tryPlay', 'togglePause', 'setSp', 'toggleAutoSpeed', 'doReset',
    'toggleEvo', 'forceMut', 'addPrey', 'clearPrey', 'newGen', 'nextPhase',
    'setPhase', 'setPopSz', 'tog', 'rebuildMap', 'setMapRegen', 'exitPlay',
    'bootSimulation', 'layoutTouch'
  ];
  fns.forEach((fn) => {
    if (typeof (window as any)[fn] !== 'function') {
      (window as any)[fn] = (...args: any[]) => {
        if ((window as any).__realHandlers && typeof (window as any).__realHandlers[fn] === 'function') {
          return (window as any).__realHandlers[fn](...args);
        }
        if (fn === 'togglePause') {
          simState.paused = !simState.paused;
          const brun = document.getElementById('brun');
          if (brun) {
            brun.textContent = simState.paused ? '▶ PLAY' : '▶ RUN';
            brun.classList.toggle('on', !simState.paused);
          }
          const paus = document.getElementById('paus');
          if (paus) paus.style.opacity = simState.paused ? '1' : '0';
        }
      };
    }
  });
}

/**
 * GitHub-Pages liegt unter https://<user>.github.io/<repo>/ — Assets müssen
 * deshalb mit basePath geladen werden. NEXT_PUBLIC_BASE_PATH wird von Next zur
 * Buildzeit inline ersetzt (vom Workflow gesetzt), im AI-Studio-Build ist es
 * leer und die Pfade bleiben wurzelrelativ wie bisher.
 *
 * Wichtig: Next rewritten MANUELL erzeugte <script src> nicht. Ohne dieses
 * Präfix würde /sim.js auf Pages 404 liefern und die Simulation nie starten.
 */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || '';

export default function SimulationPage() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let isCancelled = false;

    const init = async () => {
      try {
        const loadScript = (src: string, id: string): Promise<void> => {
          return new Promise((resolve, reject) => {
            const existing = document.getElementById(id);
            if (existing) {
              resolve();
              return;
            }
            const script = document.createElement('script');
            script.id = id;
            script.src = src;
            script.async = false;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.body.appendChild(script);
          });
        };

        // 1. Ensure Matter library is loaded and ready
        if (!(window as any).__MTR__ || !(window as any).__MTR__.Engine) {
          try {
            await loadScript(BASE + '/matter.min.js', 'matter-lib-script');
            if ((window as any).Matter && (window as any).Matter.Engine) {
              (window as any).__MTR__ = (window as any).Matter;
              try { if ((window as any).Matter) (window as any).Matter = undefined; } catch (e) {}
            }
          } catch (e) {
            console.warn('Falling back to dynamic import for Matter:', e);
            const MLib = await import('matter-js');
            let mObj = (MLib as any).default || MLib;
            if (mObj && !mObj.Engine && (mObj as any).default && (mObj as any).default.Engine) {
              mObj = (mObj as any).default;
            }
            (window as any).__MTR__ = mObj;
            try { if ((window as any).Matter) (window as any).Matter = undefined; } catch (err) {}
          }
        }

        if (isCancelled) return;

        // 2. Load and boot simulation
        // sim.js bootet sich am Dateiende selbst, sobald document.readyState
        // 'interactive'/'complete' ist — was in einer Client-Component praktisch
        // immer der Fall ist. Dieser Aufruf ist deshalb der ZWEITE Boot.
        // sim.js hat dafür einen __simBooted-Guard; vorher entstanden zwei
        // Evolver im selben Matter-World (gemessen: 527 statt 269 Bodies, also
        // 6 unsichtbare Geister-Kraken, die nie getickt aber immer kollidiert sind).
        await loadScript(BASE + '/sim.js?v=' + Date.now(), 'sim-engine-script');
        if (typeof (window as any).bootSimulation === 'function') {
          (window as any).bootSimulation();
        }
      } catch (err) {
        console.error('Simulation init failed:', err);
      }
    };

    init();

    return () => {
      isCancelled = true;
      if ((window as any)._simLoopId) cancelAnimationFrame((window as any)._simLoopId);
    };
  }, []);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
@import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@300;400&display=swap');
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:'Share Tech Mono',monospace;color:#3affa8}
canvas{position:fixed;inset:0;display:block;z-index:0}
#hdr{position:fixed;top:0;left:0;right:0;height:60px;z-index:50;background:rgba(0,4,6,.97);border-bottom:1px solid #0f32;display:flex;align-items:stretch;backdrop-filter:blur(12px)}
.mtab{height:100%;padding:0 24px;display:flex;align-items:center;gap:10px;font:11px/1 'Orbitron',monospace;letter-spacing:3px;cursor:pointer;border-right:1px solid #0f21;color:#0f68;transition:all .2s;user-select:none}
.mtab:hover{color:#0fb;background:rgba(0,255,179,0.05)}.mtab.on{color:#00ffb3;border-bottom:3px solid #00ffb3;background:rgba(0,255,179,0.08)}
.pip{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor;animation:pp 2s infinite}
@keyframes pp{0%,100%{opacity:.3}50%{opacity:1}}
#hm{flex:1;display:flex;align-items:center;justify-content:center;gap:40px}
.hv{font:clamp(16px,2.2vw,22px)/1 'Orbitron',monospace;color:#00ffb3;letter-spacing:2px;text-shadow:0 0 10px rgba(0,255,179,0.3)}
.hl{font-size:10px;color:#88ffcc;letter-spacing:2px;margin-top:4px;opacity:0.8}
#gbar{width:clamp(100px,15vw,250px);height:6px;background:#0f21;border-radius:3px;overflow:hidden;margin-top:6px}
#gbf{height:100%;background:#00ffb3;box-shadow:0 0 10px #00ffb3;border-radius:3px;transition:width .5s}
#plbl{font-size:9px;color:#00ffb3;letter-spacing:3px;border:1.5px solid #0f83;border-radius:12px;padding:4px 14px;background:rgba(0,255,179,.06);margin-bottom:4px;white-space:nowrap}
#hr{display:flex;align-items:center;gap:12px;padding:0 20px;border-left:1px solid #0f21}
.b{background:rgba(0,12,8,.85);border:1.5px solid #0f35;color:#0f8;font:11px/1 'Share Tech Mono',monospace;letter-spacing:1.5px;padding:8px 16px;cursor:pointer;border-radius:4px;transition:all .15s;white-space:nowrap;min-height:36px;display:flex;align-items:center;justify-content:center}
.b:hover{border-color:#0f8;background:rgba(0,255,128,0.1);box-shadow:0 0 12px #0f84}.b.on{border-color:#00ffb3;color:#00ffb3;background:rgba(0,255,179,0.15)}
.b.r{border-color:#f445;color:#f44}.b.r:hover{background:rgba(255,0,0,0.15);border-color:#f44}
.b.a{border-color:#fa45;color:#fa0}
#sr{-webkit-appearance:none;height:5px;background:#0f21;border-radius:3px;cursor:pointer;width:80px}
#sr::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:#00ffb3;box-shadow:0 0 8px #00ffb3}
#sv{color:#88ffcc;font-size:12px;min-width:35px;text-align:center;font-weight:bold}
#info{position:fixed;top:75px;right:15px;width:240px;z-index:40;display:flex;flex-direction:column;gap:10px;pointer-events:none}
.ic{background:rgba(0,8,12,.96);border:1px solid #0f33;border-radius:6px;padding:12px 15px;backdrop-filter:blur(15px);box-shadow:0 10px 30px rgba(0,0,0,0.5)}
.ih{font:10px/1 'Orbitron',monospace;letter-spacing:3px;color:#88ffcc;border-bottom:1px solid #0f22;padding-bottom:8px;margin-bottom:12px;display:flex;justify-content:space-between}
.vr{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.vn{font-size:9px;color:#88ffcc;width:85px;text-align:right;flex-shrink:0;opacity:0.9}
.vbx{flex:1;height:6px;background:#04090a;border:1px solid #0f21;border-radius:2px;overflow:hidden}
.vbf{height:100%;border-radius:2px;transition:width .12s}
.nr{display:flex;gap:4px;margin:5px 0;flex-wrap:wrap}
.nn{width:18px;height:18px;border-radius:3px;border:1px solid #0f32;background:#010a05;transition:background .05s;flex-shrink:0}
.pr{display:flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid #0f21;border-radius:4px;margin-bottom:6px;background:rgba(0,4,3,.6)}
.pr.best{border-color:#0f86;background:rgba(0,255,128,0.05)}.prb{height:4px;border-radius:2px;margin-bottom:3px}.prm{font-size:9px;color:#88ffcc;font-weight:bold}
.el{font-size:9px;color:#88ffcc;line-height:1.8;max-height:100px;overflow:hidden;opacity:0.8}
#ftr{position:fixed;bottom:0;left:0;right:0;height:70px;z-index:50;background:rgba(0,4,6,.97);border-top:1px solid #0f32;display:flex;align-items:center;backdrop-filter:blur(12px);overflow-x:auto;scrollbar-width:none;padding:0 10px}
#ftr::-webkit-scrollbar{display:none}
.fg{display:flex;flex-direction:column;gap:6px;padding:0 20px;border-right:1px solid #0f21;justify-content:center;flex-shrink:0}
.fl{font-size:10px;letter-spacing:2px;color:#88ffcc;font-weight:bold}.fr{display:flex;gap:8px;align-items:center}
.fr select{background:#010a05;border:1px solid #0f35;color:#0f8;font:11px/1 'Share Tech Mono',monospace;padding:6px 10px;cursor:pointer;outline:none;border-radius:4px;min-height:32px}
#flv{position:fixed;inset:0;pointer-events:none;z-index:70;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:15px;opacity:0;transition:opacity .5s}
#fln{font:clamp(18px,4vw,32px)/1 'Orbitron',monospace;color:#00ffb3;letter-spacing:8px;text-shadow:0 0 50px #00ffb3}
#fls{font-size:12px;color:#88ffcc;letter-spacing:5px}
#ntf{position:fixed;top:75px;left:50%;transform:translateX(-50%);font-size:12px;letter-spacing:3px;color:#00ffb3;white-space:nowrap;background:rgba(0,8,6,.98);border:1.5px solid #0f35;padding:8px 24px;border-radius:4px;z-index:60;opacity:0;transition:opacity .3s;pointer-events:none;box-shadow:0 5px 20px rgba(0,0,0,0.4)}
#paus{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);font:clamp(20px,5vw,40px)/1 'Orbitron',monospace;color:#00ffb3;letter-spacing:15px;text-shadow:0 0 60px #00ffb3;z-index:60;opacity:0;transition:opacity .2s;pointer-events:none}
#php{position:fixed;top:75px;left:50%;transform:translateX(-50%);font-size:20px;color:#aaddff;letter-spacing:10px;text-shadow:0 0 20px #aaddff;pointer-events:none;z-index:40;display:none}
#pbk{position:fixed;top:75px;left:20px;z-index:41;display:none}
#kh{position:fixed;bottom:85px;right:270px;font-size:9px;color:#0f84;line-height:2;pointer-events:none;z-index:5;text-align:right;letter-spacing:1px}
#mb{position:fixed;top:60px;left:0;right:0;z-index:39;background:rgba(0,6,10,.94);border-bottom:1px solid #0f21;padding:6px 20px;font-size:10px;color:#88ffcc;display:none;gap:15px;align-items:center}
@media(max-width:767px){#info{display:none!important}#kh{display:none}#mb{display:flex!important}.mtab span{display:none}.mtab{padding:0 12px}#hr #sr,#hr #sv{display:none}}
      ` }} />
      <canvas id="c"></canvas>
      <div dangerouslySetInnerHTML={{ __html: `
<div id="hdr">
  <div class="mtab on" id="tt" onclick="window.setMode ? window.setMode('TRAIN') : void 0"><div class="pip"></div><span>TRAINING</span></div>
  <div class="mtab" id="tp" onclick="window.tryPlay ? window.tryPlay() : void 0"><div class="pip" style="animation-delay:.8s"></div><span>PLAY</span></div>
  <div id="hm">
    <div><div class="hv" id="hgen">G0</div><div class="hl">GENERATION</div></div>
    <div style="text-align:center"><div id="plbl">MOTOR PRIMITIVES</div><div id="gbar"><div id="gbf"></div></div></div>
    <div><div class="hv" id="hfit" style="color:#ffcc00">0.00</div><div class="hl">BEST FITNESS</div></div>
    <div><div class="hv" id="hsps" style="font-size:clamp(9px,1.4vw,13px);color:#aaa">—</div><div class="hl">SIM/SEC</div></div>
  </div>
  <div id="hr">
    <div style="font-size:5.5px;color:#88ffcc">SPD</div>
    <input type="range" id="sr" min="1" max="200" value="1" oninput="window.setSp ? window.setSp(+this.value) : void 0">
    <div id="sv">1×</div>
    <button class="b" id="bauto" onclick="window.toggleAutoSpeed ? window.toggleAutoSpeed() : void 0">AUTO</button>
    <button class="b on" id="brun" onclick="window.togglePause ? window.togglePause() : void 0">▶ RUN</button>
    <button class="b r" onclick="window.doReset ? window.doReset() : void 0">↺</button>
  </div>
</div>
<div id="mb"><span id="mg">G0</span>·<span id="mph">MOTOR</span>·<span id="mf" style="color:#ffcc00">F:0</span>·<span id="ms">—sps</span></div>
<div id="info">
  <div class="ic">
    <div class="ih">ECHOLOCATION SENSE</div>
    <div style="font-size:5px;color:#88ffcc;margin-bottom:2px">AUDITARCLES (echo deflection)</div>
    <div class="nr" id="nna"></div>
    <div style="font-size:5px;color:#88ffcc;margin:3px 0 2px">CHEMORECEPTION</div>
    <div class="nr" id="nnc"></div>
    <div style="font-size:5px;color:#88ffcc;margin:3px 0 2px">SUCTION GRIP STATUS</div>
    <div class="nr" id="nns"></div>
  </div>
  <div class="ic">
    <div class="ih">INTERNAL STATES</div>
    <div id="vit"></div>
  </div>
  <div class="ic">
    <div class="ih"><span>POPULATION</span><span id="pgn" style="color:#00ffb3">G0</span></div>
    <div id="plist"></div>
    <div class="el" id="elog" style="margin-top:4px"></div>
  </div>
</div>
<div id="ftr">
  <div class="fg"><div class="fl">Prey <span id="pc" style="color:#fa0">0</span></div>
    <div class="fr"><button class="b a" onclick="window.addPrey ? window.addPrey(1) : void 0">+1</button><button class="b a" onclick="window.addPrey ? window.addPrey(3) : void 0">+3</button><button class="b r" onclick="window.clearPrey ? window.clearPrey() : void 0">CLR</button></div></div>
  <div class="fg"><div class="fl">Evolution</div>
    <div class="fr"><button class="b on" id="bevo" onclick="window.toggleEvo ? window.toggleEvo() : void 0">EVO ON</button><button class="b" onclick="window.forceMut ? window.forceMut() : void 0" style="border-color:#fc3;color:#fc3">MUTATE</button></div></div>
  <div class="fg"><div class="fl">Phase</div>
    <div class="fr"><select id="psel" onchange="window.setPhase ? window.setPhase(+this.value) : void 0">
      <option value="0">I Motor</option><option value="1">II Echo</option>
      <option value="2">III Chemo</option><option value="3">IV Pursuit</option>
      <option value="4">V Evasive</option><option value="5">VI Free</option>
    </select><button class="b" onclick="window.nextPhase ? window.nextPhase() : void 0">▶</button></div></div>
  <div class="fg"><div class="fl">Pop <span id="popc">6</span></div>
    <div class="fr"><select id="popsel" onchange="window.setPopSz ? window.setPopSz(+this.value) : void 0"><option value="4">4</option><option value="6" selected>6</option><option value="8">8</option><option value="12">12</option></select>
    <button class="b" onclick="window.newGen ? window.newGen() : void 0">NEW GEN</button></div></div>
  <div class="fg"><div class="fl">Map <span id="hmg" style="color:#aaa">1</span></div>
    <div class="fr"><button class="b" onclick="window.rebuildMap ? window.rebuildMap() : void 0">REBUILD</button>
    <select id="mapsel" onchange="window.setMapRegen ? window.setMapRegen(+this.value) : void 0">
      <option value="3">Regen/3G</option><option value="5" selected>Regen/5G</option>
      <option value="10">Regen/10G</option><option value="999">Fixed</option>
    </select></div></div>
  <div class="fg"><div class="fl">View & Debug</div>
    <div class="fr"><button class="b on" id="bch" onclick="window.tog ? window.tog('ch') : void 0">CHEM</button><button class="b" id="bsw" onclick="window.tog ? window.tog('sw') : void 0">ECHO</button><button class="b" id="blt" onclick="window.tog ? window.tog('lt') : void 0">LIGHT</button><button class="b" id="bcol" onclick="window.tog ? window.tog('col') : void 0">COLLIDERS</button><button class="b on" id="bai" onclick="window.tog ? window.tog('ai') : void 0">AI CTRL</button><button class="b" id="bnoCol" onclick="window.tog ? window.tog('noCol') : void 0">NO COL</button><button class="b" id="bcpgWave" title="Handgeschriebene Gangkurve — standardmäßig AUS, nur zum A/B-Vergleich" onclick="window.tog ? window.tog('cpgWave') : void 0">CPG WAVE</button><button class="b on" id="breflexGrip" title="Reflexive Adhäsion: Haftung ist ein physikalischer Reflex, die KI steuert eine stetige Haftstärke statt an/aus" onclick="window.tog ? window.tog('reflexGrip') : void 0">REFLEX GRIP</button></div></div>
</div>
<button class="b a" id="pbk" onclick="window.exitPlay ? window.exitPlay() : void 0">← TRAINING</button>
<div id="php"></div>
<div id="flv"><div id="fln"></div><div id="fls"></div></div>
<div id="ntf"></div><div id="paus">PAUSED</div>
<div id="kh">[ ] speed &nbsp;F play &nbsp;ESC back &nbsp;SPACE pause &nbsp;R reset</div>
      ` }} />
    </>
  );
}
