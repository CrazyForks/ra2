# 原版命令行与启动入口

## 启动直达 LAN 大厅

`?network=1&start-page=lan` 支持 RA2/YR，在资源选择完成后直接进入原生 LAN 大厅。
自建服务可追加 `relay=127.0.0.1:15176`。`network=1` 负责启用宿主 relay，
`start-page=lan` 仅负责客体首次导航；未提供导航参数时仍进入主菜单。
该入口不会自动创建房间、选图或开局，也不绕过连接失败。

实现沿用下文遭遇战入口的哈希、20 字节签名及一次性跳板，只改首次目标为 3，
消费后恢复 18。依据两个主程序独立反汇编：

- RA2 主菜单 LAN 按钮 ID `0x578` 在 `0x5172C1` 返回状态 3；分发表
  `0x5146F4` 以状态加一索引到 `0x5139C2`，设置 Session=3、网络协议=1，
  再转状态 16，由原生会话初始化继续创建 Lobby。
- YR 对应按钮返回点 `0x532051`、分发表 `0x52EB58`、状态分支 `0x52DD75`；
  使用自身 Session 地址与 ESI 状态寄存器。不能直接将首次目标设为 16，
  否则会跳过网络模式初始化。

不模拟菜单点击、不主动写 Session、不改 VM 时钟。`tests/basic/ra2StartupPage.test.ts`
执行两种游戏的真实 x86 跳板，验证首次 3、再次 18、栈与标志保持及所有拒绝路径。
`test:browser:startup-page` 支持 `lan-worker` / `lan-main` 两种模式，检查第一个
原生页面就是 `GUI:Lobby`、真实 relay 已连接、后续帧继续输出。单组可运行：

```bash
RA2_BROWSER_GAME=ra2 RA2_BROWSER_STARTUP_MODE=lan-worker RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:browser:startup-page
```

该单端检查不代替双端互相发现、真实开局与命令同步验收；遭遇战 `battle` 入口
继续保留原生设置初始化与开局校验，无需增加完整 Spawner 或复杂注入依赖。

## 单人战场测试入口

`?start-page=battle` 支持 RA2/YR：选择资源（或恢复已缓存资源）后，自动进入
原生遭遇战战场。主线程与 Worker 使用相同 hook；默认启动及 `start-page=skirmish`
不变。侧边栏「快速开局」进入遭遇战设置页；自动开战使用 `start-page=battle`。

这不是完整 CnCNet Spawner：沿用原生 INI/默认遭遇战设置，未提供 URL 地图、玩家、
种子或联机配置，也不保证不同资源/缓存环境产生相同对局。用于跳过人工菜单导航，
不能代替确定性回放或联机同步测试。无有效地图/设置时仍由原生处理器校验，可能停留
在设置页；测试应超时报错，不能强制成功。

`src/games/shared/battleStartup.ts` 生成跳板，`src/games/ra2/battleStartup.ts` 与
`src/games/yr/battleStartup.ts` 各自登记地址并校验版本，独立依据主程序反汇编实现：

- 复用首次状态 11 导航；不跳过遭遇战设置的创建和配置初始化。
- RA2 `0x683C79`、YR `0x6AE34E` 位于设置窗口初始化返回后，原指令为
  `mov eax,[esp+4]; cmp eax,0x617`。初始化期间可能短暂显示设置页。
- 一次性 x86 跳板以 `ECX=ESI`（窗口）、`EDX=0x617`、两个零栈参数调用各自
  原生开局处理器 RA2 `0x6829F0` / YR `0x6ACEE0`；处理器 `RET 8`。
  不是点击脚本，也不投递 WM_COMMAND；选项解析、场景装载、窗口清理仍由原版执行。
- 保存/恢复寄存器与标志，重放覆盖的两条指令，保留后续原生条件跳转。
  调用前消费标志，之后再进入遭遇战不会重复自动开局。
- 完整 EXE 哈希、11 字节现场签名、独占桩空间和分配重叠均校验；只修改客体内存，
  不修改磁盘 EXE，也不修改 VM 时钟。

```bash
# 需要本地游戏资源与正在运行的开发服务；默认 RA2/YR × Worker/主线程四组。
RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:browser:battle-start
# 单组：
RA2_BROWSER_GAME=yr VM_BROWSER_MODE=worker RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:browser:battle-start
```

浏览器回归在选择资源后不发送客体鼠标/键盘事件，检查战场像素、持续帧输出、
原生本地 House 存活且持有单位（不假定随机国家的基地车类型索引）。House 探针
只在测试响应中注入且只读，不替换 EXE。
截图由 `RA2_BROWSER_SCREENSHOT_DIR` 指定并留在临时目录，不入库。
无游戏资源的 `tests/basic/battleStartup.test.ts` 执行真实 x86，验证一次性调用、参数、
栈平衡、寄存器恢复与重放比较，并覆盖拒绝路径。

## RA2/YR 启动直达遭遇战设置页

游戏运行后点击侧边栏「快速开局…」，确认后安全关闭当前 VM，刷新进入遭遇战设置。
取消不重启、不改 URL；确认后设置 `start-page=skirmish` 并保留其他参数。
未保存进度会丢失，联机会断开；未缓存资源（例如开发目录）需重选，弹窗明确提示。
缓存恢复自动启动时仍沿用 URL 设置。这里只跳过前置菜单，国家、地图和开始按钮
继续使用原生设置页，不表示已经实现 Spawner 配置直达战场。

网页使用 `?start-page=skirmish`，选择 RA2 或 YR 资源后首次原生页面直接是遭遇战设置。
已有查询参数时追加 `&start-page=skirmish`。不带参数保持默认；设置页入口不会
自动开局或绕过资源加载。自动开局使用上节的 `battle`，未知目标明确报错。

- 实现 `src/games/ra2/startupPage.ts`（YR 在 `src/games/yr/startupPage.ts`），
  跳板生成器共用 `src/games/shared/startupTrampoline.ts`，不复制第三方补丁代码。
  依据原版主程序反汇编：`0x513363` 的遭遇战按钮返回状态 11；`0x5146F4` 分发表跳到
  `0x513D93`，由原生代码设置 Skirmish 会话并创建设置页。
- `0x513762` 原本选择初始菜单 EBP=18；只在这里安装五字节 JMP。独占静态桩尾
  48 字节，用 MOV 读取一次性目标11并将其恢复18，再跳回原生 continuation。
  不写持续轮询标志、不模拟按钮、不改 VM 时钟；原生设置页创建/销毁仍执行。
- YR 独立校验主程序 gamemd.exe SHA-256 `7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6`
  和20字节签名。`0x52D713` 遭遇战按钮返回11，`0x52EB58` 以状态+1索引到
  `0x52E10F`，设置 Session=5。补丁入口 `0x52DB12` 原为 MOV ESI,18，
  仅首次改为11，消费后恢复18。共享跳板生成器，但不复用 RA2 地址或 EBP 寄存器。
- 只接受各自登记的主程序 SHA-256 和入口20字节签名。页面校验后将所选
  EXE 的独立副本传给 Worker，在重新发现游戏前覆盖到内存 FS；EXE 版本不匹配时拒绝装载。
  不能仅因几条指令相同就放宽版本校验，不覆写本地游戏文件。
- startupPage 从创建选项经 Worker init 或主线程回退传到共用 VmCore，具体地址
  保留在游戏目录。首次执行前安装，静态桩不越过0xC0000动态桩边界。
- 单元测试执行真实 x86，验证第一次11、第二次18以及栈/标志保持、拒绝错误版本/
  签名/重复/冲突。真实 EXE 三项回归：直达、国家选到最后一项、选图并返回单人
  菜单和主菜单。测试首击门控尊重显式预期页面，不强制等待 MainMenu。
- 浏览器脚本分别验证 Worker、`vm-worker=0` 和不带导航参数的默认入口，记录第一
  个页面；不拦截或替换 EXE 请求，使用正常开发入口和主程序缓存，验证页面选中的 EXE
  完整传到 Worker。
  截图保存于测试环境指定的临时目录，不提交游戏素材。

```bash
VM_REQUIRE_GAME_RESOURCES=1 pnpm exec vitest run tests/real-game/ra2/startupPage.test.ts
VM_REQUIRE_GAME_RESOURCES=1 pnpm exec vitest run tests/real-game/yr/startupPage.test.ts
RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:browser:startup-page
```

## 当前启动配置

RA2/YR 的 catalog 均传入 `-SPEEDCONTROL`，并在创建 VM 前将内存 INI 的
`[Options]`、`[Skirmish] GameSpeed` 默认设为 **0（最快）**。不修改导入资源，
不覆盖 `[LAN]` / `[WonlinePref]` 的房间速度，不改变 VM 时钟。
游戏内仍可用原生选项调速；重启 VM 重新应用启动默认值。

通用 shim 只拼接命令行，不判断游戏；模块路径仍为原来的 EXE，参数不混入
`GetModuleFileNameA`。测试覆盖参数边界、RA2/YR 传递与 INI 叠加。

RA2 主程序的 Options 速度位于 `0xa40b18`，Session 速度 `0xa3d2c8`，
逻辑帧计数 `0xa40d2c`，SpeedControl 标志 `0xa40d84`。主循环 `0x53ffd7`
检查标志，未开启则 `0x53ffe4` 强制速度 2。命令行解析分支在 `0x515429`。
Options 速度应使用上述地址验证，不使用 Rules 偏移。

战役通讯影片还会在 `0x672e03` 附近保存速度至 `0x7f3230`，临时写 2；
影片退出 `0x672e8f` 恢复保存值。这与主循环覆盖是两件事，不应通过每帧写 0
破坏影片节奏。主菜单、选战役时速度 0、Session 0、标志 1、时钟 1×；
影片期间保存值为 0、活动值为 2。影片后恢复需要单独观察，不能仅凭主菜单值宣称战役提速。

地址仅对应 RA2 主程序，不能用于 YR。主程序 SHA-256：

- game.exe：`06f994965ebde56116d5d53b2e8ffb0c999124166ad99032566cc33d7f83ccdb`
- gamemd.exe：`7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6`
