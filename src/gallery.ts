// Galeria persistida em IndexedDB (PNG, prompt, semente, data). Máximo de 50 itens.
export interface GalleryItem {
  id?: number;
  blob: Blob;
  prompt: string;
  seed: number;
  date: number;
  /** modelo usado (ausente em itens antigos, que eram sempre SD-Turbo) */
  modelId?: string;
}

const DB = 'atelie-local';
const STORE = 'images';
export const MAX_ITEMS = 50;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(r ? (r as IDBRequest<T>).result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  }));
}

/** Mais recentes primeiro. */
export async function list(): Promise<GalleryItem[]> {
  const all = (await tx<GalleryItem[]>('readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => b.date - a.date || (b.id ?? 0) - (a.id ?? 0));
}

export async function add(item: Omit<GalleryItem, 'id'>): Promise<void> {
  await tx('readwrite', (s) => s.add(item));
  const all = await list();
  for (const old of all.slice(MAX_ITEMS)) await remove(old.id!);
}

export async function remove(id: number): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}
