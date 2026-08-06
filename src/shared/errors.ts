export class ExtensionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ExtensionError';
  }
}

export function errorCode(error: unknown): string {
  return error instanceof ExtensionError ? error.code : 'request_failed';
}

export function isDeniedErrorCode(code: string): boolean {
  return ['permission_denied', 'grant_expired', 'target_denied', 'origin_changed', 'stale_document'].includes(code);
}
