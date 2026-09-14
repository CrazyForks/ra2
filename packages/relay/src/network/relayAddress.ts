import { isRelayRoomId } from './relayWire';

/** 每个单段路径都是房间；没有保留的游戏路径或旧入口。 */
export function relayRoomFromPath(path: string): string {
  let room: string;
  try {
    room = decodeURIComponent(path.slice(1));
  } catch {
    throw new Error('relay 房间路径编码无效');
  }
  if (!path.startsWith('/') || !isRelayRoomId(room) || ['.', '..'].includes(room) || /[\u0000-\u001f\u007f]/.test(room))
    throw new Error('relay 房间路径必须是 1–64 字符的单段房间名');
  return room;
}

/** 保留省略协议这一选择，供客户端在建立连接前探测；不依赖页面协议。 */
export function normalizeRelayAddress(value: string, defaultRoom = 'default'): string {
  const input = value.trim();
  const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  if (!input || /\s|\\/.test(input) || input.startsWith('/')) throw new Error('relay 必须包含主机地址');
  const authorityAndPath = (explicit ? input.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') : input).split(/[?#]/, 1)[0]!;
  const slash = authorityAndPath.indexOf('/');
  // 在 URL 规范化点段前校验，避免 /a/../b 悄悄变成另一个房间。
  if (slash >= 0 && authorityAndPath.slice(slash) !== '/') relayRoomFromPath(authorityAndPath.slice(slash));
  let url: URL;
  try {
    url = new URL(explicit ? input : `ws://${input}`);
  } catch {
    throw new Error('relay 必须是有效的主机地址或 WS/WSS 地址');
  }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('relay 必须是无用户名、密码和片段的 WS/WSS 地址');
  }
  if (url.pathname === '/') url.pathname = '/' + encodeURIComponent(defaultRoom);
  relayRoomFromPath(url.pathname);
  if (explicit) return url.href;
  // URL 会省略 WS 的默认 80 端口；探测 WSS 时仍必须使用调用方指定的 80。
  const authority = input.split(/[/?#]/, 1)[0]!;
  return (
    url.hostname + (url.port ? ':' + url.port : authority.endsWith(':80') ? ':80' : '') + url.pathname + url.search
  );
}

export function relayAddressCandidates(value: string, defaultRoom = 'default'): string[] {
  const normalized = normalizeRelayAddress(value, defaultRoom);
  if (/^wss?:\/\//.test(normalized)) return [normalized];
  return [`wss://${normalized}`, `ws://${normalized}`];
}
