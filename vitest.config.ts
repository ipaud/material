import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Code whose job is to draw through WebGL (renderers, compositors, render targets, GPU readback
 * diagnostics, sources that turn media into textures). jsdom has no WebGL, so a unit test can only
 * mock the GPU away and assert the mock; these are verified on real pixels instead, in the packaged
 * app (scripts/identity-gate.mjs, the equivalence harness, the 128-grey colour check). A file that
 * only mentions WebGL in a comment or a type stays in the measure.
 */
const GPU_BOUND = [
  'src/rendering/RenderEngine.ts',
  'src/rendering/bindTarget.ts',
  'src/rendering/disposeScene.ts',
  'src/rendering/analysis/ImageStatsReducer.ts',
  'src/rendering/analysis/statsDiagnostics.ts',
  'src/rendering/feedback/FeedbackSurface.ts',
  'src/rendering/feedback/feedbackStep.ts',
  'src/rendering/flow/OpticalFlowField.ts',
  'src/rendering/flow/flowDiagnostics.ts',
  'src/rendering/layers/LayerCompositor.ts',
  'src/rendering/layers/LayerHost.ts',
  'src/rendering/layers/LayerRuntimeImpl.ts',
  'src/rendering/layers/VideoIngest.ts',
  'src/rendering/layers/layerDiagnostics.ts',
  'src/rendering/simulation/SimulationRunner.ts',
  'src/rendering/simulation/SimulationSurface.ts',
  'src/rendering/simulation/kernels.ts',
  'src/rendering/simulation/simDiagnostics.ts',
  'src/rendering/temporal/TemporalFrameProvider.ts',
  'src/rendering/temporal/sources.ts',
  'src/rendering/transition/TransitionCompositor.ts',
  'src/rendering/transition/transitionDiagnostics.ts',
  'src/techniques/*/*Renderer.ts',
  'src/techniques/preview/proceduralSource.ts',
  'src/shaders/CustomShaderRenderer.ts',
  'src/shaders/compileShader.ts',
  'src/shaders/shaderDiagnostics.ts',
  'src/sources/CameraSource.ts',
  'src/sources/DisplayCaptureSource.ts',
  'src/sources/FileImageSource.ts',
  'src/sources/FileVideoSource.ts',
  'src/sources/generators/GeneratorSource.ts',
  'src/output-window/outputCameraSource.ts',
  'src/output-window/outputCaptureSource.ts',
  'src/output-window/outputLayer.ts',
  'src/output-window/replica.ts',
  'src/materials/materialTextureSlot.ts',
  'src/materials/textureLoader.ts',
];

/** Process entry points: they only wire modules together and run when the packaged app starts. */
const ENTRY_POINTS = ['src/main.tsx', 'src/output-window/main.ts', 'electron/main/index.ts', 'electron/preload/index.ts'];

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'shared/**/*.ts', 'electron/**/*.ts'],
      exclude: [...GPU_BOUND, ...ENTRY_POINTS, '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { statements: 80 },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'shared'),
      '@electron': resolve(__dirname, 'electron'),
    },
  },
});
