/**
 * gpu-particle.js — GPU 3D particle simulation
 *
 * Forked from gpu-spike.js. Key difference: each particle has full 3D
 * position + velocity. The rake ejects near-ground particles into the air;
 * gravity, floor bounce, and a home spring return them to rest.
 *
 * State per particle (two vec4 storage buffers):
 *   posBuffer: (world.x, world.y, world.z, home.x)
 *   velBuffer: (vel.x,   vel.y,   vel.z,   home.z)
 *
 * Primary path:  THREE.WebGPURenderer + TSL Fn() compute shaders
 * Fallback path: WebGL2 ping-pong render targets (pos + vel textures)
 */

import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, instancedArray, instanceIndex,
  positionGeometry, cameraProjectionMatrix, modelViewMatrix,
  vec3, vec4, float,
  clamp, smoothstep,
} from 'three/tsl';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRID    = 128;
const COUNT   = GRID * GRID;   // 16 384 particles
const EXTENT  = 7.0;

const HEX_R  = (EXTENT * 2) / GRID / Math.sqrt(3);
const H_STEP = HEX_R * Math.sqrt(3);
const V_STEP = HEX_R * 1.5;

const RAKE_RADIUS    = 0.9;
const GRAVITY        = 14.0;
const BOUNCE         = 0.22;
const FLOOR_FRICTION = 0.78;
const SPRING_K       = 2.5;
const MAX_EJECT      = 12.0;

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
  scene.fog = new THREE.Fog(0x1a1612, 22, 42);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 12, 12);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xfff5e0, 0.7));
  const sun = new THREE.DirectionalLight(0xfff0cc, 1.5);
  sun.position.set(5, 12, 8);
  scene.add(sun);

  // -------------------------------------------------------------------------
  // GPU state buffers: vec4 per particle
  // -------------------------------------------------------------------------
  const posBuffer = instancedArray(COUNT, 'vec4'); // (pos.xyz, home.x)
  const velBuffer = instancedArray(COUNT, 'vec4'); // (vel.xyz, home.z)

  const uRakePos   = uniform(new THREE.Vector2(9999, 9999));
  const uRakeDir   = uniform(new THREE.Vector2(1, 0));
  const uRakeSpeed = uniform(0.0);
  const uDt        = uniform(0.016);

  // -------------------------------------------------------------------------
  // Init compute: place particles at hex grid positions, zero velocity
  // -------------------------------------------------------------------------
  const initCompute = Fn(() => {
    const idx = instanceIndex;
    const col = idx.modInt(GRID);
    const row = idx.div(GRID);
    const isOdd = row.modInt(2).toFloat();

    const homeX = col.toFloat().mul(float(H_STEP))
      .add(isOdd.mul(float(H_STEP * 0.5)))
      .sub(float(EXTENT));
    const homeZ = row.toFloat().mul(float(V_STEP)).sub(float(EXTENT));

    posBuffer.element(idx).assign(vec4(homeX, float(0.0), homeZ, homeX));
    velBuffer.element(idx).assign(vec4(float(0.0), float(0.0), float(0.0), homeZ));
  })().compute(COUNT, [64]);

  await renderer.computeAsync(initCompute);

  // -------------------------------------------------------------------------
  // Simulation compute
  // -------------------------------------------------------------------------
  const simCompute = Fn(() => {
    const idx = instanceIndex;

    const pv = posBuffer.element(idx).toVar();
    const vv = velBuffer.element(idx).toVar();

    const px    = pv.x.toVar();
    const py    = pv.y.toVar();
    const pz    = pv.z.toVar();
    const homeX = pv.w;

    const vx    = vv.x.toVar();
    const vy    = vv.y.toVar();
    const vz    = vv.z.toVar();
    const homeZ = vv.w;

    // Rake influence: smoothstep gate within rake radius, near-ground only
    const dx   = px.sub(uRakePos.x);
    const dz   = pz.sub(uRakePos.y);
    const dist = dx.mul(dx).add(dz.mul(dz)).sqrt();

    const nearRake   = smoothstep(float(RAKE_RADIUS), float(0.0), dist);
    const nearGround = smoothstep(float(0.4), float(0.0), py);
    const impulse    = nearRake.mul(nearGround).mul(uRakeSpeed);

    // Per-particle spread: deterministic pseudo-random from home position
    const seed       = homeX.mul(float(17.3)).add(homeZ.mul(float(13.7)));
    const perpFactor = seed.sin().mul(float(0.45));
    // Perpendicular to rake direction in XZ
    const perpX = uRakeDir.y.negate();
    const perpZ = uRakeDir.x;

    vx.assign(clamp(
      vx.add(uRakeDir.x.add(perpX.mul(perpFactor)).mul(impulse).mul(float(5.0))),
      float(-MAX_EJECT), float(MAX_EJECT)
    ));
    vy.assign(clamp(
      vy.add(impulse.mul(float(15.0))),
      float(0.0), float(MAX_EJECT)
    ));
    vz.assign(clamp(
      vz.add(uRakeDir.y.add(perpZ.mul(perpFactor)).mul(impulse).mul(float(5.0))),
      float(-MAX_EJECT), float(MAX_EJECT)
    ));

    // Home spring: horizontal only, only while near ground
    const groundWeight = nearGround;
    vx.assign(vx.add(homeX.sub(px).mul(float(SPRING_K)).mul(uDt).mul(groundWeight)));
    vz.assign(vz.add(homeZ.sub(pz).mul(float(SPRING_K)).mul(uDt).mul(groundWeight)));

    // Gravity
    vy.assign(vy.sub(float(GRAVITY).mul(uDt)));

    // Integrate
    px.assign(px.add(vx.mul(uDt)));
    py.assign(py.add(vy.mul(uDt)));
    pz.assign(pz.add(vz.mul(uDt)));

    // Floor collision
    If(py.lessThan(float(0.0)), () => {
      py.assign(float(0.0));
      vy.assign(vy.abs().negate().mul(float(BOUNCE)));
      vx.assign(vx.mul(float(FLOOR_FRICTION)));
      vz.assign(vz.mul(float(FLOOR_FRICTION)));
    });

    // Bounds clamp
    px.assign(clamp(px, float(-EXTENT), float(EXTENT)));
    pz.assign(clamp(pz, float(-EXTENT), float(EXTENT)));

    posBuffer.element(idx).assign(vec4(px, py, pz, homeX));
    velBuffer.element(idx).assign(vec4(vx, vy, vz, homeZ));
  })().compute(COUNT, [64]);

  // -------------------------------------------------------------------------
  // Particle rendering: instanced hex tiles, height-tinted
  // -------------------------------------------------------------------------
  const sandMat = new THREE.NodeMaterial();
  sandMat.side = THREE.DoubleSide;

  const sandColor = vec3(float(0.784), float(0.722), float(0.604));
  const airColor  = vec3(float(0.96),  float(0.89),  float(0.76));

  sandMat.vertexNode = Fn(() => {
    const pv = posBuffer.element(instanceIndex);
    const worldPos = vec3(
      pv.x.add(positionGeometry.x),
      pv.y,
      pv.z.add(positionGeometry.z)
    );
    return cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(worldPos, float(1.0))));
  })();

  sandMat.fragmentNode = Fn(() => {
    const py = posBuffer.element(instanceIndex).y;
    const t  = clamp(py.div(float(2.5)), float(0.0), float(1.0));
    return vec4(sandColor.mix(airColor, t), float(1.0));
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
    renderer.computeAsync(initCompute);
  });

  const { onDown, onMove, onUp } = buildInput(camera, rakeGroup, (wx, wz, dx, dz) => {
    uRakePos.value.set(wx, wz);
    uRakeDir.value.set(dx, dz);
  });
  attachEvents(renderer.domElement, onDown, onMove, onUp, () => {
    uRakeSpeed.value = 0;
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  let lastTime     = performance.now();
  let fpsLastTime  = performance.now();
  let frames       = 0;
  let prevRakeX    = 9999;
  let prevRakeZ    = 9999;
  const fpsLabel   = document.querySelector('#info span');

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt  = Math.min((now - lastTime) / 1000, 0.05);
    lastTime  = now;
    uDt.value = dt;

    // Rake speed from per-frame position delta
    const rx = uRakePos.value.x;
    const rz = uRakePos.value.y;
    if (prevRakeX < 9000) {
      const ddx   = rx - prevRakeX;
      const ddz   = rz - prevRakeZ;
      const speed = Math.sqrt(ddx * ddx + ddz * ddz) / dt;
      uRakeSpeed.value = Math.min(speed * 0.12, 1.0);
    }
    prevRakeX = rx;
    prevRakeZ = rz;

    renderer.compute(simCompute);
    renderer.render(scene, camera);

    frames++;
    if (now - fpsLastTime >= 1000) {
      fpsLabel.textContent = `drag to rake  |  ${backendLabel}  |  ${frames} fps`;
      frames    = 0;
      fpsLastTime = now;
    }
  });
}

// ---------------------------------------------------------------------------
// GLSL ping-pong fallback (WebGL2 — two render-target pairs: pos + vel)
// ---------------------------------------------------------------------------

function buildGLSLFallback() {
  document.getElementById('fallback-banner').style.display = 'block';
  document.querySelector('#info span').textContent = 'drag to rake  |  GLSL ping-pong  |  -- fps';

  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.insertBefore(renderer.domElement, document.getElementById('info'));

  // Ping-pong render target options — RGBA float for negative values
  const rtOpts = {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    type:      THREE.FloatType,
    format:    THREE.RGBAFormat,
    depthBuffer: false,
  };
  let rtPosA = new THREE.WebGLRenderTarget(GRID, GRID, rtOpts);
  let rtPosB = new THREE.WebGLRenderTarget(GRID, GRID, rtOpts);
  let rtVelA = new THREE.WebGLRenderTarget(GRID, GRID, rtOpts);
  let rtVelB = new THREE.WebGLRenderTarget(GRID, GRID, rtOpts);

  // ---- Build init DataTextures (CPU hex grid) -----------------------------
  const posData = new Float32Array(GRID * GRID * 4);
  const velData = new Float32Array(GRID * GRID * 4);
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const i     = (row * GRID + col) * 4;
      const isOdd = row % 2;
      const hx    = col * H_STEP + (isOdd ? H_STEP * 0.5 : 0) - EXTENT;
      const hz    = row * V_STEP - EXTENT;
      posData[i]   = hx;  posData[i+1] = 0; posData[i+2] = hz;  posData[i+3] = hx;
      velData[i]   = 0;   velData[i+1] = 0; velData[i+2] = 0;   velData[i+3] = hz;
    }
  }
  const initPosTex = new THREE.DataTexture(posData, GRID, GRID, THREE.RGBAFormat, THREE.FloatType);
  initPosTex.needsUpdate = true;
  const initVelTex = new THREE.DataTexture(velData, GRID, GRID, THREE.RGBAFormat, THREE.FloatType);
  initVelTex.needsUpdate = true;

  // ---- Blit helper: copy DataTexture into a render target -----------------
  const simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const blitMat   = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: null } },
    vertexShader:   'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
    fragmentShader: 'uniform sampler2D uTex; varying vec2 vUv; void main(){gl_FragColor=texture2D(uTex,vUv);}',
  });
  const blitScene = new THREE.Scene();
  blitScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat));

  function resetTargets() {
    blitMat.uniforms.uTex.value = initPosTex;
    renderer.setRenderTarget(rtPosA); renderer.render(blitScene, simCamera);
    renderer.setRenderTarget(rtPosB); renderer.render(blitScene, simCamera);
    blitMat.uniforms.uTex.value = initVelTex;
    renderer.setRenderTarget(rtVelA); renderer.render(blitScene, simCamera);
    renderer.setRenderTarget(rtVelB); renderer.render(blitScene, simCamera);
    renderer.setRenderTarget(null);
  }
  resetTargets();

  // ---- Velocity update shader (reads posA + velA → writes velB) -----------
  const velUniforms = {
    uPos:      { value: null },
    uVel:      { value: null },
    uRakePos:  { value: new THREE.Vector2(9999, 9999) },
    uRakeDir:  { value: new THREE.Vector2(1, 0) },
    uRakeSpeed: { value: 0.0 },
    uDt:       { value: 0.016 },
  };
  const velMat = new THREE.ShaderMaterial({
    uniforms: velUniforms,
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: `
      uniform sampler2D uPos;
      uniform sampler2D uVel;
      uniform vec2  uRakePos;
      uniform vec2  uRakeDir;
      uniform float uRakeSpeed;
      uniform float uDt;
      varying vec2 vUv;

      void main() {
        vec4 pos = texture2D(uPos, vUv);
        vec4 vel = texture2D(uVel, vUv);

        float px = pos.x, py = pos.y, pz = pos.z;
        float homeX = pos.w, homeZ = vel.w;
        float vx = vel.x, vy = vel.y, vz = vel.z;

        vec2  dp       = vec2(px, pz) - uRakePos;
        float dist     = length(dp);
        float nearRake   = 1.0 - smoothstep(0.0, ${RAKE_RADIUS.toFixed(2)}, dist);
        float nearGround = 1.0 - smoothstep(0.0, 0.4, py);
        float impulse    = nearRake * nearGround * uRakeSpeed;

        float seed       = homeX * 17.3 + homeZ * 13.7;
        float perpFactor = sin(seed) * 0.45;
        vec2  perp       = vec2(-uRakeDir.y, uRakeDir.x);

        vx = clamp(vx + (uRakeDir.x + perp.x * perpFactor) * impulse * 5.0, -${MAX_EJECT.toFixed(1)}, ${MAX_EJECT.toFixed(1)});
        vy = clamp(vy + impulse * 15.0, 0.0, ${MAX_EJECT.toFixed(1)});
        vz = clamp(vz + (uRakeDir.y + perp.y * perpFactor) * impulse * 5.0, -${MAX_EJECT.toFixed(1)}, ${MAX_EJECT.toFixed(1)});

        vx += (homeX - px) * ${SPRING_K.toFixed(1)} * uDt * nearGround;
        vz += (homeZ - pz) * ${SPRING_K.toFixed(1)} * uDt * nearGround;

        vy -= ${GRAVITY.toFixed(1)} * uDt;

        if (py <= 0.0) {
          vy = -abs(vy) * ${BOUNCE.toFixed(2)};
          vx *= ${FLOOR_FRICTION.toFixed(2)};
          vz *= ${FLOOR_FRICTION.toFixed(2)};
        }

        gl_FragColor = vec4(vx, vy, vz, homeZ);
      }
    `,
  });
  const velScene = new THREE.Scene();
  velScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), velMat));

  // ---- Position update shader (reads posA + velB → writes posB) -----------
  const posMat = new THREE.ShaderMaterial({
    uniforms: {
      uPos: { value: null },
      uVel: { value: null },
      uDt:  { value: 0.016 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: `
      uniform sampler2D uPos;
      uniform sampler2D uVel;
      uniform float uDt;
      varying vec2 vUv;

      void main() {
        vec4 pos = texture2D(uPos, vUv);
        vec4 vel = texture2D(uVel, vUv);

        float px = clamp(pos.x + vel.x * uDt, -${EXTENT.toFixed(1)}, ${EXTENT.toFixed(1)});
        float py = max(pos.y + vel.y * uDt, 0.0);
        float pz = clamp(pos.z + vel.z * uDt, -${EXTENT.toFixed(1)}, ${EXTENT.toFixed(1)});

        gl_FragColor = vec4(px, py, pz, pos.w);
      }
    `,
  });
  const posScene = new THREE.Scene();
  posScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), posMat));

  // ---- Display scene: instanced hex tiles reading from pos texture ---------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1612);
  scene.fog = new THREE.Fog(0x1a1612, 22, 42);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 12, 12);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xfff5e0, 0.7));
  const sun = new THREE.DirectionalLight(0xfff0cc, 1.5);
  sun.position.set(5, 12, 8);
  scene.add(sun);

  const tileDisplayMat = new THREE.ShaderMaterial({
    uniforms: {
      uPos:    { value: rtPosA.texture },
      uGrid:   { value: GRID },
      uHStep:  { value: H_STEP },
      uVStep:  { value: V_STEP },
      uExtent: { value: EXTENT },
    },
    vertexShader: `
      uniform sampler2D uPos;
      uniform float uGrid;
      uniform float uHStep;
      uniform float uVStep;
      uniform float uExtent;
      varying float vHeight;

      void main() {
        float id  = float(gl_InstanceID);
        float col = mod(id, uGrid);
        float row = floor(id / uGrid);
        vec2  uv  = (vec2(col, row) + 0.5) / uGrid;
        vec4  pos = texture2D(uPos, uv);
        vHeight = pos.y;

        vec3 worldPos = position + vec3(pos.x, pos.y, pos.z);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
      }
    `,
    fragmentShader: `
      varying float vHeight;
      void main() {
        vec3 sand = vec3(0.784, 0.722, 0.604);
        vec3 air  = vec3(0.96,  0.89,  0.76);
        float t = clamp(vHeight / 2.5, 0.0, 1.0);
        gl_FragColor = vec4(mix(sand, air, t), 1.0);
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

  document.getElementById('clear-btn').addEventListener('click', resetTargets);

  const { onDown, onMove, onUp } = buildInput(camera, rakeGroup, (wx, wz, dx, dz) => {
    velUniforms.uRakePos.value.set(wx, wz);
    velUniforms.uRakeDir.value.set(dx, dz);
  });
  attachEvents(renderer.domElement, onDown, onMove, onUp, () => {
    velUniforms.uRakeSpeed.value = 0;
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  let lastTime    = performance.now();
  let fpsLastTime = performance.now();
  let frames      = 0;
  let prevRakeX   = 9999;
  let prevRakeZ   = 9999;
  const fpsLabel  = document.querySelector('#info span');

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const dt  = Math.min((now - lastTime) / 1000, 0.05);
    lastTime  = now;

    velUniforms.uDt.value = dt;
    posMat.uniforms.uDt.value = dt;

    // Rake speed
    const rx = velUniforms.uRakePos.value.x;
    const rz = velUniforms.uRakePos.value.y;
    if (prevRakeX < 9000) {
      const ddx   = rx - prevRakeX;
      const ddz   = rz - prevRakeZ;
      const speed = Math.sqrt(ddx * ddx + ddz * ddz) / dt;
      velUniforms.uRakeSpeed.value = Math.min(speed * 0.12, 1.0);
    }
    prevRakeX = rx;
    prevRakeZ = rz;

    // Pass 1: update velocities → rtVelB
    velMat.uniforms.uPos.value = rtPosA.texture;
    velMat.uniforms.uVel.value = rtVelA.texture;
    renderer.setRenderTarget(rtVelB);
    renderer.render(velScene, simCamera);

    // Pass 2: update positions → rtPosB (uses old posA + new velB)
    posMat.uniforms.uPos.value = rtPosA.texture;
    posMat.uniforms.uVel.value = rtVelB.texture;
    renderer.setRenderTarget(rtPosB);
    renderer.render(posScene, simCamera);

    renderer.setRenderTarget(null);

    // Swap ping-pong pairs
    [rtPosA, rtPosB] = [rtPosB, rtPosA];
    [rtVelA, rtVelB] = [rtVelB, rtVelA];

    tileDisplayMat.uniforms.uPos.value = rtPosA.texture;
    renderer.render(scene, camera);

    frames++;
    if (now - fpsLastTime >= 1000) {
      fpsLabel.textContent = `drag to rake  |  GLSL ping-pong  |  ${frames} fps`;
      frames    = 0;
      fpsLastTime = now;
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
  handle.position.set(0, 1.327, 1.237);
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
  let dragging  = false;
  let prevWorld = null;
  let lastDir   = { x: 1, z: 0 };

  function updatePointer(cx, cy) {
    pointer.x = (cx / window.innerWidth)  *  2 - 1;
    pointer.y = (cy / window.innerHeight) * -2 + 1;
  }

  function onDown(cx, cy) {
    dragging  = true;
    prevWorld = null;
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

    if (prevWorld) {
      const ddx = target.x - prevWorld.x;
      const ddz = target.z - prevWorld.z;
      const len = Math.sqrt(ddx * ddx + ddz * ddz);
      if (len > 0.001) lastDir = { x: ddx / len, z: ddz / len };
    }
    prevWorld = { x: target.x, z: target.z };
    rakeGroup.rotation.y = Math.atan2(lastDir.x, lastDir.z);
    onRakeMove(target.x, target.z, lastDir.x, lastDir.z);
  }

  function onUp() { dragging = false; prevWorld = null; }

  return { onDown, onMove, onUp };
}

function attachEvents(el, onDown, onMove, onUp, onRelease) {
  el.addEventListener('mousedown',  e => onDown(e.clientX, e.clientY));
  el.addEventListener('mousemove',  e => onMove(e.clientX, e.clientY));
  el.addEventListener('mouseup',    () => { onUp(); onRelease(); });
  el.addEventListener('touchstart', e => {
    e.preventDefault();
    onDown(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  el.addEventListener('touchmove',  e => {
    e.preventDefault();
    onMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  el.addEventListener('touchend', () => { onUp(); onRelease(); });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  try {
    await buildTSLScene();
  } catch (err) {
    console.warn('[gpu-particle] TSL scene failed — falling back to GLSL ping-pong:', err);
    buildGLSLFallback();
  }
}

main();
