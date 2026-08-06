import type {
  BrowserAuthorizationBaseline,
  BrowserTransformProfile,
} from '@/types/models';
import { ExtensionError } from '@/shared/errors';

const DYNAMIC_FIELD_CATEGORIES = new Set(['signature', 'nonce', 'timestamp', 'csrf']);

function normalizedTransformDestination(destination: string): string {
  const trimmed = destination.trim();
  if (trimmed.toLowerCase().startsWith('header.')) {
    return `header.${trimmed.slice(7).trim().toLowerCase()}`;
  }
  return trimmed;
}

export function authorizationDynamicTransformDestinations(
  baseline: BrowserAuthorizationBaseline,
  profile: BrowserTransformProfile,
): string[] {
  if (!profile.enabled || !profile.request.enabled) {
    throw new ExtensionError('authorization_transform_unavailable', '所选明文网关未启用请求转换');
  }
  if (profile.recovery && profile.recovery.state !== 'ready') {
    throw new ExtensionError('authorization_transform_stale', '所选明文网关正在等待文档恢复或重新验证');
  }
  const dynamicFields = new Map(
    baseline.request.fields
      .filter((field) => DYNAMIC_FIELD_CATEGORIES.has(field.category))
      .map((field) => [
        normalizedTransformDestination(field.path),
        field,
      ]),
  );
  const required = [...dynamicFields.keys()].filter((path) => {
    const field = dynamicFields.get(path);
    return field?.category === 'signature'
      || field?.category === 'nonce'
      || field?.category === 'timestamp';
  });
  if (!required.length) {
    throw new ExtensionError('authorization_transform_unnecessary', '当前授权基线没有需要动态重算的签名、Nonce 或时间字段');
  }
  const destinations = profile.request.nodes
    .filter((node) => node.kind === 'output.write')
    .map((node) => normalizedTransformDestination(node.destination));
  if (!destinations.length) {
    throw new ExtensionError('authorization_transform_invalid', '所选明文网关没有请求输出节点');
  }
  for (const destination of destinations) {
    if (
      destination === 'body'
      || destination.startsWith('body.')
      || (!destination.startsWith('header.') && !destination.startsWith('query.'))
    ) {
      throw new ExtensionError(
        'authorization_transform_unsupported',
        '首批授权动态重算只接受 Header/Query 签名字段；Body 加密 envelope 需要逻辑明文绑定',
      );
    }
    if (!dynamicFields.has(destination)) {
      throw new ExtensionError(
        'authorization_transform_invalid',
        `明文网关输出未对应基线中的动态字段: ${destination}`,
      );
    }
  }
  const output = [...new Set(destinations)];
  const missing = required.find((path) => !output.includes(path));
  if (missing) {
    throw new ExtensionError(
      'authorization_transform_incomplete',
      `明文网关尚未覆盖动态字段: ${missing}`,
    );
  }
  return output.sort();
}
