import { le32 } from './bytes';

// 原生速度档位：0 → 60，1 → 45，其余合法档位 → 60 / 档位（整数）。
// 在 LAN 开局路径执行，读取本次房间设置；不改计时器、确认或后续 Timing 事件。

export function makeLanStartupTiming(
  sessionSpeed: number,
  requestedFps: number,
  moveOpcode: number,
  sendRate: number,
): number[] {
  return [
    0x9c,
    0x50,
    0x51,
    0x52, // pushfd; 保存临时寄存器
    0x8b,
    0x0d,
    ...le32(sessionSpeed),
    0xb8,
    ...le32(30), // 非法档位保持原生保守起点，避免除零或异常加速
    0x83,
    0xf9,
    6,
    0x77,
    24, // unsigned > 6 → store
    0xb8,
    ...le32(60),
    0x85,
    0xc9,
    0x74,
    15, // 0 → store
    0x83,
    0xf9,
    1,
    0x75,
    7,
    0xb8,
    ...le32(45),
    0xeb,
    3,
    0x99,
    0xf7,
    0xf9, // cdq; idiv ecx
    0xa3,
    ...le32(requestedFps),
    0x5a,
    0x59,
    0x58,
    0x9d,
    moveOpcode,
    ...le32(sendRate), // 重放被替换的 mov eax/ecx, FrameSendRate
    0xc3,
  ];
}

export function lanTimingCall(site: number, target: number): number[] {
  return [0xe8, ...le32(target - site - 5)];
}
