# VM Worker 维护说明

## 当前实现

- `src/adapter/runtime.ts` 提供 VM 创建入口与主线程实现。
- `src/adapter/vmClient.ts` 管理主线程的 Worker 客户端；
  `vmWorker.ts` 为 Worker 入口，`vmWorkerController.ts` 管理其生命周期与消息处理。
- `src/adapter/vmCore.ts` 运行客体；`vmProtocol.ts` 定义跨线程协议。
- 主线程保留网页 UI、呈现与浏览器音频，Worker 执行 VM；
  能力探测与主线程回退由启动实现决定，不以浏览器名称硬编码支持承诺。
- 文件 provider 不直接克隆到 Worker。会话资源通过文件端口按需访问；
  主程序必须携带页面实际选中的独立副本，不能回退到不同的本地版本。
- 会话所有权归 `src/app/session/`，呈现调度归 `src/graphics/`；不在 Worker 层复制会话控制器。

## 维护与验证

协议变动必须同步两端处理、取消/销毁和待处理请求的失败结算；
不要在回退时遗留旧 Worker 或同时运行两个 VM。
帧 transfer 仅使用独立缓冲，不转移客体 WASM 内存。

运行 `pnpm run check`，按 [测试准入](TESTING.md) 追加浏览器与真实游戏测试。
`pnpm run test:browser:battle-start` 覆盖 RA2/YR 的 Worker 与主线程战场直达；
文件链路还需地图导入、分层资源和真实 ZIP 缓存刷新验收。
通过启动回归不意味着浏览器能力、存档恢复或整局游戏已全部验证。

架构以 [ARCHITECTURE.md](ARCHITECTURE.md) 为维护入口；本文件记录 Worker 实现、
回退边界和验证入口。
