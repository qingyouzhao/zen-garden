import * as THREE from 'three';

// ─── Renderer ────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// ─── Scene ───────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1612);
scene.fog = new THREE.Fog(0x1a1612, 20, 40);

// Fixed angled camera — feels like looking down at a garden tray
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 10, 10);
camera.lookAt(0, 0, 0);

// ─── Lighting ────────────────────────────────────────────────────────────────
const ambient = new THREE.AmbientLight(0xfff5e0, 0.6);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xfff0cc, 1.4);
sun.position.set(5, 12, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun);

// Point light close to the surface — makes displacement visible in Mode 2
const graze = new THREE.PointLight(0xffe8b0, 2.5, 18);
graze.position.set(-4, 1.2, -3);
scene.add(graze);

// ─── Stone ───────────────────────────────────────────────────────────────────
const stone = new THREE.Mesh(
  new THREE.BoxGeometry(1.2, 0.7, 1.0),
  new THREE.MeshLambertMaterial({ color: 0x666055 })
);
stone.position.set(1.5, 0.35, 0.5);
stone.castShadow = true;
scene.add(stone);

// ─── Rake ────────────────────────────────────────────────────────────────────
const rakeGroup = new THREE.Group();

const handle = new THREE.Mesh(
  new THREE.CylinderGeometry(0.04, 0.04, 3.5, 8),
  new THREE.MeshLambertMaterial({ color: 0x8b5e3c })
);
handle.rotation.x = Math.PI / 4;
handle.position.set(0, 0.9, -0.6);
rakeGroup.add(handle);

const head = new THREE.Mesh(
  new THREE.BoxGeometry(1.2, 0.06, 0.12),
  new THREE.MeshLambertMaterial({ color: 0x6b4c2a })
);
head.position.set(0, 0.06, 0);
rakeGroup.add(head);

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

// ─── Sand constants ───────────────────────────────────────────────────────────
const SAND_SIZE = 14;        // world units (matches PlaneGeometry)
const TEX_RES   = 512;       // offscreen canvas resolution for both modes
const RAKE_HEAD_WORLD = 1.2; // world-space width of rake head

// Stroke width in canvas pixels — proportional to rake head vs sand size
const STROKE_PX = Math.round((RAKE_HEAD_WORLD / SAND_SIZE) * TEX_RES);

// ─── Mode 1: Canvas Texture Paint ─────────────────────────────────────────────
const canvasPaint = document.createElement('canvas');
canvasPaint.width  = TEX_RES;
canvasPaint.height = TEX_RES;
const ctxPaint = canvasPaint.getContext('2d');

// Fill with sand base colour
ctxPaint.fillStyle = '#c8b89a';
ctxPaint.fillRect(0, 0, TEX_RES, TEX_RES);

const paintTex = new THREE.CanvasTexture(canvasPaint);

const sandMeshPaint = new THREE.Mesh(
  new THREE.PlaneGeometry(SAND_SIZE, SAND_SIZE),
  new THREE.MeshLambertMaterial({ map: paintTex })
);
sandMeshPaint.rotation.x = -Math.PI / 2;
sandMeshPaint.receiveShadow = true;

// ─── Mode 2: Displacement Map ─────────────────────────────────────────────────
const canvasDisp = document.createElement('canvas');
canvasDisp.width  = TEX_RES;
canvasDisp.height = TEX_RES;
const ctxDisp = canvasDisp.getContext('2d');

// White = no displacement (neutral height); dark = pushed down
ctxDisp.fillStyle = '#ffffff';
ctxDisp.fillRect(0, 0, TEX_RES, TEX_RES);

const dispTex = new THREE.CanvasTexture(canvasDisp);

const sandMeshDisp = new THREE.Mesh(
  new THREE.PlaneGeometry(SAND_SIZE, SAND_SIZE, 200, 200),
  new THREE.MeshStandardMaterial({
    color: 0xc8b89a,
    roughness: 0.95,
    metalness: 0.0,
    displacementMap: dispTex,
    displacementScale: -0.08,
  })
);
sandMeshDisp.rotation.x = -Math.PI / 2;
sandMeshDisp.receiveShadow = true;

// ─── Mode management ─────────────────────────────────────────────────────────
const MODE_NAMES = [
  'Mode 1 — Canvas Texture Paint',
  'Mode 2 — Displacement Map',
];
let currentMode = 0; // 0 = paint, 1 = displacement

const modeLabel = document.getElementById('mode-label');

function applyMode(mode) {
  scene.remove(sandMeshPaint);
  scene.remove(sandMeshDisp);

  if (mode === 0) {
    scene.add(sandMeshPaint);
    ambient.intensity = 0.6;
    sun.intensity = 1.4;
  } else {
    scene.add(sandMeshDisp);
    // Lower ambient so the graze light makes ridge shadows pop
    ambient.intensity = 0.45;
    sun.intensity = 1.0;
  }

  modeLabel.childNodes[0].textContent = MODE_NAMES[mode];
}

applyMode(currentMode);

window.addEventListener('keydown', e => {
  if (e.key === '1') { currentMode = 0; applyMode(0); }
  if (e.key === '2') { currentMode = 1; applyMode(1); }
});

// ─── Input / raycast state ────────────────────────────────────────────────────
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster   = new THREE.Raycaster();
const pointer     = new THREE.Vector2();
const target      = new THREE.Vector3();
let dragging      = false;
let prevUV        = null; // {u, v} of last painted point; null when pen is up

// Convert world XZ → UV [0,1] on the sand plane
function worldToUV(wx, wz) {
  return {
    u: (wx + SAND_SIZE / 2) / SAND_SIZE,
    v: (wz + SAND_SIZE / 2) / SAND_SIZE,
  };
}

// ─── Painting helpers ─────────────────────────────────────────────────────────

/**
 * Draw a line segment from (u0,v0) to (u1,v1) on a 2D canvas context.
 * UV coordinates are Three.js-style (v=0 at bottom), so v is flipped for canvas.
 */
function paintStrokeSegment(ctx, u0, v0, u1, v1, strokeStyle, lineWidth) {
  const x0 = u0 * TEX_RES;
  const y0 = (1 - v0) * TEX_RES; // flip v: canvas y=0 is top
  const x1 = u1 * TEX_RES;
  const y1 = (1 - v1) * TEX_RES;

  ctx.save();
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth   = lineWidth;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

function paintGroove(wx, wz) {
  const { u, v } = worldToUV(wx, wz);
  const p0 = prevUV || { u, v }; // on first point of a stroke, draw a dot

  if (currentMode === 0) {
    // Darker sand tone to show swept groove
    paintStrokeSegment(ctxPaint, p0.u, p0.v, u, v, '#9e8b72', STROKE_PX);
    paintTex.needsUpdate = true;
  } else {
    // Near-black pushes vertices down via displacementScale < 0
    paintStrokeSegment(ctxDisp, p0.u, p0.v, u, v, '#202020', STROKE_PX);
    dispTex.needsUpdate = true;
  }

  prevUV = { u, v };
}

// ─── Input handlers ───────────────────────────────────────────────────────────
function updatePointer(clientX, clientY) {
  pointer.x =  (clientX / window.innerWidth)  * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
}

function resolveWorldPos() {
  raycaster.setFromCamera(pointer, camera);
  raycaster.ray.intersectPlane(groundPlane, target);
  target.x = Math.max(-6.5, Math.min(6.5, target.x));
  target.z = Math.max(-6.5, Math.min(6.5, target.z));
}

function onDown(clientX, clientY) {
  dragging = true;
  prevUV   = null;
  updatePointer(clientX, clientY);
  resolveWorldPos();
  rakeGroup.position.set(target.x, 0, target.z);
  paintGroove(target.x, target.z);
}

function onMove(clientX, clientY) {
  if (!dragging) return;
  updatePointer(clientX, clientY);
  resolveWorldPos();
  rakeGroup.position.set(target.x, 0, target.z);
  paintGroove(target.x, target.z);
}

function onUp() {
  dragging = false;
  prevUV   = null;
}

// Mouse
renderer.domElement.addEventListener('mousedown',  e => onDown(e.clientX, e.clientY));
renderer.domElement.addEventListener('mousemove',  e => onMove(e.clientX, e.clientY));
renderer.domElement.addEventListener('mouseup',    onUp);

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

// ─── Resize ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Render loop ─────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
