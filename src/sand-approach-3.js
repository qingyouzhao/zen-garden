import * as THREE from 'three';

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// --- Main scene ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1612);
scene.fog = new THREE.Fog(0x1a1612, 20, 40);

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

// --- GPU ping-pong render targets ---
const SIM_RES = 256;
// Use RGBAFormat — universally supported for float render targets (R32F / EXT_color_buffer_float
// has uneven mobile support; RGBA16F or RGBA32F is always available in WebGL2).
// We only read/write the R channel; G, B, A are unused.
const rtOptions = {
  type: THREE.FloatType,
  format: THREE.RGBAFormat,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  wrapS: THREE.ClampToEdgeWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
};
let rtA = new THREE.WebGLRenderTarget(SIM_RES, SIM_RES, rtOptions);
let rtB = new THREE.WebGLRenderTarget(SIM_RES, SIM_RES, rtOptions);

// Initialize with flat height 0.3 (mid-range sand level).
// 4 floats per pixel (RGBA) — only R matters; G/B/A = 0.
const initData = new Float32Array(SIM_RES * SIM_RES * 4);
for (let i = 0; i < SIM_RES * SIM_RES; i++) initData[i * 4] = 0.3;
const initTex = new THREE.DataTexture(initData, SIM_RES, SIM_RES, THREE.RGBAFormat, THREE.FloatType);
initTex.needsUpdate = true;

// --- Simulation scene (full-screen quad + orthographic camera) ---
const simScene = new THREE.Scene();
const simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const simVert = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const simFrag = /* glsl */`
  precision highp float;
  uniform sampler2D uHeightmap;
  uniform vec2 uTines[5];
  uniform float uRakeActive;
  uniform float uDelta;
  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;
    vec2 texel = 1.0 / vec2(${SIM_RES}.0);

    float h  = texture2D(uHeightmap, uv).r;
    float hN = texture2D(uHeightmap, uv + vec2(0.0, texel.y)).r;
    float hS = texture2D(uHeightmap, uv - vec2(0.0, texel.y)).r;
    float hE = texture2D(uHeightmap, uv + vec2(texel.x, 0.0)).r;
    float hW = texture2D(uHeightmap, uv - vec2(texel.x, 0.0)).r;

    float repose = 0.15;
    // Inflow from higher neighbors
    float flow = 0.0;
    flow += max(0.0, (hN - h) - repose) * 0.25;
    flow += max(0.0, (hS - h) - repose) * 0.25;
    flow += max(0.0, (hE - h) - repose) * 0.25;
    flow += max(0.0, (hW - h) - repose) * 0.25;
    // Outflow to lower neighbors
    float outflow = 0.0;
    outflow += max(0.0, (h - hN) - repose) * 0.25;
    outflow += max(0.0, (h - hS) - repose) * 0.25;
    outflow += max(0.0, (h - hE) - repose) * 0.25;
    outflow += max(0.0, (h - hW) - repose) * 0.25;

    h += (flow - outflow) * uDelta * 60.0;

    // Rake displacement
    if (uRakeActive > 0.5) {
      for (int i = 0; i < 5; i++) {
        float dist = length(uv - uTines[i]);
        float groove = smoothstep(0.012, 0.005, dist);
        float ridge  = smoothstep(0.025, 0.015, dist) - smoothstep(0.015, 0.008, dist);
        h -= groove * 0.08;
        h += ridge  * 0.04;
      }
    }

    h = clamp(h, 0.0, 1.0);
    gl_FragColor = vec4(h, 0.0, 0.0, 1.0);
  }
`;

const simMaterial = new THREE.ShaderMaterial({
  vertexShader: simVert,
  fragmentShader: simFrag,
  uniforms: {
    uHeightmap: { value: initTex },
    uTines: { value: [
      new THREE.Vector2(0.5, 0.5),
      new THREE.Vector2(0.5, 0.5),
      new THREE.Vector2(0.5, 0.5),
      new THREE.Vector2(0.5, 0.5),
      new THREE.Vector2(0.5, 0.5),
    ]},
    uRakeActive: { value: 0.0 },
    uDelta: { value: 0.016 },
  },
  depthTest: false,
  depthWrite: false,
});

const simQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simMaterial);
simScene.add(simQuad);

// Run one init pass to seed rtA from the DataTexture
renderer.setRenderTarget(rtB);
simMaterial.uniforms.uHeightmap.value = initTex;
renderer.render(simScene, simCamera);
renderer.setRenderTarget(null);
// Swap so rtA holds the seeded data
[rtA, rtB] = [rtB, rtA];

// --- Sand mesh (displaced by heightmap) ---
const SAND_SEGS = 256;
const sandGeo = new THREE.PlaneGeometry(14, 14, SAND_SEGS, SAND_SEGS);
// PlaneGeometry is in XY plane; we'll rotate in JS and handle in shader instead.
// Rotate geometry so it lies in XZ plane (same as original sand).
sandGeo.rotateX(-Math.PI / 2);

const sandVert = /* glsl */`
  uniform sampler2D uHeightmap;
  varying vec2 vUv;
  varying float vHeight;
  void main() {
    vUv = uv;
    vec3 pos = position;
    float h = texture2D(uHeightmap, uv).r;
    vHeight = h;
    // Displace in local Y (which is world Y after the geometry rotation)
    pos.y += (h - 0.3) * 0.8;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const sandFrag = /* glsl */`
  precision highp float;
  uniform sampler2D uHeightmap;
  uniform vec3 uSunDir;     // normalized sun direction in view/world space
  varying vec2 vUv;
  varying float vHeight;

  void main() {
    vec2 texel = 1.0 / vec2(${SIM_RES}.0);

    // Reconstruct normal from heightmap neighbors
    float hL = texture2D(uHeightmap, vUv - vec2(texel.x, 0.0)).r;
    float hR = texture2D(uHeightmap, vUv + vec2(texel.x, 0.0)).r;
    float hD = texture2D(uHeightmap, vUv - vec2(0.0, texel.y)).r;
    float hU = texture2D(uHeightmap, vUv + vec2(0.0, texel.y)).r;

    // Scale: 14 world units / 256 texels = ~0.0547 world units per texel
    // Height scale = 0.8
    float worldScale = 14.0 / ${SIM_RES}.0;
    float heightScale = 0.8;
    // After sandGeo.rotateX(-PI/2), UV-U maps to world +X and UV-V maps to world -Z.
    // Tangent vectors are in world space so the normal points up (+Y).
    vec3 tangentX = normalize(vec3(worldScale * 2.0, (hR - hL) * heightScale, 0.0));
    vec3 tangentZ = normalize(vec3(0.0, (hU - hD) * heightScale, -worldScale * 2.0));
    vec3 normal = normalize(cross(tangentZ, tangentX)); // order gives +Y normal on flat sand

    // Sandy color with slight height-based variation
    vec3 sandColor = mix(vec3(0.68, 0.60, 0.45), vec3(0.82, 0.74, 0.58), vHeight);

    // Lambertian shading
    float NdotL = max(dot(normal, normalize(uSunDir)), 0.0);
    vec3 color = sandColor * (0.45 + 0.55 * NdotL);

    gl_FragColor = vec4(color, 1.0);
  }
`;

const sandMaterial = new THREE.ShaderMaterial({
  vertexShader: sandVert,
  fragmentShader: sandFrag,
  uniforms: {
    uHeightmap: { value: rtA.texture },
    uSunDir: { value: new THREE.Vector3(5, 12, 8).normalize() },
  },
});

const sandMesh = new THREE.Mesh(sandGeo, sandMaterial);
scene.add(sandMesh);

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
handle.rotation.x = Math.PI / 4;
handle.position.set(0, 1.327, 1.237);
rakeGroup.add(handle);

const head = new THREE.Mesh(
  new THREE.BoxGeometry(1.2, 0.06, 0.12),
  new THREE.MeshLambertMaterial({ color: 0x6b4c2a })
);
head.position.set(0, 0.06, 0);
rakeGroup.add(head);

// Tines — offsets match the simulation (±2 * 0.26 spacing)
const tineOffsets = [-2, -1, 0, 1, 2].map(i => i * 0.26);
for (const xOffset of tineOffsets) {
  const tine = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.015, 0.22, 6),
    new THREE.MeshLambertMaterial({ color: 0x5a3e20 })
  );
  tine.position.set(xOffset, -0.09, 0);
  rakeGroup.add(tine);
}

rakeGroup.position.set(0, 0, 2);
scene.add(rakeGroup);

// --- Input ---
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
  target.x = Math.max(-6.5, Math.min(6.5, target.x));
  target.z = Math.max(-6.5, Math.min(6.5, target.z));
  rakeGroup.position.set(target.x, 0, target.z);
}

function onUp() { dragging = false; }

renderer.domElement.addEventListener('mousedown', e => onDown(e.clientX, e.clientY));
renderer.domElement.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
renderer.domElement.addEventListener('mouseup', onUp);

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

// --- UV helper: world (x, z) → UV [0,1]² ---
// Sand is 14×14 centered at origin, so u = (x + 7) / 14, v = (z + 7) / 14
function worldToUV(x, z) {
  return new THREE.Vector2((x + 7) / 14, (z + 7) / 14);
}

// --- Animation loop ---
let lastTime = performance.now();

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const rawDelta = (now - lastTime) / 1000;
  lastTime = now;
  const delta = Math.min(rawDelta, 0.05);

  // --- Build tine UV positions from rake world position ---
  const rx = rakeGroup.position.x;
  const rz = rakeGroup.position.z;

  // Tines are spread along world X at the rake's Z position
  const tineUVs = tineOffsets.map(xOffset =>
    worldToUV(rx + xOffset, rz)
  );

  // --- Simulation pass ---
  simMaterial.uniforms.uHeightmap.value = rtA.texture;
  simMaterial.uniforms.uTines.value = tineUVs;
  simMaterial.uniforms.uRakeActive.value = dragging ? 1.0 : 0.0;
  simMaterial.uniforms.uDelta.value = delta;

  renderer.setRenderTarget(rtB);
  renderer.render(simScene, simCamera);
  renderer.setRenderTarget(null);

  // Update sand mesh with the freshly written texture
  sandMaterial.uniforms.uHeightmap.value = rtB.texture;

  // Swap buffers
  [rtA, rtB] = [rtB, rtA];

  // --- Main render ---
  renderer.render(scene, camera);
}

animate();
