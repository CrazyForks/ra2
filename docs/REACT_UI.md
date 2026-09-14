# React UI 维护边界

网页 UI 使用 React + TypeScript；不把原版游戏 UI、VM 或逐帧渲染改写成 React。

## 文件职责

目录按页面划分，见 [UI 目录说明](../src/ui/README.md)。

- `index.html`：元数据与入口宿主。
- `src/ui/pages/game/AppShell.tsx`：单一组件树、稳定的 canvas ref、VM 挂载/卸载入口。
- `src/ui/pages/game/components/`：资源选择、统一 RA2/YR 下载弹窗、地图管理、交流群、工具栏、启动/错误/退出面板和调试面板。
- `src/ui/pages/game/styles.css`：保留红警客户端外观与响应式规则。
- `src/ui/pages/game/components/AppRegions.tsx`：各 UI 区域订阅自己的快照；弹窗通过 Portal 留在同一组件树。
- `src/ui/pages/game/hooks/`：文件选择器与浏览器事件的 effect/ref 接口，卸载时清理监听器和异步请求。
- `src/ui/pages/game/state/`：游戏页状态；通用 store 和 `useSyncExternalStore` 订阅 hook 在 `src/ui/shared/state/`。
- `gameSourcePicker.ts`、`runtimeToolbar.ts`、`page.ts`：文件导入、性能采样与 VM 生命周期服务，不渲染组件或修改普通 UI 节点。

## DOM 所有权与性能

整个应用只有 `main.ts` 创建一个 React 根，不使用 `flushSync`、根注册表或动态 DOM 宿主。
可见性由条件渲染决定，文字、选中值和折叠样式通过 props/state 输出。
下载弹窗开关、音量、分辨率下拉、地图编辑草稿等交互状态保留在组件内部；
跨组件请求与 VM 状态才进入可订阅服务。服务不保存 ReactNode，不接受 HTMLElement 来更新界面。

组件挂载后从 effect 把 canvas ref 交给 VM 服务。卸载会取消未完成的资源选择请求、
释放计时器/输入监听器/ResizeObserver，并让旧启动代次失效；迟到结果不能重新启动 VM。
导入服务接收 File，React 的 onChange 负责交付。原生文件选择器 cancel 暂无 React input 类型支持，
因此只有这条浏览器兼容监听保留在 hook，和 focus 的 200 ms 取消兜底一起清理。

外壳节点保持稳定。WebGL、音频、Worker 消息、鼠标合并、触控位移和输入锁仍走独立适配器；
这些高频链路不经过 React state。工具栏每 500 ms 接收一次计数汇总；调试视图只在开启时更新，间隔至少 200 ms。
超分 select 与提示也由 React 管理；连续帧相同状态不会触发订阅更新。
只有 canvas/WebGL、输入锁提示、触控位移等浏览器/高频适配器保留必要的 DOM 操作，
不要让组件同时控制这些适配器拥有的属性，也不要用 React 重建 canvas 来切换界面。

模态框共用原生 `dialog.showModal()`，由浏览器约束焦点和恢复焦点。
Esc 关闭网页弹窗，不向游戏合成 Esc；导入忙碌时禁止提前关闭。

## 回归入口

启动独立开发服务后设置 `RA2_BROWSER_ORIGIN`：

```bash
pnpm run check
pnpm run test:browser:react-ui
pnpm run test:browser:touch-ui
pnpm run test:custom-maps
pnpm run test:browser:archive-layers
```

React 浏览器测试不依赖游戏素材，提交者应本地运行；dev/main PR、push 或手动触发时由 GitHub 工作流执行，覆盖桌面/窄屏下载弹窗、链接属性、Esc/按钮关闭、
焦点恢复、canvas 稳定、状态切换、取消后迟到文件导入和页面服务销毁。地图导入与触屏由各自真实浏览器测试补充。
`reactUiArchitecture.test.ts` 强制单根并禁止普通组件/服务重新拼 DOM；
`uiState.test.ts` 覆盖通知去重、订阅释放、请求取消和过期弹窗回调。
涉及控制器或生命周期的改动还应使用本地合法素材跑 RA2/YR 联机短局与 ZIP 缓存刷新；
无素材测试不能替代真实游戏验收，短局不等于公网长局稳定性保证。

上述短局测试也不覆盖 4/8 人或公网弱网长局。

资源选择器先导入文件或目录，再按玩家侧必需清单检测 RA2/YR。只有一个完整版本时
直接加载该版本的主程序并启动；两个版本均完整时才显示选择，选择前不加载 EXE。
归档启动层按两个版本的实际存在文件准备，完整目录用于识别；后台提取不会覆盖
待选版本的提示。重选或销毁时取消待选 provider。开发入口仅在 dev 显示一个「开发测试」按钮，不折叠；读取共用资源目录后同样识别版本。

首页背景保持完整外框和原图比例；桌面内容限制在内屏区域并可滚动，窄屏改为背景在上、表单在下。
