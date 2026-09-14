import type { GuestMemory } from '../../vm86/win32';
import { le32 } from './bytes';

/** 页面直达跳板的版本参数：固定地址、指令签名与初始寄存器都属于具体游戏。 */
export interface StartupTrampolineSpec {
  /** 错误信息里的人读标签（游戏与页面），不参与代码生成。 */
  readonly label: string;
  /** 覆盖点所在 EXE 的 SHA-256；不符即拒绝安装。 */
  readonly expectedHash: string;
  readonly site: number;
  /** 覆盖点原始指令的前几字节，用于确认版本并防止重复安装。 */
  readonly signature: readonly number[];
  /** `mov reg, imm32` 的 ModRM 字节，即原生状态所用的寄存器。 */
  readonly movOperand: number;
  /** 桩里写入的初始状态：遭遇战 11，LAN 3。 */
  readonly target: 3 | 11;
}

/**
 * 把菜单状态选择重定向到自建桩：桩把状态常量写进自己的存储，再用被覆盖指令的
 * 前几字节回到原地。只替换初始状态选择，保留设置页的原生初始化、消息泵与
 * 返回路径；需在首次执行前安装，桩由调用方从静态导入桩尾独占分配。
 */
export function installStartupTrampoline(
  memory: GuestMemory,
  reserve: (size: number) => number,
  hash: string,
  spec: StartupTrampolineSpec,
): number {
  const { label, site, signature, movOperand, target } = spec;
  if (hash !== spec.expectedHash) throw new Error(`${label}：EXE 哈希不匹配`);
  const current = memory.read_memory(site, signature.length);
  if (current.length !== signature.length || !current.every((byte, index) => byte === signature[index])) {
    throw new Error(`${label}：EXE 指令签名不匹配或重复安装`);
  }
  const base = reserve(48);
  if (!Number.isInteger(base) || base % 16 || base < 0x80000 || base + 48 > 0xc0000) {
    throw new Error(`${label}：启动桩分配越界`);
  }
  const storage = memory.read_memory(base, 48);
  if (storage.length !== 48 || storage.some((byte) => byte !== 0)) throw new Error(`${label}：启动桩已占用`);
  const state = base + 32;
  // MOV 不改变标志/栈，也无需调用宿主；消费后恢复默认状态18，后续回主菜单不重定向。
  const code = [0x8b, movOperand, ...le32(state), 0xc7, 0x05, ...le32(state), ...le32(18)];
  code.push(0xe9, ...le32(site + 5 - (base + code.length + 5)));
  const bytes = new Uint8Array(48);
  bytes.set(code);
  bytes.set(le32(target), 32);
  memory.write_memory(bytes, base);
  memory.write_memory(new Uint8Array([0xe9, ...le32(base - site - 5)]), site);
  return state;
}
