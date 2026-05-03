import * as THREE from 'three';
import { createScene } from './scene.js';
import { makeStone } from './stone.js';
import { buildRake } from './rake.js';
import { createPointerInput } from './input.js';

const { renderer, scene, camera } = createScene();

// --- GPU ping-pong render targets ---
const SIM_RES = 256;
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

// Initialize with flat height 0.3
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
    float flow = 0.0;
    flow += max(0.0, (hN - h) - repose) * 0.25;
    flow += max(0.0, (hS - h) - repose) * 0.25;
    flow += max(0.0, (hE - h) - repose) * 0.25;
    flow += max(0.0, (hW - h) - repose) * 0.25;
    float outflow = 0.0;
    outflow += max(0.0, (h - hN) - repose) * 0.25;
    outflow += max(0.0, (h - hS) - repose) * 0.25;
    outflow += max(0.0, (h - hE) - repose) * 0.25;
    outflow += max(0.0, (h - hW) - repose) * 0.25;

    h += (flow - outflow) * uDelta * 60.0;

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

// Seed rtA from the DataTexture
renderer.setRenderTarget(rtB);
simMaterial.uniforms.uHeightmap.value = initTex;
renderer.render(simScene, simCamera);
renderer.setRenderTarget(null);
[rtA, rtB] = [rtB, rtA];

// --- Sand mesh (displaced by heightmap) ---
const SAND_SEGS = 256;
const sandGeo = new THREE.PlaneGeometry(14, 14, SAND_SEGS, SAND_SEGS);
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
    pos.y += (h - 0.3) * 0.8;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const sandFrag = /* glsl */`
  precision highp float;
  uniform sampler2D uHeightmap;
  uniform vec3 uSunDir;
  varying vec2 vUv;
  varying float vHeight;

  void main() {
    vec2 texel = 1.0 / vec2(${SIM_RES}.0);

    float hL = texture2D(uHeightmap, vUv - vec2(texel.x, 0.0)).r;
    float hR = texture2D(uHeightmap, vUv + vec2(texel.x, 0.0)).r;
    float hD = texture2D(uHeightmap, vUv - vec2(0.0, texel.y)).r;
    float hU = texture2D(uHeightmap, vUv + vec2(0.0, texel.y)).r;

    float worldScale = 14.0 / ${SIM_RES}.0;
    float heightScale = 0.8;
    vec3 tangentX = normalize(vec3(worldScale * 2.0, (hR - hL) * heightScale, 0.0));
    vec3 tangentZ = normalize(vec3(0.0, (hU - hD) * heightScale, -worldScale * 2.0));
    vec3 normal = normalize(cross(tangentZ, tangentX));

    vec3 sandColor = mix(vec3(0.68, 0.60, 0.45), vec3(0.82, 0.74, 0.58), vHeight);
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

scene.add(makeStone());

const rakeGroup = buildRake();
rakeGroup.position.set(0, 0, 2);
scene.add(rakeGroup);

// UV helper: world (x, z) → UV [0,1]²
// After rotateX(-PI/2): UV-U → world +X, UV-V → world -Z
function worldToUV(x, z) {
  return new THREE.Vector2((x + 7) / 14, (7 - z) / 14);
}

const tineOffsets = [-2, -1, 0, 1, 2].map(i => i * 0.26);
let dragging = false;

createPointerInput(camera, renderer.domElement, {
  onDown() { dragging = true; },
  onMove(x, z) {
    rakeGroup.position.set(x, 0, z);
    dragging = true;
  },
  onUp() { dragging = false; },
});

// --- Animation loop ---
let lastTime = performance.now();

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const rawDelta = (now - lastTime) / 1000;
  lastTime = now;
  const delta = Math.min(rawDelta, 0.05);

  const rx = rakeGroup.position.x;
  const rz = rakeGroup.position.z;
  const tineUVs = tineOffsets.map(xOffset => worldToUV(rx + xOffset, rz));

  simMaterial.uniforms.uHeightmap.value = rtA.texture;
  simMaterial.uniforms.uTines.value = tineUVs;
  simMaterial.uniforms.uRakeActive.value = dragging ? 1.0 : 0.0;
  simMaterial.uniforms.uDelta.value = delta;

  renderer.setRenderTarget(rtB);
  renderer.render(simScene, simCamera);
  renderer.setRenderTarget(null);

  sandMaterial.uniforms.uHeightmap.value = rtB.texture;
  [rtA, rtB] = [rtB, rtA];

  renderer.render(scene, camera);
}
animate();
