// Armazenamento dos modelos no OPFS. Deve ser usado DENTRO de um Web Worker
// (createSyncAccessHandle só existe em workers).
import type { DownloadProgress } from './types';
import { EngineError } from './types';

import { totalSize, type ModelFile, type ModelSpec } from './models';

const MB = 1024 * 1024;
const DIR = 'atelie-modelos';

/** Pasta do modelo: a raiz (SD-Turbo, como nas versões antigas) ou uma subpasta. */
async function dir(m: ModelSpec): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle(DIR, { create: true });
  return m.dir ? base.getDirectoryHandle(m.dir, { create: true }) : base;
}

async function sizeOf(d: FileSystemDirectoryHandle, name: string): Promise<number> {
  try {
    return (await (await d.getFileHandle(name)).getFile()).size;
  } catch {
    return 0;
  }
}

/** Um arquivo só é "completo" se existir sob o nome final com exatamente o tamanho esperado. */
export async function isDownloaded(m: ModelSpec): Promise<boolean> {
  const d = await dir(m);
  for (const f of m.files) {
    if ((await sizeOf(d, f.name)) !== f.size) return false;
  }
  return true;
}

export async function usage(m: ModelSpec): Promise<number> {
  const d = await dir(m);
  let total = 0;
  for (const f of m.files) {
    total += await sizeOf(d, f.name);
    total += await sizeOf(d, f.name + '.part');
  }
  return total;
}

/** Bytes já salvos em arquivos .part (download interrompido que pode continuar). */
export async function partialBytes(m: ModelSpec): Promise<number> {
  const d = await dir(m);
  let total = 0;
  for (const f of m.files) total += await sizeOf(d, f.name + '.part');
  return total;
}

/** Apaga só os arquivos deste modelo (o outro modelo, se baixado, não é tocado). */
export async function deleteModel(m: ModelSpec): Promise<void> {
  const root = await navigator.storage.getDirectory();
  let base: FileSystemDirectoryHandle;
  try {
    base = await root.getDirectoryHandle(DIR);
  } catch (e) {
    if ((e as DOMException).name === 'NotFoundError') return;
    throw e;
  }
  if (m.dir) {
    try {
      await base.removeEntry(m.dir, { recursive: true });
    } catch (e) {
      if ((e as DOMException).name !== 'NotFoundError') throw e;
    }
    return;
  }
  for (const f of m.files) {
    for (const n of [f.name, f.name + '.part']) {
      try {
        await base.removeEntry(n);
      } catch (e) {
        if ((e as DOMException).name !== 'NotFoundError') throw e;
      }
    }
  }
}

/** Lê um arquivo inteiro para memória (necessário para criar a sessão ORT). */
export async function readFile(m: ModelSpec, name: string): Promise<Uint8Array> {
  const d = await dir(m);
  const fh = await d.getFileHandle(name);
  const access = await (fh as any).createSyncAccessHandle();
  try {
    const size: number = access.getSize();
    const buf = new Uint8Array(size);
    let off = 0;
    // leituras em blocos de 256 MB, sem cópias extras
    const CH = 256 * MB;
    while (off < size) {
      const n = access.read(buf.subarray(off, Math.min(size, off + CH)), { at: off });
      if (n <= 0) throw new Error('Leitura do OPFS retornou 0 bytes');
      off += n;
    }
    return buf;
  } finally {
    access.close();
  }
}

async function finalize(d: FileSystemDirectoryHandle, name: string): Promise<void> {
  const partHandle = await d.getFileHandle(name + '.part');
  const mv = (partHandle as any).move as ((n: string) => Promise<void>) | undefined;
  if (typeof mv === 'function') {
    try {
      await d.removeEntry(name).catch(() => undefined);
      await mv.call(partHandle, name);
      return;
    } catch {
      /* cai no fallback de cópia */
    }
  }
  // Fallback: copia em blocos (sem manter o arquivo todo na memória).
  const dst = await ((await d.getFileHandle(name, { create: true })) as any).createSyncAccessHandle();
  const src = await (partHandle as any).createSyncAccessHandle();
  try {
    dst.truncate(0);
    const size: number = src.getSize();
    const buf = new Uint8Array(8 * MB);
    let off = 0;
    while (off < size) {
      const n = src.read(buf, { at: off });
      if (n <= 0) break;
      dst.write(buf.subarray(0, n), { at: off });
      off += n;
    }
    dst.flush();
  } finally {
    src.close();
    dst.close();
  }
  await d.removeEntry(name + '.part');
}

const FLUSH_EVERY = 16 * MB;

/**
 * Total real do arquivo. Content-Range pode não ser legível em resposta de outra origem
 * (depende de Access-Control-Expose-Headers), mas Content-Length sempre é: num 206 o total
 * é o que já temos mais o que ainda vem.
 */
function totalOf(resp: Response, offset: number): number {
  const cr = resp.headers.get('Content-Range');
  const m = cr && /\/(\d+)\s*$/.exec(cr);
  if (m) return parseInt(m[1], 10);
  const cl = parseInt(resp.headers.get('Content-Length') ?? '', 10);
  if (!Number.isFinite(cl)) return 0;
  return resp.status === 206 ? offset + cl : cl;
}

async function request(m: ModelSpec, f: ModelFile, offset: number, signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(m.baseUrl + f.remote, { signal, headers: offset > 0 ? { Range: `bytes=${offset}-` } : {} });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') throw e;
    throw new EngineError('download', 'Falha ao baixar o modelo. Verifique sua conexão e tente novamente: o download continua de onde parou.');
  }
}

async function downloadOne(
  m: ModelSpec,
  d: FileSystemDirectoryHandle,
  f: ModelFile,
  doneBefore: number,
  grandTotal: number,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<number> {
  const partName = f.name + '.part';
  let offset = await sizeOf(d, partName);
  if (offset === f.size) { // baixado por inteiro, só faltava renomear
    await finalize(d, f.name);
    return offset;
  }
  if (offset > f.size) { // parcial impossível: descarta
    await d.removeEntry(partName).catch(() => undefined);
    offset = 0;
  }
  let resp = await request(m, f, offset, signal);
  if (resp.status === 416) {
    // Parcial suspeito. Se o tamanho dele já é o total, só falta finalizar; senão recomeça do zero.
    const cr = /\*\/(\d+)/.exec(resp.headers.get('Content-Range') ?? '');
    if (cr && offset > 0 && parseInt(cr[1], 10) === offset) {
      await finalize(d, f.name);
      return offset;
    }
    await d.removeEntry(partName).catch(() => undefined);
    offset = 0;
    resp = await request(m, f, 0, signal);
  }
  if (!resp.ok || !resp.body) {
    throw new EngineError('download', `Falha ao baixar o modelo (HTTP ${resp.status}). Tente novamente mais tarde.`);
  }
  const resume = resp.status === 206 && offset > 0;
  if (!resume) offset = 0; // 200: o servidor ignorou o Range; recomeça do zero
  const total = totalOf(resp, offset);
  if (total && total !== f.size) {
    throw new EngineError('download', 'O arquivo no servidor tem um tamanho diferente do esperado. Tente novamente mais tarde.');
  }
  const fileTotal = f.size;

  const partFh = await d.getFileHandle(partName, { create: true });
  const access = await (partFh as any).createSyncAccessHandle();
  let written = offset;
  let sinceFlush = 0;
  let lastReport = 0;
  const report = () => onProgress({
    file: f.name,
    fileLoaded: written,
    fileTotal,
    loaded: doneBefore + written,
    total: grandTotal,
  });
  try {
    if (!resume) access.truncate(0);
    report();
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      access.write(value, { at: written });
      written += value.byteLength;
      sinceFlush += value.byteLength;
      if (sinceFlush >= FLUSH_EVERY) {
        access.flush(); // garante que os bytes sobrevivem se a aba for morta
        sinceFlush = 0;
      }
      const now = performance.now();
      if (now - lastReport > 150) {
        lastReport = now;
        report();
      }
    }
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') throw e;
    throw new EngineError('download', 'A conexão caiu durante o download. Toque em "Continuar download": o que já foi baixado está salvo.');
  } finally {
    try { access.flush(); } catch { /* ignore */ }
    access.close();
  }

  if (written !== f.size) {
    throw new EngineError('download', 'Download incompleto. Toque em "Continuar download" para tentar de novo.');
  }
  await finalize(d, f.name);
  onProgress({
    file: f.name, fileLoaded: written, fileTotal: written,
    loaded: doneBefore + written, total: grandTotal,
  });
  return written;
}

export async function download(
  m: ModelSpec,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const d = await dir(m);
  const grandTotal = totalSize(m);
  let done = 0;
  for (const f of m.files) {
    if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
    const existing = await sizeOf(d, f.name);
    if (existing === f.size) {
      done += existing; // já completo
      continue;
    }
    if (existing > 0) await d.removeEntry(f.name).catch(() => undefined); // arquivo final com tamanho errado: refaz
    done += await downloadOne(m, d, f, done, grandTotal, onProgress, signal);
  }
}
