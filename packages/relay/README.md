# relay-package

独立的通用 WebSocket relay，包含 server、client、Worker 桥接和
[简短协议](RELAY_PROTOCOL.md)。一条 TCP 连接传控制和游戏数据，全部使用二进制帧；数据报头固定 13 字节。

## 启动与分发

relay 包不声明 Node 版本范围；源码开发使用 package.json 中的 pnpm 版本。
不保证所有 Node.js 版本兼容。在仓库根执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter relay-package run check
pnpm run build:relay
pnpm run server:relay
```

开发时使用 watch，服务端入口及其导入的源码改变后自动重启：

```bash
pnpm run server:relay:dev --host 127.0.0.1 --port 15176
# 在 relay 包目录内也可直接运行：
pnpm run dev --host 127.0.0.1 --port 15176
```

CLI 选项照常传递，例如 `--delay-ms 50`。重启会断开现有游戏连接，需要重新进入联机；
`server:relay` 和分发包启动命令仍为单次运行。

根 `build:relay` 或包内 `build` 生成 `packages/relay/dist/` 中的服务端、协议、许可和客户端库。
复制服务端 `gameRelay.cjs`、`RELAY_PROTOCOL.md`、`licenses/` 即可分发；
接收方只需 Node，无需安装依赖：

```bash
node gameRelay.cjs --host 0.0.0.0 --port 15176
```

红警页面的 `relay` 只需填写 `host:port`，默认路径 `/ra2`。按地址确定唯一协议：
RFC1918 私网、127/8 回环、169.254/16 链路本地、100.64/10 共享 VPN 地址，
以及 IPv6 ULA、链路本地、回环、内嵌私网 IPv4 使用 WS；localhost 也按回环处理。
其他 IP 和域名使用 WSS，不做 DNS 探测或失败回退。已有完整 URL 也按主机重新选择协议，
保留显式端口与房间路径。通用 RelayClient 对裸地址先尝试 WSS，失败后再尝试 WS。
所有玩家填写相同的地址与房间路径。只需放行 TCP 15176。

独立服务接受 `/房间名`，房间由服务端按路径确定；客户端不必再传 room。
房间名区分大小写，URL 解码后为 1–64 字符的单段，禁止空白、控制字符及 ? & # /。
路径直接作为房间名。
直接升级根路径被拒绝。公共客户端无路径时按 room 选项补路径，未指定则为 /default；
游戏前端的无路径地址补 /ra2。同名房间仍要求兼容性哈希一致。
内嵌网页服务保留自己的升级路由，不将任意网页或 HMR 路径改成 relay。

## 模拟游戏数据延迟

```bash
node gameRelay.cjs --port 15176 --delay-ms 50
# 仓库内：
pnpm run server:relay --port 15176 --delay-ms 50
```

`--delay-ms` 为 0–60000 整数，默认关闭。每次转发游戏数据报增加指定毫秒数，
玩家 A→B 增加 50ms，B→A 再增加 50ms，双向共增加约 100ms；不是单玩家到 relay RTT。
握手、成员通知与心跳不延迟，因此页面 RTT 不体现该注入。真实延迟还含调度和网络时间。
队列保序且有上限，连接退出会清理；极端积压可能丢弃数据，可通过 healthz faults 观察。
需要抖动或限定玩家时仍可使用 `--faults`；不能同时指定 `--delay-ms` 和 faults.delayMs。
这不模拟 TCP 丢包、重传、拥塞，也不证明低 RTT 无性能回退。
服务端不要求 HTTPS 证书；网页的安全上下文、混合内容与 LNA 权限仍受浏览器策略约束。
VPN 可保持开启，只需确保该 WS 地址可达，不集成特定 VPN。

## Docker

在仓库根运行：

```bash
docker compose -f packages/relay/compose.yaml up -d --build
docker compose -f packages/relay/compose.yaml logs -f relay
```

在本包目录运行：

```bash
docker build -t relay-package:local .
docker compose up -d --build
```

[Dockerfile](Dockerfile) 根据包内独立锁文件构建 `relay-package:local`，只安装 relay 依赖。
[compose.yaml](compose.yaml) 仅映射一个 TCP 端口；可编辑 `ports` 左侧修改宿主机端口。
运行镜像使用非 root 用户，包含服务、协议和依赖许可，不包含游戏、前端或构建工具。
基础镜像使用不固定 Node 版本的 `node:alpine`。镜像未发布到远端仓库。
构建上下文只使用 relay 目录，不需预先生成 dist 或安装仓库根依赖。

```bash
docker save -o relay-image.tar relay-package:local
# 接收方加载镜像，使用复制来的 compose.yaml，无需源码构建。
docker load -i relay-image.tar
docker compose -f compose.yaml up -d --no-build --pull never
```

## 引用

应用声明 `"relay-package": "workspace:*"`。公共入口以源码提供类型，以 `dist/lib` 提供 ESM；
应用 dev/build/test 自动构建包。浏览器入口不加载 Node 的 ws 依赖。

```ts
import { RelayClient } from 'relay-package/client';
const client = new RelayClient(
  {
    url: '127.0.0.1:15176/example',
    compatibilityHash: 'a'.repeat(64),
    metadata: new Uint8Array(),
  },
  {
    onReady(self) {
      console.log('已连接', self.addr);
    },
    onPeerJoin(peer) {
      console.log('成员加入', peer);
    },
    onDatagram(src, srcPort, destPort, bytes) {
      console.log(src, bytes);
    },
    onClose(reason) {
      console.log('连接关闭', reason);
    },
  },
);
// onReady 后发送：client.sendDatagram(destAddr, destPort, srcPort, bytes)。
// 会话结束：client.close()。
```

示例哈希仅演示用，实际由应用提供兼容性 SHA-256。RelayClient 自动处理握手、成员通知、心跳、RTT 和关闭清理；
ready 前发送返回 false，不缓存或重放，不自动重连。游戏转换由应用维护。
需要底层访问时仍可使用 WsRelaySocket 和编解码函数。`relay-package/server` 导出 createGameRelay，
`relay-package/wire` 提供编解码；默认入口等同 client。

Worker 可直接使用 WsRelaySocket，也可使用 PortRelaySocket；页面通过 serveRelayPort
持有连接，返回的清理函数必须随 VM 退出或 Worker 异常终止调用。普通发送立即复制逻辑字节，
不 transfer 客体内存。独占帧通过 sendOwned 接管后，调用方不得再访问，缓冲在派发时分离。
当前执行片段的帧在微任务交接，每批最多 64 条或达到 256 KiB 即派发；不等待计时器或下一游戏帧。
每批只回一个按字节计数的 ACK，每条仍独立 ws.send，并检查真实 WS 积压。
批处理不会合并不同 WS 事件任务，不能保证每条入站消息都能合批，也不减少编码次数。

源码与测试在 `src/` 和 `tests/`，构建在 `scripts/`。运行依赖只有 ws。
本包自带独立 pnpm-lock.yaml，可把整个目录复制到任意位置构建，不需要游戏仓库文件。
包内锁文件用于独立构建；在红警工作区更新依赖时，还需同步更新根锁文件。

## 如何取得地址

服务器实际 IP 与房间虚拟地址是两回事：

- 同机测试使用 `ws://127.0.0.1:15176/ra2`。
- LAN 玩家需要服务器所在电脑的局域网 IPv4。macOS 在系统设置的网络连接详情中查看
  TCP/IP 地址；Windows 用 `ipconfig` 查看当前网卡 IPv4；Linux 用 `ip -4 addr`。
  多网卡时选择玩家能到达的网卡地址；VPN 可用其可达地址，不必关闭 VPN。
- 服务默认使用 `--host 0.0.0.0` 接收远端连接；`0.0.0.0` 是监听地址，不能填写为连接目的地。
  容器部署填写宿主机可达 IP 和映射的 TCP 端口，通常不填容器内部 IP。
- 客户端连接后，`onReady(self)` 的 `self.addr` 或 `client.selfAddr` 是服务分配的虚拟地址。
  对方地址从 `onPeerJoin(peer)` 的 `peer.addr` 获取，离开时由 `onPeerLeave(id, addr)` 通知。
  不需要发现对方的实际 IP，发送时直接把 `peer.addr` 传给 `sendDatagram`。

虚拟地址为大端 IPv4 的无符号整数，显示格式可以这样转换：

```ts
const formatAddress = (addr: number) => [24, 16, 8, 0].map((shift) => (addr >>> shift) & 255).join('.');
```

## 独立测试

`pnpm --filter relay-package run check` 检查类型、协议、服务、客户端和独立服务端分发。
测试不依赖 RA2、游戏素材、外部 relay 或公网；真实 WS 测试监听本机随机端口。
覆盖二进制固定向量、非法帧、字段边界、握手与兼容性隔离、源地址覆写、广播、限流、
慢连接、维护排空、退出取消延迟消息，以及客户端双向通信和生命周期。
这些是协议与服务可靠性检查，不代表真实游戏长局或断线恢复已验收。

Worker 桥接、独占帧移交、端口 ACK、普通发送复制和真实 WS 积压由
`packages/relay/tests/relayPort.test.ts` 等测试覆盖。

启动日志显示「请在游戏中输入 relay：IP:端口」，可复制到游戏资源选择页的「联机 relay 地址」输入框，
或放入页面 `relay` 查询参数。服务不会自动修改游戏或浏览器配置；输入留空使用默认服务。
界面填写会更新当前页面 URL，刷新仍保留；启动后需结束当前 VM 再修改连接配置。

独立服务仅使用 CLI 配置，不读取环境变量：

```bash
node gameRelay.cjs --help
node gameRelay.cjs --host 127.0.0.1 --port 15178 --max-connections 128
node gameRelay.cjs --faults '{"delayMs":100}'
```

Docker 的 `command` 可传同样参数；更改容器内端口时同步修改端口映射及 healthcheck。
通常只改宿主机映射端口即可，容器内保持 15176。

主页默认单机。勾选「联机」后显示 relay 地址设置；留空连接同源默认服务。
带 `relay` 的链接自动勾选联机，显式 `network=0` 关闭联机。

## 许可证

本包采用 GPL-3.0-or-later，见 [LICENSE](LICENSE)。ws 等第三方组件保留自己的许可证。
分发服务端时同时保留 LICENSE、协议和 licenses/ 目录；对应源码为本包源码与构建脚本。
