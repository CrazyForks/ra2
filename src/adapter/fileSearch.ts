import type { GameFileProvider } from '../resources/contracts';
import { guestFileSearch, type GuestFileEntry } from '../vm86/shim/fileSearch';

/** 在同步 FindFirstFileA 暂停点取得匹配项；MIX 内容仍由后续 CreateFile 按需加载。 */
export async function readGuestFileSearch(files: GameFileProvider, pattern: string): Promise<GuestFileEntry[]> {
  const search = guestFileSearch(pattern);
  const entries: GuestFileEntry[] = [];
  for (const name of (await files.list(search.directory)) ?? []) {
    if (!search.matches(name)) continue;
    const path = search.directory ? `${search.directory}/${name}` : name;
    // 只要长度，不复制数百 MB 的资源；所有内置 provider 均支持前缀读取。
    const info = files.readPrefix ? await files.readPrefix(path, 1) : null;
    const data = !files.readPrefix ? await files.read(path) : null;
    if (info || data) entries.push({ path, size: info?.totalSize ?? data!.length });
    else if ((await files.list(path))?.length) entries.push({ path, size: 0, directory: true });
  }
  return entries;
}
