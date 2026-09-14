/** 只收回页面已替换的独立帧，绝不接收客体 WASM 内存。限制数量与尺寸，避免分辨率切换积压。 */
export class FrameBufferPool {
  private buffers: ArrayBuffer[] = [];
  release(buffer: ArrayBuffer): void {
    if (!buffer.byteLength || buffer.byteLength > 16 * 1024 * 1024) return;
    if (this.buffers.includes(buffer)) return;
    this.buffers.push(buffer);
    if (this.buffers.length > 2) this.buffers.shift();
  }
  take(size: number): ArrayBuffer {
    const index = this.buffers.findIndex((buffer) => buffer.byteLength === size);
    return index >= 0 ? this.buffers.splice(index, 1)[0]! : new ArrayBuffer(size);
  }
  clear(): void {
    this.buffers = [];
  }
}
