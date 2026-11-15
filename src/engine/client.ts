import type {
  Engine, WorkerReply, WorkerRequest, DownloadProgress, GenerateRequest, GenerateResult, ModelStatus,
} from './types';
import type { ModelId } from './models';
import { EngineError } from './types';

type Req = WorkerRequest extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never;

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: (p: DownloadProgress) => void;
  onStage?: (s: string) => void;
};

/** Proxy do motor real: fala com o worker. */
export function createWorkerEngine(): Engine {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const send = (msg: Omit<WorkerRequest, 'id'> & { id?: number }) => worker.postMessage(msg);

  worker.onmessage = (e: MessageEvent<WorkerReply>) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    switch (m.type) {
      case 'progress': p.onStage?.(m.stage); return;
      case 'downloadProgress': p.onProgress?.(m.progress); return;
      case 'error':
        pending.delete(m.id);
        p.reject(new EngineError(m.code, m.message));
        return;
      default:
        pending.delete(m.id);
        p.resolve(m);
    }
  };
  worker.onerror = (ev) => {
    const err = new EngineError('worker', `Erro interno do motor: ${ev.message || 'desconhecido'}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const call = <T>(msg: Req, extra: Partial<Pending> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, ...extra });
      send({ ...msg, id } as WorkerRequest);
    });

  const ortBase = new URL(import.meta.env.BASE_URL + 'ort/', document.baseURI).href;
  send({ type: 'init', ortBase, id: 0 } as WorkerRequest);

  return {
    async status(modelId: ModelId): Promise<ModelStatus> {
      const r = await call<{ downloaded: boolean; usage: number; partial: number }>({ type: 'status', modelId });
      return { downloaded: r.downloaded, usage: r.usage, partial: r.partial };
    },
    download(modelId, onProgress, signal) {
      return new Promise<void>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve: () => resolve(), reject, onProgress });
        signal.addEventListener('abort', () => send({ type: 'cancelDownload', id: 0 } as WorkerRequest), { once: true });
        send({ type: 'download', modelId, id } as WorkerRequest);
      });
    },
    async generate(req: GenerateRequest, onStage): Promise<GenerateResult> {
      const r = await call<{ rgba: ArrayBuffer; width: number; height: number; ms: number }>(
        { type: 'generate', ...req }, { onStage },
      );
      return { rgba: new Uint8ClampedArray(r.rgba), width: r.width, height: r.height, ms: r.ms };
    },
    async deleteModel(modelId: ModelId) {
      await call({ type: 'deleteModel', modelId });
    },
  };
}
