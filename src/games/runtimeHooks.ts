import type { GameFrameReader } from './performance';
import type { GuestMemory } from '../vm86/win32';

/**
 * VM 核心可调用的游戏运行态扩展。
 * 固定地址和游戏语义留在具体游戏目录，adapter 只面对这组可选能力。
 */
export interface GameRuntimeHooks {
  /** 显式性能采样时创建只读原生帧计数器；无支持版本时返回 null。 */
  createFrameReader?(memory: GuestMemory, hash: string): GameFrameReader | null;
  /** PE 映像复制进客体内存后、入口执行前应用该版本的窄范围兼容补丁。 */
  prepareImage?(memory: GuestMemory): void;
  /** 显式启动导航；具体游戏检查目标和 EXE，分配器独占静态导入桩尾。 */
  prepareStartupPage?(memory: GuestMemory, page: string, hash: string, reserve: (size: number) => number): void;
  writeGameSpeedFlag?(memory: GuestMemory, value: number): number | null;
  /** 宿主输入进入客体消息队列前修复该游戏已确认的易损运行态。 */
  beforeHostMessage?(memory: GuestMemory, message: number): void;
  crashHint?(vector: number, eip: number): string;
}
