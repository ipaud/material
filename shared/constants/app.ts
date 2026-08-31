export const APP_NAME = 'MATERIAL';
export const PROJECT_EXTENSION = 'material';
/**
 * v4 (v0.6): the single creative branch became `layers[]`. See migrateV3toV4 —
 * the change could not be additive, because v3 has exactly one place to say
 * what renders.
 */
export const PROJECT_FORMAT_VERSION = 4;

export const SUPPORTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const;
export const SUPPORTED_VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v'] as const;
export const SUPPORTED_AUDIO_EXTENSIONS = ['wav', 'mp3', 'aac', 'm4a'] as const;
export const SUPPORTED_SVG_EXTENSIONS = ['svg'] as const;

export const MAX_MOSAIC_INSTANCES = 65536;
export const MOSAIC_INSTANCE_WARNING = 40000;
