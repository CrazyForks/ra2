# 测试指南

测试分为无素材准入和真实游戏回归。前者可在干净 checkout 运行；后者需要维护者或
开发者自备、受哈希校验的游戏文件。缺资源、跳过、超时或崩溃均不是通过。

## 基础准入

```bash
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
```

`check` 包含 TypeScript、单元测试、合成 PE/真实 v86 指令测试、架构依赖检查和生产构建。
它显式选择 tests/basic/ 和 packages/relay/tests/，不读取本地 EXE 或隐式下载游戏。
`pnpm test` 则包含本地全部用例，不能用它的资源跳过数量替代公共准入。
下载流程的无素材测试也使用 Node/TypeScript；依赖与命令版本以 package.json 和锁文件为准。

格式使用 package.json 固定的 Prettier；`pnpm run format` 统一维护源码、测试、脚本、配置和文档。
第三方原文、资源与生成的锁文件由 `.prettierignore` 排除；Python、汇编等不支持的语言不由 Prettier 检查。

所有测试禁止 `.only`。修改 boot.asm 后运行 `pnpm run build:boot`，同步 boot.bin；
CI 再次汇编后检查无差异。该命令调用 `nasm`，不是 pnpm 依赖：CI 显式安装
（Ubuntu 用 `apt-get install -y nasm`），本地未安装时只能跳过固件重建，
不能因此改动 boot.bin 或跳过 `firmware-diff` 检查。补丁同时检查 EXE 哈希和指令签名，公共测试使用离线夹具，
真实游戏回归使用原始 EXE 重跑相同契约，不以合成夹具代替兼容性验证。

## 测试目录

按运行所需资源分层，不按文件名是否包含 game 分类：

| 目录                                                 | 级别与资源要求                                        |
| ---------------------------------------------------- | ----------------------------------------------------- |
| `tests/basic/`                                       | 无素材单元与集成测试，含游戏策略、资源契约的合成夹具  |
| `tests/basic/architecture/`                          | 模块依赖准入                                          |
| `tests/basic/vm/`                                    | 合成 PE 与真实 v86 指令回归，无需原版 EXE             |
| `tests/basic/browser/`、`tests/basic/smoke/`         | 无素材浏览器和独立协议冒烟；浏览器入口使用 Playwright |
| `packages/relay/tests/`                              | relay 包独立维护的无素材测试，纳入 Basic              |
| `tests/real-game/ra2/`、`tests/real-game/yr/`        | 依赖对应游戏原始 EXE 和资源的 VM 回归                 |
| `tests/real-game/browser/`、`tests/real-game/smoke/` | 真实游戏浏览器、下载和启动冒烟                        |
| `tests/experimental/browser/`                        | 需要外部模型的实验回归，不计入公共 Basic              |
| `tests/helpers/`、`tests/fixture/`                   | 共享测试工具与合成夹具，不独立执行                    |

`pnpm run test:e2e` 串行执行真实游戏 VM 文件；CI 进一步通过 job 依赖使 RA2 完整验收后再跑 YR。
Basic 包含格式、`check`、固件一致性以及无素材浏览器回归；独立入口见 [CI 配置](REAL_GAME_CI.md)。
当前素材 CI 的门槛为原始 EXE 启动、RA2 快速游戏契约及 Worker/主线程战场直达。
同机双端网络测试暂时只保留手动入口，不纳入 CI；恢复前须确认 Chromium 清理与 runner 内存容量。
其他真实游戏用例按改动选跑；共辉需要另备 MOD，缓存恢复需要原始包，均不能算作基础门槛已覆盖。

## 按改动选择回归

| 改动                       | 补充验证                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI、交互                   | test:browser:react-ui；触屏另跑 test:browser:touch-ui                                                                                               |
| 绘图、超分                 | test:graphics 及对应 upscale、ai、gan 入口                                                                                                          |
| provider、压缩包、缓存     | test:custom-maps、test:browser:archive-layers；真实包另跑 cache-reload                                                                              |
| ABI、文件 shim、补丁、调度 | 对应无素材 VM 测试和受影响游戏真实 EXE 回归                                                                                                         |
| 开局入口                   | test:browser:startup-page、test:browser:battle-start                                                                                                |
| 通用 relay                 | relay 包 check、test:browser:relay；游戏适配另跑双端网络测试                                                                                        |
| 性能                       | 同浏览器、地图、资源、速度、玩家数和负载的前后对照                                                                                                  |
| CI 下载                    | tests/basic/ciResourceDownload.test.ts、tests/basic/ciGameArchive.test.ts、tests/basic/gameCiResources.test.ts、tests/basic/ciConfiguration.test.ts |

真实游戏固定地址和指令证据在各游戏模块及其测试，不能扩大架构白名单、修改时钟、
伪造确认或跳过判负来通过测试。失败需要保留原因，复测成功不能抹去此前失败。

## 无素材浏览器测试

```bash
pnpm run test:browser:install
pnpm run dev
# 另一个终端，地址与 dev 输出一致：
RA2_BROWSER_ORIGIN=https://127.0.0.1:15174 pnpm run test:browser:react-ui
RA2_BROWSER_ORIGIN=https://127.0.0.1:15174 pnpm run test:browser:archive-layers
```

Playwright 需保留 1.60.0 起的解压修复：旧版 extract-zip 在 Node 24.16.0 上会下载完成后挂起
（Playwright issue 41000、40998；Node.js issue 63487）。浏览器版本以锁文件为准，升级后验证冷安装。

Vite 的依赖预构建同时登记 JSX、归档 Worker 和实验模型入口；新增懒加载依赖时应验证
空缓存启动，不能靠热缓存或页面重载掩盖 React 实例分裂。预构建不等于向浏览器加载实验模块。

这些入口必须阻断主程序的预加载；无需 .tmp-third-party/ 或 game/。
绘图回归需要可用的 Chromium/WebGL2；缺少浏览器或渲染能力时失败，不降级为通过。
地图和归档测试使用合成资源，不证明真实游戏包完整。地图包入口还验证会话存档的
恢复读取和零字节枚举，并在真实 IndexedDB 写入请求成功后主动中止事务，确认保存拒绝且没有残留记录。

Relay 包的协议向量、真实 socket、背压、限流、生命周期和独立构建均纳入根准入：

```bash
pnpm --filter relay-package run check
pnpm run server:relay --host 127.0.0.1 --port 15176
RELAY_PROBE_GRANT=1 RELAY_PROBE_URL=127.0.0.1:15176 pnpm run test:browser:relay
```

Chromium 联机回归显式授予 local-network-access（含局域网及回环访问）。
浏览器回归覆盖主线程、真实 Worker、双向转发及离开清理；它不证明 LNA 拒绝权限有效。
容器改动另需真实 Docker 构建、健康检查和浏览器转发，配置解析不能代替镜像验收。

## 真实游戏回归

常规本地资源放在 game/ra2/，精确主程序放在 .tmp-third-party/。共享 RA2/YR 目录应完整，
零字节占位仍属于存在的文件。准备主程序可用 `pnpm run prepare:third-party`，这会联网。
真实游戏 CI 从前端同款原始包导入到工作区外，校验整包哈希并准备固定主程序，见 [CI 配置](REAL_GAME_CI.md)。

```bash
VM_REQUIRE_GAME_RESOURCES=1 VM_GAME_DIR=/path/to/ra2 pnpm exec vitest run tests/real-game/ra2 --exclude '**/gonghui.test.ts'
VM_GAME_DIR=/path/to/yr pnpm run test:vm:yr
pnpm run test:browser:battle-start
pnpm run test:browser:network
pnpm run test:browser:network:yr
```

`VM_GAME_DIR` 用于 Node 真实 EXE 测试；浏览器由 dev 资源服务提供文件。
`test:e2e`、`test:vm`、`test:vm:ra2`、`test:vm:yr` 默认已经带上
`VM_REQUIRE_GAME_RESOURCES=1`，缺 EXE 直接失败；`pnpm test` 的全量运行仍允许跳过
未安装的游戏，但会打印明确的跳过警告，跳过的用例不计入验收。
资源完整与游戏行为仍须由断言验证。共辉另设 VM_GONGHUI=1，覆盖中国、
美国和苏联，不以原版启动成功代替。不同 EXE 的地址或资源不能混用。

双端测试经原生 UI 发现、建房、加入、地图校验、开局和展开命令，读取双方玩家/单位
状态确认同步。不得用 WS 握手或大厅截图替代真实游戏操作。Linux 多 VM 启动前检查
内存并保存 OOM 状态，日志输出宿主总量、可用量，预检失败时记录进程名与 RSS；
renderer 崩溃立即失败，诊断取样有超时，不能因取不到截图而挂起。
共享宿主仍可能被其他进程抢占，内存预检不等于全过程无资源竞争。

## 资源导入与恢复

```bash
RA2_BROWSER_ZIP=/path/to/game.zip pnpm run test:browser:cache-reload
```

验证首次选择资源、实际缓存事务提交及刷新恢复后的游戏版本。RA2_BROWSER_GAME=yr
选择 YR，RA2_BROWSER_MAIN_THREAD=1 检查回退。缺文件、零字节、读取失败和未知必须
分别覆盖，不能先过滤零字节文件再宣布恢复成功。

无痕环境默认存储配额可能小于包体积；可显式设置
RA2_BROWSER_STORAGE_QUOTA_BYTES=2147483648 验证足够配额下的恢复。测试需记录覆盖生效，
不能把配额覆盖后的通过写成默认环境通过。RA2_BROWSER_FULL_ARCHIVE=1 可对照完整解压，
但不能把旧路径通过算作分层加载通过。

## 联机性能与故障

```bash
RA2_BROWSER_RELAY=ws://127.0.0.1:15176/ra2 RA2_BROWSER_RELAY_DELAY_MS=25 RA2_BROWSER_STABILITY_SECONDS=60 pnpm run test:browser:network
```

代理每方向增加 25ms，即每端新增 50ms RTT；不是最终 RTT，也不是 relay 的 --delay-ms。
脚本逐秒输出真实逻辑帧、RequestedFPS、窗口和连接状态，并在观察结束后发送新命令。
RA2_BROWSER_STABILITY_SECONDS 支持 10–600 秒，RA2_BROWSER_PLAYERS 支持 2–8。
多人必须具备足够宿主资源；8 个连接不等于 8 人完整对局。

LAN 起步桩用 tests/basic/vm/lanStartupTiming.e2e.test.ts 验证档位、寄存器、标志、栈和重复调用。
真实双端从 timing-transitions.json 核对起步目标，从 performance-timeline.json 核对实际
推进，二者不能混为一谈。原生命令跟踪、基线替换和性能口径见 [性能指南](GAME_PERFORMANCE.md)。
故障场景与断线边界见 [联机说明](RA2_NETWORK_RELIABILITY.md)。

## CI 与交付证据

CI 统一位于 .github/workflows/quality-check.yml：Basic test 合并格式和所有无素材准入，
dev/main 上随后串行运行 RA2、YR 真实游戏回归；PR 只运行 Basic。
runner、secret、资源包和平台隔离按 [CI 配置](REAL_GAME_CI.md) 部署；存在 YAML 不代表已启用。
PR 说明实际运行的命令、版本、结果及未验证范围。涉及性能时保留同场景对照，
涉及游戏时说明地图、速度和玩家数。双人短局不证明公网、长局、多兵种交战或完整战役可靠。
