import { create } from 'zustand';
import { useProjectStore } from '@/state/projectStore';
import { useExportStore } from '@/state/exportStore';
import { useUiStore } from '@/state/uiStore';
import { applyCurve, SmoothingState } from '@/modulation/evaluator';
import { getTriggerState, liveScheduler } from '@/signals/triggerRuntime';
import { morphRuntime } from '@/performance/morphRuntime';
import { playback } from '@/playback/PlaybackController';
import { getTechnique } from '@/techniques/registry';
import { allParams, type NumberParamDef } from '@/techniques/types';
import { uid } from '@/utils/id';
import type { MidiMapping, TriggerAction, TriggerMapping } from '@shared/schemas/project';
import type { MidiDeviceInfo, MidiEvent, MidiTransport } from './transport';

/**
 * MIDI engine (Phase 14). Live-class input only — nothing here is part of
 * export. CC mappings are ABSOLUTE: the knob writes the base parameter (one
 * undo entry per gesture via the transient system), guarded by soft-takeover
 * PICKUP so look switches never jump. Note mappings fire trigger actions
 * through the existing TriggerScheduler (fireLive → same quantizer).
 *
 * Hot values (per-CC positions, pickup state) live outside React; the
 * zustand store below carries only low-frequency UI state (device list,
 * learn state, status TRANSITIONS).
 */

const CC_LEARN_MIN_DELTA = 4; // 7-bit steps a control must move to bind (§6)
const PICKUP_EPSILON = 0.015; // |knob − param| below this counts as caught
const TRANSIENT_COMMIT_MS = 600;

export type MappingStatus = 'live' | 'waiting' | 'frozen' | 'morph' | 'offline' | 'idle';

export interface LearnRequest {
  targetType: 'param' | 'triggerAction' | 'macro';
  targetParam?: string;
  action?: TriggerAction;
  lookSlot?: number | null;
  targetMappingId?: string | null;
  quantize?: MidiMapping['quantize'];
}

interface MidiUiState {
  availability: 'idle' | 'starting' | 'ready' | 'unavailable';
  devices: MidiDeviceInfo[];
  /** Mapping id → resolved (bound) device id; absent = offline. */
  bound: Record<string, string>;
  /** Mapping id → status; transitions only, not per-event. */
  status: Record<string, MappingStatus>;
  learn: { label: string } | null;
}

export const useMidiStore = create<MidiUiState>(() => ({
  availability: 'idle',
  devices: [],
  bound: {},
  status: {},
  learn: null,
}));

/** knob crossed (or landed on) the target between two positions. */
export function pickupCrossed(
  prevKnob: number | null,
  knob: number,
  target: number,
): boolean {
  if (Math.abs(knob - target) <= PICKUP_EPSILON) return true;
  if (prevKnob === null) return false;
  return (prevKnob - target) * (knob - target) < 0;
}

/** CC 0–127 → shaped normalized 0..1 (invert → curve → min/max window). */
export function shapeCcValue(mapping: MidiMapping, raw: number): number {
  let v = Math.min(Math.max(raw / 127, 0), 1);
  if (mapping.invert) v = 1 - v;
  v = applyCurve(v, mapping.curve);
  return mapping.min + (mapping.max - mapping.min) * v;
}

/**
 * Resolve which connected device a mapping should bind to (§12):
 * exact id first, then a UNIQUE manufacturer·name label match. Ambiguous
 * label matches stay unbound — the user reassigns explicitly.
 */
export function matchDevice(
  mapping: Pick<MidiMapping, 'deviceId' | 'deviceLabel'>,
  devices: MidiDeviceInfo[],
): MidiDeviceInfo | null {
  const exact = devices.find((d) => d.id === mapping.deviceId);
  if (exact) return exact;
  const byLabel = devices.filter((d) => deviceLabel(d) === mapping.deviceLabel);
  return byLabel.length === 1 ? (byLabel[0] as MidiDeviceInfo) : null;
}

export function deviceLabel(d: MidiDeviceInfo): string {
  return d.manufacturer ? `${d.manufacturer} · ${d.name}` : d.name;
}

export interface MidiDiagnostics {
  eventsPerSec: number;
  lastCc: { deviceId: string; channel: number; control: number; value: number } | null;
  lastNote: { deviceId: string; channel: number; note: number; velocity: number } | null;
  lastPitchBend: number | null;
  learnArmed: boolean;
}

class MidiEngine {
  private transport: MidiTransport | null = null;
  private devices: MidiDeviceInfo[] = [];
  /** mappingId → currently bound platform device id. */
  private bound = new Map<string, string>();
  private pickup = new Map<string, { engaged: boolean; lastKnob: number | null }>();
  private smoothing = new SmoothingState();
  private lastEventAt = new Map<string, number>();
  /** mappingId → last applied shaped value (live activity display). */
  private liveValues = new Map<string, number>();

  private learn: {
    request: LearnRequest;
    firstCc: Map<string, number>;
    resolve: ((mapping: MidiMapping | null) => void) | null;
  } | null = null;

  private transientActive = false;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private selfWrite = false;
  private unsubscribeStore: (() => void) | null = null;

  private eventTimes: number[] = [];
  private diag: Omit<MidiDiagnostics, 'eventsPerSec' | 'learnArmed'> = {
    lastCc: null,
    lastNote: null,
    lastPitchBend: null,
  };

  /** Start only when needed (§25): stored mappings exist, or the user asks. */
  async start(transport: MidiTransport): Promise<boolean> {
    if (this.transport) return true;
    useMidiStore.setState({ availability: 'starting' });
    try {
      transport.onDevicesChanged((devices) => this.handleDevices(devices));
      transport.onEvent((event) => this.handleEvent(event));
      const devices = await transport.start();
      this.transport = transport;
      this.handleDevices(devices);
      useMidiStore.setState({ availability: 'ready' });
      this.watchStore();
      return true;
    } catch {
      useMidiStore.setState({ availability: 'unavailable' });
      return false;
    }
  }

  stop(): void {
    this.transport?.stop();
    this.transport = null;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.cancelLearn();
    useMidiStore.setState({ availability: 'idle', devices: [], bound: {}, status: {} });
  }

  get isRunning(): boolean {
    return this.transport !== null;
  }

  getDiagnostics(): MidiDiagnostics {
    const cutoff = performance.now() - 1000;
    this.eventTimes = this.eventTimes.filter((t) => t >= cutoff);
    return {
      ...this.diag,
      eventsPerSec: this.eventTimes.length,
      learnArmed: this.learn !== null,
    };
  }

  /** Live shaped value of a CC mapping (imperative UI reads). */
  getLiveValue(mappingId: string): number | null {
    return this.liveValues.get(mappingId) ?? null;
  }

  getPickupState(mappingId: string): 'live' | 'waiting' | 'n/a' {
    const s = this.pickup.get(mappingId);
    if (!s) return 'n/a';
    return s.engaged ? 'live' : 'waiting';
  }

  // ---- Learn ----------------------------------------------------------

  /** Arm MIDI Learn. Resolves with the new mapping, or null on cancel. */
  startLearn(request: LearnRequest, label: string): Promise<MidiMapping | null> {
    this.cancelLearn();
    return new Promise((resolve) => {
      this.learn = { request, firstCc: new Map(), resolve };
      useMidiStore.setState({ learn: { label } });
    });
  }

  cancelLearn(): void {
    if (this.learn) {
      this.learn.resolve?.(null);
      this.learn = null;
      useMidiStore.setState({ learn: null });
    }
  }

  // ---- Device handling ------------------------------------------------

  private handleDevices(devices: MidiDeviceInfo[]): void {
    this.devices = devices;
    this.rebindAll();
    useMidiStore.setState({ devices: [...devices] });
  }

  private rebindAll(): void {
    const { project } = useProjectStore.getState();
    this.bound.clear();
    const bound: Record<string, string> = {};
    const status: Record<string, MappingStatus> = {};
    for (const mapping of project.midiMappings) {
      const device = matchDevice(mapping, this.devices);
      if (device) {
        this.bound.set(mapping.id, device.id);
        bound[mapping.id] = device.id;
        status[mapping.id] = this.pickup.get(mapping.id)?.engaged ? 'live' : 'idle';
      } else {
        status[mapping.id] = 'offline';
      }
    }
    useMidiStore.setState({ bound, status });
  }

  /** Public: project changed its mapping list (add/delete/reassign). */
  refreshBindings(): void {
    this.rebindAll();
  }

  // ---- Event handling --------------------------------------------------

  private handleEvent(event: MidiEvent): void {
    // Export renders offline state (§26): live MIDI during an export is
    // ignored entirely — it can neither reach the document nor the GPU.
    if (useExportStore.getState().phase === 'running') return;
    this.eventTimes.push(performance.now());
    if (event.type === 'cc') {
      this.diag.lastCc = {
        deviceId: event.deviceId,
        channel: event.channel,
        control: event.control,
        value: event.value,
      };
      if (this.learn?.request.targetType === 'param' || this.learn?.request.targetType === 'macro') {
        this.tryLearnCc(event);
        return;
      }
      this.handleCc(event);
    } else if (event.type === 'noteOn') {
      this.diag.lastNote = {
        deviceId: event.deviceId,
        channel: event.channel,
        note: event.note,
        velocity: event.velocity,
      };
      if (this.learn?.request.targetType === 'triggerAction') {
        this.finishLearn(event.deviceId, event.channel, 'note', event.note);
        return;
      }
      this.handleNoteOn(event);
    } else if (event.type === 'pitchBend') {
      this.diag.lastPitchBend = event.value;
    }
    // noteOff: consumed by parsing; no mapping semantics in Phase 14.
  }

  private tryLearnCc(event: Extract<MidiEvent, { type: 'cc' }>): void {
    if (!this.learn) return;
    const key = `${event.deviceId}|${event.channel}|${event.control}`;
    const first = this.learn.firstCc.get(key);
    if (first === undefined) {
      // First message from this control: remember, require real movement (§6).
      this.learn.firstCc.set(key, event.value);
      return;
    }
    if (Math.abs(event.value - first) < CC_LEARN_MIN_DELTA) return;
    this.finishLearn(event.deviceId, event.channel, 'cc', event.control);
  }

  private finishLearn(
    deviceId: string,
    channel: number,
    messageType: 'cc' | 'note',
    control: number,
  ): void {
    const learn = this.learn;
    if (!learn) return;
    this.learn = null;
    useMidiStore.setState({ learn: null });

    const device = this.devices.find((d) => d.id === deviceId);
    const request = learn.request;
    const mapping: MidiMapping = {
      id: uid('midi'),
      enabled: true,
      deviceId,
      deviceLabel: device ? deviceLabel(device) : '',
      channel,
      messageType,
      control,
      targetType: request.targetType,
      targetParam: request.targetParam ?? null,
      action: request.action ?? null,
      lookSlot: request.lookSlot ?? null,
      targetMappingId: request.targetMappingId ?? null,
      quantize: request.quantize ?? 'off',
      min: 0,
      max: 1,
      invert: false,
      smoothing: 0,
      curve: 'linear',
      pickupMode: 'pickup',
      mode: 'absolute',
    };
    // One mapping per (target, type): learning replaces an existing binding
    // for the same param / action payload.
    useProjectStore.getState().apply((p) => ({
      ...p,
      midiMappings: [
        ...p.midiMappings.filter(
          (m) =>
            !(
              m.targetType === mapping.targetType &&
              m.targetParam === mapping.targetParam &&
              m.action === mapping.action &&
              m.lookSlot === mapping.lookSlot
            ),
        ),
        mapping,
      ],
    }));
    this.rebindAll();
    const what = messageType === 'cc' ? `CC ${control}` : `NOTE ${control}`;
    useUiStore.getState().pushToast('info', `MIDI bound: ${what} (ch ${channel + 1})`);
    learn.resolve?.(mapping);
  }

  // ---- CC → ABSOLUTE parameter control ---------------------------------

  private matches(mapping: MidiMapping, deviceId: string, channel: number): boolean {
    if (!mapping.enabled) return false;
    if (this.bound.get(mapping.id) !== deviceId) return false;
    return mapping.channel === null || mapping.channel === channel;
  }

  private handleCc(event: Extract<MidiEvent, { type: 'cc' }>): void {
    const { project } = useProjectStore.getState();
    const technique = project.techniques.find((t) => t.enabled);
    if (!technique) return;
    const definition = getTechnique(technique.techniqueId);
    if (!definition) return;
    const params = allParams(definition);

    for (const mapping of project.midiMappings) {
      if (mapping.messageType !== 'cc') continue;
      if (!this.matches(mapping, event.deviceId, event.channel)) continue;
      if (mapping.control !== event.control) continue;
      if (mapping.targetType === 'macro') {
        this.handleMacroCc(mapping, event.value);
        continue;
      }
      if (mapping.targetType !== 'param') continue;
      const def = params.find(
        (p) => p.id === mapping.targetParam && p.type === 'number',
      ) as NumberParamDef | undefined;
      if (!def) continue;

      const shaped = this.shapeWithSmoothing(mapping, event.value);
      this.liveValues.set(mapping.id, shaped);

      // Frozen target: MIDI never unfreezes implicitly (§17).
      const frozen = project.modulations.some(
        (m) => m.enabled && m.target === mapping.targetParam && m.frozenValue !== null,
      );
      if (frozen) {
        this.setStatus(mapping.id, 'frozen');
        this.rememberKnob(mapping.id, shaped);
        continue;
      }
      // Armed morph owns the state; MIDI must not fight the overlay or leak
      // into the commit (§19).
      if (morphRuntime.current !== null) {
        this.setStatus(mapping.id, 'morph');
        this.rememberKnob(mapping.id, shaped);
        continue;
      }

      const current = technique.params[mapping.targetParam ?? ''];
      const currentNorm =
        typeof current === 'number'
          ? (current - def.min) / Math.max(def.max - def.min, 1e-9)
          : 0;

      const state = this.pickup.get(mapping.id) ?? { engaged: false, lastKnob: null };
      if (!state.engaged) {
        if (mapping.pickupMode === 'jump' || pickupCrossed(state.lastKnob, shaped, currentNorm)) {
          state.engaged = true;
        }
      }
      state.lastKnob = shaped;
      this.pickup.set(mapping.id, state);

      if (!state.engaged) {
        this.setStatus(mapping.id, 'waiting');
        continue;
      }
      this.setStatus(mapping.id, 'live');
      this.writeParam(technique.id, mapping.targetParam as string, def, shaped);
    }
  }

  /** CC → macro value, ABSOLUTE with the same pickup discipline (§12). */
  private handleMacroCc(mapping: MidiMapping, raw: number): void {
    const { project } = useProjectStore.getState();
    const macro = project.macros.find((m) => m.id === mapping.targetParam);
    if (!macro) return;
    const shaped = this.shapeWithSmoothing(mapping, raw);
    this.liveValues.set(mapping.id, shaped);
    const state = this.pickup.get(mapping.id) ?? { engaged: false, lastKnob: null };
    if (!state.engaged) {
      if (mapping.pickupMode === 'jump' || pickupCrossed(state.lastKnob, shaped, macro.value)) {
        state.engaged = true;
      }
    }
    state.lastKnob = shaped;
    this.pickup.set(mapping.id, state);
    if (!state.engaged) {
      this.setStatus(mapping.id, 'waiting');
      return;
    }
    this.setStatus(mapping.id, 'live');
    const store = useProjectStore.getState();
    if (!this.transientActive) {
      store.beginTransient();
      this.transientActive = true;
    }
    this.selfWrite = true;
    store.apply((p) => ({
      ...p,
      macros: p.macros.map((m) => (m.id === mapping.targetParam ? { ...m, value: shaped } : m)),
    }));
    this.selfWrite = false;
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      if (this.transientActive) {
        useProjectStore.getState().commitTransient();
        this.transientActive = false;
      }
    }, TRANSIENT_COMMIT_MS);
  }

  private shapeWithSmoothing(mapping: MidiMapping, raw: number): number {
    const target = shapeCcValue(mapping, raw);
    const now = performance.now() / 1000;
    const last = this.lastEventAt.get(mapping.id) ?? now;
    this.lastEventAt.set(mapping.id, now);
    const dt = Math.min(Math.max(now - last, 0.001), 0.1);
    return this.smoothing.step(`midi:${mapping.id}`, target, mapping.smoothing, dt);
  }

  private writeParam(
    techniqueInstanceId: string,
    paramId: string,
    def: NumberParamDef,
    norm: number,
  ): void {
    const value = def.min + Math.min(Math.max(norm, 0), 1) * (def.max - def.min);
    const store = useProjectStore.getState();
    if (!this.transientActive) {
      store.beginTransient();
      this.transientActive = true;
    }
    this.selfWrite = true;
    store.apply((p) => ({
      ...p,
      techniques: p.techniques.map((t) =>
        t.id === techniqueInstanceId ? { ...t, params: { ...t.params, [paramId]: value } } : t,
      ),
    }));
    this.selfWrite = false;
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      if (this.transientActive) {
        useProjectStore.getState().commitTransient();
        this.transientActive = false;
      }
    }, TRANSIENT_COMMIT_MS);
  }

  // ---- Note → trigger action ------------------------------------------

  private handleNoteOn(event: Extract<MidiEvent, { type: 'noteOn' }>): void {
    const { project } = useProjectStore.getState();
    for (const mapping of project.midiMappings) {
      if (mapping.messageType !== 'note' || mapping.targetType !== 'triggerAction') continue;
      if (!this.matches(mapping, event.deviceId, event.channel)) continue;
      if (mapping.control !== event.note || !mapping.action) continue;
      // Synthesized live-class trigger: source 'midi:*' is never
      // deterministic, so export ignores it. Quantization rides the
      // existing scheduler — no second quantizer (§20).
      const synth: TriggerMapping = {
        id: `midi-${mapping.id}`,
        enabled: true,
        source: `midi:${mapping.id}`,
        action: mapping.action,
        targetParam: mapping.targetParam,
        targetMappingId: mapping.targetMappingId,
        lookSlot: mapping.lookSlot,
        quantize: mapping.quantize,
        cooldownSec: 0,
        attackSec: 0.01,
        holdSec: 0,
        decaySec: 0.18,
        amount: event.velocity / 127,
        curve: 'easeOut',
      };
      const { ctx } = getTriggerState();
      liveScheduler.fireLive(synth, playback.getTime(), ctx);
      this.liveValues.set(mapping.id, event.velocity / 127);
    }
  }

  // ---- Pickup reset on external state changes --------------------------

  /**
   * A look apply, morph commit, undo/redo or preset change moves parameters
   * under the physical knobs: engaged PICKUP mappings whose knob no longer
   * matches the software value drop back to WAITING FOR PICKUP (§18).
   */
  private watchStore(): void {
    let lastTechniques = useProjectStore.getState().project.techniques;
    let lastMacros = useProjectStore.getState().project.macros;
    let lastMappings = useProjectStore.getState().project.midiMappings;
    this.unsubscribeStore = useProjectStore.subscribe((state) => {
      if (state.project.midiMappings !== lastMappings) {
        lastMappings = state.project.midiMappings;
        this.rebindAll();
      }
      const techniquesChanged = state.project.techniques !== lastTechniques;
      const macrosChanged = state.project.macros !== lastMacros;
      lastTechniques = state.project.techniques;
      lastMacros = state.project.macros;
      if (this.selfWrite || (!techniquesChanged && !macrosChanged)) return;
      this.reevaluatePickup();
    });
  }

  private reevaluatePickup(): void {
    const { project } = useProjectStore.getState();
    const technique = project.techniques.find((t) => t.enabled);
    if (!technique) return;
    const definition = getTechnique(technique.techniqueId);
    if (!definition) return;
    const params = allParams(definition);
    for (const mapping of project.midiMappings) {
      if (mapping.messageType !== 'cc' || mapping.pickupMode !== 'pickup') continue;
      const state = this.pickup.get(mapping.id);
      if (!state?.engaged || state.lastKnob === null) continue;
      let currentNorm: number | null = null;
      if (mapping.targetType === 'macro') {
        const macro = project.macros.find((m) => m.id === mapping.targetParam);
        if (macro) currentNorm = macro.value;
      } else {
        const def = params.find((p) => p.id === mapping.targetParam && p.type === 'number') as
          | NumberParamDef
          | undefined;
        if (def) {
          const current = technique.params[mapping.targetParam ?? ''];
          currentNorm =
            typeof current === 'number'
              ? (current - def.min) / Math.max(def.max - def.min, 1e-9)
              : 0;
        }
      }
      if (currentNorm !== null && Math.abs(state.lastKnob - currentNorm) > PICKUP_EPSILON) {
        state.engaged = false;
        this.setStatus(mapping.id, 'waiting');
      }
    }
  }

  /** Track knob position while blocked so pickup resumes honestly. */
  private rememberKnob(mappingId: string, shaped: number): void {
    const state = this.pickup.get(mappingId) ?? { engaged: false, lastKnob: null };
    state.lastKnob = shaped;
    this.pickup.set(mappingId, state);
  }

  private setStatus(mappingId: string, status: MappingStatus): void {
    const prev = useMidiStore.getState().status[mappingId];
    if (prev === status) return;
    useMidiStore.setState((s) => ({ status: { ...s.status, [mappingId]: status } }));
  }
}

export const midiEngine = new MidiEngine();
