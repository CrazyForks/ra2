import type { VmFrame, Win32Call, VmNetworkStatus } from '../../vm86/win32';

export type VmPhase = 'loading' | 'ready' | 'running' | 'blocked' | 'exited' | 'stopped' | 'error';

export interface VmStatus {
  phase: VmPhase;
  detail: string;
}

export interface VmCallBatch {
  /** 批次结束时的全局调用序号。 */
  ordinal: number;
  /** 本批次调用数（用于 HC/s，不逐次跨线程发消息）。 */
  delta: number;
  /** 本批次 DirectDraw 帧边界数，不等同于原生模拟帧。 */
  logicFrames: number;
  /** 本批次按 API 聚合的调用数。 */
  histogram: Array<[key: string, count: number]>;
  /** 调试日志沿用“前 200 次 + 每 256 次”的稀疏样本。 */
  samples: Array<{ call: Win32Call; ordinal: number }>;
}

export interface GameVmCallbacks {
  onNetworkStatus?: (status: VmNetworkStatus) => void;
  onStatus?: (status: VmStatus) => void;
  onCall?: (call: Win32Call, ordinal: number) => void;
  /** Worker 路径每 500ms 聚合回传；主线程回退路径继续使用 onCall。 */
  onCallBatch?: (batch: VmCallBatch) => void;
  onBlocked?: (call: Win32Call) => void;
  onFrame?: (frame: VmFrame) => void;
  /** DirectDraw 帧边界：主线程 count 为 1，Worker 每 500ms 批量回传；原生逻辑帧另用 getGamePerformance。 */
  onLogicFrame?: (count: number) => void;
  /** RA2/YR shell 页面标题变化（如 GUI:MainMenu/CampaignMenu），供 UI 诊断与浏览器回归。 */
  onShellPage?: (title: string) => void;
}
