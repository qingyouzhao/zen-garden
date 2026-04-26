# Zen Garden — Project Brainstorm

**Stack decided: Three.js + Vite. 3D. Prioritising prototype speed.**

---

## Features

### Phase 1 — First Playable ✅
*A scene you can open on your phone and interact with.*

- [x] Three.js scene: sand plane, box stone, directional light, shadows
- [x] Rake mesh (handle, head, tines) follows touch/mouse via raycasting
- [x] GitHub Pages auto-deploy on merge to main
- [x] Manual deploy trigger for any branch

### Phase 2 — It Feels Like a Zen Garden
*The core loop: raking sand leaves marks.*

- [ ] Grooves persist across the session; raking over them overwrites
- [ ] Sand ripples curve naturally around stones
- [ ] Multiple stone sizes and irregular shapes
- [ ] Undo last stroke

#### 2a — Mark Mechanism Exploration
*Spike each approach, pick the one that looks and performs best on mobile.*

- [ ] **Canvas texture paint** — draw strokes onto an offscreen 2D canvas used as a `THREE.CanvasTexture` on the sand plane. Fastest to implement; purely 2D.
- [ ] **Displacement map** — write rake depth into a texture, read it in a vertex shader to physically push sand geometry down into grooves. Looks most realistic; requires a subdivided plane.
- [ ] **Custom fragment shader** — store rake history in a render target; shader blends groove lines as a normal/height field. Most flexible long-term; pairs well with a future GPU sim.
- [ ] **Decal projection** — project groove geometry onto the surface as a mesh decal. Easy to layer; less suited to continuous freehand strokes.

#### 2b — Automation Raking Mode
*The rake moves on its own, drawing meditative patterns. Player watches or takes over at any time.*

- [ ] **Straight parallel lines** — rake sweeps back and forth across the full garden at even spacing
- [ ] **Concentric rings** — rake traces expanding circles outward from a point (or around a stone)
- [ ] **Spiral** — single continuous inward or outward Archimedean spiral
- [ ] **Lissajous / parametric** — rake follows a slowly evolving parametric curve for organic, unpredictable patterns
- [ ] Adjustable speed (slow/meditative ↔ fast/satisfying)
- [ ] Player touch interrupts auto-mode and hands control back immediately

### Phase 3 — Atmosphere
*The space feels alive and meditative.*

- [ ] Soft ambient light that shifts with time of day (dawn, midday, dusk, night)
- [ ] Subtle wind — gentle sway on any plants placed in the garden
- [ ] Ambient audio: wind, distant birds, optional water
- [ ] Mist / depth fog that thickens at edges

### Phase 4 — Garden Authoring
*The player builds their own space.*

- [ ] Place, move, and remove stones freely
- [ ] Additional objects: small plant/moss tufts, stone lantern, bamboo stalk
- [ ] Multiple rake head styles (wide flat, narrow, curved tine patterns)
- [ ] Save garden layout to localStorage; restore on reload
- [ ] Export garden as a screenshot

### Phase 5 — Simulation Depth *(GPU upgrade candidate)*
*If the sand sim becomes the core mechanic, revisit Rust + wgpu here.*

- [ ] Particle-based sand that physically displaces when raked
- [ ] Stones cast sand shadows and disturb particles on placement
- [ ] Water element: still pool that reflects the scene
- [ ] Wind scatters fine surface sand slowly over time

---

## Evaluation Criteria

| Criterion | Weight |
|---|---|
| Zero-install browser play (iOS Safari, desktop Chrome/Safari) | Must-have |
| Touch + pointer input | Must-have |
| 3D rendering (scene, lighting, materials) | Must-have |
| GPU sim headroom (particles, sand, fluid) | High |
| Fast iteration / hot reload | High |
| Bundle size / load time on mobile | Medium |

---

## Contenders (3D-only shortlist)

### 1. Three.js + WebGPU renderer
**Recommended.**

- The dominant browser 3D library; massive ecosystem, examples, and community.
- `THREE.WebGPURenderer` (available now, still maturing) unlocks compute shaders for GPU-based sand/particle/fluid simulation.
- Falls back to WebGL on older devices automatically.
- Lightweight core (~600 KB); add what you need.
- No built-in physics — pair with **Rapier (WASM)** for rigid bodies if needed.
- Vite as dev server gives instant HMR and ships a single optimized bundle.

**Verdict:** Best combination of 3D quality, GPU sim ceiling, mobile reach, and iteration speed.

---

### 2. Babylon.js
**Strong alternative if editor tooling matters.**

- More "game engine" than library: scene graph, inspector GUI, asset pipeline, physics (Havok built in) all included.
- Excellent WebGPU support; compute shaders available.
- Heavier bundle (~2–3 MB); inspector is a significant DX advantage for scene debugging.
- Less community content than Three.js; API is more opinionated.

**Verdict:** Reach for this if scene composition and a visual inspector would save meaningful time. Otherwise Three.js has a lighter footprint and wider ecosystem.

---

### 3. Rust + wgpu → WASM
**Highest GPU sim ceiling; real iteration cost.**

wgpu is the Rust implementation of the WebGPU API — the same spec browsers implement. It compiles to WASM and runs in-browser targeting either WebGPU or WebGL2 as a fallback.

**Not blocked:**
- WASM runs on iOS Safari, desktop Chrome/Safari — no install required.
- wgpu's WebGL2 backend covers devices that don't yet support WebGPU.
- Compute shaders are first-class; this is actually the most ergonomic path to heavy GPU sim (sand automata, fluid, SPH particles) of any option here.
- Touch/pointer input is wired via `wasm-bindgen` JS interop — verbose but works fine.

**Real costs:**
- **Iteration speed is the main tax.** Rust recompiles on every change; no hot module reload. Tweaking sand feel or lighting means a 5–30 s compile cycle instead of instant HMR. For a prototype phase where game feel is everything, this adds up.
- No scene graph, no camera controls, no asset pipeline out of the box — build or find crates (`winit`, `glam`, `wgpu` utilities) for everything Three.js gives for free.
- WASM binary for a wgpu app runs 3–8 MB before assets; not a blocker but slower first load on mobile than the JS options.
- `wasm-pack` / `wasm-bindgen` / `trunk` toolchain is mature but more setup than `npm create vite`.

**Verdict:** No hard blockers for browser + mobile deployment. The cost is iteration speed during prototyping — exactly the phase we're in. If GPU simulation is the *core mechanic* (not just a nice-to-have), Rust + wgpu is worth that tax. If sim is secondary to feel and aesthetics, prototype in Three.js and migrate the compute-heavy parts to a WASM module later.

---

### 4. Godot (Web export)
**Still ruled out.**

- Web exports are 10–30 MB and require HTTPS + SharedArrayBuffer headers.
- Mobile cold-start conflicts with the playtest goal.

---

## Recommendation

**Three.js + WebGPU renderer + Vite.**

- Three.js for the 3D scene and rendering.
- Vite for zero-config dev server with HMR; `npm run dev` and open on phone via local IP.
- WebGPU compute shaders for GPU-based simulation when the time comes; falls back to WebGL fragment shaders in the interim.
- Rapier (WASM) on standby for rigid-body physics if stones/objects need it.

**If GPU sim is the core mechanic:** Rust + wgpu is viable and has the highest ceiling. Accept the slower iteration loop and lean into it — write the compute pipeline first, get the sim feeling right, then build scene/rendering around it.

**Suggested first step (Three.js path):** spike a Vite scene with a flat sand plane, orbit/touch camera, and a point light. Confirm it feels right on phone before committing to the full architecture.

**Suggested first step (Rust path):** get a WASM build running in the browser with `trunk`, render a flat plane via wgpu, confirm touch input reaches Rust code. That smoke test reveals the real iteration friction before you commit.

---

## Physics / Simulation Add-ons

| Library | Type | Notes |
|---|---|---|
| **Rapier (WASM)** | Rigid body | Best perf, pairs with any renderer |
| **GPU compute shader** | Particle / sand / fluid | WebGPU compute; Chrome + Safari 18+ |
| **WebGL fragment shader** | Particle / sand | Works everywhere now; lower ceiling |
