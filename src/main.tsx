import React from 'react';
import type * as THREE from 'three';
import { TemporalFrameProvider } from './rendering/temporal/TemporalFrameProvider';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { engine } from './rendering/RenderEngine';
import { useProjectStore } from './state/projectStore';
import { useUiStore } from './state/uiStore';
import { runtimeBus } from './runtime/RuntimeBus';
import { patternClockAt, timingFromTimeline } from './pattern/patternClock';
import { compilePattern } from './pattern/compilePattern';
import { evaluatePattern } from './pattern/evaluatePattern';
import { patternRandom01 } from './pattern/patternRandom';
import { formatSequencePattern, parsePattern } from './pattern/miniNotation';
import { getPatternCompileCount, getPatternDiagnostics } from './pattern/patternSourceRuntime';
import { useOutputStore } from './state/outputStore';
import { importMediaPaths, openProjectFromPath } from './projects/projectActions';
import { modulationRuntime } from './modulation/runtime';
import * as modulationActions from './modulation/modulationActions';
import { playback } from './playback/PlaybackController';
import { createFrameEvaluator, runAnimationExport } from './export/exportRunner';
import { useExportStore } from './state/exportStore';
import * as presetActions from './projects/presetActions';
import { analyzeBuffer, sampleTrack } from './audio/analysis';
import { detectTempo } from './audio/tempo';
import { useAudioStore } from './state/audioStore';
import { morphRuntime } from './performance/morphRuntime';
import * as lookCore from './performance/lookCore';
import * as interpolate from './performance/interpolate';
import * as lookActions from './projects/lookActions';
import * as performanceActions from './performance/performanceActions';
import { candidateRuntime, useCandidateStore } from './performance/candidateRuntime';
import * as mutation from './performance/mutation';
import * as triggerRuntime from './signals/triggerRuntime';
import { midiEngine, useMidiStore } from './midi/midiEngine';
import { FakeMidiTransport, WebMidiTransport } from './midi/transport';
import { cameraManager, useCameraStore } from './sources/cameraManager';
import { captureManager, useCaptureStore } from './sources/captureManager';
import { BUILTIN_PRESETS, applyPreset } from './projects/presetActions';
import * as flowDiag from './rendering/flow/flowDiagnostics';
import * as simDiag from './rendering/simulation/simDiagnostics';
import * as transDiag from './rendering/transition/transitionDiagnostics';
import './styles/global.css';

// Dev-only handle for QA tooling (CDP-driven tests).
if (import.meta.env.DEV) {
  Object.assign(window, {
    __dev: {
      engine,
      runtimeBus,
      useOutputStore,
      /** Pattern Engine P2: pure compile/evaluate surface (read-only, dev). */
      patternEngine: {
        compilePattern,
        evaluatePattern,
        patternRandom01,
        /** P4: last-evaluated state of each live pattern source. */
        sources: getPatternDiagnostics,
        compileCount: getPatternCompileCount,
        /** P7: mini-notation (read-only helpers, no project mutation). */
        parse: parsePattern,
        format: formatSequencePattern,
      },
      /** Pattern Engine P1: inspect the pure clock at any composition time. */
      patternClock: {
        at(timeSec?: number, beatsPerCycle?: number) {
          const t = timeSec ?? playback.getTime();
          const timing = timingFromTimeline(useProjectStore.getState().project.timeline);
          return patternClockAt(t, timing, beatsPerCycle);
        },
      },
      useProjectStore,
      /** 18D: camera lifecycle (QA drives the same path as the UI). */
      cameraManager,
      useCameraStore,
      /** 18E: screen/window capture lifecycle (QA drives the UI path). */
      captureManager,
      useCaptureStore,
      /** CE1A: preset QA drives the same actions as the PresetBar. */
      presets: { BUILTIN_PRESETS, applyPreset },
      importMediaPaths,
      runAnimationExport,
      /** CE1G: transition goldens (endpoints, coverage, determinism). */
      transitionGoldens() {
        const e = engine as unknown as { renderer: THREE.WebGLRenderer | null };
        return e.renderer ? transDiag.runTransitionGoldens(e.renderer) : null;
      },
      TemporalFrameProvider,
      /** CE1H §32: replicate the EXPORT loop for one time two ways (full
       * progression vs subrange prime) and hash each stage, to find which
       * input actually differs. */
      async temporalExportProbe(T = 2, fps = 12, from = 1, w = 160, h = 90) {
        const e = engine as unknown as {
          renderer: THREE.WebGLRenderer | null;
          temporal: import('./rendering/temporal/TemporalFrameProvider').TemporalFrameProvider | null;
          generator: { texture(): THREE.Texture | null } | null;
        };
        if (!e.renderer) return null;
        const params = useProjectStore.getState().project.techniques[0]?.params ?? {};
        const hash = (buf: Uint8Array) => {
          let x = 2166136261;
          for (let i = 0; i < buf.length; i += 13) x = Math.imul(x ^ buf[i]!, 16777619);
          return (x >>> 0).toString(16);
        };
        const stage = async (t: number, first: boolean) => {
          engine.setExportPreviousTime(first ? Math.max(t - 1 / fps, 0) : null);
          engine.prepareGeneratorForExport(t, w, h);
          if (engine.isTemporalActive) await engine.prepareTemporalForExport(t, first);
          engine.prepareFeedbackForExport(t, first, params);
        };
        const probe = () => ({
          raw: e.temporal ? e.temporal.readAtlas(e.renderer!) : null,
          atlas: e.temporal ? e.temporal.slotHashes(e.renderer!).join('|') : '',
          head: e.temporal ? e.temporal.getUniforms().head : -1,
          filled: e.temporal ? e.temporal.getUniforms().filled : -1,
          anchor: e.temporal ? e.temporal.getUniforms().anchorTime : -1,
          frame: hash(engine.renderStill(w, h, params)),
        });
        engine.beginExportMode();
        // SUBRANGE: the export starts at T.
        e.temporal?.invalidate();
        await stage(T, true);
        const sub = probe();
        // FULL: starts at `from` and walks to T.
        e.temporal?.invalidate();
        let first = true;
        for (let t = from; t <= T + 1e-9; t += 1 / fps) {
          await stage(t, first);
          first = false;
        }
        const full = probe();
        engine.endExportMode();
        // Full-byte atlas comparison, reported per tile and per tile-edge.
        let rawDiff = 0;
        const tiles = new Set<number>();
        let edgeDiff = 0;
        if (sub.raw && full.raw) {
          const { width, pixels: pa } = sub.raw;
          const pb = full.raw.pixels;
          const sw = e.temporal!.config.slotWidth;
          const sh = e.temporal!.config.slotHeight;
          for (let i = 0; i < pa.length; i += 4) {
            if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2]) {
              rawDiff++;
              const px = (i / 4) % width;
              const py = Math.floor(i / 4 / width);
              const tx = Math.floor(px / sw);
              const ty = Math.floor(py / sh);
              tiles.add(ty * e.temporal!.cols + tx);
              const ix = px % sw;
              const iy = py % sh;
              if (ix === 0 || ix === sw - 1 || iy === 0 || iy === sh - 1) edgeDiff++;
            }
          }
        }
        return {
          atlasSame: sub.atlas === full.atlas,
          rawAtlasDiffPx: rawDiff,
          rawAtlasDiffTiles: [...tiles].sort((x, y) => x - y),
          rawAtlasEdgeDiffPx: edgeDiff,
          frameSame: sub.frame === full.frame,
          headSub: sub.head,
          headFull: full.head,
          filledSub: sub.filled,
          filledFull: full.filled,
          anchorSub: sub.anchor,
          anchorFull: full.anchor,
          frameSub: sub.frame,
          frameFull: full.frame,
        };
      },
      /** CE1H §32: build the SAME composition time two ways and compare the
       * atlas by logical slot — separates content from placement. */
      async temporalPathCompare(T = 2, fps = 12, from = 1) {
        const e = engine as unknown as {
          renderer: THREE.WebGLRenderer | null;
          temporal: import('./rendering/temporal/TemporalFrameProvider').TemporalFrameProvider | null;
          temporalSource: unknown;
          boundaryMode: string;
        };
        if (!e.renderer || !e.temporal || !e.temporalSource) return null;
        const tp = e.temporal;
        const src = e.temporalSource as Parameters<typeof tp.primeExact>[2];
        const mode = e.boundaryMode as Parameters<typeof tp.primeExact>[3];
        // Path A: prime directly at T (what a SUBRANGE export does).
        await tp.primeExact(e.renderer, T, src, mode);
        const a = { head: tp.getStats().anchorTime, hashes: tp.slotHashes(e.renderer) };
        // Path B: prime at `from`, then advance frame by frame to T.
        tp.invalidate();
        await tp.primeExact(e.renderer, from, src, mode);
        for (let t = from + 1 / fps; t <= T + 1e-9; t += 1 / fps) {
          await tp.advanceExact(e.renderer, t, src, mode);
        }
        const b = { head: tp.getStats().anchorTime, hashes: tp.slotHashes(e.renderer) };
        const diff: number[] = [];
        for (let k = 0; k < a.hashes.length; k++) if (a.hashes[k] !== b.hashes[k]) diff.push(k);
        return {
          anchorA: a.head,
          anchorB: b.head,
          slots: a.hashes.length,
          differing: diff.length,
          firstDiffering: diff.slice(0, 12),
          sampleA: a.hashes.slice(0, 6),
          sampleB: b.hashes.slice(0, 6),
        };
      },
      /**
       * CE1H §6-7 — PRESET contact sheet.
       *
       * Renders every preset against the CURRENT source and tiles the
       * results, so curation happens by looking at the catalog instead of
       * reading parameter tables.
       *
       * Each tile goes through the EXPORT preparation path, not a bare
       * renderStill: history, feedback and flow all have to be primed from
       * composition time or every temporal preset renders the same bare
       * frame and the sheet reports them as identical. (It did, the first
       * time — the "duplicates" were the harness, not the catalog.)
       */
      async presetSheet(atSec = 2, cell = 160, filter?: string) {
        const list = BUILTIN_PRESETS.filter((p) => !filter || p.category === filter);
        const cols = 12;
        const rows = Math.ceil(list.length / cols);
        const cw = cell;
        const ch = Math.round((cell * 9) / 16);
        const cv = document.createElement('canvas');
        cv.width = cols * cw;
        cv.height = rows * ch;
        const ctx = cv.getContext('2d')!;
        ctx.fillStyle = '#101010';
        ctx.fillRect(0, 0, cv.width, cv.height);
        const meta: { name: string; category: string; technique: string; mean: number }[] = [];
        for (let i = 0; i < list.length; i++) {
          const preset = list[i]!;
          applyPreset(preset);
          // Let the bridge install the preset's technique renderer.
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const params = useProjectStore.getState().project.techniques[0]?.params ?? {};
          engine.beginExportMode();
          engine.setExportPreviousTime(Math.max(atSec - 1 / 12, 0));
          engine.prepareGeneratorForExport(atSec, cw, ch);
          engine.prepareFlowForExport(atSec, 'sheet:' + i, true, cw, ch, params);
          if (engine.isTemporalActive) await engine.prepareTemporalForExport(atSec, true);
          engine.prepareFeedbackForExport(atSec, true, params);
          const px = engine.renderStill(cw, ch, params);
          engine.endExportMode();
          const img = ctx.createImageData(cw, ch);
          img.data.set(px);
          ctx.putImageData(img, (i % cols) * cw, Math.floor(i / cols) * ch);
          let sum = 0;
          for (let k = 0; k < px.length; k += 4) sum += (px[k]! + px[k + 1]! + px[k + 2]!) / 3;
          meta.push({
            name: preset.name,
            category: preset.category,
            technique: preset.techniqueId,
            mean: +(sum / (px.length / 4)).toFixed(1),
          });
        }
        return { url: cv.toDataURL('image/png'), cols, cell: [cw, ch], meta };
      },
      /** CE1G: visual contact sheet — every style at .25/.5/.75, as a PNG
       * data URL, for curation by eye. */
      transitionSheet() {
        const e = engine as unknown as { renderer: THREE.WebGLRenderer | null };
        if (!e.renderer) return null;
        const s = transDiag.transitionContactSheet(e.renderer);
        const cv = document.createElement('canvas');
        cv.width = s.width;
        cv.height = s.height;
        const ctx = cv.getContext('2d')!;
        const img = ctx.createImageData(s.width, s.height);
        // GL reads bottom-up; flip into canvas order.
        for (let y = 0; y < s.height; y++) {
          const src = (s.height - 1 - y) * s.width * 4;
          img.data.set(s.pixels.subarray(src, src + s.width * 4), y * s.width * 4);
        }
        ctx.putImageData(img, 0, 0);
        return { url: cv.toDataURL('image/png'), labels: s.labels, w: s.width, h: s.height };
      },
      /** CE1E: the simulation verification protocol (CA truth machine + RD
       * numeric stability), CE1D-2 methodology. */
      simHarness() {
        const e = engine as unknown as { renderer: THREE.WebGLRenderer | null };
        if (!e.renderer) return null;
        const out: Record<string, unknown> = {};
        try {
          // CA GOLDENS — exact cell truth
          out.block0 = simDiag.runCellularGolden(e.renderer, 'block', 0).cells;
          out.block4 = simDiag.runCellularGolden(e.renderer, 'block', 4).cells;
          out.blinker0 = simDiag.runCellularGolden(e.renderer, 'blinker', 0).cells;
          out.blinker1 = simDiag.runCellularGolden(e.renderer, 'blinker', 1).cells;
          out.blinker2 = simDiag.runCellularGolden(e.renderer, 'blinker', 2).cells;
          out.glider0 = simDiag.runCellularGolden(e.renderer, 'glider', 0).cells;
          out.glider4 = simDiag.runCellularGolden(e.renderer, 'glider', 4).cells;
          out.glider8 = simDiag.runCellularGolden(e.renderer, 'glider', 8).cells;
        } catch (err) {
          out.caError = String(err);
        }
        try {
          // RD stability + determinism
          out.rd0 = simDiag.runRdGolden(e.renderer, 0);
          out.rd10 = simDiag.runRdGolden(e.renderer, 10);
          out.rd100 = simDiag.runRdGolden(e.renderer, 100);
          out.rd500 = simDiag.runRdGolden(e.renderer, 500);
          out.rdSeedA = simDiag.runRdGolden(e.renderer, 50, { seed: 7 });
          out.rdSeedA2 = simDiag.runRdGolden(e.renderer, 50, { seed: 7 });
          out.rdSeedB = simDiag.runRdGolden(e.renderer, 50, { seed: 99 });
        } catch (err) {
          out.rdError = String(err);
        }
        return out;
      },
      /** CE1D-2: the full flow verification protocol on a clean process.
       * Self-tests first; throws loudly if the harness itself is broken. */
      async flowHarness() {
        // STATIC import (top of file): a dynamic import in dev loads a
        // SECOND module graph with a second 'three' — objects from one copy
        // rendered by the other fail silently. This was the root cause of
        // every zero/contradictory probe in CE1D.
        const { runFlowGolden, FlowProbe, canaryAB, canaryCD, canaryE } = flowDiag;
        const e = engine as unknown as { renderer: THREE.WebGLRenderer | null };
        if (!e.renderer) return null;
        // standalone harness self-test at a fixed grid
        const probe = new FlowProbe(e.renderer, 320, 180);
        const self = probe.selfTest();
        probe.dispose();
        const px = (n: number) => n / 320; // grid px → uv at 320-wide grid
        const cases = [
          { name: 'STATIC', du: 0, dv: 0 },
          { name: 'RIGHT2', du: px(2), dv: 0 },
          { name: 'LEFT2', du: -px(2), dv: 0 },
          { name: 'UP2', du: 0, dv: px(2) },
          { name: 'DOWN2', du: 0, dv: -px(2) },
          { name: 'DIAG2', du: px(2), dv: -px(2) },
          { name: 'RIGHT1', du: px(1), dv: 0 },
          { name: 'RIGHT4', du: px(4), dv: 0 },
          { name: 'RIGHT8', du: px(8), dv: 0 },
          { name: 'RIGHT16', du: px(16), dv: 0 },
        ];
        const canary = { ...canaryAB(e.renderer), ...canaryCD(e.renderer), E: canaryE(e.renderer) };
        const out: Record<string, unknown> = { canary, selfTest: self };
        for (const kase of cases) {
          try {
            out[kase.name] = runFlowGolden(e.renderer, kase);
          } catch (err) {
            out[kase.name] = { error: String(err) };
          }
        }
        // resolution sweep on RIGHT2
        for (const dim of [256, 512]) {
          try {
            out[`RIGHT2@${dim}`] = runFlowGolden(e.renderer, { name: `R2@${dim}`, du: 2 / dim, dv: 0 }, dim);
          } catch (err) {
            out[`RIGHT2@${dim}`] = { error: String(err) };
          }
        }
        return out;
      },
      /** CE1D dev-only: the LK shader ALONE over a shader-painted packed
       * texture (R = box at x0, G = box at x0-shift). Isolates math from
       * the class pipeline. */
      async testLKIsolated(shiftTexels = 2) {
        const three = await import('three');
        const { LK_FRAG_EXPORTED } = await import('./rendering/flow/OpticalFlowField');
        const e = engine as unknown as { renderer: THREE.WebGLRenderer | null };
        if (!e.renderer) return null;
        const W = 128, H = 64;
        const cam = new three.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
        const vs = 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy*2.0,0.0,1.0);}';
        const packed = new three.WebGLRenderTarget(W, H, { depthBuffer: false }); // RGBA8 probe
        const paint = new three.ShaderMaterial({ vertexShader: vs, depthTest: false, depthWrite: false,
          fragmentShader:
            'precision highp float; varying vec2 vUv; uniform float uShift;' +
            'float box(vec2 uv, float cx){ vec2 d = abs(uv - vec2(cx, 0.5));' +
            '  float b = smoothstep(0.13, 0.10, max(d.x, d.y)); return b; }' +
            'void main(){ float cur = box(vUv, 0.5); float prev = box(vUv, 0.5 - uShift);' +
            '  gl_FragColor = vec4(cur, prev, 0.0, 1.0); }',
          uniforms: { uShift: { value: shiftTexels / W } } });
        const ps = new three.Scene(); ps.add(new three.Mesh(new three.PlaneGeometry(1, 1), paint));
        const out = new three.WebGLRenderTarget(W, H, { depthBuffer: false, type: three.FloatType });
        const lk = new three.ShaderMaterial({ vertexShader: vs, fragmentShader: LK_FRAG_EXPORTED,
          depthTest: false, depthWrite: false,
          uniforms: { uPacked: { value: null }, uTexel: { value: new three.Vector2(1 / W, 1 / H) } } });
        const ls = new three.Scene(); ls.add(new three.Mesh(new three.PlaneGeometry(1, 1), lk));
        const draw = (t: THREE.WebGLRenderTarget, s: THREE.Scene) => {
          const p = e.renderer!.getRenderTarget();
          e.renderer!.setRenderTarget(t); e.renderer!.setViewport(0, 0, W, H);
          e.renderer!.setScissorTest(false); e.renderer!.render(s, cam);
          e.renderer!.setRenderTarget(p);
        };
        draw(packed, ps);
        lk.uniforms.uPacked!.value = packed.texture;
        draw(out, ls);
        const buf = new Float32Array(W * H * 4);
        e.renderer.readRenderTargetPixels(out, 0, 0, W, H, buf);
        const pk = new Float32Array(W * H * 4);
        e.renderer.readRenderTargetPixels(packed, 0, 0, W, H, pk);
        let n = 0, sx = 0, mx = 0, itMax = 0;
        for (let i = 0; i < W * H; i++) {
          const x = buf[i * 4]!, y = buf[i * 4 + 1]!;
          const m = Math.hypot(x, y);
          if (m > mx) mx = m;
          if (m > 1e-4) { n++; sx += x; }
          const it = Math.abs(pk[i * 4]! - pk[i * 4 + 1]!);
          if (it > itMax) itMax = it;
        }
        packed.dispose(); out.dispose(); paint.dispose(); lk.dispose();
        return { n, meanX: n ? sx / n : 0, maxMag: mx, itMax };
      },
      /** CE1D dev-only: sample-a-texture → float RT; and 1-tap LK probe. */
      async testFloatSample() {
        const three = await import('three');
        const e = engine as unknown as { renderer: THREE.WebGLRenderer | null };
        if (!e.renderer) return null;
        // luma-like source RT with a known gradient
        const src = new three.WebGLRenderTarget(8, 8, { depthBuffer: false });
        const gmat = new three.ShaderMaterial({
          vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy*2.0,0.0,1.0);}',
          fragmentShader: 'varying vec2 vUv; void main(){ gl_FragColor=vec4(vec3(vUv.x),1.0);}',
          depthTest: false, depthWrite: false });
        const cam = new three.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
        const sc1 = new three.Scene(); sc1.add(new three.Mesh(new three.PlaneGeometry(1,1), gmat));
        const rt = new three.WebGLRenderTarget(8, 8, { depthBuffer: false, type: three.FloatType });
        const smat = new three.ShaderMaterial({
          vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy*2.0,0.0,1.0);}',
          fragmentShader: 'precision highp float; varying vec2 vUv; uniform sampler2D uT;\nvoid main(){ float a=0.0; for(int i=-2;i<=2;i++){ a+=texture2D(uT, vUv+vec2(float(i)*0.125,0.0)).r; } gl_FragColor=vec4(a, texture2D(uT,vUv).r*10.0, -2.0, 1.0);}',
          depthTest: false, depthWrite: false, uniforms: { uT: { value: null } } });
        const sc2 = new three.Scene(); sc2.add(new three.Mesh(new three.PlaneGeometry(1,1), smat));
        const draw = (t: THREE.WebGLRenderTarget, s: THREE.Scene) => {
          const p = e.renderer!.getRenderTarget();
          e.renderer!.setRenderTarget(t);
          e.renderer!.setViewport(0, 0, 8, 8);
          e.renderer!.setScissorTest(false);
          e.renderer!.render(s, cam);
          e.renderer!.setRenderTarget(p);
        };
        draw(src, sc1);
        smat.uniforms.uT!.value = src.texture;
        draw(rt, sc2);
        const buf = new Float32Array(8 * 8 * 4);
        e.renderer.readRenderTargetPixels(rt, 0, 0, 8, 8, buf);
        const mid = (4 * 8 + 4) * 4;
        const out = { center: [buf[mid], buf[mid + 1], buf[mid + 2]] };
        src.dispose(); rt.dispose(); gmat.dispose(); smat.dispose();
        return out;
      },
      /** CE1D dev-only: can we render a CONSTANT into a Float RT and read it? */
      async testFloatRT() {
        const three = await import('three');
        const e = engine as unknown as { renderer: THREE.WebGLRenderer | null };
        if (!e.renderer) return null;
        const rt = new three.WebGLRenderTarget(8, 8, { depthBuffer: false, type: three.FloatType });
        const mat = new three.ShaderMaterial({
          vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy*2.0,0.0,1.0); }',
          fragmentShader: 'void main(){ gl_FragColor = vec4(0.25, -0.5, 3.0, 1.0); }',
          depthTest: false, depthWrite: false,
        });
        const sc = new three.Scene();
        sc.add(new three.Mesh(new three.PlaneGeometry(1, 1), mat));
        const cam = new three.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
        const prev = e.renderer.getRenderTarget();
        e.renderer.setRenderTarget(rt);
        e.renderer.setViewport(0, 0, 8, 8);
        e.renderer.setScissorTest(false);
        e.renderer.render(sc, cam);
        e.renderer.setRenderTarget(prev);
        const buf = new Float32Array(8 * 8 * 4);
        let err = '';
        try { e.renderer.readRenderTargetPixels(rt, 0, 0, 8, 8, buf); } catch (x) { err = String(x); }
        const gl = e.renderer.getContext();
        const glErr = gl.getError();
        rt.dispose(); mat.dispose();
        return { px: [buf[0], buf[1], buf[2], buf[3]], err, glErr };
      },
      /** CE1D dev-only: isolated synthetic flow test (QA). */
      async testFlowSynthetic(dx = 10, dy = 0) {
        const { OpticalFlowField } = await import('./rendering/flow/OpticalFlowField');
        const e = engine as unknown as { renderer: THREE.WebGLRenderer | null };
        if (!e.renderer) return null;
        const three = await import('three');
        const mk = (x: number, y: number) => {
          const cv = document.createElement('canvas');
          cv.width = 320;
          cv.height = 180;
          const g = cv.getContext('2d')!;
          g.fillStyle = '#000';
          g.fillRect(0, 0, 320, 180);
          g.fillStyle = '#fff';
          g.fillRect(x, y, 40, 40);
          const t = new three.CanvasTexture(cv);
          return t;
        };
        const flow = new OpticalFlowField();
        const t1 = mk(100, 70);
        const t2 = mk(100 + dx, 70 + dy);
        flow.update(e.renderer, t1, 320, 180, 'a');
        flow.update(e.renderer, t2, 320, 180, 'b');
        const rt = (flow as unknown as { smoothFlow: THREE.WebGLRenderTarget }).smoothFlow;
        const buf = new Float32Array(320 * 180 * 4);
        e.renderer.readRenderTargetPixels(rt, 0, 0, 320, 180, buf);
        let n = 0, sx = 0, sy = 0, mx = 0;
        for (let i = 0; i < 320 * 180; i++) {
          const x = buf[i * 4]!, y = buf[i * 4 + 1]!;
          const m = Math.hypot(x, y);
          if (m > mx) mx = m;
          if (m > 0.0015) { n++; sx += x; sy += y; }
        }
        // discriminate write-vs-read: the luma target is plain RGBA8.
        const fAny = flow as unknown as {
          lumaA: THREE.WebGLRenderTarget;
          lumaB: THREE.WebGLRenderTarget;
        };
        const readL = (rt: THREE.WebGLRenderTarget) => {
          const b = new Uint8Array(320 * 180 * 4);
          e.renderer!.readRenderTargetPixels(rt, 0, 0, 320, 180, b);
          return b;
        };
        const la = readL(fAny.lumaA);
        const lb = readL(fAny.lumaB);
        let lmax = 0, lsum = 0, dsum = 0;
        for (let i = 0; i < la.length; i += 4) {
          if (la[i]! > lmax) lmax = la[i]!;
          lsum += la[i]!;
          dsum += Math.abs(la[i]! - lb[i]!);
        }
        const lumaDiff = Math.round(dsum / (320 * 180));
        const rawRt = (flow as unknown as { rawFlow: THREE.WebGLRenderTarget }).rawFlow;
        const rbuf = new Float32Array(320 * 180 * 4);
        let rawErr = '';
        try { e.renderer.readRenderTargetPixels(rawRt, 0, 0, 320, 180, rbuf); } catch (err) { rawErr = String(err); }
        let rmax = 0, bmark = 0;
        for (let i = 0; i < rbuf.length; i += 4) {
          const m = Math.hypot(rbuf[i]!, rbuf[i + 1]!);
          if (m > rmax) rmax = m;
          if (rbuf[i + 2]! > bmark) bmark = rbuf[i + 2]!;
        }
        flow.dispose(); t1.dispose(); t2.dispose();
        return { n, meanX: n ? sx / n : 0, meanY: n ? sy / n : 0, maxMag: mx,
          lumaMax: lmax, lumaMean: Math.round(lsum / (320 * 180)), lumaDiff, rawMax: rmax, rawMarkerB: bmark, rawErr };
      },
      /** CE1D dev-only: read the flow texture back for numeric QA goldens.
       * NEVER part of the product path — QA/diagnostics exclusively. */
      readFlowStats() {
        const e = engine as unknown as {
          flow: { texture(): unknown; resolution: { width: number; height: number } } | null;
          renderer: THREE.WebGLRenderer | null;
        };
        if (!e.flow || !e.renderer) return null;
        const { width, height } = e.flow.resolution;
        const rt = (e.flow as unknown as { smoothFlow: THREE.WebGLRenderTarget }).smoothFlow;
        const buf = new Float32Array(width * height * 4);
        e.renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf);
        let sx = 0, sy = 0, sm = 0, n = 0, bgm = 0, bgn = 0;
        for (let i = 0; i < width * height; i++) {
          const x = buf[i * 4]!, y = buf[i * 4 + 1]!;
          const m = Math.hypot(x, y);
          if (m > 0.0015) { sx += x; sy += y; sm += m; n++; }
          else { bgm += m; bgn++; }
        }
        // luma pair delta (valid RGBA8<-Uint8 read): does the analyzed
        // texture actually advance?
        const fAny = e.flow as unknown as {
          lumaA: THREE.WebGLRenderTarget;
          lumaB: THREE.WebGLRenderTarget;
        };
        const readL = (rt: THREE.WebGLRenderTarget) => {
          const b = new Uint8Array(width * height * 4);
          e.renderer!.readRenderTargetPixels(rt, 0, 0, width, height, b);
          return b;
        };
        const la = readL(fAny.lumaA);
        const lb = readL(fAny.lumaB);
        let dsum = 0, rgDelta = 0;
        for (let i = 0; i < la.length; i += 4) {
          dsum += Math.abs(la[i]! - lb[i]!);
          rgDelta += Math.abs(la[i]! - la[i + 1]!); // packed R vs G in A
        }
        return {
          width, height, updates: engine.flowStats?.updates ?? 0,
          movingPx: n, meanX: n ? sx / n : 0, meanY: n ? sy / n : 0,
          meanMag: n ? sm / n : 0, bgMeanMag: bgn ? bgm / bgn : 0,
          lumaABdiff: Math.round(dsum / (width * height) * 10) / 10,
          packedRGdelta: Math.round(rgDelta / (width * height) * 10) / 10,
        };
      },
      /** 18F: realtime temporal diagnostics (mode, atlas, source cadence). */
      liveTemporal() {
        return {
          mode: engine.isLiveTemporalMode ? 'realtime' : 'seekable',
          stats: engine.getTemporalStats(),
        };
      },
      useUiStore,
      openProjectFromPath,
      modulationRuntime,
      modulationActions,
      playback,
      createFrameEvaluator,
      useExportStore,
      presetActions,
      analyzeBuffer,
      detectTempo,
      sampleTrack,
      useAudioStore,
      morphRuntime,
      lookActions,
      performanceActions,
      candidateRuntime,
      useCandidateStore,
      mutation,
      triggerRuntime,
      lookCore,
      interpolate,
      midiEngine,
      useMidiStore,
      FakeMidiTransport,
      WebMidiTransport,
    },
  });
}

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
