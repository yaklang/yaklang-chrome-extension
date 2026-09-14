const MAX_BROWSER_TIMER_MS = 0x7fffffff;

export function recordingExpiryDelay(expiresAt: number | undefined, now = Date.now()): number | undefined {
  if (expiresAt === undefined) return undefined;
  const delay = expiresAt - now;
  if (delay <= 0) return 0;
  return delay <= MAX_BROWSER_TIMER_MS ? delay : undefined;
}
