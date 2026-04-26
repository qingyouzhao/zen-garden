/**
 * gpu-spike.js — GPU sand simulation spike
 *
 * Primary path:  THREE.WebGPURenderer + TSL Fn() compute shaders
 *   - 128×128 = 16 384 sand particles stored in StorageInstancedBufferAttribute
 *   - Each frame: compute pass disturbs particles near the rake and settles far ones
 *   - Rendered as instanced sprites coloured by displacement depth
 *
 * Fallback path: WebGL2 + two RenderTarget ping-pong (fragment-shader simulation)
 *   - Same visual result without WebGPU
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  uniform,
  instancedArray,
  instanceIndex,
  vec2, vec3, float, int,
  mix, clamp, length, min, max, smoothstep, step,
  If,
  abs, floor,
} from 'three/tsl';

// ─── Constants ───────────────────────────────────────────────────────────────

const GRID   = 128;           // particles per side
const COUNT  = GRID * GRID;   // total particle count
const EXTENT = 7.0;           // half-width of sand area (world units)
const SPACING = (EXTENT * 2) / GRID;

// ─── Renderer detection ──────────────────────────────────────────────────────

let usingWebGPU = false;

async function buildWebGPUScene() {

  // ── WebGPU renderer ──────────────────────────────────────────────────────
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.insertBefore(renderer.domElement, document.getElementById('info'));

  usingWebGPU = true;
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

  // ── Storage buffers (one float per particle: displacement depth 0..1) ────
  const dispBuffer = instancedArray(COUNT, 'float');   // GPU-side displacement

  // ── Uniform for rake world-space position ─────────────────────────────────
  const uRakePos = uniform(new THREE.Vector2(0, 0));   // xz

  // ── Compute shader: TSL Fn ────────────────────────────────────────────────
  //   Each invocation processes one particle (instanceIndex = particle id).
  //   Particles within rake radius get pushed down; outside slowly spring up.

  const RAKE_RADIUS   = 0.55;  // world units of disturbance
  const PUSH_STRENGTH = 0.08;
  const SETTLE_RATE   = 0.015;

  const computeSand = Fn(() => {
    const idx = instanceIndex;

    // Reconstruct world-space XZ from linear index
    const col = idx.modInt(GRID);                  // 0..127
    const row = floor(idx.toFloat().div(float(GRID)));  // 0..127

    const px = col.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));
    const pz = row.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));

    const dx = px.sub(uRakePos.x);
    const dz = pz.sub(uRakePos.y);   // uRakePos.y holds world-Z
    const dist = dx.mul(dx).add(dz.mul(dz)).sqrt();

    const disp = dispBuffer.element(idx);

    // Within rake radius: displace downward (increase value toward 1)
    const influence = smoothstep(float(RAKE_RADIUS), float(0.0), dist);
    const newDisp = clamp(
      disp.add(influence.mul(float(PUSH_STRENGTH))).sub(float(SETTLE_RATE)),
      float(0.0),
      float(1.0)
    );

    disp.assign(newDisp);
  })().compute(COUNT, [64]);

  // Initialise displacements to zero
  await renderer.computeAsync(
    Fn(() => {
      dispBuffer.element(instanceIndex).assign(float(0.0));
    })().compute(COUNT, [64])
  );

  // ── Particle mesh: instanced Sprites driven by positionNode ──────────────
  //
  // SpriteNodeMaterial.positionNode supplies the world-space offset per instance.
  // We rebuild the XZ from instanceIndex and use dispBuffer for Y (groove depth).

  const particleMaterial = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  particleMaterial.sizeAttenuation = true;

  // Position: flat XZ grid, Y driven by -displacement (grooves go below y=0)
  particleMaterial.positionNode = Fn(() => {
    const idx = instanceIndex;
    const col = idx.modInt(GRID);
    const row = floor(idx.toFloat().div(float(GRID)));
    const px = col.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));
    const pz = row.toFloat().mul(float(SPACING)).sub(float(EXTENT - SPACING * 0.5));
    const py = dispBuffer.element(idx).mul(float(-0.18));  // groove depth in world Y
    return vec3(px, py, pz);
  })();

  // Colour: light sand (#c8b89a) → dark groove (#5a4022) by displacement
  const sandColor  = vec3(float(0.784), float(0.722), float(0.604));
  const grooveColor = vec3(float(0.353), float(0.251), float(0.133));
  particleMaterial.colorNode = Fn(() => {
    const d = dispBuffer.element(instanceIndex);
    return mix(sandColor, grooveColor, d);
  })();

  // Sprite size slightly larger than grid spacing so they tile without gaps
  particleMaterial.scaleNode = vec2(float(SPACING * 1.05), float(SPACING * 1.05));

  // Instanced mesh — geometry is just a single point; SpriteNodeMaterial
  // expands it into a billboard quad on the GPU.
  const particleGeom = new THREE.BufferGeometry();
  particleGeom.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(new Float32Array(COUNT * 3), 3)
  );
  particleGeom.instanceCount = COUNT;   // tell the renderer how many instances

  // Three.js SpriteNodeMaterial wraps everything, but we need InstancedMesh
  // for instancedArray to bind correctly. Use InstancedMesh with 1-vert geo.
  // Actually SpriteNodeMaterial + InstancedMesh is the idiomatic TSL pattern.
  const dummyGeo = new THREE.PlaneGeometry(SPACING * 1.05, SPACING * 1.05);
  const particles = new THREE.InstancedMesh(dummyGeo, particleMaterial, COUNT);
  particles.frustumCulled = false;

  // Populate dummy instance matrices (identity; actual positions come from positionNode)
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
  const rakeGroup = new THREE.Group();
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 3.5, 8),
    new THREE.MeshLambertMaterial({ color: 0x8b5e3c })
  );
  handle.rotation.x = Math.PI / 4;
  handle.position.set(0, 0.9, -0.6);
  rakeGroup.add(handle);

  const rakeHead = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.06, 0.12),
    new THREE.MeshLambertMaterial({ color: 0x6b4c2a })
  );
  rakeHead.position.set(0, 0.06, 0);
  rakeGroup.add(rakeHead);

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

  // ── Input ─────────────────────────────────────────────────────────────────
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
    uRakePos.value.set(target.x, target.z);
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

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ── Render loop ───────────────────────────────────────────────────────────
  // computeSand is a ComputeNode; calling renderer.compute() each frame runs it.
  // updateBefore on the material nodes handles per-render compute automatically
  // when you add the node to a scene, but here we want explicit control.

  let lastTime = performance.now();
  let frames = 0;
  const fpsLabel = document.querySelector('#info span');

  renderer.setAnimationLoop(async () => {
    // Run the compute pass every frame regardless of rake activity
    // (particles need to settle continuously)
    renderer.compute(computeSand);

    renderer.render(scene, camera);

    // FPS counter
    frames++;
    const now = performance.now();
    if (now - lastTime >= 1000) {
      fpsLabel.textContent = `drag to rake · WebGPU compute · ${frames} fps`;
      frames = 0;
      lastTime = now;
    }
  });
}

// ─── Fragment-shader ping-pong fallback ──────────────────────────────────────
// Uses two WebGLRenderTargets to simulate the sand state as a texture.
// Each pixel = one particle; R channel = displacement 0..1.

function buildWebGLFallback() {
  document.getElementById('fallback-banner').style.display = 'block';
  document.querySelector('#info span').textContent = 'drag to rake · WebGL fallback (ping-pong)';

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
  };
  let rtA = new THREE.WebGLRenderTarget(GRID, GRID, rtOpts);
  let rtB = new THREE.WebGLRenderTarget(GRID, GRID, rtOpts);

  // Clear rtA to 0
  renderer.setRenderTarget(rtA);
  renderer.clear();
  renderer.setRenderTarget(null);

  // Fullscreen quad scene for ping-pong
  const simScene  = new THREE.Scene();
  const simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const simMat = new THREE.ShaderMaterial({
    uniforms: {
      uState:     { value: rtA.texture },
      uRakePos:   { value: new THREE.Vector2(999, 999) },
      uRakeR:     { value: 0.55 / (EXTENT * 2) },   // normalised to [0,1] UV space
      uPush:      { value: 0.08 },
      uSettle:    { value: 0.015 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uState;
      uniform vec2  uRakePos;  // rake in UV space [0,1]
      uniform float uRakeR;
      uniform float uPush;
      uniform float uSettle;
      varying vec2 vUv;

      float smoothstepGL(float edge0, float edge1, float x) {
        float t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
        return t * t * (3.0 - 2.0 * t);
      }

      void main() {
        float cur = texture2D(uState, vUv).r;
        float d = length(vUv - uRakePos);
        float influence = smoothstepGL(uRakeR, 0.0, d);
        float next = clamp(cur + influence * uPush - uSettle, 0.0, 1.0);
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

  // ── Particle display: instanced planes ────────────────────────────────────
  // Build a grid of instanced flat squares; a vertex shader samples the
  // displacement texture by instance index to set Y and colour.

  const displayMat = new THREE.ShaderMaterial({
    uniforms: {
      uDisp: { value: rtA.texture },
      uGrid: { value: GRID },
      uExtent: { value: EXTENT },
      uSpacing: { value: SPACING },
    },
    vertexShader: /* glsl */`
      uniform sampler2D uDisp;
      uniform float uGrid;
      uniform float uExtent;
      uniform float uSpacing;

      varying float vDisp;

      void main() {
        float id = float(gl_InstanceID);
        float col = mod(id, uGrid);
        float row = floor(id / uGrid);

        // UV into displacement texture
        vec2 uv = (vec2(col, row) + 0.5) / uGrid;
        float d = texture2D(uDisp, uv).r;
        vDisp = d;

        float px = col * uSpacing - (uExtent - uSpacing * 0.5);
        float pz = row * uSpacing - (uExtent - uSpacing * 0.5);
        float py = d * -0.18;

        vec4 worldPos = vec4(position, 1.0);
        worldPos.x += px;
        worldPos.y += py;
        worldPos.z += pz;

        gl_Position = projectionMatrix * modelViewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */`
      varying float vDisp;
      void main() {
        vec3 sandColor   = vec3(0.784, 0.722, 0.604);
        vec3 grooveColor = vec3(0.353, 0.251, 0.133);
        gl_FragColor = vec4(mix(sandColor, grooveColor, vDisp), 1.0);
      }
    `,
  });

  const tileGeo = new THREE.PlaneGeometry(SPACING * 1.02, SPACING * 1.02);
  tileGeo.rotateX(-Math.PI / 2);

  const particles = new THREE.InstancedMesh(tileGeo, displayMat, COUNT);
  particles.frustumCulled = false;

  const dummy = new THREE.Object3D();
  for (let i = 0; i < COUNT; i++) {
    dummy.updateMatrix();
    particles.setMatrixAt(i, dummy.matrix);
  }
  particles.instanceMatrix.needsUpdate = true;
  scene.add(particles);

  // ── Stone + rake ──────────────────────────────────────────────────────────
  const stone = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.7, 1.0),
    new THREE.MeshLambertMaterial({ color: 0x666055 })
  );
  stone.position.set(1.5, 0.35, 0.5);
  scene.add(stone);

  const rakeGroup = new THREE.Group();
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.04, 3.5, 8),
    new THREE.MeshLambertMaterial({ color: 0x8b5e3c })
  );
  handle.rotation.x = Math.PI / 4;
  handle.position.set(0, 0.9, -0.6);
  rakeGroup.add(handle);
  const rakeHead = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.06, 0.12),
    new THREE.MeshLambertMaterial({ color: 0x6b4c2a })
  );
  rakeHead.position.y = 0.06;
  rakeGroup.add(rakeHead);
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

  // ── Input ─────────────────────────────────────────────────────────────────
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

    // Convert world XZ → UV [0,1] for the sim shader
    const u = (target.x + EXTENT) / (EXTENT * 2);
    const v = (target.z + EXTENT) / (EXTENT * 2);
    simMat.uniforms.uRakePos.value.set(u, v);
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

    // Ping-pong: simulate into rtB reading from rtA
    simMat.uniforms.uState.value = rtA.texture;
    renderer.setRenderTarget(rtB);
    renderer.render(simScene, simCamera);
    renderer.setRenderTarget(null);

    // Swap
    [rtA, rtB] = [rtB, rtA];

    // Update display material with latest state texture
    displayMat.uniforms.uDisp.value = rtA.texture;

    // Render display scene
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

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  // Probe WebGPU availability — THREE.WebGPURenderer constructor does this,
  // but we need to know before committing to the import path.
  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;

  if (hasWebGPU) {
    try {
      await buildWebGPUScene();
    } catch (err) {
      console.warn('WebGPU scene failed, falling back to WebGL ping-pong:', err);
      buildWebGLFallback();
    }
  } else {
    console.info('navigator.gpu not available — using WebGL ping-pong fallback');
    buildWebGLFallback();
  }
}

main();
