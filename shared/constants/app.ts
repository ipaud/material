export const APP_NAME = 'MATERIAL';
export const PROJECT_EXTENSION = 'material';
/**
 * v4 (v0.6): the single creative branch became `layers[]`. See migrateV3toV4 —
 * the change could not be additive, because v3 has exactly one place to say
 * what renders.
 *
 * v5 (v0.7): Takes. The shape IS additive and a v4 file needs nothing but the
 * stamp — see migrateV4toV5. The version moved anyway so that a v0.7 project
 * carrying a recorded performance is REFUSED by v0.6.1 instead of silently
 * loading with the performance stripped out by the schema.
 *
 * v6: Pins capture layer input routing and activity windows. A stamp prevents
 * older builds from stripping those nested fields when saving a project.
 *
 * v7: Layers can store up to two additional ordered technique instances. A
 * stamp prevents older builds from silently dropping those stages on save.
 */
export const PROJECT_FORMAT_VERSION = 7;

export const SUPPORTED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const;
export const SUPPORTED_VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v'] as const;
export const SUPPORTED_AUDIO_EXTENSIONS = ['wav', 'mp3', 'aac', 'm4a'] as const;
export const SUPPORTED_SVG_EXTENSIONS = ['svg'] as const;

export const MAX_MOSAIC_INSTANCES = 65536;
export const MOSAIC_INSTANCE_WARNING = 40000;
