/**
 * MidiTransport — the injectable seam between the MIDI engine and the
 * platform (§31). Production uses Web MIDI (Electron grants the 'midi'
 * permission in the main process; sysex is never requested). Tests use
 * FakeMidiTransport.
 */

export interface MidiDeviceInfo {
  id: string;
  name: string;
  manufacturer: string;
}

/** Normalized channel message. Raw system messages never leave the transport. */
export type MidiEvent =
  | { type: 'cc'; deviceId: string; channel: number; control: number; value: number }
  | { type: 'noteOn'; deviceId: string; channel: number; note: number; velocity: number }
  | { type: 'noteOff'; deviceId: string; channel: number; note: number }
  | { type: 'pitchBend'; deviceId: string; channel: number; value: number };

export interface MidiTransport {
  /** Resolves with the initial device list. Rejects when MIDI is unavailable. */
  start(): Promise<MidiDeviceInfo[]>;
  stop(): void;
  onDevicesChanged(cb: (devices: MidiDeviceInfo[]) => void): void;
  onEvent(cb: (event: MidiEvent) => void): void;
}

/**
 * Parse a raw MIDI message into a normalized event, or null for everything
 * ignored by design (§6/§25): clock (0xF8), start/continue/stop (0xFA–0xFC),
 * active sensing (0xFE), aftertouch (0xA0/0xD0), program change (0xC0),
 * sysex (0xF0) and all other system messages.
 */
export function parseMidiMessage(deviceId: string, data: Uint8Array): MidiEvent | null {
  if (data.length === 0) return null;
  const status = data[0] as number;
  if (status >= 0xf0) return null; // system messages, clock, active sensing
  const kind = status & 0xf0;
  const channel = status & 0x0f;
  const d1 = (data[1] ?? 0) & 0x7f;
  const d2 = (data[2] ?? 0) & 0x7f;
  switch (kind) {
    case 0xb0:
      return { type: 'cc', deviceId, channel, control: d1, value: d2 };
    case 0x90:
      // Note On with velocity 0 is Note Off by convention.
      if (d2 === 0) return { type: 'noteOff', deviceId, channel, note: d1 };
      return { type: 'noteOn', deviceId, channel, note: d1, velocity: d2 };
    case 0x80:
      return { type: 'noteOff', deviceId, channel, note: d1 };
    case 0xe0: {
      // 14-bit pitch bend → -1..1 (center 8192 → 0).
      const raw = (d2 << 7) | d1;
      return { type: 'pitchBend', deviceId, channel, value: (raw - 8192) / 8192 };
    }
    default:
      return null; // aftertouch, program change, …
  }
}

export class WebMidiTransport implements MidiTransport {
  private access: MIDIAccess | null = null;
  private devicesCb: ((devices: MidiDeviceInfo[]) => void) | null = null;
  private eventCb: ((event: MidiEvent) => void) | null = null;

  async start(): Promise<MidiDeviceInfo[]> {
    // No sysex — never request it (§25).
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.access.onstatechange = () => {
      this.attachInputs();
      this.devicesCb?.(this.listDevices());
    };
    this.attachInputs();
    return this.listDevices();
  }

  stop(): void {
    if (this.access) {
      this.access.onstatechange = null;
      for (const input of this.access.inputs.values()) input.onmidimessage = null;
    }
    this.access = null;
  }

  onDevicesChanged(cb: (devices: MidiDeviceInfo[]) => void): void {
    this.devicesCb = cb;
  }

  onEvent(cb: (event: MidiEvent) => void): void {
    this.eventCb = cb;
  }

  private listDevices(): MidiDeviceInfo[] {
    if (!this.access) return [];
    return [...this.access.inputs.values()]
      .filter((i) => i.state === 'connected')
      .map((i) => ({ id: i.id, name: i.name ?? '', manufacturer: i.manufacturer ?? '' }));
  }

  private attachInputs(): void {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (msg: MIDIMessageEvent) => {
        if (!msg.data) return;
        const event = parseMidiMessage(input.id, new Uint8Array(msg.data));
        if (event) this.eventCb?.(event);
      };
    }
  }
}

/** Test transport: push devices and events by hand. */
export class FakeMidiTransport implements MidiTransport {
  private devicesCb: ((devices: MidiDeviceInfo[]) => void) | null = null;
  private eventCb: ((event: MidiEvent) => void) | null = null;
  devices: MidiDeviceInfo[] = [];

  start(): Promise<MidiDeviceInfo[]> {
    return Promise.resolve([...this.devices]);
  }
  stop(): void {}
  onDevicesChanged(cb: (devices: MidiDeviceInfo[]) => void): void {
    this.devicesCb = cb;
  }
  onEvent(cb: (event: MidiEvent) => void): void {
    this.eventCb = cb;
  }

  setDevices(devices: MidiDeviceInfo[]): void {
    this.devices = devices;
    this.devicesCb?.([...devices]);
  }
  emit(event: MidiEvent): void {
    this.eventCb?.(event);
  }
  /** Convenience: emit a raw message through the shared parser. */
  emitRaw(deviceId: string, bytes: number[]): void {
    const event = parseMidiMessage(deviceId, new Uint8Array(bytes));
    if (event) this.eventCb?.(event);
  }
}
