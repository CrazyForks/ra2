import model from './vendor/Anime4K_Upscale_CNN_x2_S.glsl?raw';
import { anime4kGanPasses, planAiSurfaces, type AiPass } from './aiModelGraph';

export type AiModel = 'gan' | 'fast';

/** 固定上游模型适配，不解释任意 mpv 脚本；四层卷积权重原样保留。 */
export function anime4kConvolutionShaders(): string[] {
  const blocks = model.split('//!DESC ').slice(1, 5);
  if (blocks.length !== 4) throw new Error('CNN 模型层数不符');
  return blocks.map((block) => {
    const body = block.slice(block.indexOf('#define')).replace(/(?:MAIN|conv2d(?:_\d+)?_tf)_texOff/g, 'sampleOffset');
    return `#version 300 es
      precision highp float;
      uniform sampler2D source;
      out vec4 color;
      vec4 sampleOffset(vec2 offset) {
        // FBO 行原点在下方，训练模型的图像行原点在上方：只翻转邻域 y。
        ivec2 p = ivec2(gl_FragCoord.xy) + ivec2(offset.x, -offset.y);
        return texelFetch(source, clamp(p, ivec2(0), textureSize(source, 0)-1), 0);
      }
      ${body}
      void main() { color = hook(); }
    `;
  });
}

const vertex = `#version 300 es
  out vec2 uv;
  void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

const reconstruct = `#version 300 es
  precision highp float;
  uniform sampler2D source;
  uniform sampler2D original;
  in vec2 uv;
  out vec4 color;
  void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    // 上游 depth-to-space 的四个通道按从上到下、从左到右排列。
    int channel = (1 - (pixel.y & 1)) * 2 + (pixel.x & 1);
    float residual = texelFetch(source, pixel / 2, 0)[channel];
    color = vec4(clamp(texture(original, uv).rgb + residual, 0.0, 1.0), 1.0);
  }`;

const present = `#version 300 es
  precision highp float;
  uniform sampler2D source;
  in vec2 uv;
  out vec4 color;
  void main() { color = texture(source, uv); }`;

function program(gl: WebGL2RenderingContext, fragment: string, uniforms = ['source']): WebGLProgram {
  const shaders: WebGLShader[] = [];
  const result = gl.createProgram();
  if (!result) throw new Error('CNN program 分配失败');
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('CNN shader 分配失败');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader) ?? 'CNN 编译失败');
      gl.attachShader(result, shader);
    }
    gl.linkProgram(result);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(result) ?? 'CNN 链接失败');
    gl.useProgram(result);
    uniforms.forEach((name, index) => gl.uniform1i(gl.getUniformLocation(result, name), 4 + index));
    return result;
  } catch (error) {
    gl.deleteProgram(result);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

interface Surface {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

/** 只在显式开启且放大时创建 GPU 资源；中间激活必须保留负数，不能用 RGBA8。 */
export class AiUpscale {
  status = 'AI 超分：等待游戏画面';
  private programs: WebGLProgram[] = [];
  private surfaces: Surface[] = [];
  private width = 0;
  private height = 0;
  private cachedFrame: object | null = null;
  private failed = false;
  private destroyed = false;
  private maxTextureSize: number | undefined;
  private passes: AiPass[] = [];
  private plan: ReturnType<typeof planAiSurfaces> | null = null;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly modelKind: AiModel = 'gan',
  ) {}

  prepare(width: number, height: number, targetWidth: number, targetHeight: number): boolean {
    if (this.failed || this.destroyed) return false;
    // 延续上游 >1.2× 条件；未放大时不推理，也不修改原生像素。
    if (targetWidth <= width * 1.2 || targetHeight <= height * 1.2) {
      this.status = 'AI 未启动：放大不足 1.2×，请降低游戏分辨率或放大窗口';
      return false;
    }
    const gl = this.gl;
    // 能力查询只做一次，避免鼠标重绘时反复同步查询 GL 状态。
    this.maxTextureSize ??= gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (width * height > 1920 * 1080 || width * 2 > this.maxTextureSize || height * 2 > this.maxTextureSize) {
      this.status = 'AI 未启动：超出尺寸预算，使用原图';
      return false;
    }
    try {
      if (!this.programs.length) {
        if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('缺少浮点渲染附件');
        this.passes =
          this.modelKind === 'gan'
            ? anime4kGanPasses()
            : [
                ...anime4kConvolutionShaders().map((shader, i): AiPass => ({
                  name: `conv${i}`,
                  inputs: [i ? `conv${i - 1}` : 'MAIN'],
                  uniforms: ['source'],
                  scale: 1,
                  shader,
                })),
                {
                  name: 'output',
                  inputs: ['conv3', 'MAIN'],
                  uniforms: ['source', 'original'],
                  scale: 2,
                  shader: reconstruct,
                },
              ];
        this.plan = planAiSurfaces(this.passes);
        // 逐个登记，编译到中途失败时也能完整释放。
        for (const pass of this.passes) this.programs.push(program(gl, pass.shader, pass.uniforms));
        this.programs.push(program(gl, present));
      }
      if (width * height * (20 + this.plan!.featureCount * 8) > 128 * 1024 * 1024) {
        this.status = 'AI 未启动：超出模型显存预算，请降低游戏分辨率';
        return false;
      }
      if (width !== this.width || height !== this.height) {
        this.releaseSurfaces();
        this.surfaces.push(this.surface(width, height, false, true));
        // GAN 最后一层在半像素位置读取特征，必须沿用上游的线性过滤；
        // nearest 会把学习到的连续特征变成棋盘状颗粒。CNN 的 texelFetch 不受过滤影响。
        for (let i = 0; i < this.plan!.featureCount; i++) this.surfaces.push(this.surface(width, height, true, true));
        this.surfaces.push(this.surface(width * 2, height * 2, false, true));
        this.width = width;
        this.height = height;
      }
      this.status =
        this.modelKind === 'gan' ? 'AI 超分已启动 · GAN-M 2×（画质优先）' : 'AI 超分已启动 · CNN 2×（快速模式）';
      return true;
    } catch (error) {
      this.failed = true;
      this.releaseSurfaces();
      for (const p of this.programs) gl.deleteProgram(p);
      this.programs = [];
      this.status = `AI 不可用，回退原图：${error instanceof Error ? error.message : String(error)}`;
      console.warn(this.status);
      return false;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  hasFrame(frame: object): boolean {
    return this.cachedFrame === frame;
  }

  bindInput(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.surfaces[0]!.framebuffer);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  infer(frame: object): void {
    const gl = this.gl;
    for (let layer = 0; layer < this.passes.length; layer++) {
      this.plan!.inputs[layer]!.forEach((slot, i) => this.bindTexture(slot, 4 + i));
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.surfaces[this.plan!.outputs[layer]!]!.framebuffer);
      const scale = this.passes[layer]!.scale;
      gl.viewport(0, 0, this.width * scale, this.height * scale);
      gl.useProgram(this.programs[layer]!);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    this.cachedFrame = frame;
  }

  draw(width: number, height: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    this.bindTexture(this.plan!.output, 4);
    gl.useProgram(this.programs[this.passes.length]!);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.releaseSurfaces();
    for (const p of this.programs) this.gl.deleteProgram(p);
    this.programs = [];
  }

  private bindTexture(surface: number, unit: number): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.surfaces[surface]!.texture);
  }

  private surface(width: number, height: number, floating: boolean, linear: boolean): Surface {
    const gl = this.gl,
      texture = gl.createTexture(),
      framebuffer = gl.createFramebuffer();
    try {
      if (!texture || !framebuffer) throw new Error('CNN 纹理/帧缓冲分配失败');
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        floating ? gl.RGBA16F : gl.RGBA8,
        width,
        height,
        0,
        gl.RGBA,
        floating ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
        null,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('CNN 帧缓冲不可用');
      return { texture, framebuffer };
    } catch (error) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      throw error;
    }
  }

  private releaseSurfaces(): void {
    for (const surface of this.surfaces) {
      this.gl.deleteTexture(surface.texture);
      this.gl.deleteFramebuffer(surface.framebuffer);
    }
    this.surfaces = [];
    this.cachedFrame = null;
    this.width = this.height = 0;
  }
}
