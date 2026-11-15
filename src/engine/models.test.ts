import { describe, it, expect } from 'vitest';
import { MODELS, DEFAULT_MODEL, getModel, isModelId, totalSize } from './models';
import { padTokenIds, stepToX0 } from './scheduler';

describe('registro de modelos', () => {
  it('tem sdxs (padrão) e sd-turbo', () => {
    expect(MODELS.map((m) => m.id).sort()).toEqual(['sd-turbo', 'sdxs']);
    expect(DEFAULT_MODEL).toBe('sdxs');
    expect(isModelId('sdxs')).toBe(true);
    expect(isModelId('outro')).toBe(false);
  });
  it('tamanhos exatos conferidos no Hugging Face', () => {
    expect(getModel('sd-turbo').files.map((f) => f.size)).toEqual([681_393_168, 1_733_430_199, 99_094_314]);
    expect(getModel('sdxs').files.map((f) => f.size)).toEqual([246_280_550, 689_988_794, 2_468_157]);
    expect(totalSize(getModel('sd-turbo'))).toBe(2_513_917_681);
    expect(totalSize(getModel('sdxs'))).toBe(938_737_501);
  });
  it('SD-Turbo mantém os nomes antigos na raiz; o novo usa subpasta', () => {
    expect(getModel('sd-turbo').dir).toBeNull();
    expect(getModel('sd-turbo').files.map((f) => f.name)).toEqual(['text_encoder.onnx', 'unet.onnx', 'vae_decoder.onnx']);
    expect(getModel('sdxs').dir).toBe('sdxs');
  });
  it('cada modelo tem os três tipos de arquivo e o pad certo', () => {
    for (const m of MODELS) expect(m.files.map((f) => f.kind)).toEqual(['text_encoder', 'unet', 'vae_decoder']);
    expect(getModel('sdxs').pipeline.padTokenId).toBe(49407);
    expect(getModel('sd-turbo').pipeline.padTokenId).toBe(0);
  });
});

describe('padTokenIds', () => {
  it('completa com o token de preenchimento até 77', () => {
    const r = padTokenIds([49406, 320, 49407], 77, 49407);
    expect(r.length).toBe(77);
    expect(r.slice(0, 3)).toEqual([49406, 320, 49407]);
    expect(r.slice(3).every((v) => v === 49407)).toBe(true);
    expect(padTokenIds([49406, 49407], 5, 0)).toEqual([49406, 49407, 0, 0, 0]);
  });
  it('corta o excesso e aceita bigint', () => {
    expect(padTokenIds([1n, 2n, 3n, 4n], 2, 0)).toEqual([1, 2]);
  });
});

describe('x0 sem divisão (vaeScale = 1)', () => {
  it('x0 = latents - sigma * eps', () => {
    const x = stepToX0(new Float32Array([10, 0]), new Float32Array([1, 1]), 2, 1);
    expect(Array.from(x)).toEqual([8, -2]);
  });
});
