/**
 * LZMA-Alone 流解码封装（NSIS solid 块用）：浏览器在模块 Worker 里解，
 * Node/测试直接调用 vendored 的 LZMA SDK JS 实现。NSIS 流的 5 字节头
 * （props + dict）没有长度字段，这里补上 8 字节长度组成标准 13 字节头；
 * 未提供长度时填全 FF（解码到流尾）。
 */

export interface LzmaDecodeOptions {
  /** props+dict 5 字节头 + 压缩数据。调用后其底层 buffer 可能被转移，不得再使用
   *  （transferInput=false 时不转移）。 */
  stream: Uint8Array;
  /** 期望输出长度；提供时严格校验。 */
  outputSize?: number;
  onProgress?: (percent: number) => void;
  /** Worker 路径是否 transfer 输入 buffer（默认 true）。连续解码同一大缓冲的
   *  多段视图（NSIS 两段流逐文件解码）时传 false，避免底层缓冲被拆走。 */
  transferInput?: boolean;
}

/** 构造标准 LZMA-Alone 输入：props+dict（5）+ 长度（8）+ 数据。 */
export function buildLzmaAloneInput(stream: Uint8Array, outputSize?: number): Uint8Array {
  const result = new Uint8Array(stream.length + 8);
  result.set(stream.subarray(0, 5), 0);
  const sizeView = new DataView(result.buffer);
  if (outputSize === undefined) {
    sizeView.setUint32(5, 0xffffffff, true);
    sizeView.setUint32(9, 0xffffffff, true);
  } else {
    sizeView.setUint32(5, outputSize >>> 0, true);
    sizeView.setUint32(9, Math.floor(outputSize / 0x100000000), true);
  }
  result.set(stream.subarray(5), 13);
  return result;
}

export interface LzmaDecodeWorkerMessage {
  ok?: boolean;
  progress?: number;
  result?: Uint8Array;
  /** SDK 消耗的输入字节数（含 13 字节 LZMA-Alone 头），reportConsumed 时回传。 */
  consumed?: number;
  error?: string;
}

/** 解码结果附带 SDK 消耗的输入字节数（含 13 字节 LZMA-Alone 头）。
 *  NSIS 两段流（头流 EOS 处截断 + 数据流）靠它定位第二段起点。 */
export interface LzmaDecodedStream {
  output: Uint8Array;
  consumed: number;
}

/** 在独立 Worker 中解码，避免数百 MB 的解码阻塞主线程。 */
async function decodeInWorker(options: LzmaDecodeOptions, reportConsumed: boolean): Promise<LzmaDecodedStream> {
  const worker = new Worker(new URL('./lzmaDecodeWorker.ts', import.meta.url), { type: 'module' });
  // 心跳由 finally 统一清理：只在 worker 回调里 clear 会漏掉 postMessage 同步抛错的路径。
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    return await new Promise<LzmaDecodedStream>((resolve, reject) => {
      // NSIS 整流解码时长度未知，SDK 不报中途进度：定时心跳让 UI 显示已用时长。
      let lastProgressAt = Date.now();
      heartbeat = setInterval(() => {
        if (Date.now() - lastProgressAt >= 2000) options.onProgress?.(-1);
      }, 3000);
      worker.onmessage = (event: MessageEvent<LzmaDecodeWorkerMessage>) => {
        const message = event.data;
        if (message.progress !== undefined) {
          lastProgressAt = Date.now();
          options.onProgress?.(message.progress);
          return;
        }
        if (message.ok && message.result) resolve({ output: message.result, consumed: message.consumed ?? 0 });
        else reject(new Error(message.error ?? 'LZMA 解码失败'));
      };
      worker.onerror = (event) => {
        reject(new Error(event.message || 'LZMA Worker 异常'));
      };
      // 转移整块输入 buffer：worker 内克隆视图保留 offset/length，主线程不再使用。
      const input = {
        buffer: options.stream.buffer,
        byteOffset: options.stream.byteOffset,
        byteLength: options.stream.byteLength,
      } as unknown as Uint8Array;
      try {
        worker.postMessage(
          {
            input,
            outputSize: options.outputSize,
            reportConsumed,
          },
          options.transferInput === false ? [] : [options.stream.buffer],
        );
      } catch (error: unknown) {
        // 输入 buffer 已被拆走时 postMessage 同步抛错（DataCloneError）；
        // 不同步 reject 的话 Promise 永不结束，调用方会永久挂起。
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    worker.terminate();
  }
}

/** Node/测试环境直接调用 vendored 实现。 */
async function decodeInline(options: LzmaDecodeOptions, reportConsumed: boolean): Promise<LzmaDecodedStream> {
  // vendored 文件已改为显式 ESM 导出；Node 里补一个 self 全局供其内部使用。
  (globalThis as Record<string, unknown>).self ??= globalThis;
  (globalThis as Record<string, unknown>).window ??= globalThis;
  const { LZMA: lzma } = await import('./vendor/lzma-worker.js');
  const input = buildLzmaAloneInput(options.stream, options.outputSize);
  return new Promise<LzmaDecodedStream>((resolve, reject) => {
    lzma.decompress(
      input,
      (result, error) => {
        if (!result) {
          reject(new Error(typeof error === 'string' ? error : (error?.message ?? 'LZMA 解码失败')));
          return;
        }
        if (options.outputSize !== undefined && result.length < options.outputSize) {
          reject(new Error(`LZMA 输出长度不足：${result.length} < ${options.outputSize}`));
          return;
        }
        // SDK 的 decode() 对纯 ASCII 输出（无 NUL/高位字节）返回 String，
        // 个别路径返回普通数组：统一归一化为 Uint8Array。
        const raw =
          result instanceof Uint8Array
            ? result
            : typeof result === 'string'
              ? new TextEncoder().encode(result)
              : Uint8Array.from(result);
        // SDK 按块填充，达到长度目标时可能多出最后一小块（1-2 字节），截齐。
        const output = options.outputSize !== undefined ? raw.subarray(0, options.outputSize) : raw;
        resolve({
          output,
          consumed: reportConsumed
            ? ((lzma as { getLastInputConsumed?: () => number }).getLastInputConsumed?.() ?? 0)
            : 0,
        });
      },
      (percent) => options.onProgress?.(percent),
    );
  });
}

async function decodeLzmaStreamInternal(
  options: LzmaDecodeOptions,
  reportConsumed: boolean,
): Promise<LzmaDecodedStream> {
  if (typeof Worker !== 'undefined' && typeof document !== 'undefined' && !import.meta.env?.VITEST) {
    return decodeInWorker(options, reportConsumed);
  }
  return decodeInline(options, reportConsumed);
}

export function decodeLzmaStream(options: LzmaDecodeOptions): Promise<Uint8Array> {
  return decodeLzmaStreamInternal(options, false).then((decoded) => decoded.output);
}

/** 解码并回传 SDK 消耗的输入字节数（含 13 字节 LZMA-Alone 头）。 */
export function decodeLzmaStreamWithConsumed(options: LzmaDecodeOptions): Promise<LzmaDecodedStream> {
  return decodeLzmaStreamInternal(options, true);
}
