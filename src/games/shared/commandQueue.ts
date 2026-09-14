import type { GuestMemory } from '../../vm86/win32';

export interface DeployQueueEntry {
  queue: 'outgoing' | 'scheduled';
  slot: number;
  frame: number;
  house: number;
  targetId: number;
  targetType: number;
  flags: number;
  executed: boolean;
}

/** 显式诊断用：只读最近 128 个环槽，包含已出队但尚未覆盖的历史。
 * 不是完整事件日志；采样错过覆盖时不得把缺失记录解释为事件未发送。 */
export function createCommandQueueReader(
  memory: GuestMemory,
  hash: string,
  profile: {
    hash: string;
    signatures: ReadonlyArray<{ address: number; bytes: readonly number[] }>;
    outgoing: number;
    scheduled: number;
  },
): (() => DeployQueueEntry[] | null) | null {
  if (hash !== profile.hash) return null;
  try {
    for (const { address, bytes } of profile.signatures) {
      const actual = memory.read_memory(address, bytes.length);
      if (actual.length !== bytes.length || !actual.every((byte, i) => byte === bytes[i])) return null;
    }
  } catch {
    return null;
  }
  return () => {
    try {
      const result: DeployQueueEntry[] = [];
      for (const [queue, address, capacity] of [
        ['outgoing', profile.outgoing, 128],
        ['scheduled', profile.scheduled, 16384],
      ] as const) {
        const header = memory.read_memory(address, 12);
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        const count = view.getUint32(0, true),
          head = view.getUint32(4, true),
          tail = view.getUint32(8, true);
        if (count > capacity || head >= capacity || tail >= capacity) return null;
        let slot = (tail + capacity - 128) % capacity,
          remaining = 128;
        while (remaining) {
          const slots = Math.min(remaining, capacity - slot);
          const bytes = memory.read_memory(address + 12 + slot * 111, slots * 111);
          if (bytes.length !== slots * 111) return null;
          const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          for (let i = 0; i < slots; i++) {
            const offset = i * 111;
            // 原版 DEPLOY=9；Frame 是原生事件字段，scheduled 队列中为计划执行帧。
            if (bytes[offset] !== 9 || bytes[offset + 2] === 255) continue;
            // 两版发送路径只 AND 0xFE，执行路径只 OR 1；高7位可能保留栈内容。
            // 不能按 C++ bool 的规范值 0/1 过滤，否则会遗漏真实本机事件。
            const flags = bytes[offset + 1]!;
            result.push({
              queue,
              slot: slot + i,
              frame: data.getUint32(offset + 3, true),
              house: bytes[offset + 2]!,
              targetId: data.getUint32(offset + 7, true),
              targetType: bytes[offset + 11]!,
              flags,
              executed: (flags & 1) !== 0,
            });
          }
          remaining -= slots;
          slot = 0;
        }
      }
      return result;
    } catch {
      return null;
    }
  };
}
