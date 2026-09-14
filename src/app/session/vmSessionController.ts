import type { SessionRuntime } from './runtime';
import type { GameVmCallbacks } from './runtimeEvents';

export interface VmSessionStartContext {
  isCurrent(): boolean;
}

export type VmSessionShellFactory<T extends SessionRuntime = SessionRuntime> = (
  context: VmSessionStartContext,
) => Promise<T>;

/**
 * 独立持有 VM shell 的异步生命周期，不依赖页面 DOM。
 * 新启动使旧的 create/start 结果失效；清理只等待已经获取的 shell。
 */
export class VmSessionController {
  private generation = 0;
  private activeShell: SessionRuntime | null = null;
  private readonly destroyPromises = new WeakMap<SessionRuntime, Promise<void>>();

  async start<T extends SessionRuntime>(factory: VmSessionShellFactory<T>): Promise<T | null> {
    const generation = ++this.generation;
    await this.destroyActive();
    if (!this.isCurrent(generation)) return null;

    let shell: T;
    try {
      shell = await factory({ isCurrent: () => this.isCurrent(generation) });
    } catch (error) {
      if (this.isCurrent(generation)) throw error;
      return null;
    }

    if (!this.isCurrent(generation)) {
      await this.destroyShell(shell);
      return null;
    }
    this.activeShell = shell;
    try {
      await shell.start();
    } catch (error) {
      const wasCurrent = this.isCurrent(generation);
      if (this.activeShell === shell) this.activeShell = null;
      // 清理前使回调失效，防止 stop/destroy 的状态覆盖原始启动错误。
      if (wasCurrent) ++this.generation;
      await this.destroyShell(shell);
      if (wasCurrent) throw error;
      return null;
    }
    if (!this.isCurrent(generation)) {
      if (this.activeShell === shell) this.activeShell = null;
      await this.destroyShell(shell);
      return null;
    }
    return shell;
  }

  async destroy(): Promise<void> {
    ++this.generation;
    await this.destroyActive();
  }

  isActive(shell: SessionRuntime): boolean {
    return this.activeShell === shell;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private async destroyActive(): Promise<void> {
    const shell = this.activeShell;
    this.activeShell = null;
    if (shell) await this.destroyShell(shell);
  }

  private destroyShell(shell: SessionRuntime): Promise<void> {
    const existing = this.destroyPromises.get(shell);
    if (existing) return existing;
    const promise = shell.destroy();
    this.destroyPromises.set(shell, promise);
    return promise;
  }
}

/** 丢弃已失效会话的回调，不在各页面重复实现代次判断。 */
export function guardVmCallbacks(callbacks: GameVmCallbacks, isCurrent: () => boolean): GameVmCallbacks {
  return {
    onNetworkStatus: (status) => {
      if (isCurrent()) callbacks.onNetworkStatus?.(status);
    },
    onStatus: (status) => {
      if (isCurrent()) callbacks.onStatus?.(status);
    },
    onCall: (call, ordinal) => {
      if (isCurrent()) callbacks.onCall?.(call, ordinal);
    },
    onCallBatch: (batch) => {
      if (isCurrent()) callbacks.onCallBatch?.(batch);
    },
    onBlocked: (call) => {
      if (isCurrent()) callbacks.onBlocked?.(call);
    },
    onFrame: (frame) => {
      if (isCurrent()) callbacks.onFrame?.(frame);
    },
    onLogicFrame: (count) => {
      if (isCurrent()) callbacks.onLogicFrame?.(count);
    },
    onShellPage: (title) => {
      if (isCurrent()) callbacks.onShellPage?.(title);
    },
  };
}
