/** Built-in geometric materials. Shape index must match sdShape in shaders/chunks.ts. */
export interface BuiltinMaterial {
  id: string;
  name: string;
  category: 'Shape' | 'Typography';
  renderer: 'shape' | 'texture';
  shapeIndex: number;
}

export const BUILTIN_MATERIALS: BuiltinMaterial[] = [
  { id: 'square', name: 'Square', category: 'Shape', renderer: 'shape', shapeIndex: 0 },
  { id: 'circle', name: 'Circle', category: 'Shape', renderer: 'shape', shapeIndex: 1 },
  { id: 'line', name: 'Line', category: 'Shape', renderer: 'shape', shapeIndex: 2 },
  { id: 'dot', name: 'Dot', category: 'Shape', renderer: 'shape', shapeIndex: 3 },
  { id: 'rectangle', name: 'Rectangle', category: 'Shape', renderer: 'shape', shapeIndex: 4 },
  { id: 'triangle', name: 'Triangle', category: 'Shape', renderer: 'shape', shapeIndex: 5 },
  { id: 'typography', name: 'Typography', category: 'Typography', renderer: 'texture', shapeIndex: 0 },
];

export function isTextureMaterial(materialId: string): boolean {
  return materialId === 'custom' || BUILTIN_MATERIALS.some((material) => material.id === materialId && material.renderer === 'texture');
}

export function shapeIndexForMaterial(materialId: string): number {
  return BUILTIN_MATERIALS.find((m) => m.id === materialId)?.shapeIndex ?? 0;
}
