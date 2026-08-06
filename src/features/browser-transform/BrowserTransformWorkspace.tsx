import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ArrowDown, ArrowRight, Braces, CheckCircle2, CirclePlus, Code2, FileInput,
  FlaskConical, Link2, Plus, RotateCcw, Save, Settings2, Sparkles, Trash2, Workflow,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { errorMessage, request } from '@/platform/messaging/runtime';
import type {
  ActiveTabInfo, BrowserPageCallable, BrowserRecordingEvent, BrowserTransformBuiltinOperation,
  BrowserTransformDirection,
  BrowserTransformNodeReference, BrowserTransformPipelineNode, BrowserTransformProfile,
  BrowserTransformProfileInput, BrowserProfileInferenceCandidate,
} from '@/types/models';
import {
  callableEnvelopeDescription, compileGuidedTransform, defaultGuidedTransform, guidedOutputDescription, parseGuidedTransform,
  type GuidedTransformDraft, type GuidedTransformOutputKind,
} from './guided';
import { createBrowserTransformProfileInput } from './profile-draft';
import {
  clearBrowserTransformReplayDraft,
  deleteBrowserTransformReplayDrafts,
  getBrowserTransformReplayDraft,
  saveBrowserTransformReplayDraft,
  type BrowserTransformReplayDraftFields,
  type BrowserTransformReplayDraftInput,
} from './replay-draft';
import {
  DEFAULT_TRANSFORM_REPLAY_BODY,
  INITIAL_TRANSFORM_WORKSPACE_STATE,
  transformWorkspaceReducer,
  type ReplayPersistenceState,
  type TransformWorkspaceState,
} from './workspace-reducer';
import { TransformReplayPanel } from './TransformReplayPanel';
import { TransformProfileRail } from './TransformProfileRail';
import { TransformDataFlowView } from './TransformDataFlowView';
import './browser-transform-workspace.css';

type RunTask = (task: () => Promise<void>, success?: string) => Promise<void>;

interface BrowserTransformWorkspaceProps {
  tab?: ActiveTabInfo;
  selectedEvent?: BrowserRecordingEvent;
  busy: boolean;
  run: RunTask;
  gatewayShared: boolean;
  gatewayShareExpiresAt?: number;
  gatewayBridgeConnected: boolean;
  onShareGateway: () => Promise<void>;
  onOpenCapture: () => void;
  onOpenRecovery: (profileId: string) => void;
  deepCaptureAvailable?: boolean;
  recoveryRevision?: number;
  suggestion?: BrowserTransformSuggestionSeed;
}

export interface BrowserTransformSuggestionSeed {
  revision: number;
  candidate: BrowserProfileInferenceCandidate;
  callable: BrowserPageCallable;
  profile: BrowserTransformProfile;
  sampleBody?: string;
  sampleLabel?: string;
}

const BUILTINS: Array<{ value: BrowserTransformBuiltinOperation; label: string }> = [
  { value: 'value.literal', label: '固定值' },
  { value: 'json.stringify', label: 'JSON 序列化' },
  { value: 'json.parse', label: 'JSON 解析' },
  { value: 'text.toString', label: '转为文本' },
  { value: 'url.encode', label: 'URL 编码' },
  { value: 'url.decode', label: 'URL 解码' },
  { value: 'base64.encode', label: 'Base64 编码' },
  { value: 'base64.decode', label: 'Base64 解码' },
  { value: 'hex.encode', label: 'Hex 编码' },
  { value: 'hex.decode', label: 'Hex 解码' },
  { value: 'object.pick', label: '选择对象字段' },
  { value: 'object.compose', label: '组合对象' },
  { value: 'form.compose', label: '组合表单' },
  { value: 'form.serialize', label: '序列化完整表单' },
];

function originOf(url?: string): string {
  try { return url ? new URL(url).origin : ''; } catch { return ''; }
}

function absoluteUrl(value?: string, base?: string): string {
  try { return value ? new URL(value, base).toString() : base || ''; } catch { return value || base || ''; }
}

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}


type GuidedInputKind = 'body' | 'body-field' | 'text' | 'header-field' | 'query-field' | 'custom';

function splitInputPath(path: string): { kind: GuidedInputKind; field: string } {
  if (path === 'body') return { kind: 'body', field: '' };
  if (path === 'text') return { kind: 'text', field: '' };
  if (path.startsWith('body.')) return { kind: 'body-field', field: path.slice(5) };
  if (path.startsWith('headers.')) return { kind: 'header-field', field: path.slice(8) };
  if (path.startsWith('query.')) return { kind: 'query-field', field: path.slice(6) };
  return { kind: 'custom', field: path };
}

function joinInputPath(kind: GuidedInputKind, field: string): string {
  if (kind === 'body') return 'body';
  if (kind === 'text') return 'text';
  if (kind === 'body-field') return `body.${field.trim()}`;
  if (kind === 'header-field') return `headers.${field.trim().toLowerCase()}`;
  if (kind === 'query-field') return `query.${field.trim()}`;
  return field.trim();
}

function outputFieldLabel(kind: GuidedTransformOutputKind): string {
  if (kind === 'json-field') return 'JSON 字段名';
  if (kind === 'form-field') return '表单字段名';
  if (kind === 'header') return 'Header 名称';
  if (kind === 'query') return 'Query 参数名';
  return '';
}

const INPUT_ROLE_LABELS: Record<BrowserPageCallable['inputSlots'][number]['role'], string> = {
  data: '明文数据',
  key: '密钥',
  iv: 'IV',
  algorithm: '算法',
  options: '选项',
  signature: '签名',
  salt: 'Salt',
  nonce: 'Nonce',
  aad: '附加数据',
  unknown: '页面参数',
};

function toInput(profile: BrowserTransformProfile): BrowserTransformProfileInput {
  return {
    id: profile.id,
    name: profile.name,
    enabled: profile.enabled,
    target: { ...profile.target },
    origin: profile.origin,
    match: { methods: [...profile.match.methods], urlPattern: profile.match.urlPattern },
    request: structuredClone(profile.request),
    response: structuredClone(profile.response),
    failMode: 'closed',
    maxConcurrency: profile.maxConcurrency,
  };
}

function profileFingerprint(profile?: BrowserTransformProfileInput): string {
  return profile ? JSON.stringify(profile) : '';
}

function encodeUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function formatSampleBody(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed, null, 2) : value;
  } catch {
    return value;
  }
}

function sampleHeaders(value: string): string {
  try {
    JSON.parse(value);
    return '{"Content-Type":"application/json"}';
  } catch {
    return '{"Content-Type":"text/plain; charset=utf-8"}';
  }
}

const DEFAULT_REPLAY_BODY = DEFAULT_TRANSFORM_REPLAY_BODY;

type StateSetter<T> = (value: T | ((current: T) => T)) => void;

function nextStateValue<T>(current: T, value: T | ((current: T) => T)): T {
  return typeof value === 'function'
    ? (value as (current: T) => T)(current)
    : value;
}

interface PendingReplaySave {
  key: string;
  fingerprint: string;
  input: BrowserTransformReplayDraftInput;
  revision: number;
  timeout: ReturnType<typeof setTimeout>;
}

function defaultReplayFields(tab?: ActiveTabInfo, selectedEvent?: BrowserRecordingEvent): BrowserTransformReplayDraftFields {
  return {
    method: selectedEvent?.method || 'POST',
    url: absoluteUrl(selectedEvent?.url, tab?.url),
    headers: '{"Content-Type":"application/json"}',
    body: DEFAULT_REPLAY_BODY,
  };
}

function replayFieldsFingerprint(fields: BrowserTransformReplayDraftFields): string {
  return JSON.stringify(fields);
}

function replayPersistenceLabel(state: ReplayPersistenceState): string {
  if (state === 'memory') return '保存网关后自动保存';
  if (state === 'loading') return '正在恢复';
  if (state === 'ready') return '本机自动保存';
  if (state === 'saving') return '正在保存';
  if (state === 'saved') return '本机已保存';
  if (state === 'too-large') return '样本过大';
  return '保存失败';
}

function nodeLabel(kind: BrowserTransformPipelineNode['kind']): string {
  if (kind === 'context.read') return '上下文';
  if (kind === 'builtin') return '内置转换';
  if (kind === 'page.call') return '页面函数';
  return '输出';
}

function callableKindLabel(callable: BrowserPageCallable): string {
  if (callable.kind === 'recorded-call') return '录制调用';
  if (callable.kind === 'business-closure') return '业务闭包';
  if (callable.kind === 'request-transaction') return '请求事务';
  return '全局函数';
}

function referencesOf(node: BrowserTransformPipelineNode): BrowserTransformNodeReference[] {
  if (node.kind === 'builtin') return node.inputs;
  if (node.kind === 'page.call') return node.arguments;
  if (node.kind === 'output.write') return [node.source];
  return [];
}

export function BrowserTransformWorkspace({
  tab,
  selectedEvent,
  busy,
  run,
  gatewayShared,
  gatewayShareExpiresAt,
  gatewayBridgeConnected,
  onShareGateway,
  onOpenCapture,
  onOpenRecovery,
  deepCaptureAvailable = true,
  recoveryRevision = 0,
  suggestion,
}: BrowserTransformWorkspaceProps) {
  const [ui, dispatch] = useReducer(
    transformWorkspaceReducer,
    INITIAL_TRANSFORM_WORKSPACE_STATE,
  );
  const [workspaceView, setWorkspaceView] = useState<'flow' | 'configure'>('flow');
  const {
    profiles, callables, selectedProfileId, draft, directionName, loadError,
    testMethod, testUrl, testHeaders, testBody, testSample, testResult, testError,
    replayPersistence, replayStorageError, replayLoadedKey, editorMode,
    confirmDeleteCallableId,
  } = ui;
  const setter = <K extends keyof TransformWorkspaceState>(field: K): StateSetter<TransformWorkspaceState[K]> => (
    (value) => dispatch({
      type: 'update',
      update: (current) => ({
        ...current,
        [field]: nextStateValue(current[field], value),
      }),
    })
  );
  const setProfiles = setter('profiles');
  const setCallables = setter('callables');
  const setSelectedProfileId = setter('selectedProfileId');
  const setDraft = setter('draft');
  const setDirectionName = setter('directionName');
  const setLoadError = setter('loadError');
  const setTestResult = setter('testResult');
  const setTestError = setter('testError');
  const setReplayPersistence = setter('replayPersistence');
  const setReplayStorageError = setter('replayStorageError');
  const setReplayLoadedKey = setter('replayLoadedKey');
  const setEditorMode = setter('editorMode');
  const setConfirmDeleteCallableId = setter('confirmDeleteCallableId');
  const handledSuggestion = useRef(0);
  const replayLoadRevision = useRef(0);
  const replaySaveRevision = useRef(0);
  const replayBaselineFingerprint = useRef('');
  const replayStablePersistence = useRef<ReplayPersistenceState>('memory');
  const pendingReplaySeed = useRef<{ key: string; fields: BrowserTransformReplayDraftFields } | undefined>(undefined);
  const pendingReplaySave = useRef<PendingReplaySave | undefined>(undefined);

  const replayProfileId = draft?.id || '';
  const replayOrigin = draft?.origin || '';
  const replayKey = replayProfileId ? `${replayProfileId}:${directionName}` : '';
  const replayActiveKey = useRef(replayKey);
  replayActiveKey.current = replayKey;
  const workspaceMounted = useRef(false);
  const replayFields = useMemo<BrowserTransformReplayDraftFields>(() => ({
    method: testMethod,
    url: testUrl,
    headers: testHeaders,
    body: testBody,
    sample: testSample,
  }), [testBody, testHeaders, testMethod, testSample, testUrl]);
  const replayFingerprint = useMemo(() => replayFieldsFingerprint(replayFields), [replayFields]);

  const applyReplayFields = useCallback((fields: BrowserTransformReplayDraftFields) => {
    dispatch({ type: 'replay.apply', fields });
  }, []);

  const discardPendingReplaySave = useCallback(() => {
    replaySaveRevision.current += 1;
    if (pendingReplaySave.current) clearTimeout(pendingReplaySave.current.timeout);
    pendingReplaySave.current = undefined;
  }, []);

  const flushPendingReplaySave = useCallback(() => {
    const pending = pendingReplaySave.current;
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingReplaySave.current = undefined;
    replaySaveRevision.current += 1;
    void saveBrowserTransformReplayDraft(pending.input).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    try {
      const target = tab ? { tabId: tab.id, frameId: 0 } : undefined;
      const [nextProfiles, nextCallables] = await Promise.all([
        request('transform.profile.list', target || {}),
        target ? request('callable.list', target).catch(() => []) : Promise.resolve([]),
      ]);
      dispatch({
        type: 'update',
        update: (current) => ({
          ...current,
          profiles: nextProfiles,
          callables: nextCallables,
          loadError: '',
          selectedProfileId: nextProfiles.some((profile) => profile.id === current.selectedProfileId)
            ? current.selectedProfileId
            : nextProfiles[0]?.id || '',
        }),
      });
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [tab]);

  useEffect(() => {
    workspaceMounted.current = true;
    return () => { workspaceMounted.current = false; };
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (recoveryRevision > 0) void load();
  }, [load, recoveryRevision]);
  useEffect(() => {
    const selected = profiles.find((profile) => profile.id === selectedProfileId);
    if (selected) {
      const selectedDirection = selected.request.enabled ? selected.request : selected.response;
      dispatch({
        type: 'patch',
        value: {
          draft: toInput(selected),
          editorMode: parseGuidedTransform(selectedDirection, callables) ? 'guided' : 'advanced',
        },
      });
    }
  }, [callables, profiles, selectedProfileId]);
  useEffect(() => {
    const revision = ++replayLoadRevision.current;
    discardPendingReplaySave();
    setReplayLoadedKey('');
    setReplayStorageError('');
    const fallback = defaultReplayFields(tab, selectedEvent);
    if (!replayProfileId) {
      replayBaselineFingerprint.current = replayFieldsFingerprint(fallback);
      replayStablePersistence.current = 'memory';
      applyReplayFields(fallback);
      setReplayPersistence('memory');
      return;
    }
    const seed = pendingReplaySeed.current?.key === replayKey ? pendingReplaySeed.current.fields : undefined;
    if (seed) {
      pendingReplaySeed.current = undefined;
      replayBaselineFingerprint.current = '';
      replayStablePersistence.current = 'ready';
      applyReplayFields(seed);
      setReplayPersistence('ready');
      setReplayLoadedKey(replayKey);
      return;
    }
    replayBaselineFingerprint.current = replayFieldsFingerprint(fallback);
    replayStablePersistence.current = 'ready';
    applyReplayFields(fallback);
    setReplayPersistence('loading');
    void getBrowserTransformReplayDraft(replayProfileId, directionName, replayOrigin)
      .then((stored) => {
        if (!workspaceMounted.current || replayLoadRevision.current !== revision) return;
        const fields = stored ? {
          method: stored.method,
          url: stored.url,
          headers: stored.headers,
          body: stored.body,
          sample: stored.sample,
        } : fallback;
        replayBaselineFingerprint.current = replayFieldsFingerprint(fields);
        replayStablePersistence.current = stored ? 'saved' : 'ready';
        applyReplayFields(fields);
        setReplayPersistence(stored ? 'saved' : 'ready');
        setReplayLoadedKey(replayKey);
      })
      .catch((error) => {
        if (!workspaceMounted.current || replayLoadRevision.current !== revision) return;
        replayBaselineFingerprint.current = replayFieldsFingerprint(fallback);
        replayStablePersistence.current = 'error';
        setReplayStorageError(`无法恢复本机回放草稿：${errorMessage(error)}`);
        setReplayPersistence('error');
        setReplayLoadedKey(replayKey);
      });
    return () => { replayLoadRevision.current += 1; };
    // Replay defaults are captured only when the profile/direction changes.
    // Navigation and new recording selections must not overwrite an edited draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayKey]);
  useEffect(() => () => flushPendingReplaySave(), [flushPendingReplaySave, replayKey]);
  useEffect(() => {
    if (!replayProfileId || replayLoadedKey !== replayKey) return;
    if (replayFingerprint === replayBaselineFingerprint.current) {
      pendingReplaySave.current = undefined;
      setReplayPersistence(replayStablePersistence.current);
      return;
    }
    const revision = ++replaySaveRevision.current;
    setReplayPersistence('saving');
    setReplayStorageError('');
    const input: BrowserTransformReplayDraftInput = {
      ...structuredClone(replayFields),
      profileId: replayProfileId,
      direction: directionName,
      origin: replayOrigin,
    };
    const pending: PendingReplaySave = {
      key: replayKey,
      fingerprint: replayFingerprint,
      input,
      revision,
      timeout: setTimeout(() => {
        if (pendingReplaySave.current === pending) pendingReplaySave.current = undefined;
        void saveBrowserTransformReplayDraft(input)
          .then((result) => {
            if (!workspaceMounted.current || replayActiveKey.current !== pending.key || replaySaveRevision.current !== revision) return;
            replayBaselineFingerprint.current = pending.fingerprint;
            replayStablePersistence.current = result.status === 'saved' ? 'saved' : 'too-large';
            setReplayPersistence(replayStablePersistence.current);
          })
          .catch((error) => {
            if (!workspaceMounted.current || replayActiveKey.current !== pending.key || replaySaveRevision.current !== revision) return;
            setReplayStorageError(`无法保存本机回放草稿：${errorMessage(error)}`);
            setReplayPersistence('error');
          });
      }, 350),
    };
    pendingReplaySave.current = pending;
    return () => clearTimeout(pending.timeout);
  }, [directionName, replayFields, replayFingerprint, replayKey, replayLoadedKey, replayOrigin, replayProfileId]);
  useEffect(() => {
    if (!suggestion || !tab || handledSuggestion.current >= suggestion.revision) return;
    handledSuggestion.current = suggestion.revision;
    replayLoadRevision.current += 1;
    discardPendingReplaySave();
    const sampleBody = suggestion.sampleBody ? formatSampleBody(suggestion.sampleBody) : undefined;
    const fields: BrowserTransformReplayDraftFields = {
      ...defaultReplayFields(tab, selectedEvent),
      method: suggestion.candidate.request.method || 'POST',
      url: absoluteUrl(suggestion.candidate.request.url, tab.url),
      headers: suggestion.sampleBody ? sampleHeaders(suggestion.sampleBody) : '{"Content-Type":"application/json"}',
      body: sampleBody || DEFAULT_REPLAY_BODY,
      sample: sampleBody ? { body: sampleBody, label: suggestion.sampleLabel || '录制短时样本' } : undefined,
    };
    const suggestedDirection = suggestion.candidate.direction;
    const seedKey = `${suggestion.profile.id}:${suggestedDirection}`;
    pendingReplaySeed.current = { key: seedKey, fields };
    replayBaselineFingerprint.current = '';
    replayStablePersistence.current = 'ready';
    applyReplayFields(fields);
    setReplayLoadedKey(seedKey);
    setReplayPersistence('ready');
    setReplayStorageError('');
    setWorkspaceView('flow');
    dispatch({
      type: 'update',
      update: (current) => ({
        ...current,
        callables: [
          ...current.callables.filter((item) => item.id !== suggestion.callable.id),
          suggestion.callable,
        ],
        profiles: [
          suggestion.profile,
          ...current.profiles.filter((item) => item.id !== suggestion.profile.id),
        ],
        selectedProfileId: suggestion.profile.id,
        draft: toInput(suggestion.profile),
        directionName: suggestedDirection,
        editorMode: 'guided',
        testResult: undefined,
        testError: '',
      }),
    });
  }, [applyReplayFields, discardPendingReplaySave, selectedEvent, suggestion, tab]);

  const savedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const activeRecovery = savedProfile?.recovery;
  const recoveryPending = Boolean(activeRecovery && activeRecovery.state !== 'ready');
  const dirty = Boolean(draft && profileFingerprint(draft) !== profileFingerprint(savedProfile ? toInput(savedProfile) : undefined));
  const callableIds = useMemo(() => new Set(callables.map((callable) => callable.id)), [callables]);
  const referencedCallableIds = useMemo(() => draft ? [draft.request, draft.response]
    .flatMap((direction) => direction.enabled ? direction.nodes : [])
    .filter((node): node is Extract<BrowserTransformPipelineNode, { kind: 'page.call' }> => node.kind === 'page.call')
    .map((node) => node.callableId) : [], [draft]);
  const bindingReady = Boolean(
    draft
    && !recoveryPending
    && originOf(tab?.url) === draft.origin
    && referencedCallableIds.every((id) => callableIds.has(id)),
  );
  const callableReferences = useMemo(() => {
    const references = new Map<string, number>();
    for (const profile of profiles) {
      for (const node of [profile.request, profile.response].flatMap((item) => item.enabled ? item.nodes : [])) {
        if (node.kind !== 'page.call') continue;
        references.set(node.callableId, (references.get(node.callableId) || 0) + 1);
      }
    }
    return references;
  }, [profiles]);
  const direction = draft?.[directionName];
  const guide = useMemo(() => direction ? parseGuidedTransform(direction, callables) : undefined, [callables, direction]);
  const guidedCallable = callables.find((callable) => callable.id === guide?.callableId);
  const envelopeDescription = callableEnvelopeDescription(guidedCallable);
  const guidedValid = Boolean(guide && guide.callableId
    && guide.inputPaths.every((path) => path.trim())
    && (guide.outputKind === 'body' || guide.outputField.trim()));
  const replayLoading = replayPersistence === 'loading';
  const replayPersistenceTitle = replayStorageError
    || (replayPersistence === 'too-large'
      ? '当前草稿超过 256 KiB，仅保留在本次页面中；已移除旧的本机副本，避免下次恢复过期内容。'
      : replayPersistence === 'memory'
        ? '保存明文网关后，回放输入会仅保存在当前浏览器中。'
        : '仅保存在当前浏览器，不会进入明文网关导出、Bridge、Yak 引擎或 AI 上下文。');

  const selectProfile = (profile: BrowserTransformProfile) => {
    const direction = profile.request.enabled ? profile.request : profile.response;
    dispatch({
      type: 'profile.select',
      selectedProfileId: profile.id,
      draft: toInput(profile),
      directionName: profile.request.enabled ? 'request' : 'response',
      editorMode: parseGuidedTransform(direction, callables) ? 'guided' : 'advanced',
    });
    setWorkspaceView('flow');
  };

  const create = () => {
    if (!tab) return;
    dispatch({
      type: 'profile.select',
      selectedProfileId: '',
      draft: createBrowserTransformProfileInput(tab, selectedEvent, callables[0]),
      directionName: 'request',
      editorMode: 'guided',
    });
    setWorkspaceView('configure');
  };

  const patchDirection = (patcher: (value: BrowserTransformDirection) => BrowserTransformDirection) => {
    setDraft((current) => current ? { ...current, [directionName]: patcher(current[directionName]) } : current);
    setTestResult(undefined);
  };

  const patchNode = (id: string, patch: Partial<BrowserTransformPipelineNode>) => patchDirection((current) => ({
    ...current,
    nodes: current.nodes.map((node) => node.id === id ? { ...node, ...patch } as BrowserTransformPipelineNode : node),
  }));

  const patchGuide = (next: GuidedTransformDraft) => {
    const callable = callables.find((item) => item.id === next.callableId);
    patchDirection(() => compileGuidedTransform(next, callable));
  };

  const selectGuidedCallable = (callableId: string) => {
    if (!guide) return;
    const callable = callables.find((item) => item.id === callableId);
    const defaults = defaultGuidedTransform(callable, { outputKind: guide.outputKind, outputField: guide.outputField });
    patchGuide({
      ...defaults,
      inputPaths: defaults.inputPaths.map((path, index) => guide.inputPaths[index] || path),
      resultPath: callable?.output.shape === 'envelope' ? undefined : guide.resultPath,
    });
  };

  const patchGuideInput = (index: number, path: string) => {
    if (!guide) return;
    patchGuide({ ...guide, inputPaths: guide.inputPaths.map((item, itemIndex) => itemIndex === index ? path : item) });
  };

  const addNode = (kind: BrowserTransformPipelineNode['kind']) => patchDirection((current) => {
    const previous = current.nodes.at(-1);
    const reference = previous ? { nodeId: previous.id } : { nodeId: '' };
    let node: BrowserTransformPipelineNode;
    if (kind === 'context.read') node = { id: uid('context'), name: '读取上下文', kind, path: 'body' };
    else if (kind === 'builtin') node = { id: uid('builtin'), name: '转换数据', kind, operation: 'json.stringify', inputs: previous ? [reference] : [] };
    else if (kind === 'page.call') node = { id: uid('call'), name: callables[0]?.name || '调用页面函数', kind, callableId: callables[0]?.id || '', arguments: previous ? [reference] : [] };
    else node = { id: uid('output'), name: '写入输出', kind, destination: 'body', source: reference, encoding: 'auto' };
    return { ...current, nodes: [...current.nodes, node] };
  });

  const patchReferences = (node: BrowserTransformPipelineNode, references: BrowserTransformNodeReference[]) => {
    if (node.kind === 'builtin') patchNode(node.id, { inputs: references });
    else if (node.kind === 'page.call') patchNode(node.id, { arguments: references });
  };

  const save = () => run(async () => {
    if (!draft) return;
    const replaySeed = structuredClone(replayFields);
    const wasNew = !draft.id;
    const profile = await request('transform.profile.save', draft);
    if (wasNew) {
      const seedKey = `${profile.id}:${directionName}`;
      pendingReplaySeed.current = { key: seedKey, fields: replaySeed };
      replayBaselineFingerprint.current = '';
      replayStablePersistence.current = 'ready';
      setReplayLoadedKey(seedKey);
      setReplayPersistence('ready');
    }
    setProfiles((current) => [profile, ...current.filter((item) => item.id !== profile.id)]);
    setSelectedProfileId(profile.id);
    setDraft(toInput(profile));
    setWorkspaceView('flow');
  }, 'Pipeline v2 配置已保存');

  const remove = () => run(async () => {
    if (!draft?.id) { setDraft(undefined); return; }
    const removedId = draft.id;
    discardPendingReplaySave();
    setReplayLoadedKey('');
    const remaining = await request('transform.profile.delete', { id: removedId });
    // The background service also removes these keys. Repeating the local
    // cleanup here serializes behind any Options-page write already in flight.
    await deleteBrowserTransformReplayDrafts(removedId).catch(() => undefined);
    setProfiles(remaining);
    setSelectedProfileId(remaining[0]?.id || '');
    setDraft(remaining[0] ? toInput(remaining[0]) : undefined);
  }, '明文网关配置已删除');

  const clearReplay = () => run(async () => {
    if (!draft?.id) return;
    const profileId = draft.id;
    const key = replayKey;
    replayLoadRevision.current += 1;
    discardPendingReplaySave();
    setReplayLoadedKey('');
    await clearBrowserTransformReplayDraft(profileId, directionName);
    if (replayActiveKey.current !== key) return;
    const fallback = defaultReplayFields(tab, selectedEvent);
    replayBaselineFingerprint.current = replayFieldsFingerprint(fallback);
    replayStablePersistence.current = 'ready';
    applyReplayFields(fallback);
    setReplayStorageError('');
    setReplayPersistence('ready');
    setReplayLoadedKey(key);
  }, '当前方向的本机回放草稿已清空');

  const deleteCallable = (callable: BrowserPageCallable) => run(async () => {
    const remaining = await request('callable.delete', { ...callable.target, callableId: callable.id });
    setCallables(remaining);
    setConfirmDeleteCallableId('');
    setTestResult(undefined);
  }, callableReferences.get(callable.id) ? '页面函数已删除，引用它的明文网关需要重新绑定' : '页面函数已删除');

  const replayPacket = () => {
    const parsed = JSON.parse(testHeaders) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Header 必须是 JSON 对象');
    const headers = Object.entries(parsed as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value) }));
    return {
      method: testMethod.toUpperCase(),
      url: testUrl,
      statusCode: directionName === 'response' ? 200 : undefined,
      headers,
      bodyBase64: encodeUtf8(testBody),
    };
  };

  const validateRecovery = () => run(async () => {
    if (!savedProfile?.recovery || savedProfile.recovery.state !== 'validation-required') {
      throw new Error('当前恢复计划还没有等待验证的新页面函数');
    }
    setTestError('');
    setTestResult(undefined);
    const result = await request('transform.recovery.validate', {
      id: savedProfile.id,
      packet: replayPacket(),
    });
    setTestResult(result.execution);
    await load();
  }, '新页面函数已通过本地回放，等待确认启用');

  const confirmRecovery = () => run(async () => {
    const validationId = savedProfile?.recovery?.validation?.id;
    if (!savedProfile || !validationId) throw new Error('恢复验证已经失效，请重新执行本地回放');
    const profile = await request('transform.recovery.confirm', {
      id: savedProfile.id,
      validationId,
    });
    setProfiles((current) => [profile, ...current.filter((item) => item.id !== profile.id)]);
    setSelectedProfileId(profile.id);
    setDraft(toInput(profile));
    setTestResult(undefined);
  }, '页面绑定已恢复，并按原启用状态生效');

  const resetRecovery = () => run(async () => {
    if (!savedProfile) return;
    await request('transform.recovery.reset', { id: savedProfile.id });
    setTestResult(undefined);
    await load();
  }, '已取消本次恢复结果，旧网关继续保持停用');

  const execute = async () => {
    if (!draft?.id || dirty) { setTestError('请先保存当前 Pipeline'); return; }
    setTestError('');
    setTestResult(undefined);
    try {
      setTestResult(await request('transform.execute', {
        profileId: draft.id,
        direction: directionName,
        packet: replayPacket(),
      }));
    } catch (error) { setTestError(errorMessage(error)); }
  };

  return <div className="transform-workbench">
    <TransformProfileRail
      tab={tab}
      profiles={profiles}
      callables={callables}
      selectedProfileId={selectedProfileId}
      callableIds={callableIds}
      callableReferences={callableReferences}
      confirmDeleteCallableId={confirmDeleteCallableId}
      busy={busy}
      onCreate={create}
      onSelect={selectProfile}
      onConfirmDeleteCallable={setConfirmDeleteCallableId}
      onDeleteCallable={deleteCallable}
      onRefresh={load}
    />

    <main className="transform-editor">
      {!draft ? <div className="transform-editor-empty"><Link2 size={24} /><strong>建立明文与线上报文的转换链路</strong>{callables.length ? <Button variant="primary" onClick={create}><CirclePlus size={14} />新建 Pipeline</Button> : <Button variant="primary" onClick={onOpenCapture}><Code2 size={14} />{deepCaptureAvailable ? '先捕获页面函数' : '回到录制并保存页面函数'}</Button>}</div> : <>
        <header className="transform-editor-head">
          <div>{workspaceView === 'flow' && savedProfile
            ? <strong className="transform-editor-title">{draft.name}</strong>
            : <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />}
            <span>{draft.origin} · document 生命周期</span>
          </div>
          <div className="transform-editor-head__actions">
            <div className="transform-view-mode" role="tablist" aria-label="明文网关视图">
              <button type="button" disabled={!savedProfile} className={workspaceView === 'flow' ? 'is-selected' : ''} onClick={() => setWorkspaceView('flow')}><Workflow size={13} />数据流</button>
              <button type="button" className={workspaceView === 'configure' ? 'is-selected' : ''} onClick={() => setWorkspaceView('configure')}><Settings2 size={13} />配置</button>
            </div>
            <label><Switch checked={draft.enabled} disabled={recoveryPending} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />启用</label>
          </div>
        </header>
        {activeRecovery && activeRecovery.state !== 'ready' && <section className={`transform-recovery is-${activeRecovery.state}`} role="status">
          <span className="transform-recovery__mark"><RotateCcw size={16} /></span>
          <div className="transform-recovery__body">
            <small>文档恢复计划 · v{activeRecovery.contractVersion}</small>
            <strong>{activeRecovery.state === 'stale'
              ? '页面函数已失效，旧网关已安全停用'
              : activeRecovery.state === 'capturing'
                ? '等待在目标页面重复一次原业务操作'
                : activeRecovery.state === 'validation-required'
                  ? '新页面函数已捕获，需要本地回放验证'
                  : activeRecovery.state === 'confirmation-required'
                    ? '恢复验证通过，等待确认替换旧绑定'
                    : '自动恢复没有完成，旧网关仍保持停用'}</strong>
            <p>{activeRecovery.reason || activeRecovery.capture.reason}</p>
            <span>{activeRecovery.capture.method} · {activeRecovery.capture.urlPattern || draft.match.urlPattern} · {activeRecovery.binding.inputSemantics.filter((item) => !item.retained).length} 个动态输入</span>
          </div>
          <div className="transform-recovery__actions">
            {(activeRecovery.state === 'stale' || activeRecovery.state === 'failed' || activeRecovery.state === 'capturing') && (
              activeRecovery.capture.automatic
                ? <Button variant="primary" disabled={busy} onClick={() => onOpenRecovery(savedProfile!.id)}><RotateCcw size={14} />{activeRecovery.state === 'capturing' ? '返回捕获' : '重新捕获'}</Button>
                : <Button variant="primary" disabled={busy} onClick={onOpenCapture}><Code2 size={14} />重新录制分析</Button>
            )}
            {activeRecovery.state === 'validation-required' && <Button variant="primary" disabled={busy || replayLoading} onClick={() => void validateRecovery()}><FlaskConical size={14} />用本地回放验证</Button>}
            {activeRecovery.state === 'confirmation-required' && <Button variant="primary" disabled={busy} onClick={() => void confirmRecovery()}><CheckCircle2 size={14} />确认并恢复</Button>}
            {['capturing', 'validation-required', 'confirmation-required', 'failed'].includes(activeRecovery.state) && <Button variant="ghost" disabled={busy} onClick={() => void resetRecovery()}>取消本次恢复</Button>}
          </div>
        </section>}
        {workspaceView === 'flow' && savedProfile ? <TransformDataFlowView
          profile={savedProfile}
          direction={directionName}
          execution={testResult}
          onDirectionChange={setDirectionName}
          onConfigure={() => setWorkspaceView('configure')}
        /> : <>
        <div className="transform-route">
          <label><span>HTTP 方法</span><input value={draft.match.methods.join(', ')} onChange={(event) => setDraft({ ...draft, match: { ...draft.match, methods: event.target.value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean) } })} /></label>
          <label><span>URL 模式</span><input value={draft.match.urlPattern} onChange={(event) => setDraft({ ...draft, match: { ...draft.match, urlPattern: event.target.value } })} /></label>
          <label><span>并发</span><input type="number" min={1} max={8} value={draft.maxConcurrency} onChange={(event) => setDraft({ ...draft, maxConcurrency: Number(event.target.value) })} /></label>
        </div>
        <div className="transform-direction-tabs">
          {(['request', 'response'] as const).map((name) => <button key={name} className={directionName === name ? 'is-selected' : ''} onClick={() => setDirectionName(name)}>{name === 'request' ? '请求加密' : '响应解密'}<i className={draft[name].enabled ? 'is-enabled' : ''}>{draft[name].enabled ? `${draft[name].nodes.length} 节点` : '关闭'}</i></button>)}
        </div>
        {direction && <div className="transform-pipeline-editor">
          <div className="transform-direction-state"><div><strong>{directionName === 'request' ? '明文 → 线上请求' : '线上响应 → 明文'}</strong><span>{editorMode === 'guided' ? '确认三个业务选择，底层 Pipeline 自动生成' : '直接编辑有序 DAG 与节点引用'}</span></div><Switch checked={direction.enabled} onCheckedChange={(enabled) => patchDirection((current) => ({ ...current, enabled }))} /></div>
          <div className="transform-editor-mode" role="tablist" aria-label="Pipeline 编辑方式">
            <button type="button" className={editorMode === 'guided' ? 'is-selected' : ''} onClick={() => setEditorMode('guided')}><Sparkles size={13} />引导配置</button>
            <button type="button" className={editorMode === 'advanced' ? 'is-selected' : ''} onClick={() => setEditorMode('advanced')}><Code2 size={13} />高级 Pipeline</button>
          </div>

          {editorMode === 'guided' && (!guide ? <div className="transform-guide-empty">
            <Sparkles size={20} />
            <div><strong>{direction.nodes.length ? '这条 Pipeline 包含高级结构' : '选择页面函数后自动生成'}</strong><span>{direction.nodes.length ? '高级结构不会被静默改写；可继续使用高级编辑，或明确替换成三步引导流程。' : '无需添加节点、引用或内置转换。'}</span></div>
            <Button size="sm" variant="primary" disabled={!callables.length} onClick={() => patchGuide(defaultGuidedTransform(callables[0]))}>{direction.nodes.length ? '替换为引导流程' : '开始配置'}</Button>
          </div> : guide && <div className="transform-guide">
            <div className="transform-guide-flow">
              <span>逻辑明文</span><ArrowRight size={13} /><strong>{guidedCallable?.name || '选择页面函数'}</strong><ArrowRight size={13} /><span>{envelopeDescription || guidedOutputDescription(guide)}</span>
            </div>

            <section className="transform-guide-step">
              <span className="transform-guide-step__index">1</span>
              <div className="transform-guide-step__body">
                <header><div><strong>明文从哪里来</strong><span>通常选择整个逻辑 Body；多参数函数会逐项显示。</span></div><FileInput size={15} /></header>
                <div className="transform-guide-inputs">
                  {guide.inputPaths.map((path, index) => {
                    const source = splitInputPath(path);
                    const slot = guidedCallable?.inputSlots.filter((item) => !item.retained)[index];
                    const needsField = !['body', 'text'].includes(source.kind);
                    return <div key={`${guide.callableId}:${index}`}>
                      <label><span>{slot ? `${slot.name} · ${INPUT_ROLE_LABELS[slot.role]}` : `参数 ${index + 1}`}</span><select value={source.kind} onChange={(event) => {
                        const kind = event.target.value as GuidedInputKind;
                        const defaultField = kind === 'body-field' ? 'value' : kind === 'header-field' ? 'authorization' : kind === 'query-field' ? 'value' : kind === 'custom' ? 'body' : '';
                        patchGuideInput(index, joinInputPath(kind, defaultField));
                      }}><option value="body">整个逻辑 Body</option><option value="body-field">Body 中的字段</option><option value="text">原始 Body 文本</option><option value="header-field">Header 字段</option><option value="query-field">Query 参数</option><option value="custom">高级上下文路径</option></select></label>
                      {needsField && <label><span>{source.kind === 'custom' ? '上下文路径' : '字段名'}</span><input value={source.field} onChange={(event) => patchGuideInput(index, joinInputPath(source.kind, event.target.value))} placeholder={source.kind === 'custom' ? 'body.account.id' : 'password'} /></label>}
                    </div>;
                  })}
                  {!guide.inputPaths.length && <div className="transform-guide-note">这个页面函数不需要外部输入，将直接使用页面内保留的环境。</div>}
                </div>
              </div>
            </section>

            <section className="transform-guide-step">
              <span className="transform-guide-step__index">2</span>
              <div className="transform-guide-step__body">
                <header><div><strong>交给哪个页面函数</strong><span>函数在当前页面文档中执行，Key、IV 与闭包值不会离开页面。</span></div><Code2 size={15} /></header>
                <label className="transform-guide-callable"><span>页面能力</span><select value={guide.callableId} onChange={(event) => selectGuidedCallable(event.target.value)}><option value="">选择页面函数</option>{callables.map((callable) => <option key={callable.id} value={callable.id}>{callable.name}</option>)}</select></label>
                {guidedCallable && <div className="transform-guide-callable-meta"><span>{callableKindLabel(guidedCallable)}</span><strong>{guidedCallable.algorithm || guidedCallable.operation}</strong><em>{guidedCallable.inputSlots.filter((slot) => !slot.retained).length} 个明文参数</em></div>}
                {!envelopeDescription && <details className="transform-guide-result"><summary>函数返回的是对象，需要取其中一个字段</summary><label><span>返回字段路径</span><input value={guide.resultPath || ''} onChange={(event) => patchGuide({ ...guide, resultPath: event.target.value || undefined })} placeholder="例如 encryptedData；留空使用完整返回值" /></label></details>}
              </div>
            </section>

            <section className="transform-guide-step">
              <span className="transform-guide-step__index">3</span>
              <div className="transform-guide-step__body">
                <header><div><strong>线上请求写到哪里</strong><span>选择报文形态即可，字段组合与节点引用由插件生成。</span></div><ArrowDown size={15} /></header>
                {envelopeDescription ? <div className="transform-guide-note">已由真实请求边界确认：{envelopeDescription}。插件会原样保持字段之间的动态关系，并只序列化一次。</div> : <div className="transform-guide-output">
                  <label><span>输出形态</span><select value={guide.outputKind} onChange={(event) => {
                    const outputKind = event.target.value as GuidedTransformOutputKind;
                    const outputField = outputKind === 'body' ? '' : guide.outputField || (outputKind === 'header' ? 'X-Sign' : outputKind === 'query' ? 'signature' : 'encryptedData');
                    patchGuide({ ...guide, outputKind, outputField, setFormContentType: outputKind === 'form-field' });
                  }}><option value="body">替换整个 Body</option><option value="json-field">写入 JSON 字段</option><option value="form-field">写入表单字段</option><option value="header">写入 Header</option><option value="query">写入 Query 参数</option></select></label>
                  {guide.outputKind !== 'body' && <label><span>{outputFieldLabel(guide.outputKind)}</span><input value={guide.outputField} onChange={(event) => patchGuide({ ...guide, outputField: event.target.value })} placeholder={guide.outputKind === 'form-field' ? 'encryptedData' : guide.outputKind === 'header' ? 'X-Sign' : 'signature'} /></label>}
                </div>}
                {!envelopeDescription && guide.outputKind === 'form-field' && <label className="transform-guide-content-type"><Switch checked={guide.setFormContentType} onCheckedChange={(setFormContentType) => patchGuide({ ...guide, setFormContentType })} /><span><strong>自动设置表单 Content-Type</strong><small>生成 application/x-www-form-urlencoded，无需再添加固定值和 Header 节点。</small></span></label>}
                <div className={`transform-guide-ready ${guidedValid ? 'is-ready' : ''}`}><CheckCircle2 size={14} /><span>{guidedValid ? `将编排 ${direction.nodes.length} 个执行节点` : '补全页面函数、输入来源和输出字段后即可保存'}</span></div>
              </div>
            </section>
          </div>)}

          {editorMode === 'advanced' && <>
            <div className="transform-advanced-notice"><Code2 size={14} /><span><strong>高级 Pipeline</strong>节点、引用和白名单操作会直接影响线上报文；常规加解密场景建议使用引导配置。</span></div>
            <div className="transform-node-list">
              {direction.nodes.map((node, index) => {
                const available = direction.nodes.slice(0, index);
                const references = referencesOf(node);
                return <section className="transform-node" key={node.id}>
                  <div className="transform-node-index"><span>{index + 1}</span>{index < direction.nodes.length - 1 && <i />}</div>
                  <div className="transform-node-fields">
                    <header><em>{nodeLabel(node.kind)}</em><input value={node.name} onChange={(event) => patchNode(node.id, { name: event.target.value })} /><Button size="icon" variant="ghost" aria-label="删除节点" title="删除节点" onClick={() => patchDirection((current) => ({ ...current, nodes: current.nodes.filter((item) => item.id !== node.id) }))}><Trash2 size={13} /></Button></header>
                    {node.kind === 'context.read' && <label><span>上下文路径</span><input value={node.path} onChange={(event) => patchNode(node.id, { path: event.target.value })} placeholder="body.password" /></label>}
                    {node.kind === 'builtin' && <><label><span>白名单操作</span><select value={node.operation} onChange={(event) => patchNode(node.id, { operation: event.target.value as BrowserTransformBuiltinOperation })}>{BUILTINS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>{node.operation === 'value.literal' && <label><span>固定值</span><input value={typeof node.options?.value === 'string' ? node.options.value : ''} onChange={(event) => patchNode(node.id, { options: { value: event.target.value } })} /></label>}{['form.compose', 'object.compose'].includes(node.operation) && <label><span>字段名 · 按输入顺序</span><input value={Array.isArray(node.options?.keys) ? node.options.keys.join(', ') : ''} placeholder="encryptedData, signature" onChange={(event) => patchNode(node.id, { options: { ...node.options, keys: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) } })} /></label>}{node.operation === 'object.pick' && <><label><span>读取路径</span><input value={Array.isArray(node.options?.paths) ? node.options.paths.join(', ') : ''} placeholder="account.id, profile.name" onChange={(event) => patchNode(node.id, { options: { ...node.options, paths: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) } })} /></label><label><span>输出字段名</span><input value={Array.isArray(node.options?.keys) ? node.options.keys.join(', ') : ''} placeholder="accountId, name" onChange={(event) => patchNode(node.id, { options: { ...node.options, keys: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) } })} /></label></>}</>}
                    {node.kind === 'page.call' && <label><span>页面函数</span><select value={node.callableId} onChange={(event) => patchNode(node.id, { callableId: event.target.value })}><option value="">选择页面函数</option>{callables.map((callable) => <option key={callable.id} value={callable.id}>{callable.name}</option>)}</select></label>}
                    {(node.kind === 'page.call' || (node.kind === 'builtin' && node.operation !== 'value.literal')) && <div className="transform-node-references"><span>输入引用</span>{references.map((reference, referenceIndex) => <div key={`${node.id}:${referenceIndex}`}><select value={reference.nodeId} onChange={(event) => patchReferences(node, references.map((item, itemIndex) => itemIndex === referenceIndex ? { ...item, nodeId: event.target.value } : item))}><option value="">选择前序节点</option>{available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><input value={reference.path || ''} onChange={(event) => patchReferences(node, references.map((item, itemIndex) => itemIndex === referenceIndex ? { ...item, path: event.target.value || undefined } : item))} placeholder="可选子路径" /><Button size="icon" variant="ghost" aria-label="删除输入引用" onClick={() => patchReferences(node, references.filter((_, itemIndex) => itemIndex !== referenceIndex))}><Trash2 size={12} /></Button></div>)}<Button size="sm" variant="ghost" onClick={() => patchReferences(node, [...references, { nodeId: available.at(-1)?.id || '' }])}><Plus size={12} />输入</Button></div>}
                    {node.kind === 'output.write' && <div className="transform-output-fields"><label><span>来源节点</span><select value={node.source.nodeId} onChange={(event) => patchNode(node.id, { source: { ...node.source, nodeId: event.target.value } })}><option value="">选择前序节点</option>{available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label><span>子路径</span><input value={node.source.path || ''} onChange={(event) => patchNode(node.id, { source: { ...node.source, path: event.target.value || undefined } })} placeholder="可选" /></label><label><span>写入目标</span><input value={node.destination} onChange={(event) => patchNode(node.id, { destination: event.target.value })} placeholder="body.encryptedData" /></label><label><span>编码</span><select value={node.encoding} onChange={(event) => patchNode(node.id, { encoding: event.target.value as 'auto' })}><option value="auto">自动</option><option value="text">文本</option><option value="json">JSON</option><option value="base64">Base64</option></select></label></div>}
                  </div>
                </section>;
              })}
            </div>
            <div className="transform-node-add"><span>添加节点</span><Button size="sm" variant="ghost" onClick={() => addNode('context.read')}><FileInput size={13} />上下文</Button><Button size="sm" variant="ghost" onClick={() => addNode('builtin')}><Braces size={13} />内置转换</Button><Button size="sm" variant="ghost" onClick={() => addNode('page.call')}><Code2 size={13} />页面函数</Button><Button size="sm" variant="ghost" onClick={() => addNode('output.write')}><ArrowDown size={13} />输出</Button></div>
          </>}
        </div>}
        <footer className="transform-editor-actions"><span className={bindingReady ? 'is-ready' : 'is-stale'}><i />{bindingReady ? '当前页面函数可用' : recoveryPending ? '旧绑定已停用，等待恢复完成' : '页面函数缺失或文档已变化'}</span><Button size="icon" variant="ghost" aria-label="删除配置" title="删除配置" onClick={() => void remove()}><Trash2 size={14} /></Button><Button variant="primary" disabled={busy || recoveryPending || !dirty || (editorMode === 'guided' && Boolean(direction?.enabled) && (!guide || !guidedValid))} onClick={() => void save()}><Save size={14} />保存</Button></footer>
        </>}
      </>}
    </main>

    <TransformReplayPanel
      tab={tab}
      draft={draft}
      busy={busy}
      replayLoading={replayLoading}
      replayPersistence={replayPersistence}
      replayPersistenceLabel={replayPersistenceLabel(replayPersistence)}
      replayPersistenceTitle={replayPersistenceTitle}
      gatewayShared={gatewayShared}
      gatewayShareExpiresAt={gatewayShareExpiresAt}
      gatewayBridgeConnected={gatewayBridgeConnected}
      onShareGateway={() => run(
        onShareGateway,
        gatewayShared ? '共享会话已刷新' : '当前页面已共享给 Yakit',
      )}
      onClear={clearReplay}
      canExecute={Boolean(draft?.id && !dirty && !busy && !replayLoading && bindingReady)}
      onExecute={execute}
      method={testMethod}
      url={testUrl}
      headers={testHeaders}
      body={testBody}
      sample={testSample}
      onMethodChange={(value) => dispatch({ type: 'patch', value: { testMethod: value, testResult: undefined } })}
      onUrlChange={(value) => dispatch({ type: 'patch', value: { testUrl: value, testResult: undefined } })}
      onHeadersChange={(value) => dispatch({ type: 'patch', value: { testHeaders: value, testResult: undefined } })}
      onBodyChange={(value) => dispatch({ type: 'patch', value: { testBody: value, testResult: undefined } })}
      loadError={loadError}
      replayStorageError={replayStorageError}
      testError={testError}
      result={testResult}
    />
  </div>;
}
