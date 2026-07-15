import { compareHLC, createClock } from './hlc.js';
import { Materializer } from './materializer.js';
import { createDeleteOperation, createRestoreOperation, createSetOperation, validateOperation } from './operations.js';

export class Repository {
  constructor({ store, deviceId, now = () => Date.now() }) {
    const required = ['appendOps', 'getAllOps', 'getMeta', 'putMeta', 'getSnapshot', 'saveSnapshot'];
    if (!store || required.some(method => typeof store[method] !== 'function')) throw new TypeError('Repository kräver ett komplett op-lager');
    if (typeof deviceId !== 'string' || !deviceId) throw new TypeError('Repository kräver deviceId');
    this.store = store;
    this.deviceId = deviceId;
    this.now = now;
    this.state = new Materializer();
    this.seq = 0;
    this.clock = null;
    this.initialized = false;
  }

  async init() {
    const ops = await this.store.getAllOps();
    const latestSnapshotId = await this.store.getMeta('latest_snapshot');
    const snapshot = latestSnapshotId ? await this.store.getSnapshot(latestSnapshotId) : null;
    this.state = new Materializer(snapshot);
    this.state.applyAll(ops);
    const snapshotOwnMax = snapshot?.applied?.reduce((max, entry) => {
      const prefix = `${this.deviceId}:`;
      if (!entry.op_id.startsWith(prefix)) return max;
      const seq = Number(entry.op_id.slice(prefix.length));
      return Number.isSafeInteger(seq) ? Math.max(max, seq) : max;
    }, 0) ?? 0;
    const ownMax = ops.reduce((max, op) => op.device_id === this.deviceId ? Math.max(max, op.seq) : max, snapshotOwnMax);
    const storedSeq = await this.store.getMeta(`seq:${this.deviceId}`);
    this.seq = Math.max(ownMax, Number.isSafeInteger(storedSeq) ? storedSeq : 0);
    const snapshotHlcs = snapshot?.entities?.flatMap(entity => entity.fields.map(cell => cell.hlc)) ?? [];
    const latestHlc = [...snapshotHlcs, ...ops.map(op => op.hlc)].reduce((latest, value) => !latest || compareHLC(value, latest) > 0 ? value : latest, null);
    this.clock = createClock(this.deviceId, this.now, latestHlc);
    this.initialized = true;
    return this;
  }

  assertReady() {
    if (!this.initialized) throw new Error('Repository.init() måste köras först');
  }

  async commit(factory) {
    this.assertReady();
    const nextSeq = this.seq + 1;
    const operation = factory(nextSeq, this.clock.tick());
    await this.store.appendOps([operation]);
    this.state.apply(operation);
    this.seq = nextSeq;
    await this.store.putMeta(`seq:${this.deviceId}`, this.seq);
    return operation;
  }

  setField(entityType, entityId, field, value) {
    return this.commit((seq, hlc) => createSetOperation({
      deviceId: this.deviceId, seq, entityType, entityId, field, value, hlc
    }));
  }

  deleteEntity(entityType, entityId) {
    return this.commit((seq, hlc) => createDeleteOperation({
      deviceId: this.deviceId, seq, entityType, entityId, hlc
    }));
  }

  restoreEntity(entityType, entityId) {
    return this.commit((seq, hlc) => createRestoreOperation({
      deviceId: this.deviceId, seq, entityType, entityId, hlc
    }));
  }

  async applyRemoteOps(ops) {
    this.assertReady();
    ops.forEach(validateOperation);
    await this.store.appendOps(ops);
    const result = this.state.applyAll(ops);
    const latest = ops.reduce((value, op) => !value || compareHLC(op.hlc, value) > 0 ? op.hlc : value, null);
    if (latest) this.clock.observe(latest);
    return result;
  }

  getEntity(type, id, options) {
    this.assertReady();
    return this.state.getEntity(type, id, options);
  }

  listEntities(type, options) {
    this.assertReady();
    return this.state.listEntities(type, options);
  }

  async saveSnapshot(id = 'latest') {
    this.assertReady();
    const snapshot = this.state.exportSnapshot();
    await this.store.saveSnapshot(id, snapshot);
    await this.store.putMeta('latest_snapshot', String(id));
    return snapshot;
  }
}
