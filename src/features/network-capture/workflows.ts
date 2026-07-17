import { observationAnalysisWindow } from '@/features/page-observation/service';
import type { BrowserTarget } from '@/types/models';
import { exportNetworkRequest, listNetworkRequests } from './service';

export async function capturedRequestEnginePayload(target: BrowserTarget, id: string, includeObservations: boolean) {
  const [exported, records] = await Promise.all([
    exportNetworkRequest(target, id),
    listNetworkRequests(target, 200),
  ]);
  const record = records.find((item) => item.id === id);
  return {
    rawRequestBase64: exported.rawRequestBase64,
    isHttps: exported.isHttps,
    observations: includeObservations && record
      ? await observationAnalysisWindow(target, record.startedAt)
      : [],
  };
}
