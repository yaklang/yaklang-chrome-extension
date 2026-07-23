import { describe, expect, it, vi } from 'vitest';
import type { BrowserTransformDirection, BrowserTransformPacket } from '@/types/models';
import { assertTransformDirection, assertTransformRoute, executeTransformDirection, readTransformValue, wildcardUrlMatches } from './mapping';

function bodyBase64(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return btoa(unescape(encodeURIComponent(text)));
}

function decodeBody(value: string): string {
  return decodeURIComponent(escape(atob(value)));
}

const packet: BrowserTransformPacket = {
  method: 'POST',
  url: 'https://portal.example.test/api/login?source=manual',
  headers: [{ name: 'Content-Type', value: 'application/json' }],
  bodyBase64: bodyBase64({ account: 'alice', password: 'plain' }),
};

describe('browser transform Pipeline v2', () => {
  it('allows bounded literal values for generated headers', async () => {
    const direction: BrowserTransformDirection = {
      enabled: true,
      nodes: [
        { id: 'literal', name: 'Content type', kind: 'builtin', operation: 'value.literal', inputs: [], options: { value: 'application/x-www-form-urlencoded' } },
        { id: 'write', name: 'Write header', kind: 'output.write', source: { nodeId: 'literal' }, destination: 'header.Content-Type', encoding: 'text' },
      ],
    };
    const result = await executeTransformDirection('profile-1', 'request', direction, packet, vi.fn());
    expect(result.setHeaders).toEqual([{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
  });

  it('resolves explicit paths without allowing prototype traversal', () => {
    expect(readTransformValue({ body: { user: { id: 7 } } }, 'body.user.id')).toBe(7);
    expect(() => readTransformValue({ body: {} }, 'body.__proto__.polluted')).toThrow('不允许');
    expect(() => readTransformValue({ body: {} }, 'body.missing')).toThrow('不存在');
  });

  it('matches full URLs and paths with bounded wildcard syntax', () => {
    expect(wildcardUrlMatches('https://*.example.test/api/*', packet.url)).toBe(true);
    expect(wildcardUrlMatches('/api/*', packet.url)).toBe(true);
    expect(wildcardUrlMatches('/admin/*', packet.url)).toBe(false);
    expect(() => assertTransformRoute(['POST'], '/api/*', packet, 'https://portal.example.test')).not.toThrow();
    expect(() => assertTransformRoute(['POST'], '/api/*', { ...packet, url: 'https://outside.example.test/api/login' }, 'https://portal.example.test')).toThrow('不匹配页面来源');
  });

  it('runs typed nodes and writes JSON, Header, and Query outputs', async () => {
    const direction: BrowserTransformDirection = {
      enabled: true,
      nodes: [
        { id: 'password', name: 'Password', kind: 'context.read', path: 'body.password' },
        { id: 'account', name: 'Account', kind: 'context.read', path: 'body.account' },
        { id: 'cipher', name: 'Encrypt', kind: 'page.call', callableId: 'encrypt', arguments: [{ nodeId: 'password' }] },
        { id: 'signature', name: 'Sign', kind: 'page.call', callableId: 'sign', arguments: [{ nodeId: 'account' }, { nodeId: 'cipher' }] },
        { id: 'write-body', name: 'Write cipher', kind: 'output.write', source: { nodeId: 'cipher' }, destination: 'body.password', encoding: 'auto' },
        { id: 'write-header', name: 'Write signature', kind: 'output.write', source: { nodeId: 'signature' }, destination: 'header.X-Sign', encoding: 'text' },
        { id: 'write-query', name: 'Write mode', kind: 'output.write', source: { nodeId: 'account' }, destination: 'query.actor', encoding: 'text' },
      ],
    };
    const invoke = vi.fn(async (callableId: string, args: unknown[]) => ({
      callableId,
      type: 'string',
      preview: callableId,
      value: callableId === 'encrypt' ? `cipher:${args[0]}` : `sig:${args.join(':')}`,
      durationMs: 1,
    }));

    const result = await executeTransformDirection('profile-1', 'request', direction, packet, invoke);

    expect(JSON.parse(decodeBody(result.bodyBase64))).toEqual({ account: 'alice', password: 'cipher:plain' });
    expect(result.setHeaders).toEqual([{ name: 'X-Sign', value: 'sig:alice:cipher:plain' }]);
    expect(new URL(result.url).searchParams.get('actor')).toBe('alice');
    expect(result.nodeDurations).toHaveLength(direction.nodes.length);
    expect(invoke).toHaveBeenNthCalledWith(2, 'sign', ['alice', 'cipher:plain']);
  });

  it('executes white-listed builtins and preserves form serialization', async () => {
    const formPacket: BrowserTransformPacket = {
      ...packet,
      headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      bodyBase64: bodyBase64('username=alice&password=plain'),
    };
    const direction: BrowserTransformDirection = {
      enabled: true,
      nodes: [
        { id: 'password', name: 'Password', kind: 'context.read', path: 'body.password' },
        { id: 'encoded', name: 'URL encode', kind: 'builtin', operation: 'url.encode', inputs: [{ nodeId: 'password' }] },
        { id: 'write', name: 'Write', kind: 'output.write', source: { nodeId: 'encoded' }, destination: 'body.password', encoding: 'text' },
      ],
    };
    const result = await executeTransformDirection('profile-1', 'request', direction, formPacket, vi.fn());
    expect(decodeBody(result.bodyBase64)).toBe('username=alice&password=plain');
  });

  it('maps normalized page bytes to a binary body', async () => {
    const direction: BrowserTransformDirection = {
      enabled: true,
      nodes: [
        { id: 'wire', name: 'Wire', kind: 'context.read', path: 'bodyBase64' },
        { id: 'plain', name: 'Decrypt', kind: 'page.call', callableId: 'decrypt', arguments: [{ nodeId: 'wire' }] },
        { id: 'write', name: 'Write', kind: 'output.write', source: { nodeId: 'plain' }, destination: 'body', encoding: 'auto' },
      ],
    };
    const result = await executeTransformDirection('profile-1', 'response', direction, packet, async (callableId) => ({
      callableId,
      type: 'object',
      preview: 'bytes',
      value: { type: 'bytes', byteLength: 5, base64: btoa('hello') },
      durationMs: 1,
    }));
    expect(atob(result.bodyBase64)).toBe('hello');
  });

  it('rejects forward references before invoking a page function', () => {
    const direction: BrowserTransformDirection = {
      enabled: true,
      nodes: [
        { id: 'call', name: 'Call', kind: 'page.call', callableId: 'encrypt', arguments: [{ nodeId: 'future' }] },
        { id: 'future', name: 'Future', kind: 'context.read', path: 'body' },
        { id: 'write', name: 'Write', kind: 'output.write', source: { nodeId: 'call' }, destination: 'body', encoding: 'auto' },
      ],
    };
    expect(() => assertTransformDirection(direction)).toThrow('尚未产生');
  });

  it('rejects excessively deep context before invoking a page function', async () => {
    let body: Record<string, unknown> = {};
    const root = body;
    for (let index = 0; index < 70; index += 1) {
      const next: Record<string, unknown> = {};
      body.next = next;
      body = next;
    }
    const invoke = vi.fn();
    const direction: BrowserTransformDirection = {
      enabled: true,
      nodes: [
        { id: 'input', name: 'Input', kind: 'context.read', path: 'body' },
        { id: 'call', name: 'Encrypt', kind: 'page.call', callableId: 'encrypt', arguments: [{ nodeId: 'input' }] },
        { id: 'write', name: 'Write', kind: 'output.write', source: { nodeId: 'call' }, destination: 'body', encoding: 'auto' },
      ],
    };
    await expect(executeTransformDirection('profile-1', 'request', direction, { ...packet, bodyBase64: bodyBase64(root) }, invoke)).rejects.toThrow('嵌套超过 64 层');
    expect(invoke).not.toHaveBeenCalled();
  });
});
