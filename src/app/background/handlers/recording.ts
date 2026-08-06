import type { BackgroundRequestHandler } from '../router';
import { ok } from '../response';
import { requiredDebuggerTarget, requiredRequestTarget } from '../request-context';
import {
  browserRecordingStatus,
  clearBrowserRecording,
  createRecordedPageCallable,
  getBrowserRecording,
  startBrowserRecording,
  stopBrowserRecording,
} from '@/features/browser-recording/service';
import {
  createCapturedPageCallable,
  deepCaptureStatus,
  detachDeepCapture,
  keepDeepCaptureAlive,
  resumeDeepCapture,
  startDeepCapture,
} from '@/features/deep-capture/service';
import {
  deletePageCallable,
  executePageCallable,
  listPageCallables,
} from '@/features/page-callable/service';
import { invalidateBrowserTransformProfilesForCallable } from '@/features/browser-transform/service';
import { appendAuditEvent } from '@/features/diagnostics/audit';
import {
  resolveBrowserProfileCallableAnalysis,
  resolveBrowserProfileCaptureContext,
  stageBrowserProfileEvidence,
} from '@/features/browser-analysis/service';

export const handleRecordingRequest: BackgroundRequestHandler = async (request, sender) => {
  switch (request.action) {
    case 'recording.start': {
      const input = request.payload;
      const target = await requiredRequestTarget(input, sender);
      const snapshot = await startBrowserRecording(target, input);
      void appendAuditEvent({
        category: 'capability',
        action: 'recording.start',
        outcome: 'success',
        targetTabId: target.tabId,
        summary: input.captureValues ? '包含用户明确启用的短时值预览' : '仅元数据',
      });
      return ok(snapshot);
    }
    case 'recording.status': return ok(await browserRecordingStatus(
      await requiredRequestTarget(request.payload, sender),
    ));
    case 'recording.get': {
      const target = await requiredRequestTarget(request.payload, sender);
      const snapshot = await getBrowserRecording(target, request.payload.limit, true);
      await stageBrowserProfileEvidence(snapshot);
      return ok(snapshot);
    }
    case 'recording.clear': {
      const target = await requiredRequestTarget(request.payload, sender);
      const snapshot = await clearBrowserRecording(target, true);
      void appendAuditEvent({
        category: 'capability',
        action: 'recording.clear',
        outcome: 'success',
        targetTabId: target.tabId,
      });
      return ok(snapshot);
    }
    case 'recording.stop': {
      const target = await requiredRequestTarget(request.payload, sender);
      const snapshot = await stopBrowserRecording(target, true);
      await stageBrowserProfileEvidence(snapshot);
      void appendAuditEvent({
        category: 'capability',
        action: 'recording.stop',
        outcome: 'success',
        targetTabId: target.tabId,
      });
      return ok(snapshot);
    }
    case 'callable.create': {
      const payload = request.payload;
      const target = payload.source === 'deep-capture'
        ? await requiredDebuggerTarget(payload, sender)
        : await requiredRequestTarget(payload, sender);
      let callable;
      if (payload.source !== 'deep-capture') {
        callable = await createRecordedPageCallable(target, payload);
      } else if (payload.strategy === 'request-transaction') {
        const capture = await resolveBrowserProfileCaptureContext(target, payload.candidateId);
        callable = await createCapturedPageCallable(target, payload.callFrameId, {
          strategy: 'request-transaction',
          name: payload.name,
          transaction: capture.transaction,
          analysis: capture.analysis,
        });
      } else if (payload.strategy === 'selected-frame') {
        const analysis = payload.candidateId
          ? await resolveBrowserProfileCallableAnalysis(target, payload.candidateId)
          : undefined;
        callable = await createCapturedPageCallable(target, payload.callFrameId, {
          strategy: 'selected-frame',
          name: payload.name,
          analysis,
        });
      } else {
        callable = await createCapturedPageCallable(target, payload.callFrameId, payload);
      }
      void appendAuditEvent({
        category: 'capability',
        action: 'callable.create',
        outcome: 'success',
        targetTabId: target.tabId,
        summary: callable.name,
      });
      return ok(callable);
    }
    case 'callable.list': return ok(await listPageCallables(
      await requiredRequestTarget(request.payload, sender),
    ));
    case 'callable.execute': {
      const target = await requiredRequestTarget(request.payload, sender);
      const result = await executePageCallable(
        target,
        request.payload.callableId,
        request.payload.args,
      );
      void appendAuditEvent({
        category: 'capability',
        action: 'callable.execute',
        outcome: 'success',
        targetTabId: target.tabId,
        summary: `${result.durationMs.toFixed(1)} ms`,
      });
      return ok(result);
    }
    case 'callable.delete': {
      const target = await requiredRequestTarget(request.payload, sender);
      const callables = await deletePageCallable(target, request.payload.callableId);
      await invalidateBrowserTransformProfilesForCallable(target, request.payload.callableId);
      return ok(callables);
    }
    case 'deep.capture.start': {
      const target = await requiredRequestTarget(request.payload, sender);
      const status = await startDeepCapture(target, request.payload.matcher);
      void appendAuditEvent({
        category: 'capability',
        action: 'deep.capture.start',
        outcome: 'success',
        targetTabId: target.tabId,
        summary: request.payload.matcher.kind === 'request'
          ? request.payload.matcher.urlPattern
          : request.payload.matcher.operation,
      });
      return ok(status);
    }
    case 'deep.capture.status': return ok(await deepCaptureStatus(
      await requiredDebuggerTarget(request.payload, sender),
    ));
    case 'deep.capture.keepalive': return ok(await keepDeepCaptureAlive(
      await requiredDebuggerTarget(request.payload, sender),
    ));
    case 'deep.capture.resume': return ok(await resumeDeepCapture(
      await requiredDebuggerTarget(request.payload, sender),
    ));
    case 'deep.capture.detach': {
      const target = await requiredDebuggerTarget(request.payload, sender);
      const status = await detachDeepCapture(target);
      void appendAuditEvent({
        category: 'capability',
        action: 'deep.capture.detach',
        outcome: 'success',
        targetTabId: target.tabId,
      });
      return ok(status);
    }
    default: return undefined;
  }
};
