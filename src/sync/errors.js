export class CursorResetError extends Error {
  constructor(message = 'Synkcursor måste återställas') {
    super(message);
    this.name = 'CursorResetError';
  }
}

export class TransportError extends Error {
  constructor(message, { status = null, code = null, retryAfter = null, cause = null } = {}) {
    super(message, { cause });
    this.name = 'TransportError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
