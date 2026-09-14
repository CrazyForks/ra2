# CI 配置

所有 CI 统一位于 `.github/workflows/`，runner 均为 `ubuntu-latest`。工作流文件可以直接用于
部署，无需自建 runner；维护者需启用 Actions、配置 secret 和分支保护。跳过不是验收通过。

## 统一流水线与 Basic test

`quality-check.yml` 是唯一工作流，接受目标为 dev/main 的 PR、dev/main push 和手动运行。
顺序为 `Basic test → Real game RA2 → Real game YR`，各 job 使用独立 runner。
Basic 执行 frozen install、Prettier 格式检查、类型/单元/合成 VM 测试、构建、固件一致性、真实浏览器绘图、
React UI、触屏、地图与分层归档、主线程/Worker relay 回归。

此 runner 是一次性隔离环境，无游戏目录、资源 secret、部署凭据、宿主目录挂载或
私有缓存。工作流检查 checkout 中没有 game/ 和 .tmp-third-party/，不下载游戏 EXE。
外部 PR 不运行真实素材任务。Basic 与游戏 job 不共用可写缓存。

## 真实游戏 CI

同一工作流内的真实游戏 job 只在 dev/main push（包括合并后）或这两个分支上手动运行，
且必须等待 Basic 成功。不接受 PR、任意 ref 或 SHA 输入。
维护者只将已审查代码合入分支；此流程是合入后回归。RA2、YR 使用独立 job，
分别下载对应资源包、校验并运行对应游戏。YR 显式依赖 Basic 和 RA2，在 RA2 完成后启动；
RA2 失败仍运行 YR，并保留整个流水线失败。Basic 失败或取消流水线时不启动游戏任务。
内部 dev 不推送 GitHub；外部贡献面向 main。目标分支需包含工作流文件才能触发，
分支发布由维护者另行执行。

| 类型   | 名称                                     | 内容                                                 |
| ------ | ---------------------------------------- | ---------------------------------------------------- |
| Secret | `GAME_RA2_URL` / `GAME_RA2_YR_URL`       | 对应游戏的原始资源包下载地址（与前端选择的文件相同） |
| Secret | `GAME_RA2_SHA256` / `GAME_RA2_YR_SHA256` | 已审核原始资源包的 SHA-256                           |

URL 只由 TypeScript 入口读取，不写入仓库、命令行或日志，也不传给测试子进程。
下载请求使用已在 CI 验证的浏览器 User-Agent；HTTP 失败只报告状态和服务类别，
不输出原始请求、响应 header、正文或网络异常。整包 SHA-256 校验通过后才允许解压；
缺少哈希时仅下载并报告摘要，任务失败，不将现场摘要自动当作可信配置。
secret 缺失时入口在下载前就失败，并指明缺的是哪个变量：fork 或未配置 secret 的仓库
不会执行真实游戏验收，也不能用「任务没跑起来」冒充通过。

## 与前端共用的资源导入

直接提供玩家在前端选择的 ZIP、RAR、7z、NSIS/SFX 安装包，不需要重新打包，
也不需要提供 game/thirdParty 目录或 inventory.json。支持范围以共享提取器为准。

浏览器 Worker 和 CI 共同调用 `src/utils/archive/archiveExtractor.ts`：使用 7z-wasm 识别格式，
递归处理嵌套包，按 `ARCHIVE_WANTED_NAMES` 提取资源，必要时使用已有 NSIS/LZMA 回退。
浏览器通过 WORKERFS 挂载 File，CI 通过 NODEFS 挂载已验证的下载文件；文件选择与
提取算法保持一致。CI 等待全部提取完成，不启用浏览器启动层抢跑，不执行安装程序。
零字节文件保留，可选文件存在时一起提取；不把未提取到文件当作成功。
NSIS 两段流变体按文件独立解码：单条损坏流只跳过该文件并在状态里报告，
不中断排在它后面的必需资源；必需项缺失仍由资源验收报错。

主程序与前端一样由 `GAME_MANIFESTS` 的获取地址和固定 SHA-256 准备，游戏包不需要
包含精确 EXE。此下载只存在于真实游戏流程，公共准入不访问 EXE 下载地址。
提取结果写入本次临时 game/ra2/，主程序同时写入 thirdParty/ 和游戏目录。
原始包限制 16 GiB，写出的资源最多 200,000 项、32 GiB；拒绝越界输出路径。

信任基线是 secret 中的整包哈希和源码登记的主程序哈希。本次导入完成后记录的
inventory.json 仅用于核对运行前的文件集合与内容，属于派生产物，不需要用户提供，
也不能替代输入哈希。资源变更需审核并更新对应 secret；原始包与测试截图不入库。

## Runner 与执行顺序

YAML 只声明触发条件、runner、工具安装与 secret，然后调用 pnpm 命令。
流程编排统一使用 TypeScript，不依赖 Python、Shell 流程或 GITHUB_ENV 中转。
无素材任务安装 NASM；两类任务均安装 Node、packageManager 指定的 pnpm 及 Chromium 系统依赖。

| 入口                               | 职责                                                                  |
| ---------------------------------- | --------------------------------------------------------------------- |
| `pnpm run ci:basic`                | 检查无素材环境、check、固件一致性、安装浏览器、九项浏览器回归         |
| `pnpm run ci:browser`              | 使用已安装浏览器，独占启动 Vite/relay，运行九项浏览器回归             |
| `pnpm run ci:real-game ra2` / `yr` | 下载对应 secret 资源、校验、安装浏览器、原始 EXE 与战场启动回归、清理 |
| `pnpm run ci:resources --record`   | 维护者显式制作清单；不被 CI 调用                                      |

`ci:quality` 保留为 `ci:basic` 的兼容别名。

`scripts/ci/run.mts` 是唯一流程入口；downloadResources.ts 只处理下载与哈希，prepareGame.ts 在独立进程调用前端共享提取器并准备主程序，
gameResources.ts 只处理资源契约，processes.ts 统一处理日志、超时和进程组清理。
提取输出通过 NODEFS 暂存到磁盘，避免完整包常驻 MEMFS；成功和失败都会清理暂存。
提取进程退出后才读取本次导入结果并验证清单，回收 WASM 内存后再启动 VM；
已校验并提取的原始包随即删除。子进程失败、超时或没有返回清单都使任务失败。
浏览器和真实游戏入口各自构建 relay 的导出模块，不依赖其他 job 的 dist。
资源路径在入口内直接传递；环境变量仅用于调用已有游戏测试的边界。
入口先清空从环境继承的 `VM_*` 本机调试变量（跳帧检查、点击序列、只悬停、关 JIT 等），
再写入自己显式设置的值，避免 runner 或调用者遗留的变量把断言降级。
每个游戏任务拥有独立 runner、资源目录和端口；两款游戏由 job 依赖串行调度，不需要 flock 或外部锁文件。
同机双端联机测试暂不纳入 CI：当前 runner 的可用内存未满足双 VM 准入门槛。
保留 `test:browser:network`、`test:browser:network:yr` 手动入口及原内存检查，
后续确认 Chromium 清理与 runner 容量后再恢复；CI 成功不代表联机已验收。

真实游戏流程：

1. 下载并校验原始游戏包，使用共享提取器导入；资源始终位于 checkout 外。
2. 准备固定版本主程序，检查必需资源，登记并校验本次导入清单。
3. 严格模式运行对应游戏原始 EXE 启动；RA2 另跑快速游戏契约。
4. 独占开发端口，验证对应游戏的 Worker/主线程战场直达。
5. 正常和失败路径均清理下载目录；runner 被强制终止时由一次性环境销毁回收。

工作流由 job timeout 限时，每个测试子进程由入口定时终止整个进程组；失败和超时返回非零。
正常退出、断言失败、SIGINT/SIGTERM 都执行清理；SIGKILL 由一次性 runner 销毁兜底。
截图与详细诊断仅留本次 runner，文本结果进入任务日志，不使用公共 artifact 上传。

## 本地验证与限制

本地已安装浏览器并有资源时，显式使用 --local；它不下载资源、不安装浏览器，也不删除自备目录：

```bash
export RA2_GAME_ROOT=/path/to/resources/game
export RA2_THIRD_PARTY_CACHE_DIR=/path/to/resources/thirdParty
export RA2_CI_RESOURCE_MANIFEST=/path/to/resources/inventory.json
export RA2_CI_RESOURCE_MANIFEST_SHA256="${APPROVED_MANIFEST_SHA256:?设置审核后的哈希}"
pnpm run ci:real-game ra2 --local # YR 改为 yr
```

不要从待校验清单现场计算期望哈希作为 CI 基线。公共测试使用合成嵌套 ZIP 和回环 HTTP
验证共享提取、零字节、过滤、下载失败、哈希及清理，不访问真实下载地址。这不证明远端 secret 或服务可用。
实际任务成功后才能宣称远端 CI 启用；双人短局不覆盖公网弱网、完整长局、多人或全部 MOD。
