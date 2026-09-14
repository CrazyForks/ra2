import type { FsrMode } from './vmFrameRenderer';

/** 实验性空间重建开关；不是 AI/时域超分，也不改变客体渲染分辨率。 */
export function spatialUpscaleEnabled(search: string): boolean {
  return new URLSearchParams(search).get('sr') === '1';
}

/** FSR 1.0（AMD FidelityFX）空间超采样；?sr=fsr / fsr-rcas / fsr-rcas-soft 启动即开启。 */
export function fsrUpscaleMode(search: string): FsrMode | null {
  const value = new URLSearchParams(search).get('sr');
  return value === 'fsr' || value === 'fsr-rcas' || value === 'fsr-rcas-soft' ? value : null;
}

/** ScaleFX 3× 像素画边缘插值；?sr=scalefx 启动即开启。 */
export function scalefxUpscaleEnabled(search: string): boolean {
  return new URLSearchParams(search).get('sr') === 'scalefx';
}

export function aiUpscaleEnabled(search: string): boolean {
  return new URLSearchParams(search).get('sr') === 'ai';
}

/** 单 pass 抗振铃 Catmull–Rom 重建；直接读取原始纹理，不需要 CPU 展开或中间帧。 */
export function spatialUpscaleShader(format: 'indexed' | 'rgba' | 'rgb565'): string {
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
    vec4 weights(float t) {
      float t2 = t * t, t3 = t2 * t;
      return vec4(-0.5*t + t2 - 0.5*t3, 1.0 - 2.5*t2 + 1.5*t3,
                  0.5*t + 2.0*t2 - 1.5*t3, -0.5*t2 + 0.5*t3);
    }
    void main() {
      vec2 size = vec2(textureSize(${texture}, 0));
      // 1:1 或缩小时保留原采样，不让实验开关改变原生像素。
      if (!upscale) { color = readPixel(ivec2(floor(uv * size))); return; }
      vec2 position = uv * size - 0.5;
      ivec2 base = ivec2(floor(position));
      vec4 wx = weights(fract(position.x)), wy = weights(fract(position.y));
      vec4 sum = vec4(0.0), low = vec4(1.0), high = vec4(0.0);
      for (int y = 0; y < 4; ++y) {
        for (int x = 0; x < 4; ++x) {
          vec4 value = readPixel(base + ivec2(x - 1, y - 1));
          sum += value * wx[x] * wy[y];
          // 中央 2×2 的颜色范围限制负瓣过冲，减少文字和高反差边缘的光晕。
          if (x >= 1 && x <= 2 && y >= 1 && y <= 2) {
            low = min(low, value); high = max(high, value);
          }
        }
      }
      color = clamp(sum, low, high);
    }
  `;
}
