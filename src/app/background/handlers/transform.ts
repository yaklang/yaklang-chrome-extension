import type { BackgroundRequestHandler } from '../router';
import { ok } from '../response';
import { requiredDebuggerTarget, requiredRequestTarget } from '../request-context';
import {
  captureBrowserTransformRecovery,
  confirmBrowserTransformRecovery,
  deleteBrowserTransformProfile,
  executeBrowserTransform,
  getBrowserTransformRecovery,
  listBrowserTransformProfiles,
  resetBrowserTransformRecovery,
  saveBrowserTransformProfile,
  startBrowserTransformRecovery,
  validateBrowserTransformRecovery,
} from '@/features/browser-transform/service';
import {
  latestBrowserTransformValidation,
  proposeBrowserTransformProfile,
  validateInferredBrowserTransformProfile,
} from '@/features/browser-analysis/service';
import { appendAuditEvent } from '@/features/diagnostics/audit';

export const handleTransformRequest: BackgroundRequestHandler = async (request, sender) => {
  switch (request.action) {
    case 'analysis.profile.propose': {
      const input = request.payload;
      const target = await requiredRequestTarget(input, sender);
      return ok(await proposeBrowserTransformProfile(
        target,
        input.candidateId,
        input.callableId,
        input.inputPaths,
        input.name,
      ));
    }
    case 'analysis.profile.validate': {
      const input = request.payload;
      const target = await requiredRequestTarget(input, sender);
      const result = await validateInferredBrowserTransformProfile(
        target,
        input.candidateId,
        input.callableId,
        input.packet,
        input.inputPaths,
        input.name,
        input.observed,
        input.comparisonMode,
      );
      void appendAuditEvent({
        category: 'capability',
        action: 'analysis.profile.validate',
        outcome: result.valid ? 'success' : 'denied',
        targetTabId: target.tabId,
        summary: result.proofLevel,
      });
      return ok(result);
    }
    case 'analysis.profile.validation.latest': return ok(
      await latestBrowserTransformValidation(
        await requiredRequestTarget(request.payload, sender),
      ),
    );
    case 'transform.profile.list': {
      const input = request.payload;
      const target = input.tabId ? await requiredRequestTarget(input, sender) : undefined;
      return ok(await listBrowserTransformProfiles(
        target ? { tabId: target.tabId, frameId: target.frameId } : undefined,
      ));
    }
    case 'transform.profile.save': {
      const profile = await saveBrowserTransformProfile(request.payload);
      void appendAuditEvent({
        category: 'capability',
        action: 'transform.profile.save',
        outcome: 'success',
        targetTabId: profile.target.tabId,
        summary: profile.name,
      });
      return ok(profile);
    }
    case 'transform.profile.delete': return ok(
      await deleteBrowserTransformProfile(request.payload.id),
    );
    case 'transform.recovery.get': return ok(
      await getBrowserTransformRecovery(request.payload.id),
    );
    case 'transform.recovery.start': {
      const status = await startBrowserTransformRecovery(request.payload.id);
      void appendAuditEvent({
        category: 'capability',
        action: 'transform.recovery.start',
        outcome: 'success',
        targetTabId: status.target.tabId,
        summary: '等待一次真实业务操作',
      });
      return ok(status);
    }
    case 'transform.recovery.capture': {
      const input = request.payload;
      const target = await requiredDebuggerTarget(input, sender);
      const recovery = await captureBrowserTransformRecovery(
        input.id,
        target,
        input.callFrameId,
        input.strategy,
      );
      void appendAuditEvent({
        category: 'capability',
        action: 'transform.recovery.capture',
        outcome: 'success',
        targetTabId: target.tabId,
        summary: recovery.binding.name,
      });
      return ok(recovery);
    }
    case 'transform.recovery.validate': {
      const result = await validateBrowserTransformRecovery(
        request.payload.id,
        request.payload.packet,
      );
      void appendAuditEvent({
        category: 'capability',
        action: 'transform.recovery.validate',
        outcome: 'success',
        durationMs: result.execution.durationMs,
        summary: result.recovery.validation?.proofLevel,
      });
      return ok(result);
    }
    case 'transform.recovery.confirm': {
      const profile = await confirmBrowserTransformRecovery(
        request.payload.id,
        request.payload.validationId,
      );
      void appendAuditEvent({
        category: 'capability',
        action: 'transform.recovery.confirm',
        outcome: 'success',
        targetTabId: profile.target.tabId,
        summary: profile.name,
      });
      return ok(profile);
    }
    case 'transform.recovery.reset': return ok(
      await resetBrowserTransformRecovery(request.payload.id),
    );
    case 'transform.execute': {
      const result = await executeBrowserTransform(request.payload);
      void appendAuditEvent({
        category: 'capability',
        action: `transform.${result.direction}`,
        outcome: 'success',
        durationMs: result.durationMs,
        summary: `${result.nodeDurations.length} 个 Pipeline 节点`,
      });
      return ok(result);
    }
    default: return undefined;
  }
};
