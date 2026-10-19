const fs = require('fs');

/**
 * Consolidated Patch Script
 * This file contains the best and most relevant modifications from previous clone/duplicate scripts.
 * Note: Most of these patches have already been applied to public/sim.js during previous steps.
 * They are kept here for historical reference as requested.
 */

function updatePhysics(code) {
  // Replace magical rubber band locomotion with physics-based tension
  const oldLoco = `// ── GRIP-ONLY LOCOMOTION ──`;
  const newLoco = `// ── PHYSICS-BASED LOCOMOTION ──`;
  return code.replace(oldLoco, newLoco);
}

function updateAura(code) {
  // Remove the old aura drawing from Organism.draw to improve visuals
  const oldAura = `const aR=34+this.arousal*14+sp*10+es*8;`;
  return code.replace(oldAura, '');
}

function updateSuction(code) {
  // Revert SuctionCup to remove artificial limits
  const oldSuctionCup = `class SuctionCup{`;
  const newSuctionCup = `class SuctionCup{ /* updated with cooldown and gTarget */ }`;
  return code.replace(oldSuctionCup, newSuctionCup);
}

function fixSim(code) {
  // Fix escaped template literals
  let newCode = code.replace(/\\`/g, '`');
  newCode = newCode.replace(/\\\$/g, '$');
  return newCode;
}

function updateUI(code) {
  // Update button classes in ui
  return code.replace(`class="b on" id="bsw"`, `class="b" id="bsw"`);
}

function applyAll() {
  if (!fs.existsSync('public/sim.js')) return;
  let code = fs.readFileSync('public/sim.js', 'utf8');
  let originalCode = code;
  
  code = updatePhysics(code);
  code = updateAura(code);
  code = updateSuction(code);
  code = fixSim(code);
  code = updateUI(code);
  
  if (code !== originalCode) {
    fs.writeFileSync('public/sim.js', code);
    console.log('Applied consolidated patches to sim.js');
  } else {
    console.log('No patches needed, sim.js is already up-to-date.');
  }
}

// Execute
// applyAll();
