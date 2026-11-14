import { describe, it, expect } from 'vitest';
import {
  makeLatents, scaleInput, stepToX0, toRGBA, halfToFloat, SIGMA, VAE_SCALE, LATENT_SIZE,
} from './scheduler';

describe('makeLatents', () => {
  it('tem o tamanho 4*64*64', () => {
    expect(makeLatents(1, SIGMA).length).toBe(4 * 64 * 64);
    expect(LATENT_SIZE).toBe(16384);
  });
  it('é determinístico para a mesma semente e muda com outra', () => {
    const a = makeLatents(42, SIGMA);
    const b = makeLatents(42, SIGMA);
    const c = makeLatents(43, SIGMA);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });
  it('tem média ~0 e desvio ~sigma', () => {
    const x = makeLatents(7, SIGMA);
    let sum = 0;
    for (const v of x) sum += v;
    const mean = sum / x.length;
    let sq = 0;
    for (const v of x) sq += (v - mean) ** 2;
    const std = Math.sqrt(sq / x.length);
    expect(Math.abs(mean)).toBeLessThan(0.05 * SIGMA);
    expect(std).toBeGreaterThan(0.97 * SIGMA);
    expect(std).toBeLessThan(1.03 * SIGMA);
  });
  it('é só ruído unitário quando sigma = 1', () => {
    const x = makeLatents(7, 1);
    const y = makeLatents(7, 2);
    expect(y[10]).toBeCloseTo(x[10] * 2, 5);
  });
});

describe('scaleInput', () => {
  it('divide por sqrt(sigma^2+1)', () => {
    const out = scaleInput(Float32Array.from([1, -2, 0]), 3);
    const k = 1 / Math.sqrt(10);
    expect(out[0]).toBeCloseTo(k, 6);
    expect(out[1]).toBeCloseTo(-2 * k, 6);
    expect(out[2]).toBe(0);
  });
});

describe('stepToX0', () => {
  it('calcula (lat - sigma*eps)/vaeScale', () => {
    const out = stepToX0(Float32Array.from([10, 0]), Float32Array.from([1, -2]), 2, 0.5);
    expect(out[0]).toBeCloseTo((10 - 2) / 0.5, 5);
    expect(out[1]).toBeCloseTo((0 + 4) / 0.5, 5);
  });
  it('usa as constantes padrão', () => {
    const out = stepToX0(Float32Array.from([SIGMA]), Float32Array.from([1]));
    expect(out[0]).toBeCloseTo(0, 5);
    expect(VAE_SCALE).toBe(0.18215);
  });
});

describe('toRGBA', () => {
  it('mapeia -1..1 para 0..255 com limites e layout CHW->RGBA', () => {
    // 2 pixels (w=2,h=1): R = [-1, 1], G = [0, 5 (acima)], B = [-5 (abaixo), 0.5]
    const chw = Float32Array.from([-1, 1, 0, 5, -5, 0.5]);
    const px = toRGBA(chw, 2, 1);
    expect(px).toBeInstanceOf(Uint8ClampedArray);
    expect(px.length).toBe(8);
    expect(Array.from(px.slice(0, 4))).toEqual([0, 128, 0, 255]);
    expect(Array.from(px.slice(4, 8))).toEqual([255, 255, 191, 255]);
  });
});

describe('halfToFloat', () => {
  it('converte valores comuns', () => {
    const f = halfToFloat(Uint16Array.from([0x3c00, 0xc000, 0x0000, 0x3800, 0x7c00]));
    expect(Array.from(f.slice(0, 4))).toEqual([1, -2, 0, 0.5]);
    expect(f[4]).toBe(Infinity);
  });
});
