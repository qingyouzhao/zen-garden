import * as THREE from 'three';
import { buildControlsUI } from './sim-controls.js';

// --- Scene setup ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1612);
scene.fog = new THREE.Fog(0x1a1612, 20, 40);

// Fixed angled camera — feels like looking down at a garden tray
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 10, 10);
camera.lookAt(0, 0, 0);

// --- Lighting ---
const ambient = new THREE.AmbientLight(0xfff5e0, 0.6);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xfff0cc, 1.4);
sun.position.set(5, 12, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun);

// --- Heightmap sand simulation ---
// 64x64 cells over 14x14 world units
const GRID = 64;              // number of cells per side
const VERTS = GRID + 1;       // number of vertices per side (65x65)
const WORLD_SIZE = 14;        // world units
const CELL_SIZE = WORLD_SIZE / GRID;  // ≈ 0.21875 units

// Repose angle: ~30 degrees → tan(30°) ≈ 0.577
let TAN_REPOSE = Math.tan(Math.PI / 6);

// Height array — row-major, index = row * VERTS + col
const heightmap = new Float32Array(VERTS * VERTS);

// Dirty-region tracking: we maintain a bounding box of disturbed cells
// expanded each frame until sand settles
let dirtyMinI = VERTS, dirtyMaxI = -1;
let dirtyMinJ = VERTS, dirtyMaxJ = -1;
let maxTransfer = 0;  // largest height transfer this relaxation pass

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

// Convert world X,Z to grid indices (clamped)
function worldToGrid(wx, wz) {
  const i = Math.floor((wx + WORLD_SIZE / 2) / WORLD_SIZE * GRID);
  const j = Math.floor((wz + WORLD_SIZE / 2) / WORLD_SIZE * GRID);
  return [
    Math.max(0, Math.min(GRID - 1, i)),
    Math.max(0, Math.min(GRID - 1, j))
  ];
}

// Heightmap index for vertex at (i, j) — i = column, j = row
function idx(i, j) {
  return j * VERTS + i;
}

// --- Sand geometry ---
// PlaneGeometry rows/cols = segment counts (GRID x GRID = 64x64 segments, 65x65 verts)
const sandGeo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, GRID, GRID);
// PlaneGeometry is in XY plane, we rotate it to XZ; vertices laid out row-major by Three.js
// After rotation the geometry is XZ-plane. We will update vertex positions directly.
const sandMat = new THREE.MeshLambertMaterial({
  color: 0xc8b89a,
  side: THREE.FrontSide,
});
const sand = new THREE.Mesh(sandGeo, sandMat);
sand.rotation.x = -Math.PI / 2;
sand.receiveShadow = true;
scene.add(sand);

// Cache reference to position attribute for fast updates
const posAttr = sandGeo.attributes.position;

// Apply heightmap to geometry vertices
// Three.js PlaneGeometry (before rotation) lays verts left→right, top→bottom in XY
// X goes -7..+7 (col index 0..GRID), Y goes +7..-7 (row index 0..GRID)
// After rotation.x = -PI/2: world_x = geom_x, world_z = -geom_y
//   → geom row 0 (y=+7) → world z = -7  → gridJ = 0
//   → geom row GRID (y=-7) → world z = +7 → gridJ = GRID
// worldToGrid uses j = floor((wz + 7) / 14 * 64), so j=0 at wz=-7, j=63 at wz≈+7
// gridJ = row keeps this consistent (no Z-axis flip).
function applyHeightmap() {
  let vi = 0;
  for (let row = 0; row <= GRID; row++) {
    for (let col = 0; col <= GRID; col++) {
      const gridI = col;
      const gridJ = row;  // row 0 (world z=-7) → j=0, consistent with worldToGrid
      const h = heightmap[idx(gridI, gridJ)];
      posAttr.setZ(vi, h);  // Z in unrotated plane becomes Y in world after rotation
      vi++;
    }
  }
  posAttr.needsUpdate = true;
  sandGeo.computeVertexNormals();
}

// Relaxation pass over dirty region
// Runs 4 iterations per call for faster convergence
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

        // Check 4 orthogonal neighbors
        const neighbors = [
          idx(i + 1, j),
          idx(i - 1, j),
          idx(i, j + 1),
          idx(i, j - 1),
        ];

        for (const n of neighbors) {
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

// --- Stone ---
const stone = new THREE.Mesh(
  new THREE.BoxGeometry(1.2, 0.7, 1.0),
  new THREE.MeshLambertMaterial({ color: 0x666055 })
);
stone.position.set(1.5, 0.35, 0.5);
stone.castShadow = true;
scene.add(stone);

// --- Rake ---
const rakeGroup = new THREE.Group();

const handle = new THREE.Mesh(
  new THREE.CylinderGeometry(0.04, 0.04, 3.5, 8),
  new THREE.MeshLambertMaterial({ color: 0x8b5e3c })
);
handle.rotation.x = Math.PI / 4; // tilt forward
handle.position.set(0, 1.327, 1.237);
rakeGroup.add(handle);

const head = new THREE.Mesh(
  new THREE.BoxGeometry(1.2, 0.06, 0.12),
  new THREE.MeshLambertMaterial({ color: 0x6b4c2a })
);
head.position.set(0, 0.06, 0);
rakeGroup.add(head);

// 5 tines spaced 0.26 apart
const TINE_OFFSETS = [-2, -1, 0, 1, 2].map(i => i * 0.26);
let TINE_DEPTH = 0.15;   // how deep the groove is
let TINE_RADIUS = 0.10;  // world-unit radius of each tine's influence
let RELAX_ITERS = 4;

for (let i = -2; i <= 2; i++) {
  const tine = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.015, 0.22, 6),
    new THREE.MeshLambertMaterial({ color: 0x5a3e20 })
  );
  tine.position.set(i * 0.26, -0.09, 0);
  rakeGroup.add(tine);
}

rakeGroup.position.set(0, 0, 2);
scene.add(rakeGroup);

// --- Input: drag rake along the sand plane ---
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const target = new THREE.Vector3();
let dragging = false;

// Track previous rake position for displacement direction
const prevRakePos = new THREE.Vector3(0, 0, 2);

function updatePointer(clientX, clientY) {
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
}

function onDown(clientX, clientY) {
  dragging = true;
  updatePointer(clientX, clientY);
}

// Displace sand under rake tines and deposit ahead
function displaceWithRake(rakeX, rakeZ, dx, dz) {
  const moveDist = Math.sqrt(dx * dx + dz * dz);
  if (moveDist < 0.001) return;

  // Unit direction of motion
  const ndx = dx / moveDist;
  const ndz = dz / moveDist;

  // Tine radius in grid cells
  const tineRadiusCells = Math.ceil(TINE_RADIUS / CELL_SIZE) + 1;
  // Deposit offset: 2-3 cells ahead in direction of motion
  const depositOffset = 2.5 * CELL_SIZE;

  for (const tineOX of TINE_OFFSETS) {
    // Tine world position — offset perpendicular to motion
    // Perpendicular to (ndx, ndz) is (-ndz, ndx)
    const tineWX = rakeX + tineOX * (-ndz);
    const tineWZ = rakeZ + tineOX * ndx;

    const [ti, tj] = worldToGrid(tineWX, tineWZ);

    // Groove: subtract height in cells near the tine
    let totalRemoved = 0;

    for (let di = -tineRadiusCells; di <= tineRadiusCells; di++) {
      for (let dj = -tineRadiusCells; dj <= tineRadiusCells; dj++) {
        const ci = ti + di;
        const cj = tj + dj;
        if (ci < 0 || ci >= VERTS || cj < 0 || cj >= VERTS) continue;

        // World position of this cell
        const cwx = (ci / GRID) * WORLD_SIZE - WORLD_SIZE / 2;
        const cwz = (cj / GRID) * WORLD_SIZE - WORLD_SIZE / 2;
        const dist = Math.sqrt((cwx - tineWX) ** 2 + (cwz - tineWZ) ** 2);

        if (dist < TINE_RADIUS) {
          // Smooth falloff within the tine radius
          const falloff = 1 - dist / TINE_RADIUS;
          const removal = TINE_DEPTH * falloff;
          const cellIdx = idx(ci, cj);
          const actual = Math.min(removal, heightmap[cellIdx] + 0.3); // don't dig below -0.3
          heightmap[cellIdx] -= actual;
          totalRemoved += actual;
          markDirty(ci, cj);
        }
      }
    }

    // Deposit removed sand 2-3 cells ahead
    const depWX = tineWX + ndx * depositOffset;
    const depWZ = tineWZ + ndz * depositOffset;
    const [di2, dj2] = worldToGrid(depWX, depWZ);

    // Distribute over a small area
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

function onMove(clientX, clientY) {
  if (!dragging) return;
  updatePointer(clientX, clientY);
  raycaster.setFromCamera(pointer, camera);
  raycaster.ray.intersectPlane(groundPlane, target);
  // Clamp to sand bounds
  target.x = Math.max(-6.5, Math.min(6.5, target.x));
  target.z = Math.max(-6.5, Math.min(6.5, target.z));

  const dx = target.x - prevRakePos.x;
  const dz = target.z - prevRakePos.z;

  displaceWithRake(target.x, target.z, dx, dz);

  prevRakePos.set(target.x, prevRakePos.y, target.z);

  // Position rake on sand surface
  const [ri, rj] = worldToGrid(target.x, target.z);
  const surfaceH = heightmap[idx(ri, rj)];
  rakeGroup.position.set(target.x, surfaceH, target.z);

  // Orient rake in direction of motion
  const moveDist = Math.sqrt(dx * dx + dz * dz);
  if (moveDist > 0.005) {
    rakeGroup.rotation.y = Math.atan2(dx, dz);
  }
}

function onUp() { dragging = false; }

// Mouse
renderer.domElement.addEventListener('mousedown', e => onDown(e.clientX, e.clientY));
renderer.domElement.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
renderer.domElement.addEventListener('mouseup', onUp);

// Touch
renderer.domElement.addEventListener('touchstart', e => {
  e.preventDefault();
  onDown(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: false });
renderer.domElement.addEventListener('touchmove', e => {
  e.preventDefault();
  onMove(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: false });
renderer.domElement.addEventListener('touchend', onUp);

// --- Resize ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Loop ---
let SETTLE_THRESHOLD = 0.0001;  // stop expanding dirty region when stable

function animate() {
  requestAnimationFrame(animate);

  if (hasDirty()) {
    // Run relaxation iterations on the dirty region
    relaxSand(RELAX_ITERS);

    // Grow the dirty region each frame so slumping propagates outward
    if (maxTransfer > SETTLE_THRESHOLD) {
      expandDirty(2);
    } else {
      // Sand has settled in this region — clear dirty
      clearDirty();
    }

    applyHeightmap();
  }

  renderer.render(scene, camera);
}
animate();

buildControlsUI([
  { label: 'Groove Depth',       value: TINE_DEPTH,        min: 0.02, max: 0.4,  step: 0.01,  onChange: v => { TINE_DEPTH        = v; } },
  { label: 'Groove Width',       value: TINE_RADIUS,       min: 0.03, max: 0.4,  step: 0.01,  onChange: v => { TINE_RADIUS       = v; } },
  { label: 'Repose Angle',       value: TAN_REPOSE,        min: 0.1,  max: 1.5,  step: 0.05,  onChange: v => { TAN_REPOSE        = v; } },
  { label: 'Relax Passes',       value: RELAX_ITERS,       min: 1,    max: 10,   step: 1,     onChange: v => { RELAX_ITERS       = Math.round(v); } },
  { label: 'Settle Threshold',   value: SETTLE_THRESHOLD,  min: 0.00001, max: 0.01, step: 0.00001, onChange: v => { SETTLE_THRESHOLD = v; } },
], () => {
  heightmap.fill(0);
  clearDirty();
  applyHeightmap();
});
