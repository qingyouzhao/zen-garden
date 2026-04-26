# Zen Garden — Tech Stack Brainstorm

**Goals:** instant playtest from any browser (phone + desktop), no install, touch-friendly, headroom for particle / GPU simulation later.

**Direction decided: 3D.**

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

### 3. Godot (Web export)
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

**Suggested first step:** spike a Three.js + Vite scene with a flat sand plane, an orbit/touch camera, and a point light. Confirm it feels right on phone before committing to the full architecture.

---

## Physics / Simulation Add-ons

| Library | Type | Notes |
|---|---|---|
| **Rapier (WASM)** | Rigid body | Best perf, pairs with any renderer |
| **GPU compute shader** | Particle / sand / fluid | WebGPU compute; Chrome + Safari 18+ |
| **WebGL fragment shader** | Particle / sand | Works everywhere now; lower ceiling |
