# WebSocket 联机与弱网测试

当前版本保留 RA2/YR 原生 IPX 数据报同步，通过 WebSocket 中继传输。
现有服务端故障注入，不代表已经实现短断线续局或完成弱网长局验收。

单玩家弱网的验收目标是：短时故障允许同步等待，但恢复后双方必须能执行新命令；
慢连接不得堵塞其他连接的中继路由。此目标不表示慢玩家存在时其他玩家逻辑仍能
无等待推进，也不等同于保证无限期掉线后续局。

## 启动

开发服务器自带 `/ra2`；默认没有故障注入。需要弱网时重启服务：

```bash
RA2_NET_FAULTS='{"seed":42,"room":"ra2","delayMs":50,"jitterMs":20}' pnpm run dev
```

用户仍从默认页面进入游戏，无需客户端 URL 参数。上例对选中房间每次中继转发
增加约 50 ms 延迟和 ±20 ms 抖动；往返经过两次转发，并非固定 50 ms RTT。
同一接收端保持先后顺序，因此实际排队延迟可能高于配置值。

独立服务（不提供静态页面）：

```bash
pnpm run server:relay --port 15176
```

默认监听 0.0.0.0。玩家可以独立部署 relay；入口为
`pnpm run server:relay`，页面使用
`?relay=127.0.0.1:15176` 指定地址，默认路径 /ra2（远端玩家替换为可达地址）。
红警按主机选择协议：内网 IP 使用 WS，公网 IP 和域名使用 WSS，不进行失败回退。
默认房间路径为 `/ra2`，自定义 URL 路径作为房间。独立服务支持 `--delay-ms 50` 为每次游戏数据报转发增加 50ms；
不延迟心跳，页面 RTT 不体现注入，也不是完整 TCP 弱网模拟。
独立服务使用 WebSocket 帧协议，配置通过 CLI 选项提供。`pnpm run build:relay` 生成可独立分发的
服务端文件，或使用 relay 包内 Dockerfile 构建镜像；运行只需 Node，不安装整个项目。详见 [部署与协议](../packages/relay/RELAY_PROTOCOL.md)。

relay 的控制与游戏数据共用一条 WS/TCP 连接，支持无证书的明文 WS；HTTPS 页访问局域网 WS 仍受浏览器混合内容和
本地网络权限策略限制。LNA 拒绝后的连接行为仍未完成验证。
同源部署可由反向代理提供 TLS；纯静态 dist 不包含 relay，但可以连接玩家自建服务。
独立服务 `/healthz` 返回路由／丢弃及故障队列统计，建议仅管理网访问。
此入口尚无用户认证，不应当作完整生产对战平台直接开放。

### 维护与连接保护

独立服务 `--max-connections` 默认 2048，包含尚未 hello 的连接；超过上限只拒绝
新连接，不踢旧连接。每个虚拟 LAN 上限为 20 人，原生单场对局仍最多
8 人；目前公共大厅与虚拟 LAN 尚未拆分。20 连接广播互通及第 21 人拒绝有中继
回归覆盖，不代表 20 个真实游戏客户端大厅已验收。此上限是内存资源保护，
不是鉴权，也不代表容量已压测到 2048 人。

Linux 独立服务维护流程：给 **Node 服务进程** 发送 SIGUSR2，停止接纳新连接和
尚未完成 hello 的新玩家，已有房间继续转发；观察 `/healthz` 的 `draining`、
`connections`、`rooms`、`players`，等 connections=0 后再 SIGTERM。SIGTERM
仍是停止服务，不会自动等整场对局结束；不要用进程管理器自动重启替代排空。
没有暴露公开 HTTP 管理端点；身份认证和管理面尚未提供。

### 玩家可见状态

RA2/YR Worker 和主线程回退共用 `onNetworkStatus`，页面显示连接中、已连接、
其他 LAN 成员数、中继 RTT 和断线原因。RTT 是浏览器到中继的应用层往返时间，
包括任务调度，不是对手延迟；成员数不是当前对局玩家数。状态指示不表示游戏已同步。
每次 WS 连接/welcome 握手默认限时 10 秒；已建立连接的探测迟到不用于踢人。
正常离开只显示已关闭，异常断开提示当前不支持断线续局。旧 VM 的迟到状态被
页面生命周期过滤，退出清理 UI 和网络定时器；room-close 会关闭传输，握手前数据报不得进入客体。

### 公开对局限制

- 身份认证／签名入场凭据：未提供；当前不以 clientId 或随机名作为身份凭据。
- 大厅与对局拆分、规则/MOD/地图有效内容指纹：尚未实现；当前只比较 EXE。
- 真正断线恢复：需要稳定身份、交付序号和恢复窗口；当前不自动重连或补发历史命令。
- 8 人真实长局、真实 TCP 弱网、失步 CRC、反作弊及可信赛果：未验收。

## 故障配置

`RA2_NET_FAULTS` 是 dev/preview 的服务端 JSON；独立服务改用 `--faults` CLI 选项。非法配置拒绝启动。
启动日志明确显示启用状态；客户端不能设置规则。
服务端代码也可用 `relay.setFaults(config)` 在战场开始后切换规则，传 undefined
关闭。仅允许在待发队列排空时切换，避免旧包被提前放行、丢弃或与新包乱序；
每次切换重置该轮故障统计／黑洞计时，累计路由统计不重置。不暴露 HTTP 管理接口。

| 字段                          | 含义／默认值                                            |
| ----------------------------- | ------------------------------------------------------- |
| `seed`                        | uint32 随机种子，默认 1；相同有序输入得到相同随机决定   |
| `room`                        | 仅影响指定房间，省略为全部                              |
| `fromClientId` / `toClientId` | 精确匹配发送／接收端 ID，可配置单向故障；不是游戏显示名 |
| `delayMs` / `jitterMs`        | 每次出站转发的延迟与均匀 ±抖动，默认 0                  |
| `lossRate`                    | 应用数据报丢弃概率，0–1，默认 0；广播按接收端分别决定   |
| `blackholeMs`                 | 从故障模块创建开始，丢弃匹配数据报的持续时间，默认 0    |
| `bytesPerSecond`              | 每个接收端选中流量的带宽上限，含线协议头；默认不限      |
| `maxQueuedPackets`            | 故障模块全局待发包数上限，默认 1024                     |
| `maxQueuedBytes`              | 故障模块全局待发字节上限，默认 4 MiB                    |

例如单向丢包（客户端 ID 可在浏览器 WS URL 的 clientId 字段查看）：

```bash
RA2_NET_FAULTS='{"seed":42,"fromClientId":"实际客户端ID","lossRate":0.03}' pnpm run dev
```

握手、成员通知和心跳不受影响。匹配数据报受原 relay 限流后再进入故障模块；
队列满或预计等待超过 300 秒则丢弃并计数。连接退出或服务关闭取消待发消息，
不允许旧地址复用后把旧包送给新玩家。`datagramsRouted` 只在实际调用出站发送
成功时增加，不把进入延迟队列当作送达，更不表示客体已消费。

固定种子只保证相同输入顺序下随机决定一致；并发连接的到达顺序、真实计时和
游戏执行仍有变化，不能宣称整个真实对局逐次确定性复现。

## 测试与边界

```bash
pnpm exec vitest run packages/relay/tests/relayFaults.test.ts packages/relay/tests/gameRelay.test.ts tests/basic/ra2NetworkTransport.test.ts packages/relay/tests/relayWire.test.ts tests/basic/ra2PeerDiscovery.test.ts tests/basic/ra2Winsock.test.ts
```

覆盖配置校验、固定种子、方向隔离、延迟保序、带宽、黑洞恢复、包／字节上限、
连接退出清理和真实 WS 握手／单向丢弃。测试不依赖版权资源，纳入 `pnpm run check`。

此模块模拟的是 **数据报转发层故障**。丢弃已经到达 relay 的数据报不同于 TCP
底层丢包：后者会重传并产生队头阻塞。真实 TCP 弱网仍需在隔离网络 namespace／
专用代理上用 netem 等注入，不能用 `lossRate` 的游戏结果代替 TCP 丢包结论。
心跳保持正常意味着本模块也不验证真实半开连接检测。

公开对局的最低验证范围包括真实 RA2/YR 双端正常开局、延迟／抖动／丢包／限速、
真实 TCP 弱网、后台标签页和长局测试，并记录双方继续执行新命令的结果。
transport 断线仍结束连接，无 ACK／恢复窗口；故障测试发现游戏退出或停顿时必须记录，
不能靠无限缓存或假报“重连成功”掩盖。

## 真实游戏单玩家故障回归

```bash
RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 RA2_BROWSER_FAULT_SCENARIO=jitter pnpm run test:browser:network
```

可选场景：`jitter`（100 ms ±80 ms）、`stall500`（每次转发延迟 500 ms）、
`loss`（3% 应用数据报丢弃）、`blackhole2000` / `blackhole5000`（2/5 秒完全丢弃）。
测试从默认页面进入真实 RA2，只有连接目的地重定向到测试专属 WebSocket 中继，
只读 Worker 探针观察双方 House 状态，不替换 EXE、不写游戏内存。依赖 dev 服务、
其已生成的 `node_modules/.vite/basic-ssl/_cert.pem`、本地资源和 Chromium。

双方进入战场后，仅对第二个浏览器玩家下行注入；再让双方依次通过原生输入展开
各自基地车，验证两端状态一致、无人判败、连接未关闭，并额外观察 10 秒。
输出双方截图和 `weak-network.json`。这些是双人短局、共享状态子集验收，不能
代替完整逻辑 CRC 或 8 人长局。`RA2_BROWSER_GAME=yr` 支持 YR 双命令回归，
按 YR 原生操作框选再展开，不沿用 RA2 的固定基地车点击位置。

多人入口：`RA2_BROWSER_PLAYERS=8`，自动选择支持 8 人的地图并验证 8 个原生
玩家槽；对每个玩家发送展开命令，在所有 VM 上检查一致状态。Linux 同机多 VM
预检按 `1200 MiB × 玩家数 + 1024 MiB` 保守估算，可用内存不足明确失败，不伪装跳过
或通过。该估算不是实际峰值上限，仍需更大内存／分机环境完成真实 8 人验收。
`RA2_BROWSER_MAP_PLAYERS=8` 只让双人测试使用 8 人地图，不能称作 8 人对局。

## RA2/YR LAN 初始发包间隔

通用 WS 二进制协议、Worker 端口桥和 Winsock 适配同时用于 RA2 与 YR；两种游戏仍按 EXE
兼容性哈希隔离，不支持 RA2 与 YR 混合对局。固定地址时序按各自版本独立校验。

### 未解决的长观察失败边界

历史长观察曾出现逻辑停滞和 renderer 崩溃；运行期间伴随共享宿主内存压力，
但现有记录不足以把全部现象归因于 OOM。该失败尚未在隔离环境排除，不能用短局通过、
资源预检或单独的中继测试替代。

复验须固定 RA2/YR 的 EXE 哈希和资源清单基线，在资源隔离、独立浏览器/renderer 的环境中，
分别运行 RA2 与 YR 的长观察回归；同时记录逻辑帧是否持续推进、renderer 是否崩溃、
进程/宿主内存和 OOM 事件，并保留失败与通过两类结果。短局入口分别为
`pnpm run test:browser:network` 和 `pnpm run test:browser:network:yr`，不能把它们单独当作
长观察失败已排除的证据。

### 开局协商周期

原生初始化将 RequestedFPS 设为 30；CPU 平均耗时报告使用客体事件类型 `0x21`，Timing
协商使用 `0x20`，收到 Timing 事件后才更新 RequestedFPS。原生仍检查房主、接收进度和
各玩家报告，并按实际平均耗时、房间速度和动态窗口计算结果，不能把固定帧数换算成完整
收敛时间。

除四处初始发送间隔外，两个游戏模块各自校验两处协商周期签名：

- RA2：`0x623bcf` 的 `test cl,0x7f` 改为 `test cl,0x1f`，CPU 报告机会由每 128 个逻辑帧
  缩短为每 32 帧；`0x6240b7` 的 `test al,al` 改为 `test al,0x3f`，Timing 协商机会由
  每 256 帧缩短为每 64 帧。
- YR：对应检查点为 `0x6476bf` 和 `0x647ba7`，使用相同的 128→32、256→64 帧变更。

这些检查点与初始发送间隔签名一起受各自 EXE 哈希和完整字节签名保护；任一检查失败都不
写入补丁。实现和行为测试见 [`src/games/ra2/networkTiming.ts`](../src/games/ra2/networkTiming.ts)、
[`src/games/yr/networkTiming.ts`](../src/games/yr/networkTiming.ts)、
`tests/basic/ra2NetworkTiming.test.ts` 和 `tests/basic/yrNetworkTiming.test.ts`。

### 版本绑定与可复核证据

`src/games/ra2/networkTiming.ts` 针对 RA2 1.006 的哈希
`06f994965ebde56116d5d53b2e8ffb0c999124166ad99032566cc33d7f83ccdb`，
先核对以下四处完整指令签名，再把各处 `mov` 的立即数 5 改为 3：

```text
0x597ba6: B9 05 00 00 00 3B C6 89 0D 64 D5 A3 00
0x59c4ef: B8 05 00 00 00 89 15 18 0B A4 00 8B 15 AC D2 A3 00 3B D6 A3 64 D5 A3 00
0x5bde16: B8 05 00 00 00 3B CE A3 64 D5 A3 00
0x5bdfd0: B8 05 00 00 00 3B CF A3 64 D5 A3 00
```

`src/games/yr/networkTiming.ts` 对 YR 1.001 使用独立哈希
`7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6`，
核对以下签名后把各处立即数 5 改为 2：

```text
0x5b6546: B9 05 00 00 00 3B C6 89 0D 54 B5 A8 00
0x5baec5: B8 05 00 00 00 89 15 60 EB A8 00 8B 15 4C B2 A8 00 3B D6 A3 54 B5 A8 00
0x5dd2d8: B8 05 00 00 00 3B CE A3 54 B5 A8 00
0x5dd498: B8 05 00 00 00 3B CF A3 54 B5 A8 00
```

RA2/YR 使用各自模块，不能交叉写入地址。仅在联机 shim 启用时安装；哈希未知时
返回 `false`，签名不匹配时在任何写入前失败，重复安装也不会留下部分补丁。
测试入口为 `tests/basic/ra2NetworkTiming.test.ts` 和 `tests/basic/yrNetworkTiming.test.ts`。
两种实现使用原生 Timing 事件、确认、重试和动态 MaxAhead 窗口，不引入自定义事件协议。
补丁只修改上述初始发包间隔与协商周期，不修改游戏时钟、确认机制或窗口计算；周期缩短会
提高报告和协商频率，性能评估需同时观察逻辑帧率、窗口、操作延迟及队列压力。

30ms 对照采用 `RA2_BROWSER_RELAY_DELAY_MS=15`，给每个浏览器与指定 relay
之间的原始 TCP 字节流上下行各加 15ms，包含 WS 握手、心跳和数据。
该代理提供固定 RTT 注入，不等于最终页面 RTT 恰好 30ms；本地传输和调度还会增加耗时。
不模拟 TCP 丢包或重传；代理只在测试进程中存在，结束时释放连接和定时器。

## 共用 Worker 发送路径

内置编码器每次创建独占二进制帧，`RelayClient` 在支持 `sendOwned` 的端口连接中
直接移交该帧，省去编码后的一次完整复制。客体读取、编码载荷复制和普通 `send`
的逻辑字节复制仍保留；自定义 codec 不假设所有权，继续普通发送。此行为同时用于
RA2/YR，不改变线协议，也不修改任一游戏的同步算法。

Worker 端口 ACK 只回收端口队列额度。页面发送前另检查 WebSocket 的真实积压加
当前帧是否超限，防止网络发送缓慢时端口不断 ACK、底层却无界堆积。
超限沿用现有关闭与重新开局语义，没有自动重连或补发历史命令。

## LAN 起步目标

RA2/YR 在四条原生 LAN 开局路径安装独立的客体桩，按本次房间速度初始化
RequestedFPS，最高档从 60Hz 起步，下一档为 45Hz，其余合法档位遵循原版整数换算。
所有原版签名先通过校验，再分配动态代码和安装 CALL；未知 EXE 不修改。
桩保存寄存器、标志与栈，并重放原有 FrameSendRate 设置；同一 VM 再次开局会重读档位。
不锁死 FPS，也不跳过慢端报告、CRC、确认或 Timing 的窗口切换。
这是起步目标，不保证宿主或网络有足够吞吐达到它；测量方法见
[游戏性能](GAME_PERFORMANCE.md)。

| 内容              | RA2 1.006                                      | YR 1.001                                       |
| ----------------- | ---------------------------------------------- | ---------------------------------------------- |
| Session.GameSpeed | `0xA3D2C8`                                     | `0xA8B268`                                     |
| RequestedFPS      | `0xA3D568`                                     | `0xA8B558`                                     |
| 开局入口          | `0x597BA6`、`0x59C4EF`、`0x5BDE16`、`0x5BDFD0` | `0x5B6546`、`0x5BAEC5`、`0x5DD2D8`、`0x5DD498` |

原生速度上限换算在 RA2 `0x624153..0x624184`、YR `0x647C43..0x647C74`。
客户端在开局入口之后才将 Session.GameSpeed 写入运行 GameSpeed，所以桩读取
会话设置，不能读取尚未更新的运行值。桩由现有动态代码分配器独占分配，随 VM 销毁。
全部档位、重复调用和寄存器/标志/栈保留由 `tests/basic/vm/lanStartupTiming.e2e.test.ts` 验证。
双 VM 的起步目标、原生降速和实际 FPS 应分别验收，不能将字段值当作实测性能。

裸地址协议探测兼容 Node 原生 WebSocket 在 TLS 失败时只触发 `error` 的行为：
打开前由错误或关闭事件尝试下一个候选，解绑旧连接以隔离迟到事件；显式 WSS 和已打开
会话不回退。回归见 `packages/relay/tests/relayClient.test.ts` 的真实 socket 与事件生命周期测试。
