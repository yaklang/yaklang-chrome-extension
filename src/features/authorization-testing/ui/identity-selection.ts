export interface AuthorizationIdentityTabSelection {
  leftTabId?: number;
  rightTabId?: number;
}

export interface NormalizeAuthorizationIdentityTabSelectionInput
  extends AuthorizationIdentityTabSelection {
  eligibleTabIds: readonly number[];
  activeTabId?: number;
}

export interface AuthorizationIdentityOptionConflictInput {
  candidateTabId: number;
  candidateIsolationContextId?: string;
  otherTabId?: number;
  otherIsolationContextId?: string;
  otherLabel: string;
}

export function authorizationIdentityOptionDisabledReason({
  candidateTabId,
  candidateIsolationContextId,
  otherTabId,
  otherIsolationContextId,
  otherLabel,
}: AuthorizationIdentityOptionConflictInput): string | undefined {
  if (otherTabId !== undefined && candidateTabId === otherTabId) {
    return `已用于${otherLabel}`;
  }
  if (
    candidateIsolationContextId
    && otherIsolationContextId
    && candidateIsolationContextId === otherIsolationContextId
  ) {
    return `与${otherLabel} 共享登录态`;
  }
  return undefined;
}

export function normalizeAuthorizationIdentityTabSelection({
  eligibleTabIds,
  activeTabId,
  leftTabId,
  rightTabId,
}: NormalizeAuthorizationIdentityTabSelectionInput): AuthorizationIdentityTabSelection {
  const available = new Set(
    eligibleTabIds.filter((tabId) => Number.isSafeInteger(tabId) && tabId > 0),
  );
  const existing = (tabId?: number): number | undefined => (
    tabId !== undefined && available.has(tabId) ? tabId : undefined
  );

  let left = existing(leftTabId);
  let right = existing(rightTabId);

  if (left !== undefined && left === right) right = undefined;

  if (left === undefined) {
    left = existing(activeTabId) ?? right ?? eligibleTabIds.find((tabId) => available.has(tabId));
    if (left === right) right = undefined;
  }

  return {
    leftTabId: left,
    rightTabId: right,
  };
}
