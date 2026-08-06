import { describe, expect, it } from 'vitest';
import { capabilityParams } from '@/protocol/bridge';
import { capabilityDomainOwners } from './capability-domains';

describe('Grant capability handler registry', () => {
  it('assigns every negotiated capability to exactly one domain', () => {
    const methods = Object.keys(capabilityParams).filter((method) => method !== 'system.ping');
    const invalid = methods.map((method) => ({
      method,
      owners: capabilityDomainOwners(method).map((owner) => owner.id),
    })).filter((entry) => entry.owners.length !== 1);

    expect(invalid).toEqual([]);
  });

  it('does not claim undeclared methods by accident', () => {
    expect(capabilityDomainOwners('browser.unknown.future')).toEqual([]);
  });
});
