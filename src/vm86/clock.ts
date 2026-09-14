const MIN_RATE = 0.25;
const MAX_RATE = 8;

/**
 * 连续的客体时钟。倍率改变时先把旧倍率累计到锚点，因此客体时间不会
 * 倒退或突然跳跃；Win32 timer deadline 可以始终保存在客体毫秒域中。
 */
export class ScaledClock {
  private rate = 1;
  private hostAnchor: number;
  private guestAnchor = 0;
  private readonly wallAnchor: number;
  private readonly readHostTime: () => number;

  constructor(readHostTime?: () => number, readWallTime?: () => number) {
    this.readHostTime = readHostTime ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()));
    this.hostAnchor = this.readHostTime();
    // 显式测试时钟沿用同一纪元；生产默认用 Date.now 提供真实墙钟。
    this.wallAnchor = (readWallTime ?? (readHostTime ? this.readHostTime : Date.now))();
  }

  now(): number {
    const hostNow = this.readHostTime();
    return this.guestAnchor + (hostNow - this.hostAnchor) * this.rate;
  }

  getRate(): number {
    return this.rate;
  }

  /** 当前客体墙钟时间；日期、SYSTEMTIME、FILETIME 使用，运行计时器不得使用。 */
  wallNow(): number {
    return this.wallAnchor + this.now();
  }

  setRate(requested: number): number {
    const next = normalizeGameClockRate(requested);
    const hostNow = this.readHostTime();
    this.guestAnchor += (hostNow - this.hostAnchor) * this.rate;
    this.hostAnchor = hostNow;
    this.rate = next;
    return next;
  }

  /** 将客体毫秒间隔换算为浏览器实际需要等待的毫秒。 */
  toHostDelay(guestMilliseconds: number): number {
    if (!Number.isFinite(guestMilliseconds) || guestMilliseconds <= 0) return 0;
    return guestMilliseconds / this.rate;
  }

  /** 将宿主实际等待间隔换回客体毫秒域，用于客体 deadline。 */
  toGuestDelay(hostMilliseconds: number): number {
    if (!Number.isFinite(hostMilliseconds) || hostMilliseconds <= 0) return 0;
    return hostMilliseconds * this.rate;
  }
}

export function normalizeGameClockRate(requested: number): number {
  if (!Number.isFinite(requested)) return 1;
  return Math.max(MIN_RATE, Math.min(MAX_RATE, requested));
}
