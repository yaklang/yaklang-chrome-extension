import {
  PAGE_REQUEST_EVENT,
  PAGE_RESPONSE_EVENT,
  type PageBridgeRequest,
  type PageBridgeResponse,
} from '@/features/page-context/protocol';

export default defineUnlistedScript(() => {
  const script = document.currentScript;
  if (!script || script.getAttribute('data-yakit-page-bridge-ready') === 'true') return;
  script.setAttribute('data-yakit-page-bridge-ready', 'true');

  const MAX_DEPTH = 6;
  const MAX_ITEMS = 100;
  const MAX_STRING = 100_000;

  function serialize(value: unknown): { value: unknown; type: string; preview: string; truncated: boolean } {
    const seen = new WeakSet<object>();
    let truncated = false;

    const visit = (input: unknown, depth: number): unknown => {
      if (input === null) return null;
      if (typeof input === 'string') {
        if (input.length > MAX_STRING) truncated = true;
        return input.slice(0, MAX_STRING);
      }
      if (typeof input === 'number' || typeof input === 'boolean') return input;
      if (typeof input === 'undefined') return { $type: 'undefined' };
      if (typeof input === 'bigint') return { $type: 'bigint', value: input.toString() };
      if (typeof input === 'symbol') return { $type: 'symbol', value: String(input) };
      if (typeof input === 'function') {
        const source = Function.prototype.toString.call(input);
        if (source.length > 2_000) truncated = true;
        return { $type: 'function', name: input.name || '', source: source.slice(0, 2_000) };
      }
      if (depth >= MAX_DEPTH) {
        truncated = true;
        return { $type: 'max-depth', constructor: (input as object).constructor?.name || 'Object' };
      }
      if (seen.has(input as object)) return { $type: 'circular' };
      seen.add(input as object);

      if (input instanceof Error) {
        return { $type: 'error', name: input.name, message: input.message, stack: input.stack?.slice(0, 10_000) };
      }
      if (input instanceof Date) return { $type: 'date', value: input.toISOString() };
      if (input instanceof RegExp) return { $type: 'regexp', value: String(input) };
      if (input instanceof Node) {
        const element = input instanceof Element ? input : input.parentElement;
        const html = element?.outerHTML || input.textContent || '';
        if (html.length > 10_000) truncated = true;
        return {
          $type: 'node',
          name: input.nodeName,
          html: html.slice(0, 10_000),
        };
      }
      if (Array.isArray(input)) {
        if (input.length > MAX_ITEMS) truncated = true;
        return input.slice(0, MAX_ITEMS).map((item) => visit(item, depth + 1));
      }

      const output: Record<string, unknown> = {};
      const keys = Reflect.ownKeys(input as object).slice(0, MAX_ITEMS);
      if (Reflect.ownKeys(input as object).length > MAX_ITEMS) truncated = true;
      for (const key of keys) {
        const name = typeof key === 'symbol' ? `[${String(key)}]` : key;
        try {
          output[name] = visit(Reflect.get(input as object, key), depth + 1);
        } catch (error) {
          output[name] = { $type: 'unreadable', message: error instanceof Error ? error.message : String(error) };
        }
      }
      return output;
    };

    const normalized = visit(value, 0);
    let preview: string;
    try {
      preview = typeof value === 'string' ? value : JSON.stringify(normalized);
    } catch {
      preview = String(value);
    }
    return {
      value: normalized,
      type: value === null ? 'null' : typeof value,
      preview: preview.slice(0, 2_000),
      truncated: truncated || preview.length > 2_000,
    };
  }

  script.addEventListener(PAGE_REQUEST_EVENT, (rawEvent) => {
    if (!(rawEvent instanceof CustomEvent) || typeof rawEvent.detail !== 'string') return;
    void (async () => {
      let request: PageBridgeRequest;
      try {
        request = JSON.parse(rawEvent.detail) as PageBridgeRequest;
      } catch {
        return;
      }
      const startedAt = performance.now();
      let response: PageBridgeResponse;
      try {
        let rawResult: unknown;
        if (request.operation === 'eval') {
          const source = request.mode === 'expression'
            ? `(${request.code}\n)`
            : `(async () => {\n${request.code}\n})()`;
          rawResult = (0, eval)(source);
        } else {
          const segments = request.path.split('.').filter(Boolean);
          let owner: unknown = window;
          let target: unknown = window;
          for (const segment of segments) {
            owner = target;
            target = Reflect.get(target as object, segment);
          }
          if (typeof target !== 'function') throw new TypeError(`${request.path} is not a function`);
          rawResult = Reflect.apply(target, owner, request.args);
        }
        const result = serialize(await rawResult);
        response = {
          id: request.id,
          ok: true,
          result: { ...result, durationMs: Math.round((performance.now() - startedAt) * 100) / 100 },
        };
      } catch (error) {
        response = {
          id: request.id,
          ok: false,
          error: {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack?.slice(0, 10_000) : undefined,
          },
        };
      }
      script.dispatchEvent(new CustomEvent(PAGE_RESPONSE_EVENT, { detail: JSON.stringify(response) }));
    })();
  });
});
