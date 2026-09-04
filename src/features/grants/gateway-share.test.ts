import { describe, expect, it } from 'vitest';
import { CONTROL_CAPABILITY_SCOPES } from '@/protocol/capabilities';
import type { ActiveTabInfo, ExtensionState } from '@/types/models';
import { gatewayShareActive, gatewayShareGrantInput } from './gateway-share';

const NOW = 1_000_000;

const tab: ActiveTabInfo = {
  id: 7,
  windowId: 1,
  title: 'Login',
  url: 'https://app.example.test/login',
  incognito: false,
};

function state(): ExtensionState {
  return {
    version: 7,
  } as ExtensionState;
}

describe('gateway quick share', () => {
  it('creates a 30 minute control grant for the current main frame', () => {
    const input = gatewayShareGrantInput(state(), tab, NOW);

    expect(input.targets).toEqual([{ tabId: 7, frameId: 0 }]);
    expect(input.durationMinutes).toBe(30);
    expect(input.scopes).toEqual(expect.arrayContaining(CONTROL_CAPABILITY_SCOPES));
  });

  it('preserves an active session while adding the current tab and gateway capabilities', () => {
    const current = state();
    current.activeGrant = {
      id: 'grant',
      taskId: 'task',
      createdAt: NOW - 10_000,
      expiresAt: NOW + 60 * 60_000,
      scopes: ['browser.tabs.read'],
      targets: [{
        tabId: 3,
        frameId: 0,
        documentId: 'document-a',
        isolationContextId: 'profile:default',
        origin: 'https://other.example.test',
        grantedUrl: 'https://other.example.test/',
        title: 'Other',
      }],
    };

    const input = gatewayShareGrantInput(current, tab, NOW);

    expect(input.targets).toEqual([
      { tabId: 3, frameId: 0 },
      { tabId: 7, frameId: 0 },
    ]);
    expect(input.durationMinutes).toBe(60);
    expect(input.taskId).toBe('task');
    expect(current.activeGrant.scopes).toEqual(['browser.tabs.read']);
  });

  it('only reports ready when the tab, origin, lifetime and control scopes match', () => {
    const current = state();
    const input = gatewayShareGrantInput(current, tab, NOW);
    const grant = {
      id: 'grant',
      taskId: 'task',
      createdAt: NOW,
      expiresAt: NOW + 30 * 60_000,
      scopes: input.scopes,
      targets: [{
        tabId: tab.id,
        frameId: 0,
        documentId: 'document',
        isolationContextId: 'profile:default',
        origin: 'https://app.example.test',
        grantedUrl: tab.url,
        title: tab.title,
      }],
    };

    expect(gatewayShareActive(grant, tab, NOW)).toBe(true);
    expect(gatewayShareActive({ ...grant, expiresAt: NOW }, tab, NOW)).toBe(false);
    expect(gatewayShareActive({ ...grant, scopes: ['browser.tabs.read'] }, tab, NOW)).toBe(false);
    expect(gatewayShareActive(grant, { ...tab, url: 'https://elsewhere.example.test/' }, NOW)).toBe(false);
  });

});
