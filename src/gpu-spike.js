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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRID    = 128;
const COUNT   = GRID * GRID;            // 16 384 particles
const EXTENT  = 7.0;                    // half-width of sand area, world units
const SPACING = (EXTENT * 2) / GRID;   // ~0.109 world units per tile

const RAKE_RADIUS   = 0.6;
const PUSH_STRENGTH = 0.09;
const SETTLE_RATE   = 0.0; // grooves persist until raked over

// ---------------------------------------------------------------------------
// TSL / WebGPU path (works on WebGPU natively; falls back to WebGL2 via
// transform feedback when navigator.gpu is absent)
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

  // Scene / Camera / Lights
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

  // -------------------------------------------------------------------------
  // GPU storage buffer: one float per particle [0..1]
  // 0 = flat undisturbed sand, 1 = deepest groove
  // -------------------------------------------------------------------------
  const dispBuffer = instancedArray(COUNT, 'float');

  // Uniform: rake world-space (X, Z) — .y holds world Z
  const uRakePos = uniform(new THREE.Vector2(9999, 9999));

  // -------------------------------------------------------------------------
  // Compute shader (TSL Fn)
  // -------------------------------------------------------------------------
  // 64-thread workgroups, 256 total groups for 16 384 particles.
  // On WebGPU: runs as a true compute shader.
  // On WebGL2: emulated via transform feedback (Three.js handles this).

  const sandCompute = Fn(() => {
    const idx = instanceIndex;

    // Integer grid coordinates from linear index
    const col = idx.modInt(GRID);
    const row = idx.div(GRID);

    // World-space centre of this particle tile (XZ)
    const px = col.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));
    const pz = row.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));

    // Distance from particle to rake
    const dx   = px.sub(uRakePos.x);
    const dz   = pz.sub(uRakePos.y);
    const dist = dx.mul(dx).add(dz.mul(dz)).sqrt();

    // Influence: 1.0 at centre, 0.0 at RAKE_RADIUS
    const influence = smoothstep(float(RAKE_RADIUS), float(0.0), dist);

    // Update displacement in-place
    const disp = dispBuffer.element(idx);
    disp.assign(
      clamp(
        disp.add(influence.mul(float(PUSH_STRENGTH))).sub(float(SETTLE_RATE)),
        float(0.0),
        float(1.0)
      )
    );
  })().compute(COUNT, [64]);

  // Zero-initialise all displacements
  await renderer.computeAsync(
    Fn(() => {
      dispBuffer.element(instanceIndex).assign(float(0.0));
    })().compute(COUNT, [64])
  );

  // -------------------------------------------------------------------------
  // Particle rendering
  // -------------------------------------------------------------------------
  // InstancedMesh with flat PlaneGeometry tiles.
  // All instance matrices are identity — the vertexNode derives world position
  // from instanceIndex + dispBuffer, so the instance matrix plays no role.

  const sandMat = new THREE.NodeMaterial();
  sandMat.side = THREE.DoubleSide;

  // Vertex shader: reconstruct tile world-pos from instanceIndex, project
  sandMat.vertexNode = Fn(() => {
    const idx = instanceIndex;
    const col = idx.modInt(GRID);
    const row = idx.div(GRID);

    const px = col.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));
    const pz = row.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));
    const py = dispBuffer.element(idx).mul(float(-0.18));  // grooves dip below y=0

    // positionGeometry provides per-vertex local offsets within the tile quad.
    // PlaneGeometry.rotateX(-PI/2) maps:  local X → world X, local Y → world Z.
    const worldPos = vec3(
      px.add(positionGeometry.x),
      py,
      pz.add(positionGeometry.z)
    );

    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(worldPos, float(1.0))));
  })();

  // Fragment shader: sand colour (#c8b89a) → groove colour (#5a4022)
  const sandColor   = vec3(float(0.784), float(0.722), float(0.604));
  const grooveColor = vec3(float(0.353), float(0.251), float(0.133));

  sandMat.fragmentNode = Fn(() => {
    const d = dispBuffer.element(instanceIndex);
    return vec4(mix(sandColor, grooveColor, d), float(1.0));
  })();

  const tileGeo = new THREE.PlaneGeometry(SPACING * 1.04, SPACING * 1.04);
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

  // Stone + rake
  scene.add(makeStone());
  const rakeGroup = buildRake();
  rakeGroup.position.set(0, 0, 2);
  scene.add(rakeGroup);

  // Input
  const { onDown, onMove, onUp } = buildInput(camera, rakeGroup, (wx, wz) => {
    uRakePos.value.set(wx, wz);
  });
  attachEvents(renderer.domElement, onDown, onMove, onUp);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Render loop
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
// Uses two WebGLRenderTargets as state textures (128x128, R channel = displacement).
// A fullscreen-quad fragment shader steps the simulation, instanced tiles display it.
// Activated only if WebGPURenderer.init() throws (very unusual in 2025).

function buildGLSLFallback() {
  document.getElementById('fallback-banner').style.display = 'block';
  document.querySelector('#info span').textContent = 'drag to rake  |  GLSL ping-pong  |  -- fps';

  // Import standard renderer via the global THREE namespace which three/webgpu bundles
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) {
    document.getElementById('fallback-banner').textContent =
      'No WebGL support detected. Please use a modern browser.';
    return;
  }

  // Create a plain WebGL renderer by abusing WebGPURenderer with forceWebGL
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true });
  // Note: forceWebGL mode does NOT require await renderer.init() for basic rendering
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.insertBefore(renderer.domElement, document.getElementById('info'));

  // Ping-pong targets
  const rtOpts = {
    minFilter:   THREE.NearestFilter,
    magFilter:   THREE.NearestFilter,
    type:        THREE.FloatType,
    format:      THREE.RedFormat,
    depthBuffer: false,
  };
  let rtA = new THREE.WebGLRenderTarget(GRID, GRID, rtOpts);
  let rtB = new THREE.WebGLRenderTarget(GRID, GRID, rtOpts);

  // Simulation step (fullscreen quad, GLSL fragment shader)
  const simScene  = new THREE.Scene();
  const simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const simMat = new THREE.ShaderMaterial({
    uniforms: {
      uState:   { value: rtA.texture },
      uRakePos: { value: new THREE.Vector2(9999, 9999) },
      uRakeR:   { value: RAKE_RADIUS / (EXTENT * 2) },
      uPush:    { value: PUSH_STRENGTH },
      uSettle:  { value: SETTLE_RATE },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uState;
      uniform vec2  uRakePos;
      uniform float uRakeR;
      uniform float uPush;
      uniform float uSettle;
      varying vec2 vUv;

      void main() {
        float cur  = texture2D(uState, vUv).r;
        float d    = length(vUv - uRakePos);
        float t    = clamp((uRakeR - d) / uRakeR, 0.0, 1.0);
        float inf  = t * t * (3.0 - 2.0 * t);
        float next = clamp(cur + inf * uPush - uSettle, 0.0, 1.0);
        gl_FragColor = vec4(next, 0.0, 0.0, 1.0);
      }
    `,
  });
  simScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simMat));

  // Display scene
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
      uDisp:    { value: rtA.texture },
      uGrid:    { value: GRID },
      uExtent:  { value: EXTENT },
      uSpacing: { value: SPACING },
    },
    vertexShader: /* glsl */`
      uniform sampler2D uDisp;
      uniform float uGrid;
      uniform float uExtent;
      uniform float uSpacing;
      varying float vDisp;

      void main() {
        float id  = float(gl_InstanceID);
        float col = mod(id, uGrid);
        float row = floor(id / uGrid);
        vec2  uv  = (vec2(col, row) + 0.5) / uGrid;
        float d   = texture2D(uDisp, uv).r;
        vDisp = d;

        float px = col * uSpacing - (uExtent - uSpacing * 0.5);
        float pz = row * uSpacing - (uExtent - uSpacing * 0.5);
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

  const tileGeo = new THREE.PlaneGeometry(SPACING * 1.04, SPACING * 1.04);
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

  const { onDown, onMove, onUp } = buildInput(camera, rakeGroup, (wx, wz) => {
    simMat.uniforms.uRakePos.value.set(
      (wx + EXTENT) / (EXTENT * 2),
      (wz + EXTENT) / (EXTENT * 2)
    );
  });
  attachEvents(renderer.domElement, onDown, onMove, onUp);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

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
// Shared helpers
// ---------------------------------------------------------------------------

function makeStone() {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.7, 1.0),
    new THREE.MeshLambertMaterial({ color: 0x666055 })
  );
  m.position.set(1.5, 0.35, 0.5);
  return m;
}

function buildRake() {
  const g = new THREE.Group();

  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 3.5, 8),
    new THREE.MeshLambertMaterial({ color: 0x8b5e3c })
  );
  handle.rotation.x = Math.PI / 4;
  handle.position.set(0, 0.9, -0.6);
  g.add(handle);

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.06, 0.12),
    new THREE.MeshLambertMaterial({ color: 0x6b4c2a })
  );
  head.position.y = 0.06;
  g.add(head);

  for (let i = -2; i <= 2; i++) {
    const tine = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.015, 0.22, 6),
      new THREE.MeshLambertMaterial({ color: 0x5a3e20 })
    );
    tine.position.set(i * 0.26, -0.09, 0);
    g.add(tine);
  }
  return g;
}

function buildInput(camera, rakeGroup, onRakeMove) {
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const raycaster   = new THREE.Raycaster();
  const pointer     = new THREE.Vector2();
  const target      = new THREE.Vector3();
  let dragging = false;

  function updatePointer(cx, cy) {
    pointer.x = (cx / window.innerWidth)  *  2 - 1;
    pointer.y = (cy / window.innerHeight) * -2 + 1;
  }

  function onDown(cx, cy) { dragging = true; updatePointer(cx, cy); }

  function onMove(cx, cy) {
    if (!dragging) return;
    updatePointer(cx, cy);
    raycaster.setFromCamera(pointer, camera);
    raycaster.ray.intersectPlane(groundPlane, target);
    target.x = Math.max(-EXTENT, Math.min(EXTENT, target.x));
    target.z = Math.max(-EXTENT, Math.min(EXTENT, target.z));
    rakeGroup.position.set(target.x, 0, target.z);
    onRakeMove(target.x, target.z);
  }

  function onUp() { dragging = false; }

  return { onDown, onMove, onUp };
}

function attachEvents(el, onDown, onMove, onUp) {
  el.addEventListener('mousedown',  e => onDown(e.clientX, e.clientY));
  el.addEventListener('mousemove',  e => onMove(e.clientX, e.clientY));
  el.addEventListener('mouseup',    () => onUp());
  el.addEventListener('touchstart', e => {
    e.preventDefault();
    onDown(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  el.addEventListener('touchmove',  e => {
    e.preventDefault();
    onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  el.addEventListener('touchend', () => onUp());
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
