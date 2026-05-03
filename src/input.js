import * as THREE from 'three';

const BOUNDS = 6.5;
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/**
 * Wire up pointer and touch input for garden interaction.
 *
 * onDown(x, z)           — pointer pressed, projected to world XZ
 * onMove(x, z, dx, dz)   — pointer moved; dx/dz are raw deltas from last position
 * onUp()                 — pointer released
 */
export function createPointerInput(camera, domElement, { onDown, onMove, onUp } = {}) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const target = new THREE.Vector3();
  let dragging = false;
  let prevX = 0, prevZ = 0, hasPrev = false;

  function updatePointer(clientX, clientY) {
    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;
  }

  function project() {
    raycaster.setFromCamera(pointer, camera);
    raycaster.ray.intersectPlane(groundPlane, target);
    target.x = Math.max(-BOUNDS, Math.min(BOUNDS, target.x));
    target.z = Math.max(-BOUNDS, Math.min(BOUNDS, target.z));
  }

  function handleDown(clientX, clientY) {
    dragging = true;
    hasPrev = false;
    updatePointer(clientX, clientY);
    project();
    onDown?.(target.x, target.z);
  }

  function handleMove(clientX, clientY) {
    if (!dragging) return;
    updatePointer(clientX, clientY);
    project();
    const dx = hasPrev ? target.x - prevX : 0;
    const dz = hasPrev ? target.z - prevZ : 0;
    prevX = target.x;
    prevZ = target.z;
    hasPrev = true;
    onMove?.(target.x, target.z, dx, dz);
  }

  function handleUp() {
    dragging = false;
    hasPrev = false;
    onUp?.();
  }

  domElement.addEventListener('mousedown', e => handleDown(e.clientX, e.clientY));
  domElement.addEventListener('mousemove', e => handleMove(e.clientX, e.clientY));
  domElement.addEventListener('mouseup', handleUp);
  domElement.addEventListener('touchstart', e => {
    e.preventDefault();
    handleDown(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  domElement.addEventListener('touchmove', e => {
    e.preventDefault();
    handleMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  domElement.addEventListener('touchend', handleUp);
}
