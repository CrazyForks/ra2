/**
 * DirectSound 客体 PCM buffer 的 WebAudio 输出层。
 *
 * 这个模块不依赖 Win32 shim：shim 只需把 CreateSoundBuffer/Lock/Unlock/Play
 * 等调用转换成同名操作，客体内存仍由 shim 自己管理。
 */
import { DEFAULT_PCM_FORMAT, normalizePcmWaveFormat, type PcmPlayOptions, type PcmWaveFormat } from '../vm86/audio';
export { DEFAULT_PCM_FORMAT, normalizePcmWaveFormat, parsePcmWaveFormatEx } from '../vm86/audio';
export type { PcmPlayOptions, PcmWaveFormat } from '../vm86/audio';

export type PcmBufferId = number | string;

/** 实时环形流（ScriptProcessor 回退路径）每个输出量子的帧数：4096 ≈ 85-93ms 缓冲。
 *  该回调跑在主线程；正常路径走 AudioWorklet（音频线程渲染，见 pcmStreamWorklet.js），
 *  只有不支持 AudioWorklet 的浏览器才落到这条回退路径。 */
const STREAM_PROCESSOR_FRAMES = 4_096;

/** pcmStreamWorklet.js 的注册名。 */
const PCM_STREAM_WORKLET_NAME = 'ra2-pcm-stream';

/** AudioWorklet 模块加载缓存：一次 addModule 全 context 复用；失败后允许重试。 */
let workletModulePromise: Promise<void> | null = null;
function loadPcmStreamWorklet(context: AudioContext): Promise<void> {
  workletModulePromise ??= context.audioWorklet
    .addModule(new URL('./pcmStreamWorklet.js', import.meta.url))
    .catch((error) => {
      workletModulePromise = null;
      throw error;
    });
  return workletModulePromise;
}

export interface PcmBufferSnapshot {
  byteLength: number;
  positionBytes: number;
  playing: boolean;
  loop: boolean;
  /** DirectSound 百分之一 dB，-10000..0。 */
  volume: number;
  /** DirectSound 声像，-10000..10000。 */
  pan: number;
  /** 实际请求的播放频率，Hz。 */
  frequency: number;
  format: PcmWaveFormat;
}

export interface WebAudioPcmSinkOptions {
  /** 便于测试或把输出接入已有 AudioContext。 */
  contextFactory?: () => AudioContext;
  /** 默认连到 context.destination。 */
  destination?: (context: AudioContext) => AudioNode;
  onError?: (error: unknown) => void;
}

interface PcmBufferState {
  format: PcmWaveFormat;
  pcm: Uint8Array;
  decoded: AudioBuffer | null;
  source: AudioBufferSourceNode | null;
  /** 播放中仍会被 Lock/Unlock 覆写的 DirectSound 环形流（回退路径）。 */
  stream: ScriptProcessorNode | null;
  /** 实时流首选路径：音频线程渲染的 AudioWorklet。 */
  worklet: AudioWorkletNode | null;
  streamFrame: number;
  /** 最近一次 worklet position 回发的 context 时刻（游标外推基准）。 */
  workletPositionAt: number;
  gain: GainNode | null;
  panner: StereoPannerNode | null;
  positionBytes: number;
  startedAt: number;
  startedFrame: number;
  playing: boolean;
  loop: boolean;
  volume: number;
  pan: number;
  frequency: number;
}

/** DirectSound 音量（百分之一 dB）转 WebAudio 线性 gain。 */
export function directSoundVolumeToGain(volume: number): number {
  const clamped = clamp(Math.trunc(volume), -10_000, 0);
  return clamped === -10_000 ? 0 : 10 ** (clamped / 2_000);
}

/** DirectSound 声像转 StereoPannerNode 的 -1..1。 */
export function directSoundPanToStereo(pan: number): number {
  return clamp(Math.trunc(pan), -10_000, 10_000) / 10_000;
}

/**
 * 将 DirectSound 静态 buffer 播放到 WebAudio。
 *
 * AudioContext 延迟创建。可在页面启动时调用 installUserGestureUnlock，
 * 先于用户手势到达的 Play 会保留 playing 状态，解锁后自动出声。
 */
/** 主音量初始线性增益：50% 滑杆 → (0.5)^2 平方增益。滑杆百分比与线性增益由这两个
 *  常量互相推导；页面层、工具栏与 worker 配置不再各写一份字面量。 */
export const DEFAULT_MASTER_VOLUME = 0.25;
/** 与 DEFAULT_MASTER_VOLUME 等价的滑杆百分比（0..100）。 */
export const DEFAULT_VOLUME_PERCENT = Math.round(Math.sqrt(DEFAULT_MASTER_VOLUME) * 100);

export class WebAudioPcmSink {
  private readonly buffers = new Map<PcmBufferId, PcmBufferState>();
  private context: AudioContext | null = null;
  private destroyed = false;
  private masterGain: GainNode | null = null;
  /** 主音量线性增益 0..1，作用于所有 buffer 之后、destination 之前。 */
  private masterVolume = DEFAULT_MASTER_VOLUME;

  constructor(private readonly options: WebAudioPcmSinkOptions = {}) {}

  createBuffer(id: PcmBufferId, byteLength: number, format: PcmWaveFormat = DEFAULT_PCM_FORMAT as PcmWaveFormat): void {
    this.assertAlive();
    this.releaseBuffer(id);
    const normalized = normalizePcmWaveFormat(format);
    const size = clamp(Math.trunc(byteLength), 0, 64 * 1024 * 1024);
    this.buffers.set(id, {
      format: normalized,
      pcm: new Uint8Array(size),
      decoded: null,
      source: null,
      stream: null,
      worklet: null,
      streamFrame: 0,
      workletPositionAt: 0,
      gain: null,
      panner: null,
      positionBytes: 0,
      startedAt: 0,
      startedFrame: 0,
      playing: false,
      loop: false,
      volume: 0,
      pan: 0,
      frequency: normalized.nSamplesPerSec,
    });
  }

  duplicateBuffer(sourceId: PcmBufferId, destinationId: PcmBufferId): boolean {
    const source = this.buffers.get(sourceId);
    if (!source) return false;
    this.createBuffer(destinationId, source.pcm.byteLength, source.format);
    const destination = this.buffers.get(destinationId)!;
    destination.pcm.set(source.pcm);
    destination.volume = source.volume;
    destination.pan = source.pan;
    destination.frequency = source.frequency;
    return true;
  }

  setFormat(id: PcmBufferId, format: PcmWaveFormat): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    const wasPlaying = state.playing;
    const position = this.currentPosition(state);
    this.detachPlayback(state);
    state.format = normalizePcmWaveFormat(format);
    state.frequency = state.format.nSamplesPerSec;
    state.positionBytes = alignPosition(position, state);
    state.decoded = null;
    if (wasPlaying) this.start(state);
    return true;
  }

  /** 把 Unlock 取得的客体 PCM 快照写回镜像 buffer。 */
  writeBuffer(id: PcmBufferId, offset: number, bytes: Uint8Array): number {
    const state = this.buffers.get(id);
    if (!state || bytes.byteLength === 0) return 0;
    const start = clamp(Math.trunc(offset), 0, state.pcm.byteLength);
    const length = Math.min(bytes.byteLength, state.pcm.byteLength - start);
    if (length <= 0) return 0;

    // RA2/Bink 会在 DSBPLAY_LOOPING 播放期间持续覆写 DirectSound 环形缓冲。
    // AudioBufferSourceNode 只能播放创建时的快照；过去每次 Unlock 都重建 source，
    // 会反复回卷、堆积 WebAudio 节点，最终还可能拖垮 renderer。首次动态覆写时
    // 切到单一实时环形播放器，之后只更新 PCM 镜像，播放游标不再重置。
    const switchToLiveStream = state.playing && state.loop && state.source !== null;
    state.pcm.set(bytes.subarray(0, length), start);
    state.decoded = null;
    if (switchToLiveStream) this.startLiveStream(state);
    // worklet 路径：把写入区间实时同步给音频线程的渲染器。
    if (state.worklet && state.playing) {
      this.postWorkletUpdate(state, state.worklet, start, bytes.subarray(0, length));
    }
    return length;
  }

  play(id: PcmBufferId, options: PcmPlayOptions = {}): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    state.loop = options.loop ?? false;
    if ((state.source || state.stream || state.worklet) && options.fromByte === undefined) {
      // IDirectSoundBuffer::Play 对已在播放的 buffer 不会从头触发一遍。
      if (state.source) state.source.loop = state.loop;
      if (state.worklet) {
        // 非循环流播到末尾会停在 worklet 内部；再次 Play 应恢复出声。
        this.postWorkletMessage(state, { kind: 'play' });
        this.postWorkletMessage(state, { kind: 'set-loop', loop: state.loop });
      }
      return true;
    }
    if (options.fromByte !== undefined) state.positionBytes = alignPosition(options.fromByte, state);
    if (state.positionBytes >= state.pcm.byteLength) state.positionBytes = 0;
    state.playing = true;
    this.detachPlayback(state, false);
    this.start(state);
    return true;
  }

  stop(id: PcmBufferId): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    state.positionBytes = this.currentPosition(state);
    state.playing = false;
    this.detachPlayback(state, false);
    return true;
  }

  setCurrentPosition(id: PcmBufferId, byteOffset: number): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    const wasPlaying = state.playing;
    state.positionBytes = alignPosition(byteOffset, state);
    state.streamFrame = bytePositionToFrame(state.positionBytes, state);
    if (state.worklet) {
      this.postWorkletMessage(state, { kind: 'set-position', frame: state.streamFrame });
      if (this.context) state.workletPositionAt = this.context.currentTime;
    } else if (wasPlaying && !state.stream) {
      this.detachPlayback(state, false);
      this.start(state);
    }
    return true;
  }

  setVolume(id: PcmBufferId, volume: number): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    state.volume = clamp(Math.trunc(volume), -10_000, 0);
    if (state.gain && this.context) {
      state.gain.gain.setValueAtTime(directSoundVolumeToGain(state.volume), this.context.currentTime);
    }
    return true;
  }

  setPan(id: PcmBufferId, pan: number): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    state.pan = clamp(Math.trunc(pan), -10_000, 10_000);
    if (state.panner && this.context) {
      state.panner.pan.setValueAtTime(directSoundPanToStereo(state.pan), this.context.currentTime);
    }
    return true;
  }

  /** 主音量：整个 sink 输出的线性增益（0=静音，1=满）。先于用户手势时也可调用，节点惰性创建后生效。 */
  setMasterVolume(linear: number): void {
    this.masterVolume = clamp(linear, 0, 1);
    if (this.masterGain && this.context) {
      this.masterGain.gain.setValueAtTime(this.masterVolume, this.context.currentTime);
    }
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  setFrequency(id: PcmBufferId, frequency: number): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    const wasPlaying = state.playing;
    const position = this.currentPosition(state);
    const liveStream = state.stream !== null || state.worklet !== null;
    if (!liveStream) this.detachPlayback(state, false);
    // DSBFREQUENCY_ORIGINAL = 0。
    state.frequency = frequency === 0 ? state.format.nSamplesPerSec : clamp(Math.trunc(frequency), 100, 200_000);
    state.positionBytes = position;
    if (wasPlaying && !liveStream) this.start(state);
    if (state.worklet) {
      this.postWorkletMessage(state, { kind: 'set-frequency', frequency: state.frequency });
    }
    return true;
  }

  getState(id: PcmBufferId): PcmBufferSnapshot | null {
    const state = this.buffers.get(id);
    if (!state) return null;
    return {
      byteLength: state.pcm.byteLength,
      positionBytes: this.currentPosition(state),
      playing: state.playing,
      loop: state.loop,
      volume: state.volume,
      pan: state.pan,
      frequency: state.frequency,
      format: { ...state.format },
    };
  }

  releaseBuffer(id: PcmBufferId): boolean {
    const state = this.buffers.get(id);
    if (!state) return false;
    state.playing = false;
    this.detachPlayback(state, false);
    return this.buffers.delete(id);
  }

  stopAll(): void {
    for (const state of this.buffers.values()) {
      state.positionBytes = this.currentPosition(state);
      state.playing = false;
      this.detachPlayback(state, false);
    }
  }

  /** 必须从 pointerdown/keydown 等用户手势调用。 */
  async unlock(): Promise<boolean> {
    if (this.destroyed) return false;
    const context = this.ensureContext();
    if (!context) return false;
    try {
      if (context.state === 'suspended') await context.resume();
      if (context.state !== 'running') return false;
      for (const state of this.buffers.values()) {
        if (state.playing && !state.source && !state.stream && !state.worklet) this.start(state);
      }
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  /**
   * 安装常驻的浏览器自动播放解锁钩子，返回手动解绑函数。
   * 首次成功之后不再自卸载：iOS/Android 把标签页切后台会挂起 AudioContext，
   * 恢复前台时 visibilitychange 里的 resume 可能因无用户手势被拒——常驻手势监听
   * 在用户下一次点击（也是游戏内第一次点击）时兜底恢复。running 状态下 unlock()
   * 是廉价 no-op（缓存 context + 一次 state 判断），常驻无实际开销。
   */
  installUserGestureUnlock(target?: EventTarget): () => void {
    const eventTarget = target ?? (typeof document === 'undefined' ? null : document);
    if (!eventTarget) return () => undefined;
    let active = true;
    const events = ['pointerdown', 'touchstart', 'keydown'] as const;
    const remove = (): void => {
      if (!active) return;
      active = false;
      for (const event of events) eventTarget.removeEventListener(event, listener, true);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
    const listener = (): void => {
      void this.unlock();
    };
    const onVisible = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void this.unlock();
    };
    for (const event of events) eventTarget.addEventListener(event, listener, { capture: true, passive: true });
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return remove;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.stopAll();
    this.buffers.clear();
    this.destroyed = true;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') {
      try {
        await context.close();
      } catch (error) {
        this.report(error);
      }
    }
  }

  private start(state: PcmBufferState): void {
    if (!state.playing || state.pcm.byteLength === 0) return;
    const context = this.ensureContext();
    if (!context) return;
    this.startAt(state, context.currentTime);
  }

  /**
   * 把正在循环的静态快照无缝切换成一个长期存活的实时 PCM 读取器。
   * 首选 AudioWorklet（pcmStreamWorklet.js，渲染在音频线程，主线程忙帧不卡音）；
   * 不支持时回退 ScriptProcessor（旧 WebAudio API，回调跑在主线程）。两者都比
   * 为每次 DirectSound Unlock 新建 AudioBufferSourceNode 更符合环形缓冲语义，
   * 也把 Bink/音乐流的整块重复解码降为每个输出量子的线性读取。
   */
  private startLiveStream(state: PcmBufferState): void {
    const context = this.context;
    if (!context || state.stream || state.worklet || !state.source || !state.playing) return;
    if (typeof AudioWorkletNode !== 'undefined' && context.audioWorklet) {
      void this.startWorkletStream(state, context).catch((error) => {
        this.report(error);
        // 模块加载失败等异常：回退主线程 ScriptProcessor（源仍在播，条件仍成立）。
        if (state.source && !state.stream && !state.worklet) this.startScriptProcessorStream(state, context);
      });
      return;
    }
    this.startScriptProcessorStream(state, context);
  }

  /**
   * AudioWorklet 路径：等模块就绪后创建节点，整块同步当前 PCM 镜像并从
   * 旧 source 的当前位置续播，然后拆除旧 source。加载期间旧 source 继续播
   * 旧快照，切换无缝隙。
   */
  private async startWorkletStream(state: PcmBufferState, context: AudioContext): Promise<void> {
    const oldSource = state.source;
    if (!oldSource) return;
    await loadPcmStreamWorklet(context);
    // 等待期间可能被替换/停止/重启：只有源没变才接管。
    if (state.worklet || !state.playing || state.source !== oldSource) return;

    const current = this.currentPosition(state);
    const totalFrames = Math.floor(state.pcm.byteLength / state.format.nBlockAlign);
    const worklet = new AudioWorkletNode(context, PCM_STREAM_WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [Math.max(1, state.format.nChannels)],
    });
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    gain.gain.value = directSoundVolumeToGain(state.volume);
    panner.pan.value = directSoundPanToStereo(state.pan);
    worklet.connect(gain).connect(panner).connect(this.masterDestination(context));
    worklet.port.onmessage = (event) => this.onWorkletMessage(state, worklet, event.data);
    const frame = bytePositionToFrame(current, state);
    worklet.port.postMessage({
      kind: 'create',
      channels: state.format.nChannels,
      frames: totalFrames,
      frequency: state.frequency,
      loop: state.loop,
      frame,
    });
    // 初始全量同步：现有镜像一次性转成交织 Float32 送进 worklet。
    this.postWorkletUpdate(state, worklet, 0, state.pcm);

    const oldGain = state.gain;
    const oldPanner = state.panner;
    state.source = null;
    state.worklet = worklet;
    state.gain = gain;
    state.panner = panner;
    state.streamFrame = frame;
    state.workletPositionAt = context.currentTime;
    state.positionBytes = current;

    oldSource.onended = null;
    try {
      oldSource.stop();
    } catch {
      /* 已自然结束。 */
    }
    oldSource.disconnect();
    oldGain?.disconnect();
    oldPanner?.disconnect();
  }

  /** worklet 回发消息：目前只有按约 100ms 节奏的播放游标。 */
  private onWorkletMessage(
    state: PcmBufferState,
    worklet: AudioWorkletNode,
    message: { kind: string; frame?: number },
  ): void {
    if (state.worklet !== worklet || !this.context || message.kind !== 'position') return;
    state.streamFrame = message.frame ?? state.streamFrame;
    state.workletPositionAt = this.context.currentTime;
  }

  private postWorkletMessage(state: PcmBufferState, message: Record<string, unknown> & { kind: string }): void {
    if (!state.worklet) return;
    state.worklet.port.postMessage(message);
  }

  /** 把一段 16/8 位 PCM 转成交织 Float32 并 transfer 进 worklet。 */
  private postWorkletUpdate(state: PcmBufferState, worklet: AudioWorkletNode, offset: number, bytes: Uint8Array): void {
    const channels = Math.max(1, state.format.nChannels);
    const blockAlign = Math.max(1, state.format.nBlockAlign);
    const frames = Math.floor(bytes.byteLength / blockAlign);
    if (frames <= 0) return;
    const data = new Float32Array(frames * channels);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bytesPerSample = state.format.wBitsPerSample >>> 3;
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        data[frame * channels + channel] = readPcmSample(
          view,
          frame * blockAlign + channel * bytesPerSample,
          state.format.wBitsPerSample,
        );
      }
    }
    worklet.port.postMessage({ kind: 'update', offsetFrames: Math.floor(offset / blockAlign), data }, [data.buffer]);
  }

  /** ScriptProcessor 回退路径：主线程 onaudioprocess 逐量子渲染。 */
  private startScriptProcessorStream(state: PcmBufferState, context: AudioContext): void {
    if (state.stream || !state.source || !state.playing) return;
    const createProcessor = context.createScriptProcessor?.bind(context);
    if (!createProcessor) return;

    const current = this.currentPosition(state);
    const oldSource = state.source;
    const oldGain = state.gain;
    const oldPanner = state.panner;
    try {
      const stream = createProcessor(STREAM_PROCESSOR_FRAMES, 0, Math.max(1, state.format.nChannels));
      const gain = context.createGain();
      const panner = context.createStereoPanner();
      gain.gain.value = directSoundVolumeToGain(state.volume);
      panner.pan.value = directSoundPanToStereo(state.pan);
      stream.connect(gain).connect(panner).connect(this.masterDestination(context));
      state.streamFrame = bytePositionToFrame(current, state);
      stream.onaudioprocess = (event) => this.renderLiveStream(state, stream, event.outputBuffer);

      state.source = null;
      state.stream = stream;
      state.gain = gain;
      state.panner = panner;
      state.positionBytes = current;

      oldSource.onended = null;
      try {
        oldSource.stop();
      } catch {
        /* 已自然结束。 */
      }
      oldSource.disconnect();
      oldGain?.disconnect();
      oldPanner?.disconnect();
    } catch (error) {
      this.report(error);
    }
  }

  private renderLiveStream(state: PcmBufferState, stream: ScriptProcessorNode, output: AudioBuffer): void {
    const channels = Array.from({ length: output.numberOfChannels }, (_, channel) => output.getChannelData(channel));
    for (const channel of channels) channel.fill(0);
    if (state.stream !== stream || !state.playing) return;

    const totalFrames = Math.floor(state.pcm.byteLength / state.format.nBlockAlign);
    if (totalFrames <= 0) return;
    const outputRate = output.sampleRate || this.context?.sampleRate || state.format.nSamplesPerSec;
    const step = state.frequency / Math.max(1, outputRate);
    // 16 位 PCM（主流）走整块 Int16Array 视图，免逐样本 DataView 分支；
    // 其余位宽回退逐样本读取。
    const samples16 =
      state.format.wBitsPerSample === 16
        ? new Int16Array(state.pcm.buffer, state.pcm.byteOffset, state.pcm.byteLength >> 1)
        : null;
    const view = samples16 ? null : new DataView(state.pcm.buffer, state.pcm.byteOffset, state.pcm.byteLength);
    const bytesPerSample = state.format.wBitsPerSample >>> 3;
    let frame = state.streamFrame;
    for (let index = 0; index < output.length; index++) {
      const sourceFrame = Math.floor(frame) % totalFrames;
      for (let channel = 0; channel < channels.length; channel++) {
        const sourceChannel = Math.min(channel, state.format.nChannels - 1);
        if (samples16) {
          channels[channel]![index] = samples16[sourceFrame * state.format.nChannels + sourceChannel]! / 32_768;
        } else {
          const offset = sourceFrame * state.format.nBlockAlign + sourceChannel * bytesPerSample;
          channels[channel]![index] = readPcmSample(view!, offset, state.format.wBitsPerSample);
        }
      }
      frame += step;
      if (frame >= totalFrames) {
        if (state.loop) frame %= totalFrames;
        else {
          state.playing = false;
          frame = totalFrames;
          break;
        }
      }
    }
    state.streamFrame = frame;
    state.positionBytes = Math.min(totalFrames, Math.floor(frame)) * state.format.nBlockAlign;
  }

  private startAt(state: PcmBufferState, when: number): void {
    if (!state.playing || state.pcm.byteLength === 0) return;
    const context = this.ensureContext();
    if (!context) return;
    try {
      const audio = state.decoded ?? this.decode(context, state);
      state.decoded = audio;
      const source = context.createBufferSource();
      const gain = context.createGain();
      const panner = context.createStereoPanner();
      source.buffer = audio;
      source.loop = state.loop;
      source.playbackRate.value = playbackRate(state);
      gain.gain.value = directSoundVolumeToGain(state.volume);
      panner.pan.value = directSoundPanToStereo(state.pan);
      source.connect(gain).connect(panner).connect(this.masterDestination(context));
      const frame = bytePositionToFrame(state.positionBytes, state);
      state.source = source;
      state.gain = gain;
      state.panner = panner;
      state.startedAt = when;
      state.startedFrame = frame;
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        panner.disconnect();
        if (state.source !== source) return;
        state.source = null;
        state.gain = null;
        state.panner = null;
        if (!state.loop) {
          state.playing = false;
          state.positionBytes = 0;
        }
      };
      source.start(when, Math.min(frame / state.format.nSamplesPerSec, audio.duration));
    } catch (error) {
      this.report(error);
    }
  }

  private decode(context: AudioContext, state: PcmBufferState): AudioBuffer {
    const { format, pcm } = state;
    const frames = Math.floor(pcm.byteLength / format.nBlockAlign);
    const audio = context.createBuffer(format.nChannels, Math.max(1, frames), format.nSamplesPerSec);
    const bytesPerSample = format.wBitsPerSample >>> 3;
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let channel = 0; channel < format.nChannels; channel++) {
      const output = audio.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++) {
        const offset = frame * format.nBlockAlign + channel * bytesPerSample;
        output[frame] = readPcmSample(view, offset, format.wBitsPerSample);
      }
    }
    return audio;
  }

  private currentPosition(state: PcmBufferState): number {
    if (state.stream || state.worklet) {
      const totalFrames = Math.floor(state.pcm.byteLength / state.format.nBlockAlign);
      if (totalFrames <= 0) return 0;
      // worklet 游标 = 最近回发帧 + 按频率外推（回发节奏约 100ms）。
      const advanced =
        state.worklet && this.context && state.playing
          ? Math.floor((this.context.currentTime - state.workletPositionAt) * state.frequency)
          : 0;
      const frame = state.loop
        ? (Math.floor(state.streamFrame) + advanced) % totalFrames
        : Math.min(totalFrames, Math.floor(state.streamFrame) + advanced);
      return frame * state.format.nBlockAlign;
    }
    if (!state.source || !this.context || !state.playing) return state.positionBytes;
    const elapsed = Math.max(0, this.context.currentTime - state.startedAt);
    const advanced = Math.floor(elapsed * state.format.nSamplesPerSec * playbackRate(state));
    const totalFrames = Math.floor(state.pcm.byteLength / state.format.nBlockAlign);
    if (totalFrames <= 0) return 0;
    const frame = state.loop
      ? (state.startedFrame + advanced) % totalFrames
      : Math.min(totalFrames, state.startedFrame + advanced);
    return frame * state.format.nBlockAlign;
  }

  private detachPlayback(state: PcmBufferState, updatePosition = true): void {
    const source = state.source;
    const stream = state.stream;
    const worklet = state.worklet;
    const gain = state.gain;
    const panner = state.panner;
    if (!source && !stream && !worklet) return;
    if (updatePosition) state.positionBytes = this.currentPosition(state);
    state.source = null;
    state.stream = null;
    state.worklet = null;
    state.gain = null;
    state.panner = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // AudioBufferSourceNode 已经自然结束。
      }
      source.disconnect();
    }
    if (stream) {
      stream.onaudioprocess = null;
      stream.disconnect();
    }
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.postMessage({ kind: 'destroy' });
      worklet.disconnect();
    }
    gain?.disconnect();
    panner?.disconnect();
  }

  private ensureContext(): AudioContext | null {
    if (this.context?.state === 'closed') this.context = null;
    if (this.context) return this.context;
    try {
      if (this.options.contextFactory) {
        this.context = this.options.contextFactory();
      } else {
        if (typeof AudioContext === 'undefined') return null;
        this.context = new AudioContext();
      }
      // 新 context 需要重建主增益节点（旧节点随旧 context 一起销毁）。
      this.masterGain = null;
      return this.context;
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  /** 惰性创建的主增益节点：所有 buffer 汇聚后统一过音量，再进 destination。 */
  private masterDestination(context: AudioContext): AudioNode {
    if (!this.masterGain) {
      this.masterGain = context.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(this.options.destination?.(context) ?? context.destination);
    }
    return this.masterGain;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('WebAudioPcmSink 已销毁');
  }

  private report(error: unknown): void {
    this.options.onError?.(error);
  }
}

function readPcmSample(view: DataView, offset: number, bits: number): number {
  switch (bits) {
    case 8:
      return (view.getUint8(offset) - 128) / 128;
    case 16:
      return view.getInt16(offset, true) / 32_768;
    case 24: {
      let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
      if ((value & 0x80_0000) !== 0) value |= 0xff00_0000;
      return value / 8_388_608;
    }
    case 32:
      return view.getInt32(offset, true) / 2_147_483_648;
    default:
      return 0;
  }
}

function bytePositionToFrame(position: number, state: PcmBufferState): number {
  return Math.floor(alignPosition(position, state) / state.format.nBlockAlign);
}

function alignPosition(position: number, state: PcmBufferState): number {
  const clamped = clamp(Math.trunc(position), 0, state.pcm.byteLength);
  return clamped - (clamped % state.format.nBlockAlign);
}

function playbackRate(state: PcmBufferState): number {
  return clamp(state.frequency / state.format.nSamplesPerSec, 0.01, 16);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
