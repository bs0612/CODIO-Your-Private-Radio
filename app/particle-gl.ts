// The album field draws tens of thousands of squares per frame. Canvas 2D pays a
// style parse and a draw call for each, so weaker machines had to drop density.
// Point sprites carry the same squares to the GPU in one draw call; the fragment
// shader reproduces fillRect's analytic edge coverage so the image is unchanged.
// A second, optional pass draws a soft additive halo behind every square so the
// field can bloom with the music at no CPU cost.

export type ParticleGlRenderer = {
  resize: (deviceWidth: number, deviceHeight: number, ratio: number) => void;
  begin: () => void;
  push: (x: number, y: number, size: number, rgb: readonly number[], alpha: number) => void;
  /** Present the collected points. `glow` (0..1) adds the halo pass. */
  flush: (glow?: number) => void;
  clear: () => void;
};

const particleGlRenderers = new WeakMap<HTMLCanvasElement, ParticleGlRenderer>();
const PARTICLE_VERTEX_BYTES = 16;
const ATTRIBUTE_RECT = 0;
const ATTRIBUTE_COLOR = 1;

const PARTICLE_VERTEX_SHADER = `
attribute vec3 aRect;
attribute vec4 aColor;
uniform vec2 uResolution;
uniform float uScale;
varying vec4 vColor;
varying vec4 vBounds;
void main() {
  float size = aRect.z * uScale;
  vec2 topLeft = aRect.xy * uScale;
  vec2 center = topLeft + size * .5;
  gl_Position = vec4(center.x / uResolution.x * 2. - 1., 1. - center.y / uResolution.y * 2., 0., 1.);
  gl_PointSize = ceil(size) + 2.;
  float top = uResolution.y - topLeft.y;
  vBounds = vec4(topLeft.x, top - size, topLeft.x + size, top);
  vColor = aColor;
}`;
const PARTICLE_FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec4 vColor;
varying vec4 vBounds;
void main() {
  vec2 span = clamp(min(gl_FragCoord.xy + .5, vBounds.zw) - max(gl_FragCoord.xy - .5, vBounds.xy), 0., 1.);
  float alpha = vColor.a * span.x * span.y;
  if (alpha <= 0.) discard;
  gl_FragColor = vec4(vColor.rgb * alpha, alpha);
}`;

// The halo is a gaussian disc centred on each square, several squares wide,
// blended additively so overlapping particles brighten like light would.
const GLOW_VERTEX_SHADER = `
attribute vec3 aRect;
attribute vec4 aColor;
uniform vec2 uResolution;
uniform float uScale;
uniform float uSpread;
varying vec4 vColor;
varying vec3 vSpot;
void main() {
  float size = aRect.z * uScale;
  vec2 center = aRect.xy * uScale + size * .5;
  gl_Position = vec4(center.x / uResolution.x * 2. - 1., 1. - center.y / uResolution.y * 2., 0., 1.);
  float radius = clamp(size * uSpread, 3., 18.);
  gl_PointSize = radius * 2. + 2.;
  vSpot = vec3(center.x, uResolution.y - center.y, radius);
  vColor = aColor;
}`;
const GLOW_FRAGMENT_SHADER = `
precision mediump float;
uniform float uGlow;
varying vec4 vColor;
varying vec3 vSpot;
void main() {
  float d = length(gl_FragCoord.xy - vSpot.xy) / vSpot.z;
  if (d >= 1.) discard;
  float falloff = exp(-d * d * 4.2) * (1. - d);
  float alpha = vColor.a * falloff * uGlow;
  gl_FragColor = vec4(vColor.rgb * alpha, alpha);
}`;

function createParticleGlRenderer(canvas: HTMLCanvasElement, gl: WebGLRenderingContext): ParticleGlRenderer | null {
  let program: WebGLProgram | null = null;
  let glowProgram: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let resolutionUniform: WebGLUniformLocation | null = null;
  let scaleUniform: WebGLUniformLocation | null = null;
  let glowResolutionUniform: WebGLUniformLocation | null = null;
  let glowScaleUniform: WebGLUniformLocation | null = null;
  let glowSpreadUniform: WebGLUniformLocation | null = null;
  let glowUniform: WebGLUniformLocation | null = null;
  let lost = false;
  let size = { width: 1, height: 1, ratio: 1 };
  let bytes = new Uint8ClampedArray(PARTICLE_VERTEX_BYTES * 4096);
  let floats = new Float32Array(bytes.buffer);
  let count = 0;

  const compile = (type: number, code: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const link = (vertexCode: string, fragmentCode: string) => {
    const vertex = compile(gl.VERTEX_SHADER, vertexCode);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentCode);
    const linked = gl.createProgram();
    if (!vertex || !fragment || !linked) return null;
    gl.attachShader(linked, vertex);
    gl.attachShader(linked, fragment);
    // Both programs share one interleaved buffer layout, so the attribute
    // pointers set once below stay valid when switching programs.
    gl.bindAttribLocation(linked, ATTRIBUTE_RECT, "aRect");
    gl.bindAttribLocation(linked, ATTRIBUTE_COLOR, "aColor");
    gl.linkProgram(linked);
    return gl.getProgramParameter(linked, gl.LINK_STATUS) ? linked : null;
  };
  const applySize = () => {
    gl.viewport(0, 0, size.width, size.height);
    if (glowProgram) {
      gl.useProgram(glowProgram);
      gl.uniform2f(glowResolutionUniform, size.width, size.height);
      gl.uniform1f(glowScaleUniform, size.ratio);
    }
    gl.useProgram(program);
    gl.uniform2f(resolutionUniform, size.width, size.height);
    gl.uniform1f(scaleUniform, size.ratio);
  };
  const initialize = () => {
    program = link(PARTICLE_VERTEX_SHADER, PARTICLE_FRAGMENT_SHADER);
    buffer = gl.createBuffer();
    if (!program || !buffer) return false;
    // The halo is decorative: a driver that rejects it still gets the field.
    glowProgram = link(GLOW_VERTEX_SHADER, GLOW_FRAGMENT_SHADER);
    if (glowProgram) {
      glowResolutionUniform = gl.getUniformLocation(glowProgram, "uResolution");
      glowScaleUniform = gl.getUniformLocation(glowProgram, "uScale");
      glowSpreadUniform = gl.getUniformLocation(glowProgram, "uSpread");
      glowUniform = gl.getUniformLocation(glowProgram, "uGlow");
      gl.useProgram(glowProgram);
      gl.uniform1f(glowSpreadUniform, 3.2);
    }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(ATTRIBUTE_RECT);
    gl.vertexAttribPointer(ATTRIBUTE_RECT, 3, gl.FLOAT, false, PARTICLE_VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(ATTRIBUTE_COLOR);
    gl.vertexAttribPointer(ATTRIBUTE_COLOR, 4, gl.UNSIGNED_BYTE, true, PARTICLE_VERTEX_BYTES, 12);
    resolutionUniform = gl.getUniformLocation(program, "uResolution");
    scaleUniform = gl.getUniformLocation(program, "uScale");
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    applySize();
    // Drivers may finish linking on first use. Pay that once here rather than
    // inside the first measured frame that selects the particle density.
    gl.bufferData(gl.ARRAY_BUFFER, bytes.subarray(0, PARTICLE_VERTEX_BYTES), gl.STREAM_DRAW);
    gl.drawArrays(gl.POINTS, 0, 1);
    if (glowProgram) {
      gl.useProgram(glowProgram);
      gl.drawArrays(gl.POINTS, 0, 1);
      gl.useProgram(program);
    }
    gl.clear(gl.COLOR_BUFFER_BIT);
    return true;
  };
  if (!initialize()) return null;
  canvas.addEventListener("webglcontextlost", (event) => { event.preventDefault(); lost = true; });
  canvas.addEventListener("webglcontextrestored", () => { lost = !initialize(); });

  return {
    resize(deviceWidth, deviceHeight, ratio) {
      size = { width: Math.max(1, deviceWidth), height: Math.max(1, deviceHeight), ratio };
      if (!lost) applySize();
    },
    begin() { count = 0; },
    push(x, y, pointSize, rgb, alpha) {
      if ((count + 1) * PARTICLE_VERTEX_BYTES > bytes.length) {
        const grown = new Uint8ClampedArray(bytes.length * 2);
        grown.set(bytes);
        bytes = grown;
        floats = new Float32Array(bytes.buffer);
      }
      const floatOffset = count * 4;
      const byteOffset = count * PARTICLE_VERTEX_BYTES + 12;
      floats[floatOffset] = x;
      floats[floatOffset + 1] = y;
      floats[floatOffset + 2] = pointSize;
      bytes[byteOffset] = Math.round(rgb[0]);
      bytes[byteOffset + 1] = Math.round(rgb[1]);
      bytes[byteOffset + 2] = Math.round(rgb[2]);
      bytes[byteOffset + 3] = Math.round(Math.min(1, alpha) * 255);
      count += 1;
    },
    flush(glow = 0) {
      if (lost) return;
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!count) return;
      gl.bufferData(gl.ARRAY_BUFFER, bytes.subarray(0, count * PARTICLE_VERTEX_BYTES), gl.STREAM_DRAW);
      if (glow > 0 && glowProgram) {
        gl.useProgram(glowProgram);
        gl.uniform1f(glowUniform, Math.min(1, glow));
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.drawArrays(gl.POINTS, 0, count);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(program);
      }
      gl.drawArrays(gl.POINTS, 0, count);
    },
    clear() { count = 0; if (!lost) gl.clear(gl.COLOR_BUFFER_BIT); },
  };
}

// Software WebGL is slower than Canvas 2D, so require a real GPU. A canvas that
// has taken a WebGL context can never fall back to 2D, so prove the shaders on a
// throwaway canvas before claiming the visible one.
export const PARTICLE_GL_OPTIONS: WebGLContextAttributes = {
  alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
  preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: true,
};
let acceleratedWebGl: boolean | undefined;

// Also tells the page whether the browser is rasterizing without a GPU, where
// full-screen backdrop blurs cost far more than anything drawn on the canvases.
export function hasAcceleratedWebGl() {
  if (acceleratedWebGl !== undefined) return acceleratedWebGl;
  try {
    const probe = document.createElement("canvas");
    const probeGl = probe.getContext("webgl", PARTICLE_GL_OPTIONS);
    acceleratedWebGl = Boolean(probeGl && createParticleGlRenderer(probe, probeGl));
    probeGl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    acceleratedWebGl = false;
  }
  return acceleratedWebGl;
}

export function acquireParticleGlRenderer(canvas: HTMLCanvasElement) {
  const existing = particleGlRenderers.get(canvas);
  if (existing) return existing;
  if (!hasAcceleratedWebGl()) return null;
  const gl = canvas.getContext("webgl", PARTICLE_GL_OPTIONS);
  const renderer = gl ? createParticleGlRenderer(canvas, gl) : null;
  if (renderer) particleGlRenderers.set(canvas, renderer);
  return renderer;
}
