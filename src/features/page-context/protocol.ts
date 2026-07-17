import type { PageEvalResult } from '@/types/models';

export const PAGE_BRIDGE_CHANNEL = 'yakit-page-bridge-v1';
export const PAGE_REQUEST_EVENT = 'yakit:page-request:v1';
export const PAGE_RESPONSE_EVENT = 'yakit:page-response:v1';

export type PageOperation =
  | { operation: 'eval'; mode: 'expression' | 'program'; code: string }
  | { operation: 'invoke'; path: string; args: unknown[] };

export type PageBridgeRequest = PageOperation & {
  id: string;
  timeoutMs: number;
};

export type PageBridgeResponse = {
  id: string;
  ok: true;
  result: PageEvalResult;
} | {
  id: string;
  ok: false;
  error: { name: string; message: string; stack?: string };
};
