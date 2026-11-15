// Registro dos modelos disponíveis. Puro (sem OPFS, sem ORT): usado pela UI e pelo worker.

export type ModelId = 'sdxs' | 'sd-turbo';
export type Kind = 'text_encoder' | 'unet' | 'vae_decoder';

export interface ModelFile {
  kind: Kind;
  /** nome do arquivo no OPFS (dentro da pasta do modelo) */
  name: string;
  /** caminho remoto relativo a baseUrl */
  remote: string;
  /** tamanho exato em bytes: um arquivo só está completo se tiver exatamente isso */
  size: number;
}

export interface PipelineSpec {
  sigma: number;
  /** o decodificador recebe x0 / vaeScale */
  vaeScale: number;
  /** valor do timestep (1 passo) */
  timestep: number;
  /** tipo do tensor input_ids do codificador de texto */
  textIdsType: 'int32' | 'int64';
  /** tipo do tensor timestep da U-Net */
  timestepType: 'int64' | 'float32';
  /** token usado para preencher o prompt até 77 posições */
  padTokenId: number;
  textOutput: string;
  unetOutput: string;
  vaeInput: string;
  vaeOutput: string;
  /** dimensões livres fixadas ao criar cada sessão (WebGPU precisa de formas estáticas) */
  overrides: Record<Kind, Record<string, number>>;
}

export interface ModelSpec {
  id: ModelId;
  name: string;
  /** linha curta do seletor */
  tradeoff: string;
  description: string;
  license: string;
  baseUrl: string;
  /** subpasta no OPFS; null = raiz da pasta de modelos (compatível com downloads antigos) */
  dir: string | null;
  files: ModelFile[];
  /** repositório do tokenizador (transformers.js exige tokenizer.json, que os repositórios dos modelos não têm) */
  tokenizerRepo: string;
  pipeline: PipelineSpec;
}

export const TOKENIZER_REPO = 'Xenova/clip-vit-base-patch16';

const SD_TURBO: ModelSpec = {
  id: 'sd-turbo',
  name: 'SD-Turbo',
  tradeoff: 'Mais detalhe, mas pesado: pode derrubar celulares com pouca memória.',
  description: 'SD-Turbo (Stability AI), 1 passo, 512×512.',
  license: 'Licença da Stability AI (uso não comercial / termos da comunidade).',
  baseUrl: 'https://huggingface.co/schmuell/sd-turbo-ort-web/resolve/main/',
  dir: null,
  files: [
    { kind: 'text_encoder', name: 'text_encoder.onnx', remote: 'text_encoder/model.onnx', size: 681_393_168 },
    { kind: 'unet', name: 'unet.onnx', remote: 'unet/model.onnx', size: 1_733_430_199 },
    { kind: 'vae_decoder', name: 'vae_decoder.onnx', remote: 'vae_decoder/model.onnx', size: 99_094_314 },
  ],
  tokenizerRepo: TOKENIZER_REPO,
  pipeline: {
    sigma: 14.6146,
    vaeScale: 0.18215,
    timestep: 999,
    textIdsType: 'int32',
    timestepType: 'int64',
    padTokenId: 0, // OpenCLIP (SD 2.x) preenche com "!" (id 0)
    textOutput: 'last_hidden_state',
    unetOutput: 'out_sample',
    vaeInput: 'latent_sample',
    vaeOutput: 'sample',
    overrides: {
      text_encoder: { batch_size: 1 },
      unet: { batch_size: 1, num_channels: 4, height: 64, width: 64, sequence_length: 77 },
      vae_decoder: { batch_size: 1, num_channels_latent: 4, height_latent: 64, width_latent: 64 },
    },
  },
};

const SDXS: ModelSpec = {
  id: 'sdxs',
  name: 'Leve',
  tradeoff: 'Mais leve e rápido: recomendado para celulares.',
  description: 'SDXS-512 DreamShaper (1 passo, 512×512), pesos em fp16.',
  license: 'OpenRAIL++ (IDKiro/sdxs-512-dreamshaper).',
  baseUrl: 'https://huggingface.co/blinkfy/CVClass-SDXS-ONNX/resolve/main/',
  dir: 'sdxs',
  files: [
    { kind: 'text_encoder', name: 'text_encoder.fp16.onnx', remote: 'text_encoder/model.fp16.onnx', size: 246_280_550 },
    { kind: 'unet', name: 'unet.fp16.onnx', remote: 'unet/model.fp16.onnx', size: 689_988_794 },
    { kind: 'vae_decoder', name: 'vae_decoder.fp16.onnx', remote: 'vae_decoder/model.fp16.onnx', size: 2_468_157 },
  ],
  tokenizerRepo: TOKENIZER_REPO,
  pipeline: {
    sigma: 14.6146,
    vaeScale: 1, // TAESD: scaling_factor = 1.0
    timestep: 999,
    textIdsType: 'int64',
    timestepType: 'float32',
    padTokenId: 49407, // CLIP do SD 1.x preenche com <|endoftext|>
    textOutput: 'last_hidden_state',
    unetOutput: 'out_sample',
    vaeInput: 'latent_sample',
    vaeOutput: 'sample',
    overrides: {
      text_encoder: {},
      unet: {},
      vae_decoder: { latent_height: 64, latent_width: 64, image_height: 512, image_width: 512 },
    },
  },
};

export const DEFAULT_MODEL: ModelId = 'sdxs';

// Só para testes de ponta a ponta: um build com VITE_TEST_SIZES='{"unet/model.fp16.onnx":3145728,…}'
// troca os tamanhos esperados por arquivos pequenos. Nunca definido no build de produção.
function withTestSizes(m: ModelSpec): ModelSpec {
  const raw = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TEST_SIZES;
  if (!raw) return m;
  const sizes = JSON.parse(raw) as Record<string, number>;
  return { ...m, files: m.files.map((f) => ({ ...f, size: sizes[f.remote] ?? f.size })) };
}

export const MODELS: ModelSpec[] = [SDXS, SD_TURBO].map(withTestSizes);

export function isModelId(v: unknown): v is ModelId {
  return MODELS.some((m) => m.id === v);
}

export function getModel(id: ModelId): ModelSpec {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Modelo desconhecido: ${id}`);
  return m;
}

export function totalSize(m: ModelSpec): number {
  return m.files.reduce((s, f) => s + f.size, 0);
}
