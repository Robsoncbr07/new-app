// Armazenamento dos modelos no OPFS. Deve ser usado DENTRO de um Web Worker
// (createSyncAccessHandle só existe em workers).
import type { DownloadProgress } from './types';
import { EngineError } from './types';

export const BASE_URL = 'https://huggingface.co/schmuell/sd-turbo-ort-web/resolve/main/';

export interface ModelFile {
  /** nome do arquivo no OPFS */
  name: string;
  /** caminho remoto relativo a BASE_URL */
  remote: string;
  /** tamanho aproximado em bytes (usado só até o Content-Length real chegar) */
  approx: number;
}

const MB = 1024 * 1024;
export const FILES: ModelFile[] = [
  { name: 'text_encoder.onnx', remote: 'text_encoder/model.onnx', approx: 1700 * MB },
  { name: 'unet.onnx', remote: 'unet/model.onnx', approx: 640 * MB },
  { name: 'vae_decoder.onnx', remote: 'vae_decoder/model.onnx', approx: 95 * MB },
];

const DIR = 'atelie-modelos';

async function dir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

async function exists(d: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await d.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

async function sizeOf(d: FileSystemDirectoryHandle, name: string): Promise<number> {
  try {
    return (await (await d.getFileHandle(name)).getFile()).size;
  } catch {
    return 0;
  }
}

/** Um arquivo só é "completo" se existir sob o nome final (nunca como .part). */
export async function isDownloaded(): Promise<boolean> {
  const d = await dir();
  for (const f of FILES) {
    if (!(await exists(d, f.name))) return false;
    if ((await sizeOf(d, f.name)) < 1024 * 1024) return false;
  }
  return true;
}

export async function usage(): Promise<number> {
  const d = await dir();
  let total = 0;
  for (const f of FILES) {
    total += await sizeOf(d, f.name);
    total += await sizeOf(d, f.name + '.part');
  }
  return total;
}

export async function deleteAll(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(DIR, { recursive: true });
  } catch (e) {
    if ((e as DOMException).name !== 'NotFoundError') throw e;
  }
}

/** Lê um arquivo inteiro para memória (necessário para criar a sessão ORT). */
export async function readFile(name: string): Promise<Uint8Array> {
  const d = await dir();
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

async function downloadOne(
  d: FileSystemDirectoryHandle,
  f: ModelFile,
  doneBefore: number,
  grandTotalApprox: number,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<number> {
  let resp: Response;
  try {
    resp = await fetch(BASE_URL + f.remote, { signal });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') throw e;
    throw new EngineError('download', 'Falha ao baixar o modelo. Verifique sua conexão e tente novamente.');
  }
  if (!resp.ok || !resp.body) {
    throw new EngineError('download', `Falha ao baixar o modelo (HTTP ${resp.status}). Tente novamente mais tarde.`);
  }
  const lenHeader = resp.headers.get('Content-Length');
  const expected = lenHeader ? parseInt(lenHeader, 10) : 0;
  const fileTotal = expected || f.approx;

  const partFh = await d.getFileHandle(f.name + '.part', { create: true });
  const access = await (partFh as any).createSyncAccessHandle();
  let written = 0;
  let lastReport = 0;
  try {
    access.truncate(0);
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      access.write(value, { at: written });
      written += value.byteLength;
      const now = performance.now();
      if (now - lastReport > 150) {
        lastReport = now;
        onProgress({
          file: f.name,
          fileLoaded: written,
          fileTotal,
          loaded: doneBefore + written,
          total: Math.max(grandTotalApprox, doneBefore + fileTotal),
        });
      }
    }
    access.flush();
  } catch (e) {
    access.close();
    if ((e as DOMException).name === 'AbortError') throw e;
    throw new EngineError('download', 'A conexão caiu durante o download. Tente novamente (o arquivo parcial será refeito).');
  }
  access.close();

  if (expected && written !== expected) {
    throw new EngineError('download', 'Download incompleto (tamanho diferente do esperado). Tente novamente.');
  }
  if (!expected && written < f.approx * 0.5) {
    throw new EngineError('download', 'Download incompleto. Tente novamente.');
  }
  await finalize(d, f.name);
  onProgress({
    file: f.name, fileLoaded: written, fileTotal: written,
    loaded: doneBefore + written, total: Math.max(grandTotalApprox, doneBefore + written),
  });
  return written;
}

export async function download(
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
): Promise<void> {
  const d = await dir();
  const approxTotal = FILES.reduce((s, f) => s + f.approx, 0);
  let done = 0;
  for (const f of FILES) {
    if (signal.aborted) throw new DOMException('Cancelado', 'AbortError');
    const existing = await sizeOf(d, f.name);
    if (existing >= 1024 * 1024 && (await exists(d, f.name))) {
      done += existing; // já completo
      continue;
    }
    done += await downloadOne(d, f, done, approxTotal, onProgress, signal);
  }
}

/** Remove restos parciais (usado ao cancelar). */
export async function cleanPartials(): Promise<void> {
  const d = await dir();
  for (const f of FILES) await d.removeEntry(f.name + '.part').catch(() => undefined);
}
