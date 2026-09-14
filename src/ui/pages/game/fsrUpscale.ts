/**
 * AMD FidelityFX Super Resolution 1.0 — EASU（边缘自适应空间超采样）。
 *
 * 算法移植自 GPUOpen-Effects/FidelityFX-FSR 的 ffx_fsr1.h（FSR 1，v1.20210629），
 * MIT 许可，版权声明见下方注释与 vendor/README.md：
 *
 *   FidelityFX Super Resolution Sample
 *   Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files(the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and / or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions :
 *   The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 *   THE SOFTWARE.
 *
 * 适配（与官方实现的差异，数学部分逐行保留）：
 * - 官方用 gather4 取 12 个抽头、CPU 打包 con0–con3 常量；本移植按客体帧格式
 *   （索引 / RGBA / RGB565 三种）用 texelFetch 直接取点，输出像素到输入的映射
 *   经 uv 恒等化简后与官方一致，无需打包常量。
 * - 快速倒数/开方近似（fsrRcp / fsrRsq）沿用官方位运算版本：对 0 输入返回
 *   有限大数，平色区域不会像精确 1/x 那样产生 NaN。
 * - 缩小或 1:1 时走原采样直通，不改变原生像素（与 bicubic 路径同一约定）。
 */

const FSr_COMMON = `
// ===== FSR EASU（移植自 ffx_fsr1.h，MIT，见文件头）=====
// 官方 APrxLoRcpF1 / APrxLoRsqF1 位运算近似：有限值输出是平色区稳定的前提。
float fsrRcp(float a) { return uintBitsToFloat(0x7ef07ebbu - floatBitsToUint(a)); }
float fsrRsq(float a) { return uintBitsToFloat(0x5f347d74u - (floatBitsToUint(a) >> 1u)); }
// 官方「最简多通道近似亮度」：0.5*R + G + 0.5*B（2 FMA）。
float fsrLuma(vec3 c) { return c.r * 0.5 + c.g + c.b * 0.5; }

// 累加方向与长度（官方 FsrEasuSetF，双线性权重由调用方按 pp 给出）。
void fsrSet(
  vec2 pp, float w, float lA, float lB, float lC, float lD, float lE, inout vec2 dir, inout float len) {
  float dc = lD - lC;
  float cb = lC - lB;
  float lenX = max(abs(dc), abs(cb));
  lenX = fsrRcp(lenX);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  lenX *= lenX;
  len += lenX * w;
  float ec = lE - lC;
  float ca = lC - lA;
  float lenY = max(abs(ec), abs(ca));
  lenY = fsrRcp(lenY);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  lenY *= lenY;
  len += lenY * w;
}

// 单抽头滤波（官方 FsrEasuTapF：旋转、各向异性、lanczos2 近似、负瓣）。
void fsrTap(
  inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {
  vec2 v;
  v.x = off.x * dir.x + off.y * dir.y;
  v.y = off.x * (-dir.y) + off.y * dir.x;
  v *= len;
  float d2 = v.x * v.x + v.y * v.y;
  d2 = min(d2, clp);
  float wB = (2.0 / 5.0) * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
  float w = wB * wA;
  aC += c * w;
  aW += w;
}
`;

/** FSR 1.0 RCAS 锐化 pass：读取 EASU 放大后的中间 RGBA 纹理，单 pass 输出。
 * sharpness 采用官方语义：0 = 最大锐化，越大越柔和（内部按 2^-sharpness 缩放）。 */
export function fsrRcasShader(sharpness: number): string {
  // 官方 FsrRcasCon 的档位换算：stops → 线性。
  const scale = Math.pow(2, -sharpness).toFixed(9);
  return `#version 300 es
    precision highp float;
    precision highp int;
    uniform sampler2D easuFrame;
    in vec2 uv;
    out vec4 color;
    // ===== FSR RCAS（移植自 ffx_fsr1.h，MIT，见文件头）=====
    // 官方 APrxMedRcpF1 中精度倒数近似：避免可见的色调阶梯。
    float rcasMedRcp(float a) { float b = uintBitsToFloat(0x7ef19fffu - floatBitsToUint(a)); return b * (-b * a + 2.0); }
    // FSR_RCAS_DENOISE 未启用（官方建议噪声在锐化之后另行处理），噪声检测分支省略。
    vec4 rcasLoad(ivec2 p) {
      p = clamp(p, ivec2(0), textureSize(easuFrame, 0) - 1);
      return texelFetch(easuFrame, p, 0);
    }
    void main() {
      // 官方以输出整数像素 sp 取 3×3 十字邻域；uv 即输出像素位置，sp = uv*size。
      // FBO 写入端按 gl_FragCoord（自下而上）落行，采样端按屏幕 uv（自上而下），
      // 因此必须翻转 Y：否则 EASU→RCAS 整条链上下颠倒（曾实际发生）。
      ivec2 sp = ivec2(floor(uv * vec2(textureSize(easuFrame, 0))));
      sp.y = textureSize(easuFrame, 0).y - 1 - sp.y;
      vec3 b = rcasLoad(sp + ivec2(0, -1)).rgb;
      vec3 d = rcasLoad(sp + ivec2(-1, 0)).rgb;
      vec3 e = rcasLoad(sp).rgb;
      vec3 f = rcasLoad(sp + ivec2(1, 0)).rgb;
      vec3 h = rcasLoad(sp + ivec2(0, 1)).rgb;
      // 环（上下左右）的逐通道 min/max。
      vec3 mn4 = min(min(b, d), min(f, h));
      vec3 mx4 = max(max(b, d), max(f, h));
      // 官方限制器（高精度倒数）；分母加极小钳制：纯白/纯黑块下官方 0×∞
      // 会产生 NaN，社区移植常规以钳制规避，仅影响病态输入。
      vec3 hitMin = min(mn4, e) * (1.0 / max(4.0 * mx4, 1e-4));
      vec3 hitMax = (vec3(1.0) - max(mx4, e)) * (1.0 / max(4.0 * mn4 - 4.0, 1e-4));
      vec3 lobe3 = max(-hitMin, hitMax);
      float lobe = max(-(0.25 - (1.0 / 16.0)), min(max(lobe3.x, max(lobe3.y, lobe3.z)), 0.0)) * ${scale};
      float rcpL = rcasMedRcp(4.0 * lobe + 1.0);
      color = vec4((lobe * (b + d + h + f) + e) * rcpL, 1.0);
    }
  `;
}

/** 单 pass FSR 1.0 EASU 片段着色器；三种客体帧格式共用同一套滤波数学。 */
export function fsrUpscaleShader(format: 'indexed' | 'rgba' | 'rgb565'): string {
  const texture = format === 'indexed' ? 'indexedFrame' : format === 'rgba' ? 'rgbaFrame' : 'packedFrame';
  const sample =
    format === 'indexed'
      ? 'int index = int(texelFetch(indexedFrame, p, 0).r * 255.0 + 0.5); return vec4(texelFetch(palette, ivec2(index, 0), 0).rgb, 1.0);'
      : format === 'rgba'
        ? 'return texelFetch(rgbaFrame, p, 0);'
        : `uint bits = texelFetch(packedFrame, p, 0).r;
         uvec3 rgb = uvec3((bits >> 11u) & 31u, (bits >> 5u) & 63u, bits & 31u);
         rgb = (rgb << uvec3(3u, 2u, 3u)) | (rgb >> uvec3(2u, 4u, 2u));
         return vec4(vec3(rgb) / 255.0, 1.0);`;
  const taps = (() => {
    const letters = ['b', 'c', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'n', 'o'] as const;
    const offsets: Record<(typeof letters)[number], string> = {
      b: 'vec2(-1.0, -1.0)',
      c: 'vec2(0.0, -1.0)',
      e: 'vec2(-1.0, 0.0)',
      f: 'vec2(0.0, 0.0)',
      g: 'vec2(1.0, 0.0)',
      h: 'vec2(2.0, 0.0)',
      i: 'vec2(-1.0, 1.0)',
      j: 'vec2(0.0, 1.0)',
      k: 'vec2(1.0, 1.0)',
      l: 'vec2(2.0, 1.0)',
      n: 'vec2(0.0, 2.0)',
      o: 'vec2(1.0, 2.0)',
    };
    return letters.map((l) => `  vec3 ${l}C = readPixel(ivec2(fp + ${offsets[l]})).rgb;`).join('\n');
  })();
  // 官方 12-tap 核的四个双线性角区（FsrEasuF 的 FsrEasuSetF 调用顺序与权重）。
  const sets = `
  fsrSet(pp, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL, dir, len);
  fsrSet(pp, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL, dir, len);
  fsrSet(pp, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL, dir, len);
  fsrSet(pp, pp.x * pp.y, gL, jL, kL, lL, oL, dir, len);`;
  // 官方 12 个抽头的顺序与相对 'f' 的偏移。
  const tapCalls = `
  fsrTap(aC, aW, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, bC); // b
  fsrTap(aC, aW, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, cC); // c
  fsrTap(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, iC); // i
  fsrTap(aC, aW, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, jC); // j
  fsrTap(aC, aW, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, fC); // f
  fsrTap(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, eC); // e
  fsrTap(aC, aW, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, kC); // k
  fsrTap(aC, aW, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, lC); // l
  fsrTap(aC, aW, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, hC); // h
  fsrTap(aC, aW, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, gC); // g
  fsrTap(aC, aW, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, oC); // o
  fsrTap(aC, aW, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, nC); // n`;
  return `#version 300 es
    precision highp float;
    precision highp int;
    uniform ${format === 'rgb565' ? 'highp usampler2D' : 'sampler2D'} ${texture};
    ${format === 'indexed' ? 'uniform sampler2D palette;' : ''}
    uniform bool upscale;
    in vec2 uv;
    out vec4 color;
    vec4 readPixel(ivec2 p) {
      p = clamp(p, ivec2(0), textureSize(${texture}, 0) - 1);
      ${sample}
    }
    ${FSr_COMMON}
    void main() {
      vec2 size = vec2(textureSize(${texture}, 0));
      // 1:1 或缩小时保留原采样，不改变原生像素。
      if (!upscale) { color = readPixel(ivec2(floor(uv * size))); return; }
      // 官方把输出整数像素 ip 映射回输入：pp = ip*scale + 0.5*scale - 0.5。
      // 全屏四边形的 uv 落在输出像素中心（ip = uv*outputSize - 0.5），代入上式
      // 恒等化简为 uv*size - 0.5，与 bicubic 路径同一约定；直接用 uv 也避免了
      // WebGL gl_FragCoord 与官方 Vulkan 示例的 Y 轴方向差异（曾导致画面上下颠倒）。
      vec2 pp = uv * size - 0.5;
      vec2 fp = floor(pp);
      pp -= fp;
${taps}
      float bL = fsrLuma(bC), cL = fsrLuma(cC), eL = fsrLuma(eC), fL = fsrLuma(fC);
      float gL = fsrLuma(gC), hL = fsrLuma(hC), iL = fsrLuma(iC), jL = fsrLuma(jC);
      float kL = fsrLuma(kC), lL = fsrLuma(lC), nL = fsrLuma(nC), oL = fsrLuma(oC);
      vec2 dir = vec2(0.0);
      float len = 0.0;${sets}
      // 归一化（官方近似）并在接近零时回退为水平方向。
      vec2 dir2 = dir * dir;
      float dirR = dir2.x + dir2.y;
      bool zro = dirR < (1.0 / 32768.0);
      dirR = fsrRsq(dirR);
      dirR = zro ? 1.0 : dirR;
      dir.x = zro ? 1.0 : dir.x;
      dir *= dirR;
      len = len * 0.5;
      len *= len;
      float stretch = (dir.x * dir.x + dir.y * dir.y) * fsrRcp(max(abs(dir.x), abs(dir.y)));
      vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 + (-0.5) * len);
      float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
      float clp = fsrRcp(lob);
      // 最近 4 邻域（f/g/j/k）的颜色范围做去振铃钳位。
      vec3 min4 = min(min(fC, gC), min(jC, kC));
      vec3 max4 = max(max(fC, gC), max(jC, kC));
      vec3 aC = vec3(0.0);
      float aW = 0.0;${tapCalls}
      vec3 pix = min(max4, max(min4, aC * (1.0 / aW)));
      color = vec4(pix, 1.0);
    }
  `;
}
