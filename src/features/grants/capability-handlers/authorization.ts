import type { BrowserAuthorizationResourceSelector } from '@/types/models';
import type { CapabilityDomainHandler } from '../capability-context';
import { allowedTarget, requireScope } from '../capability-context';
import {
  captureAuthContextHandle,
  getAuthContextHandle,
} from '@/features/authorization-testing/auth-context';
import {
  captureAuthContextAttestation,
  getAuthContextAttestation,
} from '@/features/authorization-testing/auth-attestation';
import {
  bindAuthorizationBaselineLogicalRequest,
  captureAuthorizationBaseline,
  compileAuthorizationBaseline,
  compileAuthorizationBaselinePacket,
  compileAuthorizationBaselineWithTransform,
  getAuthorizationBaseline,
  inspectAuthorizationBaselineTransform,
  listAuthorizationBaselineCandidates,
  readAuthorizationBaselineResource,
} from '@/features/authorization-testing/baseline';
import { AUTHORIZATION_CAPABILITY_DOMAIN } from '../capability-domains';

function requireAuthorizationContextScopes(
  grant: Parameters<typeof requireScope>[0],
): void {
  requireScope(grant, 'browser.cookies.read');
  requireScope(grant, 'browser.storage.read');
}

function requireAuthorizationBaselineScopes(
  grant: Parameters<typeof requireScope>[0],
): void {
  requireScope(grant, 'browser.isolation.read');
  requireAuthorizationContextScopes(grant);
}

export const authorizationCapabilityHandler: CapabilityDomainHandler = {
  ...AUTHORIZATION_CAPABILITY_DOMAIN,
  async handle({ method, input, grant }) {
    if (method === 'browser.authorization.context.capture') {
      requireAuthorizationContextScopes(grant);
      return captureAuthContextHandle({
        slotId: input.slotId === 'right' ? 'right' : 'left',
        accountLabel: typeof input.accountLabel === 'string' ? input.accountLabel : undefined,
        isolationProofId: String(input.isolationProofId || ''),
        target: await allowedTarget(grant, input),
        grantId: grant.id,
        grantExpiresAt: grant.expiresAt,
      });
    }
    if (method === 'browser.authorization.context.get') {
      requireAuthorizationContextScopes(grant);
      return getAuthContextHandle(String(input.id || ''), grant.id);
    }
    if (method === 'browser.authorization.context.attest') {
      requireAuthorizationContextScopes(grant);
      return captureAuthContextAttestation({
        target: await allowedTarget(grant, input),
        grantId: grant.id,
        grantExpiresAt: grant.expiresAt,
      });
    }
    if (method === 'browser.authorization.context.attestation.get') {
      requireAuthorizationContextScopes(grant);
      return getAuthContextAttestation(String(input.id || ''), grant.id);
    }

    requireAuthorizationBaselineScopes(grant);
    if (method === 'browser.authorization.baseline.capture') {
      return captureAuthorizationBaseline({
        target: await allowedTarget(grant, input),
        grantId: grant.id,
        authContextKind: input.authContextKind === 'attestation' ? 'attestation' : 'handle',
        authContextId: String(input.authContextId || ''),
        networkRequestId: String(input.networkRequestId || ''),
        comparisonKey: String(input.comparisonKey || ''),
      });
    }
    if (method === 'browser.authorization.baseline.candidates') {
      return listAuthorizationBaselineCandidates({
        target: await allowedTarget(grant, input),
        grantId: grant.id,
        authContextKind: input.authContextKind === 'attestation' ? 'attestation' : 'handle',
        authContextId: String(input.authContextId || ''),
        limit: typeof input.limit === 'number' ? input.limit : 100,
      });
    }
    if (method === 'browser.authorization.baseline.get') {
      return getAuthorizationBaseline(String(input.id || ''), grant.id);
    }
    if (method === 'browser.authorization.baseline.logical.bind') {
      requireScope(grant, 'browser.network.sensitive.read');
      requireScope(grant, 'browser.transform.execute');
      return bindAuthorizationBaselineLogicalRequest({
        id: String(input.id || ''),
        grantId: grant.id,
        profileId: String(input.profileId || ''),
        comparisonKey: String(input.comparisonKey || ''),
      });
    }
    if (method === 'browser.authorization.baseline.resource.get') {
      return readAuthorizationBaselineResource({
        id: String(input.id || ''),
        grantId: grant.id,
        selector: input.selector as BrowserAuthorizationResourceSelector,
      });
    }
    if (method === 'browser.authorization.baseline.compile') {
      requireScope(grant, 'browser.network.sensitive.read');
      return compileAuthorizationBaseline({
        id: String(input.id || ''),
        grantId: grant.id,
        selector: input.selector as BrowserAuthorizationResourceSelector,
        replacement: input.replacement as Parameters<typeof compileAuthorizationBaseline>[0]['replacement'],
        comparisonKey: String(input.comparisonKey || ''),
      });
    }
    if (method === 'browser.authorization.baseline.packet.compile') {
      requireScope(grant, 'browser.network.replay');
      requireScope(grant, 'browser.network.sensitive.read');
      return compileAuthorizationBaselinePacket({
        id: String(input.id || ''),
        grantId: grant.id,
      });
    }
    if (method === 'browser.authorization.baseline.transform.inspect') {
      requireScope(grant, 'browser.network.sensitive.read');
      requireScope(grant, 'browser.transform.read');
      return inspectAuthorizationBaselineTransform({
        id: String(input.id || ''),
        grantId: grant.id,
        profileId: String(input.profileId || ''),
      });
    }
    if (method === 'browser.authorization.baseline.transform.compile') {
      requireScope(grant, 'browser.network.replay');
      requireScope(grant, 'browser.network.sensitive.read');
      requireScope(grant, 'browser.transform.execute');
      return compileAuthorizationBaselineWithTransform({
        id: String(input.id || ''),
        grantId: grant.id,
        selector: input.selector as BrowserAuthorizationResourceSelector,
        replacement: input.replacement as Parameters<typeof compileAuthorizationBaselineWithTransform>[0]['replacement'],
        comparisonKey: String(input.comparisonKey || ''),
        profileId: String(input.profileId || ''),
        bindingFingerprint: String(input.bindingFingerprint || ''),
      });
    }
    throw new Error(`授权能力没有实现: ${method}`);
  },
};
