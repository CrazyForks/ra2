import { normalizeGuestPath } from '../paths';

/** 目录元数据不等于已挂载内容；发现 MIX 时不能为枚举预读整个影片包。 */
export interface GuestFileEntry {
  path: string;
  size: number;
  directory?: boolean;
}

export function guestFileSearch(pattern: string) {
  const normalized = normalizeGuestPath(pattern);
  const slash = normalized.lastIndexOf('/');
  const directory = slash < 0 ? '' : normalized.slice(0, slash);
  const name = normalized.slice(slash + 1);
  // Win32 的 *.* 也匹配无扩展名文件；通配符只作用于当前目录的文件名。
  const wildcard = name === '*.*' ? '*' : name;
  const regex = new RegExp(
    `^${wildcard
      .split('')
      .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')))
      .join('')}$`,
    'i',
  );
  return { normalized, directory, matches: (entry: string) => !/[\\/]/.test(entry) && regex.test(entry) };
}
