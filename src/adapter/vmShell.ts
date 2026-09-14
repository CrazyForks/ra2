import type { SessionRuntime } from '../app/session/runtime';
import type { GamePerformanceSample } from '../games/performance';
import type { GuestMemRecordResult } from './memRecord';

/** 输入最终进入 shim 后的坐标与实际呈现面边界。 */
export interface VmPointerState {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 客体 GetClientRect 实际读到的主窗口客户区。 */
  clientWidth: number;
  clientHeight: number;
  /** 最近一次从浏览器注入的键盘消息，用于端到端确认 Esc 等保留键已进入客体。 */
  lastKeyMessage: number;
  lastKeyVirtualKey: number;
  lastMouseMessage: number;
  lastMouseHwnd: number;
  lastMouseControlId: number;
  lastMouseCallback: number;
  lastMouseDispatchHwnd: number;
  lastMouseDispatchControlId: number;
  lastMouseDispatchCallback: number;
  campaignHoverDispatches: number;
  /** 合成 WM_TIMER 的分派次数，用于判断客体是否仍在泵消息。 */
  wmTimerDispatches: number;
}

/** VM 外壳统一接口：主线程 Win32GameVm 与 worker 客户端 WorkerVmClient 都实现它。
 *  probe 类读取统一为 Promise 返回——主线程模式是同步直读的薄包装，
 *  worker 模式是 request/response RPC，页面层只面对一条异步路径。 */
export interface VmAttachResult {
  attached: string[];
  existing: string[];
}

export interface VmShell extends SessionRuntime {
  /** 只更新文件系统，不重启 VM，不刷新客体地图列表。 */
  attachMapFiles(files: ReadonlyMap<string, Uint8Array>): Promise<VmAttachResult>;
  stop(): Promise<void>;
  /** 等待客体已关闭文件产生的存档写入全部持久化。 */
  flushFiles(): Promise<void>;
  /** Win32 消息注入（WM_*）；wParam/lParam 语义见 Win32Shim.postMessage。 */
  postMessage(message: number, wParam?: number, lParam?: number): void;
  setKeyState(virtualKey: number, down: boolean): void;
  setCursorPosition(x: number, y: number): void;
  setGameClockRate(rate: number): number;
  setMasterVolume(linear: number): void;
  getPointerState(): Promise<VmPointerState | null>;
  /** 按需读取真实逻辑帧率；未支持、未加载时返回 null。 */
  getGamePerformance(): Promise<GamePerformanceSample | null>;
  /** 写入当前 RA2/YR 的游戏速度档位；返回客体实际写入值。 */
  setGameSpeedFlag(value: number): Promise<number | null>;
  /** 内存改动录制：快照当前客体 RAM 为基线；VM 未就绪时 false。 */
  startMemRecord(): Promise<boolean>;
  /** 结束录制并返回改动统计（修改次数降序 + 区段汇总）；未在录制中时 null。 */
  stopMemRecord(): Promise<GuestMemRecordResult | null>;
  /** 首次打开调试面板后启用调用热点和稀疏样本；默认只累计 HC 总数。 */
  setCallTracing(enabled: boolean): void;
}
