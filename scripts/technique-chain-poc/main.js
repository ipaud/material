import * as THREE from 'three';
import { LayerRuntimeImpl } from '@/rendering/layers/LayerRuntimeImpl';
import { OutputReplica } from '@/output-window/replica';
import { defaultParams } from '@/techniques/types';
import { mosaicDefinition } from '@/techniques/mosaic/definition';
import { createTechniqueRenderer } from '@/techniques/registry';
import { renderTechniqueChain } from '@/rendering/techniqueChain';

const W = 1920;
const H = 1080;
const FRAMES = 120;
const result = document.querySelector('#result');

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

function makeSource() {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = Math.round((x / W) * 255);
      data[i + 1] = Math.round((y / H) * 255);
      data[i + 2] = (x ^ y) & 255;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function makeTarget() {
  return new THREE.WebGLRenderTarget(W, H, {
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
}

function camera() {
  const cam = new THREE.PerspectiveCamera(20, W / H, 10, 100000);
  cam.position.z = H / 2 / Math.tan((20 * Math.PI) / 360);
  cam.near = Math.max(cam.position.z / 100, 1);
  cam.far = cam.position.z * 4;
  cam.updateProjectionMatrix();
  return cam;
}

function pixels(renderer, target) {
  const out = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(target, 0, 0, W, H, out);
  return out;
}

function maxDiff(a, b) {
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

function pixelSummary(data) {
  let nonzeroPixels = 0;
  let checksum = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0 || data[i + 3] !== 0)
      nonzeroPixels++;
    checksum = (checksum + data[i] + data[i + 1] * 3 + data[i + 2] * 7 + data[i + 3] * 11) >>> 0;
  }
  return { nonzeroPixels, checksum };
}

const cleanups = [];

try {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: true,
    powerPreference: 'high-performance',
  });
  cleanups.push(() => renderer.dispose());
  renderer.setSize(W, H, false);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const gl = renderer.getContext();
  const source = makeSource();
  cleanups.push(() => source.dispose());
  const targets = [makeTarget(), makeTarget()];
  cleanups.push(() => targets.forEach((target) => target.dispose()));
  const cam = camera();
  const material = {
    materialId: 'square',
    colorMode: 'source',
    params: { aspect: 1 },
    assetPath: null,
  };
  const definition = mosaicDefinition;
  const base = defaultParams(definition);
  const makeStage = (columns) => {
    const technique = createTechniqueRenderer(definition.id);
    cleanups.push(() => technique.dispose());
    const scene = new THREE.Scene();
    scene.add(technique.object3d);
    return { technique, scene, params: { ...base, columns, rows: Math.round((columns * H) / W) } };
  };
  const stages = [makeStage(48), makeStage(32), makeStage(24)];
  const context = (input) => ({
    sourceTexture: input,
    materialTexture: null,
    temporal: null,
    flow: null,
    compWidth: W,
    compHeight: H,
    material,
    timeSec: 0,
    seed: 1,
    renderer,
  });
  const draw = (stage, input, output) => {
    stage.technique.update(stage.params, context(input));
    renderer.setRenderTarget(output);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(stage.scene, cam);
  };
  const render = (count) => renderTechniqueChain(source, stages.slice(0, count), targets, draw);
  const outputCanvas = document.querySelector('#output-canvas');
  assert(outputCanvas instanceof HTMLCanvasElement, 'Output replica canvas is missing');
  outputCanvas.style.width = `${W / window.devicePixelRatio}px`;
  outputCanvas.style.height = `${H / window.devicePixelRatio}px`;
  const outputReplica = new OutputReplica();
  outputReplica.init(outputCanvas);
  cleanups.push(() => {
    outputReplica.handle({
      type: 'render-inputs',
      generation: 999,
      techniqueId: null,
      materialState: null,
      compWidth: W,
      compHeight: H,
      background: '#000000',
      source: null,
      layers: [],
    });
    outputReplica.dispose();
  });
  const timing = (count) => {
    for (let i = 0; i < 4; i++) render(count);
    gl.finish();
    const start = Date.now();
    for (let i = 0; i < FRAMES; i++) render(count);
    gl.finish();
    return Number(((Date.now() - start) / FRAMES).toFixed(2));
  };
  const gpuTimer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const gpuTiming = async (count) => {
    if (!gpuTimer || typeof gl.beginQuery !== 'function') return null;
    const query = gl.createQuery();
    if (!query) return null;
    try {
      gl.beginQuery(gpuTimer.TIME_ELAPSED_EXT, query);
      for (let i = 0; i < FRAMES; i++) render(count);
      gl.endQuery(gpuTimer.TIME_ELAPSED_EXT);
      for (let frame = 0; frame < 60 && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE); frame++) {
        await new Promise(requestAnimationFrame);
      }
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return null;
      if (gl.getParameter(gpuTimer.GPU_DISJOINT_EXT)) return null;
      return Number((gl.getQueryParameter(query, gl.QUERY_RESULT) / FRAMES / 1e6).toFixed(3));
    } finally {
      gl.deleteQuery(query);
    }
  };

  render(1);
  const baseline = pixels(renderer, targets[0]);
  render(1);
  const baselineRepeat = pixels(renderer, targets[0]);
  assert(maxDiff(baseline, baselineRepeat) === 0, 'one-stage render is not deterministic');
  const outputs = [];
  for (const count of [1, 2, 3]) {
    const firstTexture = render(count);
    const firstTarget = targets.find((target) => target.texture === firstTexture);
    const first = pixels(renderer, firstTarget);
    const secondTexture = render(count);
    const secondTarget = targets.find((target) => target.texture === secondTexture);
    const second = pixels(renderer, secondTarget);
    assert(maxDiff(first, second) === 0, `${count}-stage render is not deterministic`);
    const chainedPixels = pixelSummary(first);
    assert(chainedPixels.nonzeroPixels > 0, `${count}-stage render is empty`);
    outputs.push({
      stages: count,
      wallMsPerFrameUncalibrated: timing(count),
      gpuMsPerFrame: await gpuTiming(count),
      deterministicMaxDiff: maxDiff(first, second),
      nonzeroPixels: chainedPixels.nonzeroPixels,
      differsFromSingleStage: count === 1 ? false : maxDiff(baseline, first) > 0,
    });
  }
  const outputTarget = makeTarget();
  cleanups.push(() => outputTarget.dispose());
  const renderLiveRuntime = async (count) => {
    let outputSource = null;
    let exportSource = null;
    let replicaLayerInstalled = false;
    let outputSourceInstalled = false;
    const exportRuntime = new LayerRuntimeImpl();
    const exportConfigs = [];
    let exportPrimaryInstalled = false;
    try {
      outputSource = makeSource();
      exportSource = makeSource();
      const configs = [48, 32, 24].slice(0, count).map((columns, index) => ({
        stageId: index === 0 ? 'primary' : `stage-${index + 1}`,
        techniqueId: definition.id,
        params: { ...base, columns, rows: Math.round((columns * H) / W) },
      }));
      const stageOverrides = new Map(configs.slice(1).map(({ stageId, params }, index) => [
        stageId,
        { ...params, columns: params.columns + index + 1 },
      ]));
      outputReplica.handle({
        type: 'render-inputs',
        generation: count,
        techniqueId: configs[0].techniqueId,
        materialState: material,
        compWidth: W,
        compHeight: H,
        background: '#000000',
        source: null,
        layers: [{
          id: 'qa-output-layer',
          techniqueId: configs[0].techniqueId,
          techniqueParams: configs[0].params,
          techniqueChain: configs.slice(1).map(({ stageId, techniqueId, params }) => ({
            id: stageId,
            techniqueId,
            enabled: true,
            params,
          })),
          materialState: material,
          blendMode: 'normal',
          enabled: true,
          opacity: 1,
          source: null,
        }],
      });
      replicaLayerInstalled = true;
      const outputBranch = outputReplica.engine.branchFor('qa-output-layer');
      assert(outputBranch, 'Output replica layer branch was not created');
      outputBranch.setSource(outputSource);
      outputSourceInstalled = true;
      const outputRenderer = outputReplica.engine.renderer;
      assert(outputRenderer, 'Output replica renderer was not initialized');
      // Direct branch readback bypasses RenderEngine's per-layer authority map.
      outputBranch.setTechniqueParams(configs[0].params);
      outputBranch.setTechniqueStageParams(stageOverrides);
      exportRuntime.initBranch(renderer);
      exportRuntime.setComposition(W, H, '#000000');
      exportRuntime.setMaterialState(material);
      exportRuntime.setSource(exportSource);
      for (const { stageId, techniqueId, params } of configs) {
        exportConfigs.push({ stageId, renderer: createTechniqueRenderer(techniqueId), params });
      }
      exportRuntime.setTechniqueRenderer(exportConfigs[0].renderer);
      exportPrimaryInstalled = true;
      exportRuntime.setTechniqueParams(exportConfigs[0].params);
      exportRuntime.setTechniqueChain(exportConfigs.slice(1));
      exportRuntime.setTechniqueStageParams(stageOverrides);
      exportRuntime.setTechniqueScratchTargets(targets);
      exportRuntime.beginExportMode();
      renderer.setScissor(0, 0, Math.floor(W / 3), Math.floor(H / 3));
      renderer.setScissorTest(true);
      outputReplica.handle({
        type: 'frame',
        seq: count,
        wallEmittedAt: Date.now(),
        compTime: 0,
        techniqueId: configs[0].techniqueId,
        temporalActive: false,
        finalParams: configs[0].params,
        materialState: material,
        layerParams: { 'qa-output-layer': configs[0].params },
        layerStageParams: { 'qa-output-layer': Object.fromEntries(stageOverrides) },
        layerOpacity: { 'qa-output-layer': 1 },
      });
      const first = outputReplica.engine.renderStill(W, H);
      const second = outputReplica.engine.renderStill(W, H);
      assert(maxDiff(first, second) === 0, `Output replica ${count}-stage output is not deterministic`);
      const summary = pixelSummary(first);
      assert(summary.nonzeroPixels > 0, `Output replica ${count}-stage output is empty`);
      const outputBranchTarget = makeTarget();
      try {
        outputBranch.renderLayerTo(outputBranchTarget, { clear: true });
        const outputBranchPixels = pixels(outputRenderer, outputBranchTarget);
        exportRuntime.renderLayerTo(outputTarget, { clear: true });
        const exported = pixels(renderer, outputTarget);
        assert(renderer.getScissorTest(), 'export runtime did not restore canvas scissor test');
        const outputReplicaExportMaxDiff = maxDiff(outputBranchPixels, exported);
        assert(outputReplicaExportMaxDiff === 0, `OutputReplica ${count}-stage layer/export pixels differ by ${outputReplicaExportMaxDiff}`);
        return { stages: count, deterministicMaxDiff: maxDiff(first, second), outputReplicaExportMaxDiff, restoredScissorTest: renderer.getScissorTest(), ...summary };
      } finally {
        outputBranchTarget.dispose();
      }
    } finally {
      renderer.setScissorTest(false);
      if (replicaLayerInstalled) {
        outputReplica.handle({
          type: 'render-inputs',
          generation: count + 100,
          techniqueId: null,
          materialState: null,
          compWidth: W,
          compHeight: H,
          background: '#000000',
          source: null,
          layers: [],
        });
      }
      if (!outputSourceInstalled) outputSource?.dispose();
      exportRuntime.endExportMode();
      exportRuntime.disposeBranch();
      exportSource?.dispose();
      if (!exportPrimaryInstalled) exportConfigs[0]?.renderer.dispose();
      exportConfigs.slice(1).forEach(({ renderer: stage }) => stage.dispose());
    }
  };
  const runtimeOutputs = [];
  for (const count of [1, 2, 3]) runtimeOutputs.push(await renderLiveRuntime(count));
  const bytesPerTarget = W * H * 4;
  result.textContent = JSON.stringify(
    {
      gpu: gl.getParameter(gl.RENDERER),
      gpuTimerQueryAvailable: Boolean(gpuTimer),
      resolution: `${W}×${H}`,
      technique: 'Mosaic → Mosaic → Mosaic (stateless stages)',
      baselineSingleStageMaxDiff: maxDiff(baseline, baselineRepeat),
      baselinePixels: pixelSummary(baseline),
      drawCallsLastPass: renderer.info.render.calls,
      extraPingPongTargets: 2,
      targetMiBEach: Number((bytesPerTarget / 1024 / 1024).toFixed(2)),
      extraTargetMiB: Number(((2 * bytesPerTarget) / 1024 / 1024).toFixed(2)),
      results: outputs,
      outputReplicaResults: runtimeOutputs,
    },
    null,
    2,
  );
} catch (error) {
  result.textContent = `POC FAILED\n${error?.stack ?? error?.message ?? String(error)}`;
} finally {
  cleanups.reverse().forEach((dispose) => dispose());
}
