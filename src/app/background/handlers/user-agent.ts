import type { BackgroundRequestHandler } from '../router';
import { ok } from '../response';
import { getState } from '@/platform/storage/state';
import { resolveUserAgent, userAgentHostname } from '@/features/identity/user-agent';
import {
  applyUserAgentToSite,
  deleteUserAgentProfile,
  resetUserAgentForSite,
  saveUserAgentProfile,
} from '@/features/identity/user-agent-service';
import { getUserAgentProfiles } from '@/features/identity/user-agent-profiles';
import { appendAuditEvent } from '@/features/diagnostics/audit';

export const handleUserAgentRequest: BackgroundRequestHandler = async (request) => {
  switch (request.action) {
    case 'ua.catalog': {
      const state = await getState();
      return ok(getUserAgentProfiles(state.customUserAgentProfiles));
    }
    case 'ua.resolve': {
      const state = await getState();
      return ok(resolveUserAgent(
        request.payload.url,
        state.userAgentAssignments,
        state.customUserAgentProfiles,
      ));
    }
    case 'ua.profile.save': {
      const { profile } = await saveUserAgentProfile(request.payload);
      void appendAuditEvent({
        category: 'settings',
        action: 'ua.profile.save',
        outcome: 'success',
        summary: profile.name,
      });
      return ok(profile);
    }
    case 'ua.profile.delete': {
      const state = await deleteUserAgentProfile(request.payload.id);
      void appendAuditEvent({
        category: 'settings', action: 'ua.profile.delete', outcome: 'success',
      });
      return ok(state);
    }
    case 'ua.site.apply': {
      const input = request.payload;
      const hostname = userAgentHostname(input.url);
      const state = await applyUserAgentToSite(input.url, input.profileId);
      const profile = getUserAgentProfiles(state.customUserAgentProfiles)
        .find((item) => item.id === input.profileId)!;
      void appendAuditEvent({
        category: 'settings',
        action: 'ua.site.apply',
        outcome: 'success',
        summary: `${hostname} · ${profile.name}`,
      });
      return ok(state);
    }
    case 'ua.site.reset': {
      const hostname = userAgentHostname(request.payload.url);
      const state = await resetUserAgentForSite(request.payload.url);
      void appendAuditEvent({
        category: 'settings',
        action: 'ua.site.reset',
        outcome: 'success',
        summary: hostname,
      });
      return ok(state);
    }
    default: return undefined;
  }
};
