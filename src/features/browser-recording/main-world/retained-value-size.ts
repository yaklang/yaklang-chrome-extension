const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_NODES = 4_096;
const MAX_PROPERTIES_PER_OBJECT = 256;
const REFERENCE_BYTES = 64;
const CONTAINER_BYTES = 48;
const PROPERTY_BYTES = 16;

interface EstimateState {
  maxBytes: number;
  nodes: number;
  seen: WeakSet<object>;
}

function stringBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function exceeds(state: EstimateState): number {
  return state.maxBytes + 1;
}

function add(left: number, right: number, state: EstimateState): number {
  const total = left + right;
  return total > state.maxBytes ? exceeds(state) : total;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function estimateObject(value: object, state: EstimateState, depth: number): number {
  if (state.seen.has(value)) return REFERENCE_BYTES;
  if (depth > MAX_DEPTH || ++state.nodes > MAX_NODES) return exceeds(state);
  state.seen.add(value);

  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return add(CONTAINER_BYTES, value.size, state);
  }
  if (value instanceof ArrayBuffer) return add(CONTAINER_BYTES, value.byteLength, state);
  if (ArrayBuffer.isView(value)) return add(CONTAINER_BYTES, value.byteLength, state);
  if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
    return add(CONTAINER_BYTES, stringBytes(value.toString()), state);
  }
  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    let total = CONTAINER_BYTES;
    let entries = 0;
    for (const [key, item] of value.entries()) {
      if (++entries > MAX_PROPERTIES_PER_OBJECT) return exceeds(state);
      total = add(total, PROPERTY_BYTES + stringBytes(key), state);
      total = add(total, typeof item === 'string' ? stringBytes(item) : item.size, state);
      if (total > state.maxBytes) return total;
    }
    return total;
  }

  const sigBytes = (value as { sigBytes?: unknown }).sigBytes;
  if (typeof sigBytes === 'number' && Number.isFinite(sigBytes) && sigBytes >= 0) {
    return add(CONTAINER_BYTES, Math.ceil(sigBytes), state);
  }

  if (value instanceof Date || value instanceof RegExp) return REFERENCE_BYTES;
  if (!Array.isArray(value) && !isPlainObject(value)) return REFERENCE_BYTES;

  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return exceeds(state);
  }
  const entries = Object.entries(descriptors);
  if (entries.length > MAX_PROPERTIES_PER_OBJECT) return exceeds(state);

  let total = CONTAINER_BYTES;
  for (const [key, descriptor] of entries) {
    total = add(total, PROPERTY_BYTES + stringBytes(key), state);
    if (total > state.maxBytes) return total;
    if (!('value' in descriptor)) {
      total = add(total, REFERENCE_BYTES, state);
      continue;
    }
    total = add(total, estimateRetainedValueBytes(descriptor.value, state, depth + 1), state);
    if (total > state.maxBytes) return total;
  }
  return total;
}

function estimateRetainedValueBytes(value: unknown, state: EstimateState, depth: number): number {
  if (value === undefined || value === null) return 8;
  if (typeof value === 'string') return stringBytes(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return 16;
  if (typeof value === 'function' || typeof value === 'symbol') return REFERENCE_BYTES;
  return estimateObject(value, state, depth);
}

/**
 * Estimates the payload retained by a document-bound replay handle without
 * serializing the values. CryptoJS option objects intentionally contain shared
 * and cyclic library references; those are counted as references while actual
 * strings, buffers, blobs, arrays, and plain-object data remain budgeted.
 */
export function estimateRetainedCallBytes(
  args: unknown[],
  maxBytes = DEFAULT_MAX_BYTES,
): number {
  const state: EstimateState = {
    maxBytes,
    nodes: 0,
    seen: new WeakSet<object>(),
  };
  let total = CONTAINER_BYTES;
  for (const value of args) {
    total = add(total, estimateRetainedValueBytes(value, state, 0), state);
    if (total > maxBytes) return total;
  }
  return total;
}
