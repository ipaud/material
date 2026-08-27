import { z } from 'zod';

export const mediaKindSchema = z.enum(['image', 'video', 'audio', 'svg']);
export type MediaKind = z.infer<typeof mediaKindSchema>;

/** Metadata extracted by ffprobe (or image decode) in the main process. */
export const mediaMetadataSchema = z.object({
  kind: mediaKindSchema,
  path: z.string(),
  fileName: z.string(),
  fileSize: z.number().nonnegative(),
  durationSec: z.number().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  frameRate: z.number().positive().nullable(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  audioChannels: z.number().int().positive().nullable(),
  sampleRate: z.number().int().positive().nullable(),
});
export type MediaMetadata = z.infer<typeof mediaMetadataSchema>;
