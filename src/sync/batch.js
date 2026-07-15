import { cloneJson } from '../domain/canonical.js';
import { validateOperation } from '../domain/operations.js';

export function batchPath(deviceId, fromSeq, toSeq) {
  return `/ops/${encodeURIComponent(deviceId)}-${String(fromSeq).padStart(10, '0')}-${String(toSeq).padStart(10, '0')}.json`;
}

export function createBatch(ops) {
  if (!Array.isArray(ops) || !ops.length) throw new TypeError('En op-batch får inte vara tom');
  const sorted = [...ops].sort((a, b) => a.seq - b.seq);
  sorted.forEach(validateOperation);
  const deviceId = sorted[0].device_id;
  if (sorted.some(op => op.device_id !== deviceId)) throw new Error('En batch får bara innehålla en enhet');
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].seq !== sorted[index - 1].seq + 1) throw new Error('En batch måste ha sammanhängande sekvenser');
  }
  const fromSeq = sorted[0].seq;
  const toSeq = sorted.at(-1).seq;
  return {
    batch_version: 1,
    device_id: deviceId,
    from_seq: fromSeq,
    to_seq: toSeq,
    ops: sorted.map(cloneJson)
  };
}

export function validateBatch(batch) {
  if (!batch || batch.batch_version !== 1 || typeof batch.device_id !== 'string' || !Array.isArray(batch.ops) || !batch.ops.length) throw new TypeError('Ogiltig op-batch');
  const normalized = createBatch(batch.ops);
  if (normalized.device_id !== batch.device_id || normalized.from_seq !== batch.from_seq || normalized.to_seq !== batch.to_seq) throw new Error('Batchens metadata matchar inte operationerna');
  return batch;
}
