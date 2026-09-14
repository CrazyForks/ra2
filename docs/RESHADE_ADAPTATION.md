# ReShade 与游戏专用插件适配研究

## 结论与证据基线

2026-09-14 的调查发现，头猫魔改版 ReShade 包含 PNG 序列动画及游戏专用纹理输入，
值得作为高清绘制适配的研究对象。当前已实现开发用单 pass 渲染接入，并在真实 RA2 帧上验证 LaserBlit 直通和诊断扰动。
尚未接入插件 DLL、游戏数据接口或高清动画绘制，不能据此宣称完整兼容或画质、性能收益。

研究基线为 YRModdingBase 的 `4af0dd002522845236088c433a5529a6803d60ea`：

- `README.md` 明确说明整合头猫魔改版 ReShade，支持 PNG 序列动画。
- `Resources/Renderers.ini` 的 ReShade 配置组合 cnc-ddraw 与 `d3d9.dll`。
- `reshade-shaders/Shaders/ReShadeK.fxh` 声明 `TOPMASK`、`LIGHT`、`ZBUFFER`、
  `SHROUD`、`WATER` 等游戏纹理；`show_water_depth.fx` 另需 `WATERDEPTH`。
- DLL 静态字符串含 `AnimClass_Draw_SetTexture`、`TechnoClass_RenderVxl_ReplaceMesh`、
  `GScreenClass_Update_TransferBuffer` 等接口名。这支持游戏绘制挂钩的推断，但不能代替
  调用约定、地址、对象生命周期与运行行为的验证。没有执行该 DLL。

另外两个同名近似项目需区分：RA2YR Reshade 是以颜色、FakeHDR、FXAA、Tiltshift 为主
的效果包；CnC-RaVaGe 的 yrr-reshade 是面向 Yuri's Revenge Redux 的 ReShade 分支。
后者不是已确认的头猫插件源码。

## 已完成的编译实验

独立编译器使用 yrr-reshade 的 `dc276eaebc3ade93853a333025c5d96363001b80`，
仅构建 `source/effect_*` 中的预处理器、解析器和 GLSL 生成器，不构建或加载注入 DLL。
实验宏使用 800×600、`__RESHADE__=50202`、`__RENDERER__=0x10000`，不表示其他
宏配置、编译器版本或渲染后端已经验证。

| 效果文件                   | FX → GLSL       | WebGL2 编译与链接  |
| -------------------------- | --------------- | ------------------ |
| `LaserBlit.fx`             | 成功，1 个 pass | 局部语法适配后成功 |
| `show_water_depth.fx`      | 成功，6 个 pass | 未验证             |
| `NeoBloomIndexedFilter.fx` | 成功，9 个 pass | 未验证             |

原始激光 GLSL 在 WebGL2 编译失败；适配显式 binding、跨阶段 varying、顶点编号类型，
并声明 GLSL ES 版本和精度后，顶点与片段 shader 均编译成功且程序链接成功。
测试环境为 Chromium WebGL2 / SwiftShader。临时 Linux 副本还需补齐头文件名大小写
别名。这些定向变换不是完整的 FX 兼容层；本次没有验证绘制像素、真实游戏效果或帧率。

## 集成边界

当前 `src/vm86/win32.ts` 的 `VmFrame` 提供最终像素与光标，没有上述游戏辅助纹理。
只传最终画面不足以还原插件的水面、遮挡和分层高清绘制。

适配应分为三个部分：

1. 在游戏模块中确认并校验绘制入口，提取辅助纹理或对象绘制命令。RA2 与 YR 的版本、
   地址和 ABI 分别处理，不把游戏专用挂钩放进通用 vm86。
2. 浏览器渲染层管理纹理、FBO、uniform 和多 pass 调度；覆盖主线程及 Worker 的呈现
   路径，并明确销毁所有者。现有入口为 `src/ui/pages/game/vmFrameRenderer.ts`，
   呈现调度为 `src/graphics/framePresenter.ts`。
3. 高清 PNG 动画需维护原对象的位置、帧序、遮挡、阴影和队伍颜色。仅把图片放大或覆盖
   在最终帧上不能证明这些行为正确。UI 保护需要真实遮罩，光标应保持独立呈现。

优先验收一个效果所需的真实数据桥接，再验证一个单位的高清动画。每一步都应留出关闭
路径，与原画面对照；不能用伪造游戏纹理宣布兼容。帧率结论需同场景测量。

## 来源与分发

ReShade 核心许可与各效果文件、游戏插件和素材的许可分别核对。YRModdingBase 整合包
声明自定义非商业许可，不能推断其中所有组件都可随本项目分发。本次没有找到并确认
头猫修改部分的完整公开源码及独立许可，原发布论坛页面也存在访问限制。
研究使用的第三方副本、编译输出和截图不入库。

## 开发渲染入口

`VmFrameRenderer.setPostProcess()` 接收 GPU 效果工厂，关闭、替换和销毁时释放效果。
`src/graphics/framePostProcess.ts` 的 `ColorPostProcess` 在最终颜色之后、独立光标之前
执行单 pass；通过 GPU 颜色复制接入现有呈现路径，不读取客体内存，也不进行 CPU 像素
回读。当前额外颜色复制及 GL 状态查询尚未优化，不作为性能结论。

`src/graphics/experimental/reshadeLaser.ts` 接收外部编译后的 LaserBlit GLSL，并适配
GLSL ES 和 framebuffer 的纵向坐标。没有辅助数据时明确关闭游戏效果、仅直通颜色；
不能把默认纹理当成真实游戏遮罩。该模块没有生产入口导入，不内置第三方 shader。
编译宏须沿用上文的 800×600 基线，本适配器尚不支持任意 FX 或自动重编译。

先启动开发服务，并自备游戏资源和上述编译输出：

```bash
pnpm run dev --host 127.0.0.1 --port 15185
# 另一个终端，设置编译产物的实际路径：
RA2_LASER_GLSL="$LASER_GLSL_PATH" pnpm exec tsx scripts/experiments/probeReshadeRender.mts
# 无素材像素回归：
pnpm exec tsx tests/basic/browser/postProcessBrowserSmoke.mts
```

探针默认创建被忽略的 `.tmp-reshade-render`，已存在则拒绝覆盖；使用 `RA2_POST_OUTPUT`
指定新目录。通过开发请求拦截暴露 renderer 及只读 VM 引用，不修改生产页面或原始素材。
同一次浏览器任务内对同一真实帧生成原图、直通和诊断扰动截图，验证直通及关闭后逐字节
恢复，并确认原生单位建立及逻辑帧推进。诊断输入为常量位移，不能用于评价插件的真实
激光效果、遮挡正确性或高清收益。当前真实游戏验收仅覆盖 RA2 主线程；YR、Worker
与多 pass 水面/Bloom 仍未验收。

无素材像素回归覆盖 RGBA、RGB565、索引色、尺寸变化、重复重绘、开关、光标和后端切换。
真实游戏探针第一次因测试脚本的函数命名辅助变量缺失而失败；修复测试脚本后的复测
通过，不把首次失败计为成功。

## 游戏内可用效果

游戏工具栏的 **ReShade** 下拉提供「关闭」「色彩 + 锐化」「左右对照」。默认关闭；
收起控制栏时先点击左上角菜单。开启后显示「已开启 · 色彩 + 锐化」，左右对照时
左半边为原图、右半边为增强。开关立即重绘当前帧，不重启 VM，不需要外部 shader 文件。
Canvas 2D 后端会报告 WebGL2 要求，保持关闭；GPU 资源由当前帧渲染器拥有。

`src/graphics/reshadePreset.ts` 移植 SweetFX 的 Vibrance 和 LumaSharpen pattern 1，
基线为 `16d1a42247cb5baaf660120ee35c9a33bb94649c` 的
`Shaders/SweetFX/Vibrance.fx` 与 `Shaders/SweetFX/LumaSharpen.fx`。
保留 MIT 许可于 `src/graphics/vendor/sweetfx/LICENSE` 及产物中的许可注释。
当前固定色彩强度 0.55、锐化强度 0.9、锐化限制 0.045；没有 Bloom 或任意 FX 加载器。
这些效果作用于整个最终颜色帧（包括原生侧栏），独立光标随后绘制。
这是真实效果算法的浏览器移植，仍不表示支持 ReShade DLL 或头猫版游戏绘制扩展。

无素材像素回归另检查增强确实改变颜色、左右对照两侧分别等于原图与完整增强。
以下真实 RA2 主线程探针通过游戏工具栏切换模式，用同一帧保存对照，并验证关闭恢复：

```bash
pnpm exec tsx scripts/experiments/probeReShadeUi.mts
```

默认输出 `.tmp-reshade-ui`，已存在时用 `RA2_POST_OUTPUT` 指定新目录。
首次 UI 探针因下拉按钮定位器名称错误而超时，失败截图保留；更正定位器后另目录复测。
