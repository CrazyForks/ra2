/**
 * BroadcastChannel DirectPlay 传输单元测试（迁移自 scripts/dplayBroadcastChannelSmoke.mts）：
 * 客体内存读出来的是整片 WASM 缓冲上的视图，postMessage 前必须只克隆逻辑载荷，
 * 不能把整个 VM 底缓冲带进结构化克隆。Node 里 BroadcastChannel 是全局的。
 */
import { expect, it } from 'vitest';
import { BroadcastChannelTransport } from '../../src/vm86/shim/dplayTransport';
import type { DplayWire } from '../../src/vm86/shim/dplayWire';

it('BroadcastChannel 精确尺寸 payload 克隆（不携带整个 VM 底缓冲）', async () => {
  // 随机 channel 名，避免与其他测试/进程冲突。
  const channelName = `dplay-broadcast-smoke-${Date.now()}-${Math.random()}`;
  const oversizedBacking = new Uint8Array(1024 * 1024);
  oversizedBacking.set([1, 2, 3, 4, 5], 123);
  const narrowPayload = oversizedBacking.subarray(123, 128);

  let receiver!: BroadcastChannelTransport;
  let timeout: ReturnType<typeof setTimeout>;
  const received = new Promise<DplayWire>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('BroadcastChannel payload was not delivered')), 2000);
    receiver = new BroadcastChannelTransport({ onMessage: resolve }, channelName);
  });
  const sender = new BroadcastChannelTransport({ onMessage() {} }, channelName);

  try {
    expect(sender.send({ t: 'msg', i: 'smoke-room', f: 1, o: 2, a: narrowPayload })).toBe(true);
    const cloned = await received;
    expect(cloned.t).toBe('msg');
    if (cloned.t !== 'msg') throw new Error('Expected a msg payload');
    expect([...cloned.a]).toEqual([1, 2, 3, 4, 5]);
    expect(cloned.a.byteLength).toBe(5);
    expect(cloned.a.buffer.byteLength, 'must not clone the full VM backing buffer').toBe(5);
  } finally {
    clearTimeout(timeout!);
    sender.close();
    receiver.close();
  }
}, 10_000);
