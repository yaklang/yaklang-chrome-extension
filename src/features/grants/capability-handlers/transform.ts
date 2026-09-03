import type {
  BrowserTransformExecuteInput,
  BrowserTransformPacket,
  BrowserTransformProfileInput,
} from '@/types/models';
import { browser } from 'wxt/browser';
import type { CapabilityDomainHandler } from '../capability-context';
import { allowedTarget, requireScope } from '../capability-context';
import {
  captureBrowserTransformRecovery,
  confirmBrowserTransformRecovery,
  deleteBrowserTransformProfile,
  executeBrowserTransform,
  getBrowserTransformProfile,
  getBrowserTransformRecovery,
  listBrowserTransformProfiles,
  resetBrowserTransformRecovery,
  saveBrowserTransformProfile,
  startBrowserTransformRecovery,
  validateBrowserTransformRecovery,
} from '@/features/browser-transform/service';
import {
  compareBrowserPackets,
  latestBrowserTransformValidation,
  proposeBrowserTransformProfile,
  validateInferredBrowserTransformProfile,
} from '@/features/browser-analysis/service';
import { ExtensionError } from '@/shared/errors';
import { TRANSFORM_CAPABILITY_DOMAIN } from '../capability-domains';

export const transformCapabilityHandler: CapabilityDomainHandler = {
  ...TRANSFORM_CAPABILITY_DOMAIN,
  async handle({ method, input, grant }) {
    if (method === 'browser.packet.compare') {
      await allowedTarget(grant, input);
      return compareBrowserPackets(
        input.actual as BrowserTransformPacket,
        input.expected as BrowserTransformPacket,
        input.mode === 'exact' ? 'exact' : 'structure',
      );
    }
    if (method === 'browser.profile.propose') {
      requireScope(grant, 'browser.recording.read');
      const target = await allowedTarget(grant, input);
      return proposeBrowserTransformProfile(
        target,
        String(input.candidateId || ''),
        String(input.callableId || ''),
        Array.isArray(input.inputPaths) ? input.inputPaths.map(String) : undefined,
        typeof input.name === 'string' ? input.name : undefined,
      );
    }
    if (method === 'browser.profile.validation.latest') {
      return latestBrowserTransformValidation(await allowedTarget(grant, input));
    }
    if (method === 'browser.profile.validate') {
      requireScope(grant, 'browser.recording.read');
      const target = await allowedTarget(grant, input);
      return validateInferredBrowserTransformProfile(
        target,
        String(input.candidateId || ''),
        String(input.callableId || ''),
        input.packet as BrowserTransformPacket,
        Array.isArray(input.inputPaths) ? input.inputPaths.map(String) : undefined,
        typeof input.name === 'string' ? input.name : undefined,
        input.observed as BrowserTransformPacket | undefined,
        input.comparisonMode === 'exact' ? 'exact' : 'structure',
      );
    }

    if (method.startsWith('browser.transform.recovery.')) {
      const profile = await getBrowserTransformProfile(String(input.id || ''));
      const resolveInPage = method !== 'browser.transform.recovery.capture'
        && method !== 'browser.transform.recovery.reset';
      const target = await allowedTarget(grant, {
        tabId: profile.target.tabId,
        frameId: profile.target.frameId,
        ...(typeof input.documentId === 'string' ? { documentId: input.documentId } : {}),
      }, resolveInPage);
      const owner = { kind: 'grant' as const, grantId: grant.id, expiresAt: grant.expiresAt };
      if (method === 'browser.transform.recovery.get') {
        return getBrowserTransformRecovery(profile.id);
      }
      if (method === 'browser.transform.recovery.start') {
        requireScope(grant, 'browser.debugger.control');
        return startBrowserTransformRecovery(profile.id, owner);
      }
      if (method === 'browser.transform.recovery.capture') {
        requireScope(grant, 'browser.debugger.control');
        requireScope(grant, 'browser.callable.execute');
        return captureBrowserTransformRecovery(
          profile.id,
          target,
          String(input.callFrameId || ''),
          input.strategy === 'request-transaction'
            ? 'request-transaction'
            : 'selected-frame',
          owner,
        );
      }
      if (method === 'browser.transform.recovery.validate') {
        return validateBrowserTransformRecovery(
          profile.id,
          input.packet as BrowserTransformPacket,
        );
      }
      if (method === 'browser.transform.recovery.confirm') {
        return confirmBrowserTransformRecovery(profile.id, String(input.validationId || ''));
      }
      return resetBrowserTransformRecovery(profile.id, owner);
    }

    if (method === 'browser.transform.profile.list') {
      const profiles = await listBrowserTransformProfiles();
      const visible = await Promise.all(profiles.map(async (profile) => {
        try {
          await allowedTarget(grant, profile.target);
          return profile;
        } catch {
          return undefined;
        }
      }));
      return visible.filter(Boolean);
    }
    if (method === 'browser.transform.profile.save') {
      const profileInput = input as unknown as BrowserTransformProfileInput;
      const target = await allowedTarget(grant, profileInput.target);
      const frame = await browser.webNavigation.getFrame(target);
      if (!frame?.url || profileInput.origin !== new URL(frame.url).origin) {
        throw new ExtensionError('target_denied', '转换配置来源与当前页面不一致');
      }
      return saveBrowserTransformProfile({ ...profileInput, target });
    }
    if (method === 'browser.transform.profile.delete') {
      const profile = await getBrowserTransformProfile(String(input.id || ''));
      await allowedTarget(grant, profile.target);
      return deleteBrowserTransformProfile(profile.id);
    }
    const executeInput = input as unknown as BrowserTransformExecuteInput;
    const profile = await getBrowserTransformProfile(executeInput.profileId);
    await allowedTarget(grant, profile.target);
    return executeBrowserTransform(executeInput);
  },
};
