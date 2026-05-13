import * as THREE from 'three';
import { createScene } from './scene.js';
import { makeStone } from './stone.js';
import { buildRake } from './rake.js';
import { createPointerInput } from './input.js';

const { renderer, scene, camera } = createScene();

// --- Heightmap sand simulation ---
// 64x64 cells over 14x14 world units
const GRID = 64;
const VERTS = GRID + 1;
const WORLD_SIZE = 14;
const CELL_SIZE = WORLD_SIZE / GRID;

// Repose angle: ~30 degrees → tan(30°) ≈ 0.577
let TAN_REPOSE = Math.tan(Math.PI / 6);

const heightmap = new Float32Array(VERTS * VERTS);

// Dirty-region tracking
let dirtyMinI = VERTS, dirtyMaxI = -1;
let dirtyMinJ = VERTS, dirtyMaxJ = -1;
let maxTransfer = 0;

function markDirty(i, j) {
  dirtyMinI = Math.min(dirtyMinI, i);
  dirtyMaxI = Math.max(dirtyMaxI, i);
  dirtyMinJ = Math.min(dirtyMinJ, j);
  dirtyMaxJ = Math.max(dirtyMaxJ, j);
}

function hasDirty() {
  return dirtyMaxI >= dirtyMinI && dirtyMaxJ >= dirtyMinJ;
}

function expandDirty(amount) {
  if (!hasDirty()) return;
  dirtyMinI = Math.max(0, dirtyMinI - amount);
  dirtyMaxI = Math.min(VERTS - 1, dirtyMaxI + amount);
  dirtyMinJ = Math.max(0, dirtyMinJ - amount);
  dirtyMaxJ = Math.min(VERTS - 1, dirtyMaxJ + amount);
}

function clearDirty() {
  dirtyMinI = VERTS; dirtyMaxI = -1;
  dirtyMinJ = VERTS; dirtyMaxJ = -1;
}

function worldToGrid(wx, wz) {
  const i = Math.floor((wx + WORLD_SIZE / 2) / WORLD_SIZE * GRID);
  const j = Math.floor((wz + WORLD_SIZE / 2) / WORLD_SIZE * GRID);
  return [
    Math.max(0, Math.min(GRID - 1, i)),
    Math.max(0, Math.min(GRID - 1, j))
  ];
}

function idx(i, j) {
  return j * VERTS + i;
}

// --- Sand geometry ---
const sandGeo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, GRID, GRID);
const sandMat = new THREE.MeshLambertMaterial({ color: 0xc8b89a, side: THREE.FrontSide });
const sand = new THREE.Mesh(sandGeo, sandMat);
sand.rotation.x = -Math.PI / 2;
sand.receiveShadow = true;
scene.add(sand);

const posAttr = sandGeo.attributes.position;

// Apply heightmap to geometry vertices
// After rotation.x = -PI/2: geom Z (setZ) becomes world Y displacement
function applyHeightmap() {
  let vi = 0;
  for (let row = 0; row <= GRID; row++) {
    for (let col = 0; col <= GRID; col++) {
      posAttr.setZ(vi, heightmap[idx(col, row)]);
      vi++;
    }
  }
  posAttr.needsUpdate = true;
  sandGeo.computeVertexNormals();
}

// 4-iteration Gauss-Seidel repose-angle relaxation over dirty region
function relaxSand(iterations) {
  if (!hasDirty()) return;

  const minI = Math.max(1, dirtyMinI);
  const maxI = Math.min(VERTS - 2, dirtyMaxI);
  const minJ = Math.max(1, dirtyMinJ);
  const maxJ = Math.min(VERTS - 2, dirtyMaxJ);

  const threshold = TAN_REPOSE * CELL_SIZE;
  maxTransfer = 0;

  for (let iter = 0; iter < iterations; iter++) {
    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i <= maxI; i++) {
        const c = idx(i, j);
        const h = heightmap[c];

        for (const n of [idx(i + 1, j), idx(i - 1, j), idx(i, j + 1), idx(i, j - 1)]) {
          const diff = h - heightmap[n];
          if (diff > threshold) {
            const transfer = (diff - threshold) * 0.5;
            heightmap[c] -= transfer;
            heightmap[n] += transfer;
            if (transfer > maxTransfer) maxTransfer = transfer;
          }
        }
      }
    }
  }
}

scene.add(makeStone());

// --- Rake ---
const rakeGroup = buildRake();
rakeGroup.position.set(0, 0, 2);
scene.add(rakeGroup);

const TINE_OFFSETS = [-2, -1, 0, 1, 2].map(i => i * 0.26);
let TINE_DEPTH = 0.15;
let TINE_RADIUS = 0.10;

function displaceWithRake(rakeX, rakeZ, dx, dz) {
  const moveDist = Math.sqrt(dx * dx + dz * dz);
  if (moveDist < 0.001) return;

  const ndx = dx / moveDist;
  const ndz = dz / moveDist;

  const tineRadiusCells = Math.ceil(TINE_RADIUS / CELL_SIZE) + 1;
  const depositOffset = 2.5 * CELL_SIZE;

  for (const tineOX of TINE_OFFSETS) {
    const tineWX = rakeX + tineOX * (-ndz);
    const tineWZ = rakeZ + tineOX * ndx;

    const [ti, tj] = worldToGrid(tineWX, tineWZ);
    let totalRemoved = 0;

    for (let di = -tineRadiusCells; di <= tineRadiusCells; di++) {
      for (let dj = -tineRadiusCells; dj <= tineRadiusCells; dj++) {
        const ci = ti + di;
        const cj = tj + dj;
        if (ci < 0 || ci >= VERTS || cj < 0 || cj >= VERTS) continue;

        const cwx = (ci / GRID) * WORLD_SIZE - WORLD_SIZE / 2;
        const cwz = (cj / GRID) * WORLD_SIZE - WORLD_SIZE / 2;
        const dist = Math.sqrt((cwx - tineWX) ** 2 + (cwz - tineWZ) ** 2);

        if (dist < TINE_RADIUS) {
          const falloff = 1 - dist / TINE_RADIUS;
          const removal = TINE_DEPTH * falloff;
          const cellIdx = idx(ci, cj);
          const actual = Math.min(removal, heightmap[cellIdx] + 0.3);
          heightmap[cellIdx] -= actual;
          totalRemoved += actual;
          markDirty(ci, cj);
        }
      }
    }

    const depWX = tineWX + ndx * depositOffset;
    const depWZ = tineWZ + ndz * depositOffset;
    const [di2, dj2] = worldToGrid(depWX, depWZ);

    const depositCells = [];
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const ci = di2 + di;
        const cj = dj2 + dj;
        if (ci >= 0 && ci < VERTS && cj >= 0 && cj < VERTS) {
          depositCells.push([ci, cj]);
        }
      }
    }

    if (depositCells.length > 0 && totalRemoved > 0) {
      const share = totalRemoved / depositCells.length;
      for (const [ci, cj] of depositCells) {
        heightmap[idx(ci, cj)] += share;
        markDirty(ci, cj);
      }
    }
  }
}

createPointerInput(camera, renderer.domElement, {
  onMove(x, z, dx, dz) {
    displaceWithRake(x, z, dx, dz);

    const [ri, rj] = worldToGrid(x, z);
    const surfaceH = heightmap[idx(ri, rj)];
    rakeGroup.position.set(x, surfaceH, z);

    const moveDist = Math.sqrt(dx * dx + dz * dz);
    if (moveDist > 0.005) rakeGroup.rotation.y = Math.atan2(dx, dz);
  },
});

// --- Loop ---
const SETTLE_THRESHOLD = 0.0001;
let SETTLE_ITERS = 4;

window.__sandControls = {
  setRepose(deg)      { TAN_REPOSE = Math.tan(deg * Math.PI / 180); },
  setTineDepth(v)     { TINE_DEPTH = v; },
  setTineRadius(v)    { TINE_RADIUS = v; },
  setSettleIters(v)   { SETTLE_ITERS = v; },
};

function animate() {
  requestAnimationFrame(animate);

  if (hasDirty()) {
    relaxSand(SETTLE_ITERS);
    if (maxTransfer > SETTLE_THRESHOLD) {
      expandDirty(2);
    } else {
      clearDirty();
    }
    applyHeightmap();
  }

  renderer.render(scene, camera);
}
animate();
