/** 会话只拥有启动与销毁；输入、调试和游戏控制能力由各自消费者使用。 */
export interface SessionRuntime {
  start(): Promise<void>;
  destroy(): Promise<void>;
}
