# RA2 VM

在浏览器中直接运行《红色警戒 2》和《尤里的复仇》的原版 x86 程序。
项目基于 v86、自定义固件和 Win32/DirectX 兼容层，不启动 Windows。

当前为 Alpha：支持本地资源导入、RA2/YR 选择、遭遇战入口、存档、地图包和自建
WebSocket relay 联机。双人短局回归不代表所有战役、MOD、多人大规模交战或公网长局兼容。

## 运行与开发

内部开发在 `dev` 分支进行，不推送 GitHub；外部贡献请向 `main` 提交 PR。
使用 Node.js 和 `package.json` 指定的 pnpm，不对 Node 设置版本范围限制。

```bash
pnpm install --frozen-lockfile
pnpm run dev
```

打开终端给出的 HTTPS 地址，选择本地游戏文件夹或压缩包。应用先检查资源：
只有一个完整版本时自动启动，同时包含 RA2/YR 时再选择游戏。运行时所需精确 EXE
由游戏清单指定，开发环境可用 `pnpm run prepare:hosted` 准备本地缓存；该命令会联网下载。
游戏程序与资源不包含在本仓库中，公共测试不需要它们。

```bash
pnpm run check          # 类型、无素材单元/合成 VM 测试、生产构建
pnpm run build          # 静态页面输出到 dist/
pnpm run preview        # 预览构建结果
```

开发者自备的完整资源可放在被忽略的 `game/ra2/`，详见 [测试指南](docs/TESTING.md)。
首次使用 pnpm 的安装方式和可用 Node 环境由开发环境提供；CI 输出实际工具链版本。

## 自建联机

主页勾选「联机」，填写服务器的 `host:port`，或留空使用同源 relay。
内网 IP 使用 WS，公网 IP 和域名使用 WSS；浏览器对 HTTPS 页面连接私网 WS 的限制
仍适用。双方需要一致的游戏版本、MOD 和地图。

```bash
pnpm run server:relay --help
pnpm run server:relay --host 0.0.0.0 --port 15176
pnpm run server:relay:dev   # watch 模式，重启会断开现有连接
```

页面也可使用 `?relay=127.0.0.1:15176/friends`；路径是房间名，省略时使用 `/ra2`。
独立包包含 server、client、Dockerfile 与 Compose；静态页面构建不包含 relay。

```bash
pnpm run build:relay
node packages/relay/dist/gameRelay.cjs --host 0.0.0.0 --port 15176
```

详见 [relay 部署](packages/relay/README.md) 和 [协议](packages/relay/RELAY_PROTOCOL.md)。
当前不支持断线续局；连接丢失后需重新开局。

## 文档与贡献

- [架构设计](docs/ARCHITECTURE.md)：模块边界、数据流与所有权。
- [贡献指南](CONTRIBUTING.md)：开发、验证和 PR 要求。
- [测试与 CI](docs/TESTING.md)：无素材准入和真实游戏测试。
- [CI 资源配置](docs/REAL_GAME_CI.md)：下载地址 secret、哈希与 runner 隔离。
- [游戏性能](docs/GAME_PERFORMANCE.md)：真实逻辑 FPS 和联机测量。
- [文档索引](docs/README.md)：资源、界面、Worker、启动与超分专题。

## 许可证

项目原创代码采用 **GPL-3.0-or-later**，见 [LICENSE](LICENSE)。你可以按照 GPL 第 3 版
或任何后续版本的条款使用、修改和分发这些代码；软件不提供任何担保。
第三方代码、依赖和游戏素材保留各自许可，不因仓库许可证改变归属。
来源和适用边界见 [第三方说明](docs/THIRD_PARTY.md)。
