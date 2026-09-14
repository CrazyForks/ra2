# 通用 WS 二进制协议

一条 WS/WSS 连接同时传控制消息和游戏数据，独立服务路径可为 `/房间名`。
不要求 WebSocket 子协议，无额外协商。每条 WS 二进制消息恰好一帧；客户端与服务端必须使用同一协议版本。

## 编码

所有整数均为无符号、大端。公共头仅 1 字节消息类型 `TT`。
WebSocket 保留消息边界，即使底层拆帧，接收 API 仍交付完整消息；不按 TCP read 边界解析。
`str` 为 `uint16 UTF-8字节数 + UTF-8字节`，严格校验 UTF-8；`hash` 为 32 字节 SHA-256。
`metadata` / `data` 占用该消息剩余字节，不额外编码长度；其他消息禁止尾随字节。

| TT  | 消息       | 公共头之后的字段，按顺序                      |
| --- | ---------- | --------------------------------------------- |
| 01  | hello      | room:str, hash:32字节, nonce:str, metadata    |
| 02  | welcome    | peer:str, addr:u32, epoch:u32                 |
| 03  | peer-join  | peer:str, addr:u32, hash:32字节, metadata     |
| 04  | peer-leave | peer:str, addr:u32                            |
| 05  | datagram   | src:u32, dest:u32, sport:u16, dport:u16, data |
| 06  | ping       | n:u32, at:u64                                 |
| 07  | pong       | n:u32, at:u64                                 |
| 08  | room-close | epoch:u32, reason:str                         |

游戏数据报固定 **13 字节头**，没有 JSON：

```text
偏移  0       1       5       9       11      13
      05      src     dest    sport   dport   原始数据…
字节  1       4       4       2       2
```

例如 src=1、dest=2、sport=3、dport=4、数据为 AA：
`05 00 00 00 01 00 00 00 02 00 03 00 04 AA`。
WS 自身的帧头另计。JavaScript API 保留 exe（64 位小写十六进制哈希）、n/a 字段名，
由编解码器转换，不向网络发送字段名。at 只允许 0 至 2^53−1 的整数，避免客户端精度丢失。

## 房间与限制

URL 路径解码后直接确定房间，覆盖 hello.room；客户端仍发送有效的 hello.room 字段。
所有路径按同一房间名规则解析。只允许非空单段房间名，
禁止控制字符及点段；直接升级根路径 / 被拒绝。应用客户端先为无路径地址补上 /ra2。
通用客户端可用 room 选项指定缺省路径，未指定则为 /default；显式路径始终优先。
路径不能作为鉴权秘密，服务不提供房间认证。

连接后 5 秒内发送 hello；服务发送 welcome，再发送已有成员的 peer-join，通知其他成员新人加入。
同房间必须使用相同兼容性哈希。服务端不读取游戏文件或解释元数据。
room 非空、最多 64 个 UTF-16 代码单元，禁止空白及 ? & # /；nonce 非空且最多 32。
URL 的 `clientId` 查询参数与协议中的 `peer` 使用同一规则：非空、最多 128 个 ASCII 字符，且只允许
`A-Z`、`a-z`、`0-9`、`.`、`_`、`-`；`reason` 非空且最多 128 个 UTF-16 代码单元；metadata 最多 64 字节。
完整帧不超过 128 KiB，data 为 1–65507 字节；最多 20 位成员，默认发送积压上限 4 MiB。

addr/src/dest 是网络序 IPv4 数值，不是实际网络端点。服务端覆写 src 为连接的虚拟地址，
在房间内按 dest 单播；255.255.255.255 和 10.247.255.255 广播给其他成员。
关闭连接通知 peer-leave。WS 可靠有序；无自动重连、断线续局或无序传输。
WS ping/pong 每 15 秒检查存活；应用 ping/pong 测量 RTT。服务限制包速率和字节速率。

## 部署

启动、Docker 和客户端例子见 `README.md`。只需一个 TCP 端口；CLI 选项为
`--host`（默认 0.0.0.0）、`--port`（默认 15176）、`--max-connections`（默认 2048）、
`--delay-ms`（每次游戏数据报转发附加 0–60000ms，默认关闭）、
`--faults`（可选 JSON 故障配置）和 `--help`。独立服务只读取 CLI 选项，不读取环境变量。
红警页面由 `parseRa2RelayUrl` 按主机确定唯一的 WS/WSS 协议；省略协议或提供完整 URL
都会按主机重选协议，不执行失败回退。通用 `RelayClient` 对裸地址仍可先尝试 WSS、
失败后尝试 WS；显式协议不回退，建立会话后不自动重连。每次协议建连/握手默认限时 10 秒。
`--delay-ms` 不延迟心跳，页面 RTT 不反映注入；双向数据报增加约两倍指定值。
它复用保序有界故障队列，不模拟 TCP 重传；不能与 faults.delayMs 同时指定。
GET /healthz 返回 JSON 健康信息（不是 WS 线协议）。SIGUSR2 排空，SIGTERM/SIGINT 关闭服务。

服务不含认证、静态网页、游戏资源或任意目标代理。明文 WS 不要求证书；HTTPS 页面访问
内网 WS 仍受浏览器混合内容和本地网络策略限制，WSS 可由部署者的反向代理终止 TLS。
