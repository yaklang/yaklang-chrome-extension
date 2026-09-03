import { toJsonSchema } from '@valibot/to-json-schema';
import type {
  BridgeCapabilityAccess,
  BridgeCapabilityCatalog,
  BridgeCapabilityDescriptor,
  BridgeCapabilityDomain,
  BridgeCapabilityScopeCondition,
  BridgeCapabilityTargetMode,
} from '@/types/messages';
import type { CapabilityScope } from '@/types/models';
import { capabilityParams } from './bridge';

const CAPABILITY_SCHEMA_VERSION = 1;
const CAPABILITY_SCHEMA_DIALECT = 'http://json-schema.org/draft-07/schema#' as const;
const READ_TIMEOUT_MS = 20_000;
const REPLAY_TIMEOUT_MS = 60_000;

export type BridgeCapabilityMethod = keyof typeof capabilityParams;

interface CapabilityMetadata {
  domain: BridgeCapabilityDomain;
  access: BridgeCapabilityAccess;
  agentVisible?: boolean;
  summary: string;
  scopes: CapabilityScope[];
  conditionalScopes?: BridgeCapabilityScopeCondition[];
  targetMode: BridgeCapabilityTargetMode;
  defaultTimeoutMs: number;
}

const CAPABILITY_METADATA = {
  'system.ping': {
    domain: 'system', access: 'read', summary: '检查插件可用性与版本',
    scopes: [], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.tabs': {
    domain: 'page', access: 'read', summary: '列出当前浏览器实例中的全部 HTTP(S) 标签页；配对实例无需逐页授权',
    scopes: ['browser.tabs.read'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.tab.open': {
    domain: 'page', access: 'write', summary: '在当前浏览器实例中新建并前台打开 HTTP(S) 页面',
    scopes: ['browser.tabs.write'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.thumbnail': {
    domain: 'page', access: 'read', summary: '读取当前可见标签页的低清预览图，供 Yakit 实例列表展示',
    scopes: ['browser.tabs.read'], targetMode: 'tab', defaultTimeoutMs: READ_TIMEOUT_MS, agentVisible: false,
  },
  'browser.isolation.inspect': {
    domain: 'isolation', access: 'read', summary: '读取浏览器实例内标签页的 Cookie Store 与身份隔离上下文',
    scopes: ['browser.isolation.read'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.isolation.proof': {
    domain: 'isolation', access: 'sensitive-read', summary: '生成有时限的身份隔离证明，并对同 Cookie Store 的 Tab 执行认证存储预检',
    scopes: ['browser.isolation.read', 'browser.cookies.read', 'browser.storage.read'],
    targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.isolation.incognito.open': {
    domain: 'isolation', access: 'dangerous', summary: '在同一插件安装下创建独立无痕身份页面',
    scopes: ['browser.isolation.manage'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.isolation.container.open': {
    domain: 'isolation', access: 'dangerous', summary: '创建由 Yakit 管理的临时 Firefox Container 身份页面',
    scopes: ['browser.isolation.manage'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.isolation.container.list': {
    domain: 'isolation', access: 'read', summary: '列出由 Yakit 创建且仍然存在的临时 Firefox Container',
    scopes: ['browser.isolation.manage'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.isolation.container.remove': {
    domain: 'isolation', access: 'dangerous', summary: '关闭并删除由 Yakit 创建的临时 Firefox Container',
    scopes: ['browser.isolation.manage'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.authorization.context.capture': {
    domain: 'authorization', access: 'sensitive-read', summary: '为隔离身份生成不含原始凭据的短时认证上下文句柄',
    scopes: ['browser.isolation.read', 'browser.cookies.read', 'browser.storage.read'],
    targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.authorization.context.get': {
    domain: 'authorization', access: 'sensitive-read', summary: '实时复核并读取当前浏览器实例中的短时认证上下文句柄',
    scopes: ['browser.isolation.read', 'browser.cookies.read', 'browser.storage.read'],
    targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.authorization.context.attest': {
    domain: 'authorization', access: 'sensitive-read', summary: '为单个隔离页面生成不含原始凭据的跨设备认证证明',
    scopes: ['browser.isolation.read', 'browser.cookies.read', 'browser.storage.read'],
    targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.authorization.context.attestation.get': {
    domain: 'authorization', access: 'sensitive-read', summary: '实时复核跨设备认证证明及其目标文档',
    scopes: ['browser.isolation.read', 'browser.cookies.read', 'browser.storage.read'],
    targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.authorization.baseline.capture': {
    domain: 'authorization', access: 'sensitive-read', summary: '将已捕获请求封存为不暴露凭据值的短时授权基线',
    scopes: ['browser.network.sensitive.read', 'browser.isolation.read', 'browser.cookies.read', 'browser.storage.read'],
    targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.authorization.baseline.candidates': {
    domain: 'authorization', access: 'read', summary: '列出不包含 Header 或 Body 值的授权基线请求候选',
    scopes: ['browser.network.read', 'browser.isolation.read', 'browser.cookies.read', 'browser.storage.read'],
    targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.authorization.baseline.get': {
    domain: 'authorization', access: 'sensitive-read', summary: '实时复核授权基线及其认证上下文',
    scopes: ['browser.network.sensitive.read', 'browser.isolation.read', 'browser.cookies.read', 'browser.storage.read'],
    targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.authorization.baseline.logical.bind': {
    domain: 'authorization', access: 'dangerous', summary: '在本机验证明文网关生成结构，并将短时逻辑字段 HMAC 绑定到授权基线',
    scopes: ['browser.network.sensitive.read', 'browser.isolation.read', 'browser.cookies.read', 'browser.storage.read', 'browser.transform.execute'],
    targetMode: 'none', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.authorization.baseline.resource.get': {
    domain: 'authorization', access: 'sensitive-read', summary: '读取已确认资源选择器的单个短时值，用于跨身份矩阵',
    scopes: ['browser.network.sensitive.read', 'browser.isolation.read', 'browser.cookies.read', 'browser.storage.read'],
    targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.authorization.baseline.compile': {
    domain: 'authorization', access: 'dangerous', summary: '在实时复核身份后编译一次供 Yak 受限执行器使用的短时请求',
    scopes: ['browser.network.replay', 'browser.network.sensitive.read', 'browser.isolation.read', 'browser.cookies.read', 'browser.storage.read'],
    targetMode: 'none', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.authorization.baseline.packet.compile': {
    domain: 'authorization', access: 'dangerous', summary: '在实时复核身份后编译不可变的完整操作模板或认证骨架',
    scopes: ['browser.network.replay', 'browser.network.sensitive.read', 'browser.isolation.read', 'browser.cookies.read', 'browser.storage.read'],
    targetMode: 'none', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.authorization.baseline.transform.inspect': {
    domain: 'authorization', access: 'sensitive-read', summary: '验证身份页面的明文网关是否完整覆盖授权请求动态字段',
    scopes: ['browser.network.sensitive.read', 'browser.isolation.read', 'browser.cookies.read', 'browser.storage.read', 'browser.transform.read'],
    targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.authorization.baseline.transform.compile': {
    domain: 'authorization', access: 'dangerous', summary: '在发起身份自己的页面环境重算签名、Nonce 与时间字段后编译请求',
    scopes: ['browser.network.replay', 'browser.network.sensitive.read', 'browser.isolation.read', 'browser.cookies.read', 'browser.storage.read', 'browser.transform.execute'],
    targetMode: 'none', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.frames': {
    domain: 'page', access: 'read', summary: '列出浏览器实例指定标签页中的 Frame',
    scopes: ['browser.tabs.read'], targetMode: 'tab', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.context': {
    domain: 'page', access: 'sensitive-read', summary: '采集 DOM、表单、认证信号及可选 Storage/Cookie 上下文',
    scopes: ['browser.dom.read'],
    conditionalScopes: [
      { scope: 'browser.storage.read', when: 'includeStorage=true' },
      { scope: 'browser.cookies.read', when: 'includeCookies=true' },
    ],
    targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.node.inspect': {
    domain: 'page', access: 'read', summary: '读取页面上下文快照中的稳定节点',
    scopes: ['browser.dom.read'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.node.action': {
    domain: 'page', access: 'write', summary: '点击、聚焦、滚动或填写稳定页面节点',
    scopes: ['browser.dom.write'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.cookies': {
    domain: 'page', access: 'sensitive-read', summary: '读取目标页面 Cookie，包括已授权的 HttpOnly 值',
    scopes: ['browser.cookies.read'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.takeover': {
    domain: 'page', access: 'write', summary: '将目标标签页切换到前台',
    scopes: ['browser.tab.activate'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.instance.close': {
    domain: 'page', access: 'dangerous', summary: '关闭当前浏览器实例的全部窗口',
    scopes: ['browser.instance.close'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.handoff.request': {
    domain: 'handoff', access: 'write',
    summary: '页面需要用户扫码、MFA、验证码或设备确认时调用；Yakit 会在本地呈现交互内容，Agent 只等待结果',
    scopes: ['browser.human.takeover'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.handoff.status': {
    domain: 'handoff', access: 'read', summary: '读取当前人工接管状态',
    scopes: ['browser.human.takeover'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.handoff.presentation.get': {
    domain: 'handoff', access: 'sensitive-read', agentVisible: false,
    summary: '仅在本机提取当前扫码接管的二维码展示数据',
    scopes: ['browser.human.takeover'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.handoff.focus': {
    domain: 'handoff', access: 'write', agentVisible: false,
    summary: '二维码无法在本地呈现时，由 Yakit 将对应浏览器实例切换到前台',
    scopes: ['browser.human.takeover'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.handoff.resolve': {
    domain: 'handoff', access: 'write', agentVisible: false,
    summary: '由 Yakit 本地界面完成或取消人工接管',
    scopes: ['browser.human.takeover'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.network.start': {
    domain: 'network', access: 'control', summary: '启动有界网络捕获，可选采集请求头和 Body',
    scopes: ['browser.network.capture'],
    conditionalScopes: [{ scope: 'browser.network.sensitive.read', when: 'captureHeaders=true or captureBody=true' }],
    targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.network.status': {
    domain: 'network', access: 'read', summary: '读取网络捕获状态',
    scopes: ['browser.network.read'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.network.list': {
    domain: 'network', access: 'read', summary: '列出已捕获请求，敏感字段仍由 Agent 操作审核策略保护',
    scopes: ['browser.network.read'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.network.clear': {
    domain: 'network', access: 'control', summary: '清空目标页面的网络捕获',
    scopes: ['browser.network.capture'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.network.stop': {
    domain: 'network', access: 'control', summary: '停止目标页面的网络捕获',
    scopes: ['browser.network.capture'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.network.export': {
    domain: 'network', access: 'sensitive-read', summary: '将已捕获请求导出为完整 HTTP 报文',
    scopes: ['browser.network.sensitive.read'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.network.poc': {
    domain: 'network', access: 'execute', summary: '让 Yak 基于已捕获请求生成 PoC',
    scopes: ['browser.network.sensitive.read'], targetMode: 'document', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.network.analysis': {
    domain: 'network', access: 'sensitive-read', summary: '将已捕获请求准备为 Yak AI 分析上下文',
    scopes: ['browser.network.sensitive.read'], targetMode: 'document', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.recording.start': {
    domain: 'recording', access: 'control', summary: '开始业务 Trace 录制，可选采集有界值预览',
    scopes: ['browser.recording.control'],
    conditionalScopes: [{ scope: 'browser.recording.sensitive.read', when: 'captureValues=true' }],
    targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.recording.status': {
    domain: 'recording', access: 'read', summary: '读取录制状态',
    scopes: ['browser.recording.read'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.recording.get': {
    domain: 'recording', access: 'read', summary: '读取完整的有界录制快照',
    scopes: ['browser.recording.read'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.recording.clear': {
    domain: 'recording', access: 'control', summary: '清空当前录制 Session',
    scopes: ['browser.recording.control'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.recording.stop': {
    domain: 'recording', access: 'control', summary: '停止并封存当前录制',
    scopes: ['browser.recording.control'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.recording.trace.list': {
    domain: 'recording', access: 'read', summary: '列出业务 Trace、请求和推断候选元数据',
    scopes: ['browser.recording.read'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.recording.evidence.inspect': {
    domain: 'recording', access: 'sensitive-read', summary: '读取 Trace 或事件证据及可选值预览',
    scopes: ['browser.recording.read'],
    conditionalScopes: [{ scope: 'browser.recording.sensitive.read', when: 'includeValues=true' }],
    targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.callable.create': {
    domain: 'callable', access: 'execute', summary: '从录制句柄或深度捕获 Frame 创建页面函数',
    scopes: ['browser.callable.execute'],
    conditionalScopes: [{ scope: 'browser.debugger.control', when: 'source=deep-capture' }],
    targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.callable.list': {
    domain: 'callable', access: 'read', summary: '列出当前文档的页面函数',
    scopes: ['browser.recording.read'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.callable.execute': {
    domain: 'callable', access: 'execute', summary: '执行文档绑定的页面函数',
    scopes: ['browser.callable.execute'], targetMode: 'document', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.callable.delete': {
    domain: 'callable', access: 'write', summary: '删除页面函数',
    scopes: ['browser.callable.execute'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.callable.inspect': {
    domain: 'callable', access: 'read', summary: '读取页面函数输入槽、输出契约和来源',
    scopes: ['browser.recording.read'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.callable.replay': {
    domain: 'callable', access: 'execute', summary: '使用新参数回放页面函数',
    scopes: ['browser.callable.execute'], targetMode: 'document', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.deep_capture.start': {
    domain: 'debugger', access: 'dangerous', summary: '为密码调用、消息边界或请求武装 Chromium 深度捕获',
    scopes: ['browser.debugger.control'], targetMode: 'document', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.deep_capture.status': {
    domain: 'debugger', access: 'sensitive-read', summary: '读取暂停状态、调用栈和已授权作用域预览',
    scopes: ['browser.debugger.read'], targetMode: 'document', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.deep_capture.keepalive': {
    domain: 'debugger', access: 'control', summary: '延长暂停页面的交互窗口',
    scopes: ['browser.debugger.control'], targetMode: 'document', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.deep_capture.resume': {
    domain: 'debugger', access: 'control', summary: '恢复页面执行并保留捕获结果',
    scopes: ['browser.debugger.control'], targetMode: 'document', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.deep_capture.detach': {
    domain: 'debugger', access: 'control', summary: '释放扩展拥有的调试会话',
    scopes: ['browser.debugger.control'], targetMode: 'document', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.transform.profile.list': {
    domain: 'transform', access: 'read', summary: '列出目标页面可见的明文网关 Profile',
    scopes: ['browser.transform.read'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.transform.profile.save': {
    domain: 'transform', access: 'dangerous', summary: '保存或更新完整 Transform Profile',
    scopes: ['browser.transform.manage'], targetMode: 'profile', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.transform.profile.delete': {
    domain: 'transform', access: 'write', summary: '删除 Transform Profile',
    scopes: ['browser.transform.manage'], targetMode: 'profile', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.transform.recovery.get': {
    domain: 'transform', access: 'read', summary: '读取 Profile 的非敏感文档恢复计划和确定性状态',
    scopes: ['browser.transform.read'], targetMode: 'profile', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.transform.recovery.start': {
    domain: 'transform', access: 'dangerous', summary: '按 Profile 恢复计划武装一次性请求边界捕获',
    scopes: ['browser.transform.manage', 'browser.debugger.control'],
    targetMode: 'profile', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.transform.recovery.capture': {
    domain: 'transform', access: 'dangerous', summary: '从暂停现场重新捕获 Profile 的页面函数并保持停用',
    scopes: ['browser.transform.manage', 'browser.debugger.control', 'browser.callable.execute'],
    targetMode: 'profile', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.transform.recovery.validate': {
    domain: 'transform', access: 'execute', summary: '使用当前文档和本地报文验证待恢复 Profile',
    scopes: ['browser.transform.execute'], targetMode: 'profile', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.transform.recovery.confirm': {
    domain: 'transform', access: 'dangerous', summary: '确认已验证的恢复结果并替换旧页面绑定',
    scopes: ['browser.transform.manage'], targetMode: 'profile', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.transform.recovery.reset': {
    domain: 'transform', access: 'write', summary: '取消当前恢复结果并保持旧 Profile 停用',
    scopes: ['browser.transform.manage'], targetMode: 'profile', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.transform.execute': {
    domain: 'transform', access: 'execute', summary: '对 HTTP 报文应用已保存的请求或响应转换',
    scopes: ['browser.transform.execute'], targetMode: 'profile', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.packet.compare': {
    domain: 'transform', access: 'read', summary: '按结构或精确模式比较两份 HTTP 报文',
    scopes: ['browser.transform.read'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.profile.propose': {
    domain: 'transform', access: 'read', summary: '从候选证据和页面函数确定性编译 Profile 提案',
    scopes: ['browser.transform.read', 'browser.recording.read'],
    targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.profile.validation.latest': {
    domain: 'transform', access: 'read', summary: '读取当前文档最近的短时验证草稿',
    scopes: ['browser.transform.read'], targetMode: 'document', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'browser.profile.validate': {
    domain: 'transform', access: 'execute', summary: '重新编译并执行 Profile，再与候选或报文证据比较',
    scopes: ['browser.transform.execute', 'browser.recording.read'],
    targetMode: 'document', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.invoke': {
    domain: 'page', access: 'dangerous', summary: '在页面 MAIN world 调用具名函数路径',
    scopes: ['browser.page.invoke'], targetMode: 'document', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'browser.eval': {
    domain: 'page', access: 'dangerous', summary: '在页面 MAIN world 执行表达式或异步程序',
    scopes: ['browser.page.eval.expression'],
    conditionalScopes: [{ scope: 'browser.page.eval.program', when: 'mode=program' }],
    targetMode: 'document', defaultTimeoutMs: REPLAY_TIMEOUT_MS,
  },
  'proxy.list': {
    domain: 'proxy', access: 'read', summary: '列出扩展代理 Profile',
    scopes: ['browser.proxy.read'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
  'proxy.switch': {
    domain: 'proxy', access: 'write', summary: '切换当前代理 Profile',
    scopes: ['browser.proxy.write'], targetMode: 'none', defaultTimeoutMs: READ_TIMEOUT_MS,
  },
} satisfies Record<BridgeCapabilityMethod, CapabilityMetadata>;

function capabilityAvailable(method: BridgeCapabilityMethod): boolean {
  if (method === 'browser.isolation.incognito.open') return !import.meta.env.FIREFOX;
  if (method.startsWith('browser.isolation.container.')) return import.meta.env.FIREFOX;
  if (method.startsWith('browser.deep_capture.')) return !import.meta.env.FIREFOX;
  if (method === 'browser.transform.recovery.start' || method === 'browser.transform.recovery.capture') {
    return !import.meta.env.FIREFOX;
  }
  if (method === 'browser.invoke' || method === 'browser.eval') {
    return !(import.meta.env.FIREFOX && import.meta.env.MODE === 'store');
  }
  return true;
}

export const BRIDGE_CAPABILITIES = (
  Object.keys(CAPABILITY_METADATA) as BridgeCapabilityMethod[]
).filter(capabilityAvailable);

export const READ_CAPABILITY_SCOPES: CapabilityScope[] = [
  'browser.tabs.read',
  'browser.isolation.read',
  'browser.dom.read',
  'browser.storage.read',
  'browser.cookies.read',
  'browser.network.read',
  'browser.recording.read',
  'browser.transform.read',
];

export const CONTROL_CAPABILITY_SCOPES: CapabilityScope[] = [
  ...READ_CAPABILITY_SCOPES,
  'browser.tabs.write',
  'browser.dom.write',
  'browser.isolation.manage',
  'browser.tab.activate',
  'browser.instance.close',
  ...(!(import.meta.env.FIREFOX && import.meta.env.MODE === 'store')
    ? ['browser.page.invoke' as const, 'browser.page.eval.expression' as const]
    : []),
  'browser.human.takeover',
  'browser.network.capture',
  'browser.network.sensitive.read',
  'browser.network.replay',
  'browser.recording.control',
  'browser.recording.sensitive.read',
  'browser.callable.execute',
  ...(!import.meta.env.FIREFOX ? [
    'browser.debugger.read' as const,
    'browser.debugger.control' as const,
  ] : []),
  'browser.transform.manage',
  'browser.transform.execute',
  'browser.proxy.read',
  'browser.proxy.write',
];

export const CAPABILITY_LABELS: Record<CapabilityScope, string> = {
  'browser.tabs.read': '标签页列表',
  'browser.tabs.write': '打开网页',
  'browser.isolation.read': '读取身份隔离状态',
  'browser.isolation.manage': '创建隔离身份页面',
  'browser.dom.read': '页面 DOM',
  'browser.dom.write': '操作页面元素',
  'browser.storage.read': '页面 Storage',
  'browser.cookies.read': 'Cookie',
  'browser.tab.activate': '切到前台',
  'browser.instance.close': '关闭浏览器实例',
  'browser.page.invoke': '调用页面函数',
  'browser.page.eval.expression': '执行页面表达式',
  'browser.page.eval.program': '执行页面程序',
  'browser.human.takeover': '人工接管',
  'browser.network.read': '读取网络摘要',
  'browser.network.capture': '控制网络捕获',
  'browser.network.sensitive.read': '读取请求头与请求体',
  'browser.network.replay': '在页面认证上下文中重放请求',
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

export function capabilityBaseScope(method: string): CapabilityScope | undefined {
  return CAPABILITY_METADATA[method as BridgeCapabilityMethod]?.scopes[0];
}

export function capabilityVisibleToAgent(method: string): boolean {
  const metadata = CAPABILITY_METADATA[method as BridgeCapabilityMethod] as CapabilityMetadata | undefined;
  return metadata?.agentVisible !== false;
}

export function isControlScopeSet(scopes: readonly CapabilityScope[]): boolean {
  return scopes.some((scope) => !READ_CAPABILITY_SCOPES.includes(scope));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(input)
      .filter((key) => input[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(input[key])]),
  );
}

export function canonicalCapabilityCatalogPayload(
  catalog: Omit<BridgeCapabilityCatalog, 'hash'>,
): string {
  return JSON.stringify(canonicalize(catalog));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function capabilityDescriptor(method: BridgeCapabilityMethod): BridgeCapabilityDescriptor {
  const metadata: CapabilityMetadata = CAPABILITY_METADATA[method];
  const paramsSchema = toJsonSchema(capabilityParams[method], {
    target: 'draft-07',
    typeMode: 'input',
    errorMode: 'ignore',
  }) as Record<string, unknown>;
  return {
    method,
    ...metadata,
    scopes: [...metadata.scopes],
    conditionalScopes: metadata.conditionalScopes?.map((condition) => ({ ...condition })),
    paramsSchema,
  };
}

let catalogPromise: Promise<BridgeCapabilityCatalog> | undefined;

export function getBridgeCapabilityCatalog(): Promise<BridgeCapabilityCatalog> {
  catalogPromise ||= (async () => {
    const payload = {
      version: CAPABILITY_SCHEMA_VERSION,
      schemaDialect: CAPABILITY_SCHEMA_DIALECT,
      capabilities: BRIDGE_CAPABILITIES.map(capabilityDescriptor),
    };
    return {
      ...payload,
      hash: await sha256Hex(canonicalCapabilityCatalogPayload(payload)),
    };
  })();
  return catalogPromise;
}
