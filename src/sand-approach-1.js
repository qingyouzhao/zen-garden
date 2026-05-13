import * as THREE from 'three';
import { createScene } from './scene.js';
import { makeStone } from './stone.js';
import { buildRake } from './rake.js';
import { createPointerInput } from './input.js';

const { renderer, scene, camera } = createScene();

// --- Heightmap sand ---
const GRID = 128;           // cells per side
const WORLD = 14;           // world-unit side length
const VERTS = GRID + 1;     // vertices per side (129)
const CELL = WORLD / GRID;  // ≈ 0.109 units per cell

const heightmap = new Float32Array(VERTS * VERTS);

const sandGeo = new THREE.PlaneGeometry(WORLD, WORLD, GRID, GRID);
sandGeo.rotateX(-Math.PI / 2);

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

const sand = new THREE.Mesh(sandGeo, new THREE.MeshLambertMaterial({ color: 0xc8b89a }));
sand.receiveShadow = true;
scene.add(sand);

scene.add(makeStone());

const rakeGroup = buildRake();
rakeGroup.position.set(0, 0, 2);
scene.add(rakeGroup);

// --- Rake displacement parameters ---
let GROOVE_DEPTH  = 0.12;
let GROOVE_RADIUS = 0.8;   // in cell units
let RIDGE_WIDTH   = 2;     // cells out from tine centre on each side
let MAX_HEIGHT    = 0.35;
const MIN_HEIGHT  = -0.12;
const TINE_POSITIONS = [-2, -1, 0, 1, 2].map(i => i * 0.26);

function applyRakeDisplacement(rakeX, rakeZ, dx, dz) {
  const moveLen = Math.sqrt(dx * dx + dz * dz);
  if (moveLen < 1e-5) return;

  const tx = dx / moveLen, tz = dz / moveLen;
  const px = -tz, pz = tx;

  for (const tineOffset of TINE_POSITIONS) {
    const tineWorldX = rakeX + tineOffset * px;
    const tineWorldZ = rakeZ + tineOffset * pz;

    const col0 = (tineWorldX + WORLD / 2) / WORLD * GRID;
    const row0 = (tineWorldZ + WORLD / 2) / WORLD * GRID;

    let volumeRemoved = 0;

    const r = Math.ceil(GROOVE_RADIUS) + 1;
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        const dist = Math.sqrt(dr * dr + dc * dc);
        if (dist > GROOVE_RADIUS) continue;
        const row = Math.round(row0) + dr;
        const col = Math.round(col0) + dc;
        if (row < 0 || row >= VERTS || col < 0 || col >= VERTS) continue;

        const vi = row * VERTS + col;
        const weight = 1 - (dist / GROOVE_RADIUS);
        const removal = GROOVE_DEPTH * weight;
        const before = heightmap[vi];
        heightmap[vi] = Math.max(MIN_HEIGHT, heightmap[vi] - removal);
        volumeRemoved += before - heightmap[vi];
      }
    }

    if (volumeRemoved <= 0) continue;

    const ridgeCells = [];
    for (let side = -1; side <= 1; side += 2) {
      for (let d = 1; d <= RIDGE_WIDTH; d++) {
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

createPointerInput(camera, renderer.domElement, {
  onMove(x, z, dx, dz) {
    applyRakeDisplacement(x, z, dx, dz);
    flushHeightmap();

    const surfaceY = sampleHeight(x, z);
    rakeGroup.position.set(x, surfaceY, z);

    const moveLen = Math.sqrt(dx * dx + dz * dz);
    if (moveLen > 1e-5) rakeGroup.rotation.y = Math.atan2(dx, dz);
  },
});

window.__sandControls = {
  setGrooveDepth(v)  { GROOVE_DEPTH = v; },
  setGrooveRadius(v) { GROOVE_RADIUS = v; },
  setRidgeWidth(v)   { RIDGE_WIDTH = v; },
  setMaxHeight(v)    { MAX_HEIGHT = v; },
};

// --- Loop ---
function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
