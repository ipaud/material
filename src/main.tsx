import React from 'react';
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
      /** CE1D dev-only: the LK shader ALONE over a shader-painted packed
       * texture (R = box at x0, G = box at x0-shift). Isolates math from
       * the class pipeline. */
      async testLKIsolated(shiftTexels = 2) {
        const three = await import('three');
        const { LK_FRAG_EXPORTED } = await import('./rendering/flow/OpticalFlowField');
        const e = engine as unknown as { renderer: import('three').WebGLRenderer | null };
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
        const draw = (t: import('three').WebGLRenderTarget, s: import('three').Scene) => {
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
        const e = engine as unknown as { renderer: import('three').WebGLRenderer | null };
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
        const draw = (t: import('three').WebGLRenderTarget, s: import('three').Scene) => {
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
        const e = engine as unknown as { renderer: import('three').WebGLRenderer | null };
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
        const e = engine as unknown as { renderer: import('three').WebGLRenderer | null };
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
        const rt = (flow as unknown as { smoothFlow: import('three').WebGLRenderTarget }).smoothFlow;
        const buf = new Float32Array(320 * 180 * 4);
        e.renderer.readRenderTargetPixels(rt, 0, 0, 320, 180, buf);
        let n = 0, sx = 0, sy = 0, mx = 0, bg = 0, bgn = 0;
        for (let i = 0; i < 320 * 180; i++) {
          const x = buf[i * 4]!, y = buf[i * 4 + 1]!;
          const m = Math.hypot(x, y);
          if (m > mx) mx = m;
          if (m > 0.0015) { n++; sx += x; sy += y; }
          else { bg += m; bgn++; }
        }
        // discriminate write-vs-read: the luma target is plain RGBA8.
        const fAny = flow as unknown as {
          lumaA: import('three').WebGLRenderTarget;
          lumaB: import('three').WebGLRenderTarget;
        };
        const readL = (rt: import('three').WebGLRenderTarget) => {
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
        const lbuf = la;
        const rawRt = (flow as unknown as { rawFlow: import('three').WebGLRenderTarget }).rawFlow;
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
          renderer: import('three').WebGLRenderer | null;
        };
        if (!e.flow || !e.renderer) return null;
        const { width, height } = e.flow.resolution;
        const rt = (e.flow as unknown as { smoothFlow: import('three').WebGLRenderTarget }).smoothFlow;
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
          lumaA: import('three').WebGLRenderTarget;
          lumaB: import('three').WebGLRenderTarget;
        };
        const readL = (rt: import('three').WebGLRenderTarget) => {
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
