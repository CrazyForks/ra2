import { t } from '../../../shared/i18n/translate';
import type { VmFrame } from '../../../../vm86/win32';

export const PROBE_PADDING = 16;
/** Enable full-frame processing only for explicitly wired models; arbitrary probe models cannot automatically become live features. */
export const LIVE_MODEL_IDS = ['ultra4x-fp16', 'nomos2x', 'nomos2x-fp16'] as const;
export type LiveModelId = (typeof LIVE_MODEL_IDS)[number];
export function isLiveModelId(id: string): id is LiveModelId {
  return LIVE_MODEL_IDS.some((candidate) => candidate === id);
}
export const ULTRASHARP_HASH = 'ba692ad6c7b59bdebbaa9951c9ef5295a6d69e7444f1c46824c3cafdaab067a8';
export const ULTRASHARP_URL =
  'https://huggingface.co/Kim2091/UltraSharpV2/resolve/2d1db39ff692c111da92112d49f833e4ad7035ae/4x-UltraSharpV2_Lite_fp32_op17.onnx';
/**
 * Pin releases and hashes; scale belongs to model architecture and cannot be changed by altering output display size alone. The two /.tmp-models/ entries are developer-exported local weights; see docs/AI_UPSCALING.md. They are neither committed nor distributed. Their loading/probe entry points are gated by import.meta.env.DEV in page.ts and RuntimeToolbarView.tsx; production never requests them. Models retained long term must use release URLs with fixed hashes.
 */
export const PROBE_MODELS = [
  {
    id: 'nomos2x-fp16',
    name: 'NomosUni SPAN 2× FP16',
    scale: 2,
    license: t('CC BY 4.0 · Phhofm / 本地半精度转换'),
    megabytes: '0.84',
    hash: '89dbec0fed7a06a0c70ace8b12a937b8f07d11b69aa996dd1ea20d6b9c90b92b',
    url: '/.tmp-models/nomosuni-span-2x-fp16.onnx',
  },
  {
    id: 'nomos2x',
    name: 'NomosUni SPAN 2×',
    scale: 2,
    license: t('CC BY 4.0 · Phhofm / 本地 ONNX 导出'),
    megabytes: '1.66',
    hash: 'bff599f3192122440c2b946a1a9d881ba4dc978e19a36b7dcc8fad73d70d25c0',
    url: '/.tmp-models/nomosuni-span-2x-fp32.onnx',
  },
  {
    id: 'animesharp2x-soft',
    name: 'AnimeSharpV2 RealPLKSR 2× Soft',
    scale: 2,
    license: t('CC BY-NC-SA 4.0（非商业）· Kim2091'),
    megabytes: '29.9',
    hash: 'a77ad08fff1f1216f7213f0a1296941806250ab9af9465d41aad96b2a862156f',
    url: 'https://github.com/Kim2091/Kim2091-Models/releases/download/2x-AnimeSharpV2_Set/2x-AnimeSharpV2_RPLKSR_Soft_fp32.onnx',
  },
  {
    id: 'animesharp2x-sharp',
    name: 'AnimeSharpV2 RealPLKSR 2× Sharp',
    scale: 2,
    license: t('CC BY-NC-SA 4.0（非商业）· Kim2091'),
    megabytes: '29.9',
    hash: '580cf6afc9231a07650ae0ce58ef67b99fc4571a31bd9a3bb9bc3dfcb1e9f322',
    url: 'https://github.com/Kim2091/Kim2091-Models/releases/download/2x-AnimeSharpV2_Set/2x-AnimeSharpV2_RPLKSR_Sharp_fp32.onnx',
  },
  {
    id: 'ultra4x-fp16',
    name: 'UltraSharpV2 Lite 4× FP16',
    scale: 4,
    license: t('CC BY-NC-SA 4.0（非商业）· Kim2091'),
    megabytes: '15.3',
    hash: 'b368dd0460421c3b3484a9a6855c07670f853abde3e0e5a6bfb72f2d5f8d9c50',
    url: 'https://huggingface.co/Kim2091/UltraSharpV2/resolve/2d1db39ff692c111da92112d49f833e4ad7035ae/4x-UltraSharpV2_Lite_fp16_op17.onnx',
  },
  {
    id: 'apisr2x',
    name: t('APISR RRDB 原生 2×'),
    scale: 2,
    license: 'GPL-3.0 · APISR / Xenova ONNX',
    megabytes: '18',
    hash: 'c0c1bd343db0da03de28c5eb82c1cadfd5c77f909c9351fffda047dd116a3a24',
    url: 'https://huggingface.co/Xenova/2x_APISR_RRDB_GAN_generator-onnx/resolve/6361f81701564a71fe9aed63b1f1a150e0340e8f/onnx/model.onnx',
  },
  {
    id: 'ultra4x',
    name: 'UltraSharpV2 Lite 4×',
    scale: 4,
    hash: ULTRASHARP_HASH,
    url: ULTRASHARP_URL,
    license: t('CC BY-NC-SA 4.0（非商业）· Kim2091'),
    megabytes: '29.9',
  },
] as const;
export interface ProbeImage {
  rgba: Uint8ClampedArray;
  size: number;
  height?: number;
}

/** Copy a small central patch synchronously; never give recyclable VM frame buffers to async models or read the GL framebuffer. */
export function captureProbeImage(frame: VmFrame, size: number): ProbeImage {
  if (!Number.isInteger(size) || size < 32 || size > 256) throw new Error(t('实验采样边长必须为 32～256'));
  const padded = size + PROBE_PADDING * 2;
  const rgba = new Uint8ClampedArray(padded * padded * 4);
  const left = Math.floor((frame.width - padded) / 2),
    top = Math.floor((frame.height - padded) / 2);
  for (let y = 0; y < padded; y++)
    for (let x = 0; x < padded; x++) {
      const source =
        Math.max(0, Math.min(frame.height - 1, top + y)) * frame.width +
        Math.max(0, Math.min(frame.width - 1, left + x));
      const out = (y * padded + x) * 4;
      if (frame.rgba) rgba.set(frame.rgba.subarray(source * 4, source * 4 + 3), out);
      else if (frame.rgb565) {
        const p = frame.rgb565[source]!;
        const r = (p >>> 11) & 31,
          g = (p >>> 5) & 63,
          b = p & 31;
        rgba[out] = (r << 3) | (r >>> 2);
        rgba[out + 1] = (g << 2) | (g >>> 4);
        rgba[out + 2] = (b << 3) | (b >>> 2);
      } else {
        const color = frame.pixels[source]! * 4;
        rgba.set(frame.palette.subarray(color, color + 3), out);
      }
      rgba[out + 3] = 255;
    }
  return { rgba, size: padded };
}

export function probeTensor(image: ProbeImage): Float32Array {
  const count = image.size * (image.height ?? image.size);
  if (image.rgba.length !== count * 4) throw new Error(t('采样像素长度错误'));
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) data[c * count + i] = image.rgba[i * 4 + c]! / 255;
  return data;
}

export function probeOutput(
  data: Float32Array,
  dims: readonly number[],
  inputSize: number,
  scale: 2 | 4 = 4,
): ProbeImage {
  return probeFrameOutput(data, dims, inputSize, inputSize, scale);
}
export function probeFrameOutput(
  data: Float32Array,
  dims: readonly number[],
  width: number,
  height: number,
  scale: 2 | 4,
): ProbeImage {
  const size = width * scale,
    outHeight = height * scale,
    count = size * outHeight;
  if (
    dims.length !== 4 ||
    dims[0] !== 1 ||
    dims[1] !== 3 ||
    dims[2] !== outHeight ||
    dims[3] !== size ||
    data.length !== count * 3
  ) {
    throw new Error(t('模型输出不是预期的 {0}× RGB：{1}', scale, dims.join('×')));
  }
  const rgba = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 3; c++) {
      const value = data[c * count + i]!;
      if (!Number.isFinite(value)) throw new Error(t('模型输出包含 NaN/Infinity'));
      rgba[i * 4 + c] = Math.round(Math.max(0, Math.min(1, value)) * 255);
    }
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, size, ...(outHeight !== size ? { height: outHeight } : {}) };
}

export type ProbeReply =
  | { type: 'ready'; adapter: string }
  | { type: 'error'; message: string }
  | { type: 'result'; image: ProbeImage; milliseconds: number; adapter: string };
