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
  'browser.recording.start',
  'browser.recording.status',
  'browser.recording.get',
  'browser.recording.clear',
  'browser.recording.stop',
  'browser.callable.create',
  'browser.callable.list',
  'browser.callable.execute',
  'browser.callable.delete',
  ...(!import.meta.env.FIREFOX ? [
    'browser.deep_capture.start',
    'browser.deep_capture.status',
    'browser.deep_capture.keepalive',
    'browser.deep_capture.resume',
    'browser.deep_capture.detach',
    'browser.transform.profile.list',
    'browser.transform.profile.save',
    'browser.transform.profile.delete',
    'browser.transform.execute',
  ] : []),
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
  'browser.recording.read',
  ...(!import.meta.env.FIREFOX ? ['browser.transform.read' as const] : []),
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
  'browser.recording.control',
  'browser.recording.sensitive.read',
  'browser.callable.execute',
  ...(!import.meta.env.FIREFOX ? [
    'browser.debugger.read' as const,
    'browser.debugger.control' as const,
    'browser.transform.manage' as const,
    'browser.transform.execute' as const,
  ] : []),
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
  'browser.recording.read': '读取浏览器录制',
  'browser.recording.control': '控制浏览器录制',
  'browser.recording.sensitive.read': '读取录制值预览',
  'browser.callable.execute': '创建并执行页面函数',
  'browser.debugger.read': '读取暂停现场与作用域',
  'browser.debugger.control': '控制页面深度捕获',
  'browser.transform.read': '读取浏览器转换配置',
  'browser.transform.manage': '管理浏览器转换配置',
  'browser.transform.execute': '执行浏览器请求与响应转换',
  'browser.proxy.read': '读取代理',
  'browser.proxy.write': '切换代理',
};

export function isControlScopeSet(scopes: readonly CapabilityScope[]): boolean {
  return scopes.some((scope) => !READ_CAPABILITY_SCOPES.includes(scope));
}
