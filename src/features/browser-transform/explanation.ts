import type {
  BrowserPageCallable,
  BrowserTransformDirection,
  BrowserTransformDirectionName,
  BrowserTransformExplanation,
  BrowserTransformExplanationStage,
  BrowserTransformObservedOperation,
  BrowserTransformProfile,
  BrowserTransformProfileInput,
} from '@/types/models';

type ExplainableProfile = Pick<
  BrowserTransformProfileInput,
  'match' | 'origin' | 'request' | 'response'
> & Partial<Pick<BrowserTransformProfile, 'requestTransaction'>>;

function routeLabel(value: string, origin: string): string {
  try {
    const url = new URL(value, `${origin}/`);
    const keys = [...new Set(url.searchParams.keys())].sort();
    return `${url.pathname}${keys.length ? `?${keys.join('&')}` : ''}`;
  } catch {
    return value.split('#', 1)[0].slice(0, 512);
  }
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))].slice(0, 64);
}

function safeOperation(operation: BrowserTransformObservedOperation): BrowserTransformObservedOperation {
  const crypto = operation.crypto;
  return {
    operation: operation.operation.slice(0, 240),
    destination: operation.destination?.slice(0, 512),
    crypto: crypto ? {
      adapterId: crypto.adapterId.slice(0, 120),
      providerKind: crypto.providerKind,
      family: crypto.family,
      operation: crypto.operation.slice(0, 240),
      algorithm: crypto.algorithm?.slice(0, 240),
      mode: crypto.mode?.slice(0, 120),
      padding: crypto.padding?.slice(0, 120),
      inputEncoding: crypto.inputEncoding,
      outputEncoding: crypto.outputEncoding,
      state: crypto.state ? {
        model: crypto.state.model,
        phase: crypto.state.phase,
      } : undefined,
      key: crypto.key ? {
        kind: crypto.key.kind,
        bits: crypto.key.bits,
      } : undefined,
    } : undefined,
  };
}

function callableOperations(callable: BrowserPageCallable): BrowserTransformObservedOperation[] {
  const observed = callable.provenance.analysis?.operations || [];
  if (observed.length) return observed.slice(0, 16).map(safeOperation);
  return [safeOperation({
    operation: callable.algorithm || callable.operation,
    crypto: callable.crypto,
  })];
}

function referenceLabels(direction: BrowserTransformDirection, nodeIds: string[]): string[] {
  const byId = new Map(direction.nodes.map((node) => [node.id, node]));
  return unique(nodeIds.map((nodeId) => {
    const node = byId.get(nodeId);
    if (!node) return nodeId;
    if (node.kind === 'context.read') return node.path;
    if (node.kind === 'output.write') return node.destination;
    return node.name;
  }));
}

function explainDirection(
  profile: ExplainableProfile,
  directionName: BrowserTransformDirectionName,
  callables: Map<string, BrowserPageCallable>,
): BrowserTransformExplanation['directions'][number] | undefined {
  const direction = profile[directionName];
  if (!direction.enabled) return undefined;
  const stages: BrowserTransformExplanationStage[] = [];
  const inputs = direction.nodes.filter((node) => node.kind === 'context.read');
  if (inputs.length) stages.push({
    id: `${directionName}:input`,
    kind: 'input',
    owner: directionName === 'request' ? 'webfuzzer' : 'yak',
    proof: 'configured',
    title: directionName === 'request' ? '读取逻辑明文' : '读取线上响应',
    summary: `从 ${unique(inputs.map((node) => node.kind === 'context.read' ? node.path : undefined)).join('、')} 取得本次转换输入`,
    nodeIds: inputs.map((node) => node.id),
    inputPaths: unique(inputs.map((node) => node.kind === 'context.read' ? node.path : undefined)),
    outputPaths: unique(inputs.map((node) => node.name)),
    operations: [],
    evidence: [],
  });

  const transaction = directionName === 'request' ? profile.requestTransaction?.transaction : undefined;
  for (const [index, prerequisite] of (transaction?.prerequisites || []).entries()) {
    stages.push({
      id: `${directionName}:prerequisite:${index}`,
      kind: 'prerequisite',
      owner: 'page',
      proof: 'observed',
      title: `刷新页面动态参数 ${index + 1}`,
      summary: '仅执行录制证据确认的在线前置请求，响应继续留在当前浏览器会话中',
      nodeIds: [],
      inputPaths: [],
      outputPaths: prerequisite.response.requiredPaths.slice(0, 32),
      operations: [],
      evidence: [{ strength: 'proven', label: '响应字段与页面计算参数的值链已经精确关联' }],
      network: {
        method: prerequisite.method,
        route: routeLabel(prerequisite.url, profile.origin),
        statusCode: prerequisite.response.statusCode,
        requiredPaths: prerequisite.response.requiredPaths.slice(0, 32),
      },
    });
  }

  for (const node of direction.nodes) {
    if (node.kind === 'context.read') continue;
    if (node.kind === 'page.call') {
      const callable = callables.get(node.callableId);
      const analysis = callable?.provenance.analysis;
      stages.push({
        id: `${directionName}:node:${node.id}`,
        kind: 'page-call',
        owner: 'page',
        proof: analysis || callable?.provenance.recordingId || callable?.provenance.traceId ? 'observed' : 'configured',
        title: callable?.name || node.name,
        summary: callable?.kind === 'request-transaction'
          ? '在当前页面文档中复现原业务封装，保留 Key、IV、闭包值与字段动态关系'
          : '使用页面保留的真实函数、receiver 和固定参数执行转换',
        nodeIds: [node.id],
        inputPaths: referenceLabels(direction, node.arguments.map((reference) => reference.nodeId)),
        outputPaths: callable?.output.paths.length ? callable.output.paths.slice(0, 64) : [node.name],
        operations: callable ? callableOperations(callable) : [],
        evidence: (analysis?.evidence || []).slice(0, 12).map((item) => ({
          strength: item.strength,
          label: item.label,
        })),
        source: callable ? {
          functionName: callable.provenance.functionName,
          url: callable.provenance.sourceUrl
            ? routeLabel(callable.provenance.sourceUrl, profile.origin)
            : undefined,
          lineNumber: callable.provenance.lineNumber,
        } : undefined,
      });
      continue;
    }
    if (node.kind === 'builtin') {
      stages.push({
        id: `${directionName}:node:${node.id}`,
        kind: 'builtin',
        owner: 'extension',
        proof: 'configured',
        title: node.name,
        summary: `执行受限内置操作 ${node.operation}`,
        nodeIds: [node.id],
        inputPaths: referenceLabels(direction, node.inputs.map((reference) => reference.nodeId)),
        outputPaths: [node.name],
        operations: [{ operation: node.operation }],
        evidence: [],
      });
      continue;
    }
    stages.push({
      id: `${directionName}:node:${node.id}`,
      kind: 'output',
      owner: 'extension',
      proof: 'configured',
      title: node.name,
      summary: `将上一阶段结果以 ${node.encoding} 编码写入 ${node.destination}`,
      nodeIds: [node.id],
      inputPaths: referenceLabels(direction, [node.source.nodeId]),
      outputPaths: [node.destination],
      operations: [{ operation: `output.${node.encoding}`, destination: node.destination }],
      evidence: [],
    });
  }

  if (transaction?.prerequisites.length) stages.push({
    id: `${directionName}:session`,
    kind: 'session',
    owner: 'extension',
    proof: 'configured',
    title: '绑定浏览器会话',
    summary: '只把终止 URL 适用的当前 Cookie Store 会话临时交给 Yak，不写入 Profile',
    nodeIds: [], inputPaths: [], outputPaths: ['header.Cookie'], operations: [], evidence: [],
  });

  stages.push({
    id: `${directionName}:transport`,
    kind: 'transport',
    owner: directionName === 'request' ? 'yak' : 'webfuzzer',
    proof: 'configured',
    title: directionName === 'request' ? 'Yak 发送唯一线上请求' : '返回可编辑的明文响应',
    summary: directionName === 'request'
      ? '页面终止请求只被捕获，不在浏览器中发送；Yak 应用转换结果后发送一次'
      : '解码结果作为 Web Fuzzer 中的逻辑响应，原始线上响应仍可审计',
    nodeIds: [],
    inputPaths: unique(stages.flatMap((stage) => (
      stage.kind === 'output' || stage.kind === 'session' ? stage.outputPaths : []
    ))),
    outputPaths: [], operations: [], evidence: [],
    network: directionName === 'request' && transaction ? {
      method: transaction.request.method,
      route: routeLabel(transaction.request.url, profile.origin),
      requiredPaths: transaction.request.expectedDestinations.slice(0, 64),
    } : undefined,
  });

  return {
    direction: directionName,
    summary: directionName === 'request'
      ? `明文请求经过 ${stages.length} 个语义阶段生成线上请求`
      : `线上响应经过 ${stages.length} 个语义阶段还原为明文`,
    stages,
  };
}

export function createBrowserTransformExplanation(
  profile: ExplainableProfile,
  callables: BrowserPageCallable[],
  previous?: BrowserTransformExplanation,
): BrowserTransformExplanation {
  const byId = new Map(callables.map((callable) => [callable.id, callable]));
  const directions = (['request', 'response'] as const).flatMap((direction) => {
    const explained = explainDirection(profile, direction, byId);
    if (!explained) return [];
    const previousDirection = previous?.directions.find((item) => item.direction === direction);
    if (!previousDirection) return [explained];
    const previousCalls = previousDirection.stages.filter((stage) => stage.kind === 'page-call');
    return [{
      ...explained,
      stages: explained.stages.map((stage) => {
        if (stage.kind !== 'page-call' || stage.operations.length) return stage;
        const fallback = previousCalls.find((item) => item.outputPaths.some((path) => stage.outputPaths.includes(path)))
          || (previousCalls.length === 1 ? previousCalls[0] : undefined);
        return fallback ? { ...stage, operations: fallback.operations, evidence: fallback.evidence } : stage;
      }),
    }];
  });
  return { version: 1, directions };
}
