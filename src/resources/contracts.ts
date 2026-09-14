export interface GameFileProvider {
  readonly label: string;
  /** 失效动态目录/持久化索引；不影响当前 Provider 的写入快照。 */
  invalidateCache?(): void;
  /** 已有目录索引可同步判定时返回 true/false；尚未索引返回 null。
   *  VM 用 false 跳过确定不存在的静态素材，避免每次 CreateFile 都 await。 */
  hasKnownFile?(path: string): boolean | null;
  /** 内存来源（ZIP 解压）内目录结构不固定：发现流程递归枚举所有子目录。
   *  目录后端逐目录枚举太贵，只有显式开启的来源才展开。 */
  deepDiscovery?: boolean;
  read(path: string): Promise<Uint8Array | null>;
  /** 读取文件前缀并报告完整逻辑长度；超大容器可避免整包进入 JS heap。 */
  readPrefix?(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; totalSize: number } | null>;
  /** 读取大文件的指定区间；用于稀疏 MIX 在播放其中影片时按需补页。 */
  readRange?(path: string, offset: number, length: number): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  flush(): Promise<void>;
  /** 列出某个目录的直接子项名（保留原始大小写）；空串表示根目录。不支持时返回 null。 */
  list(directory: string): Promise<string[] | null>;
}

/** 执行方只消费策略，不拥有游戏规则；来源类型由组装方指定。 */
export interface ResourcePolicy<Source> {
  prepareSource(source: Source): Promise<Source>;
  isSessionStatic(normalizedPath: string): boolean;
  preloadFallbackUrl(path: string): string | undefined;
}
