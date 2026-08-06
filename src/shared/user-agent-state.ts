import type { UserAgentAssignment, UserAgentProfile } from '@/types/models';

export const MAX_CUSTOM_USER_AGENT_PROFILES = 256;
export const MAX_USER_AGENT_ASSIGNMENTS = 5_000;
export const BUILTIN_USER_AGENT_PROFILE_IDS = [
  'chrome-windows',
  'chrome-macos',
  'edge-windows',
  'firefox-windows',
  'firefox-linux',
  'safari-macos',
  'safari-iphone',
  'safari-ipad',
  'chrome-android',
  'googlebot',
] as const;

const BUILTIN_IDS = new Set<string>(BUILTIN_USER_AGENT_PROFILE_IDS);
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface UserAgentStateSlice {
  customUserAgentProfiles: UserAgentProfile[];
  userAgentAssignments: UserAgentAssignment[];
}

export function normalizeUserAgentValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('User-Agent 不能为空');
  if (normalized.length > 1_024) throw new Error('User-Agent 不能超过 1024 个字符');
  if (/\r|\n/.test(normalized)) throw new Error('User-Agent 不能包含换行符');
  return normalized;
}

export function normalizeUserAgentHostname(value: string): string {
  const candidate = value.trim().toLowerCase().replace(/\.$/, '');
  if (!candidate || candidate.length > 253 || /[\s/@?#]/.test(candidate)) {
    throw new Error('User-Agent 站点域名无效');
  }
  const parsed = new URL(`https://${candidate}/`);
  if (parsed.port || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error('User-Agent 站点域名无效');
  }
  return parsed.hostname.toLowerCase();
}

function normalizedCustomProfile(value: unknown): UserAgentProfile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<UserAgentProfile>;
  if (
    typeof input.id !== 'string' || !ID_PATTERN.test(input.id) || BUILTIN_IDS.has(input.id)
    || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100
    || typeof input.userAgent !== 'string'
  ) return undefined;
  try {
    return {
      id: input.id,
      name: input.name.trim(),
      userAgent: normalizeUserAgentValue(input.userAgent),
      category: 'custom',
      builtin: false,
    };
  } catch {
    return undefined;
  }
}

function normalizedAssignment(value: unknown): UserAgentAssignment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<UserAgentAssignment>;
  if (
    typeof input.id !== 'string' || !ID_PATTERN.test(input.id)
    || typeof input.hostname !== 'string'
    || typeof input.profileId !== 'string' || !ID_PATTERN.test(input.profileId)
    || !Number.isFinite(input.createdAt) || input.createdAt! < 0
    || !Number.isFinite(input.updatedAt) || input.updatedAt! < input.createdAt!
  ) return undefined;
  try {
    return {
      id: input.id,
      hostname: normalizeUserAgentHostname(input.hostname),
      profileId: input.profileId,
      createdAt: input.createdAt!,
      updatedAt: input.updatedAt!,
    };
  } catch {
    return undefined;
  }
}

export function normalizeStoredUserAgentState(
  customProfiles: unknown,
  assignments: unknown,
): UserAgentStateSlice {
  const profilesById = new Map<string, UserAgentProfile>();
  const profileInputs = Array.isArray(customProfiles)
    ? customProfiles.slice(0, MAX_CUSTOM_USER_AGENT_PROFILES * 2)
    : [];
  for (const input of profileInputs) {
    const profile = normalizedCustomProfile(input);
    if (profile) profilesById.set(profile.id, profile);
  }
  const normalizedProfiles = [...profilesById.values()].slice(-MAX_CUSTOM_USER_AGENT_PROFILES);
  const validProfileIds = new Set<string>([
    ...BUILTIN_USER_AGENT_PROFILE_IDS,
    ...normalizedProfiles.map((profile) => profile.id),
  ]);

  const assignmentsByHostname = new Map<string, UserAgentAssignment>();
  const assignmentInputs = Array.isArray(assignments)
    ? assignments.slice(0, MAX_USER_AGENT_ASSIGNMENTS * 4)
    : [];
  for (const input of assignmentInputs) {
    const assignment = normalizedAssignment(input);
    if (!assignment || !validProfileIds.has(assignment.profileId)) continue;
    const previous = assignmentsByHostname.get(assignment.hostname);
    if (!previous || previous.updatedAt <= assignment.updatedAt) {
      assignmentsByHostname.set(assignment.hostname, assignment);
    }
  }
  let normalizedAssignments = [...assignmentsByHostname.values()];
  if (normalizedAssignments.length > MAX_USER_AGENT_ASSIGNMENTS) {
    normalizedAssignments = normalizedAssignments
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_USER_AGENT_ASSIGNMENTS)
      .sort((left, right) => left.createdAt - right.createdAt || left.hostname.localeCompare(right.hostname));
  }

  return {
    customUserAgentProfiles: normalizedProfiles,
    userAgentAssignments: normalizedAssignments,
  };
}

export function assertUserAgentState(input: UserAgentStateSlice): void {
  if (input.customUserAgentProfiles.length > MAX_CUSTOM_USER_AGENT_PROFILES) {
    throw new Error(`自定义 User-Agent 预设不能超过 ${MAX_CUSTOM_USER_AGENT_PROFILES} 个`);
  }
  if (input.userAgentAssignments.length > MAX_USER_AGENT_ASSIGNMENTS) {
    throw new Error(`User-Agent 站点绑定不能超过 ${MAX_USER_AGENT_ASSIGNMENTS} 条`);
  }
  const normalized = normalizeStoredUserAgentState(
    input.customUserAgentProfiles,
    input.userAgentAssignments,
  );
  if (
    normalized.customUserAgentProfiles.length !== input.customUserAgentProfiles.length
    || normalized.userAgentAssignments.length !== input.userAgentAssignments.length
  ) {
    throw new Error('User-Agent 设置包含重复、失效或引用不存在的数据');
  }
  for (let index = 0; index < input.customUserAgentProfiles.length; index += 1) {
    if (JSON.stringify(normalized.customUserAgentProfiles[index]) !== JSON.stringify(input.customUserAgentProfiles[index])) {
      throw new Error('自定义 User-Agent 预设格式无效');
    }
  }
  for (let index = 0; index < input.userAgentAssignments.length; index += 1) {
    if (JSON.stringify(normalized.userAgentAssignments[index]) !== JSON.stringify(input.userAgentAssignments[index])) {
      throw new Error('User-Agent 站点绑定格式无效');
    }
  }
}

export function userAgentStateFingerprint(input: UserAgentStateSlice): string {
  return JSON.stringify({
    profiles: input.customUserAgentProfiles,
    assignments: input.userAgentAssignments,
  });
}
