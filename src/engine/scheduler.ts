// Funções puras do "scheduler" de um passo (SD-Turbo, 1 step) e utilidades de imagem.

export const SIGMA = 14.6146;
export const VAE_SCALE = 0.18215;
export const LATENT_C = 4;
export const LATENT_H = 64;
export const LATENT_W = 64;
export const LATENT_SIZE = LATENT_C * LATENT_H * LATENT_W;

/** PRNG determinístico de 32 bits. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ruído gaussiano (Box-Muller) com semente, multiplicado por sigma. */
export function makeLatents(seed: number, sigma: number = SIGMA): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(LATENT_SIZE);
  for (let i = 0; i < LATENT_SIZE; i += 2) {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    out[i] = r * Math.cos(theta) * sigma;
    if (i + 1 < LATENT_SIZE) out[i + 1] = r * Math.sin(theta) * sigma;
  }
  return out;
}

/** x / sqrt(sigma^2 + 1) */
export function scaleInput(latents: Float32Array, sigma: number = SIGMA): Float32Array {
  const k = 1 / Math.sqrt(sigma * sigma + 1);
  const out = new Float32Array(latents.length);
  for (let i = 0; i < latents.length; i++) out[i] = latents[i] * k;
  return out;
}

/** (latents - sigma * eps) / vaeScale  -> entrada do decodificador VAE. */
export function stepToX0(
  latents: Float32Array,
  eps: Float32Array,
  sigma: number = SIGMA,
  vaeScale: number = VAE_SCALE,
): Float32Array {
  const out = new Float32Array(latents.length);
  for (let i = 0; i < latents.length; i++) out[i] = (latents[i] - sigma * eps[i]) / vaeScale;
  return out;
}

/** CHW float (-1..1) -> RGBA 0..255. */
export function toRGBA(chw: Float32Array, w: number, h: number): Uint8ClampedArray {
  const plane = w * h;
  const out = new Uint8ClampedArray(plane * 4);
  for (let i = 0; i < plane; i++) {
    const o = i * 4;
    out[o] = (chw[i] + 1) * 127.5;
    out[o + 1] = (chw[plane + i] + 1) * 127.5;
    out[o + 2] = (chw[2 * plane + i] + 1) * 127.5;
    out[o + 3] = 255;
  }
  return out;
}

/** Converte um float16 (bits em Uint16) para float32. */
export function halfToFloat(h: Uint16Array): Float32Array {
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const v = h[i];
    const s = (v & 0x8000) ? -1 : 1;
    const e = (v >> 10) & 0x1f;
    const m = v & 0x3ff;
    if (e === 0) out[i] = s * Math.pow(2, -14) * (m / 1024);
    else if (e === 31) out[i] = m ? NaN : s * Infinity;
    else out[i] = s * Math.pow(2, e - 15) * (1 + m / 1024);
  }
  return out;
}

/** Garante Float32Array a partir da saída de um tensor (fp32 ou fp16 em Uint16Array). */
export function toFloat32(data: unknown): Float32Array {
  if (data instanceof Float32Array) return data;
  if (data instanceof Uint16Array) return halfToFloat(data);
  if (ArrayBuffer.isView(data)) return Float32Array.from(data as unknown as ArrayLike<number>);
  throw new Error('Tipo de dado de tensor inesperado');
}
