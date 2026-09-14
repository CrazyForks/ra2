/** NSIS solid LZMA 流解码 Worker：输入转移整块 buffer，输出结果转移回主线程。 */
import { LZMA as lzma } from './vendor/lzma-worker.js';
import { buildLzmaAloneInput, type LzmaDecodeWorkerMessage } from './lzmaDecode';

export interface LzmaDecodeRequest {
  input: { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
  outputSize?: number;
  reportConsumed?: boolean;
}

self.onmessage = (event: MessageEvent<LzmaDecodeRequest>) => {
  const { input, outputSize, reportConsumed } = event.data;
  const stream = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const post = (message: LzmaDecodeWorkerMessage, transfer?: Transferable[]): void => {
    (self as unknown as Worker).postMessage(message, transfer ?? []);
  };
  try {
    const withHeader = buildLzmaAloneInput(stream, outputSize);
    lzma.decompress(
      withHeader,
      (result, error) => {
        if (!result) {
          post({ ok: false, error: typeof error === 'string' ? error : (error?.message ?? 'LZMA 解码失败') });
          return;
        }
        if (outputSize !== undefined && result.length < outputSize) {
          post({ ok: false, error: `LZMA 输出长度不足：${result.length} < ${outputSize}` });
          return;
        }
        // SDK 的 decode() 对纯 ASCII 输出返回 String，个别路径返回普通数组：
        // 统一归一化为 Uint8Array。
        const raw =
          result instanceof Uint8Array
            ? result
            : typeof result === 'string'
              ? new TextEncoder().encode(result)
              : Uint8Array.from(result);
        // SDK 按块填充，达到长度目标时可能多出最后一小块（1-2 字节），截齐。
        const output = outputSize !== undefined ? raw.subarray(0, outputSize) : raw;
        post(
          {
            ok: true,
            result: output,
            consumed: reportConsumed
              ? ((lzma as { getLastInputConsumed?: () => number }).getLastInputConsumed?.() ?? 0)
              : undefined,
          },
          [output.buffer],
        );
      },
      (percent) => {
        post({ progress: percent });
      },
    );
  } catch (error) {
    post({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
