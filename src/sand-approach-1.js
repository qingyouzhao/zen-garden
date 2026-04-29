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

// --- Heightmap sand ---
const GRID = 128;           // cells per side
const WORLD = 14;           // world-unit side length
const VERTS = GRID + 1;     // vertices per side (129)
const CELL = WORLD / GRID;  // ≈ 0.109 units per cell

// Flat heightmap — all zeros initially
const heightmap = new Float32Array(VERTS * VERTS);

// Build subdivided plane (rotated from XZ to XY then we'll position in world)
const sandGeo = new THREE.PlaneGeometry(WORLD, WORLD, GRID, GRID);
sandGeo.rotateX(-Math.PI / 2);

// Apply heightmap values to geometry positions buffer
function flushHeightmap() {
  const pos = sandGeo.attributes.position;
  for (let row = 0; row < VERTS; row++) {
    for (let col = 0; col < VERTS; col++) {
      const vi = row * VERTS + col;
      pos.setY(vi, heightmap[vi]);
    }
  }
  pos.needsUpdate = true;
  sandGeo.computeVertexNormals();
}

const sandMat = new THREE.MeshLambertMaterial({ color: 0xc8b89a });
const sand = new THREE.Mesh(sandGeo, sandMat);
sand.receiveShadow = true;
scene.add(sand);

// --- Stone (box) — fixed position, unaffected by heightmap ---
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

// 5 tines, spaced 0.26 apart (matching original)
const TINE_POSITIONS = [-2, -1, 0, 1, 2].map(i => i * 0.26);

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

// --- Rake displacement parameters ---
let GROOVE_DEPTH  = 0.12;   // how deep a tine carves (volume subtracted per tine footprint)
let GROOVE_RADIUS = 0.8;    // in cell units — radius of the circular tine footprint
let RIDGE_WIDTH   = 2;      // cells out from tine centre on each perpendicular side
let MAX_HEIGHT    = 0.35;   // clamp ceiling for piled sand
const MIN_HEIGHT  = -0.12;  // floor (just below surface)

/**
 * Apply one rake step.
 * rakeX, rakeZ  — current rake world position
 * dx, dz        — movement delta this frame (world units)
 */
function applyRakeDisplacement(rakeX, rakeZ, dx, dz) {
  const moveLen = Math.sqrt(dx * dx + dz * dz);
  if (moveLen < 1e-5) return;

  // Unit travel direction and perpendicular
  const tx = dx / moveLen, tz = dz / moveLen;
  const px = -tz, pz = tx; // perpendicular (left side of travel)

  for (const tineOffset of TINE_POSITIONS) {
    // World position of this tine
    // Tines are arranged along the rake head's local X axis.
    // We need to map tine local-X into world space.
    // The rake head faces its travel direction, so the head's X axis is the perpendicular.
    const tineWorldX = rakeX + tineOffset * px;
    const tineWorldZ = rakeZ + tineOffset * pz;

    // Convert to grid cell indices
    const col0 = (tineWorldX + WORLD / 2) / WORLD * GRID;
    const row0 = (tineWorldZ + WORLD / 2) / WORLD * GRID;

    // Accumulate volume removed so we can deposit it conserved
    let volumeRemoved = 0;

    // --- Groove: subtract from cells within GROOVE_RADIUS of tine ---
    const r = Math.ceil(GROOVE_RADIUS) + 1;
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        const dist = Math.sqrt(dr * dr + dc * dc);
        if (dist > GROOVE_RADIUS) continue;
        const row = Math.round(row0) + dr;
        const col = Math.round(col0) + dc;
        if (row < 0 || row >= VERTS || col < 0 || col >= VERTS) continue;

        const vi = row * VERTS + col;
        // Gaussian-shaped taper so groove edge is smooth
        const weight = 1 - (dist / GROOVE_RADIUS);
        const removal = GROOVE_DEPTH * weight;
        const before = heightmap[vi];
        heightmap[vi] = Math.max(MIN_HEIGHT, heightmap[vi] - removal);
        volumeRemoved += before - heightmap[vi];
      }
    }

    if (volumeRemoved <= 0) continue;

    // --- Ridge: deposit removed volume in cells perpendicular to travel ---
    // Ridge band: RIDGE_WIDTH cells to each side of the tine, along the perpendicular.
    // px/pz are unit-vector components; one cell step in world = CELL units,
    // so one cell step in grid-coords = 1 cell. We step along perpendicular in
    // world space and convert: gridStep = worldStep / CELL.
    const ridgeCells = [];
    for (let side = -1; side <= 1; side += 2) {
      for (let d = 1; d <= RIDGE_WIDTH; d++) {
        // Move d * CELL world units along perpendicular → d grid cells
        const ridgeRow = Math.round(row0 + side * d * pz);
        const ridgeCol = Math.round(col0 + side * d * px);
        if (ridgeRow < 0 || ridgeRow >= VERTS || ridgeCol < 0 || ridgeCol >= VERTS) continue;
        ridgeCells.push({ row: ridgeRow, col: ridgeCol, weight: 1 / d });
      }
    }

    if (ridgeCells.length === 0) continue;

    const totalWeight = ridgeCells.reduce((s, c) => s + c.weight, 0);
    for (const { row, col, weight } of ridgeCells) {
      const vi = row * VERTS + col;
      const deposit = volumeRemoved * (weight / totalWeight);
      heightmap[vi] = Math.min(MAX_HEIGHT, heightmap[vi] + deposit);
    }
  }
}

// --- Sample heightmap at world (x, z) — bilinear interpolation ---
function sampleHeight(x, z) {
  const fc = (x + WORLD / 2) / WORLD * GRID;
  const fr = (z + WORLD / 2) / WORLD * GRID;
  const c0 = Math.floor(fc), r0 = Math.floor(fr);
  const c1 = Math.min(c0 + 1, GRID), r1 = Math.min(r0 + 1, GRID);
  const tc = fc - c0, tr = fr - r0;

  const h00 = heightmap[r0 * VERTS + c0];
  const h10 = heightmap[r0 * VERTS + c1];
  const h01 = heightmap[r1 * VERTS + c0];
  const h11 = heightmap[r1 * VERTS + c1];
  return h00 * (1 - tc) * (1 - tr) +
         h10 * tc       * (1 - tr) +
         h01 * (1 - tc) * tr +
         h11 * tc       * tr;
}

// --- Input: drag rake along the sand plane ---
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const target = new THREE.Vector3();
let dragging = false;

// Track previous rake XZ for delta computation
let prevRakeX = rakeGroup.position.x;
let prevRakeZ = rakeGroup.position.z;

function updatePointer(clientX, clientY) {
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
}

function onDown(clientX, clientY) {
  dragging = true;
  updatePointer(clientX, clientY);
  // Sync prev position so first move delta is correct
  prevRakeX = rakeGroup.position.x;
  prevRakeZ = rakeGroup.position.z;
}

function onMove(clientX, clientY) {
  if (!dragging) return;
  updatePointer(clientX, clientY);
  raycaster.setFromCamera(pointer, camera);
  raycaster.ray.intersectPlane(groundPlane, target);
  // Clamp to sand bounds
  target.x = Math.max(-6.5, Math.min(6.5, target.x));
  target.z = Math.max(-6.5, Math.min(6.5, target.z));

  const newX = target.x, newZ = target.z;
  const dx = newX - prevRakeX, dz = newZ - prevRakeZ;

  // Displace heightmap under tines
  applyRakeDisplacement(newX, newZ, dx, dz);
  flushHeightmap();

  // Lift rake to sit on the sand surface at its position
  const surfaceY = sampleHeight(newX, newZ);
  rakeGroup.position.set(newX, surfaceY, newZ);

  // Rotate rake to face direction of travel
  const moveLen = Math.sqrt(dx * dx + dz * dz);
  if (moveLen > 1e-5) {
    rakeGroup.rotation.y = Math.atan2(dx, dz);
  }

  prevRakeX = newX;
  prevRakeZ = newZ;
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
function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();

buildControlsUI([
  { label: 'Groove Depth',  value: GROOVE_DEPTH,  min: 0.01, max: 0.30, step: 0.01, onChange: v => { GROOVE_DEPTH  = v; } },
  { label: 'Groove Radius', value: GROOVE_RADIUS, min: 0.2,  max: 2.0,  step: 0.1,  onChange: v => { GROOVE_RADIUS = v; } },
  { label: 'Ridge Width',   value: RIDGE_WIDTH,   min: 1,    max: 6,    step: 1,    onChange: v => { RIDGE_WIDTH   = v; } },
  { label: 'Max Pile',      value: MAX_HEIGHT,    min: 0.1,  max: 0.8,  step: 0.05, onChange: v => { MAX_HEIGHT    = v; } },
], () => {
  heightmap.fill(0);
  flushHeightmap();
});
