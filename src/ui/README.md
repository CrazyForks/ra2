# UI 目录

按页面归属组织：页面自己的组件、状态、hooks 和样式放在一起。
当前只有游戏页面；资源选择、下载、地图管理和联机状态都是该页面的区域/弹窗，不单独创建路由。

```text
ui/
  pages/
    game/
      AppShell.tsx       游戏页组件树与 VM 生命周期入口
      page.ts           页面组装、资源选择与输入/工具栏接线
      components/       资源选择、工具栏、弹窗、启动及调试面板
      hooks/            文件选择器、网页滚轮适配
      state/            游戏页专属状态与用户输入请求
      styles.css        页面样式
      vendor/           游戏画面超分模型及许可
      ...               页面输入、渲染、资源导入等专属模块
  shared/
    components/         应用级错误边界
    state/              通用 store 与 React 订阅 hook
```

应用由 `src/main.ts` 挂载 React 根，`index.html` 提供游戏页入口。
页面专属组件不要放入 `shared`；共享层不能反向依赖页面。
游戏运行时模块位于 `adapter/`、`vm86/`；文件契约、纯 provider 和识别归 `resources/`，
浏览器文件实现归 `platform/browser/files/`，游戏定义归 `games/`，不搬进 UI。
完整职责与依赖边界见 `docs/ARCHITECTURE.md`。
VM 会话控制归 `app/session/`；呈现调度归 `graphics/framePresenter.ts`。
页面只注入渲染器、低频状态回调与开发模式模型工厂，不在组件中复制 rAF 或模型取消逻辑。

移动文件必须同步更新静态 import、浏览器测试中的 Vite 动态导入路径、GLSL `?raw` 地址和文档。
不在旧目录保留转发文件，以免同时存在两套入口。目录及共享依赖边界由
`tests/basic/reactUiArchitecture.test.ts` 校验。
