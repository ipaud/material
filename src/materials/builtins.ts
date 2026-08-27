/** Built-in geometric materials. Shape index must match sdShape in shaders/chunks.ts. */
export interface BuiltinMaterial {
  id: string;
  name: string;
  shapeIndex: number;
}

export const BUILTIN_MATERIALS: BuiltinMaterial[] = [
  { id: 'square', name: 'Square', shapeIndex: 0 },
  { id: 'circle', name: 'Circle', shapeIndex: 1 },
  { id: 'line', name: 'Line', shapeIndex: 2 },
  { id: 'dot', name: 'Dot', shapeIndex: 3 },
  { id: 'rectangle', name: 'Rectangle', shapeIndex: 4 },
  { id: 'triangle', name: 'Triangle', shapeIndex: 5 },
];

export function shapeIndexForMaterial(materialId: string): number {
  return BUILTIN_MATERIALS.find((m) => m.id === materialId)?.shapeIndex ?? 0;
}
