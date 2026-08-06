import type { BrowserDeepCaptureMatcher } from '@/types/models';
import type { CapabilityDomainHandler } from '../capability-context';
import { allowedTarget, requireScope } from '../capability-context';
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
import {
  callableInspect,
  callableReplay,
  recordingEvidenceInspect,
  recordingTraceList,
  resolveBrowserProfileCallableAnalysis,
  resolveBrowserProfileCaptureContext,
  stageBrowserProfileEvidence,
} from '@/features/browser-analysis/service';
import { RECORDING_CAPABILITY_DOMAIN } from '../capability-domains';

export const recordingCapabilityHandler: CapabilityDomainHandler = {
  ...RECORDING_CAPABILITY_DOMAIN,
  async handle({ method, input, grant }) {
    if (method.startsWith('browser.recording.')) {
      const target = await allowedTarget(grant, input);
      if (method === 'browser.recording.trace.list') {
        return recordingTraceList(target, typeof input.limit === 'number' ? input.limit : 40);
      }
      if (method === 'browser.recording.evidence.inspect') {
        const includeValues = input.includeValues === true;
        if (includeValues) requireScope(grant, 'browser.recording.sensitive.read');
        return recordingEvidenceInspect(
          target,
          String(input.traceId || ''),
          typeof input.eventId === 'string' ? input.eventId : undefined,
          includeValues,
        );
      }
      if (method === 'browser.recording.start') {
        if (input.captureValues === true) {
          requireScope(grant, 'browser.recording.sensitive.read');
        }
        return startBrowserRecording(target, {
          captureValues: input.captureValues === true,
          maxEntries: typeof input.maxEntries === 'number' ? input.maxEntries : undefined,
          maxValueBytes: typeof input.maxValueBytes === 'number' ? input.maxValueBytes : undefined,
          expiresAt: grant.expiresAt,
        }, { kind: 'grant', grantId: grant.id, expiresAt: grant.expiresAt });
      }
      if (method === 'browser.recording.status') return browserRecordingStatus(target);
      if (method === 'browser.recording.get') {
        const snapshot = await getBrowserRecording(
          target,
          typeof input.limit === 'number' ? input.limit : 500,
          grant.scopes.includes('browser.recording.sensitive.read'),
        );
        await stageBrowserProfileEvidence(snapshot);
        return snapshot;
      }
      if (method === 'browser.recording.clear') {
        return clearBrowserRecording(
          target,
          grant.scopes.includes('browser.recording.sensitive.read'),
        );
      }
      const snapshot = await stopBrowserRecording(
        target,
        grant.scopes.includes('browser.recording.sensitive.read'),
      );
      await stageBrowserProfileEvidence(snapshot);
      return snapshot;
    }

    if (method.startsWith('browser.callable.')) {
      const source = String(input.source || '');
      const target = await allowedTarget(grant, input, source !== 'deep-capture');
      if (method === 'browser.callable.inspect') {
        return callableInspect(
          target,
          typeof input.callableId === 'string' ? input.callableId : undefined,
        );
      }
      if (method === 'browser.callable.replay') {
        return callableReplay(
          target,
          String(input.callableId || ''),
          Array.isArray(input.args) ? input.args : [],
        );
      }
      if (method === 'browser.callable.list') return listPageCallables(target);
      if (method === 'browser.callable.create') {
        if (source === 'deep-capture') {
          requireScope(grant, 'browser.debugger.control');
          if (input.strategy === 'request-transaction') {
            const capture = await resolveBrowserProfileCaptureContext(
              target,
              String(input.candidateId || ''),
            );
            return createCapturedPageCallable(target, String(input.callFrameId || ''), {
              strategy: 'request-transaction',
              name: typeof input.name === 'string' ? input.name : undefined,
              transaction: capture.transaction,
              analysis: capture.analysis,
            }, { kind: 'grant', grantId: grant.id, expiresAt: grant.expiresAt });
          }
          const selectedFrameAnalysis = input.strategy === 'selected-frame' && typeof input.candidateId === 'string'
            ? await resolveBrowserProfileCallableAnalysis(target, input.candidateId)
            : undefined;
          return createCapturedPageCallable(
            target,
            String(input.callFrameId || ''),
            input.strategy === 'expression' ? {
              strategy: 'expression',
              name: String(input.name || ''),
              functionExpression: String(input.functionExpression || ''),
            } : {
              strategy: 'selected-frame',
              name: typeof input.name === 'string' ? input.name : undefined,
              analysis: selectedFrameAnalysis,
            },
            { kind: 'grant', grantId: grant.id, expiresAt: grant.expiresAt },
          );
        }
        return createRecordedPageCallable(target, {
          callHandleId: String(input.callHandleId || ''),
          name: String(input.name || ''),
        });
      }
      if (method === 'browser.callable.execute') {
        return executePageCallable(
          target,
          String(input.callableId || ''),
          Array.isArray(input.args) ? input.args : [],
        );
      }
      const callableId = String(input.callableId || '');
      const callables = await deletePageCallable(target, callableId);
      await invalidateBrowserTransformProfilesForCallable(target, callableId);
      return callables;
    }

    const target = await allowedTarget(
      grant,
      input,
      method === 'browser.deep_capture.start',
    );
    const owner = { kind: 'grant' as const, grantId: grant.id, expiresAt: grant.expiresAt };
    if (method === 'browser.deep_capture.start') {
      return startDeepCapture(target, input.matcher as BrowserDeepCaptureMatcher, owner);
    }
    if (method === 'browser.deep_capture.status') return deepCaptureStatus(target, owner);
    if (method === 'browser.deep_capture.keepalive') return keepDeepCaptureAlive(target, owner);
    if (method === 'browser.deep_capture.resume') {
      return resumeDeepCapture(target, 'engine-request', owner);
    }
    return detachDeepCapture(target, owner);
  },
};
