export const PAGE_RECORDER_BRIDGE_CHANNEL = 'yakit-page-recorder-bridge-v1' as const;
export const PAGE_RECORDER_REQUEST_EVENT = 'yakit:page-recorder:request:v1' as const;
export const PAGE_RECORDER_RESPONSE_EVENT = 'yakit:page-recorder:response:v1' as const;

export type PageRecorderBridgeCommand =
  | 'start'
  | 'resume'
  | 'navigation.record'
  | 'stop'
  | 'clear'
  | 'status'
  | 'get'
  | 'callable.create'
  | 'callable.list'
  | 'callable.execute'
  | 'callable.delete'
  | 'transform.execute';

export interface PageRecorderBridgeRequest {
  id: string;
  command: PageRecorderBridgeCommand;
  input: Record<string, unknown>;
}

export type PageRecorderBridgeResponse = {
  id: string;
  ok: true;
  result: unknown;
} | {
  id: string;
  ok: false;
  error: string;
};

export interface PageRecorderRuntimeMessage {
  channel: typeof PAGE_RECORDER_BRIDGE_CHANNEL;
  command: PageRecorderBridgeCommand;
  input: Record<string, unknown>;
}
