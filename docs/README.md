# 文档索引

这里的维护文档描述当前代码、脚本和测试边界；命令与版本以 `package.json`、根
`pnpm-lock.yaml`、`packages/relay/pnpm-lock.yaml` 和实际 workflow 为准。

## 当前维护入口

| 主题                                 | 入口                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| 贡献与许可证                         | [贡献指南](../CONTRIBUTING.md)、[第三方说明](THIRD_PARTY.md)                    |
| 仓库协作规则                         | [AGENTS.md](../AGENTS.md)                                                       |
| 开发与玩家功能                       | [项目 README](../README.md)                                                     |
| 架构约束、模块边界与依赖准入         | [架构要求](ARCHITECTURE_REQUIREMENTS.md)、[实现设计](ARCHITECTURE.md)           |
| 原生逻辑 FPS 与性能测试              | [游戏性能测量](GAME_PERFORMANCE.md)、[资源与呈现性能](PERFORMANCE_RESOURCES.md) |
| 开发工具                             | [脚本目录](../scripts/README.md)                                                |
| 历史资源裁剪依据                     | [资源证据](RESOURCE_PACKAGE_EVIDENCE.md)                                        |
| 测试选择与合入门槛                   | [测试准入](TESTING.md)                                                          |
| 私有素材、可信 runner 与真实对局回归 | [真实游戏 CI](REAL_GAME_CI.md)                                                  |
| React / 页面布局                     | [React 边界](REACT_UI.md)、[UI 目录](../src/ui/README.md)                       |
| VM Worker 与主线程回退               | [Worker 现状](WORKER.md)                                                        |
| 自建 relay、独立分发与通用线协议     | [Relay 协议](../packages/relay/RELAY_PROTOCOL.md)                               |
| WebSocket 联机、弱网与公开对局限制   | [联机稳定性](RA2_NETWORK_RELIABILITY.md)                                        |
| 启动参数与页面/战场 hook             | [启动说明](RA2_COMMAND_LINE_AND_SPAWNER.md)                                     |
| 超分模式、实验模型与测量限制         | [超分](AI_UPSCALING.md)                                                         |
| ReShade 效果与适配边界               | [ReShade 适配](RESHADE_ADAPTATION.md)                                           |

固定地址、版本哈希和指令签名以 `src/games/` 中的 profile、hook 及其测试为准；
维护文档只记录用途、边界和复核入口，不保存一次性终端日志、机器路径或旧交接状态。
