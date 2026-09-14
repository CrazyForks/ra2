/**
 * 串行执行异步任务；事件按顺序触发并不代表其异步处理会按顺序完成。
 * 后一项只在前一项完全结束后执行；单项失败会报告错误，不会毒化整条队列。
 */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly onError: (error: unknown) => void) {}

  enqueue(task: () => void | Promise<void>): Promise<void> {
    const run = this.tail.then(task);
    this.tail = run.catch((error) => this.onError(error));
    return run;
  }
}
