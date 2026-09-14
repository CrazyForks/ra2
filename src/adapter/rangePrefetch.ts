import type { GameFileProvider } from '../resources/contracts';

/** 只预取一个后续页，最多 2 MiB；不把影片容器复制成整包，也不挂载迟到的页。 */
export class RangePrefetch {
  private generation = 0;
  private speculating = false;
  private next: {
    provider: GameFileProvider;
    path: string;
    offset: number;
    length: number;
    bytes: Promise<Uint8Array | null>;
  } | null = null;
  clear(): void {
    this.generation++;
    this.next = null;
  }
  async read(
    provider: GameFileProvider,
    path: string,
    offset: number,
    length: number,
    totalSize: number,
  ): Promise<Uint8Array | null> {
    const generation = this.generation;
    const pending = this.next;
    this.next = null;
    const hit =
      pending?.provider === provider && pending.path === path && pending.offset === offset && pending.length === length;
    const bytes = (hit ? await pending.bytes : null) ?? (await provider.readRange!(path, offset, length));
    // 预取失败不能提前使对局失败；真正读取时再走正常错误报告路径。
    const nextOffset = offset + length;
    if (!this.speculating && generation === this.generation && bytes?.length === length && nextOffset < totalSize) {
      const nextLength = Math.min(2 * 1024 * 1024, totalSize - nextOffset);
      // 跳读会弃用旧页，但底层 I/O 未必可取消；完成前不再启动其他投机读取。
      this.speculating = true;
      this.next = {
        provider,
        path,
        offset: nextOffset,
        length: nextLength,
        bytes: Promise.resolve()
          .then(() => provider.readRange!(path, nextOffset, nextLength))
          .catch(() => null)
          .finally(() => {
            this.speculating = false;
          }),
      };
    }
    return bytes;
  }
}
