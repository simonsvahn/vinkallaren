import { TransportError } from './errors.js';

export const SYNC_STATUS = Object.freeze({
  OFFLINE: 'offline',
  LOCAL_SAVED: 'local_saved',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  ACTION_REQUIRED: 'action_required'
});

export const SYNC_STATUS_LABEL = Object.freeze({
  [SYNC_STATUS.OFFLINE]: 'Offline · lokalt sparat',
  [SYNC_STATUS.LOCAL_SAVED]: 'Lokalt sparat',
  [SYNC_STATUS.SYNCING]: 'Synkar…',
  [SYNC_STATUS.SYNCED]: 'Synkad',
  [SYNC_STATUS.ACTION_REQUIRED]: 'Åtgärd krävs'
});

const defaultOnline = () => globalThis.navigator?.onLine !== false;
const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export class SyncSession {
  constructor({ engine, isOnline = defaultOnline, sleep = defaultSleep, onStatus = () => {}, maxRateLimitRetries = 1 }) {
    if (!engine || typeof engine.syncOnce !== 'function') throw new TypeError('SyncSession kräver synkmotor');
    if (!Number.isSafeInteger(maxRateLimitRetries) || maxRateLimitRetries < 0) throw new TypeError('Ogiltigt antal rate-limit-försök');
    this.engine = engine;
    this.isOnline = isOnline;
    this.sleep = sleep;
    this.onStatus = onStatus;
    this.maxRateLimitRetries = maxRateLimitRetries;
    this.status = SYNC_STATUS.LOCAL_SAVED;
    this.detail = null;
  }

  setStatus(status, detail = null) {
    if (!Object.values(SYNC_STATUS).includes(status)) throw new TypeError('Ogiltig synkstatus');
    this.status = status;
    this.detail = detail;
    this.onStatus({ status, label: SYNC_STATUS_LABEL[status], detail });
    return this.status;
  }

  markLocalSaved() {
    return this.setStatus(this.isOnline() ? SYNC_STATUS.LOCAL_SAVED : SYNC_STATUS.OFFLINE);
  }

  async syncOnce() {
    if (!this.isOnline()) {
      this.setStatus(SYNC_STATUS.OFFLINE);
      return { skipped: true, reason: 'offline' };
    }

    let rateLimitRetries = 0;
    while (true) {
      this.setStatus(SYNC_STATUS.SYNCING);
      try {
        const result = await this.engine.syncOnce();
        this.setStatus(SYNC_STATUS.SYNCED, result);
        return result;
      } catch (error) {
        if (!this.isOnline()) {
          this.setStatus(SYNC_STATUS.OFFLINE, { error });
          throw error;
        }
        if (error instanceof TransportError && error.status === 401) {
          this.setStatus(SYNC_STATUS.ACTION_REQUIRED, { reason: 'token_expired', error });
          throw error;
        }
        if (error instanceof TransportError && error.status === 429 && rateLimitRetries < this.maxRateLimitRetries) {
          rateLimitRetries += 1;
          const retryAfterSeconds = Number.isFinite(error.retryAfter) && error.retryAfter >= 0 ? error.retryAfter : 1;
          this.setStatus(SYNC_STATUS.LOCAL_SAVED, { reason: 'rate_limited', retryAfterSeconds, attempt: rateLimitRetries });
          await this.sleep(retryAfterSeconds * 1000);
          if (!this.isOnline()) {
            this.setStatus(SYNC_STATUS.OFFLINE);
            throw error;
          }
          continue;
        }
        this.setStatus(SYNC_STATUS.ACTION_REQUIRED, { reason: 'sync_failed', error });
        throw error;
      }
    }
  }
}
