/**
 * GBK（cp936）编码：Win9x 中文环境窄字符串的代码页。
 * 浏览器没有 GBK 的 TextEncoder，这里用自带的 TextDecoder('gbk') 反查构建
 * 「字符 → 双字节」映射（约 2.4 万项，一次性约 1ms），零外部依赖。
 * ASCII 可打印字符映射为单字节自身；不可编码字符（emoji 等）返回 null。
 */
let reverseMap: Map<string, number[]> | null = null;
let reverseMapUnsupported = false;

function buildGbkReverseMap(): Map<string, number[]> {
  const bytes: number[] = [];
  // GBK 双字节区：lead 0x81–0xFE，trail 0x40–0x7E / 0x80–0xFE。
  // 每对之间插入 0x00（ASCII）重置解码状态机，整块解码一次再按分隔符回切，
  // 避免两万多次单独 decode 调用。区段内每个双字节序列恰好对应一个字符。
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      bytes.push(lead, trail, 0);
    }
  }
  const text = new TextDecoder('gbk').decode(Uint8Array.from(bytes));
  const map = new Map<string, number[]>();
  let pair = 0;
  for (const ch of text) {
    if (ch === '\x00') {
      pair++;
      continue;
    }
    if (ch === '�') continue; // 浏览器不识别该字节对的替换符，不建立映射
    const lead = 0x81 + Math.floor(pair / 190);
    const offset = pair % 190;
    const trail = offset + 0x40 + (offset >= 63 ? 1 : 0); // trail 跳过 0x7F
    if (!map.has(ch)) map.set(ch, [lead, trail]);
  }
  return map;
}

/** 返回字符的 GBK 字节序列；字符不可编码返回 null。 */
export function gbkBytesOf(char: string): number[] | null {
  const code = char.charCodeAt(0);
  if (code >= 0x20 && code <= 0x7e) return [code];
  if (reverseMapUnsupported) return null;
  if (!reverseMap) {
    try {
      reverseMap = buildGbkReverseMap();
    } catch {
      // 环境缺少 gbk 解码器（极老浏览器）：中文名不可用，英文名不受影响。
      reverseMapUnsupported = true;
      return null;
    }
  }
  return reverseMap.get(char) ?? null;
}
