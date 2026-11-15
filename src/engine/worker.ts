/// Worker de módulo: dono do ONNX Runtime Web (WebGPU) e do armazenamento OPFS.
import * as ort from 'onnxruntime-web/webgpu';
import * as store from './modelStore';
import {
  SIGMA, VAE_SCALE, makeLatents, scaleInput, stepToX0, toRGBA, toFloat32,
} from './scheduler';
import { EngineError, type WorkerRequest, type WorkerReply } from './types';

const ctx = self as unknown as {
  postMessage(msg: WorkerReply, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

const post = (msg: WorkerReply, transfer?: Transferable[]) => ctx.postMessage(msg, transfer);

let ortReady = false;
function initOrt(ortBase: string) {
  ort.env.wasm.wasmPaths = ortBase;
  ort.env.wasm.numThreads = 1; // sem isolamento de origem cruzada no GitHub Pages
  ortReady = true;
}

// ---------- sessões ----------
const BASE_SESSION_OPTS = {
  executionProviders: ['webgpu'],
  enableMemPattern: false,
  enableCpuMemArena: false,
  extra: {
    session: {
      disable_prepacking: '1',
      use_device_allocator_for_initializers: '1',
      use_ort_model_bytes_directly: '1',
      use_ort_model_bytes_for_initializers: '1',
    },
  },
};

type Kind = 'text_encoder' | 'unet' | 'vae_decoder';
const FILE_OF: Record<Kind, string> = {
  text_encoder: 'text_encoder.onnx',
  unet: 'unet.onnx',
  vae_decoder: 'vae_decoder.onnx',
};
const OVERRIDES: Record<Kind, Record<string, number>> = {
  text_encoder: { batch_size: 1 },
  unet: { batch_size: 1, num_channels: 4, height: 64, width: 64, sequence_length: 77 },
  vae_decoder: { batch_size: 1, num_channels_latent: 4, height_latent: 64, width_latent: 64 },
};

const LABEL: Record<Kind, string> = {
  text_encoder: 'codificador de texto',
  unet: 'U-Net',
  vae_decoder: 'decodificador de imagem',
};

const cache: Partial<Record<Kind, ort.InferenceSession>> = {};

// No modo econômico o codificador de texto (o maior arquivo, ~1,7 GB) roda na CPU: no
// Galaxy S24 FE a aba era derrubada ao executá-lo na GPU. Fica mais lento, mas não disputa
// memória de vídeo com o resto do pipeline.
const onCpu = (kind: Kind, lowMemory: boolean) => lowMemory && kind === 'text_encoder';

async function createSession(kind: Kind, stage: (s: string) => void, cpu = false): Promise<ort.InferenceSession> {
  stage(`Lendo ${FILE_OF[kind]} do armazenamento…`);
  const bytes = await store.readFile(FILE_OF[kind]);
  stage(`Criando sessão: ${LABEL[kind]}${cpu ? ' (CPU)' : ''}…`);
  const opts = {
    ...BASE_SESSION_OPTS,
    executionProviders: [cpu ? 'wasm' : 'webgpu'],
    freeDimensionOverrides: OVERRIDES[kind],
  };
  return ort.InferenceSession.create(bytes, opts as ort.InferenceSession.SessionOptions);
}

async function getSession(kind: Kind, lowMemory: boolean, stage: (s: string) => void) {
  if (lowMemory) return createSession(kind, stage, onCpu(kind, lowMemory));
  let s = cache[kind];
  if (!s) {
    s = await createSession(kind, stage);
    cache[kind] = s;
  }
  return s;
}

async function releaseAll() {
  for (const k of Object.keys(cache) as Kind[]) {
    try { await cache[k]!.release(); } catch { /* ignore */ }
    delete cache[k];
  }
}

// ---------- tokenizer ----------
let tokenizer: any = null;
async function tokenize(prompt: string): Promise<Int32Array> {
  if (!tokenizer) {
    const { AutoTokenizer, env } = await import('@huggingface/transformers');
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    tokenizer = await AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch16');
    tokenizer.pad_token_id = 0;
  }
  const enc = tokenizer(prompt, { padding: 'max_length', max_length: 77, truncation: true, return_tensor: false });
  let ids: number[] = Array.from(enc.input_ids as ArrayLike<number | bigint>, (v) => Number(v));
  if (ids.length > 77) ids = ids.slice(0, 77);
  while (ids.length < 77) ids.push(0);
  return Int32Array.from(ids);
}

// ---------- erros ----------
async function checkWebGPU(): Promise<void> {
  const gpu = (navigator as any).gpu;
  if (!gpu) {
    throw new EngineError('no-webgpu', 'WebGPU não está disponível neste navegador. Use o Chrome no Android 12+ ou o Safari no iOS 26+.');
  }
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new EngineError('no-adapter', 'Nenhuma GPU compatível com WebGPU foi encontrada neste aparelho.');
  }
  if (!adapter.features.has('shader-f16')) {
    throw new EngineError('no-f16', 'Sua GPU não suporta "shader-f16", recurso necessário para este modelo.');
  }
}

function wrapError(e: unknown): EngineError {
  if (e instanceof EngineError) return e;
  const msg = String((e as any)?.message ?? e);
  if (/out of memory|oom|device (was )?lost|device_lost|context lost|allocat|memory|buffer/i.test(msg)) {
    return new EngineError('oom', 'A GPU ficou sem memória ou foi perdida. Ative o "Modo econômico de memória", feche outros apps e tente novamente.');
  }
  if (/fetch|network|Failed to load|tokenizer|huggingface/i.test(msg)) {
    return new EngineError('network', 'Não foi possível carregar o tokenizador (precisa de internet na primeira vez). Verifique a conexão.');
  }
  return new EngineError('unknown', `Erro inesperado: ${msg}`);
}

// ---------- geração ----------
async function tensorToCpu(t: ort.Tensor): Promise<ort.Tensor> {
  const data = await t.getData(true);
  return new ort.Tensor(t.type as any, (data as any).slice(), t.dims as number[]);
}

async function generate(id: number, prompt: string, seed: number, lowMemory: boolean) {
  const t0 = performance.now();
  const stage = (s: string) => post({ id, type: 'progress', stage: s });
  await checkWebGPU();
  if (!(await store.isDownloaded())) {
    throw new EngineError('no-model', 'O modelo ainda não foi baixado.');
  }
  if (lowMemory) await releaseAll();

  stage('Lendo o prompt (tokenizador)…');
  const ids = await tokenize(prompt);

  // No modo econômico, uma falha no meio não pode deixar a sessão (e a memória da GPU) presa.
  let session: ort.InferenceSession | null = null;
  try {
    await runPipeline();
  } catch (e) {
    if (lowMemory && session) await (session as ort.InferenceSession).release().catch(() => undefined);
    throw e;
  }

  async function runPipeline() {
  // 1) texto
  session = await getSession('text_encoder', lowMemory, stage);
  stage(lowMemory ? 'Executando: codificador de texto na CPU (1/3), pode levar até um minuto…' : 'Executando: codificador de texto (1/3)…');
  const te = await session.run({ input_ids: new ort.Tensor('int32', ids, [1, 77]) });
  const hidden = await tensorToCpu(te['last_hidden_state']);
  if (lowMemory) await session.release();

  // 2) unet
  session = await getSession('unet', lowMemory, stage);
  stage('Executando: U-Net (2/3)…');
  const latents = makeLatents(seed >>> 0, SIGMA);
  const sample = scaleInput(latents, SIGMA);
  const un = await session.run({
    sample: new ort.Tensor('float32', sample, [1, 4, 64, 64]),
    timestep: new ort.Tensor('int64', BigInt64Array.from([999n]), [1]),
    encoder_hidden_states: hidden,
  });
  const eps = toFloat32(await un['out_sample'].getData(true));
  if (lowMemory) await session.release();

  // 3) vae
  session = await getSession('vae_decoder', lowMemory, stage);
  stage('Executando: decodificador de imagem (3/3)…');
  const x0 = stepToX0(latents, eps, SIGMA, VAE_SCALE);
  const vo = await session.run({ latent_sample: new ort.Tensor('float32', x0, [1, 4, 64, 64]) });
  const img = toFloat32(await vo['sample'].getData(true));
  if (lowMemory) await session.release();

  stage('Finalizando…');
  const rgba = toRGBA(img, 512, 512);
  const buf = rgba.buffer as ArrayBuffer;
  post({ id, type: 'result', rgba: buf, width: 512, height: 512, ms: Math.round(performance.now() - t0) }, [buf]);
  }
}

// ---------- download ----------
let dlAbort: AbortController | null = null;

async function download(id: number) {
  dlAbort = new AbortController();
  try {
    await store.download((progress) => post({ id, type: 'downloadProgress', progress }), dlAbort.signal);
    post({ id, type: 'downloaded' });
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') {
      post({ id, type: 'error', code: 'aborted', message: 'Download cancelado.' });
      return;
    }
    throw e;
  } finally {
    dlAbort = null;
  }
}

let busy = false;

ctx.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init':
        initOrt(m.ortBase);
        return;
      case 'cancelDownload':
        dlAbort?.abort();
        return;
      case 'status':
        post({ id: m.id, type: 'status', downloaded: await store.isDownloaded(), usage: await store.usage(), partial: await store.partialBytes() });
        return;
      case 'download':
        await download(m.id);
        return;
      case 'deleteModel':
        await releaseAll();
        await store.deleteAll();
        post({ id: m.id, type: 'deleted' });
        return;
      case 'generate':
        if (!ortReady) throw new EngineError('unknown', 'Motor não inicializado.');
        if (busy) throw new EngineError('busy', 'Já existe uma geração em andamento.');
        busy = true;
        try {
          await generate(m.id, m.prompt, m.seed, m.lowMemory);
        } finally {
          busy = false;
        }
        return;
    }
  } catch (err) {
    const w = wrapError(err);
    post({ id: (m as any).id, type: 'error', code: w.code, message: w.message });
  }
};
