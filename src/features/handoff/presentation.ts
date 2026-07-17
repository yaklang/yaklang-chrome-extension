import type { AuditEvent, HandoffReason, HumanHandoff } from '@/types/models';

export const HANDOFF_REASON_LABELS: Record<HandoffReason, string> = {
  qr_code: '需要扫码',
  mfa: '需要二次验证',
  captcha: '需要完成验证码',
  device_confirmation: '需要设备确认',
  other: '需要人工操作',
};

export const AUDIT_CATEGORY_LABELS: Record<AuditEvent['category'], string> = {
  grant: '授权',
  bridge: 'Bridge',
  capability: '能力调用',
  handoff: '人工接管',
  settings: '设置',
};

export const AUDIT_OUTCOME_LABELS: Record<AuditEvent['outcome'], string> = {
  success: '成功',
  denied: '已拒绝',
  error: '错误',
  cancelled: '已取消',
};

export function waitingHandoff(handoff?: HumanHandoff): HumanHandoff | undefined {
  return handoff?.state === 'waiting_for_user' ? handoff : undefined;
}
