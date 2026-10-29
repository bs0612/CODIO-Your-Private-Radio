import { PARTICLE_GL_OPTIONS } from "./particle-gl";

// A slow aurora behind the home dashboard: layered value noise shaped into two
// curtains, coloured from the current scene and lifted by the music's bass.
// It is one full-screen triangle at a quarter of the device resolution, so a
// frame costs a few hundred microseconds on any GPU; software rasterizers never
// create it and keep the CSS ambient washes instead.

export type AuroraPalette = {
  a: readonly [number, number, number];
  b: readonly [number, number, number];
  c: readonly [number, number, number];
  accent: readonly [number, number, number];
};

export type AuroraFrame = {
  time: number;
  energy: number;
  pointerX: number;
  pointerY: number;
  opacity: number;
  palette: AuroraPalette;
};

export type AuroraRenderer = {
  resize: (deviceWidth: number, deviceHeight: number) => void;
  render: (frame: AuroraFrame) => void;
  isLost: () => boolean;
};

const AURORA_VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * .5 + .5;
  gl_Position = vec4(aPosition, 0., 1.);
}`;

const AURORA_FRAGMENT_SHADER = `
precision mediump float;
varying vec2 vUv;
uniform float uTime;
uniform vec2 uAspect;
uniform vec2 uPointer;
uniform float uEnergy;
uniform float uOpacity;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform vec3 uAccent;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
}
float fbm(vec2 p) {
  float value = 0.;
  float amplitude = .5;
  for (int octave = 0; octave < 4; octave++) {
    value += amplitude * noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    amplitude *= .5;
  }
  return value;
}
void main() {
  vec2 p = (vUv - .5) * uAspect + uPointer * .07;
  float t = uTime * .05;
  float warp = fbm(p * 1.25 + vec2(t * .6, -t * .35));
  float curtain = smoothstep(.43, .8, fbm(vec2(p.x * 1.5 + t, p.y * 2.6 - t * .4 + warp * .9)));
  float veil = smoothstep(.5, .86, fbm(vec2(p.x * .9 - t * .7, p.y * 1.8 + t * .3 - warp * .7) + 5.2));
  float sky = smoothstep(-.05, .5, vUv.y) * (1. - smoothstep(.78, 1.08, vUv.y));
  vec3 color = uColorB * curtain + uColorA * veil * .9 + uColorC * curtain * veil * .8;
  color += uAccent * (curtain * .22 + uEnergy * .55 * veil);
  float alpha = clamp((curtain * .62 + veil * .46) * sky * uOpacity * (.85 + uEnergy * .6), 0., .92);
  gl_FragColor = vec4(color * alpha, alpha);
}`;

const auroraRenderers = new WeakMap<HTMLCanvasElement, AuroraRenderer>();

// One renderer per canvas: an effect that restarts (scene change, Now Playing
// closing) reuses the compiled program instead of linking it again.
export function acquireAuroraRenderer(canvas: HTMLCanvasElement) {
  const existing = auroraRenderers.get(canvas);
  if (existing) return existing;
  const renderer = createAuroraRenderer(canvas);
  if (renderer) auroraRenderers.set(canvas, renderer);
  return renderer;
}

export function createAuroraRenderer(canvas: HTMLCanvasElement): AuroraRenderer | null {
  const gl = canvas.getContext("webgl", PARTICLE_GL_OPTIONS);
  if (!gl) return null;
  let program: WebGLProgram | null = null;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let lost = false;
  let size = { width: 1, height: 1 };

  const compile = (type: number, code: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const initialize = () => {
    const vertex = compile(gl.VERTEX_SHADER, AURORA_VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, AURORA_FRAGMENT_SHADER);
    program = gl.createProgram();
    const buffer = gl.createBuffer();
    if (!vertex || !fragment || !program || !buffer) return false;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // One oversized triangle covers the viewport without a diagonal seam.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    uniforms = Object.fromEntries(["uTime", "uAspect", "uPointer", "uEnergy", "uOpacity", "uColorA", "uColorB", "uColorC", "uAccent"]
      .map((name) => [name, gl.getUniformLocation(program!, name)]));
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.viewport(0, 0, size.width, size.height);
    return true;
  };
  if (!initialize()) return null;
  canvas.addEventListener("webglcontextlost", (event) => { event.preventDefault(); lost = true; });
  canvas.addEventListener("webglcontextrestored", () => { lost = !initialize(); });

  return {
    resize(deviceWidth, deviceHeight) {
      size = { width: Math.max(1, deviceWidth), height: Math.max(1, deviceHeight) };
      if (!lost) gl.viewport(0, 0, size.width, size.height);
    },
    render({ time, energy, pointerX, pointerY, opacity, palette }) {
      if (lost) return;
      const aspect = size.width / Math.max(1, size.height);
      gl.uniform1f(uniforms.uTime, time);
      gl.uniform2f(uniforms.uAspect, aspect >= 1 ? aspect : 1, aspect >= 1 ? 1 : 1 / aspect);
      gl.uniform2f(uniforms.uPointer, pointerX, pointerY);
      gl.uniform1f(uniforms.uEnergy, Math.max(0, Math.min(1, energy)));
      gl.uniform1f(uniforms.uOpacity, Math.max(0, Math.min(1, opacity)));
      gl.uniform3f(uniforms.uColorA, palette.a[0], palette.a[1], palette.a[2]);
      gl.uniform3f(uniforms.uColorB, palette.b[0], palette.b[1], palette.b[2]);
      gl.uniform3f(uniforms.uColorC, palette.c[0], palette.c[1], palette.c[2]);
      gl.uniform3f(uniforms.uAccent, palette.accent[0], palette.accent[1], palette.accent[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    isLost: () => lost,
  };
}

// Scene colours live in CSS custom properties. Accept the forms the stylesheet
// uses (#rgb, #rrggbb, rgb()/rgba(), and the bare "r, g, b" of --accent-rgb).
export function parseCssColor(value: string | null | undefined, fallback: readonly [number, number, number]): [number, number, number] {
  const text = (value || "").trim();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const digits = hex.length === 3 ? hex.split("").map((digit) => digit + digit) : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
    return [parseInt(digits[0], 16) / 255, parseInt(digits[1], 16) / 255, parseInt(digits[2], 16) / 255];
  }
  const channels = text.replace(/^rgba?\(/i, "").replace(/\)$/, "").split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
  if (channels.length === 3 && channels.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255)) {
    return [channels[0] / 255, channels[1] / 255, channels[2] / 255];
  }
  return [fallback[0], fallback[1], fallback[2]];
}
