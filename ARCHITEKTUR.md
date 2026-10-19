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
