/** 原生模拟计数，不是 DirectDraw/VBlank、rAF 或目标帧率。 */
export interface GameFrameCounters {
  frame: number;
  gameSpeed: number;
  sessionSpeed: number;
  requestedFps: number;
}
export type GameFrameReader = () => GameFrameCounters | null;
export interface GamePerformanceSample extends GameFrameCounters {
  sampledAtMs: number;
  intervalMs: number | null;
  logicFps: number | null;
  status: 'baseline' | 'sample' | 'reset' | 'inactive';
}
