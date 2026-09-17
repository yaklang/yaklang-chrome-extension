import {
  startBrowserRecording,
  stopBrowserRecording,
} from '@/features/browser-recording/service';
import {
  listRecordingTraces,
  stageBrowserProfileEvidence,
} from '@/features/browser-analysis/service';
import {
  listNetworkRequests,
  startNetworkCapture,
  stopNetworkCapture,
} from '@/features/network-capture/service';
import { actOnPageNode, capturePageContext } from '@/features/page-context/service';
import {
  beginPageDialogCapture,
  endPageDialogCapture,
  installPageDialogCapture,
  restorePageDialogCapture,
} from '@/features/page-context/dialogs';
import { ExtensionError } from '@/shared/errors';
import { pairedBrowserTransformCandidate } from '@/features/browser-transform/profile-draft';
import type {
  BrowserRecordingEvent,
  BrowserRecordingSnapshot,
  BrowserTarget,
  NetworkRequestRecord,
  PageDialog,
  PageNodeActionResult,
} from '@/types/models';

type InspectionOwner = { grantId: string; expiresAt: number };
export { installPageDialogCapture, restorePageDialogCapture };

function clipped(value: string | undefined, max: number): string | undefined {
  return value === undefined ? undefined : value.slice(0, max);
}

function compactEvent(event: BrowserRecordingEvent): Record<string, unknown> {
  return {
    id: event.id,
    traceId: event.traceId,
    kind: event.kind,
    operation: event.operation,
    label: event.label,
    crypto: event.crypto,
    transform: event.transform,
    direction: event.direction,
    method: event.method,
    statusCode: event.statusCode,
    url: clipped(event.url, 2_048),
    dataType: event.dataType,
    byteLength: event.byteLength,
    resultByteLength: event.resultByteLength,
    scriptUrl: clipped(event.scriptUrl, 2_048),
    stack: clipped(event.stack, 512),
    callableCapable: event.callableCapable,
    callHandleId: event.callHandleId,
    arguments: event.arguments?.slice(0, 8),
    inputs: event.inputs.slice(0, 12),
    outputs: event.outputs.slice(0, 12),
    inputPreview: clipped(event.inputPreview, 1_024),
    outputPreview: clipped(event.outputPreview, 1_024),
    error: event.error,
  };
}

function compactRequest(request: NetworkRequestRecord): Record<string, unknown> {
  return {
    id: request.id,
    method: request.method,
    url: clipped(request.url, 4_096),
    resourceType: request.resourceType,
    statusCode: request.statusCode,
    durationMs: request.durationMs,
    error: request.error,
    requestBody: request.requestBody && {
      ...request.requestBody,
      data: clipped(request.requestBody.data, 2_048),
    },
    responseContentType: request.responseContentType,
    responseSize: request.responseSize,
  };
}

export function summarizeCryptoInspection(
  snapshot: BrowserRecordingSnapshot,
  requests: NetworkRequestRecord[],
): Record<string, unknown> {
  const events = snapshot.events.slice(-16);
  const cryptoCount = events.filter((event) => event.kind === 'crypto').length;
  const transformCount = events.filter((event) => event.kind === 'transform').length;
  const state = cryptoCount + transformCount > 0
    ? 'observed'
    : events.length + requests.length > 0
      ? 'boundary_only'
      : 'no_evidence';
  return {
    state,
    summary: state === 'observed'
      ? `已观测到 ${cryptoCount} 次密码调用和 ${transformCount} 次编码/序列化转换`
      : state === 'boundary_only'
        ? '已观测到页面或网络边界，但未命中已知加解密适配器'
        : '本次页面操作没有产生可分析证据',
    recording: {
      count: snapshot.status.count,
      droppedCount: snapshot.status.droppedCount,
      events: events.map(compactEvent),
      traces: listRecordingTraces(snapshot, 6),
    },
    network: {
      count: requests.length,
      requests: requests.slice(0, 8).map(compactRequest),
    },
  };
}

async function waitForInspectionIdle(target: BrowserTarget, maxWaitMs: number): Promise<NetworkRequestRecord[]> {
  const startedAt = Date.now();
  let lastChangedAt = startedAt;
  let previousSignature = '';
  let observedActivity = false;
  let requests: NetworkRequestRecord[] = [];
  while (Date.now() - startedAt < maxWaitMs) {
    requests = await listNetworkRequests(target, 20);
    const signature = requests.map((item) => `${item.id}:${item.completedAt || ''}:${item.error || ''}`).join('|');
    if (signature !== previousSignature) {
      previousSignature = signature;
      lastChangedAt = Date.now();
    }
    if (requests.length > 0) observedActivity = true;
    const allFinished = requests.every((item) => item.completedAt !== undefined || Boolean(item.error));
    if (observedActivity && Date.now() - startedAt >= 500 && allFinished && Date.now() - lastChangedAt >= 350) break;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
  return requests;
}

export async function inspectPageCryptoOperation(
  target: BrowserTarget,
  input: { captureId: string; nodeId: string; settleMs?: number },
  owner: InspectionOwner,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const settleMs = Math.max(250, Math.min(input.settleMs || 4_000, 5_000));
  const warnings: string[] = [];
  let action: PageNodeActionResult | undefined;
  let snapshot: BrowserRecordingSnapshot | undefined;
  let requests: NetworkRequestRecord[] = [];
  let dialogs: PageDialog[] = [];
  let postAction: Record<string, unknown> | undefined;
  let recordingStarted = false;
  let networkStarted = false;
  let dialogCaptureOwned = false;

  dialogCaptureOwned = await beginPageDialogCapture(target);
  try {
    await startNetworkCapture(target, {
      captureHeaders: false,
      captureBody: true,
      maxEntries: 40,
      maxBodyBytes: 8_192,
    }, {
      kind: 'grant',
      grantId: owner.grantId,
      expiresAt: owner.expiresAt,
      followSameOriginNavigation: true,
    });
    networkStarted = true;
    await startBrowserRecording(target, {
      captureValues: true,
      maxEntries: 160,
      maxValueBytes: 4_096,
      expiresAt: owner.expiresAt,
    }, { kind: 'grant', grantId: owner.grantId, expiresAt: owner.expiresAt });
    recordingStarted = true;

    action = await actOnPageNode(input.captureId, input.nodeId, 'click', target);
    requests = await waitForInspectionIdle(target, settleMs);
    snapshot = await stopBrowserRecording(target, true);
    recordingStarted = false;
  } finally {
    if (recordingStarted) {
      try { snapshot = await stopBrowserRecording(target, true); } catch (error) {
        warnings.push(`停止页面录制失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (networkStarted) {
      try {
        if (!requests.length) requests = await listNetworkRequests(target, 20);
        await stopNetworkCapture(target);
      } catch (error) {
        warnings.push(`停止网络观察失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    dialogs = await endPageDialogCapture(target, dialogCaptureOwned);
    try {
      const context = await capturePageContext({ includeDom: true }, {
        tabId: target.tabId,
        frameId: target.frameId,
      });
      postAction = {
        sameDocument: Boolean(target.documentId && context.target.documentId === target.documentId),
        captureId: context.captureId,
        target: context.target,
        authentication: context.authentication,
        document: {
          title: context.document.title,
          url: context.document.url,
          readyState: context.document.readyState,
          forms: context.document.forms,
          interactive: context.document.interactive,
        },
      };
    } catch (error) {
      warnings.push(`采集操作后页面状态失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!snapshot || !action) {
    throw new ExtensionError('crypto_inspection_incomplete', '未能完整执行页面加解密检查');
  }
  await stageBrowserProfileEvidence(snapshot, action.node.semanticKey);
  const preparation = snapshot.profileCandidates
    .filter((candidate) => [candidate.source, ...candidate.sources]
      .some((source) => Boolean(source.callHandleId)))
    .sort((left, right) => Number(right.direction === 'request') - Number(left.direction === 'request')
      || right.confidence.score - left.confidence.score)[0];
  const pairedPreparation = preparation
    ? pairedBrowserTransformCandidate(snapshot.profileCandidates, preparation, true)
    : undefined;
  const directions = [preparation, pairedPreparation].filter(
    (candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate),
  );
  const requestPreparation = directions.find((candidate) => candidate.direction === 'request');
  const responsePreparation = directions.find((candidate) => candidate.direction === 'response');
  const preparationReady = Boolean(preparation?.status === 'ready'
    && directions.every((candidate) => candidate.status === 'ready'
      && [candidate.source, ...candidate.sources].some((source) => Boolean(source.callHandleId))));
  const evidence = summarizeCryptoInspection(snapshot, requests);
  return {
    version: 1,
    target,
    trigger: { captureId: input.captureId, nodeId: input.nodeId, action: 'click' },
    action,
    startedAt,
    completedAt: Date.now(),
    dialogs,
    dialogHandling: {
      strategy: 'nonblocking-local-dialog-defaults',
      autoDismissedAlerts: dialogs.filter((dialog) => dialog.type === 'alert').length,
      autoAcceptedConfirms: dialogs.filter((dialog) => dialog.type === 'confirm').length,
      autoSubmittedPrompts: dialogs.filter((dialog) => dialog.type === 'prompt').length,
      count: dialogs.length,
      navigationInferred: false,
    },
    postAction,
    gatewayPreparation: preparation ? {
      state: preparationReady ? 'ready' : 'capture-required',
      candidateId: preparation.id,
      direction: preparation.direction,
      confidence: preparation.confidence,
      directions: {
        request: requestPreparation
          ? { candidateId: requestPreparation.id, status: requestPreparation.status }
          : { status: 'absent' },
        response: responsePreparation
          ? { candidateId: responsePreparation.id, status: responsePreparation.status }
          : { status: 'absent' },
      },
      request: {
        method: preparation.request.method,
        url: preparation.request.url,
        bodyFormat: preparation.request.bodyFormat,
        destinations: preparation.request.mappings.map((mapping) => mapping.destination).filter(Boolean),
      },
      next: preparationReady
        ? '需要明文 HTTP 测试时，直接调用 browser.transform.prepare；同一事务的请求与响应会编译进一个 Profile'
        : '调用 browser.transform.prepare，插件将自动重触发本次操作、捕获缺失的业务方向并验证完整网关；不需要打开插件 UI',
    } : {
      state: 'unavailable',
      next: '本次证据可用于分析，但不足以生成明文转换；继续使用当前页面，不要重新打开网站',
    },
    warnings,
    ...evidence,
    purpose: '仅分析这一次页面操作；未创建、验证或保存明文网关 Profile',
  };
}
