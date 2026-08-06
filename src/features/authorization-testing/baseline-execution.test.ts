import { describe, expect, it } from 'vitest';
import {
  applyAuthorizationTransformExecution,
  authorizationRequestToTransformPacket,
  compileAuthorizationBaselineRequest,
  extractAuthorizationResourceValue,
  parseAuthorizationRequestPacket,
  replaceAuthorizationResourceValue,
} from './baseline-execution';
import { fingerprintAuthorizationComparisonValue } from './baseline-metadata';

function base64(value: string): string {
  return btoa(value);
}

describe('authorization baseline execution primitives', () => {
  it('parses a bounded request packet without discarding captured credentials', () => {
    const packet = parseAuthorizationRequestPacket(base64([
      'GET /api/orders/42 HTTP/1.1',
      'Host: example.test',
      'Cookie: session=secret',
      'Authorization: Bearer secret',
      'X-CSRF-Token: csrf-secret',
      'Sec-Fetch-Site: same-origin',
      '',
      '',
    ].join('\r\n')));
    expect(packet.method).toBe('GET');
    expect(packet.headers).toEqual([
      { name: 'Host', value: 'example.test' },
      { name: 'Cookie', value: 'session=secret' },
      { name: 'Authorization', value: 'Bearer secret' },
      { name: 'X-CSRF-Token', value: 'csrf-secret' },
      { name: 'Sec-Fetch-Site', value: 'same-origin' },
    ]);
  });

  it('extracts and replaces a normalized path resource without changing the origin', () => {
    const value = extractAuthorizationResourceValue(
      'https://example.test/api/orders/42?view=full',
      '',
      'baseline-left',
      { location: 'path', path: 'path.segment[2]' },
      'workspace-hmac-sha256:a'.padEnd(86, 'a'),
    );
    const replaced = replaceAuthorizationResourceValue(
      'https://example.test/api/orders/42?view=full',
      { location: 'path', path: 'path.segment[2]' },
      '84',
    );

    expect(atob(value.valueBase64)).toBe('42');
    expect(replaced).toBe('https://example.test/api/orders/84?view=full');
  });

  it('addresses repeated query parameters by occurrence', () => {
    const url = 'https://example.test/api/orders?id=42&view=full&id=84';
    const value = extractAuthorizationResourceValue(
      url,
      '',
      'baseline-right',
      { location: 'query', path: 'query.id[1]' },
      'workspace-hmac-sha256:b'.padEnd(86, 'b'),
    );
    const replaced = replaceAuthorizationResourceValue(
      url,
      { location: 'query', path: 'query.id[1]' },
      '126',
    );

    expect(atob(value.valueBase64)).toBe('84');
    expect(replaced).toBe('https://example.test/api/orders?id=42&view=full&id=126');
    expect(() => extractAuthorizationResourceValue(
      url,
      '',
      'baseline-right',
      { location: 'query', path: 'query.id' },
      'workspace-hmac-sha256:b'.padEnd(86, 'b'),
    )).toThrow('多个同名值');
  });

  it('compiles a read-only request while retaining the exact captured header block', async () => {
    const comparisonKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const valueFingerprint = await fingerprintAuthorizationComparisonValue(comparisonKey, '84');
    const raw = [
      'GET /api/orders/42 HTTP/1.1',
      'Host: example.test',
      'Cookie: session=secret',
      'Authorization: Bearer secret',
      '',
      '',
    ].join('\r\n');
    const compiled = await compileAuthorizationBaselineRequest({
      baselineId: 'baseline-left',
      rawRequestBase64: base64(raw),
      requestUrl: 'https://example.test/api/orders/42',
      publicUrl: 'https://example.test/api/orders/:resource',
      selector: { source: 'wire', location: 'path', path: 'path.segment[2]' },
      replacement: {
        version: 1,
        baselineId: 'baseline-right',
        source: 'wire',
        location: 'path',
        path: 'path.segment[2]',
        valueType: 'string',
        byteLength: 2,
        valueBase64: base64('84'),
        valueFingerprint,
      },
      comparisonKey,
      isHttps: true,
    });

    const request = atob(compiled.rawRequestBase64);
    expect(request).toContain('GET /api/orders/84 HTTP/1.1\r\n');
    expect(request).toContain('Cookie: session=secret\r\n');
    expect(request).toContain('Authorization: Bearer secret\r\n');
    expect(compiled.resourceValueFingerprint).toBe(valueFingerprint);
  });

  it('replaces an explicit resource Header without copying another identity credential', async () => {
    const comparisonKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const valueFingerprint = await fingerprintAuthorizationComparisonValue(comparisonKey, 'tenant-b');
    const raw = [
      'GET /api/orders HTTP/1.1',
      'Host: example.test',
      'Cookie: session=identity-a',
      'X-Tenant-Id: tenant-a',
      '',
      '',
    ].join('\r\n');
    const resource = extractAuthorizationResourceValue(
      'https://example.test/api/orders',
      base64(raw),
      'baseline-left',
      { location: 'header', path: 'header.x-tenant-id' },
      await fingerprintAuthorizationComparisonValue(comparisonKey, 'tenant-a'),
    );
    const compiled = await compileAuthorizationBaselineRequest({
      baselineId: 'baseline-left',
      rawRequestBase64: base64(raw),
      requestUrl: 'https://example.test/api/orders',
      publicUrl: 'https://example.test/api/orders',
      selector: { source: 'wire', location: 'header', path: 'header.x-tenant-id' },
      replacement: {
        version: 1,
        baselineId: 'baseline-right',
        source: 'wire',
        location: 'header',
        path: 'header.x-tenant-id',
        valueType: 'string',
        byteLength: 8,
        valueBase64: base64('tenant-b'),
        valueFingerprint,
      },
      comparisonKey,
      isHttps: true,
    });

    expect(atob(resource.valueBase64)).toBe('tenant-a');
    expect(atob(compiled.rawRequestBase64)).toContain('X-Tenant-Id: tenant-b\r\n');
    expect(atob(compiled.rawRequestBase64)).toContain('Cookie: session=identity-a\r\n');
    expect(atob(compiled.rawRequestBase64)).not.toContain('session=identity-b');
  });

  it('replaces one GraphQL variable in a reviewed POST without changing the operation or credentials', async () => {
    const comparisonKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(13)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const valueFingerprint = await fingerprintAuthorizationComparisonValue(
      comparisonKey,
      '84',
    );
    const body = JSON.stringify({
      operationName: 'Order',
      query: 'query Order($orderId: ID!) { order(id: $orderId) { id total } }',
      variables: {
        orderId: 42,
        includeAudit: true,
      },
    });
    const raw = [
      'POST /graphql HTTP/1.1',
      'Host: example.test',
      'Content-Type: application/json',
      `Content-Length: ${new TextEncoder().encode(body).byteLength}`,
      'Cookie: session=identity-a',
      '',
      body,
    ].join('\r\n');

    const compiled = await compileAuthorizationBaselineRequest({
      baselineId: 'baseline-left',
      rawRequestBase64: base64(raw),
      requestUrl: 'https://example.test/graphql',
      publicUrl: 'https://example.test/graphql',
      selector: {
        source: 'wire',
        location: 'body',
        path: 'body.variables.orderId',
      },
      replacement: {
        version: 1,
        baselineId: 'baseline-right',
        source: 'wire',
        location: 'body',
        path: 'body.variables.orderId',
        valueType: 'number',
        byteLength: 2,
        valueBase64: base64('84'),
        valueFingerprint,
      },
      comparisonKey,
      isHttps: true,
    });

    const compiledPacket = parseAuthorizationRequestPacket(compiled.rawRequestBase64);
    const compiledBody = JSON.parse(new TextDecoder().decode(
      compiledPacket.bytes.subarray(compiledPacket.bodyOffset),
    ));
    expect(compiledBody.variables).toEqual({
      orderId: 84,
      includeAudit: true,
    });
    expect(compiledBody.query).toBe(
      'query Order($orderId: ID!) { order(id: $orderId) { id total } }',
    );
    expect(atob(compiled.rawRequestBase64)).toContain('Cookie: session=identity-a\r\n');
    expect(compiledPacket.headers.find(
      (header) => header.name.toLowerCase() === 'content-length',
    )?.value).toBe(String(new TextEncoder().encode(JSON.stringify(compiledBody)).byteLength));
  });

  it('addresses a GraphQL batch variable by its ordered operation index', async () => {
    const comparisonKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(17)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const valueFingerprint = await fingerprintAuthorizationComparisonValue(
      comparisonKey,
      'user-b',
    );
    const body = JSON.stringify([
      {
        operationName: 'Viewer',
        query: 'query Viewer { viewer { id } }',
        variables: {},
      },
      {
        operationName: 'User',
        query: 'query User($userId: ID!) { user(id: $userId) { id } }',
        variables: { userId: 'user-a' },
      },
    ]);
    const raw = [
      'POST /graphql HTTP/1.1',
      'Host: example.test',
      'Content-Type: application/json',
      `Content-Length: ${new TextEncoder().encode(body).byteLength}`,
      'Cookie: session=identity-a',
      '',
      body,
    ].join('\r\n');

    const compiled = await compileAuthorizationBaselineRequest({
      baselineId: 'baseline-left',
      rawRequestBase64: base64(raw),
      requestUrl: 'https://example.test/graphql',
      publicUrl: 'https://example.test/graphql',
      selector: {
        source: 'wire',
        location: 'body',
        path: 'body[1].variables.userId',
      },
      replacement: {
        version: 1,
        baselineId: 'baseline-right',
        source: 'wire',
        location: 'body',
        path: 'body[1].variables.userId',
        valueType: 'string',
        byteLength: 6,
        valueBase64: base64('user-b'),
        valueFingerprint,
      },
      comparisonKey,
      isHttps: true,
    });

    const compiledPacket = parseAuthorizationRequestPacket(compiled.rawRequestBase64);
    const compiledBody = JSON.parse(new TextDecoder().decode(
      compiledPacket.bytes.subarray(compiledPacket.bodyOffset),
    ));
    expect(compiledBody.map((operation: { operationName: string }) => operation.operationName))
      .toEqual(['Viewer', 'User']);
    expect(compiledBody[1].variables.userId).toBe('user-b');
  });

  it('applies an identity-bound query signature without changing captured credentials', async () => {
    const raw = base64([
      'GET /api/orders/84?nonce=old&signature=old HTTP/1.1',
      'Host: example.test',
      'Cookie: session=identity-a',
      'Authorization: Bearer identity-a',
      '',
      '',
    ].join('\r\n'));
    const packet = authorizationRequestToTransformPacket(raw, 'https://example.test');
    const compiled = await applyAuthorizationTransformExecution({
      compiled: {
        version: 1,
        baselineId: 'baseline-left',
        selector: { source: 'wire', location: 'path', path: 'path.segment[2]' },
        method: 'GET',
        url: 'https://example.test/api/orders/:resource',
        isHttps: true,
        rawRequestBase64: raw,
        resourceValueFingerprint: 'workspace-hmac-sha256:a'.padEnd(88, 'a'),
        packetFingerprint: `sha256:${'a'.repeat(64)}`,
      },
      execution: {
        profileId: 'profile-left',
        direction: 'request',
        url: 'https://example.test/api/orders/84?nonce=fresh&signature=signed-84',
        bodyBase64: packet.bodyBase64,
        setHeaders: [],
        removeHeaders: [],
        logicalInput: {},
        logicalOutput: {},
        nodeDurations: [],
        nodeTrace: [],
        fieldChanges: [],
        durationMs: 1,
      },
      origin: 'https://example.test',
      allowedDestinations: ['query.nonce', 'query.signature'],
    });

    const request = atob(compiled.rawRequestBase64);
    expect(request).toContain('GET /api/orders/84?nonce=fresh&signature=signed-84 HTTP/1.1');
    expect(request).toContain('Cookie: session=identity-a');
    expect(request).toContain('Authorization: Bearer identity-a');
  });

  it('rejects dynamic transforms that touch authentication headers', async () => {
    const raw = base64([
      'GET /api/orders/84?signature=old HTTP/1.1',
      'Host: example.test',
      'Cookie: session=identity-a',
      '',
      '',
    ].join('\r\n'));
    const packet = authorizationRequestToTransformPacket(raw, 'https://example.test');

    await expect(applyAuthorizationTransformExecution({
      compiled: {
        version: 1,
        baselineId: 'baseline-left',
        selector: { source: 'wire', location: 'path', path: 'path.segment[2]' },
        method: 'GET',
        url: 'https://example.test/api/orders/:resource',
        isHttps: true,
        rawRequestBase64: raw,
        resourceValueFingerprint: 'workspace-hmac-sha256:a'.padEnd(88, 'a'),
        packetFingerprint: `sha256:${'a'.repeat(64)}`,
      },
      execution: {
        profileId: 'profile-left',
        direction: 'request',
        url: packet.url,
        bodyBase64: packet.bodyBase64,
        setHeaders: [{ name: 'Cookie', value: 'session=identity-b' }],
        removeHeaders: [],
        logicalInput: {},
        logicalOutput: {},
        nodeDurations: [],
        nodeTrace: [],
        fieldChanges: [],
        durationMs: 1,
      },
      origin: 'https://example.test',
      allowedDestinations: ['header.cookie'],
    })).rejects.toThrow('认证材料');
  });
});
