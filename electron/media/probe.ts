import path from 'node:path';
import { z } from 'zod';
import type { MediaMetadata } from '../../shared/schemas/media';
import { runFfprobeJson } from './ffmpeg';
import { approveMediaPath, validateMediaPath } from '../filesystem/mediaRegistry';

const ffprobeStreamSchema = z.object({
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  channels: z.number().optional(),
  sample_rate: z.string().optional(),
});

const ffprobeOutputSchema = z.object({
  format: z.object({ duration: z.string().optional() }).optional(),
  streams: z.array(ffprobeStreamSchema).default([]),
});

function parseFrameRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split('/').map(Number);
  if (!num || !den || !Number.isFinite(num) || !Number.isFinite(den)) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

/** Probe a media file, approve it for material:// streaming, return metadata. */
export async function probeMedia(filePath: string): Promise<MediaMetadata> {
  const { kind, size } = validateMediaPath(filePath);
  approveMediaPath(filePath);

  const base: MediaMetadata = {
    kind,
    path: filePath,
    fileName: path.basename(filePath),
    fileSize: size,
    durationSec: null,
    width: null,
    height: null,
    frameRate: null,
    videoCodec: null,
    audioCodec: null,
    audioChannels: null,
    sampleRate: null,
  };

  if (kind === 'svg') return base;

  const raw = await runFfprobeJson(filePath);
  const probed = ffprobeOutputSchema.parse(raw);

  const video = probed.streams.find((s) => s.codec_type === 'video');
  const audio = probed.streams.find((s) => s.codec_type === 'audio');
  const duration = probed.format?.duration ? Number(probed.format.duration) : null;

  return {
    ...base,
    durationSec: duration !== null && Number.isFinite(duration) ? duration : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    frameRate: parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    audioChannels: audio?.channels ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
  };
}
