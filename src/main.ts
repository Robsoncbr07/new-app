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
  } catch (e) {
    modelMissing.hidden = false;
    show(modelError, msgOf(e));
  }
  refresh();
}

function onProgress(p: DownloadProgress) {
  const pct = p.total ? Math.min(100, (p.loaded / p.total) * 100) : 0;
  dlBar.style.width = pct.toFixed(1) + '%';
  dlText.textContent = `${fmtMB(p.loaded)} de ${fmtMB(p.total)} (${Math.floor(pct)}%)`;
}

btnDownload.addEventListener('click', async () => {
  if (downloading) return;
  try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
  downloading = true;
  abort = new AbortController();
  modelError.hidden = true;
  btnDownload.hidden = true;
  dlProgress.hidden = false;
  onProgress({ file: '', fileLoaded: 0, fileTotal: 0, loaded: 0, total: 1 });
  refresh();
  try {
    await engine.download(onProgress, abort.signal);
  } catch (e) {
    if (!(e instanceof EngineError && e.code === 'aborted')) show(modelError, msgOf(e));
  } finally {
    downloading = false;
    abort = null;
    dlProgress.hidden = true;
    btnDownload.hidden = false;
    await refreshModel();
  }
});

btnCancel.addEventListener('click', () => abort?.abort());

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
  refresh();
  try {
    const r = await engine.generate({ prompt, seed, lowMemory: lowMemEl.checked }, (s) => { stageEl.textContent = s; });
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
    stageEl.hidden = true;
    show(genError, msgOf(e));
  } finally {
    busy = false;
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
detectGPU();
refreshModel();
renderGallery();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  });
}
