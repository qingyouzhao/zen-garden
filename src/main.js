import * as THREE from 'three';
import { createScene } from './scene.js';
import { makeStone } from './stone.js';
import { buildRake } from './rake.js';
import { createPointerInput } from './input.js';

const { renderer, scene, camera } = createScene();

// --- Sand plane ---
const sand = new THREE.Mesh(
  new THREE.PlaneGeometry(14, 14),
  new THREE.MeshLambertMaterial({ color: 0xc8b89a })
);
sand.rotation.x = -Math.PI / 2;
sand.receiveShadow = true;
scene.add(sand);

scene.add(makeStone());

const rakeGroup = buildRake();
rakeGroup.position.set(0, 0, 2);
scene.add(rakeGroup);

createPointerInput(camera, renderer.domElement, {
  onMove(x, z) {
    rakeGroup.position.set(x, 0, z);
  },
});

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
