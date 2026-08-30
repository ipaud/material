import * as THREE from 'three';

/**
 * CE1H — dispose every geometry a scene owns.
 *
 * Full-screen-quad passes each allocate a PlaneGeometry and several of them
 * disposed only their materials and render targets. Measured over a
 * 10-minute soak: geometry count grew monotonically 0 -> 4323 while textures,
 * programs and heap all stayed bounded, because a leaked geometry is small
 * enough that GC pressure never reveals it.
 */
export function disposeSceneGeometry(scene: THREE.Object3D): void {
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
}
