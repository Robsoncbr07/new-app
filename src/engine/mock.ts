// Motor falso para testar a UI sem WebGPU nem modelo. Só é usado com ?mock=1.
import type { Engine, GenerateResult } from './types';
import { EngineError } from './types';
import { mulberry32 } from './scheduler';
import { getModel, totalSize, type ModelId } from './models';

const key = (id: ModelId) => `atelie-mock-downloaded-${id}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createMockEngine(): Engine {
  const get = (id: ModelId) => {
    try { return localStorage.getItem(key(id)) === '1'; } catch { return false; }
  };
  return {
    async status(id) {
      return { downloaded: get(id), usage: get(id) ? totalSize(getModel(id)) : 0, partial: 0 };
    },
    async download(id, onProgress, signal) {
      const total = totalSize(getModel(id));
      const steps = 15;
      for (let i = 1; i <= steps; i++) {
        await sleep(100);
        if (signal.aborted) throw new EngineError('aborted', 'Download cancelado.');
        const loaded = Math.round((total * i) / steps);
        onProgress({ file: 'mock', fileLoaded: loaded, fileTotal: total, loaded, total });
      }
      try { localStorage.setItem(key(id), '1'); } catch { /* ignore */ }
    },
    async generate(req, onStage): Promise<GenerateResult> {
      const t0 = performance.now();
      const n = getModel(req.modelId).name;
      onStage(`${n}: Lendo o prompt…`);
      await sleep(150);
      onStage(`${n}: Criando a imagem…`);
      await sleep(250);
      onStage(`${n}: Decodificando a imagem…`);
      await sleep(100);
      const w = 512, h = 512;
      const rand = mulberry32(req.seed >>> 0);
      const hue = rand() * 360;
      const hue2 = (hue + 60 + rand() * 120) % 360;
      const c1 = hsl(hue, 0.7, 0.55), c2 = hsl(hue2, 0.7, 0.35);
      const ang = rand() * Math.PI * 2;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const t = Math.min(1, Math.max(0, ((x / w - 0.5) * dx + (y / h - 0.5) * dy) + 0.5));
          const n = (rand() - 0.5) * 24;
          const o = (y * w + x) * 4;
          rgba[o] = c1[0] * (1 - t) + c2[0] * t + n;
          rgba[o + 1] = c1[1] * (1 - t) + c2[1] * t + n;
          rgba[o + 2] = c1[2] * (1 - t) + c2[2] * t + n;
          rgba[o + 3] = 255;
        }
      }
      return { rgba, width: w, height: h, ms: Math.round(performance.now() - t0) };
    },
    async deleteModel(id) {
      try { localStorage.removeItem(key(id)); } catch { /* ignore */ }
    },
  };
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}
