import './style.css';
import { createWorkerEngine } from './engine/client';
import { createMockEngine } from './engine/mock';
import { EngineError, type Engine, type DownloadProgress } from './engine/types';
import * as gallery from './gallery';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const isMock = new URLSearchParams(location.search).get('mock') === '1';
const engine: Engine = isMock ? createMockEngine() : createWorkerEngine();

const STYLES: { label: string; suffix: string }[] = [
  { label: 'Fotografia', suffix: 'photograph, realistic, detailed' },
  { label: 'Aquarela', suffix: 'watercolor painting' },
  { label: 'Anime', suffix: 'anime style' },
  { label: '3D', suffix: '3D render' },
  { label: 'Pixel art', suffix: 'pixel art' },
  { label: 'Óleo', suffix: 'oil painting' },
];

// ---------- elementos ----------
const gpuChip = $('gpu-chip');
const gpuNotice = $('gpu-notice');
const modelMissing = $('model-missing');
const modelReady = $('model-ready');
const modelUsage = $('model-usage');
const modelError = $('model-error');
const btnDownload = $<HTMLButtonElement>('btn-download');
const btnCancel = $<HTMLButtonElement>('btn-cancel');
const btnRemove = $<HTMLButtonElement>('btn-remove');
const dlProgress = $('dl-progress');
const dlBar = $('dl-bar');
const dlText = $('dl-text');
const dlSaved = $('dl-saved');
const btnDiscard = $<HTMLButtonElement>('btn-discard');
const crashNotice = $('crash-notice');
const crashText = $<HTMLTextAreaElement>('crash-text');
const promptEl = $<HTMLTextAreaElement>('prompt');
const seedEl = $<HTMLInputElement>('seed');
const lowMemEl = $<HTMLInputElement>('low-mem');
const btnGenerate = $<HTMLButtonElement>('btn-generate');
const stageEl = $('stage');
const genError = $('gen-error');
const resultEl = $('result');
const canvas = $<HTMLCanvasElement>('canvas');
const elapsedEl = $('elapsed');
const btnSave = $<HTMLButtonElement>('btn-save');
const btnShare = $<HTMLButtonElement>('btn-share');
const btnVary = $<HTMLButtonElement>('btn-vary');
const galleryEl = $('gallery');
const galleryEmpty = $('gallery-empty');

// ---------- estado ----------
let gpuOk = false;
let downloaded = false;
let downloading = false;
let busy = false;
let currentBlob: Blob | null = null;
let currentName = 'atelie-local';
let abort: AbortController | null = null;

// ---------- utilidades ----------
function fmtMB(bytes: number): string {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2).replace('.', ',') + ' GB';
  return Math.round(bytes / 1024 ** 2).toLocaleString('pt-BR') + ' MB';
}
function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}
function show(el: HTMLElement, text?: string) {
  if (text !== undefined) el.textContent = text;
  el.hidden = false;
}
function msgOf(e: unknown): string {
  if (e instanceof EngineError) return e.message;
  return `Erro inesperado: ${(e as Error)?.message ?? e}`;
}
function refresh() {
  btnGenerate.disabled = !(downloaded && !busy && !downloading && (gpuOk || isMock));
  btnVary.disabled = btnGenerate.disabled;
  btnDownload.disabled = downloading;
  btnRemove.disabled = busy;
}

// ---------- tela ligada (Wake Lock) ----------
let wakeLock: any = null;
async function syncWakeLock() {
  try {
    const wl = (navigator as any).wakeLock;
    if (!wl) return;
    const want = (downloading || busy) && document.visibilityState === 'visible';
    if (want && !wakeLock) {
      wakeLock = await wl.request('screen');
      wakeLock.addEventListener?.('release', () => { wakeLock = null; });
    } else if (!(downloading || busy) && wakeLock) {
      const l = wakeLock;
      wakeLock = null;
      await l.release();
    }
  } catch { /* sem suporte ou negado: ignora */ }
}
document.addEventListener('visibilitychange', () => { void syncWakeLock(); });

// ---------- rastro de falha (breadcrumb) ----------
const CRUMB_KEY = 'atelie-breadcrumb';
interface Crumb { stage: string; time: string; kind: 'download' | 'generation' }
function setCrumb(kind: Crumb['kind'], stage: string) {
  try { localStorage.setItem(CRUMB_KEY, JSON.stringify({ stage, time: new Date().toISOString(), kind })); } catch { /* ignore */ }
}
function clearCrumb() {
  try { localStorage.removeItem(CRUMB_KEY); } catch { /* ignore */ }
}
function readCrumb(): Crumb | null {
  try {
    const c = JSON.parse(localStorage.getItem(CRUMB_KEY) ?? 'null');
    return c && typeof c.stage === 'string' ? c : null;
  } catch { return null; }
}

async function diagnosticText(c: Crumb): Promise<string> {
  const lines = [
    `Etapa: ${c.stage}`,
    `Tipo: ${c.kind}`,
    `Hora: ${c.time}`,
    `userAgent: ${navigator.userAgent}`,
    `deviceMemory: ${mem ?? 'indisponível'}`,
    `Modo econômico: ${lowMemEl.checked ? 'ligado' : 'desligado'}`,
  ];
  try {
    const e = await navigator.storage.estimate();
    lines.push(`Armazenamento: ${fmtMB(e.usage ?? 0)} usados de ${fmtMB(e.quota ?? 0)}`);
  } catch { lines.push('Armazenamento: indisponível'); }
  try {
    const a = await (navigator as any).gpu?.requestAdapter();
    if (a) {
      const i = a.info ?? (await a.requestAdapterInfo?.()) ?? {};
      lines.push(`GPU: ${[i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' / ') || 'sem detalhes'}`);
      lines.push(`maxBufferSize: ${a.limits.maxBufferSize}`);
      lines.push(`maxStorageBufferBindingSize: ${a.limits.maxStorageBufferBindingSize}`);
      lines.push(`shader-f16: ${a.features.has('shader-f16') ? 'sim' : 'não'}`);
    } else lines.push('WebGPU: sem adaptador');
  } catch { lines.push('WebGPU: indisponível'); }
  return lines.join('\n');
}

function showCrashNotice() {
  const c = readCrumb();
  if (!c) return;
  $('crash-stage').textContent = c.stage;
  crashNotice.hidden = false;
  $('btn-crash-dismiss').addEventListener('click', () => { clearCrumb(); crashNotice.hidden = true; });
  $('btn-crash-copy').addEventListener('click', async () => {
    const text = await diagnosticText(c);
    try {
      await navigator.clipboard.writeText(text);
      $('btn-crash-copy').textContent = 'Copiado!';
    } catch {
      crashText.value = text; // sem acesso à área de transferência: mostra para copiar à mão
      crashText.hidden = false;
      crashText.select();
    }
  });
}

// ---------- WebGPU ----------
async function detectGPU() {
  try {
    const gpu = (navigator as any).gpu;
    if (gpu) {
      const adapter = await gpu.requestAdapter();
      gpuOk = !!adapter;
    }
  } catch {
    gpuOk = false;
  }
  gpuChip.textContent = gpuOk ? 'WebGPU disponível' : 'WebGPU indisponível';
  gpuChip.classList.toggle('ok', gpuOk);
  gpuChip.classList.toggle('bad', !gpuOk);
  gpuNotice.hidden = gpuOk;
  refresh();
}

// ---------- modelo ----------
async function refreshModel() {
  try {
    const s = await engine.status();
    downloaded = s.downloaded;
    modelMissing.hidden = downloaded;
    modelReady.hidden = !downloaded;
    if (downloaded) modelUsage.textContent = `Armazenamento usado: ${fmtMB(s.usage)}`;
    const has = !downloaded && s.partial > 0;
    btnDownload.textContent = has ? 'Continuar download' : 'Baixar modelo';
    dlSaved.hidden = !has;
    btnDiscard.hidden = !has;
    if (has) dlSaved.textContent = `Já salvo no aparelho: ${fmtMB(s.partial)} de ~2,4 GB. O download continua de onde parou.`;
  } catch (e) {
    modelMissing.hidden = false;
    show(modelError, msgOf(e));
  }
  refresh();
}

let lastCrumb = 0;
function onProgress(p: DownloadProgress) {
  const now = Date.now();
  if (p.file && now - lastCrumb > 1000) {
    lastCrumb = now;
    setCrumb('download', `Baixando ${p.file} (${fmtMB(p.fileLoaded)} de ${fmtMB(p.fileTotal)})`);
  }
  const pct = p.total ? Math.min(100, (p.loaded / p.total) * 100) : 0;
  dlBar.style.width = pct.toFixed(1) + '%';
  dlText.textContent = `${fmtMB(p.loaded)} de ${fmtMB(p.total)} (${Math.floor(pct)}%)`;
}

btnDownload.addEventListener('click', async () => {
  if (downloading) return;
  try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
  downloading = true;
  void syncWakeLock();
  setCrumb('download', 'Iniciando download');
  abort = new AbortController();
  modelError.hidden = true;
  btnDownload.hidden = true;
  dlProgress.hidden = false;
  onProgress({ file: '', fileLoaded: 0, fileTotal: 0, loaded: 0, total: 1 });
  refresh();
  try {
    await engine.download(onProgress, abort.signal);
    clearCrumb();
  } catch (e) {
    clearCrumb(); // erro tratado ou pausa: não foi uma morte da página
    if (!(e instanceof EngineError && e.code === 'aborted')) show(modelError, msgOf(e));
  } finally {
    downloading = false;
    void syncWakeLock();
    abort = null;
    dlProgress.hidden = true;
    btnDownload.hidden = false;
    await refreshModel();
  }
});

btnCancel.addEventListener('click', () => abort?.abort());

btnDiscard.addEventListener('click', async () => {
  if (!confirm('Descartar o que já foi baixado? Será preciso começar do zero.')) return;
  try {
    await engine.deleteModel();
  } catch (e) {
    show(modelError, msgOf(e));
  }
  await refreshModel();
});

btnRemove.addEventListener('click', async () => {
  if (!confirm('Remover o modelo do aparelho? Será preciso baixar ~2,4 GB de novo para gerar imagens.')) return;
  try {
    await engine.deleteModel();
  } catch (e) {
    show(modelError, msgOf(e));
  }
  await refreshModel();
});

// ---------- prompt / estilos ----------
for (const s of STYLES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = s.label;
  b.addEventListener('click', () => {
    const cur = promptEl.value.trim();
    if (cur.toLowerCase().includes(s.suffix.toLowerCase())) return;
    promptEl.value = cur ? `${cur.replace(/[,\s]+$/, '')}, ${s.suffix}` : s.suffix;
    promptEl.focus();
  });
  $('styles').appendChild(b);
}

seedEl.value = String(randomSeed());
$('btn-dice').addEventListener('click', () => { seedEl.value = String(randomSeed()); });

const mem = (navigator as any).deviceMemory as number | undefined;
lowMemEl.checked = mem === undefined || mem <= 8;

// ---------- geração ----------
async function rgbaToBlob(rgba: Uint8ClampedArray, w: number, h: number): Promise<Blob> {
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d')!;
  c.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao gerar o PNG'))), 'image/png'));
}

function parseSeed(): number {
  const n = Number(seedEl.value);
  if (seedEl.value.trim() === '' || !Number.isFinite(n) || n < 0) {
    const s = randomSeed();
    seedEl.value = String(s);
    return s;
  }
  return Math.floor(n) % 4294967296;
}

async function generate() {
  if (busy) return;
  const prompt = promptEl.value.trim();
  if (!prompt) {
    show(genError, 'Escreva uma descrição para a imagem.');
    promptEl.focus();
    return;
  }
  const seed = parseSeed();
  busy = true;
  genError.hidden = true;
  stageEl.classList.remove('done');
  show(stageEl, 'Preparando…');
  setCrumb('generation', 'Preparando');
  void syncWakeLock();
  refresh();
  try {
    const r = await engine.generate({ prompt, seed, lowMemory: lowMemEl.checked }, (s) => {
      stageEl.textContent = s;
      setCrumb('generation', s);
    });
    clearCrumb();
    const blob = await rgbaToBlob(r.rgba, r.width, r.height);
    currentBlob = blob;
    currentName = `atelie-${seed}`;
    resultEl.hidden = false;
    elapsedEl.textContent = `Pronto em ${(r.ms / 1000).toFixed(1).replace('.', ',')} s · semente ${seed}`;
    stageEl.hidden = true;
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      await gallery.add({ blob, prompt, seed, date: Date.now() });
      await renderGallery();
    } catch {
      /* galeria indisponível (ex.: modo privado): ignora */
    }
  } catch (e) {
    clearCrumb();
    stageEl.hidden = true;
    show(genError, msgOf(e));
  } finally {
    busy = false;
    void syncWakeLock();
    refresh();
  }
}

btnGenerate.addEventListener('click', generate);
btnVary.addEventListener('click', () => {
  seedEl.value = String(randomSeed());
  generate();
});

btnSave.addEventListener('click', () => {
  if (!currentBlob) return;
  const url = URL.createObjectURL(currentBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentName}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

function canShareFiles(): boolean {
  try {
    const f = new File([new Blob()], 'a.png', { type: 'image/png' });
    return !!navigator.share && !!navigator.canShare && navigator.canShare({ files: [f] });
  } catch {
    return false;
  }
}
if (canShareFiles()) {
  btnShare.hidden = false;
  btnShare.addEventListener('click', async () => {
    if (!currentBlob) return;
    const file = new File([currentBlob], `${currentName}.png`, { type: 'image/png' });
    try {
      await navigator.share({ files: [file], title: 'Ateliê Local', text: promptEl.value });
    } catch { /* usuário cancelou */ }
  });
}

// ---------- galeria ----------
let thumbUrls: string[] = [];
async function renderGallery() {
  for (const u of thumbUrls) URL.revokeObjectURL(u);
  thumbUrls = [];
  galleryEl.textContent = '';
  let items: gallery.GalleryItem[] = [];
  try { items = await gallery.list(); } catch { /* ignore */ }
  galleryEmpty.hidden = items.length > 0;
  for (const it of items) {
    const url = URL.createObjectURL(it.blob);
    thumbUrls.push(url);
    const cell = document.createElement('div');
    cell.className = 'thumb';
    cell.dataset.id = String(it.id);
    cell.tabIndex = 0;
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-label', `Abrir imagem: ${it.prompt}`);
    const img = document.createElement('img');
    img.src = url;
    img.alt = it.prompt;
    img.loading = 'lazy';
    img.decoding = 'async';
    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Excluir imagem');
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm('Excluir esta imagem da galeria?')) return;
      await gallery.remove(it.id!);
      await renderGallery();
    });
    const open = async () => {
      promptEl.value = it.prompt;
      seedEl.value = String(it.seed);
      currentBlob = it.blob;
      currentName = `atelie-${it.seed}`;
      const bmp = await createImageBitmap(it.blob);
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d')!.drawImage(bmp, 0, 0);
      bmp.close();
      resultEl.hidden = false;
      elapsedEl.textContent = `Da galeria · semente ${it.seed} · ${new Date(it.date).toLocaleString('pt-BR')}`;
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    cell.addEventListener('click', open);
    cell.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
    cell.append(img, del);
    galleryEl.appendChild(cell);
  }
}

// ---------- init ----------
showCrashNotice();
detectGPU();
refreshModel();
renderGallery();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  });
}
