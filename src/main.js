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

// ─── Sand plane ──────────────────────────────────────────────────────────────
const sand = new THREE.Mesh(
  new THREE.PlaneGeometry(14, 14),
  new THREE.MeshLambertMaterial({ color: 0xc8b89a })
);
sand.rotation.x = -Math.PI / 2;
sand.receiveShadow = true;
scene.add(sand);

// ─── Stone (box) ─────────────────────────────────────────────────────────────
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

// ─── Constants ───────────────────────────────────────────────────────────────
const SAND_MIN = -6.5;
const SAND_MAX =  6.5;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── HUD labels ──────────────────────────────────────────────────────────────

// Bottom-centre: current auto-pattern name (fades out in manual mode)
const autoLabel = document.createElement('div');
Object.assign(autoLabel.style, {
  position:      'fixed',
  bottom:        '22px',
  left:          '50%',
  transform:     'translateX(-50%)',
  color:         '#d4c8a8',
  fontFamily:    'Georgia, serif',
  fontSize:      '15px',
  letterSpacing: '0.12em',
  pointerEvents: 'none',
  textShadow:    '0 1px 4px rgba(0,0,0,0.8)',
  textAlign:     'center',
  transition:    'opacity 0.5s',
  opacity:       '0',
  userSelect:    'none',
});
document.body.appendChild(autoLabel);

// Top-left: key-hint overlay (replaces the old #mode-label content)
const keyHint = document.getElementById('mode-label');
if (keyHint) {
  keyHint.innerHTML =
    'Zen Garden' +
    '<span>A auto &nbsp;|&nbsp; 1 lines &nbsp;|&nbsp; 2 rings &nbsp;|&nbsp; 3 spiral &nbsp;|&nbsp; 4 lissajous</span>';
}

let hudFadeTimer = null;

function showAutoLabel(text) {
  clearTimeout(hudFadeTimer);
  autoLabel.textContent = text;
  autoLabel.style.opacity = '1';
}

function hideAutoLabel() {
  clearTimeout(hudFadeTimer);
  hudFadeTimer = setTimeout(() => { autoLabel.style.opacity = '0'; }, 1200);
}

// ─── Auto-raking patterns ─────────────────────────────────────────────────────

function makeParallelLines() {
  // Sweeps left-right and right-left, stepping down Z each pass.
  // ~9 s per half-sweep; garden height split into ~13 lines.
  const speed   = 13 / 9;  // units/s
  const zStep   = 1.0;
  const zValues = [];
  for (let z = SAND_MIN; z <= SAND_MAX + 0.01; z += zStep) zValues.push(z);
  let zIdx = 0, dir = 1, x = SAND_MIN;
  return {
    name: 'Parallel Lines',
    reset() { zIdx = 0; dir = 1; x = SAND_MIN; },
    tick(dt) {
      x += dir * speed * dt;
      if (dir > 0 && x >= SAND_MAX) {
        x = SAND_MAX; dir = -1; zIdx = (zIdx + 1) % zValues.length;
      } else if (dir < 0 && x <= SAND_MIN) {
        x = SAND_MIN; dir =  1; zIdx = (zIdx + 1) % zValues.length;
      }
      return { x, z: zValues[zIdx] };
    },
  };
}

function makeConcentricRings() {
  // Radius grows each frame; one full orbit every ~2 s; restarts from centre.
  const maxRadius = 6.0;
  const growRate  = maxRadius / 18;      // reach edge in ~18 s
  const angSpeed  = (Math.PI * 2) / 2;  // one rotation per 2 s
  let angle = 0, radius = 0.3;
  return {
    name: 'Concentric Rings',
    reset() { angle = 0; radius = 0.3; },
    tick(dt) {
      angle  += angSpeed * dt;
      radius += growRate * dt;
      if (radius > maxRadius) radius = 0.3;
      return {
        x: clamp(radius * Math.cos(angle), SAND_MIN, SAND_MAX),
        z: clamp(radius * Math.sin(angle), SAND_MIN, SAND_MAX),
      };
    },
  };
}

function makeSpiral() {
  // Archimedean spiral r = a*theta; ~18 s from centre to edge, then restarts.
  const totalTime = 18;
  const turns     = 5;
  const maxTheta  = Math.PI * 2 * turns;
  const a         = 6.0 / maxTheta;
  const thetaSpd  = maxTheta / totalTime;
  let theta = 0;
  return {
    name: 'Spiral',
    reset() { theta = 0; },
    tick(dt) {
      theta += thetaSpd * dt;
      if (theta > maxTheta) theta = 0;
      const r = a * theta;
      return {
        x: clamp(r * Math.cos(theta), SAND_MIN, SAND_MAX),
        z: clamp(r * Math.sin(theta), SAND_MIN, SAND_MAX),
      };
    },
  };
}

function makeLissajous() {
  // x = A*sin(a*t + delta),  z = B*sin(b*t); delta drifts so figure evolves.
  const A = 6.0, B = 6.0, a = 3, b = 2;
  const baseSpd  = 0.35;   // rad/s — slow enough to feel meditative
  const deltaSpd = 0.015;  // delta drift rad/s
  let t = 0, delta = 0;
  return {
    name: 'Lissajous',
    reset() { t = 0; delta = 0; },
    tick(dt) {
      t     += baseSpd  * dt;
      delta += deltaSpd * dt;
      return {
        x: clamp(A * Math.sin(a * t + delta), SAND_MIN, SAND_MAX),
        z: clamp(B * Math.sin(b * t),          SAND_MIN, SAND_MAX),
      };
    },
  };
}

const patternObjects = {
  lines:     makeParallelLines(),
  rings:     makeConcentricRings(),
  spiral:    makeSpiral(),
  lissajous: makeLissajous(),
};

const patternKeys = { '1': 'lines', '2': 'rings', '3': 'spiral', '4': 'lissajous' };

let autoMode       = false;
let currentPattern = 'lines';

function enableAuto(patternKey) {
  currentPattern = patternKey;
  patternObjects[currentPattern].reset();
  autoMode = true;
  showAutoLabel('Auto: ' + patternObjects[currentPattern].name);
}

function disableAuto() {
  autoMode = false;
  hideAutoLabel();
}

// ─── Keyboard controls ────────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (k === 'a') { autoMode ? disableAuto() : enableAuto(currentPattern); return; }
  if (patternKeys[k]) enableAuto(patternKeys[k]);
});

// ─── Input: pointer/touch → manual rake control ───────────────────────────────
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster   = new THREE.Raycaster();
const pointer     = new THREE.Vector2();
const target      = new THREE.Vector3();
let dragging      = false;

function updatePointer(clientX, clientY) {
  pointer.x =  (clientX / window.innerWidth)  * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
}

function onDown(clientX, clientY) {
  if (autoMode) disableAuto(); // player takes over immediately
  dragging = true;
  updatePointer(clientX, clientY);
}

function onMove(clientX, clientY) {
  if (!dragging) return;
  updatePointer(clientX, clientY);
  raycaster.setFromCamera(pointer, camera);
  raycaster.ray.intersectPlane(groundPlane, target);
  target.x = clamp(target.x, SAND_MIN, SAND_MAX);
  target.z = clamp(target.z, SAND_MIN, SAND_MAX);
  rakeGroup.position.set(target.x, 0, target.z);
}

function onUp() { dragging = false; }

renderer.domElement.addEventListener('mousedown',  e => onDown(e.clientX, e.clientY));
renderer.domElement.addEventListener('mousemove',  e => onMove(e.clientX, e.clientY));
renderer.domElement.addEventListener('mouseup',    onUp);

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
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1); // cap dt so tab-switch can't teleport rake

  if (autoMode && !dragging) {
    const pos = patternObjects[currentPattern].tick(dt);
    rakeGroup.position.set(pos.x, 0, pos.z);
  }

  renderer.render(scene, camera);
}
animate();
