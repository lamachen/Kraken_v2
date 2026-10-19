# Kraken_v2 — Körpermodell & Antriebsarchitektur

Stand: 2026-10-19 · Zweig `fix/physics-locomotion`

> **Wichtig:** `FIXES.md` dokumentiert die erste Reparaturrunde. Der dort beschriebene
> **Jet-Antrieb ist wieder entfernt** — er war ein Designfehler von mir. Dieses Dokument
> beschreibt das tatsächlich gewollte Körpermodell.

---

## Das Medium: keins

Die Viecher sind **keine** Wassertiere. Es sind Aliens, die sich auf einer **Oberfläche**
bewegen — Draufsicht, `gravity = {x:0, y:0}`. Daraus folgt:

- kein Auftrieb, kein Strömungswiderstand, **kein Rudern**
- Arme, die durch die Luft wedeln, erzeugen **keinen** Vortrieb
- was bleibt ist **Reibung gegen den Untergrund** (`frictionAir` als viskose Näherung,
  im Matter-Integrator statt per `setVelocity` — constraint-konsistent)

Alle `JET_*`-Konstanten, `FUNNEL_LEVER`, die Mantel-Pulsierung und jede
`Body.applyForce` auf den Rumpf sind entfernt.

## Der einzige Antrieb

**Es wirkt an keiner Stelle eine Kraft auf den Rumpf.** Auch nicht „indirekt" über
einen Arm. `Pt.force()` — eine translationale Kraft am Schwerpunkt — ist komplett
gelöscht, weil das genau das verbotene Muster war: eine von außen aufgedrückte
Schiebekraft, die über den Arm den ganzen Körper mitnimmt.

Übrig bleiben ausschließlich **Gelenkmomente**:

```js
tau = clamp(MUSCLE_KP*(ziel - ist) - MUSCLE_KD*relOmega, -1, 1) * MUSCLE_TMAX * tone * SUB_COMP;
B.torque += tau;      // Segment i
A.torque -= tau;      // Segment i-1   →  Actio = Reactio, intern zur Armkette
```

Momente zwischen zwei Armsegmenten sind **innerhalb der Kette** — sie erzeugen weder
Nettokraft noch Nettomoment auf den Körper. Sie können den Rumpf nur bewegen, indem
sie den Arm **verkürzen oder verlängern**. Und das zieht nur dann am Rumpf, wenn die
Spitze **verankert** ist.

### Der Bewegungszyklus

```
1. Arm ausstrecken            → Spitze erreicht einen neuen Punkt
2. Saugnapf haftet            → fester Anker (Boden, Wand, oder ein Objekt)
3. Arm einknicken (curl)      → Arm wird kürzer → zieht den Rumpf an den Anker heran
4. lösen, nachziehen          → Zyklus wiederholt sich, ggf. phasenverschoben pro Arm
```

**Derselbe Mechanismus, zwei Wirkungen** — und zwar automatisch, ohne Sondercode:
der Constraint-Solver teilt die Korrektur **massengewichtet** auf.

| Anker | Effekt |
|---|---|
| fester Punkt (Boden/Wand) | der **Rumpf** wird herangezogen → Fortbewegung |
| leichtes freies Objekt (Beute) | das **Objekt** wird herangezogen → Greifen/Fressen |

Genau das war die Anforderung, und sie ergibt sich aus der Physik von selbst.

### Warum Asymmetrie nötig ist

6 radial symmetrische Arme, die **gleichzeitig** ankern und einknicken, heben sich
gegenseitig auf — Nettokraft null. Fortbewegung erfordert, dass Arme auf **einer** Seite
verankern und ziehen, während die anderen lösen und nachgesetzt werden. Diese
Koordination ist nicht gescriptet; sie ist genau das, was die Evolution finden muss.

---

## Was die KI steuert (27 Ausgänge, alle belegt)

| Ausgang | Bedeutung | Wirkt auf |
|---|---|---|
| `out[0]` | Frequenz der metachronalen Welle (`CPG_HZ_MIN…MAX`) | CPG-Uhr |
| `out[1]` | **Muskeltonus** 0.30…1.00 — schlaff ↔ steif | skaliert alle Gelenkmomente |
| `out[2+k·4+0]` | Schulter-Zielwinkel Arm *k* | Gelenkmoment Schulter |
| `out[2+k·4+1]` | Amplitude der Welle an Arm *k* | Gelenkmomente |
| `out[2+k·4+2]` | Ruhekrümmung Arm *k* (Einknicken/Strecken) | Gelenkmomente |
| `out[2+k·4+3]` | Saugnapf Arm *k*, **mit Hysterese** | Anker |
| `out[26]` | Echo-Impuls auslösen | Sensorik |

`out[0]`/`out[1]` waren vorher tote Ausgänge. Sie sind jetzt globale Arm-Parameter —
beides reine Muskelstellgrößen, keine Kräfte.

### Saugnapf-Hysterese (wichtigster Lernbarkeits-Fix)

Vorher wurde `suctionOn` **jeden Frame neu** aus dem Netz gelesen (`out > 0.1`). Ein
einziger Frame knapp unter der Schwelle ließ den Anker sofort los.

Gemessen: **32 erfolgreiche Grips, aber nur 0.5 % der Schritte mit Anker** — jeder Grip
wurde im selben Frame wieder gelöscht. Für die Evolution ein praktisch unlernbares Nadelöhr.

Jetzt latchend: an bei `out > +0.15`, aus erst bei `out < −0.15`. Dazu asymmetrische
Energiekosten — **neu ansaugen ist teuer (0.00022), halten fast gratis (0.00004)**,
wie beim echten Saugnapf. Ergebnis: **bis zu 6 Arme gleichzeitig verankert, 30 % der Schritte.**

---

## Kalibrierung (per Sweep gemessen, nicht geraten)

`tools/tune-grip.js` swept Grip-Tempo-Gate × Muskelmoment × Rumpfmasse und misst den
Vortrieb eines 3-Phasen-Inchworm-Zyklus über 10 Zyklen in 3 Zielrichtungen.

| Größe | Wert | Begründung |
|---|---|---|
| `MUSCLE_TMAX` | 0.0135 | ×3 war in **allen** Top-Konfigurationen der gemeinsame Faktor: Ø Vortrieb 64 → 166 px |
| `SHOULDER_TMAX` | 0.042 | Schulter muss die ganze Kette schwenken *und* den Zug übertragen |
| Rumpfmasse | 16 | bei reiner Arm-Fortbewegung sind die Arme Aktuator **und** Reaktionsmasse; 16 : 3.2 = 5:1 bleibt solver-stabil |
| Segmentmasse | `lerp(3.2, 1.8)` | Taper ≤ 1.8:1 über die Kette |
| `MAX_ANG_V` Segmente | 0.30 | sonst sättigt der stärkere Muskel dauerhaft am Clamp = Bang-Bang |
| Grip-Tempo-Gate | 6.0 | **kein** Flaschenhals (Anker-Rate identisch für 2.4/5/12/50/∞ — begrenzt wird über `GRIP_BREAK`), aber künstliche Freiheit genommen |
| `GRIP_BREAK` | 22 px | Dehnung, ab der ein Saugnapf abreißt |
| `GRIP_MAX_TIME` | 3.0 s | Haltegrenze pro Anker |
| `OVR.floorGrip` | `true` | **entscheidend**: auf einer Oberfläche kann der Saugnapf überall haften, nicht nur an Wänden. Ohne das gäbe es im offenen Gelände buchstäblich nichts zu halten |

---

## Verifizierter Zustand (`npm run test:sim`)

```
CHECKS: 12/12
 bodies 369/369          (exakt eine Population, keine Geister-Kraken)
 spawnErr 0.0000/0.0000  (Schulter + Segmente, constraint-frei)
 peakV 6.00  peakAV 0.300 (im Limit)
 NaN 0   ausserhalb 0
 Umdrehungen 0.47         (Original: 198.8)
 steps/s 137
 Grip-Pull: bis 294 px Vortrieb über 10 Inchworm-Zyklen
 Trend/Generation: Score +17.7, vorwärts +2.8 px, netto +0.8 px
```

`npm ci && npm run build` → exit 0, TypeScript sauber, `eslint` leer.

---

## Ehrliche offene Punkte

1. **Die Richtung des Grip-Pull ist noch nicht zuverlässig.** Der *gescriptete*
   Test-Controller liefert je nach Lauf +294 px, −269 px oder +132 px in der
   Zielrichtung. Der Mechanismus existiert und funktioniert, aber ein großer Teil der
   Bewegung stammt derzeit aus **nicht-reziproken Armhüben gegen die Bodenreibung**
   (physikalisch legitim, aber nicht der gewollte Hauptweg). Die koordinierte
   *asymmetrische* Anker-Sequenz muss die Evolution selbst finden — dafür ist sie
   jetzt überhaupt erst möglich.

2. **Der KI fehlt die Propriozeption.** In den 64 NN-Eingängen stehen Echolot, Chemie,
   Licht, Grip-Status, Tempo, Winkelgeschwindigkeit, Wandnähe, Beutendistanz — aber
   **kein einziges Gelenkwinkel-Feedback**. Die KI ist blind für die Pose ihrer eigenen
   Arme. Ein Körpermodell kann so nicht entstehen. Das ist der wichtigste einzelne
   Hebel und bewusst noch nicht umgesetzt, weil es `NI`/`NSW` ändert und die
   HUD-Visualisierung betrifft.

3. **`anchorUse*12` in der Fitness ist niedrig gewichtet.** Solange Punkt 1 offen ist,
   würde ein höheres Gewicht „dauernd verankert sitzen und nichts tun" belohnen.

---

## Nächste Hebel, in dieser Reihenfolge

1. **Propriozeption** — pro Arm: Schulterwinkel, mittlere Krümmung, Spitzenposition
   relativ zum Rumpf (x/y), Kontakt. Dazu Rumpf-Beschleunigung. `NI` 64 → ~104.
   Ohne das kann die KI ihren Körper nicht verstehen.
2. **Curriculum für Asymmetrie** — Phase 0 in einer Karte mit *einem* Ankerpunkt
   starten, damit „einseitig ankern und ziehen" überhaupt selektierbar ist, dann
   Komplexität steigern.
3. **Symmetrie brechen** — Arme paarweise koppeln (`k` und `k+3`) halbiert den
   Suchraum und erzwingt gegenläufige Bewegungsmuster.
4. **CMA-ES statt `(μ,λ)`-GA** — bei 4027 Gewichten deutlich schnellere Konvergenz.
5. **Mehrfach-Evaluation pro Genom** (3 Spawns mitteln) — entfernt das letzte
   Spawn-Rauschen, kostet 3× Rechenzeit.

---

# Ergänzung — Merge-Runde 2

Der obige Stand (`ee24fb5`) war bereits sweep-kalibriert und bleibt die Basis.
Aus einer zweiten, unabhängig gelaufenen Runde wurden **fünf** Punkte dazugenommen.
Nichts von der Kalibrierung oben wurde zurückgedreht: `floorGrip`, `SUCK_ON/OFF`-
Hysterese, `GRIP_BREAK 22`, `GRIP_MAX_TIME 3.0`, `MUSCLE_TMAX 0.0135`,
`SHOULDER_TMAX 0.042`, Rumpfmasse 16, `MAX_ANG_V 0.30` und `SUBSTEPS 2` sind
unverändert übernommen.

## Kalibrierung des Zug-Mechanismus (`tools/grip-pull-calib.js`)

Standalone-Nachbau in reinem Matter: ein Arm, Spitze an einem festen Weltpunkt
verankert, erzwungener Zugzyklus, gemessen wird wie weit der Rumpf herankommt.

| Gelenkmoment | Rumpf m=8 | m=14 | m=20 | m=26 | m=40 |
|---|---|---|---|---|---|
| 0.004 | 118 px (99 %) | 113 px (95 %) | 116 px (98 %) | 109 px (92 %) | 112 px (95 %) |
| 0.04  | 113 px (96 %) | 115 px (97 %) | 111 px (94 %) | 115 px (97 %) | 111 px (94 %) |
| 1.2   | 114 px (96 %) | 111 px (94 %) | 113 px (96 %) | 114 px (96 %) | 115 px (97 %) |

**Die Zugweite ist von Muskelmoment und Rumpfmasse praktisch unabhängig** — der
Mechanismus ist geometrie-bestimmt (Arm 118.5 px Reichweite, voll eingerollt ≈ 0).
Der Engpass war also nie die Kraft, sondern dass die Krake keinen Halt bekam.
Deshalb zielen die Fixes unten auf Halten und Wahrnehmen, nicht auf mehr Moment.

Nebenbefund derselben Messreihe: eine Kette mit `curl = 0` (gestreckt) ist exakt
stabil, mit `curl = 0.28` und `angularStiffness = 0` explodiert sie auf
`max|v| = 69.3 px/step` aus einem kräftefreien Ruhezustand — die Bestätigung für
den `angularStiffness: 1`-Fix aus Runde 1.

## 1. Saugnapf-Cooldown war dauerhaft klemmend (Bug, auch in ee24fb5)

`cd` wurde an drei Stellen **gesetzt** (`tryGrip` bei zu schneller Spitze → 0.05,
bei fehlendem Anker → 0.08, `release()` → 0.12), aber ausschließlich in
`applyConstraint()` **dekrementiert** — und das läuft nur, solange `gripped` wahr
ist. Ein einziger Fehlversuch sperrte den Napf damit für den Rest der Episode.

Das ist die plausibelste Erklärung dafür, warum die Anker-Rate trotz `floorGrip`
gedeckelt war. Fix: Dekrement direkt in `tryGrip()`.

## 2. Propriozeption — NN-Eingänge 64 → 104

Der Stand oben hatte **kein** Gelenk-Feedback. In den Eingängen standen Echolot,
Chemie, Licht, Grip-Status, Tempo und Wandnähe — die KI war blind für die Pose
ihrer eigenen Arme. Ein Körpermodell kann so nicht entstehen, egal wie lange
trainiert wird. Das war der wichtigste einzelne fehlende Baustein für das
Projektziel „die KI soll ihren Körper verstehen".

Neu auf `[37..72]`, 6 Arme × 6 Werte:

| # | Wert |
|---|---|
| 0 | Schulterwinkel relativ zum Rumpf (auf `SHOULDER_LIMIT` normiert) |
| 1 | mittlere Krümmung über die Kette (auf `JOINT_LIMIT` normiert) |
| 2–3 | Spitzenposition **im Rumpf-Koordinatensystem**, auf `ARM_REACH` = 118.5 px normiert |
| 4 | Tastkontakt der Spitze |
| 5 | **Zuglast am Saugnapf** — 0 = lose, 1 = kurz vor dem Abriss |

Neu auf `[73..76]`: Eigenbeschleunigung längs und quer im Rumpfsystem, Anteil
tragender Arme, mittlere Arm-Extension.

Damit kann die KI die Kausalität selbst beobachten: *Arm einknicken → Zuglast
steigt → Eigenbeschleunigung längs wird positiv → Rumpf bewegt sich*. Vollständig
ungescriptet.

`NSW` war hart auf `64*NH+…` kodiert und hätte die neuen Eingänge abgeschnitten —
jetzt `NI*NH+…`. Genomgröße 4027 → **5307 Gewichte**.

## 3. Drei Saugnäpfe pro Arm statt einem

`SUCTION_IDX = [CONN_SEGS]` = `[7]` lag **außerhalb** des Segmente-Arrays (0..6)
und wurde außerdem nirgends benutzt — gebaut wurde `new SuctionCup(CONN_SEGS-1)`,
also ein einziger Napf ganz außen. Der ursprüngliche Code-Kommentar („Suction
cups at tip, 57%, 28% of tentacle length") beschreibt bereits die Absicht.

Jetzt `SUCTION_IDX = [2, 4, CONN_SEGS-1]` → **18 Ankerpunkte** pro Krake.
Zusammen mit `floorGrip` kann die KI damit mehrarmig koordiniert ziehen statt
nur an einer einzigen Spitze. Gemessen: bis zu **5 Arme gleichzeitig verankert**.

## 4. Asymmetrischer Zug-Zyklus (`PULL_ASYM = 1.8`)

Der CPG erzeugte eine symmetrische Sinuswelle. Eine symmetrische Welle zieht im
Mittel genausoweit zurück wie sie holt — für Netto-Vortrieb braucht der Gang
Asymmetrie: **langsam strecken** (neuen Anker suchen), **schnell einknicken**
(ziehen). `waveAt()` formt die Phase jetzt über `pow(0.5+0.5·sin φ, 1.8)`.

## 5. `nnFwd` ohne Allokation

`nnFwd` lief 8× pro Sim-Schritt und allokierte dabei je 3 `Float32Array` —
24 Objekte/Step bzw. ~1440/s. Jetzt geteilte Scratch-Puffer; `Organism.tick`
sichert den Inhalt sofort (`this.lOut.set(out)`), und `buildInputs` schreibt
direkt in `this.lIn`.

---

## Verifizierter Zustand nach dem Merge (`npm run test:sim`)

```
CHECKS: 13/13
 bodies 362/362           (exakt eine Population)
 spawnErr 0.0000/0.0000   (Schulter + Segmente constraint-frei)
 peakV 6.00  peakAV 0.300 (im Limit)
 NaN 0   ausserhalb 0
 Umdrehungen 0.55–0.70    (Original: 198.8)
 steps/s 100
 Propriozeption 27/36 Werte aktiv
 verankert: 72 % der Zeit, bis 5 Arme gleichzeitig
 Grip-Pull: bis 272 px gerichteter Vortrieb über 10 Zyklen (18.1 px/Zyklus)
```

Lernkurve über 18 Generationen à 900 Schritte (Phase 0):

| | Start | Ende | Trend/Gen |
|---|---|---|---|
| Score | 1860 | **2906** | **+62.9** |
| Vorwärts-Projektion | 1225 px | **1704 px** | +30.4 px |
| Netto-Distanz | 177 px | **839 px** (Spitze) | +23.6 px |
| Grip-Kriech-Strecke | 1046 px | **1629 px** | — |
| Geradlinigkeit | 5 % | **23 %** | — |
| Umdrehungen | 0.6 | 0.6 | — |

Zum Vergleich: dieselbe Konfiguration **ohne** Propriozeption und mit nur einem
Saugnapf pro Arm erreichte in derselben Messung einen Trend von +10.4 Score/Gen
und +0.03 px Netto/Gen. Die Propriozeption ist also nicht Kosmetik, sondern der
Hebel, der den Gradienten überhaupt erst trägt.

`npm ci && npm run build` → exit 0, TypeScript sauber, `eslint` leer.
