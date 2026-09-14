import gan from './vendor/Anime4K_Upscale_GAN_x2_M.glsl?raw';

export interface AiPass {
  name: string;
  inputs: string[];
  uniforms: string[];
  scale: 1 | 2;
  shader: string;
}

/** 只适配仓库内固定的 GAN 模型，不接受用户提供的 shader 或任意 mpv 指令。 */
export function anime4kGanPasses(): AiPass[] {
  const blocks = gan.split('//!DESC ').slice(1);
  if (blocks.length !== 23) throw new Error('GAN 模型层数不符');
  return blocks.map((block, index) => {
    const inputs = [...block.matchAll(/^\/\/!BIND (\w+)$/gm)].map((m) => m[1]!);
    const name = block.match(/^\/\/!SAVE (\w+)$/m)?.[1];
    if (!name || !inputs.length || inputs.length > 8 || !block.includes('#define')) throw new Error('GAN 模型绑定不符');
    const uniforms = inputs.map((input) => `tex_${input}`);
    const final = index === blocks.length - 1;
    const samplers = inputs
      .map(
        (input, i) => `
      uniform sampler2D ${uniforms[i]};
      #define ${input}_pos uv
      ${
        final
          ? `#define ${input}_tex(p) texture(${uniforms[i]}, p)`
          : `#define ${input}_tex(p) texelFetch(${uniforms[i]}, clamp(ivec2((p) * vec2(textureSize(${uniforms[i]}, 0))), ivec2(0), textureSize(${uniforms[i]}, 0)-1), 0)`
      }
      // 模型偏移按图像顶行递增，FBO 从底行递增；最终层的半像素偏移不能取整。
      ${
        final
          ? `#define ${input}_texOff(p) ${input}_tex(uv + (p) * vec2(1.0, -1.0) / vec2(textureSize(${uniforms[i]}, 0)))`
          : `#define ${input}_texOff(p) texelFetch(${uniforms[i]}, clamp(ivec2(gl_FragCoord.xy) + ivec2((p) * vec2(1.0, -1.0)), ivec2(0), textureSize(${uniforms[i]}, 0)-1), 0)`
      }
    `,
      )
      .join('\n');
    return {
      name,
      inputs,
      uniforms,
      scale: final ? 2 : 1,
      shader: `#version 300 es
        precision highp float;
        in vec2 uv;
        out vec4 color;
        ${samplers}
        ${block.slice(block.indexOf('#define'))}
        void main() { color = hook(); }
      `,
    };
  });
}

/** 分支残差网络不能用简单双缓冲：按最后一次使用复用纹理，避免覆盖仍需读取的特征。 */
export function planAiSurfaces(passes: readonly AiPass[]) {
  const lastUse = new Map<string, number>();
  passes.forEach((pass, index) => pass.inputs.forEach((name) => lastUse.set(name, index)));
  const slots = new Map<string, number>([['MAIN', 0]]);
  const aliveUntil: number[] = [];
  const inputs: number[][] = [],
    outputs: number[] = [];
  passes.forEach((pass, index) => {
    inputs.push(
      pass.inputs.map((name) => {
        const slot = slots.get(name);
        if (slot === undefined) throw new Error(`AI 依赖尚未产生：${name}`);
        return slot;
      }),
    );
    if (pass.scale === 2) {
      if (index !== passes.length - 1) throw new Error('仅支持最后一层放大');
      outputs.push(-1);
      return;
    }
    let slot = aliveUntil.findIndex((end) => end < index);
    if (slot < 0) slot = aliveUntil.length;
    aliveUntil[slot] = lastUse.get(pass.name) ?? index;
    outputs.push(slot + 1);
    slots.set(pass.name, slot + 1);
  });
  const output = aliveUntil.length + 1;
  if (outputs.at(-1) !== -1) throw new Error('AI 模型缺少输出层');
  outputs[outputs.length - 1] = output;
  return { inputs, outputs, featureCount: aliveUntil.length, output };
}
