import * as THREE from 'three';

export function makeStone() {
  const stone = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.7, 1.0),
    new THREE.MeshLambertMaterial({ color: 0x666055 })
  );
  stone.position.set(1.5, 0.35, 0.5);
  stone.castShadow = true;
  return stone;
}
