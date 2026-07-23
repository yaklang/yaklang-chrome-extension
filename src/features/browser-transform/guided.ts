import type {
  BrowserPageCallable,
  BrowserTransformDirection,
  BrowserTransformPipelineNode,
} from '@/types/models';

export type GuidedTransformOutputKind = 'body' | 'json-field' | 'form-field' | 'header' | 'query';

export interface GuidedTransformDraft {
  callableId: string;
  inputPaths: string[];
  resultPath?: string;
  outputKind: GuidedTransformOutputKind;
  outputField: string;
  setFormContentType: boolean;
}

export interface GuidedTransformSuggestion {
  outputKind?: GuidedTransformOutputKind;
  outputField?: string;
}

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function activeInputCount(callable?: BrowserPageCallable): number {
  if (!callable) return 1;
  return Math.max(0, callable.inputSlots.filter((slot) => !slot.retained).length);
}

function defaultInputPaths(callable?: BrowserPageCallable): string[] {
  if (!callable) return ['body'];
  const slots = callable.inputSlots.filter((slot) => !slot.retained);
  if (slots.length <= 1) return slots.map(() => 'body');
  return slots.map((slot) => (
    callable.kind === 'business-closure'
      && /^[A-Za-z_$][\w$]*$/.test(slot.name)
      && !/^arg\d+$/.test(slot.name)
      ? `body.${slot.name}`
      : 'body'
  ));
}

export function defaultGuidedTransform(
  callable?: BrowserPageCallable,
  suggestion: GuidedTransformSuggestion = {},
): GuidedTransformDraft {
  return {
    callableId: callable?.id || '',
    inputPaths: defaultInputPaths(callable),
    outputKind: suggestion.outputKind || 'body',
    outputField: suggestion.outputField || '',
    setFormContentType: suggestion.outputKind === 'form-field',
  };
}

export function compileGuidedTransform(guide: GuidedTransformDraft, callable?: BrowserPageCallable): BrowserTransformDirection {
  const expectedInputs = activeInputCount(callable);
  const paths = guide.inputPaths.slice(0, expectedInputs);
  while (paths.length < expectedInputs) paths.push('body');

  const inputNodes = paths.map((path, index): BrowserTransformPipelineNode => ({
    id: uid('input'),
    name: expectedInputs > 1 ? `读取参数 ${index + 1}` : '读取明文输入',
    kind: 'context.read',
    path: path.trim() || 'body',
  }));
  const callId = uid('call');
  const callNode: BrowserTransformPipelineNode = {
    id: callId,
    name: callable?.name || '调用页面函数',
    kind: 'page.call',
    callableId: guide.callableId,
    arguments: inputNodes.map((node) => ({ nodeId: node.id })),
  };
  const callReference = { nodeId: callId, path: guide.resultPath?.trim() || undefined };
  const nodes: BrowserTransformPipelineNode[] = [...inputNodes, callNode];

  if (guide.outputKind === 'form-field') {
    const formId = uid('form');
    const field = guide.outputField.trim();
    nodes.push({
      id: formId,
      name: `组成表单字段 ${field || 'value'}`,
      kind: 'builtin',
      operation: 'form.compose',
      inputs: [callReference],
      options: { keys: [field] },
    });
    if (guide.setFormContentType) {
      const contentTypeId = uid('literal');
      nodes.push({
        id: contentTypeId,
        name: '表单 Content-Type',
        kind: 'builtin',
        operation: 'value.literal',
        inputs: [],
        options: { value: 'application/x-www-form-urlencoded' },
      });
      nodes.push({
        id: uid('header'),
        name: '设置表单 Content-Type',
        kind: 'output.write',
        destination: 'header.Content-Type',
        source: { nodeId: contentTypeId },
        encoding: 'text',
      });
    }
    nodes.push({
      id: uid('output'),
      name: '写入线上表单',
      kind: 'output.write',
      destination: 'body',
      source: { nodeId: formId },
      encoding: 'text',
    });
    return { enabled: true, nodes };
  }

  const field = guide.outputField.trim();
  const destination = guide.outputKind === 'body' ? 'body'
    : guide.outputKind === 'json-field' ? `body.${field}`
      : guide.outputKind === 'header' ? `header.${field}`
        : `query.${field}`;
  nodes.push({
    id: uid('output'),
    name: guide.outputKind === 'body' ? '替换线上 Body' : `写入 ${field || '输出字段'}`,
    kind: 'output.write',
    destination,
    source: callReference,
    encoding: guide.outputKind === 'body' ? 'auto' : 'text',
  });
  return { enabled: true, nodes };
}

function referenceFromCall(
  nodeId: string,
  path: string | undefined,
  callId: string,
): string | undefined {
  return nodeId === callId ? path : undefined;
}

export function parseGuidedTransform(
  direction: BrowserTransformDirection,
  callables: BrowserPageCallable[],
): GuidedTransformDraft | undefined {
  const calls = direction.nodes.filter((node): node is Extract<BrowserTransformPipelineNode, { kind: 'page.call' }> => node.kind === 'page.call');
  if (calls.length !== 1) return undefined;
  const call = calls[0];
  const callable = callables.find((item) => item.id === call.callableId);
  const byId = new Map(direction.nodes.map((node) => [node.id, node]));
  const inputPaths: string[] = [];
  for (const reference of call.arguments) {
    const source = byId.get(reference.nodeId);
    if (!source || source.kind !== 'context.read' || reference.path) return undefined;
    inputPaths.push(source.path);
  }

  const outputs = direction.nodes.filter((node): node is Extract<BrowserTransformPipelineNode, { kind: 'output.write' }> => node.kind === 'output.write');
  const form = direction.nodes.find((node): node is Extract<BrowserTransformPipelineNode, { kind: 'builtin' }> => (
    node.kind === 'builtin' && node.operation === 'form.compose'
  ));
  if (form) {
    const bodyOutput = outputs.find((node) => node.destination === 'body' && node.source.nodeId === form.id);
    const keys = form.options?.keys;
    if (!bodyOutput || form.inputs.length !== 1 || form.inputs[0].nodeId !== call.id
      || !Array.isArray(keys) || keys.length !== 1 || typeof keys[0] !== 'string') return undefined;
    const contentTypeOutput = outputs.find((node) => node.destination.toLowerCase() === 'header.content-type');
    if (outputs.some((node) => node !== bodyOutput && node !== contentTypeOutput)) return undefined;
    return {
      callableId: call.callableId,
      inputPaths,
      resultPath: form.inputs[0].path,
      outputKind: 'form-field',
      outputField: keys[0],
      setFormContentType: Boolean(contentTypeOutput),
    };
  }

  if (outputs.length !== 1) return undefined;
  const output = outputs[0];
  const resultPath = referenceFromCall(output.source.nodeId, output.source.path, call.id);
  if (output.source.nodeId !== call.id) return undefined;
  if (output.destination === 'body') {
    return { callableId: call.callableId, inputPaths, resultPath, outputKind: 'body', outputField: '', setFormContentType: false };
  }
  if (output.destination.startsWith('body.')) {
    return { callableId: call.callableId, inputPaths, resultPath, outputKind: 'json-field', outputField: output.destination.slice(5), setFormContentType: false };
  }
  if (output.destination.toLowerCase().startsWith('header.')) {
    return { callableId: call.callableId, inputPaths, resultPath, outputKind: 'header', outputField: output.destination.slice(7), setFormContentType: false };
  }
  if (output.destination.startsWith('query.')) {
    return { callableId: call.callableId, inputPaths, resultPath, outputKind: 'query', outputField: output.destination.slice(6), setFormContentType: false };
  }
  return undefined;
}

export function guidedOutputDescription(guide: GuidedTransformDraft): string {
  const field = guide.outputField.trim() || '待填写字段';
  if (guide.outputKind === 'body') return '替换整个线上 Body';
  if (guide.outputKind === 'json-field') return `写入 JSON 字段 ${field}`;
  if (guide.outputKind === 'form-field') return `组成表单字段 ${field}`;
  if (guide.outputKind === 'header') return `写入 Header ${field}`;
  return `写入 Query ${field}`;
}
