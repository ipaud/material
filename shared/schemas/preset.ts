import { z } from 'zod';
import {
  materialStateSchema,
  modulationMappingSchema,
  paramRecordSchema,
  triggerMappingSchema,
} from './project';

export const presetSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  techniqueId: z.string(),
  params: paramRecordSchema,
  material: materialStateSchema,
  modulations: z.array(modulationMappingSchema),
  triggers: z.array(triggerMappingSchema).default([]),
  builtin: z.boolean(),
});
export type Preset = z.infer<typeof presetSchema>;

export const presetFileSchema = z.object({
  version: z.literal(1),
  presets: z.array(presetSchema),
});
export type PresetFile = z.infer<typeof presetFileSchema>;
