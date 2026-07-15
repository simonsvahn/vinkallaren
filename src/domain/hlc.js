const NODE_RE = /^[A-Za-z0-9._~:-]{1,80}$/;
const HLC_RE = /^(\d{13})-(\d{6})-([A-Za-z0-9._~:-]{1,80})$/;

export function validateNodeId(node) {
  if (!NODE_RE.test(String(node || ''))) throw new TypeError('Ogiltigt HLC-enhets-id');
  return String(node);
}

export function formatHLC({ wallTime, counter, node }) {
  if (!Number.isSafeInteger(wallTime) || wallTime < 0 || wallTime > 9_999_999_999_999) throw new TypeError('Ogiltig HLC-tid');
  if (!Number.isSafeInteger(counter) || counter < 0 || counter > 999_999) throw new TypeError('Ogiltig HLC-räknare');
  return `${String(wallTime).padStart(13, '0')}-${String(counter).padStart(6, '0')}-${validateNodeId(node)}`;
}

export function parseHLC(value) {
  const match = HLC_RE.exec(String(value || ''));
  if (!match) throw new TypeError('Ogiltig HLC-sträng');
  return { wallTime: Number(match[1]), counter: Number(match[2]), node: match[3] };
}

export function compareHLC(left, right) {
  const a = typeof left === 'string' ? parseHLC(left) : left;
  const b = typeof right === 'string' ? parseHLC(right) : right;
  if (a.wallTime !== b.wallTime) return a.wallTime < b.wallTime ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.node === b.node ? 0 : (a.node < b.node ? -1 : 1);
}

export function createClock(nodeId, now = () => Date.now(), initial = null) {
  const node = validateNodeId(nodeId);
  let state = initial ? parseHLC(initial) : { wallTime: 0, counter: 0, node };
  if (state.node !== node) state = { wallTime: state.wallTime, counter: state.counter, node };

  function tick(remoteValue = null) {
    const localWall = Number(now());
    if (!Number.isSafeInteger(localWall) || localWall < 0) throw new TypeError('Klockan gav en ogiltig tid');
    const remote = remoteValue ? parseHLC(remoteValue) : null;
    const wallTime = Math.max(localWall, state.wallTime, remote?.wallTime ?? 0);
    let counter = 0;
    if (wallTime === state.wallTime && remote && wallTime === remote.wallTime) counter = Math.max(state.counter, remote.counter) + 1;
    else if (wallTime === state.wallTime) counter = state.counter + 1;
    else if (remote && wallTime === remote.wallTime) counter = remote.counter + 1;
    state = { wallTime, counter, node };
    return formatHLC(state);
  }

  return Object.freeze({
    tick,
    observe: tick,
    get value() { return formatHLC(state); },
    get state() { return { ...state }; }
  });
}
