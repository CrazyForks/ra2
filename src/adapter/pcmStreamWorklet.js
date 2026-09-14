/**
 * DirectSound 环形 PCM 流的 AudioWorklet 渲染器。
 *
 * 主线程只负责把 guest 写入的 PCM 区间转成 Float32 同步进来（update），
 * 逐量子的采样渲染在音频线程完成——主线程被画面渲染/GC 打满时不会再掏空
 * 缓冲（旧 ScriptProcessor 方案 onaudioprocess 跑在主线程，卡顿根因）。
 * 每个 DirectSound buffer 一个 Processor 实例，消息经各自 port 直连。
 *
 * 消息协议（port，主线程 → worklet）：
 *  - create {channels, frames, frequency, loop, frame}：建流（PCM 全量随后 update 同步）
 *  - update {offsetFrames, data: Float32Array}：按帧偏移覆写交织数据
 *  - play / stop / set-loop {loop} / set-position {frame} / set-frequency {frequency}
 *  - destroy
 * 回发（worklet → 主线程）：position {frame}——约每 100ms 汇报播放游标，
 * 主线程按 currentTime 外推。
 *
 * 注意：本文件经 `new URL(..., import.meta.url)` 原样发射为构建资源，
 * Vite 不做 TS 转译，因此必须保持纯 JS 语法（无类型注解/declare/泛型）。
 */

// AudioWorklet 全局（sampleRate/currentTime/registerProcessor）不在 lib.dom 里，
// 此处用 JSDoc 提供类型，文件本体保持纯 JS。
/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentTime */

class Ra2PcmStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {{ channels: number, frames: number, pcm: Float32Array, frame: number,
     *   playing: boolean, loop: boolean, step: number, lastPositionAt: number } | null} */
    this.state = null;
    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  /**
   * @param {{ kind: string, channels?: number, frames?: number, frequency?: number,
   *   loop?: boolean, frame?: number, offsetFrames?: number, data?: Float32Array }} message
   */
  onMessage(message) {
    switch (message.kind) {
      case 'create': {
        const channels = Math.max(1, message.channels);
        const frames = Math.max(0, message.frames);
        this.state = {
          channels,
          frames,
          pcm: new Float32Array(Math.max(1, frames) * channels),
          frame: message.frame,
          playing: true,
          loop: message.loop,
          step: Math.max(0, message.frequency) / sampleRate,
          lastPositionAt: currentTime,
        };
        break;
      }
      case 'update': {
        if (this.state) this.state.pcm.set(message.data, message.offsetFrames * this.state.channels);
        break;
      }
      case 'play': {
        if (this.state) this.state.playing = true;
        break;
      }
      case 'stop': {
        if (this.state) {
          this.state.playing = false;
          this.port.postMessage({ kind: 'position', frame: this.state.frame });
        }
        break;
      }
      case 'set-loop': {
        if (this.state) this.state.loop = message.loop;
        break;
      }
      case 'set-position': {
        if (this.state) this.state.frame = message.frame;
        break;
      }
      case 'set-frequency': {
        if (this.state) this.state.step = Math.max(0, message.frequency) / sampleRate;
        break;
      }
      case 'destroy': {
        this.state = null;
        break;
      }
    }
  }

  process(_inputs, outputs) {
    const state = this.state;
    const output = outputs[0];
    if (!state || !output || output.length === 0) return true;
    const length = output[0] ? output[0].length : 0;
    for (const channel of output) channel.fill(0);
    if (!state.playing || state.frames <= 0) return true;

    let frame = state.frame;
    for (let i = 0; i < length; i++) {
      if (frame >= state.frames) {
        if (state.loop) {
          frame %= state.frames;
        } else {
          state.playing = false;
          frame = state.frames;
          break;
        }
      }
      const base = Math.floor(frame) * state.channels;
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][i] = state.pcm[base + Math.min(channel, state.channels - 1)];
      }
      frame += state.step;
    }
    state.frame = frame;

    // 约每 100ms 回发一次游标；主线程拿它当外推基准。
    if (currentTime - state.lastPositionAt >= 0.1) {
      state.lastPositionAt = currentTime;
      this.port.postMessage({ kind: 'position', frame: state.frame });
    }
    return true;
  }
}

registerProcessor('ra2-pcm-stream', Ra2PcmStreamProcessor);
