function assertJson(value, path) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} innehåller ett icke-ändligt tal`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJson(entry, `${path}[${index}]`));
    return;
  }
  if (type === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, entry] of Object.entries(value)) assertJson(entry, `${path}.${key}`);
    return;
  }
  throw new TypeError(`${path} är inte ett giltigt JSON-värde`);
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = sortJson(value[key]);
      return out;
    }, {});
  }
  return value;
}

export function assertJsonValue(value, path = 'value') {
  assertJson(value, path);
  return value;
}

export function cloneJson(value) {
  assertJsonValue(value);
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function canonicalStringify(value) {
  assertJsonValue(value);
  return JSON.stringify(sortJson(value));
}
