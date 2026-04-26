# Zen Garden — Tech Stack Brainstorm

**Goals:** instant playtest from any browser (phone + desktop), no install, touch-friendly, headroom for particle / GPU simulation later.

---

## Evaluation Criteria

| Criterion | Weight |
|---|---|
| Zero-install browser play (iOS Safari, desktop Chrome/Safari) | Must-have |
| Touch + pointer input | Must-have |
| Fast iteration / hot reload | High |
| GPU sim headroom (particles, sand, fluid) | High |
| Bundle size / load time on mobile | Medium |
| 2D rendering quality | Medium |

---

## Options

### 1. PixiJS + WebGL
**Best balance for this project.**

- Hardware-accelerated 2D renderer on top of WebGL; falls back gracefully on older devices.
- Custom GLSL fragment shaders slot in naturally for GPU sand/particle simulation.
- Tiny bundle (~1 MB), fast cold-start on mobile.
- No physics included — pair with **Rapier (WASM)** or **Matter.js** if rigid bodies are needed.
- Large community, well-maintained, v8 is current.

**Verdict:** Strong default choice. Fast to prototype, scales to GPU sim via shaders without switching engines.

---

### 2. Three.js + WebGL/WebGPU
**Best if the game goes 3D or needs compute shaders.**

- 3D capable but works fine as a 2D orthographic scene.
- WebGPU backend (`THREE.WebGPURenderer`) available now — enables compute shaders for real particle/fluid sim on supported browsers.
- Heavier than PixiJS (~3–5 MB), more concepts to manage for a 2D game.
- Physics via **Rapier** or **Cannon.js** add-ons.

**Verdict:** Reach for this if the aesthetic goes 3D/isometric, or if GPU compute sim becomes the core mechanic. Overkill for pure 2D.

---

### 3. Phaser 3
**Best if you want a batteries-included game framework.**

- Full game loop, scene manager, asset pipeline, WebGL renderer, input, camera — all built in.
- Physics via **Matter.js** (built in) or **Arcade** (simple AABB).
- Less GPU compute access than raw WebGL; shader support exists but is secondary.
- Heaviest bundle (~1.3 MB min), but fine on modern mobile.

**Verdict:** Fastest path to a "game" (menus, scenes, assets). GPU sim would feel bolted-on. Best if scope expands to more game-like features.

---

### 4. p5.js
**Best for pure creative-coding prototypes.**

- Minimal syntax, beloved for generative art and simulations.
- CPU-only by default; `p5.js` + a `p5.Graphics` WebGL context is possible but awkward.
- No path to GPU compute; hits CPU limits quickly with large particle counts.

**Verdict:** Great for a one-day proof-of-concept or visual experiment. Not the right long-term foundation if GPU sim is on the roadmap.

---

### 5. Raw WebGL / WebGPU
**Maximum control, steep ramp.**

- WebGPU compute shaders are the best-in-browser option for GPU particle/sand simulation.
- Browser support: Chrome/Edge stable, Safari 18+ (iOS 18 / macOS Sequoia), Firefox behind flag.
- No scene graph, no input helpers, no asset pipeline — build everything.
- Excellent long-term ceiling; poor short-term iteration speed.

**Verdict:** Worth considering if sand simulation becomes a compute-heavy core mechanic. Otherwise, use Three.js or PixiJS to get the WebGL layer without the boilerplate.

---

### 6. Godot (HTML5/Web export)
**Full game engine, but mismatched for this use case.**

- Excellent editor, physics, and scene tools.
- Web exports are large (10–30 MB), load slowly on mobile, and require SharedArrayBuffer (HTTPS + specific headers).
- GPU compute is possible via RenderingDevice but less portable than WebGL shaders.

**Verdict:** Pass. Load time and mobile compatibility conflict directly with the playtest goals.

---

## Recommendation

| If… | Use… |
|---|---|
| Starting now, 2D, want fast iteration | **PixiJS** |
| 3D/isometric aesthetic or GPU compute is central | **Three.js (WebGPU renderer)** |
| Game-like structure matters more than sim depth | **Phaser 3** |
| One-day visual prototype only | **p5.js** |

**Suggested first step:** build a 30-minute PixiJS spike — a canvas with touch-draggable sand raking — and see if the feel is right before committing.

---

## Physics Add-ons (stack-agnostic)

| Library | Type | Notes |
|---|---|---|
| **Rapier (WASM)** | Rigid body | Best perf, runs in browser, pairs with any renderer |
| **Matter.js** | Rigid body | JS-only, easy to start, slower at scale |
| **GPU fragment shader** | Particle / sand | Custom GLSL; no library needed, highest ceiling |
| **WebGPU compute** | Fluid / cellular automata | Best ceiling, requires Chrome/Safari 18+ |
