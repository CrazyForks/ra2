/**
 * 音频 smoke 迁移：WAVEFORMATEX 解析、DirectSound 音量/声像换算，
 * 以及 DirectSound COM 桥（CreateSoundBuffer/Lock/Unlock/Play）到
 * Win32AudioSink 的事件序列。
 */
import { describe, expect, it } from 'vitest';
import {
  directSoundPanToStereo,
  directSoundVolumeToGain,
  parsePcmWaveFormatEx,
  WebAudioPcmSink,
  type PcmWaveFormat,
} from '../../src/adapter/audio';
import type { Win32AudioSink } from '../../src/vm86/win32';
import { callShim, createGuestMemory, createTestShim, readU32, writeU32 } from '../helpers/guestMemory';

const waveFormat = Uint8Array.from([
  0xff,
  0xff, // 前置填充，验证 offset
  0x01,
  0x00, // WAVE_FORMAT_PCM
  0x02,
  0x00, // stereo
  0x22,
  0x56,
  0x00,
  0x00, // 22050 Hz
  0x88,
  0x58,
  0x01,
  0x00, // 88200 bytes/s
  0x04,
  0x00, // block align
  0x10,
  0x00, // 16 bit
  0x00,
  0x00, // cbSize
]);

describe('WAVEFORMATEX 与音量/声像换算（原 audioSmoke）', () => {
  it('parsePcmWaveFormatEx 按 offset 解析 PCM 格式头', () => {
    expect(parsePcmWaveFormatEx(waveFormat, 2)).toEqual({
      wFormatTag: 1,
      nChannels: 2,
      nSamplesPerSec: 22_050,
      nAvgBytesPerSec: 88_200,
      nBlockAlign: 4,
      wBitsPerSample: 16,
      cbSize: 0,
    });
  });

  it('DirectSound 音量（百分之一 dB）转线性 gain', () => {
    expect(directSoundVolumeToGain(0)).toBe(1);
    expect(directSoundVolumeToGain(-10_000)).toBe(0);
    expect(Math.abs(directSoundVolumeToGain(-600) - 0.501187) < 0.000001).toBeTruthy();
  });

  it('DirectSound 声像转 -1..1', () => {
    expect(directSoundPanToStereo(-10_000)).toBe(-1);
    expect(directSoundPanToStereo(2_500)).toBe(0.25);
    expect(directSoundPanToStereo(10_000)).toBe(1);
  });
});

describe('DirectSound COM 桥（原 audioSmoke）', () => {
  it('CreateSoundBuffer/Lock/Unlock/Play 全流程驱动 Win32AudioSink', () => {
    const memory = createGuestMemory(12 * 1024 * 1024);
    const audioEvents: string[] = [];
    let createdFormat: PcmWaveFormat | null = null;
    let writtenPcm = new Uint8Array();
    const audio: Win32AudioSink = {
      createBuffer(_id, size, format) {
        audioEvents.push(`create:${size}`);
        createdFormat = { ...format };
      },
      duplicateBuffer() {
        return true;
      },
      setFormat() {
        return true;
      },
      writeBuffer(_id, offset, bytes) {
        audioEvents.push(`write:${offset}:${bytes.length}`);
        writtenPcm = bytes.slice();
        return bytes.length;
      },
      play(_id, options) {
        audioEvents.push(`play:${options?.loop ? 1 : 0}`);
        return true;
      },
      stop() {
        return true;
      },
      setCurrentPosition() {
        return true;
      },
      setVolume() {
        return true;
      },
      setPan() {
        return true;
      },
      setFrequency() {
        return true;
      },
      getState() {
        return { positionBytes: 0, playing: true };
      },
      releaseBuffer() {
        return true;
      },
    };
    const shim = createTestShim(memory, { firstDynamicId: 1, audio });
    const dispatchSound = (key: string, args: number[]) => callShim(shim, key, args, 0x2000);

    const desc = 0x1000;
    const formatPtr = 0x1100;
    const objectOut = 0x1200;
    memory.write_memory(waveFormat.subarray(2), formatPtr);
    writeU32(memory, desc, 20);
    writeU32(memory, desc + 8, 6);
    writeU32(memory, desc + 16, formatPtr);
    expect(dispatchSound('DSOUND.COM!IDirectSound.CreateSoundBuffer', [0xdead, desc, objectOut, 0]).eax).toBe(0);
    const object = readU32(memory, objectOut);
    expect(object).toBeTruthy();
    // createdFormat 在 sink 闭包内赋值，TS 控制流仍按初始 null 窄化，这里显式还原声明类型。
    expect((createdFormat as PcmWaveFormat | null)?.nSamplesPerSec).toBe(22_050);

    const pointerOut = 0x1210;
    const bytesOut = 0x1214;
    expect(dispatchSound('DSOUND.COM!IDirectSoundBuffer.Lock', [object, 0, 6, pointerOut, bytesOut, 0, 0, 0]).eax).toBe(
      0,
    );
    const pcm = Uint8Array.from([0, 1, 2, 3, 4, 5]);
    memory.write_memory(pcm, readU32(memory, pointerOut));
    expect(
      dispatchSound('DSOUND.COM!IDirectSoundBuffer.Unlock', [
        object,
        readU32(memory, pointerOut),
        readU32(memory, bytesOut),
        0,
        0,
      ]).eax,
    ).toBe(0);
    expect(writtenPcm).toEqual(pcm);
    expect(dispatchSound('DSOUND.COM!IDirectSoundBuffer.Play', [object, 0, 0, 1]).eax).toBe(0);
    expect(readU32(memory, object + 12)).toBe(0); // 状态变化后强制首轮游标查询回 host
    const cursorOut = 0x1220;
    expect(dispatchSound('DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition', [object, cursorOut, 0]).eax).toBe(0);
    expect(readU32(memory, object + 8)).toBe(readU32(memory, cursorOut));
    expect(readU32(memory, object + 12)).toBe(1023);
    const vtable = readU32(memory, object);
    const getCurrentPositionStub = readU32(memory, vtable + 4 * 4);
    expect(memory.read_memory(getCurrentPositionStub, 4)).toEqual(new Uint8Array([0x8b, 0x4c, 0x24, 0x04]));
    expect(audioEvents).toEqual(['create:6', 'write:0:6', 'play:1']);
  });
});

/** getState 恒返回 null 的 sink：模拟 Worker 音频代理无法同步回读 WebAudio 的场景。 */
const createWorkerLikeAudio = (): Win32AudioSink => ({
  createBuffer() {},
  duplicateBuffer() {
    return true;
  },
  setFormat() {
    return true;
  },
  writeBuffer(_id, _offset, bytes) {
    return bytes.length;
  },
  play() {
    return true;
  },
  stop() {
    return true;
  },
  setCurrentPosition() {
    return true;
  },
  setVolume() {
    return true;
  },
  setPan() {
    return true;
  },
  setFrequency() {
    return true;
  },
  getState() {
    return null;
  },
  releaseBuffer() {
    return true;
  },
});

describe('DirectSound 流式音乐（RA2 增补，原 audioSmoke）', () => {
  // 流式音乐回归：播放中的 DirectSound 环形 buffer 被 Unlock 覆写后，必须
  // 切到单一实时读取器，不能继续循环首次快照或为每次写入重建 source。
  it('环形 buffer 首次动态覆写后切到实时 PCM 流且保持连续游标', () => {
    class FakeAudioBuffer {
      readonly duration: number;
      private readonly channels: Float32Array[];
      readonly numberOfChannels: number;
      readonly length: number;
      constructor(
        channelCount: number,
        frameCount: number,
        readonly sampleRate: number,
      ) {
        this.numberOfChannels = channelCount;
        this.length = frameCount;
        this.duration = frameCount / sampleRate;
        this.channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
      }
      getChannelData(channel: number): Float32Array {
        return this.channels[channel]!;
      }
    }
    class FakeAudioParam {
      value = 0;
      setValueAtTime(value: number): void {
        this.value = value;
      }
      linearRampToValueAtTime(value: number): void {
        this.value = value;
      }
    }
    class FakeNode {
      connect(): this {
        return this;
      }
      disconnect(): void {}
    }
    class FakeSource extends FakeNode {
      buffer: FakeAudioBuffer | null = null;
      loop = false;
      playbackRate = new FakeAudioParam();
      onended: (() => void) | null = null;
      startedWhen = -1;
      startedOffset = -1;
      stopped = false;
      stoppedWhen = -1;
      start(when: number, offset: number): void {
        this.startedWhen = when;
        this.startedOffset = offset;
      }
      stop(when = 0): void {
        this.stopped = true;
        this.stoppedWhen = when;
      }
    }
    class FakeProcessor extends FakeNode {
      onaudioprocess: ((event: { outputBuffer: FakeAudioBuffer }) => void) | null = null;
      constructor(
        private readonly frames: number,
        private readonly channels: number,
      ) {
        super();
      }
      process(): FakeAudioBuffer {
        const output = new FakeAudioBuffer(this.channels, this.frames, 22_050);
        this.onaudioprocess?.({ outputBuffer: output });
        return output;
      }
    }
    class FakeAudioContext {
      currentTime = 0;
      sampleRate = 22_050;
      state = 'running';
      destination = new FakeNode();
      readonly sources: FakeSource[] = [];
      readonly processors: FakeProcessor[] = [];
      createBuffer(channels: number, frames: number, rate: number): FakeAudioBuffer {
        return new FakeAudioBuffer(channels, frames, rate);
      }
      createBufferSource(): FakeSource {
        const source = new FakeSource();
        this.sources.push(source);
        return source;
      }
      createScriptProcessor(frames: number, _inputs: number, channels: number): FakeProcessor {
        const processor = new FakeProcessor(frames, channels);
        this.processors.push(processor);
        return processor;
      }
      createGain(): FakeNode & { gain: FakeAudioParam } {
        return Object.assign(new FakeNode(), { gain: new FakeAudioParam() });
      }
      createStereoPanner(): FakeNode & { pan: FakeAudioParam } {
        return Object.assign(new FakeNode(), { pan: new FakeAudioParam() });
      }
    }
    const fakeContext = new FakeAudioContext();
    const streamingSink = new WebAudioPcmSink({
      contextFactory: () => fakeContext as unknown as AudioContext,
    });
    streamingSink.createBuffer('music', 88_200, {
      wFormatTag: 1,
      nChannels: 2,
      nSamplesPerSec: 22_050,
      nAvgBytesPerSec: 88_200,
      nBlockAlign: 4,
      wBitsPerSample: 16,
      cbSize: 0,
    });
    streamingSink.writeBuffer('music', 0, new Uint8Array(88_200));
    expect(streamingSink.play('music', { loop: true })).toBe(true);
    expect(fakeContext.sources.length).toBe(1);
    fakeContext.currentTime = 0.25;
    const firstSource = fakeContext.sources[0]!;
    // 0.25 秒处是第 5512 帧附近；写入满幅左声道，实时回调第一帧应立即读到。
    streamingSink.writeBuffer('music', 5_512 * 4, Uint8Array.from([0xff, 0x7f, 0, 0]));
    expect(firstSource.stopped).toBe(true);
    expect(fakeContext.sources.length).toBe(1);
    expect(fakeContext.processors.length).toBe(1);
    const output = fakeContext.processors[0]!.process();
    expect(output.getChannelData(0)[0]).toBeGreaterThan(0.99);
    expect(output.getChannelData(1)[0]).toBe(0);
    // 后续 Unlock 只更新 PCM，不创建新的 source/processor。
    streamingSink.writeBuffer('music', 30_000, Uint8Array.from([1, 2, 3, 4]));
    expect(fakeContext.sources.length).toBe(1);
    expect(fakeContext.processors.length).toBe(1);
    expect(streamingSink.getState('music')!.positionBytes).toBeGreaterThan(5_512 * 4);
    expect(streamingSink.getState('music')?.playing).toBe(true);
  });

  // DSBLOCK_ENTIREBUFFER 的 dwBytes=0 仍必须返回完整缓冲区。
  it('Lock 带 DSBLOCK_ENTIREBUFFER 且 dwBytes=0 时返回完整缓冲区', () => {
    const memory = createGuestMemory(12 * 1024 * 1024);
    const shim = createTestShim(memory, { firstDynamicId: 1, audio: createWorkerLikeAudio() });
    const dispatchSound = (key: string, args: number[]) => callShim(shim, key, args, 0x2000);

    const desc = 0x1000;
    const formatPtr = 0x1100;
    const objectOut = 0x1200;
    memory.write_memory(waveFormat.subarray(2), formatPtr);
    writeU32(memory, desc, 20);
    writeU32(memory, desc + 8, 6);
    writeU32(memory, desc + 16, formatPtr);
    expect(dispatchSound('DSOUND.COM!IDirectSound.CreateSoundBuffer', [0xdead, desc, objectOut, 0]).eax).toBe(0);
    const object = readU32(memory, objectOut);
    expect(object).toBeTruthy();

    const entirePointerOut = 0x1220;
    const entireBytesOut = 0x1224;
    expect(
      dispatchSound('DSOUND.COM!IDirectSoundBuffer.Lock', [object, 0, 0, entirePointerOut, entireBytesOut, 0, 0, 2])
        .eax,
    ).toBe(0);
    expect(readU32(memory, entirePointerOut) !== 0).toBe(true);
    expect(readU32(memory, entireBytesOut)).toBe(6);
  });

  // Worker 音频代理不能同步回读 WebAudio；shim 的本地播放游标必须仍会前进，
  // 否则游戏永远不会为环形音乐缓冲解码下一段。
  it('getState 不可用（Worker 代理）时 shim 本地播放游标仍会前进', async () => {
    const memory = createGuestMemory(12 * 1024 * 1024);
    const shim = createTestShim(memory, { firstDynamicId: 1, audio: createWorkerLikeAudio() });
    const dispatchSound = (key: string, args: number[]) => callShim(shim, key, args, 0x2000);

    const formatPtr = 0x1100;
    memory.write_memory(waveFormat.subarray(2), formatPtr);
    const streamDesc = 0x1240;
    const streamOut = 0x1260;
    writeU32(memory, streamDesc, 20);
    writeU32(memory, streamDesc + 8, 88_200);
    writeU32(memory, streamDesc + 16, formatPtr);
    expect(dispatchSound('DSOUND.COM!IDirectSound.CreateSoundBuffer', [0xdead, streamDesc, streamOut, 0]).eax).toBe(0);
    const streamObject = readU32(memory, streamOut);
    expect(dispatchSound('DSOUND.COM!IDirectSoundBuffer.Play', [streamObject, 0, 0, 1]).eax).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cursorOut = 0x1270;
    expect(dispatchSound('DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition', [streamObject, cursorOut, 0]).eax).toBe(0);
    expect(readU32(memory, cursorOut), 'Worker 侧估算的 DirectSound 播放游标没有前进').toBeGreaterThan(0);
  });

  // AudioWorklet 首选路径：实时流渲染移出主线程，写入区间经 port 同步。
  it('支持 AudioWorklet 时实时流走 worklet 节点并同步写入区间', async () => {
    class FakeAudioParam {
      value = 0;
      setValueAtTime(value: number): void {
        this.value = value;
      }
    }
    class FakeNode {
      connect(): this {
        return this;
      }
      disconnect(): void {}
    }
    class FakeSource extends FakeNode {
      buffer: unknown = null;
      loop = false;
      playbackRate = new FakeAudioParam();
      onended: (() => void) | null = null;
      stopped = false;
      start(): void {}
      stop(): void {
        this.stopped = true;
      }
    }
    const posted: Array<Record<string, unknown>> = [];
    const workletNodes: FakeWorkletNode[] = [];
    class FakeWorkletNode extends FakeNode {
      readonly port: {
        onmessage: ((event: MessageEvent) => void) | null;
        postMessage: (message: Record<string, unknown>) => void;
      } = {
        onmessage: null,
        postMessage: (message) => {
          posted.push(message);
        },
      };
      constructor() {
        super();
        workletNodes.push(this);
      }
    }
    class FakeWorkletContext extends FakeNode {
      currentTime = 0;
      sampleRate = 22_050;
      state = 'running';
      destination = new FakeNode();
      readonly audioWorklet = { addModule: () => Promise.resolve() };
      readonly sources: FakeSource[] = [];
      createBuffer(_channels: number, frames: number): { duration: number; getChannelData: () => Float32Array } {
        return { duration: frames / this.sampleRate, getChannelData: () => new Float32Array(frames) };
      }
      createBufferSource(): FakeSource {
        const source = new FakeSource();
        this.sources.push(source);
        return source;
      }
      createGain(): FakeNode & { gain: FakeAudioParam } {
        return Object.assign(new FakeNode(), { gain: new FakeAudioParam() });
      }
      createStereoPanner(): FakeNode & { pan: FakeAudioParam } {
        return Object.assign(new FakeNode(), { pan: new FakeAudioParam() });
      }
    }
    const fakeContext = new FakeWorkletContext();
    (globalThis as Record<string, unknown>).AudioWorkletNode = FakeWorkletNode;
    try {
      const sink = new WebAudioPcmSink({
        contextFactory: () => fakeContext as unknown as AudioContext,
      });
      sink.createBuffer('music', 88_200, {
        wFormatTag: 1,
        nChannels: 2,
        nSamplesPerSec: 22_050,
        nAvgBytesPerSec: 88_200,
        nBlockAlign: 4,
        wBitsPerSample: 16,
        cbSize: 0,
      });
      sink.writeBuffer('music', 0, new Uint8Array(88_200));
      expect(sink.play('music', { loop: true })).toBe(true);
      // 播放中的第二次写入触发实时流切换（旧 source 停掉，worklet 接管）。
      sink.writeBuffer('music', 5_512 * 4, Uint8Array.from([0xff, 0x7f, 0, 0]));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(workletNodes.length).toBe(1);
      const create = posted.find((message) => message.kind === 'create')!;
      expect(create).toBeTruthy();
      expect(create.frames).toBe(88_200 / 4);
      expect(create.frequency).toBe(22_050);
      expect(create.loop).toBe(true);
      // 初始全量镜像同步：88_200 字节 = 22_050 帧 × 2 声道。
      const initialUpdate = posted.find((message) => message.kind === 'update')!;
      expect((initialUpdate.data as Float32Array).length).toBe(44_100);
      expect(initialUpdate.offsetFrames).toBe(0);
      // 后续写入走增量 update。
      posted.length = 0;
      sink.writeBuffer('music', 30_000, Uint8Array.from([1, 2, 3, 4]));
      const update = posted.find((message) => message.kind === 'update')!;
      expect(update.offsetFrames).toBe(7_500);
      expect((update.data as Float32Array).length).toBe(2);
      // 游标回发：worklet 报 frame 后主线程按 currentTime 外推。
      const worklet = workletNodes[0]!;
      const frameMessage = { kind: 'position', frame: 10_000 };
      fakeContext.currentTime = 1;
      worklet.port.onmessage?.({ data: frameMessage } as unknown as MessageEvent);
      fakeContext.currentTime = 1.5;
      // 10_000 + 0.5s × 22050 = 21_025 帧 → × 4 字节。
      expect(sink.getState('music')!.positionBytes).toBe(21_025 * 4);
      // stop 拆掉 worklet 并回发 destroy。
      sink.stop('music');
      expect(posted.some((message) => message.kind === 'destroy')).toBe(true);
      expect(workletNodes[0]!.port.onmessage).toBeNull();
    } finally {
      delete (globalThis as Record<string, unknown>).AudioWorkletNode;
    }
  });
});
