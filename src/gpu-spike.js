/**
 * gpu-spike.js — GPU sand simulation spike
 *
 * Primary path:  THREE.WebGPURenderer + TSL Fn() compute shaders
 *   - 128x128 = 16 384 sand particles stored in a GPU storage buffer
 *   - Each frame: a compute pass disturbs particles near the rake and settles far ones
 *   - Rendered as instanced flat tiles coloured by displacement depth
 *
 * WebGPURenderer automatically falls back to a WebGL2 backend (transform feedback)
 * when the browser lacks native WebGPU.  A further GLSL ping-pong fallback is
 * provided for browsers where even that fails (e.g. very old WebGL1).
 *
 * See the PR description for findings on stability, fps, and iOS compatibility.
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  uniform,
  instancedArray,
  instanceIndex,
  positionGeometry,
  cameraProjectionMatrix,
  modelViewMatrix,
  vec3, vec4, float,
  mix, clamp, smoothstep,
} from 'three/tsl';
import { makeStone } from './stone.js';
import { buildRake } from './rake.js';
import { createPointerInput } from './input.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRID    = 256;
const COUNT   = GRID * GRID;            // 65 536 particles
const EXTENT  = 7.0;                    // half-width of sand area, world units

// Pointy-top hex grid geometry
const HEX_R  = (EXTENT * 2) / GRID / Math.sqrt(3);
const H_STEP = HEX_R * Math.sqrt(3);
const V_STEP = HEX_R * 1.5;

let RAKE_RADIUS   = 0.7;
let PUSH_STRENGTH = 0.12;
const TINE_OFFSETS  = [-0.52, -0.26, 0.0, 0.26, 0.52];
let TINE_R        = 0.07;

// ---------------------------------------------------------------------------
// TSL / WebGPU path
// ---------------------------------------------------------------------------

async function buildTSLScene() {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.insertBefore(renderer.domElement, document.getElementById('info'));

  const isWebGPU = renderer.backend && renderer.backend.isWebGPUBackend;
  const backendLabel = isWebGPU ? 'WebGPU compute' : 'WebGL2 transform feedback';
  document.querySelector('#info span').textContent = `drag to rake  |  ${backendLabel}  |  -- fps`;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1612);
  scene.fog = new THREE.Fog(0x1a1612, 20, 40);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 10, 10);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xfff5e0, 0.6));
  const sun = new THREE.DirectionalLight(0xfff0cc, 1.4);
  sun.position.set(5, 12, 8);
  scene.add(sun);

  // GPU storage buffer: one float per particle [0..1]
  const dispBuffer = instancedArray(COUNT, 'float');

  const uRakePos      = uniform(new THREE.Vector2(9999, 9999));
  const uRakeDir      = uniform(new THREE.Vector2(1, 0));
  const uRakeRadius   = uniform(RAKE_RADIUS);
  const uPushStrength = uniform(PUSH_STRENGTH);
  const uTineR        = uniform(TINE_R);

  // Compute shader (TSL Fn) — tine-aware influence
  const sandCompute = Fn(() => {
    const idx = instanceIndex;

    const col = idx.modInt(GRID);
    const row = idx.div(GRID);

    const isOdd = row.modInt(2).toFloat();
    const px = col.toFloat().mul(float(H_STEP))
      .add(isOdd.mul(float(H_STEP * 0.5)))
      .sub(float(EXTENT));
    const pz = row.toFloat().mul(float(V_STEP)).sub(float(EXTENT));

    const dx = px.sub(uRakePos.x);
    const dz = pz.sub(uRakePos.y);

    const dist = dx.mul(dx).add(dz.mul(dz)).sqrt();
    const gate = smoothstep(uRakeRadius, float(0.0), dist);

    const dPerp = dx.mul(uRakeDir.y.negate()).add(dz.mul(uRakeDir.x));

    const tineInf = float(0.0).toVar();
    for (const tOff of TINE_OFFSETS) {
      const d = dPerp.sub(float(tOff)).abs();
      tineInf.assign(tineInf.max(smoothstep(uTineR, float(0.0), d)));
    }

    const influence = tineInf.mul(gate);
    const disp = dispBuffer.element(idx);
    disp.assign(clamp(disp.add(influence.mul(uPushStrength)), float(0.0), float(1.0)));
  })().compute(COUNT, [64]);

  const clearCompute = Fn(() => {
    dispBuffer.element(instanceIndex).assign(float(0.0));
  })().compute(COUNT, [64]);

  await renderer.computeAsync(clearCompute);

  // Particle rendering
  const sandMat = new THREE.NodeMaterial();
  sandMat.side = THREE.DoubleSide;

  sandMat.vertexNode = Fn(() => {
    const idx = instanceIndex;
    const col = idx.modInt(GRID);
    const row = idx.div(GRID);

    const isOdd = row.modInt(2).toFloat();
    const px = col.toFloat().mul(float(H_STEP))
      .add(isOdd.mul(float(H_STEP * 0.5)))
      .sub(float(EXTENT));
    const pz = row.toFloat().mul(float(V_STEP)).sub(float(EXTENT));
    const py = dispBuffer.element(idx).mul(float(-0.18));

    const worldPos = vec3(
      px.add(positionGeometry.x),
      py,
      pz.add(positionGeometry.z)
    );

    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(worldPos, float(1.0))));
  })();

  const sandColor   = vec3(float(0.784), float(0.722), float(0.604));
  const grooveColor = vec3(float(0.353), float(0.251), float(0.133));

  sandMat.fragmentNode = Fn(() => {
    const d = dispBuffer.element(instanceIndex);
    return vec4(mix(sandColor, grooveColor, d), float(1.0));
  })();

  const tileGeo = new THREE.CircleGeometry(HEX_R * 0.97, 6);
  tileGeo.rotateX(-Math.PI / 2);

  const particles = new THREE.InstancedMesh(tileGeo, sandMat, COUNT);
  particles.frustumCulled = false;

  const dummy = new THREE.Object3D();
  for (let i = 0; i < COUNT; i++) {
    dummy.updateMatrix();
    particles.setMatrixAt(i, dummy.matrix);
  }
  particles.instanceMatrix.needsUpdate = true;
  scene.add(particles);

  scene.add(makeStone());
  const rakeGroup = buildRake();
  rakeGroup.position.set(0, 0, 2);
  scene.add(rakeGroup);

  document.getElementById('clear-btn').addEventListener('click', () => {
    renderer.computeAsync(clearCompute);
  });

  let lastDir = { x: 1, z: 0 };

  createPointerInput(camera, renderer.domElement, {
    onMove(x, z, dx, dz) {
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.001) lastDir = { x: dx / len, z: dz / len };
      rakeGroup.position.set(x, 0, z);
      rakeGroup.rotation.y = Math.atan2(lastDir.x, lastDir.z);
      uRakePos.value.set(x, z);
      uRakeDir.value.set(lastDir.x, lastDir.z);
    },
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  window.__sandControls = {
    setRakeRadius(v)    { RAKE_RADIUS = v; uRakeRadius.value = v; },
    setPushStrength(v)  { PUSH_STRENGTH = v; uPushStrength.value = v; },
    setTineRadius(v)    { TINE_R = v; uTineR.value = v; },
  };

  let lastTime = performance.now();
  let frames   = 0;
  const fpsLabel = document.querySelector('#info span');

  renderer.setAnimationLoop(() => {
    renderer.compute(sandCompute);
    renderer.render(scene, camera);

    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      fpsLabel.textContent = `drag to rake  |  ${backendLabel}  |  ${frames} fps`;
      frames = 0;
      lastTime = now;
    }
  });
}

// ---------------------------------------------------------------------------
// GLSL ping-pong fallback (WebGL1 / old browsers without transform feedback)
// ---------------------------------------------------------------------------

function buildGLSLFallback() {
  document.getElementById('fallback-banner').style.display = 'block';
  document.querySelector('#info span').textContent = 'drag to rake  |  GLSL ping-pong  |  -- fps';

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) {
    document.getElementById('fallback-banner').textContent =
      'No WebGL support detected. Please use a modern browser.';
    return;
  }

  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.insertBefore(renderer.domElement, document.getElementById('info'));

  const rtOpts = {
    minFilter:   THREE.NearestFilter,
    magFilter:   THREE.NearestFilter,
    type:        THREE.FloatType,
    format:      THREE.RedFormat,
    depthBuffer: false,
  };
  let rtA = new THREE.WebGLRenderTarget(GRID, GRID, rtOpts);
  let rtB = new THREE.WebGLRenderTarget(GRID, GRID, rtOpts);

  const simScene  = new THREE.Scene();
  const simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const TINE_SPACING_UV = 0.26 / (EXTENT * 2);
  const TINE_R_UV       = TINE_R / (EXTENT * 2);
  const RAKE_R_UV       = RAKE_RADIUS / (EXTENT * 2);

  const simMat = new THREE.ShaderMaterial({
    uniforms: {
      uState:   { value: rtA.texture },
      uRakePos: { value: new THREE.Vector2(9999, 9999) },
      uRakeDir: { value: new THREE.Vector2(1, 0) },
      uRakeR:   { value: RAKE_R_UV },
      uTineR:   { value: TINE_R_UV },
      uTineSp:  { value: TINE_SPACING_UV },
      uPush:    { value: PUSH_STRENGTH },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uState;
      uniform vec2  uRakePos;
      uniform vec2  uRakeDir;
      uniform float uRakeR;
      uniform float uTineR;
      uniform float uTineSp;
      uniform float uPush;
      varying vec2 vUv;

      void main() {
        float cur = texture2D(uState, vUv).r;

        vec2  d    = vUv - uRakePos;
        float dist = length(d);
        float gate = 1.0 - smoothstep(0.0, uRakeR, dist);

        vec2  perp = vec2(-uRakeDir.y, uRakeDir.x);
        float dPerp = dot(d, perp);

        float tineInf = 0.0;
        for (int i = -2; i <= 2; i++) {
          float tOff = float(i) * uTineSp;
          float dt   = abs(dPerp - tOff);
          tineInf    = max(tineInf, 1.0 - smoothstep(0.0, uTineR, dt));
        }

        float influence = tineInf * gate;
        gl_FragColor = vec4(clamp(cur + influence * uPush, 0.0, 1.0), 0.0, 0.0, 1.0);
      }
    `,
  });
  simScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simMat));

  const scene  = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1612);
  scene.fog = new THREE.Fog(0x1a1612, 20, 40);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 10, 10);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xfff5e0, 0.6));
  const sun = new THREE.DirectionalLight(0xfff0cc, 1.4);
  sun.position.set(5, 12, 8);
  scene.add(sun);

  const tileDisplayMat = new THREE.ShaderMaterial({
    uniforms: {
      uDisp:   { value: rtA.texture },
      uGrid:   { value: GRID },
      uExtent: { value: EXTENT },
      uHStep:  { value: H_STEP },
      uVStep:  { value: V_STEP },
    },
    vertexShader: /* glsl */`
      uniform sampler2D uDisp;
      uniform float uGrid;
      uniform float uExtent;
      uniform float uHStep;
      uniform float uVStep;
      varying float vDisp;

      void main() {
        float id  = float(gl_InstanceID);
        float col = mod(id, uGrid);
        float row = floor(id / uGrid);
        vec2  uv  = (vec2(col, row) + 0.5) / uGrid;
        float d   = texture2D(uDisp, uv).r;
        vDisp = d;

        float isOdd = mod(row, 2.0);
        float px = col * uHStep + isOdd * uHStep * 0.5 - uExtent;
        float pz = row * uVStep - uExtent;
        float py = d * -0.18;

        vec3 worldPos = position + vec3(px, py, pz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying float vDisp;
      void main() {
        vec3 sand   = vec3(0.784, 0.722, 0.604);
        vec3 groove = vec3(0.353, 0.251, 0.133);
        gl_FragColor = vec4(mix(sand, groove, vDisp), 1.0);
      }
    `,
  });

  const tileGeo = new THREE.CircleGeometry(HEX_R * 0.97, 6);
  tileGeo.rotateX(-Math.PI / 2);

  const tiles = new THREE.InstancedMesh(tileGeo, tileDisplayMat, COUNT);
  tiles.frustumCulled = false;

  const dummy = new THREE.Object3D();
  for (let i = 0; i < COUNT; i++) {
    dummy.updateMatrix();
    tiles.setMatrixAt(i, dummy.matrix);
  }
  tiles.instanceMatrix.needsUpdate = true;
  scene.add(tiles);

  scene.add(makeStone());
  const rakeGroup = buildRake();
  rakeGroup.position.set(0, 0, 2);
  scene.add(rakeGroup);

  const clearScene  = new THREE.Scene();
  const clearMat    = new THREE.ShaderMaterial({
    vertexShader:   'void main(){gl_Position=vec4(position.xy,0.0,1.0);}',
    fragmentShader: 'void main(){gl_FragColor=vec4(0.0);}',
  });
  clearScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), clearMat));

  document.getElementById('clear-btn').addEventListener('click', () => {
    renderer.setRenderTarget(rtA);
    renderer.render(clearScene, simCamera);
    renderer.setRenderTarget(rtB);
    renderer.render(clearScene, simCamera);
    renderer.setRenderTarget(null);
  });

  let lastDir = { x: 1, z: 0 };

  createPointerInput(camera, renderer.domElement, {
    onMove(x, z, dx, dz) {
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.001) lastDir = { x: dx / len, z: dz / len };
      rakeGroup.position.set(x, 0, z);
      rakeGroup.rotation.y = Math.atan2(lastDir.x, lastDir.z);
      simMat.uniforms.uRakePos.value.set(
        (x + EXTENT) / (EXTENT * 2),
        (z + EXTENT) / (EXTENT * 2)
      );
      simMat.uniforms.uRakeDir.value.set(lastDir.x, lastDir.z);
    },
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  window.__sandControls = {
    setRakeRadius(v)    { RAKE_RADIUS = v; simMat.uniforms.uRakeR.value = v / (EXTENT * 2); },
    setPushStrength(v)  { PUSH_STRENGTH = v; simMat.uniforms.uPush.value = v; },
    setTineRadius(v)    { TINE_R = v; simMat.uniforms.uTineR.value = v / (EXTENT * 2); },
  };

  let lastTime = performance.now();
  let frames   = 0;
  const fpsLabel = document.querySelector('#info span');

  function animate() {
    requestAnimationFrame(animate);

    simMat.uniforms.uState.value = rtA.texture;
    renderer.setRenderTarget(rtB);
    renderer.render(simScene, simCamera);
    renderer.setRenderTarget(null);

    [rtA, rtB] = [rtB, rtA];
    tileDisplayMat.uniforms.uDisp.value = rtA.texture;
    renderer.render(scene, camera);

    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      fpsLabel.textContent = `drag to rake  |  GLSL ping-pong  |  ${frames} fps`;
      frames = 0;
      lastTime = now;
    }
  }
  animate();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  try {
    await buildTSLScene();
  } catch (err) {
    console.warn('[gpu-spike] TSL scene failed — falling back to GLSL ping-pong:', err);
    buildGLSLFallback();
  }
}

main();
