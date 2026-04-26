/**
 * gpu-spike.js — GPU sand simulation spike
 *
 * Primary path:  THREE.WebGPURenderer + TSL Fn() compute shaders
 *   - 128×128 = 16 384 sand particles stored in StorageInstancedBufferAttribute
 *   - Each frame: compute pass disturbs particles near the rake and settles far ones
 *   - Rendered as instanced quads coloured by displacement depth
 *
 * Fallback path: WebGL2 + two RenderTarget ping-pong (fragment-shader simulation)
 *   - Same visual result without WebGPU
 *
 * Result: see PR description for findings on stability, fps, and iOS compatibility.
 */

// ─── WebGPU path imports ──────────────────────────────────────────────────────
// We use the three/webgpu bundle (includes WebGPURenderer + all node materials)
// and three/tsl for the TSL shader-building API.

import * as THREE from 'three/webgpu';
import {
  Fn,
  uniform,
  instancedArray,
  instanceIndex,
  vec2, vec3, vec4, float,
  mix, clamp, smoothstep,
  cameraProjectionMatrix,
  modelViewMatrix,
} from 'three/tsl';

// ─── Constants ───────────────────────────────────────────────────────────────

const GRID    = 128;             // particles per side
const COUNT   = GRID * GRID;     // total particle count  (16 384)
const EXTENT  = 7.0;             // half-width of sand area in world units
const SPACING = (EXTENT * 2) / GRID;   // ~0.109 world units

const RAKE_RADIUS   = 0.6;   // disturb radius, world units
const PUSH_STRENGTH = 0.09;
const SETTLE_RATE   = 0.012;

// ─── WebGPU scene ────────────────────────────────────────────────────────────

async function buildWebGPUScene() {

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();   // throws if WebGPU is not supported
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.insertBefore(renderer.domElement, document.getElementById('info'));

  document.querySelector('#info span').textContent = 'drag to rake · WebGPU compute ✓';

  // ── Scene / Camera / Lights ──────────────────────────────────────────────
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

  // ── Storage buffers ───────────────────────────────────────────────────────
  // dispBuffer: one float per particle [0..1] — 0 = undisturbed, 1 = deep groove
  const dispBuffer = instancedArray(COUNT, 'float');

  // ── Rake position uniform (world-space X, world-space Z) ─────────────────
  const uRakePos = uniform(new THREE.Vector2(9999, 9999));  // off-screen initially

  // ── Compute shader ────────────────────────────────────────────────────────
  // One invocation per particle.  Reads particle's logical (col, row) from its
  // linear index, reconstructs world XZ, measures distance to rake, then either
  // pushes or settles the displacement float.

  const sandCompute = Fn(() => {
    const idx = instanceIndex;

    // integer col and row from linear index
    const col = idx.modInt(GRID);
    const row = idx.div(GRID);   // integer division

    // world-space XZ centre of this particle
    const px = col.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));
    const pz = row.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));

    // distance to rake in world units
    const dx = px.sub(uRakePos.x);
    const dz = pz.sub(uRakePos.y);
    const dist = dx.mul(dx).add(dz.mul(dz)).sqrt();

    // influence peaks at 0 dist, falls to 0 at RAKE_RADIUS
    const influence = smoothstep(float(RAKE_RADIUS), float(0.0), dist);

    // current displacement
    const disp = dispBuffer.element(idx);

    // push up (increase) inside radius, always settle down gently
    disp.assign(
      clamp(
        disp.add(influence.mul(float(PUSH_STRENGTH))).sub(float(SETTLE_RATE)),
        float(0.0),
        float(1.0)
      )
    );
  })().compute(COUNT, [64]);

  // Initialise all displacements to 0
  await renderer.computeAsync(
    Fn(() => {
      dispBuffer.element(instanceIndex).assign(float(0.0));
    })().compute(COUNT, [64])
  );

  // ── Particle rendering ────────────────────────────────────────────────────
  // Strategy: InstancedMesh with flat PlaneGeometry tiles.  All instance
  // matrices are identity; the vertexNode reads world XZ and displacement from
  // dispBuffer by instanceIndex, computing the final clip-space position itself.
  //
  // The tile plane is in the XZ plane (rotated -90° on X) so it lies flat.

  const tileMat = new THREE.NodeMaterial();
  tileMat.side = THREE.DoubleSide;

  // vertex shader: compute world pos from instanceIndex + dispBuffer, project
  tileMat.vertexNode = Fn(() => {
    const idx = instanceIndex;
    const col = idx.modInt(GRID);
    const row = idx.div(GRID);

    const px = col.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));
    const pz = row.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));
    const py = dispBuffer.element(idx).mul(float(-0.18));

    // positionGeometry is the per-vertex local offset within the tile quad
    // (the PlaneGeometry is in XY; we need it in XZ)
    const localX = vec3(1, 0, 0);  // placeholder — we use raw XY below
    const tileHalf = float(SPACING * 0.52);

    // PlaneGeometry default: vertices in XY plane. We want XZ. Swap Y→-Z.
    const localPos = vec3(
      tileHalf.mul(2.0).mul(0.0), float(0), float(0)  // overridden per-vertex below
    );

    // Access the raw geometry vertex position (XY for a PlaneGeometry)
    // positionGeometry is a built-in that reads `position` attribute
    // For a PlaneGeometry: X runs across, Y runs along the second axis.
    // We want the tile in the XZ plane so we map: localX→world X, localY→world Z
    const worldPos = vec3(
      px.add(tileHalf.mul(2.0).mul(0.0)),  // will be replaced
      py,
      pz
    );

    // Use positionGeometry (the per-vertex local XY coords of the tile)
    // We need to bring in the raw position attribute of the geometry.
    // The cleanest way: build worldPos including the tile offset manually.
    // A PlaneGeometry of size S×S has verts at ±S/2 in X and Y.
    // Remap: local.x → world X offset, local.y → world Z offset (tile lies flat).

    // We can't easily call positionGeometry here without importing it, so
    // we use a varying-based workaround: multiply by the vertex position.
    // Actually positionGeometry IS available through the tsl bundle.  But
    // we already imported from three/tsl — we just didn't import that symbol.
    // Fall back to a compact approach: use THREE.js's attribute('position').
    //
    // NOTE: This comment block was written during development to reason through
    // the approach. The final working code is below.

    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(worldPos, 1.0)));
  })();

  // The vertex shader above is incomplete because it doesn't use the tile's
  // local vertex offsets. We need to import `positionGeometry` from three/tsl.
  // Rebuild properly:

  tileMat.dispose();  // discard the incomplete material

  // Full correct implementation:
  const { positionGeometry } = await import('three/tsl');

  const sandMat = new THREE.NodeMaterial();
  sandMat.side = THREE.DoubleSide;

  sandMat.vertexNode = Fn(() => {
    const idx = instanceIndex;
    const col = idx.modInt(GRID);
    const row = idx.div(GRID);

    const px = col.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));
    const pz = row.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));
    const py = dispBuffer.element(idx).mul(float(-0.18));

    // positionGeometry.x and .z are the local offsets of this vertex within the
    // tile quad (PlaneGeometry in XZ plane after rotation).
    const worldPos = vec3(
      px.add(positionGeometry.x),
      py,
      pz.add(positionGeometry.z)
    );

    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(worldPos, 1.0)));
  })();

  // Fragment: colour by displacement — light sand → dark groove
  const sandColor   = vec3(float(0.784), float(0.722), float(0.604));
  const grooveColor = vec3(float(0.353), float(0.251), float(0.133));

  sandMat.fragmentNode = Fn(() => {
    const d = dispBuffer.element(instanceIndex);
    return vec4(mix(sandColor, grooveColor, d), float(1.0));
  })();

  // PlaneGeometry in XZ plane (rotated -90° on X so it lies flat)
  const tileGeo = new THREE.PlaneGeometry(SPACING * 1.04, SPACING * 1.04);
  tileGeo.rotateX(-Math.PI / 2);

  const particles = new THREE.InstancedMesh(tileGeo, sandMat, COUNT);
  particles.frustumCulled = false;

  // All instance matrices: identity (position comes from vertexNode)
  const dummy = new THREE.Object3D();
  for (let i = 0; i < COUNT; i++) {
    dummy.updateMatrix();
    particles.setMatrixAt(i, dummy.matrix);
  }
  particles.instanceMatrix.needsUpdate = true;
  scene.add(particles);

  // ── Stone ─────────────────────────────────────────────────────────────────
  const stone = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.7, 1.0),
    new THREE.MeshLambertMaterial({ color: 0x666055 })
  );
  stone.position.set(1.5, 0.35, 0.5);
  scene.add(stone);

  // ── Rake visual ───────────────────────────────────────────────────────────
  const rakeGroup = buildRake();
  rakeGroup.position.set(0, 0, 2);
  scene.add(rakeGroup);

  // ── Input ─────────────────────────────────────────────────────────────────
  const { onDown, onMove, onUp } = buildInput(camera, rakeGroup, (wx, wz) => {
    uRakePos.value.set(wx, wz);
  });

  attachEvents(renderer.domElement, onDown, onMove, onUp);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ── Render loop ───────────────────────────────────────────────────────────
  let lastTime = performance.now();
  let frames = 0;
  const fpsLabel = document.querySelector('#info span');

  renderer.setAnimationLoop(() => {
    renderer.compute(sandCompute);
    renderer.render(scene, camera);

    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      fpsLabel.textContent = `drag to rake · WebGPU compute · ${frames} fps`;
      frames = 0;
      lastTime = now;
    }
  });
}

// ─── WebGL ping-pong fallback ─────────────────────────────────────────────────
// Uses two WebGLRenderTargets as a state texture (128×128, R=float = displacement).
// A fullscreen-quad fragment shader simulates one step per frame.
// A second instanced-mesh pass reads the texture and renders the sand tiles.

function buildWebGLFallback() {
  document.getElementById('fallback-banner').style.display = 'block';
  document.querySelector('#info span').textContent = 'drag to rake · WebGL fallback (ping-pong)';

  // Use the standard WebGL renderer for the fallback
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.insertBefore(renderer.domElement, document.getElementById('info'));

  // ── Simulation render targets ─────────────────────────────────────────────
  const rtOpts = {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    type: THREE.FloatType,
    format: THREE.RedFormat,
    depthBuffer: false,
  };
  let rtA = new THREE.WebGLRenderTarget(GRID, GRID, rtOpts);
  let rtB = new THREE.WebGLRenderTarget(GRID, GRID, rtOpts);

  // Clear both targets to 0
  renderer.setRenderTarget(rtA); renderer.clear();
  renderer.setRenderTarget(rtB); renderer.clear();
  renderer.setRenderTarget(null);

  // Fullscreen quad scene for simulation step
  const simScene  = new THREE.Scene();
  const simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // Normalised rake radius (RAKE_RADIUS relative to total UV span = EXTENT*2)
  const uRakeNorm = RAKE_RADIUS / (EXTENT * 2);

  const simMat = new THREE.ShaderMaterial({
    uniforms: {
      uState:   { value: rtA.texture },
      uRakePos: { value: new THREE.Vector2(9999, 9999) }, // UV [0,1], offscreen
      uRakeR:   { value: uRakeNorm },
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
        float cur = texture2D(uState, vUv).r;
        float d   = length(vUv - uRakePos);
        float t   = clamp((uRakeR - d) / uRakeR, 0.0, 1.0);
        float inf  = t * t * (3.0 - 2.0 * t);  // smoothstep
        float next = clamp(cur + inf * uPush - uSettle, 0.0, 1.0);
        gl_FragColor = vec4(next, 0.0, 0.0, 1.0);
      }
    `,
  });

  const simQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), simMat);
  simScene.add(simQuad);

  // ── Display scene ─────────────────────────────────────────────────────────
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

  // ── Instanced tile mesh ───────────────────────────────────────────────────
  // The vertex shader samples the displacement texture by gl_InstanceID to
  // offset Y and sets vDisp for colour interpolation.

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
        vec3 sand  = vec3(0.784, 0.722, 0.604);
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

  // ── Stone + rake ──────────────────────────────────────────────────────────
  const stone = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.7, 1.0),
    new THREE.MeshLambertMaterial({ color: 0x666055 })
  );
  stone.position.set(1.5, 0.35, 0.5);
  scene.add(stone);

  const rakeGroup = buildRake();
  rakeGroup.position.set(0, 0, 2);
  scene.add(rakeGroup);

  // ── Input ─────────────────────────────────────────────────────────────────
  const { onDown, onMove, onUp } = buildInput(camera, rakeGroup, (wx, wz) => {
    // Convert world XZ → UV [0,1]
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

  // ── Render loop ───────────────────────────────────────────────────────────
  let lastTime = performance.now();
  let frames = 0;
  const fpsLabel = document.querySelector('#info span');

  function animate() {
    requestAnimationFrame(animate);

    // 1. Simulate into rtB
    simMat.uniforms.uState.value = rtA.texture;
    renderer.setRenderTarget(rtB);
    renderer.render(simScene, simCamera);
    renderer.setRenderTarget(null);

    // 2. Swap buffers
    [rtA, rtB] = [rtB, rtA];

    // 3. Update display with latest state
    tileDisplayMat.uniforms.uDisp.value = rtA.texture;

    // 4. Render the display scene
    renderer.render(scene, camera);

    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      fpsLabel.textContent = `drag to rake · WebGL fallback · ${frames} fps`;
      frames = 0;
      lastTime = now;
    }
  }
  animate();
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

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

  function onDown(cx, cy) {
    dragging = true;
    updatePointer(cx, cy);
  }

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
  el.addEventListener('mouseup',    onUp);
  el.addEventListener('touchstart', e => {
    e.preventDefault();
    onDown(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  el.addEventListener('touchmove',  e => {
    e.preventDefault();
    onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  el.addEventListener('touchend', onUp);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;

  if (hasWebGPU) {
    try {
      await buildWebGPUScene();
    } catch (err) {
      console.warn('[gpu-spike] WebGPU init failed, falling back to WebGL ping-pong:', err);
      buildWebGLFallback();
    }
  } else {
    console.info('[gpu-spike] navigator.gpu absent — using WebGL ping-pong fallback');
    buildWebGLFallback();
  }
}

main();
