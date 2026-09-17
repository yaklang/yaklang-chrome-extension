export async function readRequestBody(request: Request, maximumBytes = 8 * 1024 * 1024): Promise<{
  text: string;
  value: string | FormData;
  contentType: string;
}> {
  const contentType = request.headers.get('content-type') || '';
  const reader = request.clone().body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > maximumBytes) {
          void reader.cancel().catch(() => undefined);
          throw new Error(`请求 Body 超过 ${maximumBytes} B`);
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (contentType.toLowerCase().includes('multipart/form-data')) {
    const value = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
    const fields = new URLSearchParams();
    for (const [key, item] of value) {
      if (typeof item !== 'string') throw new Error(`表单字段 ${key} 包含文件，暂不允许自动回放`);
      fields.append(key, item);
    }
    return { text: fields.toString(), value, contentType: 'application/x-www-form-urlencoded' };
  }
  const text = new TextDecoder().decode(bytes);
  return { text, value: text, contentType };
}
