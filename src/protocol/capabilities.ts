import type { CapabilityScope } from '@/types/models';

export const BRIDGE_CAPABILITIES = [
  'system.ping',
  'browser.tabs',
  'browser.frames',
  'browser.context',
  'browser.node.inspect',
  'browser.node.action',
  'browser.cookies',
  'browser.takeover',
  'browser.handoff.request',
  'browser.handoff.status',
  'browser.network.start',
  'browser.network.status',
  'browser.network.list',
  'browser.network.clear',
  'browser.network.stop',
  'browser.network.export',
  'browser.network.poc',
  'browser.network.analysis',
  'browser.observe.start',
  'browser.observe.status',
  'browser.observe.list',
  'browser.observe.clear',
  'browser.observe.stop',
  ...(!(import.meta.env.FIREFOX && import.meta.env.MODE === 'store') ? ['browser.invoke', 'browser.eval'] : []),
  'proxy.list',
  'proxy.switch',
] as const;

export const READ_CAPABILITY_SCOPES: CapabilityScope[] = [
  'browser.tabs.read',
  'browser.dom.read',
  'browser.storage.read',
  'browser.cookies.read',
  'browser.network.read',
  'browser.observation.read',
];

export const CONTROL_CAPABILITY_SCOPES: CapabilityScope[] = [
  ...READ_CAPABILITY_SCOPES,
  'browser.dom.write',
  'browser.tab.activate',
  ...(!(import.meta.env.FIREFOX && import.meta.env.MODE === 'store')
    ? ['browser.page.invoke' as const, 'browser.page.eval.expression' as const]
    : []),
  'browser.human.takeover',
  'browser.network.capture',
  'browser.network.sensitive.read',
  'browser.observation.control',
  'browser.observation.sensitive.read',
  'browser.proxy.read',
  'browser.proxy.write',
];

export const CAPABILITY_LABELS: Record<CapabilityScope, string> = {
  'browser.tabs.read': '标签页列表',
  'browser.dom.read': '页面 DOM',
  'browser.dom.write': '操作页面元素',
  'browser.storage.read': '页面 Storage',
  'browser.cookies.read': 'Cookie',
  'browser.tab.activate': '切到前台',
  'browser.page.invoke': '调用页面函数',
  'browser.page.eval.expression': '执行页面表达式',
  'browser.page.eval.program': '执行页面程序',
  'browser.human.takeover': '人工接管',
  'browser.network.read': '读取网络摘要',
  'browser.network.capture': '控制网络捕获',
  'browser.network.sensitive.read': '读取请求头与请求体',
  'browser.observation.read': '读取页面行为观测',
  'browser.observation.control': '控制页面行为观测',
  'browser.observation.sensitive.read': '读取观测值预览',
  'browser.proxy.read': '读取代理',
  'browser.proxy.write': '切换代理',
};

export function isControlScopeSet(scopes: readonly CapabilityScope[]): boolean {
  return scopes.some((scope) => !READ_CAPABILITY_SCOPES.includes(scope));
}
