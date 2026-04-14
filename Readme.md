# Photonic Life

A cellular automaton that models light as computation — not Conway's Life with color on top, but a simulation where wavelength, phase, and wave interference are the actual mechanics.

**[Live demo](https://a-9-sovos.github.io/photonic-life)** — or clone and open `index.html` locally, no build step.

---

## What it is

Each cell is a photonic gate carrying three independent wavelength channels (~650nm red, ~532nm green, ~450nm blue), modeled after the photonic crystal substrate described in the whitepaper below. Each channel has two degrees of freedom:

- **Amplitude** — bistable (0 or 1), Kerr-effect threshold switching
- **Phase** — 0–2π, determines wave interference with neighbors

That's 6 bits of state per cell — hex-native, matching the whitepaper's "six independent color/polarization channels" model.

### Rules

Survival and birth are governed by **phasor coherence** — the circular variance of live neighbor phases on each channel:

- **Constructive interference** (neighbors in phase, coherence ≥ threshold) → cell survives or is born
- **Destructive interference** (opposing phases, coherence < threshold) → cell decays
- **Entrainment** — surviving cells drift 8% toward their neighbors' mean phase each step, causing domains to slowly synchronize
- **WDM** — channels evolve independently; additive mixing produces the full visible spectrum

Brightness in the render encodes local phase coherence — you can watch coherence wavefronts propagate across the grid in real time.

---

## Features

### Simulation
- Toroidal grid (wrapping edges)
- Bloom rendering via a two-pass box-blur composited additively over the sharp cell layer (toggle off for max performance)
- Flat `Uint8Array` / `Float32Array` grid storage — cache-friendly, zero GC pressure in the hot path
- Coherence cached during step, read by renderer — neighbor walk happens once per cell per step
- Stats update every 10 generations, or immediately whenever an alias fires

### Painting
- Left-click drag to paint cells with selected channel(s) and phase
- Right-click drag to erase
- Brush size control
- Per-channel (R/G/B) and phase angle selection

### Alias system
Pattern rewriting rules: define a trigger pattern A and a replacement pattern B. When A appears anywhere on the grid, it's atomically replaced with B.

- Color-exact matching — each cell in a pattern specifies which channels must be alive
- `?` cells match any live color (at least one channel alive)
- `*` cells match anything — live, dead, any color (trigger patterns only)
- Dirty-region incremental scanning — only cells that changed state this step are checked, so alias cost on a stable grid is ~zero
- Chain mode (⛓) — alias fires again on its own outputs, enabling multi-step rewrite cascades
- Up to 8×8 pattern size
- Enable/disable individual aliases at runtime
- **Export** aliases to `.json` — shareable, human-readable
- **Import** aliases from `.json` — merges into current set
- **Clear** removes all aliases at once (with confirmation)

---

## Controls

| Control | Action |
|---|---|
| ▶ Play / ⏸ Pause | Run/pause simulation |
| ⏭ Step | Single step |
| ⟳ Seed | Randomize with coherent clusters |
| ✕ Clear | Empty grid |
| Speed slider | 1–60 FPS |
| Cell slider | 3–14px cell size |
| Brush slider | Brush radius |
| R / G / B buttons | Active paint channels |
| Phase slider | Paint phase angle |
| Bloom toggle | Glow effect on/off |
| ⇄ Aliases | Open alias editor panel |
| Left-click drag | Paint |
| Right-click drag | Erase |

### Alias editor

1. Set pattern size (W × H, up to 8×8)
2. Click a palette swatch to select a color, then click/drag cells to paint
   - Right-click a cell to reset it to dead
   - `?` — alive, any color (A pattern only)
   - `*` — wildcard, matches anything (A pattern only)
3. Paint the **A** (trigger) pattern, then the **B** (replacement) pattern
4. Name it and click **+ Add**

To edit an existing alias click ✎, make changes, then **✓ Save**. ⛓ toggles chain mode. ● / ○ toggles enabled. ✕ deletes.

---

## Example: Spider

`examples/Spider.json` contains a two-alias set that turns a specific shape wildcard pattern into a spider-like structure. To load it:

1. Open the alias panel (⇄ Aliases)
2. Click **↑ Import** and select `examples/Spider.json`
3. Seed the grid (⟳ Seed) and play — the aliases will fire wherever the trigger pattern appears

You can export your own alias sets the same way with **↓ Export**.

---

## Theoretical basis

This project is a simulation of the photonic compute substrate described in the included whitepaper:

> *Starting Over Today for a 1,000,000% Compute Power Boost Over the Best of Tomorrow — A Whitepaper on Photonic Compute Substrates*

https://github.com/A-9-SOVOS/Photonics-2025

Key concepts implemented:

- **Hex-native state** — 6 bits per cell via three wavelength channels with amplitude + phase
- **Bistable switching** — amplitude is 0 or 1 only; no gradual fade (Kerr-effect model)
- **Causal locality** — strictly nearest-neighbor interactions, no global signals
- **WDM (Wavelength-Division Multiplexing)** — independent parallel channels per cell
- **Coherence as computation** — phase alignment between neighbors determines state transitions
- **Propagation as information flow** — coherence waves travel across the grid at the speed of local interaction, analogous to the whitepaper's "information spreads at light speed through the material"

The alias system demonstrates the whitepaper's programming model: *"define local interaction rules... encode computation in the crystal structure itself or in initial light patterns."* Aliases are those rules — pattern-matched rewrites that fire deterministically when conditions are met.

---

## Performance

Tested target: Steam 50th-percentile gaming PC (integrated/entry GPU, ~4-core CPU).

- Step loop: fully inlined phasor math, zero array allocations per cell
- Render: `ImageData` pixel writes (bloom off) or two-pass box-blur composite (bloom on) — bloom buffers allocated once per canvas size, not per frame
- Alias scan: dirty-region bounded — O(changed cells × pattern area), not O(grid size)
- DOM: all element refs cached at startup, stats written every 10 steps (or immediately on alias fire)

---

## Files

```
index.html                        — UI, layout, styles
app.js                            — simulation, rendering, alias engine
examples/Spider.json              — example alias set
Readme.md                         — this file
.github/workflows/deploy.yml      — GitHub Pages deployment
```

No dependencies. No build step. Open `index.html`.
