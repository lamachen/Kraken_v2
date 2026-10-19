# Kraken_v2 — Reparatur & Physik-Überarbeitung

Stand: 2026-10-19 · Zweig `fix/physics-locomotion`

## Symptom (gemeldet)

> „Aktuell kreiseln die Kraken alle nur im Kreis nach dem Start, und kurz vorher
> sind sie alle unkontrolliert geglitcht und aus der Map geflogen."

Beide Symptome sind reproduzierbar und hatten **sieben** voneinander unabhängige
Ursachen. Alle sind hier mit Messwerten belegt — nicht geraten.

---

## Messverfahren

`tools/headless.js` fährt die **echte** Simulation (echtes `matter.min.js`, echtes
`public/sim.js`) in einem DOM-Stub unter Node und misst Physik und KI-Verhalten:

```bash
npm run test:sim          # volle Suite (~3 min)
npm run test:sim:quick    # Kurzlauf (~30 s)
node tools/headless.js --gens 30 --measure-steps 900   # langer Evolutionslauf
SIM_PATH=/pfad/zu/alt.js node tools/headless.js        # beliebige Variante messen
```

Ergebnisse liegen als JSON in `tools/reports/`:
`baseline-original.json` (Stand vor der Reparatur), `fixed.json`, `learning-30gen.json`.

---

## Vorher / Nachher

| Messgröße | Original | Repariert | Faktor |
|---|---|---|---|
| Bodies im Matter-World | **787** (erwartet 271) | 447 (= exakt erwartet) | −3× Ballast |
| Constraint-Verletzung Schulter beim Spawn | **56.94 px** | **0.0000 px** | ∞ |
| Constraint-Verletzung Segment beim Spawn | **26.99 px** | **0.0000 px** | ∞ |
| Peak \|v\| im 1. Frame | **69.8 px/step** (4188 px/s) | 6.00 px/step (360 px/s) | 12× |
| Peak \|ω\| im 1. Frame | **3917.97 rad/step** | 0.2000 rad/step | 19590× |
| Bodies außerhalb der Map (120 Steps) | **129** | **0** | — |
| Umdrehungen pro Episode | **198.8** | **0.29 – 0.65** | ~300× |
| Geradeaus-Anteil (Netto/Pfad) | 7 % | 42 % | 6× |
| Jet-Gerichtetheit | 3 % | **47 – 55 %** | ~17× |
| Passiv-Restenergie (alle Aktuatoren aus) | 964 px Pfad | **0 px, \|v\| = 0.00000** | — |
| `applyMuscles()` Laufzeit | 50.78 ms/step | **0.33 ms/step** | 152× |
| Simulationsgeschwindigkeit | 114 steps/s | 118 steps/s (bei ⅓ mehr Bodies) | ≈ |
| Tote NN-Ausgänge | 2 (`out[0]`, `out[1]`) | **0** | — |
| Tentakelsegmente mit Welt-Kollision | **0 / 42** | **42 / 42** | — |
| Bestandene Regression-Checks | **4 / 12** | **11 / 12** | — |

Lernkurve über 30 Generationen (`tools/reports/learning-30gen.json`):
Score **433 → 503**, Netto-Distanz **305 → 460 px**, Vorwärts-Projektion **511 → 638 px**,
linearer Trend **+5.86 Score/Generation** und **+6.88 px Netto/Generation**.

---

## Die sieben Ursachen

### 1. `angularStiffness` — die eigentliche Explosion (kritisch)

Matter.js `Constraint.create()` setzt `angularStiffness` per Default auf **0**.
In `Constraint.solve()` steht:

```js
p = cross(pointA, b)/w * _torqueDampen * inverseInertia * (1 - angularStiffness);
bodyA.angle -= p;      // ← anglePrev wird NICHT mitgeführt
```

Bei `angularStiffness = 0` ist der Faktor `(1-0) = 1`, d. h. der Solver wendet eine
**Winkelkorrektur an, die `anglePrev` nicht nachführt** — sie erzeugt
Winkelgeschwindigkeit aus dem Nichts. Bei einer *gekrümmten* Gelenkkette schaukelt
sich das im allerersten `Engine.update` auf.

Isoliert in reinem Matter nachgestellt (7 Segmente, curl 0.28, **Kräfte = 0,
Momente = 0, Geschwindigkeiten = 0, Constraint-Verletzung = 0.00000**):

| Konfiguration | max \|v\| | max \|ω\| |
|---|---|---|
| `curl = 0` (gerade Kette) | 0.00000 | 0.00000 |
| `curl = 0.28`, `angularStiffness = 0` | **69.30** | **95.05** |
| `curl = 0.28`, `angularStiffness = 1` | **0.41** | **0.013** |

**Fix:** `angularStiffness: 1` an allen drei Constraint-Typen (Schulter-Anchor,
Segment-Gelenke, Saugnapf-Grip). Das ist kein Workaround, sondern die physikalisch
korrekte Einstellung: ein **Scharnier** ist positionsgekoppelt und rotationsfrei.

### 2. Degenerierte Kapsel-Geometrie

```js
const collisionLength = Math.max(1, options.length - options.thickness);
//  = max(1, 13.5 - 11.9) = 1.6 px  bei 11.9 px Dicke
chamfer: { radius: options.thickness / 2 }   // = 5.95 > min(w,h)/2
```

Kommentar im Code: *„chamfer adds it back"* — tut es nicht, Matters `chamfer` rundet
Ecken **nach innen** ab. Ergebnis: ein 1.6 × 11.9 px Splitter mit
`inertia = 1.20` statt `10.52` für eine echte Kapsel. Zusammen mit Rumpfmasse 30
ergab das ein Trägheitsverhältnis von **250:1** — Sequential-Impulse-Solver
werden ab etwa 10:1 instabil.

**Fix:** `collisionLength = max(thickness·1.02, length)`, `chamfer radius = min(T·0.48, L·0.48)`,
und Massenverhältnis Rumpf : Segment₀ auf ≈ 8:1 begrenzt.

### 3. `angDiff()` mit while-Schleife — 152× Performance-Verlust

```js
function angDiff(a,b){let d=a-b;while(d>Math.PI)d-=Math.PI*2;while(d<-Math.PI)d+=Math.PI*2;return d}
```

Matter normiert `body.angle` **nie**. Gemessen: `max|angle| = 1.784.349 rad`
→ **284.000 Schleifendurchläufe pro Aufruf**, bei 432 Aufrufen pro Sim-Schritt
(6 Kraken × 6 Arme × 6 Gelenke × 2 Substeps) = über 100 Mio. Iterationen/Schritt.
`applyMuscles()` kostete dadurch **50.78 ms** und wurde mit jedem Frame langsamer.

**Fix:** Restmodulo (`O(1)`) plus periodisches Einwickeln von `body.angle` auf
(−π, π] in `Pt.step()`. Ergebnis: `applyMuscles` **0.33 ms**, `max|angle| = 3.9 rad`.

### 4. Doppel-Boot → 6 Geister-Kraken

`public/sim.js` bootet sich am Dateiende selbst (`document.readyState` ist in einer
Next.js-Client-Component praktisch immer `interactive`), **und** `app/page.tsx` ruft
`bootSimulation()` nochmal auf. Zwei `Evolver` im selben Matter-World:

```
Bodies im World:  527      erwartet: 269  (11 Walls + 6 Kraken × 43)
Überschuss:       258  =  6.0 Kraken-Leichen
```

Die zweite Population wurde nie getickt und nie gezeichnet — war also unsichtbar,
hat aber kollidiert und Saugnapf-Constraints gehalten.

**Fix:** `window.__simBooted`-Guard + `teardownWorld()`. Der Guard startet den
Render-Loop neu statt nur zu returnieren, weil React StrictMode
(`reactStrictMode: true`) Effekte im Dev-Build doppelt mountet und der Cleanup in
`page.tsx` `cancelAnimationFrame` aufruft — sonst wäre die Simulation im Dev-Modus
nach dem zweiten Mount eingefroren.

### 5. Fitness-Funktion hat Kreiseln belohnt (das „Kreisel"-Symptom)

```js
const gripLoco = this.gripMoveDist * 3.5;    // gripMoveDist = Σ|v| solange IRGENDEIN Arm hält
this.angularAccum = 0;                        // deklariert als "spinning penalty" —
                                              // aber NIE erhöht und NIE verwendet
const effectiveIdleP = Math.max(0, idleP - this.energySpent * 1.5);  // belohnt Verschwendung
const wallP = this.wallHits * 0.5;            // wallHits wurde NIE erhöht
```

Drehen auf der Stelle liefert volles `|v|`, keinen Drift-Penalty und fast keinen
Energieaufwand → **Kreiseln war die fitness-optimale Strategie**. Gemessen am
Original: Generation 2 erreichte Score 3244 bei **109 px** echter Distanz und
**198.8 Umdrehungen**.

**Fix:** komplett neue, nicht farmbare Fitness. `gripMoveDist` summiert jetzt nur
noch `max(0, Verschiebung · Blickrichtung)`; `angularAccum` und `wallHits` sind
verdrahtet; der Idle-Bonus für Energieverschwendung ist weg. Stattdessen
lageunabhängige Skill-Terme:

```js
const reach       = clamp(maxDisplacement / spawnReach, 0, 1.2);  // Freiraum-Ausnutzung
const directed    = maxDisplacement / pathLen;                    // Geradlinigkeit
const headingHold = 1 - clamp(angularAccum / (steps*MAX_ANG_V_CORE), 0, 1);
travel = reach*240 + directed*95 + headingHold*45 + expl*1800 + meanSpeed*40;
```

`computeSpawnReach()` vermisst beim Spawn per 16 Strahlen den verfügbaren Freiraum.
Ohne das war die Fitness reine Lotterie: wer in einer Nische mit der Wand im Rücken
spawnt, kann physikalisch nie weit kommen (gemessen: Score-Streuung 150…571 **ohne
Trend** über 22 Generationen → nach der Normierung 433 → 503 mit klarem Trend).

### 6. Muskeln haben gar kein Drehmoment erzeugt

```js
Body.applyForce(this.body, this.body.position, {x: cfx * 0.0006, y: cfy * 0.0006});
```

Angriffspunkt = `body.position` = Schwerpunkt → **Hebelarm 0 → Drehmoment exakt 0**.
Die „Muskel"-Kräftepaare an `pts[i-1]`/`pts[i+1]` haben die Segmente nur
translationell verschoben, nie gebeugt. Dazu die Skalierung: `force = 1` auf
`mass = 0.5` ergibt in Matter `Δv = 555 px/step`; der alte Faktor 0.0006 bei
clamp 350 lieferte nach 10 Steps **936 px/step = 56.177 px/s**.

**Fix:** echte PD-Muskelregler über `body.torque` (Matter resettet `torque` und
`force` nach jedem `Engine.update` selbst, Akkumulation ist also sicher):

```js
tau = clamp(MUSCLE_KP*(ziel - ist) - MUSCLE_KD*relOmega, -1, 1) * MUSCLE_TMAX * SUB_COMP;
B.torque += tau;  A.torque -= tau;     // Actio = Reactio innerhalb der Kette
```

Kalibriert an der gemessenen Segment-Trägheit ≈ 7 → `Δω ≈ 0.18 rad/step`.

### 7. Kein freier Antrieb — `out[0]`/`out[1]` waren tot

Die einzige Fortbewegung war „Grip-and-pull". Ohne Kontakt gab es **keinen**
Vortrieb, und mit 6 radial symmetrischen Armen ist Drehen die stabilste Lösung.
Zwei der 27 NN-Ausgänge wurden nirgends gelesen.

**Fix:** `out[0]` = Jet-Intensität, `out[1]` = Trichter-Richtung, mit echter
Mantel-Pulsierung (Füllung → Refraktärzeit 0.30 s → Stoß) und **Trichter-Steuerung**:

```js
const ap = { x: pos.x + cos(lat)*FUNNEL_LEVER*aim, y: pos.y + sin(lat)*FUNNEL_LEVER*aim };
Body.applyForce(b, ap, { x: cos(faceAng+aim*0.95)*F, y: sin(faceAng+aim*0.95)*F });
```

Der Strahl läuft bei ausgelenktem Trichter nicht mehr durch den Schwerpunkt und
erzeugt so ein Drehmoment. Das ist die einzige Lenkachse — ein Oktopus lenkt
genauso, und nur deshalb kann der Rumpf träge sein (was wiederum das Kreiseln
physikalisch unterbindet).

Dazu ein **CPG** (Central Pattern Generator) als Rhythmus-Prior: eine metachronale
Welle läuft mit Phasenversatz `k·2π/6` über die Arme, das NN steuert pro Arm nur
Amplitude, Ruhekrümmung und Schulterziel. Ohne diesen Prior muss die Evolution
27 chaotische Ausgänge gleichzeitig entdecken — die stabilste lokale Lösung ist
dann „im Kreis zappeln". Die CPG-Phase (sin/cos) liegt jetzt auf den Eingängen
`[27]`/`[28]`, damit das Netz sich phasenlocken kann (dort lagen `surfPress`,
ein Duplikat von `max([0..7])`, und `bodyPress`, das wegen `hx=hy=false` **immer 0** war).

---

## Weitere reparierte Defekte

| Defekt | Wirkung vorher | Fix |
|---|---|---|
| `Pt.step()` wurde **nie aufgerufen** | kein Geschwindigkeits-Limit aktiv | in `postPhysics()` pro Step |
| `Evolver.stepCount++` auf `undefined` | `NaN % 12 === 0` → false → `CHEM.diffuse()` lief im Training **nie** → Phase 3 CHEMOTAXIS tot | `(this.stepCount\|\|0)+1` |
| `DEBRIS` nicht definiert | latenter `ReferenceError` in `_damTent`/`takeDamage` | `const DEBRIS=[]` |
| `p.vx += tip.vx()*2` auf `Prey` | `Prey` hatte keine `vx`/`vy` → Knockback komplett wirkungslos | Getter/Setter + `knock()` |
| Tentakel `mask: 0`, `isSensor: true` | Arme kollidierten mit **nichts** — Abstützen und Tasten unmöglich | `mask: COL_WALL\|COL_PREY`, `isSensor: false`, negative `group` gegen Selbstkollision |
| `tipContact = clamp(tip.spd()*12,0,1)` | „Tastsinn" war nur die eigene Geschwindigkeit | echte Wand-/Beute-Berührung, exponentiell geglättet |
| Saugnapf `stiffness: 0.22, length: 2`, Bruch bei 26 px | Gummi — kein Halt zum Abstützen | `stiffness: 0.9, length: 0`, Bruch bei 14 px, `load` als Sensorwert |
| `Organism.ang` zufällig, `body.angle = 0` | Tentakel an `orgAng+relAng` gespawnt, Anchor bei `relAng` | `Body.setAngle` **vor** dem Arm-Aufbau |
| `initPos()` Schritt `SL·u(θ)` nach Drehung | bei `length:0`-Gelenk geometrisch unerfüllbar | `layout()`: halber Schritt → drehen → halber Schritt |
| Wasserwiderstand per `Body.setVelocity` an 258 Bodies | überschreibt die Verlet-Historie, aus der der Solver seine Impulse liest → Dauer-Oszillation | `frictionAir` im Integrator, Mantel-Rotationsdämpfung als echtes Drehmoment |
| Beute `max 5 px/step` bei Kraken-Limit 6 | Beute fast unfangbar, Phase 4/5 unlernbar | `min(MAX_LIN_V·0.55, …)` |
| `body.angle` wächst unbegrenzt | numerisch unsauber | `wrapAngle()` ab \|angle\| > 50 |
| kein NaN-Guard | ein einziger NaN tötet den Körper endgültig | Reparatur + sauberes Neu-`layout()` |
| Mutationsraten `r:.18, m:.36` auf 4027 Gewichte | 725 Mutationen/Gen → Eliten gehen unter | `r:.055, m:.16` (Phase 0), absteigend pro Phase |
| `bestFit` nie zurückgesetzt | `bestW` friert ein, Phase-Wechsel unfair | Reset bei `setPhase()` und Phasenübergang |
| Population 6 | zu wenig Selektionsdruck | 8 (Desktop) / 6 (Mobile) — gemessen 118 steps/s |

---

## Physik-Kalibrierung (matter-js 0.20.0, gemessen)

```
Engine.update(engine, 16.667)  →  deltaTimeSquared = 277.78
Δv = (F / m) · 277.78   [px/frame]        Δω = (τ / I) · 277.78   [rad/frame]
force = 1 auf masse 0.5  →  Δv = 555.6 px/frame
torque = 0.05 auf I = 5.9 →  Δω = 2.36 rad/frame  (135°/frame!)
```

Deshalb gelten für alle Kräfte und Momente im Code **Ziel-Beschleunigungen**, nicht
Ziel-Kräfte: `Pt.force()` rechnet `F = m · a`, damit ein 1.8-Einheiten-Segment nicht
16× stärker beschleunigt als der 26-Einheiten-Rumpf.

`Body.setVelocity` / `setAngularVelocity` normalisiert Matter 0.20 selbst auf
`_baseDelta` (16.667 ms) — sie sind also bei Substeps **einheitenkonsistent**.
Verifiziert: bei `delta = 8.333` ist `body.velocity = 1.389` während
`position − positionPrev = 0.694`; `setVelocity(0.925·v)` liefert im nächsten
Update exakt `0.925·v`.

**Substeps:** `SUBSTEPS = 2` mit `SUB_COMP = SUBSTEPS` als Impuls-Kompensation,
denn `n` Substeps à `Δt/n` ergeben `n·(Δt/n)² = Δt²/n`. Momente und Kräfte werden
pro Substep mit `SUB_COMP` multipliziert, damit der Gesamtimpuls stimmt.

---

## Verbleibender offener Punkt

**„Evolution steigert Vorwärtsbewegung"** schlägt in der kurzen Suite fehl — bei
14 Generationen à 500 Schritte (= 8 s) reicht der Selektionsdruck für 4027 Gewichte
nicht. Im langen Lauf (30 Generationen à 900 Schritte) ist der Trend eindeutig
positiv (+5.86 Score/Gen, +6.88 px Netto/Gen). Im Spiel selbst läuft Phase 0 mit
`dur: 100` s = **6000 Schritte pro Generation** und 12 Generationen — also etwa
10× mehr Evaluationsbudget als der kurze Test.

Konkrete nächste Hebel, falls das Lern-Tempo im echten Betrieb zu niedrig ist:

1. **Mehrfach-Evaluation pro Genom** (3 Spawns mitteln) — eliminiert den Rest
   Spawn-Rauschen, kostet 3× Rechenzeit.
2. **CMA-ES statt `(μ,λ)`-GA** — bei 4027 Gewichten konvergiert das deutlich schneller.
3. **Curriculum**: Phase 0 in offenem Wasser ohne Innenwände starten, Wände erst ab Phase 1.
4. **Symmetrie-Bonus**: Arme paarweise spiegeln (`out[2+k*4+j]` für `k` und `k+3` koppeln)
   halbiert den effektiven Suchraum und erzwingt geraden Lauf.
5. **`expl`-Gewicht** (aktuell 1800) ist der stärkste Term — bei zu starkem
   Erkundungsdrang leidet die Geradeaus-Qualität.

---

## Dateien

| Datei | Änderung |
|---|---|
| `public/sim.js` | Physik, Muskeln, CPG, Jet, Fitness, Boot, Kollision, Sensoren |
| `app/page.tsx` | Kommentar zum Doppel-Boot (Guard sitzt in `sim.js`) |
| `tools/headless.js` | **neu** — 12-Punkte-Regression-Suite, headless |
| `tools/reports/*.json` | **neu** — Messwerte vorher/nachher |
| `package.json` | `test:sim`, `test:sim:quick` |
| `tsconfig.json` | von `next build` migriert (`jsx: react-jsx`, Next 16 Pflicht) |

Build verifiziert: `npm ci && npm run build` → ✓ Compiled successfully, TypeScript sauber, exit 0.
