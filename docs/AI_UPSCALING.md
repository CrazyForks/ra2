# 可选 GPU AI 超分

## 当前入口

控制栏的 WebGL2 超分与开发模式「模型实验」是两条独立路径。
前者使用内置 CNN/GAN shader；后者按登记哈希加载本地 ONNX，生产构建不包含
ORT 或模型 Worker。模型实验窗口提供 AnimeSharpV2 RealPLKSR 2× Soft/Sharp、
NomosUni SPAN 2× FP32/FP16、APISR RRDB 原生 2× 和 UltraSharpV2 Lite 4× FP32/FP16；
整帧显示提供 UltraSharpV2 Lite 4× FP16、NomosUni SPAN 2× FP32/FP16。

当前模型列表与默认值以 `src/ui/pages/game/experiments/modelProbe.ts` 和
`src/ui/pages/game/components/ModelProbeDialog.tsx` 为准。模型适用范围和验证入口见下文。

## 使用

运行中可在控制栏的「超分」下拉框实时切换关闭 / Bicubic / CNN / GAN-M，
不重启 VM、不修改游戏分辨率；暂停画面也会立即重绘，适合同场景对照。
URL 参数只决定启动时的模式，实时选择不持久保存。切换会释放旧模型资源，
AI 首次绘制需编译 shader，可能短暂停顿；实际是否启动以画面状态提示为准。

- `?sr=ai`：预训练 Anime4K GAN-M 2×，画质优先，默认关闭。
- `?sr=ai&sr-model=fast`：CNN S，速度优先，方便同场景对照。
- `?sr=1`：抗振铃 bicubic 插值对照，**不是 AI**。
- 不带 `sr` 或 `?sr=0`：原显示路径。
- `?webgl=0`：Canvas 2D，不运行任何 GPU 超分。

已有参数时用 `&sr=ai`。建议先选 800×600 游戏分辨率，再放大窗口/全屏。
AI 只在实际画布宽高都超过输入的 1.2 倍时启动；否则保持原像素。
固定模型先重建到 2×，再适配显示尺寸；超过 2× 的额外放大不是第二轮 AI 推理。
不会自动降低客体分辨率、改变 VM 时钟或修改游戏设置。

## 运行路径

原始 RGB565 / RGBA / 索引帧 → GPU 原尺寸 RGBA → GAN-M 分支网络 → 2× RGB 残差重建
→ 输出尺寸呈现 → 独立鼠标光标。

当前 WebGL2 路径使用预训练 GLSL 常量，不需要额外模型下载或 WASM 推理循环，
也不上传画面至服务器。默认模型为 23 个卷积 pass 的 GAN-M，快速模式为四层 CNN；
适用对象是动画素材。上游 Anime4K
说明（来源：`bloc97/Anime4K`）明确以动画为目标；RA2 的文字、栅栏、地形纹理可能
出现过度平滑或伪影，请用开关前后结果对照。
模型来源、许可、固定哈希见 [vendor 记录](../src/ui/pages/game/vendor/README.md)。

性能边界：

- 默认关闭不创建 CNN GPU 资源。模型源码随前端打包，只有启用且实际放大时才编译。
- 卷积采用 RGBA16F，负激活不被 RGBA8 截断；按分支最后一次使用复用纹理。
  原尺寸整数位置用 texelFetch，最终半像素位置用线性过滤，避免棋盘颗粒。
- 同帧鼠标移动/窗口变化复用已有 2× 结果，不重跑推理；新帧不排队做 CPU 推理。
- 生产路径没有 `readPixels` / `finish`，也没有逐像素 JS/WASM 推理。
- 缺少浮点渲染附件、编译/分配失败时警告并回退原图，不假装 AI 已开启。
- 输入上限 1920×1080 像素且 2× 尺寸不能超出 GPU 上限；超出时回退。
  显存按 `(20 + 8 × 特征纹理峰值数) × 输入像素数` 估算，上限 128 MiB；
  超出模型预算也会回退，不含原显示路径和驱动开销。CNN 快速模式为 36 字节/像素。
- 请求超分后，画面顶部显示实际状态：已启动、放大不足或回退原因，全屏下仍可见。
  提示不接收鼠标，不影响点击；关闭超分时隐藏。`#screen` 的 `data-upscale` 用于诊断；
  是否发生推理以画面状态提示和实际输出为准，不依据 URL 参数或渲染器名称判断。
- 不做 CPU/WASM 静默回退，以免抢占 VM 时间。该路径用于较低客体分辨率下的放大画质。

## 验证

开发服务运行后，可执行以下无素材浏览器回归；它们验证 shader、旁路、资源释放和显示状态：

```bash
pnpm run test:graphics
pnpm run test:graphics:upscale
pnpm run test:graphics:ai
pnpm run test:graphics:gan
```

## 开发模型

开发模型不替换默认实时超分，也不把权重打入发布包。所有模型都按登记版本和
SHA-256 核验，权重、原版截图和结果留在被忽略的临时目录。

### UltraSharpV2 Lite 4×

登记的 `4x-UltraSharpV2_Lite_fp32_op17.onnx` 版本许可为 CC BY-NC-SA 4.0，
SHA-256 为 `ba692ad6c7b59bdebbaa9951c9ef5295a6d69e7444f1c46824c3cafdaab067a8`。
`scripts/experiments/probeUltraSharp.py` 只做 CPU ONNX 兼容性初筛，不进入游戏渲染链；
它检查输出有限值、四倍尺寸和实际模型哈希。

```bash
python -m venv "$MODEL_ENV"
"$MODEL_ENV/bin/pip" install onnxruntime==1.30.0 pillow==12.3.0 numpy==2.5.3
"$MODEL_ENV/bin/python" scripts/experiments/probeUltraSharp.py \
  "$ULTRASHARP_MODEL" "$RA2_FRAME" "$SR_OUTPUT" \
  --crop 180 200 128
```

输出 `input.png`、`ultrasharp.png`、`comparison.png`（nearest / bicubic / 模型）
与 `result.json`（实际哈希、输入输出尺寸和三轮耗时）。调用前设置
`MODEL_ENV`、`ULTRASHARP_MODEL`、`RA2_FRAME` 和 `SR_OUTPUT`；输出目录已存在时拒绝覆盖。

浏览器 GPU 探针使用同一份 FP32 模型：

```bash
RA2_PROBE_MODEL=/path/to/4x-UltraSharpV2_Lite_fp32_op17.onnx \
RA2_PROBE_MODEL_ID=ultra4x RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:graphics:model-probe
# 无硬件的兼容测试可显式加 RA2_PROBE_SOFTWARE=1；此模式仅验证兼容性。
```

### 浏览器 GPU 模型入口

#### 共同加载规则

- ONNX Runtime Web 固定 1.29.0，仅在独立 Worker 内按需 import。正常游戏启动
  或仅打开窗口都不下载 ORT/WASM/权重。权重由用户本地选择，不上传、不自动缓存。
- 所有登记模型先校验 SHA-256；存在输出元数据兼容修正的模型只在独立副本中等长改名，
  不改输入、权重、算子或磁盘文件，结构不匹配必须拒绝。
- 必须有 WebGPU 适配器，不可用时报错；部分官方节点按兼容配置交给 WASM，界面显示
  实际执行路径。FP16 模型还要求适配器支持 `shader-f16`，不支持时拒绝加载，不回退为 FP32。
- 渲染模式包括关闭/Bicubic/CNN/GAN；推理结果不自动切换模型。

#### 小块采样规则

- 「模型实验」默认采样游戏画面中心 128×128，可调 32～256；四边另带 16 像素上下文，
  原图与模型输出并排显示。
- 采样同步复制小块，不引用 VM 待回收缓冲；一次只运行一个推理任务，不排队、不替换游戏帧。
  原生游戏光标仍走现有管线，不进入样本。关闭小块采样窗口、超时或切换模型会取消任务并释放小块 Worker。

#### 整帧显示规则

- 整帧只开放已接线的 `ultra4x-fp16`、`nomos2x` 和 `nomos2x-fp16`；输入最多 800×600，
  输出倍率由所选模型决定，不改变屏幕或客体分辨率。
- 整帧采用单任务背压：空闲时获取最新帧，忙时丢弃过期输入；首帧显示原图，完成后显示
  最近推理结果，光标按最新原始帧即时绘制。页面隐藏不发新任务。
- 停止、换源、切换普通超分模式或退出会取消任务并释放 Worker；失败或超时恢复原图。

#### 测量边界

- 无素材回归和模型探针只验证加载、输出尺寸、Worker、WebGPU、资源释放和界面状态，
  不建立跨硬件性能门槛。软件 WebGPU 仅用于兼容性和拒绝路径检查。
- 画质、运动稳定性、整帧帧率、端到端延迟和显存占用，必须使用真实游戏画面、固定输入
  和目标设备分别测量；探针耗时包含输入复制、跨 Worker 传输、推理、转换与回读，
  不等于纯 GPU kernel 时间或输入延迟。
- 测试脚本使用合成采样源，不代表真实游戏画质；截图和 JSON 只保存在本地临时输出目录。

#### AnimeSharpV2 RealPLKSR 原生 2×

使用作者官方发布（来源：`Kim2091/Kim2091-Models/releases/tag/2x-AnimeSharpV2_Set`）
的 `2x-AnimeSharpV2_RPLKSR_Soft_fp32.onnx` 与 `2x-AnimeSharpV2_RPLKSR_Sharp_fp32.onnx`，
每个 29,895,095 字节，许可 CC BY-NC-SA 4.0，不分发权重、不自动下载。
Soft SHA-256 `a77ad08fff1f1216f7213f0a1296941806250ab9af9465d41aad96b2a862156f`；
Sharp SHA-256 `580cf6afc9231a07650ae0ce58ef67b99fc4571a31bd9a3bb9bc3dfcb1e9f322`。
独立哈希阻止混用文件或上游资产静默替换。默认 Soft（较干净输入），Sharp 面向重退化源；
两者均为面向动画素材的原生 2× 模型。
核对两份图：FP32 NCHW 输入/输出，末端 DepthToSpace 为 CRD、blocksize=2，
使用与 UltraSharp 相同的 output/width/height 符号修复和末端 WASM 兼容。
输出通道动态符号保持原样，由实际推理结果严格校验 RGB 及 2× 宽高。

```bash
RA2_PROBE_MODEL=/path/to/2x-AnimeSharpV2_RPLKSR_Soft_fp32.onnx \
RA2_PROBE_MODEL_ID=animesharp2x-soft pnpm run test:graphics:model-probe
# Sharp 使用 animesharp2x-sharp 和对应文件；无硬件时加 RA2_PROBE_SOFTWARE=1，仅验证兼容性。
```

#### UltraSharp Lite FP16 与整帧显示

开发模式「模型实验」提供官方 `4x-UltraSharpV2_Lite_fp16_op17.onnx`，大小
15,281,610 字节，
SHA-256 `b368dd0460421c3b3484a9a6855c07670f853abde3e0e5a6bfb72f2d5f8d9c50`。
权重、输入、输出均采用 FP16；输入 RGB8 转半精度，输出解码并检查有限值。
要求适配器 `shader-f16`；不支持时拒绝加载该 FP16 模型，不回退为 FP32。
同时提供 FP32 对照与 UltraSharp 输出元数据/Metal DepthToSpace 兼容处理。

整帧输入最多 800×600，真实模型输出为 3200×2400（较小输入按 4×）。
FP16 运行必须使用支持 `shader-f16` 的适配器；软件 WebGPU 只验证拒绝路径、控制器
背压/清理和光标坐标回归。

```bash
RA2_PROBE_MODEL=/path/to/4x-UltraSharpV2_Lite_fp16_op17.onnx \
RA2_PROBE_MODEL_ID=ultra4x-fp16 pnpm run test:graphics:model-probe
# 软件 GPU 拒绝路径验证另外设置 RA2_PROBE_SOFTWARE=1 RA2_PROBE_EXPECT_NO_F16=1
```

Metal 兼容：ORT DepthToSpace 的 `AppendPermFunction` 参数为 input 类型，
调用处传入 output 索引，导致 `perm(output_indices_t)` 无法转换为 `input_indices_t`。
源码位置：`microsoft/onnxruntime/blob/main/onnxruntime/core/providers/webgpu/tensor/depth_to_space.cc`。
通过正式 `forceCpuNodeNames` 选项，仅将官方模型 `/to_img/DepthToSpace` 节点交给
WASM 执行，避开该 Metal shader；不拦截浏览器编译器、不改卷积权重或全退 CPU。
节点名从已校验模型读取，缺失/数量变化拒绝。Metal 兼容性需在 Apple 硬件上验收，
软件 WebGPU 结果只用于兼容性检查。

#### APISR RRDB 原生 2×

APISR RRDB 2× 使用 Xenova ONNX 发布版（来源：`Xenova/2x_APISR_RRDB_GAN_generator-onnx`）的
`onnx/model.onnx`（FP32，17,963,855 字节）。
SHA-256 为 `c0c1bd343db0da03de28c5eb82c1cadfd5c77f909c9351fffda047dd116a3a24`。
模型卡许可 GPL-3.0，权重不随仓库分发，用户通过模型窗口链接本地下载导入。
这是面向动画素材的原生 2× 模型。
独立校验 2× 输出，按 2× 裁掉上下文；切换模型立即终止旧 Worker 并清空旧结果。
其 ONNX 输出 `reconstruction` 同样错误复用了输入 H/W 符号，按独立签名等长改名；
该图不含 DepthToSpace，不应用 UltraSharp 的 CPU 像素重排绕行。

```bash
RA2_PROBE_MODEL=/path/to/model.onnx RA2_PROBE_MODEL_ID=apisr2x \
RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:graphics:model-probe
```

### NomosUni SPAN 2×

开发模式的「模型实验」可选择 NomosUni SPAN 2×。作者发布页：
Phhofm/models/releases/tag/2xNomosUni_span_multijpg_ldl
仅提供 PTH / safetensors；我们使用官方 safetensors 导出 FP32 ONNX，许可 CC BY 4.0。
导出工具在预热后合并 SPAN 重参数卷积，生成文件 1,656,582 字节，并非量化或换模型。
权重与 ONNX 均不提交、不进入 public/dist。

#### FP32 导出与验证

```bash
# 独立 Python 环境中安装这些固定版本，以复现登记的导出哈希。
pip install torch==2.14.0 spandrel==0.4.2 onnx onnxruntime==1.30.0 numpy
mkdir -p .tmp-models
export NOMOS_WEIGHTS="$PWD/.tmp-models/nomosuni-span-2x.safetensors"
curl -fL "${NOMOS_MODEL_URL:?请设置登记版本的模型地址}" -o "$NOMOS_WEIGHTS"
python scripts/experiments/exportNomosOnnx.py "$NOMOS_WEIGHTS" .tmp-models/nomosuni-span-2x-fp32.onnx
```

官方源 SHA-256：`a3d35e01b8b71b4b3041ad1686f8ebd7bc4e1f3a10378319c2ac61c78b67012a`。
ONNX SHA-256：`bff599f3192122440c2b946a1a9d881ba4dc978e19a36b7dcc8fad73d70d25c0`。
导出脚本对 64×64、48×80 输入验证原生 2× 尺寸、原始数值以及显示钳制后结果；
输入/输出尺寸符号已独立，不应用 UltraSharp 元数据补丁。末端 DepthToSpace 保留
Metal 的 WASM 兼容路径。

FP32 小块探针：

```bash
RA2_PROBE_MODEL="$PWD/.tmp-models/nomosuni-span-2x-fp32.onnx" RA2_PROBE_MODEL_ID=nomos2x \
  RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 pnpm run test:graphics:model-probe
```

FP32 整帧烟测固定读取 `.tmp-models/nomosuni-span-2x-fp32.onnx`，加载 `nomos2x`：

```bash
pnpm exec tsx tests/experimental/browser/nomosLiveBrowserSmoke.mts
```

#### FP16 转换与验证

```bash
pip install onnxconverter-common==1.16.0
python scripts/experiments/convertNomosFp16.py .tmp-models/nomosuni-span-2x-fp32.onnx .tmp-models/nomosuni-span-2x-fp16.onnx
```

FP16 文件 841,058 字节，SHA-256：
`89dbec0fed7a06a0c70ace8b12a937b8f07d11b69aa996dd1ea20d6b9c90b92b`。
采用 ONNX Runtime 推荐的半精度转换方式（非 INT8 量化），输入/输出及卷积使用 FP16；
DepthToSpace 通过 Cast 保留 FP32，便于沿用 Metal/WASM 兼容路径。
FP16 小块探针必须使用支持 `shader-f16` 的 WebGPU 适配器：

```bash
RA2_PROBE_MODEL="$PWD/.tmp-models/nomosuni-span-2x-fp16.onnx" \
RA2_PROBE_MODEL_ID=nomos2x-fp16 RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 \
pnpm run test:graphics:model-probe
```

适配器不支持 `shader-f16` 时应明确拒绝；以下仅验证拒绝路径，不算 FP16 推理通过：

```bash
RA2_PROBE_SOFTWARE=1 RA2_PROBE_EXPECT_NO_F16=1 \
RA2_PROBE_MODEL="$PWD/.tmp-models/nomosuni-span-2x-fp16.onnx" \
RA2_PROBE_MODEL_ID=nomos2x-fp16 RA2_BROWSER_ORIGIN=https://127.0.0.1:15175 \
pnpm run test:graphics:model-probe
```

Nomos FP32 与 FP16 都支持整帧处理，输入上限 800×600，原生输出 1600×1200；
整帧验证在模型实验中选择对应精度并点击「接入整帧显示」。

### 可选离线批量脚本

`scripts/experiments/compareSrModels.py` 使用本地官方权重，对相同截图区域运行 APISR 2×、
AnimeSharpV2 Soft/Sharp 2×、Real-ESRGAN x2plus、NomosUni SPAN 2×、
SuperScale SPAN 1×，另加 UltraSharpV2 Lite 4× 参考。依赖 Pillow、NumPy、
ONNX Runtime、PyTorch、Spandrel；模型路径与来源在脚本的 `MODELS` 中。

```bash
python scripts/experiments/compareSrModels.py "$RA2_FRAME" "$SR_OUTPUT" --weights-dir "$SR_WEIGHTS" \
  --crop '步兵:180:200:128' --crop '地形:310:150:128'
python -m http.server 15176 --bind 127.0.0.1 --directory "$SR_OUTPUT"
```

输出目录必须尚不存在。输出含原图、裁剪位置、原倍率 PNG、统一 2× 展示图、
九宫格及记录来源/权重哈希/CPU 耗时的 `report.json`；不会复制或分发权重。
该工具只读本地模型和截图，输出目录必须是临时目录。
