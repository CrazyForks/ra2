# 超分模型来源

## ScaleFX 3×（像素画）

移植自 libretro/glsl-shaders 的 `scalefx/shaders/scalefx-pass0..4.glsl`
（Sp00kyFox，2017-03-01），MIT 许可声明保留在 `../scalefxUpscale.ts` 文件头。

- SHA-256（五个 pass 原文件）：
  - pass0 `37e534d5e600b5bac5d66f05e78f8688cc4631432d7887502e58e106a15ca40c`
  - pass1 `5e5f27731d7dc918f1cee610218aead459e62284dc33e22e22ab65f82f03e18c`
  - pass2 `7899f17fb6c156075d02a2cbf84462c184191229a9e795c6abbc023d64b3600a`
  - pass3 `0f7290476c4e8e4330ef81ba10a72a6547fc0f1ffa2d18c94cadcc8f1998b9ec`
  - pass4 `b6ad74bc8211399149166e77264d03eea582772d7f08b2dea9fbc9440d3f84c5`
- 适配差异：官方 retroarch 管线用顶点预偏移采样（GL_ES 分支），本移植一律
  texelFetch 整数取点；中间量经 RGBA8 FBO 逐级衔接，读 FBO 的 pass 翻转 Y；
  pass4 输出 3× 后额外一次线性 pass 贴合画布目标尺寸。
- 滤波逻辑（距离度量、角强度、交叉口多数投票、lvl1–6 边缘、子像素映射）逐行
  保留官方数学；SFX_SAA/SFX_CLR/SFX_SCN 用官方默认（1.0/0.5/1.0）内联。
- 算法性质：输出只包含原图已有的颜色（pass4 只做邻域取色），不产生新颜色。
- 固定 3× 整数放大，目标尺寸非 3× 倍数时由最终线性 pass 缩放；`?sr=scalefx`
  或工具栏切换开启。

## FSR 1.0（EASU）

数学部分移植自 GPUOpen-Effects/FidelityFX-FSR 的 `ffx-fsr/ffx_fsr1.h`
（FSR 1，v1.20210629；快速倒数/开方近似取自同目录 `ffx_a.h`），
代码位于 `../fsrUpscale.ts`，MIT 许可声明保留在文件头。

- SHA-256（ffx_fsr1.h）：`93c3922362ea7fc99cbcc698ca30c98de4f8c246d1fbb0b09e015ddef38ce3a5`
- SHA-256（ffx_a.h）：`f60e2722fcd13989523b9164d776ab382b3692791767f3bf8bb19967f763f3fb`
- 适配差异：官方 gather4 + CPU 打包 con0–con3 常量；本移植按客体三种帧格式
  （索引 / RGBA / RGB565）用 texelFetch 直接取 12 抽头，映射关系经恒等化简
  与官方一致。权重、负瓣、去振铃钳位与快速近似公式不修改。
- 单 pass 空间超采样，不改变客体渲染分辨率；`?sr=fsr` 或工具栏切换开启。
- RCAS 锐化档（`?sr=fsr-rcas` / `fsr-rcas-soft`，锐度 0 / 1 档）：EASU 先渲染进
  中间 RGBA 纹理，RCAS 再输出到画布。两处有意偏差：`FSR_RCAS_DENOISE` 不启用
  （官方建议噪声在锐化后处理）；限制器分母加 1e-4 钳制，规避官方在纯白/纯黑块
  的 0×∞ NaN 边界（社区移植常规处理）。

`Anime4K_Upscale_CNN_x2_S.glsl` 原样来自
bloc97/Anime4K 的 `glsl/Upscale/Anime4K_Upscale_CNN_x2_S.glsl`。

- SHA-256：`4c53ec2e287908f7ee7bcb266b0170421626d663576468b7d7dafc62962649a4`
- MIT 许可，完整版权与许可声明保留在原文件头部。
- Anime4K v3.2 CNN x2 S（版本来自 GLSL 文件头的 `//!DESC` 标识）。
- 权重、偏置与激活不修改；`../aiUpscale.ts` 适配 WebGL2 的采样、行方向、
  FBO 和 depth-to-space，最终基础图使用双线性采样，中间激活使用 RGBA16F。
- 模型针对动画，不是为 RA2 文字/像素素材训练，不保证恢复原本不存在的细节。

更新模型必须同时核验来源、许可、哈希以及独立 CPU/GPU 数值回归。

## 画质模式

原样的 Anime4K_Upscale_GAN_x2_M.glsl 来自 bloc97/Anime4K，MIT 声明保留在文件内。

- SHA-256：`8a1d33fddc8939c1e0eb4d6ad6a7baf653dd420d6b713e385b7c73be90d9affe`
- v4.1 GAN 低分辨率模型，23 个卷积 pass，最后一层重建 RGB 残差。
- `aiModelGraph.ts` 保留所有权重与分支；原尺寸整数采样用 texelFetch，最后一层
  半像素采样保持线性过滤。按特征最后一次使用规划纹理复用，不能简单双缓冲。
- CNN S 作为快速模式。GAN 仍不是 RA2 专用训练，不能保证所有素材更好。
