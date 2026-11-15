import type { ModelId } from './models';

export interface DownloadProgress {
  file: string;
  fileLoaded: number;
  fileTotal: number;
  loaded: number;
  total: number;
}

export interface ModelStatus {
  downloaded: boolean;
  usage: number;
  /** bytes já salvos de um download interrompido (arquivos .part) */
  partial: number;
}

export interface GenerateRequest {
  modelId: ModelId;
  prompt: string;
  seed: number;
  lowMemory: boolean;
}

export interface GenerateResult {
  /** RGBA 512x512 */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  ms: number;
}

/** Mesma interface para o motor real (worker) e o mock. */
export interface Engine {
  status(modelId: ModelId): Promise<ModelStatus>;
  download(modelId: ModelId, onProgress: (p: DownloadProgress) => void, signal: AbortSignal): Promise<void>;
  generate(req: GenerateRequest, onStage: (label: string) => void): Promise<GenerateResult>;
  deleteModel(modelId: ModelId): Promise<void>;
}

/** Erro com mensagem já em português, pronto para exibir. */
export class EngineError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type WorkerRequest =
  | { id: number; type: 'init'; ortBase: string }
  | { id: number; type: 'status'; modelId: ModelId }
  | { id: number; type: 'download'; modelId: ModelId }
  | { id: number; type: 'cancelDownload' }
  | { id: number; type: 'generate'; modelId: ModelId; prompt: string; seed: number; lowMemory: boolean }
  | { id: number; type: 'deleteModel'; modelId: ModelId };

export type WorkerReply =
  | { id: number; type: 'status'; downloaded: boolean; usage: number; partial: number }
  | { id: number; type: 'progress'; stage: string }
  | { id: number; type: 'downloadProgress'; progress: DownloadProgress }
  | { id: number; type: 'downloaded' }
  | { id: number; type: 'result'; rgba: ArrayBuffer; width: number; height: number; ms: number }
  | { id: number; type: 'deleted' }
  | { id: number; type: 'error'; code: string; message: string };
