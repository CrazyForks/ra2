# 原生游戏帧率与 E2E 性能口径

GameRuntimeHooks.createFrameReader 提供只读原生逻辑计数。
VmShell.getGamePerformance() 在主线程和 Worker 都返回 Promise。
Worker 在客体所在的线程采样并附上宿主 performance.now()，不会把 RPC 往返耗时算入采样区间。
未请求采样时不创建计时器、不逐帧跨线程通信，也不注入跳转或改游戏时钟。

## 指标

- frame 是原生模拟帧累计值；logicFps 是两次帧数差除以宿主实际时间差。
- sampledAtMs、intervalMs 是测量所在宿主的单调时间与实际间隔。
  不同 Worker 时间原点不能直接相减；每个玩家独立计算。
- requestedFps 是原生 LAN 协商变量，单机或协商前可能只是初值，不是实际 FPS 或单机上限；
  gameSpeed、sessionSpeed 是原生速度档位。
- status：第一次 baseline；正常 sample；计数回退或时间异常 reset；
  菜单/未运行 inactive。非 sample 的 FPS 为 null，正常运行但没推进则为 0。
- 未知 EXE、签名不匹配、短读、VM 未加载或已销毁时返回 null，不能算通过。

现有 DirectDraw 边界计数、画面上传 FPS 和浏览器 rAF 均保留原有含义，
不替代原生逻辑 FPS。此探针也不是每个客体逻辑帧完成时的时间戳记录。

## 版本证据

RA2 1.006 的 EXE 哈希沿用 src/games/ra2/startupPage.ts，YR 1.001 的哈希沿用
src/games/yr/startupPage.ts。
src/games/ra2/performance.ts 校验 0x540676 至 0x540689 的读取/递增/写回指令，
计数地址 0xa40d2c。YR 1.001 独立实现位于 src/games/yr/performance.ts，
校验 0x55de73 至 0x55de86，计数地址 0xa8ed84。先核对各自 SHA-256，再核对签名。
LAN 时序的版本绑定、签名和限制见 [联机稳定性](RA2_NETWORK_RELIABILITY.md)。

## 联机性能测试

服务与真实游戏资源准备好后运行：

```bash
RA2_BROWSER_RELAY=ws://127.0.0.1:15176/ra2 RA2_BROWSER_RELAY_DELAY_MS=25 RA2_BROWSER_STABILITY_SECONDS=60 RA2_BROWSER_PERF_WARMUP_SECONDS=30 pnpm run test:browser:network
```

代理每方向增加 25ms，即每玩家到 relay 新增约 50ms RTT。不要与服务端
--delay-ms 的单次转发延迟混淆。YR 用 RA2_BROWSER_GAME=yr 选择。
测试点击「开发测试」入口；玩家界面始终先选择资源。房间由 relay URL 路径指定。

每秒打印 [game-perf]，逐秒保存 performance-timeline.json，结束输出 performance.json。
overall 和 warmed 包含按实际时长加权的 logicFps、窗口 FPS P05/P50/P95、
窗口数、异常数，以及完整零推进窗口累计得到的最大观察停滞时长。
窗口百分位不是逐帧耗时百分位，无法揭示一秒内所有卡顿。
最终即时状态检查不加入分布，避免几毫秒采样污染百分位。
默认预热 30 秒，时间不足则 warmed 为 null。

可显式设置 RA2_BROWSER_MIN_LOGIC_FPS 为预热后加权平均最低门槛。
缺少有效窗口、未知探针、计数重置或低于门槛均失败。默认不把 60 写死：
不同游戏速度档位有不同目标，探针不更改速度。

## 单机与验证范围

pnpm run test:browser:battle-start 在 RA2/YR 主线程和 Worker 直达战场后，
额外采样 5 秒，输出各游戏/模式的 _-native-perf-_.json。
RA2_BROWSER_SCREENSHOT_DIR 指定输出目录。只断言计数有效且推进，不要求固定 FPS。
RA2_BROWSER_GAME 和 VM_BROWSER_MODE 可选择单个场景，避免同机资源竞争。

对照需固定地图、单位数、操作序列、分辨率、游戏速度、VM 模式与宿主负载，
保留 RTT 分布和失败记录，进行多轮重复。单人启动、双人短局或合成内存测试
不能证明多人、公网长局稳定，也不能证明低 RTT 无性能回退。

联机脚本可用 RA2_BROWSER_START_PAGE=lan 验证直接进入原生 LAN 大厅后完整建房/开局。
RA2_BROWSER_TIMING_BASELINE_REF 指定代码基线时，仅将该基线的两份 networkTiming.ts
编译后作为浏览器模块加载，供同场景 A/B；不替换 EXE 或资源。省略时测试当前实现。
test-config.json 记录实际基线、入口、延迟与观察时长；基线代码同样必须通过原生补丁签名校验。

timing-transitions.json 从首次观察到可操作战场开始，记录原生 RequestedFPS/MaxAhead 的变化，
包括原生帧号与每个 Worker 自己的时间戳。它给出首次观测边界，不是逐指令精确发生时间；
用于避免只分析展开基地车之后的性能窗口、漏掉最初的低帧率阶段。

### 原生命令队列观测

`RA2_BROWSER_TRACE_COMMANDS=1` 在真实联机测试的展开命令阶段启用只读队列探针，
写入 `command-latency.json`。默认关闭，正式运行不导入探针、不轮询游戏队列。
RA2/YR 模块分别校验实际 EXE 哈希及出队/入队指令，通用读取器只解释队列布局。
依据为 YRpp 的 `EventClass.h`、`QueueClass.h` 定义，并核对两份原版 EXE。

记录本机 outgoing 的 DEPLOY 事件及双方 scheduled 的执行标记，以 House、目标 ID、
目标类型关联，断言双方计划执行帧一致；仍独立要求双方基地车消失和玩家存活。
outgoing.frame 初始为入队帧，原生发送调度会原地改写为计划执行帧；
scheduled.frame 是计划执行帧，不能把首次 outgoing 快照与它强制比较相等。
executed 只表示原生事件处理完成，不表示展开动画完成。

`observedMs` 从测试发出键盘事件算起，包含轮询、Worker RPC 和双端等待，只是首次
观测上界。`observedFrame` / `sampledAtMs` 是该端快照的逻辑帧/宿主采样时间，不能
跨 Worker 直接相减。探针读取最近 128 个环槽，包括已出队但尚未覆盖的历史；
积压或覆盖可能造成漏观测，缺失只能判定本轮证据不足，不能解释为事件没有发送。
该模式增加诊断开销，不与关闭探针的性能对照混为一组。

### 开局慢与冷启动

原版联机初始 RequestedFPS 为 30。当前 LAN 开局按房间 Session.GameSpeed 初始化：
0 为 60Hz、1 为 45Hz、2–6 为整数 60 / 档位，非法档位保守回到 30Hz。
每次开局重读设置，后续真实报告、降速和窗口仍由原生处理。
版本、指令证据与边界见 [LAN 起步目标](RA2_NETWORK_RELIABILITY.md#lan-起步目标)。
单机不启用这段联机补丁，不能套用同一结论。

资源打开、目录枚举或稀疏文件补页可能让客体等待 provider；首次执行战场代码还会
触发 v86 的 JIT 编译。首次 ZIP/7z 导入后继续解压、写入资源缓存，与 HTTP 开发入口、
刷新后的惰性缓存恢复属于不同路径。对照应明确资源来源，并分别测首次导入、刷新
恢复和同 VM 再次进入战场；第三种同时温热资源与 JIT，单凭提速不能区分二者。
现有 HC/s 与指令计数只有吞吐，没有文件等待时长，不足以断言是 IO 或 JIT 瓶颈。

队列原始 `flags` 保留事件 +1 的整字节，`executed` 只解释 bit0。不能要求该字节
等于 0 或 1：RA2 发送路径 `0x626330` / YR `0x649E30` 读取 +1 后只用
`AND 0xFE` 清执行位；YR 执行路径 `0x64CAC7` 用 `OR 1` 置位。
YR 目标事件构造器 `0x4C65E0` 没有初始化 +1，高7位可能保留栈内容。
RA2 `0x62631B` / YR `0x649E1B` 从本地 House+0x30 原样复制 House 字节，
没有本地 0x80 标志的证据，因此不对 House 做高位掩码。
这些结论依据本文支持的两版主程序独立反汇编；YRpp 的 EventClass.h 把
执行字段声明为 bool，不足以说明原 EXE 对整字节的实际处理。
