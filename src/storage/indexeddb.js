import { canonicalStringify, cloneJson } from '../domain/canonical.js';
import { operationFingerprint, validateOperation } from '../domain/operations.js';

const DB_VERSION = 1;

const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error || new Error('IndexedDB-transaktionen avbröts'));
  transaction.onerror = () => reject(transaction.error);
});

export async function openVinkallarenDB({ indexedDB = globalThis.indexedDB, name = 'vinkallaren' } = {}) {
  if (!indexedDB || typeof indexedDB.open !== 'function') throw new Error('IndexedDB saknas i denna miljö');
  const request = indexedDB.open(name, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('ops')) db.createObjectStore('ops', { keyPath: 'op_id' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
  };
  return requestResult(request);
}

export class IndexedDBStore {
  constructor(db) {
    if (!db) throw new TypeError('IndexedDB-databas saknas');
    this.db = db;
  }

  async appendOps(ops) {
    const incoming = new Map();
    for (const op of ops) {
      validateOperation(op);
      const inBatch = incoming.get(op.op_id);
      if (inBatch && operationFingerprint(inBatch) !== operationFingerprint(op)) throw new Error(`Kollision för op_id ${op.op_id}`);
      incoming.set(op.op_id, op);
    }
    if (!incoming.size) return 0;

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction('ops', 'readwrite');
      const store = transaction.objectStore('ops');
      let inserted = 0;
      let collision = null;
      for (const op of incoming.values()) {
        const request = store.get(op.op_id);
        request.onsuccess = () => {
          const existing = request.result;
          if (existing) {
            if (operationFingerprint(existing) !== operationFingerprint(op)) {
              collision = new Error(`Kollision för op_id ${op.op_id}`);
              transaction.abort();
            }
            return;
          }
          store.add(cloneJson(op));
          inserted += 1;
        };
        request.onerror = () => {
          collision = request.error;
          transaction.abort();
        };
      }
      transaction.oncomplete = () => resolve(inserted);
      transaction.onabort = () => reject(collision || transaction.error || new Error('IndexedDB-transaktionen avbröts'));
      transaction.onerror = () => reject(collision || transaction.error);
    });
  }

  async getAllOps() {
    const transaction = this.db.transaction('ops', 'readonly');
    const values = await requestResult(transaction.objectStore('ops').getAll());
    await transactionDone(transaction);
    return values.map(cloneJson).sort((a, b) => a.op_id.localeCompare(b.op_id));
  }

  async putMeta(key, value) {
    const transaction = this.db.transaction('meta', 'readwrite');
    transaction.objectStore('meta').put({ key: String(key), value: cloneJson(value) });
    await transactionDone(transaction);
  }

  async getMeta(key) {
    const transaction = this.db.transaction('meta', 'readonly');
    const row = await requestResult(transaction.objectStore('meta').get(String(key)));
    await transactionDone(transaction);
    return row ? cloneJson(row.value) : null;
  }

  async saveSnapshot(id, snapshot) {
    canonicalStringify(snapshot);
    const transaction = this.db.transaction('snapshots', 'readwrite');
    transaction.objectStore('snapshots').put({ id: String(id), value: cloneJson(snapshot) });
    await transactionDone(transaction);
  }

  async getSnapshot(id) {
    const transaction = this.db.transaction('snapshots', 'readonly');
    const row = await requestResult(transaction.objectStore('snapshots').get(String(id)));
    await transactionDone(transaction);
    return row ? cloneJson(row.value) : null;
  }

  close() {
    this.db.close();
  }
}
