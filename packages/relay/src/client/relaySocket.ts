/** 浏览器传输与 Worker 端口桥共用的消息连接契约。 */
export interface RelaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(frame: Uint8Array): void;
  /** 可选快路径：调用方交出独占帧，之后不得访问；端口桥可到微任务派发时再分离缓冲。
   * 禁止传入客体内存或共享缓存，也不能重复提交同一个缓冲。 */
  sendOwned?(frame: Uint8Array): void;
  close(code?: number, reason?: string): void;
}
