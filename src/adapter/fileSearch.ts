import type { GameFileProvider } from '../resources/contracts';
import { guestFileSearch, type GuestFileEntry } from '../vm86/shim/fileSearch';

/** Obtain matches at the synchronous FindFirstFileA suspension point; subsequent CreateFile calls still load MIX content on demand. */
export async function readGuestFileSearch(files: GameFileProvider, pattern: string): Promise<GuestFileEntry[]> {
  const search = guestFileSearch(pattern);
  const entries: GuestFileEntry[] = [];
  for (const name of (await files.list(search.directory)) ?? []) {
    if (!search.matches(name)) continue;
    const path = search.directory ? `${search.directory}/${name}` : name;
    // Only the length is needed; avoid copying hundreds of MB of assets. All built-in providers support prefix reads.
    const info = files.readPrefix ? await files.readPrefix(path, 1) : null;
    const data = !files.readPrefix ? await files.read(path) : null;
    if (info || data) entries.push({ path, size: info?.totalSize ?? data!.length });
    else if ((await files.list(path))?.length) entries.push({ path, size: 0, directory: true });
  }
  return entries;
}
