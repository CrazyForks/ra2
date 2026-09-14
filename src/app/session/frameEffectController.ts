import type { VmFrame } from '../../vm86/win32';

export interface FrameEffect<Selection> {
  load(file: File, selection?: Selection): Promise<void>;
  frame(frame: VmFrame): VmFrame | null;
  readonly status: string;
  destroy(): void;
}
interface EffectOptions<Selection> {
  create(changed: () => void): Promise<FrameEffect<Selection>>;
  currentFrame(): VmFrame | null;
  isCurrent(): boolean;
  invalidate(): void;
  beforeLoad(): void;
  publish(status: string | null): void;
  now?(): number;
}

/** 会话级异步画面效果；具体模型和浏览器 Worker 由组装入口注入。
 * token 同时保护动态 import 和 load，停止之后晚到的实例必须释放。
 */
export class FrameEffectController<Selection> {
  private effect: FrameEffect<Selection> | null = null;
  private token = 0;
  private publishedAt = 0;
  private failure: string | null = null;
  constructor(private options: EffectOptions<Selection>) {}

  stop(clearFailure = false): void {
    ++this.token;
    this.effect?.destroy();
    this.effect = null;
    if (clearFailure) this.failure = null;
    this.options.invalidate();
  }
  async set(file: File | null, selection?: Selection): Promise<void> {
    this.stop(true);
    this.publishedAt = 0;
    const token = this.token;
    if (!file) return;
    const frame = this.options.currentFrame();
    if (!frame || !this.options.isCurrent() || frame.width > 800 || frame.height > 600) {
      this.failure = '整帧实验未启动：请先启动游戏并设置不超过 800×600 的分辨率';
      this.options.publish(this.failure);
      throw new Error(this.failure);
    }
    let instance: FrameEffect<Selection> | undefined;
    const current = () => token === this.token && this.options.isCurrent();
    try {
      instance = await this.options.create(() => {
        if (current()) this.options.invalidate();
      });
      if (!current()) {
        instance.destroy();
        return;
      }
      this.effect = instance;
      this.options.beforeLoad();
      await instance.load(file, selection);
      if (!current() && this.effect === instance) {
        instance.destroy();
        this.effect = null;
      }
    } catch (error) {
      // 已被 stop 接管的实例不重复销毁，也不覆盖新模型的状态。
      if (this.effect === instance) {
        instance?.destroy();
        this.effect = null;
      }
      if (!current()) return;
      this.failure = `整帧实验失败：${error instanceof Error ? error.message : String(error)}`;
      this.options.publish(this.failure);
      throw error;
    }
  }
  transform(frame: VmFrame): VmFrame | null {
    return this.effect?.frame(frame) ?? null;
  }
  publishStatus(fallback: string | null): void {
    if (!this.effect) {
      this.options.publish(this.failure ?? fallback);
      return;
    }
    const now = this.options.now?.() ?? performance.now();
    if (now - this.publishedAt >= 500) {
      this.publishedAt = now;
      this.options.publish(this.effect.status);
    }
  }
}
