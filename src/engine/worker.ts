/// Worker de módulo: dono do ONNX Runtime Web (WebGPU) e do armazenamento OPFS.
import * as ort from 'onnxruntime-web/webgpu';
import * as store from './modelStore';
import {
  makeLatents, scaleInput, stepToX0, toRGBA, toFloat32, padTokenIds,
} from './scheduler';
import { getModel, type Kind, type ModelId, type ModelSpec } from './models';
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

const LABEL: Record<Kind, string> = {
  text_encoder: 'codificador de texto',
  unet: 'U-Net',
  vae_decoder: 'decodificador de imagem',
};

// Sessões em cache (só no modo normal), por modelo e tipo. Todas rodam na GPU (WebGPU).
const cache: Partial<Record<string, ort.InferenceSession>> = {};
const cacheKey = (m: ModelSpec, kind: Kind) => `${m.id}/${kind}`;

async function createSession(m: ModelSpec, kind: Kind, stage: (s: string) => void): Promise<ort.InferenceSession> {
  const file = m.files.find((f) => f.kind === kind)!;
  stage(`Lendo ${file.name} do armazenamento…`);
  // Os bytes lidos do OPFS vivem só dentro desta função: o ORT copia para a memória do wasm
  // durante create() e libera essa cópia ao terminar; aqui soltamos a referência logo depois
  // para a cópia em JS poder ser coletada antes da próxima etapa.
  let bytes: Uint8Array | null = await store.readFile(m, file.name);
  stage(`Criando sessão: ${LABEL[kind]}…`);
  const opts = { ...BASE_SESSION_OPTS, freeDimensionOverrides: m.pipeline.overrides[kind] };
  try {
    return await ort.InferenceSession.create(bytes, opts as ort.InferenceSession.SessionOptions);
  } finally {
    bytes = null;
  }
}

async function getSession(m: ModelSpec, kind: Kind, lowMemory: boolean, stage: (s: string) => void) {
  if (lowMemory) return createSession(m, kind, stage);
  const key = cacheKey(m, kind);
  let s = cache[key];
  if (!s) {
    s = await createSession(m, kind, stage);
    cache[key] = s;
  }
  return s;
}

async function releaseAll(exceptModel?: ModelId) {
  for (const k of Object.keys(cache)) {
    if (exceptModel && k.startsWith(exceptModel + '/')) continue;
    try { await cache[k]!.release(); } catch { /* ignore */ }
    delete cache[k];
  }
}

// ---------- tokenizer ----------
let tokenizer: any = null;
let tokenizerRepo = '';
async function tokenize(m: ModelSpec, prompt: string): Promise<number[]> {
  if (!tokenizer || tokenizerRepo !== m.tokenizerRepo) {
    const { AutoTokenizer, env } = await import('@huggingface/transformers');
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    tokenizer = await AutoTokenizer.from_pretrained(m.tokenizerRepo);
    tokenizerRepo = m.tokenizerRepo;
  }
  // Sem padding do tokenizador: preenchemos nós mesmos com o token certo de cada modelo.
  const enc = tokenizer(prompt, { padding: false, truncation: true, max_length: 77, return_tensor: false });
  return padTokenIds(enc.input_ids as ArrayLike<number | bigint>, 77, m.pipeline.padTokenId);
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

async function generate(id: number, modelId: ModelId, prompt: string, seed: number, lowMemory: boolean) {
  const t0 = performance.now();
  const m = getModel(modelId);
  const P = m.pipeline;
  const stage = (s: string) => post({ id, type: 'progress', stage: `${m.name}: ${s}` });
  await checkWebGPU();
  if (!(await store.isDownloaded(m))) {
    throw new EngineError('no-model', 'O modelo ainda não foi baixado.');
  }
  // Um modelo por vez na memória: no modo econômico nada fica em cache; no normal, trocar de
  // modelo descarta as sessões do anterior.
  await releaseAll(lowMemory ? undefined : m.id);

  stage('Lendo o prompt (tokenizador)…');
  const ids = await tokenize(m, prompt);

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
  session = await getSession(m, 'text_encoder', lowMemory, stage);
  stage('Executando: codificador de texto (1/3)…');
  const idsTensor = P.textIdsType === 'int64'
    ? new ort.Tensor('int64', BigInt64Array.from(ids, (v) => BigInt(v)), [1, 77])
    : new ort.Tensor('int32', Int32Array.from(ids), [1, 77]);
  const te = await session.run({ input_ids: idsTensor });
  const hidden = await tensorToCpu(te[P.textOutput]);
  if (lowMemory) await session.release();

  // 2) unet
  session = await getSession(m, 'unet', lowMemory, stage);
  stage('Executando: U-Net (2/3)…');
  const latents = makeLatents(seed >>> 0, P.sigma);
  const sample = scaleInput(latents, P.sigma);
  const timestep = P.timestepType === 'int64'
    ? new ort.Tensor('int64', BigInt64Array.from([BigInt(P.timestep)]), [1])
    : new ort.Tensor('float32', Float32Array.from([P.timestep]), [1]);
  const un = await session.run({
    sample: new ort.Tensor('float32', sample, [1, 4, 64, 64]),
    timestep,
    encoder_hidden_states: hidden,
  });
  const eps = toFloat32(await un[P.unetOutput].getData(true));
  if (lowMemory) await session.release();

  // 3) vae
  session = await getSession(m, 'vae_decoder', lowMemory, stage);
  stage('Executando: decodificador de imagem (3/3)…');
  const x0 = stepToX0(latents, eps, P.sigma, P.vaeScale);
  const vo = await session.run({ [P.vaeInput]: new ort.Tensor('float32', x0, [1, 4, 64, 64]) });
  const img = toFloat32(await vo[P.vaeOutput].getData(true));
  if (lowMemory) await session.release();

  stage('Finalizando…');
  const rgba = toRGBA(img, 512, 512);
  const buf = rgba.buffer as ArrayBuffer;
  post({ id, type: 'result', rgba: buf, width: 512, height: 512, ms: Math.round(performance.now() - t0) }, [buf]);
  }
}

// ---------- download ----------
let dlAbort: AbortController | null = null;

async function download(id: number, modelId: ModelId) {
  dlAbort = new AbortController();
  try {
    await store.download(getModel(modelId), (progress) => post({ id, type: 'downloadProgress', progress }), dlAbort.signal);
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
      {
        const spec = getModel(m.modelId);
        post({ id: m.id, type: 'status', downloaded: await store.isDownloaded(spec), usage: await store.usage(spec), partial: await store.partialBytes(spec) });
      }
        return;
      case 'download':
        await download(m.id, m.modelId);
        return;
      case 'deleteModel':
        await releaseAll();
        await store.deleteModel(getModel(m.modelId));
        post({ id: m.id, type: 'deleted' });
        return;
      case 'generate':
        if (!ortReady) throw new EngineError('unknown', 'Motor não inicializado.');
        if (busy) throw new EngineError('busy', 'Já existe uma geração em andamento.');
        busy = true;
        try {
          await generate(m.id, m.modelId, m.prompt, m.seed, m.lowMemory);
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
