import * as THREE from 'three';

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

// --- Sand plane ---
const sand = new THREE.Mesh(
  new THREE.PlaneGeometry(14, 14),
  new THREE.MeshLambertMaterial({ color: 0xc8b89a })
);
sand.rotation.x = -Math.PI / 2;
sand.receiveShadow = true;
scene.add(sand);

// --- Stone (box) ---
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

// Tines
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

function updatePointer(clientX, clientY) {
  pointer.x = (clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(clientY / window.innerHeight) * 2 + 1;
}

function onDown(clientX, clientY) {
  dragging = true;
  updatePointer(clientX, clientY);
}

function onMove(clientX, clientY) {
  if (!dragging) return;
  updatePointer(clientX, clientY);
  raycaster.setFromCamera(pointer, camera);
  raycaster.ray.intersectPlane(groundPlane, target);
  // Clamp to sand bounds
  target.x = Math.max(-6.5, Math.min(6.5, target.x));
  target.z = Math.max(-6.5, Math.min(6.5, target.z));
  rakeGroup.position.set(target.x, 0, target.z);
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
