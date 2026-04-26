# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A small zen garden simulator. The player rakes sand, places stones, and tends a meditative space. No win conditions — only presence. Tech stack and architecture are TBD and should be decided when development begins.

## Git Workflow

Never push directly to `main`. Always work on a feature branch and open a PR for review before merging.

## Operating as an Indie Developer

Work autonomously and ship iteratively. When facing decisions:

1. **Decide without asking** — make the simplest reasonable choice and document it here. Prefer tools and stacks you know well over novel ones.
2. **Build to playable** — get something running before refining. A working prototype reveals more than a perfect plan.
3. **Self-review before committing** — re-read the diff and ask: *Is this the simplest way? Does it introduce complexity the game doesn't need yet?* Cut anything that doesn't earn its place.
4. **Commit small and often** — each commit should leave the game in a runnable state.
5. **Record decisions here** — when you pick a tech stack, architecture pattern, or non-obvious convention, add it to this file so future sessions inherit the context.

Only surface a question to the user when a decision is truly theirs to make (scope, feel, player experience). Implementation choices are yours.

## Stack

**Three.js + Vite** — chosen for prototype speed. 3D scene in the browser, instant HMR via Vite, open on phone via local IP.

Rust + wgpu remains the upgrade path if GPU compute simulation becomes the core mechanic. Migrate then, not now.

## Running the Game

```bash
npm install
npm run dev        # Vite prints a local IP — open that on your phone to playtest (same WiFi)
npm run build      # production bundle → dist/
```

**Live deployment:** every merge to `main` auto-deploys via GitHub Actions to:
`https://qingyouzhao.github.io/zen-garden/`

No local server needed to playtest on phone — just open that URL.

## Architecture

Everything currently lives in `src/main.js` (single-file prototype). Split into modules as the codebase grows — suggested boundaries: `scene.js` (Three.js setup), `rake.js` (rake mesh + drag logic), `input.js` (pointer/touch abstraction).

**Input model:** pointer and touch events both project onto a `THREE.Plane` at y=0 via raycasting. The rake follows that intersection point, clamped to the sand bounds.
