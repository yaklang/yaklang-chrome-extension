import type { ExtensionResponse } from '@/types/messages';
import { errorCode, ExtensionError } from '@/shared/errors';

export function ok<T>(data?: T): ExtensionResponse<T> {
  return { ok: true, data };
}

export function fail(error: unknown): ExtensionResponse {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    errorCode: errorCode(error),
    errorData: error instanceof ExtensionError ? error.details : undefined,
  };
}
