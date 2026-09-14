/** 小端 RGBA 查表；位复制与原有帧输出一致，避免 CPU/GPU 路径出现色差。 */
export const RGB565_TO_RGBA32 = new Uint32Array(0x10000);
for (let i = 0; i < 0x10000; i++) {
  const r = (i >>> 11) & 31,
    g = (i >>> 5) & 63,
    b = i & 31;
  RGB565_TO_RGBA32[i] =
    ((r << 3) | (r >>> 2) | (((g << 2) | (g >>> 4)) << 8) | (((b << 3) | (b >>> 2)) << 16) | 0xff00_0000) >>> 0;
}
