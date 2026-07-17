let fallbackSequence = 0;

function randomHex(byteLength: number): string | undefined {
  try {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') return undefined;
    const bytes = cryptoApi.getRandomValues(new Uint8Array(byteLength));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

export function createOpaqueId(prefix: string): string {
  const entropy = randomHex(16);
  if (entropy) return `${prefix}-${entropy}`;

  fallbackSequence = (fallbackSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
}
