import type {
  BrowserRequestAnalysisBundle,
  YakPocGenerateResult,
} from '@/types/models';
import type { CapabilityDomainHandler } from '../capability-context';
import { allowedTarget, requireScope } from '../capability-context';
import {
  clearNetworkRequests,
  exportNetworkRequest,
  listNetworkRequests,
  networkCaptureStatus,
  redactNetworkRequests,
  startNetworkCapture,
  stopNetworkCapture,
} from '@/features/network-capture/service';
import { capturedRequestEnginePayload } from '@/features/network-capture/workflows';
import { ExtensionError } from '@/shared/errors';
import { NETWORK_CAPABILITY_DOMAIN } from '../capability-domains';

export const networkCapabilityHandler: CapabilityDomainHandler = {
  ...NETWORK_CAPABILITY_DOMAIN,
  async handle({ method, input, grant, requestEngine }) {
    const target = await allowedTarget(grant, input);
    if (method === 'browser.network.start') {
      if (input.captureHeaders === true || input.captureBody === true) {
        requireScope(grant, 'browser.network.sensitive.read');
      }
      return startNetworkCapture(target, {
        captureHeaders: input.captureHeaders === true,
        captureBody: input.captureBody === true,
        maxEntries: typeof input.maxEntries === 'number' ? input.maxEntries : undefined,
        maxBodyBytes: typeof input.maxBodyBytes === 'number' ? input.maxBodyBytes : undefined,
      }, { kind: 'grant', grantId: grant.id, expiresAt: grant.expiresAt });
    }
    if (method === 'browser.network.status') return networkCaptureStatus(target);
    if (method === 'browser.network.list') {
      const records = await listNetworkRequests(
        target,
        typeof input.limit === 'number' ? input.limit : 100,
      );
      return grant.scopes.includes('browser.network.sensitive.read')
        ? records
        : redactNetworkRequests(records);
    }
    if (method === 'browser.network.clear') return clearNetworkRequests(target);
    if (method === 'browser.network.stop') return stopNetworkCapture(target);
    if (method === 'browser.network.export') {
      return exportNetworkRequest(target, String(input.id));
    }
    if (!requestEngine) {
      throw new ExtensionError('bridge_disconnected', 'Yak 引擎请求通道不可用');
    }
    if (method === 'browser.network.poc') {
      return requestEngine<YakPocGenerateResult>(
        'yakit.poc.generate',
        await capturedRequestEnginePayload(target, String(input.id), false),
      );
    }
    return requestEngine<BrowserRequestAnalysisBundle>(
      'yakit.browser_request.prepare_analysis',
      await capturedRequestEnginePayload(
        target,
        String(input.id),
        grant.scopes.includes('browser.recording.read'),
      ),
    );
  },
};
