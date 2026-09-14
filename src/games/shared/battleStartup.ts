import type { GuestMemory } from '../../vm86/win32';
import { le32 } from './bytes';

/** 单人测试入口的版本参数：跳转目标、开局处理器与对应的页面直达安装器。 */
export interface BattleStartupSpec {
  readonly label: string;
  readonly expectedHash: string;
  readonly site: number;
  /** 原生开局处理器；以 fastcall 约定接收设置窗口与动作码。 */
  readonly handler: number;
  /** 进入战场前先直达该版本的遭遇战页面，由它校验哈希并分配自己的桩尾。 */
  readonly navigate: (memory: GuestMemory, reserve: (size: number) => number, hash: string) => number;
}

/** 两个版本在覆盖点处的原始指令相同：读设置命令再比较 0x617。 */
const SIGNATURE = [0x8b, 0x44, 0x24, 0x04, 0x3d, 0x17, 0x06, 0, 0, 0x74, 0x22] as const;

/**
 * 单人测试入口：原生设置初始化返回后，以当前设置调用开局处理器。
 * 不发送 WM_COMMAND/鼠标事件，不绕过选项校验、场景加载或设置页清理。
 * ECX=设置窗口，EDX=原生开始动作 0x617；两个栈参数为零，由被调用者 RET 8。
 * 这里只消费一次；返回菜单后再次进入遭遇战仍然需要玩家自行开始。
 */
export function installBattleStartup(
  memory: GuestMemory,
  reserve: (size: number) => number,
  hash: string,
  spec: BattleStartupSpec,
): number {
  const { label, site, handler, navigate } = spec;
  if (hash !== spec.expectedHash) throw new Error(`${label}：EXE 哈希不匹配`);
  const current = memory.read_memory(site, SIGNATURE.length);
  if (current.length !== SIGNATURE.length || !current.every((byte, index) => byte === SIGNATURE[index])) {
    throw new Error(`${label}：指令签名不匹配或重复安装`);
  }
  const base = reserve(96);
  if (!Number.isInteger(base) || base % 16 || base < 0x80000 || base + 96 > 0xc0000) {
    throw new Error(`${label}：启动桩分配越界`);
  }
  const storage = memory.read_memory(base, 96);
  if (storage.length !== 96 || storage.some((byte) => byte !== 0)) throw new Error(`${label}：启动桩已占用`);
  const state = base + 80;
  const code = [
    0x9c,
    0x60, // 保存原始标志/寄存器；开局处理器只能通过原生状态输出结果。
    0x83,
    0x3d,
    ...le32(state),
    0,
    0x74,
    26,
    0xc7,
    0x05,
    ...le32(state),
    ...le32(0), // 调用前消费，重入也不会重复开局。
    0x6a,
    0,
    0x6a,
    0,
    0x8b,
    0xce,
    0xba,
    ...le32(0x617),
  ];
  code.push(0xe8, ...le32(handler - (base + code.length + 5)));
  code.push(0x61, 0x9d, ...SIGNATURE.slice(0, 9));
  code.push(0xe9, ...le32(site + 9 - (base + code.length + 5)));
  const bytes = new Uint8Array(96);
  bytes.set(code);
  bytes.set(le32(1), 80);
  navigate(
    memory,
    (size) => {
      const address = reserve(size);
      if (address < base + 96 && address + size > base) throw new Error(`${label}：启动桩分配重叠`);
      return address;
    },
    hash,
  );
  memory.write_memory(bytes, base);
  memory.write_memory([0xe9, ...le32(base - site - 5), 0x90, 0x90, 0x90, 0x90], site);
  return state;
}
