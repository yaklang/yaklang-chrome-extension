import { ExtensionError } from '@/shared/errors';
import type { BrowserAuthorizationTaskSchema } from './engine';

type JSONObject = Record<string, unknown>;

function mismatch(schema: string, path: string, expected: string): never {
  throw new ExtensionError(
    'authorization_protocol_schema_mismatch',
    `授权测试协议 v1 / ${schema} 在 ${path} 不匹配：应为${expected}。请确认 Yak 与插件来自同一版本并重新建立工作区。`,
    { schema, path, protocolVersion: 1 },
  );
}

function objectValue(value: unknown, schema: string, path: string): JSONObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) mismatch(schema, path, '对象');
  return value as JSONObject;
}

function strictKeys(value: JSONObject, allowed: readonly string[], schema: string, path: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) mismatch(schema, `${path}.${key}`, '协议声明字段');
  }
}

function requiredString(value: JSONObject, key: string, schema: string, path: string): string {
  const result = value[key];
  if (typeof result !== 'string' || !result) mismatch(schema, `${path}.${key}`, '非空字符串');
  return result;
}

function requiredNumber(value: JSONObject, key: string, schema: string, path: string): number {
  const result = value[key];
  if (typeof result !== 'number' || !Number.isFinite(result)) mismatch(schema, `${path}.${key}`, '有限数字');
  return result;
}

function requiredBoolean(value: JSONObject, key: string, schema: string, path: string): boolean {
  const result = value[key];
  if (typeof result !== 'boolean') mismatch(schema, `${path}.${key}`, '布尔值');
  return result;
}

function collection(value: JSONObject, key: string, schema: string, path: string): unknown[] {
  const result = value[key];
  if (result === undefined || result === null) return [];
  if (!Array.isArray(result)) mismatch(schema, `${path}.${key}`, '数组或空值');
  return result;
}

function strings(value: JSONObject, key: string, schema: string, path: string): string[] {
  return collection(value, key, schema, path).map((item, index) => {
    if (typeof item !== 'string') mismatch(schema, `${path}.${key}[${index}]`, '字符串');
    return item;
  });
}

function objects(
  value: JSONObject,
  key: string,
  schema: string,
  path: string,
  normalize: (item: JSONObject, itemPath: string) => JSONObject,
): JSONObject[] {
  return collection(value, key, schema, path).map((item, index) => {
    const itemPath = `${path}.${key}[${index}]`;
    return normalize(objectValue(item, schema, itemPath), itemPath);
  });
}

function normalizeContext(value: JSONObject, schema: string, path: string): JSONObject {
  const target = objectValue(value.target, schema, `${path}.target`);
  requiredNumber(target, 'tabId', schema, `${path}.target`);
  requiredNumber(target, 'frameId', schema, `${path}.target`);
  requiredString(target, 'documentId', schema, `${path}.target`);
  const authentication = objectValue(value.authentication, schema, `${path}.authentication`);
  requiredString(authentication, 'status', schema, `${path}.authentication`);
  requiredNumber(authentication, 'cookieCount', schema, `${path}.authentication`);
  requiredNumber(authentication, 'storageEntryCount', schema, `${path}.authentication`);
  return {
    ...value,
    target,
    authentication: {
      ...authentication,
      authCookieNames: strings(authentication, 'authCookieNames', schema, `${path}.authentication`),
      authStorageKeys: strings(authentication, 'authStorageKeys', schema, `${path}.authentication`),
    },
  };
}

function normalizeBaseline(value: unknown, schema: string, path: string): JSONObject | undefined {
  if (value === undefined || value === null) return undefined;
  const baseline = objectValue(value, schema, path);
  const request = objectValue(baseline.request, schema, `${path}.request`);
  const logical = baseline.logicalRequest === undefined || baseline.logicalRequest === null
    ? undefined
    : objectValue(baseline.logicalRequest, schema, `${path}.logicalRequest`);
  return {
    ...baseline,
    request: {
      ...request,
      operationNames: strings(request, 'operationNames', schema, `${path}.request`),
      headerNames: strings(request, 'headerNames', schema, `${path}.request`),
      fields: collection(request, 'fields', schema, `${path}.request`),
    },
    logicalRequest: logical ? {
      ...logical,
      outputDestinations: strings(logical, 'outputDestinations', schema, `${path}.logicalRequest`),
    } : undefined,
  };
}

function normalizeWorkspace(value: unknown, schema: string): JSONObject {
  const workspace = objectValue(value, schema, '$');
  strictKeys(workspace, [
    'version', 'id', 'engineInstanceId', 'mode', 'state', 'left', 'right', 'proof', 'baselines',
    'baselinePair', 'plan', 'execution', 'createdAt', 'expiresAt', 'staleReason', 'recovery',
  ], schema, '$');
  if (requiredNumber(workspace, 'version', schema, '$') !== 1) mismatch(schema, '$.version', '版本 1');
  for (const key of ['id', 'engineInstanceId', 'mode', 'state']) requiredString(workspace, key, schema, '$');
  requiredNumber(workspace, 'createdAt', schema, '$');
  requiredNumber(workspace, 'expiresAt', schema, '$');
  const proof = objectValue(workspace.proof, schema, '$.proof');
  requiredString(proof, 'level', schema, '$.proof');
  const baselines = objectValue(workspace.baselines, schema, '$.baselines');
  const pair = objectValue(workspace.baselinePair, schema, '$.baselinePair');
  requiredString(pair, 'state', schema, '$.baselinePair');
  const resourceCandidates = objects(pair, 'resourceCandidates', schema, '$.baselinePair', (item, path) => {
    for (const key of ['id', 'source', 'location', 'path', 'category', 'confidence']) requiredString(item, key, schema, path);
    requiredBoolean(item, 'requiresLogicalBinding', schema, path);
    return { ...item, reasons: strings(item, 'reasons', schema, path) };
  });
  const operationCandidates = objects(pair, 'operationCandidates', schema, '$.baselinePair', (item, path) => {
    for (const key of ['id', 'method', 'path']) requiredString(item, key, schema, path);
    requiredBoolean(item, 'eligible', schema, path);
    requiredBoolean(item, 'sideEffect', schema, path);
    requiredBoolean(item, 'requiresDynamicRebuild', schema, path);
    return {
      ...item,
      authenticationPaths: strings(item, 'authenticationPaths', schema, path),
      dynamicPaths: strings(item, 'dynamicPaths', schema, path),
      reasons: strings(item, 'reasons', schema, path),
    };
  });
  let plan = workspace.plan;
  if (plan !== undefined && plan !== null) {
    const input = objectValue(plan, schema, '$.plan');
    plan = {
      ...input,
      canaryPaths: strings(input, 'canaryPaths', schema, '$.plan'),
      cases: collection(input, 'cases', schema, '$.plan'),
      reasons: strings(input, 'reasons', schema, '$.plan'),
    };
  }
  let execution = workspace.execution;
  if (execution !== undefined && execution !== null) {
    const input = objectValue(execution, schema, '$.execution');
    execution = {
      ...input,
      cases: collection(input, 'cases', schema, '$.execution'),
      evidence: collection(input, 'evidence', schema, '$.execution'),
      reasons: strings(input, 'reasons', schema, '$.execution'),
    };
  }
  return {
    ...workspace,
    left: normalizeContext(objectValue(workspace.left, schema, '$.left'), schema, '$.left'),
    right: normalizeContext(objectValue(workspace.right, schema, '$.right'), schema, '$.right'),
    proof: { ...proof, reasons: strings(proof, 'reasons', schema, '$.proof') },
    baselines: {
      ...baselines,
      left: normalizeBaseline(baselines.left, schema, '$.baselines.left'),
      right: normalizeBaseline(baselines.right, schema, '$.baselines.right'),
      verification: normalizeBaseline(baselines.verification, schema, '$.baselines.verification'),
    },
    baselinePair: {
      ...pair,
      reasons: strings(pair, 'reasons', schema, '$.baselinePair'),
      resourceCandidates,
      operationCandidates,
    },
    plan,
    execution,
  };
}

function normalizeEvidence(value: unknown, schema: string): JSONObject {
  const result = objectValue(value, schema, '$');
  strictKeys(result, [
    'version', 'workspaceId', 'executionId', 'mode', 'verdict', 'confidence', 'cases', 'comparisons',
    'semantic', 'representations', 'expiresAt', 'leftCaseId', 'rightCaseId', 'scope', 'view',
    'representation', 'equal', 'entries', 'omitted', 'caseId', 'side', 'packetBase64', 'capturedBytes',
    'truncated', 'direction', 'verified', 'evidence', 'rejectedPaths', 'verdictChanged', 'reason',
  ], schema, '$');
  if (requiredNumber(result, 'version', schema, '$') !== 1) mismatch(schema, '$.version', '版本 1');
  requiredString(result, 'workspaceId', schema, '$');
  requiredString(result, 'executionId', schema, '$');
  if (schema === 'authorization.evidence.inspect') return {
    ...result,
    cases: collection(result, 'cases', schema, '$'),
    comparisons: collection(result, 'comparisons', schema, '$'),
    semantic: collection(result, 'semantic', schema, '$'),
    representations: strings(result, 'representations', schema, '$'),
  };
  if (schema === 'authorization.evidence.diff') return {
    ...result,
    entries: collection(result, 'entries', schema, '$'),
  };
  if (schema === 'authorization.evidence.validate') return {
    ...result,
    evidence: collection(result, 'evidence', schema, '$'),
    rejectedPaths: strings(result, 'rejectedPaths', schema, '$'),
  };
  requiredString(result, 'packetBase64', schema, '$');
  return result;
}

export function normalizeBrowserAuthorizationTaskResult<T>(
  schema: BrowserAuthorizationTaskSchema,
  value: unknown,
): T {
  if (schema === 'authorization.baseline.candidates') {
    if (value === undefined || value === null) return [] as T;
    if (!Array.isArray(value)) mismatch(schema, '$', '数组或空值');
    return value.map((candidate, index) => {
      const item = objectValue(candidate, schema, `$[${index}]`);
      requiredString(item, 'id', schema, `$[${index}]`);
      return { ...item, reasons: strings(item, 'reasons', schema, `$[${index}]`) };
    }) as T;
  }
  if ([
    'authorization.workspace.create',
    'authorization.workspace.inspect',
    'authorization.baseline.bind',
    'authorization.logical.bind',
    'authorization.plan.create',
    'authorization.plan.execute',
  ].includes(schema)) return normalizeWorkspace(value, schema) as T;
  return normalizeEvidence(value, schema) as T;
}
