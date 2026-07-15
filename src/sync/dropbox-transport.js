import { canonicalStringify, cloneJson } from '../domain/canonical.js';
import { batchPath, validateBatch } from './batch.js';
import { CursorResetError, TransportError } from './errors.js';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';
const NOTIFY = 'https://notify.dropboxapi.com/2';

const normalizePath = value => {
  const path = String(value || '');
  if (!path.startsWith('/') || path.includes('..')) throw new TypeError('Ogiltig Dropbox-väg');
  return path;
};

const parentPath = path => path.slice(0, path.lastIndexOf('/')) || '/';

export class DropboxTransport {
  constructor({ accessToken, fetchImpl = (...args) => globalThis.fetch(...args), id = 'dropbox' }) {
    if (!accessToken) throw new TypeError('Dropbox access token saknas');
    if (!fetchImpl) throw new TypeError('fetch saknas');
    this.accessToken = accessToken;
    this.fetch = fetchImpl.bind(globalThis);
    this.id = id;
    this.knownFolders = new Set(['/']);
  }

  async parseError(response) {
    const text = await response.text().catch(() => '');
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = {}; }
    const summary = payload.error_summary || payload.error?.['.tag'] || text || `HTTP ${response.status}`;
    if (summary.includes('reset')) throw new CursorResetError(summary);
    const retryHeader = response.headers?.get?.('Retry-After');
    const retryAfter = retryHeader === null || retryHeader === undefined ? null : Number(retryHeader);
    throw new TransportError(`Dropbox: ${summary}`, {
      status: response.status,
      code: summary,
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : null
    });
  }

  async rpc(route, body) {
    const response = await this.fetch(`${API}${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) return this.parseError(response);
    return response.json();
  }

  async ensureFolder(pathValue) {
    const path = normalizePath(pathValue);
    if (path === '/' || this.knownFolders.has(path)) return;
    try {
      await this.rpc('/files/create_folder_v2', { path, autorename: false });
    } catch (error) {
      if (!(error instanceof TransportError) || error.status !== 409 || !String(error.code).includes('conflict/folder')) throw error;
    }
    this.knownFolders.add(path);
  }

  async upload(pathValue, value, mode) {
    const path = normalizePath(pathValue);
    await this.ensureFolder(parentPath(path));
    const response = await this.fetch(`${CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path, mode, autorename: false, mute: true, strict_conflict: true })
      },
      body: JSON.stringify(value)
    });
    if (!response.ok) return this.parseError(response);
    return response.json();
  }

  async putImmutable(path, value) {
    try {
      await this.upload(path, value, 'add');
      return { path, created: true };
    } catch (error) {
      if (!(error instanceof TransportError) || error.status !== 409 || !String(error.code).includes('conflict')) throw error;
      const existing = await this.getJson(path);
      if (canonicalStringify(existing) !== canonicalStringify(value)) throw new Error(`Oföränderlig Dropbox-kollision: ${path}`);
      return { path, created: false };
    }
  }

  async putMutable(path, value) {
    await this.upload(path, value, 'overwrite');
    return { path, created: true };
  }

  async getJson(pathValue) {
    const path = normalizePath(pathValue);
    const response = await this.fetch(`${CONTENT}/files/download`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Dropbox-API-Arg': JSON.stringify({ path }) }
    });
    if (!response.ok) return this.parseError(response);
    return cloneJson(await response.json());
  }

  async putBatch(batch) {
    validateBatch(batch);
    return this.putImmutable(batchPath(batch.device_id, batch.from_seq, batch.to_seq), batch);
  }

  async listChanges(cursor = null) {
    let result;
    if (cursor) {
      result = await this.rpc('/files/list_folder/continue', { cursor });
    } else {
      await this.ensureFolder('/ops');
      result = await this.rpc('/files/list_folder', {
        path: '/ops', recursive: false, include_deleted: false, include_non_downloadable_files: false
      });
    }
    return {
      entries: (result.entries || [])
        .filter(entry => entry['.tag'] === 'file' && entry.path_display?.endsWith('.json'))
        .map(entry => ({ path: entry.path_display, rev: entry.rev })),
      cursor: result.cursor,
      has_more: Boolean(result.has_more)
    };
  }

  async getLatestCursor() {
    await this.ensureFolder('/ops');
    const result = await this.rpc('/files/list_folder/get_latest_cursor', {
      path: '/ops', recursive: false, include_deleted: false, include_non_downloadable_files: false
    });
    return result.cursor;
  }

  async waitForChanges(cursor, { timeoutMs = 30_000 } = {}) {
    const timeout = Math.max(30, Math.min(480, Math.ceil(timeoutMs / 1000)));
    const response = await this.fetch(`${NOTIFY}/files/list_folder/longpoll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cursor, timeout })
    });
    if (!response.ok) return this.parseError(response);
    const result = await response.json();
    return { changes: Boolean(result.changes), backoff: result.backoff ?? null };
  }
}
