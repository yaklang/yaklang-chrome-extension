import type { BrowserDeepCaptureMatcher, BrowserProfileInferenceCandidate, BrowserRecordingEvent } from '@/types/models';
import { cryptoDeepCaptureMatcher } from '@/features/browser-crypto/model';

export function eventMatcher(event?: BrowserRecordingEvent, candidate?: BrowserProfileInferenceCandidate): BrowserDeepCaptureMatcher | undefined {
  if (!event) return undefined;
  const frameHints = candidate?.capturePlan?.frameHints;
  const crypto = cryptoDeepCaptureMatcher(event);
  if (crypto) return { ...crypto, frameHints };
  if (['fetch', 'xhr', 'form'].includes(event.kind) && event.url) return { kind: 'request', urlPattern: event.url, frameHints };
  if (['beacon', 'worker', 'message'].includes(event.kind) && event.wrapperHandleId) return {
    kind: 'boundary', eventKind: event.kind as 'beacon' | 'worker' | 'message', operation: event.operation,
    wrapperHandleId: event.wrapperHandleId, scriptUrl: event.scriptUrl, frameHints,
  };
  return undefined;
}
