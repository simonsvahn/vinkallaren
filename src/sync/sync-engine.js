import { createBatch, validateBatch } from './batch.js';
import { CursorResetError } from './errors.js';

const isBatchPath = path => /^\/ops\/.+\.json$/.test(path);

export class SyncEngine {
  constructor({ repository, transport, batchSize = 250 }) {
    if (!repository?.initialized) throw new TypeError('SyncEngine kräver initierad Repository');
    if (!transport || typeof transport.putBatch !== 'function' || typeof transport.listChanges !== 'function' || typeof transport.getJson !== 'function') throw new TypeError('SyncEngine kräver transport');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new TypeError('Ogiltig batchstorlek');
    this.repository = repository;
    this.transport = transport;
    this.batchSize = batchSize;
    this.keyPrefix = `sync:${transport.id || 'transport'}`;
  }

  async uploadLocal() {
    const uploadedSeq = await this.repository.store.getMeta(`${this.keyPrefix}:uploaded_seq`) ?? 0;
    const all = await this.repository.store.getAllOps();
    const pending = all
      .filter(op => op.device_id === this.repository.deviceId && op.seq > uploadedSeq)
      .sort((a, b) => a.seq - b.seq);
    let uploadedOps = 0;
    let uploadedBatches = 0;
    for (let index = 0; index < pending.length; index += this.batchSize) {
      const batch = createBatch(pending.slice(index, index + this.batchSize));
      await this.transport.putBatch(batch);
      await this.repository.store.putMeta(`${this.keyPrefix}:uploaded_seq`, batch.to_seq);
      uploadedOps += batch.ops.length;
      uploadedBatches += 1;
    }
    return { uploadedOps, uploadedBatches };
  }

  async downloadRemote({ allowCursorReset = true } = {}) {
    let cursor = await this.repository.store.getMeta(`${this.keyPrefix}:cursor`);
    let downloadedOps = 0;
    let downloadedBatches = 0;
    let resetUsed = false;
    while (true) {
      let page;
      try {
        page = await this.transport.listChanges(cursor);
      } catch (error) {
        if (error instanceof CursorResetError && allowCursorReset && !resetUsed) {
          cursor = null;
          resetUsed = true;
          continue;
        }
        throw error;
      }
      for (const entry of page.entries) {
        if (!isBatchPath(entry.path)) continue;
        const batch = await this.transport.getJson(entry.path);
        validateBatch(batch);
        await this.repository.applyRemoteOps(batch.ops);
        downloadedOps += batch.ops.length;
        downloadedBatches += 1;
      }
      cursor = page.cursor;
      await this.repository.store.putMeta(`${this.keyPrefix}:cursor`, cursor);
      if (!page.has_more) break;
    }
    return { downloadedOps, downloadedBatches, cursor, cursorReset: resetUsed };
  }

  async syncOnce() {
    const upload = await this.uploadLocal();
    const download = await this.downloadRemote();
    return { ...upload, ...download };
  }

  async waitAndSync({ timeoutMs = 30_000 } = {}) {
    let cursor = await this.repository.store.getMeta(`${this.keyPrefix}:cursor`);
    if (!cursor) {
      await this.syncOnce();
      cursor = await this.repository.store.getMeta(`${this.keyPrefix}:cursor`);
    }
    const result = await this.transport.waitForChanges(cursor, { timeoutMs });
    if (!result.changes) return { changes: false, backoff: result.backoff ?? null };
    return { changes: true, backoff: result.backoff ?? null, ...await this.syncOnce() };
  }
}
