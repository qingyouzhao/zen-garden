# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A small, browser-based zen garden simulator. The player rakes sand into patterns, places and moves stones, and tends a meditative space. The tone is calm, tactile, and unhurried. There are no win conditions — only presence.

## Tech Stack

- **Vanilla JavaScript + HTML5 Canvas** — no framework, no build step, zero dependencies. Open `index.html` and it runs.
- Single-page, single-canvas. All state lives in memory; localStorage is used only for saving the garden layout.
- ES modules via `<script type="module">` so files can be split without a bundler.

## Running the Game

```bash
npx serve .          # or: python3 -m http.server 8080
```

Open `http://localhost:3000` (or 8080). No install step.

## Architecture

```
index.html           # canvas element + script entry
src/
  main.js            # boot: creates Game, wires input, starts loop
  game.js            # Game class — owns state, update(), draw() per frame
  garden.js          # Garden — sand grid, rake strokes, sand-pattern math
  entities.js        # Stone, Plant, Lantern — placeable objects
  input.js           # Mouse/touch unified pointer events → intent objects
  renderer.js        # All canvas draw calls; game.js hands it state
  save.js            # serialize/deserialize garden to localStorage
assets/
  sounds/            # ambient audio (optional, lazy-loaded)
  textures/          # any PNG sprite sheets if needed
```

**Data flow:** `input.js` emits intents → `game.js` applies them to `garden.js` / entities → `renderer.js` draws the result. `game.js` is the only file that imports from all others.

**Sand grid:** The garden surface is a 2D array of cells. Each cell stores rake direction (angle) or `null` (unraked). The renderer reads cell angles to draw parallel lines that simulate raked sand. Stroke paths update cells along a brush radius.

## Development Conventions

- Keep each source file under ~200 lines. Split when it grows.
- No classes required for simple data — plain objects with factory functions are fine.
- Pixel dimensions: target a 1200×800 logical canvas, scaled via `devicePixelRatio` for sharpness.
- 60 fps game loop via `requestAnimationFrame`; `update(dt)` receives delta time in seconds.
- Color palette should stay muted and earthy — no bright UI chrome.

## Autonomous Operation Guidelines

When implementing features, follow this order without asking:

1. **Decide** — pick the simplest approach that fits the architecture above.
2. **Build** — write the code, keep files small, no premature abstraction.
3. **Self-review** — before committing, re-read the diff and ask: *Does this feel calm and coherent? Does it introduce complexity the game doesn't need yet?*
4. **Commit** — small, descriptive commits. Push when a feature is playable, not just compiling.
5. **Note blockers** — if genuinely stuck on a design question (not an implementation detail), leave a `// TODO:` comment and move on.

Default to shipping something playable over designing something perfect.
