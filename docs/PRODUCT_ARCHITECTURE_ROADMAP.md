# Yakit Browser Agent 产品与架构路线

> 状态：Phase 1-4 生产基线已完成；前端密码通用化 Phase 3.2 的 G0-G3.5 已实施，G4-G5 按真实样本继续；外部分发仍受账号、签名与商店人工审核约束
> 更新时间：2026-07-21
> 适用仓库：`yaklang-chrome-extension`、Yak `common/browser`/`common/yak/yakurl` 与 Yakit 浏览器集成页

## 0. 2026-07-17 实施快照

本项目尚未正式发布，因此当前重构不承担旧状态、旧消息或旧 Bridge 协议的迁移兼容。破坏性变更直接形成新的生产基线，避免长期保留双字段、双协议和回退分支。

本轮已经落地：

- 状态模型直接切换到 v7；代理、UA、Bridge、面板设置与 grant/Bridge/action session 分域存储，不读取旧聚合 key；
- content script、嵌入式 floating page、Popup/Options 三类发送者使用不同的标签页绑定策略；
- Options 顶栏显式选择目标标签页，从 Popup/悬浮面板进入时携带 `tabId`；
- RequestMap + Valibot 严格校验 extension runtime 消息和 Bridge method params；
- 授权改为 `targets + origin + scopes + taskId + expiresAt`，跨来源导航后失效；
- background 状态写入串行化，避免并发 `get -> modify -> set` 丢更新；
- Bridge v3 使用 `engine challenge -> extension auth -> hello_ack`，以双方 P-256 身份签名绑定 extension Origin、installation、engine、connection、session、task 与 grant；
- Yak gRPC 默认托管 loopback Bridge；Yakit 复用 `RequestYakURL` 的 `browser-extension://` schema 完成配对窗口、审批、重命名和撤销，没有增加成组 gRPC RPC；
- Bridge 运行时支持多浏览器同时在线并按 `deviceId` 隔离路由；Yakit 点击设备行默认进入包含录制与深度捕获的浏览器现场工作台，能力调用/Yak 脚本作为高级模式；单一 `ExecuteBrowserExtensionTask` 流式 RPC 负责 schema 分发、日志、结果、取消和错误回程；
- 浏览器 Yak 任务在拥有 Bridge 的 gRPC 进程内执行，请求级注入选中设备的 `browser.ExtensionCall`，并限制脚本体积、并发、超时、单事件和总输出；不再借用会 fork 子进程的通用 Exec Yak 链路；
- 插件与 Yakit 展示同一六位校验码，审批后自动连接；不再配置、复制或轮换 bearer token，设备撤销会立即断开当前会话；
- 页面执行抽象为 Chrome User Scripts MAIN、受管 injected MAIN fallback 与 Firefox AMO invoke-only 渠道；
- 默认 production/store 构建使用 User Scripts，物理移除 `page-main-world.js`；enterprise 使用 User Scripts 优先并保留 injected fallback，dev 与 Firefox MV2 保留 injected bridge；
- 常驻 content script 从约 480KB 降到 Store 约 11.1 KiB；React 浮动工作台仅在展开时加载；
- Chrome Store/User Scripts 与 injected bridge 均通过真实 Chromium E2E；
- content/background/MAIN world/总包体积继续作为可观测的参考指标，但不再阻断构建；商店执行策略、权限和资源暴露策略仍由自动审计硬性校验。
- grant target 已绑定 `tabId + frameId + documentId + origin`，同源刷新返回 `stale_document`，跨来源导航返回 `origin_changed`；
- Bridge 已支持 cancel、8 请求并发上限、重复 ID 拒绝、16 MiB 收发上限和断线清理；
- 人工接管具备 `waiting_for_user -> completed/cancelled` 状态、三处 UI 提示和扩展到 Yak 的事件回程；
- 审计流使用独立 storage key，最多保留 500 条脱敏元数据，Options 提供操作记录视图；
- Store 与 Enterprise E2E 已覆盖接管完成事件、取消、审计脱敏和 document 边界。
- 基于 `webRequest` 的 document-bound Fetch/XHR 捕获已经落地，默认只保存有界元数据；请求头、Cookie 和 body 需要显式开启；
- Options 已提供网络时间线、原始请求检查器和复制功能；
- 插件与 Yak 已支持双向 request/response，`yakit.web_fuzzer.open` 会保存配置、打开 Yakit Web Fuzzer 并返回 `pageId`；
- Store E2E 已验证真实 HttpOnly Cookie、请求头、POST body、Agent scope 读取、Web Fuzzer 回执和审计不泄漏。
- 页面上下文已从最多 500 KiB HTML 改为有界结构化快照，正文摘要上限 20 KiB，可操作节点上限 400；
- `captureId + documentId + frameId + nodeId` 稳定引用、`browser.node.inspect/action` 和 `stale_node` 已落地；
- open Shadow DOM 遍历、认证信号、context diff 与登录态工作区已经完成，并通过真实 Chromium 节点写入/点击测试。
- main/同源/跨源 frame inventory、显式 frame 授权与跨 frame context 已完成；
- IndexedDB database/store/key 概况、CacheStorage 名称清单和 SPA history/fragment 生命周期已完成，数据库与 Cache 值不会被采集。
- 交互/Fetch/XHR/Form/Beacon/WebSocket/Worker/SharedWorker/MessagePort/统一密码调用/转换独立 MAIN-world 录制器、业务 Trace、每次录制随机加盐的值关联、文档绑定页面函数、敏感值独立 scope、Yak PoC 与无值 AI 分析上下文已完成；密码调用已收敛为开放但有界的统一 `crypto` 协议和 adapter registry，覆盖 WebCrypto、CryptoJS、JSEncrypt、sm-crypto 与 node-forge；
- Chromium `chrome.debugger` 深度捕获、一次性函数/请求断点、两阶段 stack/scope 采集、45 秒自动恢复、页面闭包运行时适配器与 Options/Yakit 工作台已完成；Firefox 明确不声明该能力；
- 浏览器明文网关已完成：插件提供文档绑定的多步 request/response 页面函数链，Yak Web Fuzzer 在发送前加密/签名、响应后解密，Yakit 保持明文编辑并提供明文/线上报文对照；失败不会回退发送明文；
- Cookie 三格式导入导出、UA 请求头边界、PAC 分流/认证/冲突/统计已完成；
- Popup 已改为固定图标 rail：概览、代理、Cookie Editor、User-Agent 四个模块保持稳定位置；顶部仅保留 Yak SVG、当前页面和带 Tooltip 的引擎状态点。Cookie Editor 与 User-Agent 面向当前标签页提供快速操作：敏感值默认隐藏、显式显示、当前站点新增/编辑/删除 Cookie，以及内置/自定义 UA 预设的应用、刷新和恢复默认；Options 的“常用工具”分组承载完整 Cookie 清单、导入导出、CHIPS 属性、站点绑定和自定义预设管理；
- Bridge v3 已支持 512 KiB 阈值分片、16 MiB 总上限、心跳延迟、设备签名认证和逻辑 session 恢复；
- expression/program Eval 独立 scope、Agent session action timeline 与暂停/恢复/撤销已完成；
- 任务型 Overview、320/390px 导航、站点策略/活动任务/全屏/快捷展开悬浮面板已完成；
- Native Host 可执行程序、Linux/macOS/Windows 安装器、企业 managed policy、本地指标、脱敏诊断、权限/隐私/Limited Use/商店审核包已完成；
- Vitest 116 项、四渠道构建与 fixture 泄漏审计、Store/Enterprise Chromium E2E、Trace 精确/通道关联、跨页面录制与浏览器后退、停止后页面函数复跑、JSEncrypt RSA receiver 保真回放与 `form.data` 自动 Profile、真实 AES-GCM/HMAC 闭包捕获、AES + RSA 请求事务与独立服务端验签、自动共同祖先捕获与参数级明文网关、sm-crypto/node-forge 独立服务端验收、随机 ESM + WASM 闭包和 Worker holdout、明文网关双向转换与服务端验证、Service Worker 重启验证、Native Messaging v3 真实链路与 Yak Go 确定性包测试已完成。

外部发布动作不属于源码可自动完成的状态：开发者账号、签名证书、稳定隐私政策 URL、Windows/macOS/Linux 真机签名包、Chrome Web Store/AMO 上传、审查往返与批准。执行清单位于 `docs/store-review/RELEASE_CHECKLIST.md`。

## 1. 当前判断

当前版本已经从一年前的实验性浏览器插件演进为可提交审核的生产候选基线：

- WXT、React、Chrome MV3 与 Firefox 构建链路已经建立；
- Popup、Options 和网页悬浮面板使用统一的品牌与 UI 体系；
- Popup 负责 1-2 步完成当前标签页的高频动作，Options 负责可搜索、可批量、可审计的深度管理；两者共用同一 runtime request map 和 background capability handler，不复制浏览器 API 逻辑；
- Yak/Yakit 原始品牌资产已经恢复；
- 代理、Cookie、User-Agent、页面上下文和 Bridge 已经形成基础能力；
- Chrome Store User Scripts、Enterprise User Scripts + injected fallback 与 Firefox AMO invoke-only 发布边界已经物理分包；
- Bridge v3、Yakit 配对控制面、Native Host、task/grant/session 身份和授权有效期已经打通；
- 只读、表达式 Eval、程序 Eval、敏感网络、录制值预览、页面函数、调试读取/控制与页面函数执行分别授权；
- 扫码、MFA、CAPTCHA 接管和 Agent 暂停/恢复/撤销已经形成可观察状态机；
- 生产剩余风险已经收敛为外部签名、真机兼容与商店审核，而不是未实现的核心架构。

## 2. 产品北极星

Yakit Browser Agent 不应该被设计成另一个通用浏览器工具箱。

Cookie Editor、UA 修改、编码解码和代理切换都是辅助功能。产品真正有差异化的价值是：

> 将用户真实登录后的浏览器环境，以明确授权、可观察、可暂停、可人工接管、可审计的方式交给 Yakit 和 AI Agent。

所有架构和 UI 决策都应服务于以下主流程：

```text
用户选择目标标签页
    -> 创建与 AI task 绑定的授权
    -> Agent 读取结构化页面和认证上下文
    -> 捕获请求、签名或加密逻辑
    -> 发送到 Yakit Fuzzer / Repeater / AI
    -> 遇到二维码、MFA、CAPTCHA 时请求人工接管
    -> 用户完成并显式恢复任务
    -> Agent 获取新上下文并继续
    -> 授权到期或用户主动撤销
```

## 3. P0：继续扩展功能前必须处理

### 3.1 请求必须绑定发送者标签页

原实现的 background handler 忽略 `runtime.MessageSender`，content script 发出的 `tab.active`、`context.capture` 等请求会重新查询当前活动标签页。本轮已经完成 sender、frame 与 document 级绑定。

这会造成一个真实风险：后台标签页加载 content script 时，如果用户已经切到另一个标签页，悬浮面板可能显示、授权或采集错误的页面。

目标规则：

```text
content script 请求
    -> 默认使用 sender.tab.id + sender.frameId + sender.documentId

popup / options 请求
    -> 必须显式传 tabId，或由 UI 明确选择 active tab

Bridge 请求
    -> 必须显式传 tabId，并验证它属于当前 grant
```

所有页面能力都应接受统一目标：

```ts
interface BrowserTarget {
  tabId: number;
  frameId?: number;
  documentId?: string;
}
```

导航后旧 `documentId` 应返回 `stale_document`，不能静默操作新页面。

### 3.2 授权从两级改为 capability scopes

原有 `read | control` 太粗。当前状态已经保存具体 scope，UI 的“只读/控制”仅作为创建 scope 集合的快捷预设；Eval 表达式与程序已经拆成独立 scope。

建议 scope：

```text
context.read
cookies.read
storage.read
network.read
page.invoke
page.eval.expression
page.eval.program
page.interact
proxy.read
proxy.write
human.takeover
```

授权至少包含：

```ts
interface BrowserGrant {
  id: string;
  taskId: string;
  agentId?: string;
  targets: BrowserTarget[];
  origins: string[];
  scopes: CapabilityScope[];
  createdAt: number;
  expiresAt: number;
}
```

`page.eval.program` 应独立授权。首次高风险执行应允许用户预览代码和目标 origin。

### 3.3 消息协议必须运行时校验

TypeScript 类型不会校验来自 runtime、content script、Native Messaging 或 WebSocket 的真实数据。

当前已建立严格 request map：

```ts
interface RequestMap {
  'context.eval': {
    input: EvalRequest;
    output: PageEvalResult;
  };
  'proxy.switch': {
    input: { id: string };
    output: ExtensionState;
  };
}
```

配合 Zod、Valibot 或等价 schema 校验：

- Bridge envelope 和 protocol version；
- `tabId`、`frameId`、`documentId`；
- Eval 代码长度、模式、超时和并发数量；
- Cookie URL、domain、path 和 expiration；
- 代理 host、port、scheme、PAC 数据；
- loopback WebSocket endpoint、配对状态、双方公钥与签名 envelope；
- Grant scope、origin、task 和有效期；
- 单请求和返回值大小。

### 3.4 Storage 避免并发覆盖

原有状态写入为 `get -> modify -> set`，并发写可能丢失更新。当前已经串行化所有跨域 mutation，按代理、UA、Bridge、面板拆分长期 key，并把 grant/handoff、Bridge session、Agent timeline、代理密码/统计放入 session key；审计和本地聚合指标使用独立有界 key。

当前按领域拆 key：

```text
settings.proxy
settings.userAgent
settings.bridge
ui.floatingPanel
session.activeGrant
session.audit
```

写操作由 background 串行执行。临时会话与长期配置分开存储。

### 3.5 Bridge 必须有正式握手

目标握手：

```text
engine signed challenge
    -> extension verifies paired engine identity
    -> extension signed auth (origin + installation + task/grant)
    -> engine verifies paired device identity
    -> hello_ack + protocol/capability negotiation
    -> ready
```

在收到 `hello_ack` 之前不能显示“引擎已连接”。

Bridge v3 已具备双方 P-256 身份校验、Origin/installation 绑定、protocol/capability/版本协商、request cancel、8 个并发请求上限、16 MiB 总上限和有界事件回程；超过 512 KiB 的消息按 256 KiB 分片。握手携带 installation/task/grant/resume session，回执携带 engine identity/instance/connection/session 身份；心跳记录序号、时间和延迟。断线中的具体调用明确失败，重连恢复逻辑 task/grant session 身份，不伪装恢复已经中断的调用栈。

## 4. Eval 发布策略

### 4.1 先区分“构建渠道”和“执行机制”

`store`、`enterprise`、`dev` 是三个发布渠道，不是三个完全独立的 JavaScript 语义。

底层执行机制主要有三种：

1. 当前的 injected MAIN-world bridge；
2. `userScripts.execute({ world: "MAIN" })`；
3. 仅允许预定义的 `page.invoke` / structured commands。

推荐矩阵：

| 构建渠道 | 首选执行机制 | 备用机制 |
| --- | --- | --- |
| Chrome Web Store | User Scripts MAIN | Invoke-only |
| Enterprise managed | User Scripts MAIN | 受管策略允许的 injected bridge |
| Local development | Injected MAIN bridge | User Scripts MAIN 对照测试 |
| Firefox MV3 AMO | Invoke-only / structured commands | 无通用 Eval 回退 |
| Firefox 本地/受管 | Injected bridge | Invoke-only |
| Firefox MV2 | Injected bridge | Invoke-only |

### 4.2 三种渠道的使用效果是否完全一样

结论：目标能力可以接近，但不完全一样。

#### A. 当前 injected MAIN-world bridge

执行链路：

```text
Bridge/background
    -> isolated content script
    -> CustomEvent
    -> packaged page-main-world.js
    -> indirect eval(code)
```

优点：

- 可以访问页面真实 `window`、闭包外全局对象和页面函数；
- 可以等待 Promise；
- 可以自定义循环对象、DOM Node、BigInt 等序列化；
- Chrome、现有 Firefox MV2 构建都可使用；
- 开发时不依赖用户开启 User Scripts 权限。

不足：

- 页面可以观察、修改或干扰 MAIN world 逻辑；
- 页面可以伪造 CustomEvent 响应；
- 请求和返回需要自己维护关联、超时、序列化；
- 同步死循环无法中断；
- 从 Bridge 获取代码再调用 `eval()` 很可能不符合 Chrome Web Store MV3 政策；
- 更适合本地开发、自托管或受管环境，不适合作为公开商店版默认机制。

#### B. User Scripts MAIN

执行链路：

```text
background
    -> browser.userScripts.execute({
         target,
         world: "MAIN",
         js: [{ code }]
       })
    -> browser InjectionResult[]
```

与当前方案相同或接近的部分：

- `world: "MAIN"` 可以访问页面真实 `window` 和页面全局函数；
- 可以执行动态代码；
- 可以指定 tab、frame 或 document；
- 可以等待 Promise；
- 可以返回每个 frame 的执行结果；
- 可以在代码外包一层统一 serializer，保持现有 `PageEvalResult` 格式。

统一语义为：`expression` 自动返回表达式值；`program` 是 async 函数体，必须显式 `return` 才产生返回值，否则为 `undefined`。这避免在 Store MAIN world 内二次调用 `eval`，也让 User Scripts 与 injected fallback 的程序行为一致。

不同点：

- Chrome 需要 `userScripts` permission；
- Chrome 138+ 用户必须在扩展详情页开启 “Allow User Scripts”；
- Firefox 技术上提供 `userScripts`，但当前 AMO 政策将其限定为用户脚本管理器；本产品公开 Firefox 包不使用该 API；
- Chrome 的一次性 `userScripts.execute()` 需要 Chrome 135+；
- 当前项目 Firefox 输出是 MV2，不能直接复用 Firefox 的新 MV3 User Scripts 路径；
- Chrome 和 Firefox 的返回值 clone/serialization 细节不同，跨浏览器应主动返回 JSON string 或统一 envelope；
- MAIN world 依旧能被页面观察和干扰，User Scripts 不是可信执行环境；
- User Scripts 的 one-shot injection 与当前常驻事件桥生命周期不同。

因此，在支持的浏览器上，以下使用体验可以做到基本一致：

```text
输入代码
选择目标标签页/frame
访问页面 window
等待 Promise
得到统一 PageEvalResult
```

但权限开启流程、版本覆盖、frame result、错误格式和底层生命周期不会完全相同。

特别注意：`world: "USER_SCRIPT"` 不是当前 Eval 的等价替代。它与页面隔离，不能直接读取页面框架、加密库和业务全局变量。Yakit 需要复用页面签名或登录态逻辑时，必须选择 `MAIN`。

#### C. Invoke-only / structured commands

示例：

```text
page.invoke
dom.query
dom.click
form.fill
network.findRequest
storage.get
```

优点：

- 权限最容易解释；
- 审计和参数脱敏更容易；
- 对 AI 更稳定，减少生成任意代码；
- 更容易通过公开商店审核；
- 可以对每种能力做明确 schema 和测试。

不足：

- 不能等价替代任意 Eval；
- 遇到未知框架、混淆代码、临时加密逻辑时能力受限；
- 需要持续扩充结构化命令。

因此 Invoke-only 应该是 Agent 的首选路径，而不是删除 Eval 后的完全替代。

### 4.3 推荐的统一 Eval API

上层不应知道底层是 User Scripts 还是 injected bridge：

```ts
interface PageExecutionAdapter {
  availability(): Promise<ExecutionAvailability>;
  execute(request: PageExecutionRequest): Promise<PageExecutionResult[]>;
}
```

请求：

```ts
interface PageExecutionRequest {
  target: BrowserTarget;
  mode: 'expression' | 'program';
  code: string;
  timeoutMs: number;
  maxResultBytes: number;
}
```

Adapter：

```text
ChromeUserScriptsAdapter
FirefoxUserScriptsAdapter
InjectedMainWorldAdapter
InvokeOnlyAdapter
```

UI 和 Bridge 始终调用同一个 `page.execute` capability。Adapter 根据构建渠道、浏览器版本、User Scripts 是否开启以及当前 grant 自动选择。

### 4.4 Chrome Web Store 风险

Chrome MV3 政策明确将以下行为列为常见违规：

- 使用 `eval()` 执行从远程来源获得的字符串；
- 构建解释器执行从远程来源获得的复杂命令；
- 让扩展完整功能无法从提交代码中被审核者理解。

政策明确列出的远程逻辑执行豁免 API 是：

- Debugger API；
- User Scripts API。

官方资料：

- [Additional Requirements for Manifest V3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- [chrome.userScripts](https://developer.chrome.com/docs/extensions/reference/api/userScripts)
- [Enabling chrome.userScripts is changing](https://developer.chrome.com/blog/chrome-userscript)
- [MDN userScripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts)
- [MDN userScripts.execute](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts/execute)

源码预审、实际 Store 包审计、隐私/Limited Use/权限说明和 reviewer test packet 已完成；正式批准仍必须通过 Chrome Web Store 开发者账号上传和人工审核，不能由本地测试替代。

## 5. Page Context 目标模型

页面上下文已经从“一次返回完整 HTML”切换为有界结构化快照，并完成 frame 与浏览器存储 inventory。

建议层次：

```text
Page summary
Accessibility/DOM action tree
Forms and actionable elements
Frames and shadow roots
Authentication signals
Storage inventory
Network request summary
Crypto/signing recording and page callables
Relevant excerpts on demand
```

必须补齐：

- [已完成] main frame、同源 frame、跨源 frame 清单；
- [已完成] `frameId`、`documentId` 和 origin；
- [已完成] open Shadow Root 遍历；
- [已完成] IndexedDB database/store/key 概况；
- [已完成] CacheStorage 概况；
- [已完成] SPA route 和 document 生命周期；
- [已完成] 页面登录状态信号；
- [已完成] 结构化可操作元素引用；
- [已完成] context diff，而不是每次返回完整快照。

元素引用建议：

```text
captureId + documentId + frameId + nodeId
```

页面变化后返回 `stale_node`，不能退化为可能误命中的 CSS selector。

## 6. 高价值产品功能

### 6.1 浏览器请求到 Yakit 工作流

浏览器请求到 Yakit 的生产链路已经闭环：`webRequest` 捕获 Fetch/XHR/Form navigation，用户显式开启敏感字段后生成 HTTP/1.1 重放包，并通过带回执的 Bridge 在 Yakit 中打开 Web Fuzzer、生成可运行 Yak PoC，或生成不含认证值的 AI 分析上下文。AI Agent 可结合关联 Trace 中统一建模的 WebCrypto/CryptoJS/JSEncrypt/sm-crypto/node-forge 密码事件、Worker/MessagePort 通道和 WebSocket 事件分析鉴权、签名、重放和对象级越权风险。

优先完成：

```text
捕获 fetch / XHR / form 请求
    -> 发送到 Web Fuzzer
    -> 发送到 Repeater
    -> 生成 Yak PoC
    -> 交给 AI 分析鉴权、签名和越权风险
```

这是浏览器插件与 Yakit 结合最直接的产品价值。

### 6.2 浏览器现场、前端加密与页面函数

这部分不再是平铺的 Hook 日志，而是围绕一次真实业务操作组织：

```text
点击 / 提交
    -> 业务 Trace
    -> 页面转换 / WebCrypto / CryptoJS / JSEncrypt / sm-crypto / node-forge
    -> Fetch / XHR / WebSocket
    -> 精确值关联
    -> 保留页面调用句柄
    -> 用新输入验证页面函数
```

独立 `page-recorder-main-world.js` 已覆盖 click/submit、Fetch/XHR/Form/Beacon、WebSocket、Worker/SharedWorker/MessagePort、统一密码 adapter 和 Base64 编解码。WebCrypto、CryptoJS、JSEncrypt、sm-crypto 与 node-forge 不再是不同事件类型，而是使用同一 `crypto` envelope；库、算法族、调用名、padding、编码、状态 phase/correlation 和有界 key 元数据由 adapter 提供。默认不返回原始值，只发送路径、大小、编码和每个文档随机加盐的指纹；早期输出和后续输入指纹相同才建立 `exact` link，跨异步消息只建立明确标注的 `correlated` channel link。短时值预览需要 `browser.recording.sensitive.read`，单值最多 8 KiB。用户发起的录制现在是标签页/Frame 级 Session：完整跳转、刷新、历史前进后退、SPA History 与 fragment 都成为 Trace 事件；旧文档片段封存在扩展专属 `storage.session`，新文档观察器沿用 Session 身份和全局顺序继续录制。该 Session 不进入持久化存储、审计或 AI 请求分析，并在新录制、清空、标签页关闭或浏览器会话结束时删除。

满足 replay eligibility 的一次调用会保留原函数、receiver、参数模板和页面内 key 对象的 opaque handle；状态型/流式调用默认作为证据，引导捕获其上层一次性业务闭包。JSEncrypt、sm-crypto 与 node-forge 只公开密钥类型、位数和本次录制加盐指纹，不导出 PEM、私钥、模数或实例。handle 同时受数量、单条 2 MiB 和总计 8 MiB 预算约束，超限调用保留元数据但不成为 callable。录制调用与深度捕获闭包都注册为统一 `BrowserPageCallable`，`browser.callable.*` 不导出密钥，只允许在同一 live document 中使用显式参数槽调用。手动停止录制会恢复页面 API，但 callable 仍可验证；完整导航后 callable 属于历史文档，BFCache 恢复时可重新使用，硬刷新或新文档则会真实销毁闭包。Grant 拥有的录制不会跨文档自动扩权。

Options 与 Yakit 都使用 Session -> Trace -> 执行链/证据/页面函数的三列工作台。录制时间线与执行卡片统一为从早到晚，编号和相对时间表达执行顺序，精确值关联使用独立视觉语义，跳转卡片承担文档边界。Yakit 不新增成组 gRPC 接口，而是通过 `ExecuteBrowserExtensionTask` 的 `capability.call` schema 调用 `browser.recording.*`、`browser.callable.*` 和 `browser.transform.*`。

生产级深度模式不把低层 WebCrypto primitive 当成最终能力。用户从 Trace 选择自动推断候选，插件比较多个密码来源的有界调用栈，寻找最近共同页面祖先，并通过 Chromium CDP 在最早仍保留业务栈的真实调用处暂停。后台用真实 script/function location、作用域绑定和副作用门禁唯一解析业务 frame：纯业务函数以 `selected-frame` 保存；如果该函数同时读 DOM、组装多密码字段并发出请求，则以 `request-transaction` 保留，回放时在页面内映射新明文、拦截唯一目标请求、校验预期输出并回滚 DOM，不会因为浅层副作用检查而误选外层 `onclick`。函数表达式只作为歧义场景的高级入口；暂停作用域默认只存在于当前会话，不进入 Bridge、审计或 Profile。只有用户明确生成并保存明文网关后，被选中的短时样本才会复制到 `profileId + direction` 关联的本机私有回放草稿；该草稿不进入 Bridge、Yak/AI、诊断或导出。页面恢复后，Options、Yakit 或 Yak 可用新 JSON 参数重复调用。

暂停控制面只依赖 grant 身份、`webNavigation`、session 状态和 CDP，不向已暂停页面执行脚本。UI 持续 keepalive，失去控制面后 alarm 在 45 秒自动恢复页面。`browser.debugger.read`、`browser.debugger.control` 和 `browser.callable.execute` 独立授权；grant 替换、过期、撤销和标签页关闭释放其拥有的会话。完整设计和边界见 `docs/DEEP_CAPTURE_ARCHITECTURE.md`。

真实验收夹具使用闭包内不可导出的 AES-GCM/HMAC key、动态 timestamp/nonce/IV、本地 `buildLoginEnvelope` 与 `openLoginResponse` 业务函数。只有捕获请求与响应闭包后，用新账号/密码生成不同随机参数，通过服务端验签解密，并将服务端密文响应还原为明文 JSON，才算完成；字符串 hash mock 不算深度能力验收。

### 6.3 登录态工作区

建立可见 session：

```text
目标 origin
关联标签页
账号线索
Cookie/Storage 概况
CSRF/token 来源
当前代理环境
共享给哪个 Agent/task
授权和过期时间
最近上下文变化
```

默认不导出原始认证值。快照导出必须显式确认并支持脱敏。

### 6.4 人机接管状态机

当前已经完成可运行闭环：Agent 创建 `browser.handoff.request`，插件在目标标签页、Popup 和 Options 显示 `waiting_for_user`，用户完成或取消后发送 `browser.handoff.changed`，Yak 通过 `ExtensionWaitEvent` 消费；独立 Agent runtime 同时记录 running/paused/revoked 与有界 action timeline。

目标状态：

```text
agent_running
needs_human
waiting_for_human
human_resumed
agent_resuming
completed / cancelled / expired
```

流程：

1. Agent 说明需要扫码、MFA、CAPTCHA 或设备确认的原因；
2. 扩展聚焦目标标签页并显示任务；
3. Agent 停止读取敏感内容和重复轮询；
4. 用户完成操作并点击“已完成”；
5. 扩展发送 `human_resumed`；
6. Agent 获取新 context diff 并继续。

## 7. 现有工具完善方向

### Cookie Editor

- [已完成] 搜索、排序和过滤；
- [已完成] 批量删除；
- [已完成] 编辑现有 Cookie；
- [已完成] JSON/Netscape/Raw Set-Cookie 有界导入导出，默认脱敏，原始值导出需显式开启；
- [已完成] Partitioned Cookie；
- [已完成] SameSite 与过期时间；Priority/SameParty 可在交换格式中识别和展示，浏览器 Cookies API 无法写回时返回明确 warning；
- [已完成] 按 domain/path 分组；
- [已完成] 默认隐藏 value，点击后显示。

### User-Agent 与设备身份

当前产品明确选择第一种边界：UI 已命名为 “User-Agent 请求头”，只承诺通过 DNR 修改真实网络请求头，不暗示页面 JS、timezone、viewport、touch 或 geolocation 已被完整伪装。

完整设备指纹伪装不属于当前插件承诺；如果未来引入，必须作为独立能力重新设计 scope、页面注入生命周期和浏览器兼容测试，不能与单一 UA header 规则混为一谈。

### 代理与自动切换

- [已完成] 代理出口、自动切换、规则订阅三个稳定工作区；
- [已完成] 结构化 host/URL 条件、手动规则与订阅源的确定性顺序；
- [已完成] AutoProxy/GFWList、SwitchyOmega Conditions、域名与 hosts 列表解析；
- [已完成] GitHub blob 转 raw、ETag/Last-Modified、定时更新、失败保留上一可用 revision；
- [已完成] IndexedDB 512 条分块、分页读取、流式搜索与八份 PAC artifact 上限；
- [已完成] host exact/suffix 共享 trie、正则慢路径预编译、4 MB PAC 安全预算和 50,000 域名回归测试；
- [已完成] 当前 URL 路由解释、Popup 将当前 hostname 指定到任意固定出口或恢复自动判断、全局模式与站点规则分层、悬浮面板快切；
- [已完成] 编译、浏览器应用与运行态提交串行化，过期下载结果丢弃；
- [已完成] 代理认证，用户名持久化、密码仅保存在浏览器 session；
- [已完成] 有界 JSON 导入导出，不包含代理密码；
- [已完成] 默认出口和 fail-open/fail-closed 行为；
- [已完成] 移除每请求规则命中统计，PAC 成为唯一请求热路径。

详细不变量与性能边界见 `docs/PROXY_ARCHITECTURE.md`。

## 8. UI/UX 改进

### 8.1 字号

已清除 8px/9px 字号；正文、辅助说明、表格和技术元数据按下面基线执行，并由 320/390/桌面截图验证。

目标：

- 工作台正文不低于 12px；
- 辅助说明不低于 11px；
- 表格正文 12px；
- tag、时间戳、技术元数据最低 10px；
- 不再使用 8px。

### 8.2 Overview 改为当前任务工作台

Overview 已改为任务工作台，第一屏展示：

```text
当前站点与登录环境
当前代理和流量状态
正在共享给哪个 Agent
Agent 最近动作
需要用户完成的步骤
抓请求 / 采集上下文 / 发送 Fuzzer
```

### 8.3 移动和窄视口导航

窄视口使用不换行的横向滚动导航；320px 与 390px E2E 检查 document overflow 和导航标签换行。

### 8.4 悬浮面板

已完成：

- 当前站点单独隐藏；
- allowlist/denylist；
- 仅在活动 task 中显示；
- 快捷键展开；
- 页面全屏、演示、视频场景自动收起；
- 与网页边缘控件冲突时调整位置；
- 显示当前 task 和授权风险，而不仅是代理状态。

## 9. 目标代码目录

```text
src/
  app/background/
    index.ts
  entrypoints/
    background.ts
    popup/
    options/
    agent.content/
    page-main-world.ts
    page-recorder-main-world.ts

  features/
    proxy/
    cookies/
    identity/
    page-context/
    browser-recording/
    deep-capture/
    browser-transform/
    network-capture/
    grants/
    handoff/
    diagnostics/
    agent-runtime/
    engine-bridge/
    floating-panel/

  platform/
    browser/
    storage/
    messaging/
    policy/

  protocol/
  components/ui/
  components/brand/
  shared/errors.ts
```

原则：

- WXT background entrypoint 只负责注册并调用 `app/background`；
- 每个高风险 feature 拥有 service，纯编译器/交换器与测试放在 feature 内；
- browser API 通过 platform adapter 隔离；
- background 应用 router 只编排 domain service，不在 entrypoint 内实现浏览器业务；
- UI、Bridge 和测试共享同一份协议 schema。

## 10. 测试策略

### 单元测试

- [已完成] PAC compiler、URL pattern 和冲突优先级；
- [已完成] 无迁移 clean bootstrap、storage 分域和并发写；
- [已完成] Bridge envelope、extension RequestMap 与 managed policy validation；
- [已完成] Grant scope/策略判断与 expression/program Eval serializer；
- [已完成] Cookie URL/脱敏交换与 UA DNR 规则生成。
- [已完成] Deep Capture matcher、adapter 参数上限与 Chromium/Firefox capability 声明。
- [已完成] Transform profile/path/output schema、多步映射、路由匹配、原型链与 Header 注入拒绝。

### 协议测试

- [已完成] pairing code、engine challenge、extension auth、hello_ack、身份字段和 protocol version mismatch；
- [已完成] read/program scope、origin/tab/frame/document 越权；
- [已完成] timeout/cancel、并发、重复 ID、payload 上限与双向 chunk；
- [已完成] 设备审批/撤销、断线 session 恢复、task 到期/撤销与 Native Host framing；
- [已完成] Chromium `connectNative` -> Go Host -> loopback Yak Bridge -> Bridge v3 challenge/auth/identity/heartbeat 的真实端到端验证（生产包仍为 optional permission，只有不可交互的临时测试副本预授权）。
- [已完成] debugger read/control/adapter 独立 scope、会话所有权、暂停期无页面脚本控制面与 grant 撤销清理。
- [已完成] transform read/manage/execute 独立 scope、profile target 越权、Web Fuzzer request/response hook 顺序与 fail-closed。

### 浏览器 E2E

- [已完成] Chrome Store/User Scripts 与 Enterprise User Scripts + injected fallback 模式；
- [已完成] Firefox MV2 injected 与 Firefox MV3 AMO invoke-only 构建/静态策略审计；
- [已完成] CSP 严格页面、SPA、同源/跨源 iframe 与 open Shadow DOM；
- [已完成] 页面伪造消息不扩权、Service Worker 停启保留 session、标签页关闭/导航 Eval fail-closed；
- [已完成] WebCrypto 函数调用断点、业务 frame/scope、闭包适配器动态 nonce/IV 与服务端 HMAC/AES-GCM 验证；
- [已完成] 明文登录请求经 document-bound profile 转为不含明文的动态线上报文，并通过独立服务端 HMAC 验签与 AES-GCM 解密；服务端 AES-GCM 密文响应经页面闭包还原；路径不匹配与隐式跨 Origin 调用失败关闭；
- [已完成] 320px、390px 和桌面视口 UI、面板边界与资源像素/加载检查。

当前容器没有 Firefox 可执行程序或 macOS/Windows 环境；Firefox 真机安装、AMO 签名包和三平台 Native Host 签名属于 `RELEASE_CHECKLIST.md` 的外部发布门禁，不能用 Chromium 模拟结果冒充通过。

## 11. 分阶段落地

### Phase 1：安全与架构基线

- [已完成] sender tab/frame/document 绑定与 stale-document；
- [已完成] RequestMap 和运行时 schema；
- [已完成] Storage 分域、session/local 生命周期与串行写；
- [已完成] capability scopes 与 origin 绑定；
- [已完成] Bridge hello_ack 和版本协商；
- [已完成] Store/enterprise/dev 构建渠道；
- [已完成] PageExecutionAdapter；
- [已完成] Chrome User Scripts MAIN，并通过浏览器 E2E。

### Phase 2：核心产品闭环

- [已完成] Fetch/XHR request capture；
- [已完成] 发送 Yakit Web Fuzzer/Repeater 工作区；
- [已完成] task-bound grant；
- [已完成] human handoff 状态机；
- [已完成] context diff；
- [已完成] Agent action timeline、暂停/恢复/撤销与脱敏持久审计。

### Phase 3：浏览器现场深度

- [已完成] frame/document/node 引用与显式跨 frame 授权；
- [已完成] open Shadow DOM；
- [已完成] IndexedDB/CacheStorage inventory；
- [已完成] 交互/Fetch/XHR/Form/Beacon/WebSocket/Worker/SharedWorker/MessagePort/统一 `crypto` 事件有界录制、Trace/value/channel link 与独立敏感 scope；WebCrypto、CryptoJS、JSEncrypt、sm-crypto、node-forge 通过同一 adapter contract 接入；
- [已完成] 标签页级录制 Session：登录跳转、刷新、历史前进后退与 SPA 路由成为有序 Trace 事件，新文档自动接续；BFCache 恢复旧函数现场，硬加载保留证据并准确标记闭包失效；
- [已完成] 文档绑定页面函数创建、停止后复跑、刷新/撤销失效与 Options/Yakit 专用工作台；
- [已完成] Options/Yakit 页面函数生命周期管理：统一列出来源、引用数量、删除影响与二次确认；
- [已完成] Chromium Deep Capture、45 秒 watchdog、两阶段 stack/scope、业务闭包 callable 与 Options/Yakit 同构工作台；
- [已完成] Deep Capture 为插件 Hook、页面函数和依赖库标记来源，默认选择页面业务帧，并支持点击展开有界作用域值/函数源码；
- [已完成] Browser Transform Gateway：Pipeline v2 有序 DAG、多参数、多输出请求与响应转换、并发门控、Bridge 能力、Yak Web Fuzzer 原生数据面、Yakit 配置与明文/线上对照；
- [已完成] 登录态工作区；
- [已完成] Cookie、UA 请求头边界和代理规则完善。

### Phase 3.1：自动推断 Profile 与 AI 浏览器协作

- [已完成] WebCrypto / CryptoJS / JSEncrypt / sm-crypto / node-forge 参数角色、请求字段、exact value link 与 state correlation 形成统一推断证据；
- [已完成] JSEncrypt RSA 保留真实实例 receiver 与固定参数，只公开 key 类型、位数和加盐指纹；单字段 exact link 可直接生成 Form/JSON/Header/Query 明文网关；
- [已完成] AES/RSA/HMAC 等多个密码输出进入同一请求时合并为 request-level candidate，界面逐项展示目标字段并要求捕获上层业务 callable，避免拆分后破坏随机 key/IV/nonce 一致性；
- [已完成] 高置信度候选在 Options / Yakit 展示证据、参数语义与缺失步骤，并可一键武装对应的深度捕获入口；
- [已完成] 页面录制调用与深度捕获闭包合并为统一 Page Callable，不保留旧模型迁移或方法别名；
- [已完成] Pipeline v2 使用类型化 context.read / builtin / page.call / output.write 节点，节点只能引用前序结果；
- [已完成] JSON、FormData、URLSearchParams、form-urlencoded 与 query 建立通用字段级证据，不依赖站点 URL 或字段名称；
- [已完成] 单条精确值链且保留调用句柄的已知加密调用可从一次录制直接生成可解释候选；
- [已完成] Options 与 Yakit 默认使用“明文来源 → 页面能力 → 线上目标”三步引导，自动编译 form.compose、字段名、Content-Type 与底层引用；
- [已完成] 自动把录制短时样本带入明文网关本地回放，并允许一键恢复原样本；保存网关后按 Profile/请求响应方向自动保存本机私有草稿，切换工作区或目标标签页可恢复，删除网关联动清理，且草稿不进入 Bridge、Yak/AI、诊断或导出；
- [已完成] 多来源同步栈推断共同业务祖先，一键以后台可信 `selected-frame` 捕获完整闭包；参数名自动形成字段级 Body 映射，完整暂停作用域保持非持久化，只有用户明确保存网关时选中的短时样本可进入有界本机私有草稿；
- [已完成] 共同业务祖先直接负责 DOM 取值与发包时自动生成 `request-transaction`，严格拦截 method/URL、保留混淆后的固定 URL 参数，并以 AES + RSA 真实服务端验签、零浏览器请求泄漏验收；
- [待完成] 为页面内回放生成确定性或结构性断言；
- [已完成] 低层加密调用或未知请求/消息边界可一键进入业务 frame 捕获，确定性排序页面闭包并保留完整 envelope / signature callable；
- [待完成] Yakit AI ReAct 使用 task-bound `browser_session` 附加资源和领域工具读取页面、分析候选、驱动捕获；
- [待完成] AI 只能返回引用现有 evidence 的候选补丁，不能直接发布任意代码；
- [待完成] 混淆 CryptoJS、不可导出 WebCrypto key、刷新重捕获与 AI 候选补丁夹具。

完整设计见 `docs/AUTO_PROFILE_INFERENCE_ARCHITECTURE.md`。

### Phase 3.2：前端密码能力通用化

当前统一 `crypto` event、Evidence Graph、Page Callable 与 request-level Profile compiler 已通过 global、真实 minified bundle、随机 ESM closure、Worker 和 WASM 外围业务 wrapper 验收。已知库 adapter 负责增强语义；算法未知时，请求/消息边界和业务 callable 恢复仍是最低保证。

本阶段将已知库 adapter 定义为语义加速器，把请求/消息边界与业务 callable 恢复定义为最低保证：

- [已完成] 记录 recorder 关闭/1,000 次小调用/10 次 1 MiB 调用/预算耗尽性能与 93 项测试基线，并加入生产源码 fixture leakage 审计；
- [已完成] 删除封闭 provider 枚举和展示字符串函数匹配，改为有界 `adapterId + providerKind + operation + wrapperHandleId + state model`；
- [已完成] 从 MAIN-world recorder 拆出 adapter registry、五个独立 adapter、通信边界和 retained-call 双预算基础设施，不保留旧 adapter 分支；
- [待完成] 继续把 Fetch/XHR/Form/WebSocket、evidence/trace 与编码运行时从 MAIN-world 编排入口物理拆开；该项只改善维护边界，不阻塞已经通过的运行时通用性验收；
- [已完成] WebCrypto、CryptoJS、JSEncrypt 迁移到同一独立 adapter contract，不保留旧分支；
- [已完成] 增加 sendBeacon、Worker、SharedWorker、MessagePort 边界和有界同步/异步来源；
- [已完成] 从未知请求/消息边界自动排序页面业务 frame，并允许在算法未命名时捕获完整 closure callable；
- [已完成] 第一批高价值 adapter：sm-crypto 的 SM2/SM3/SM4 与 node-forge 的 RSA/digest/HMAC/stateful cipher；
- [待完成] 第二批 adapter：jsrsasign 与 jose；后续按真实样本推进 libsodium.js、TweetNaCl、noble 和 OpenPGP.js；
- [待完成] serializer/compression 使用独立 transform evidence 接入 Axios interceptor、protobuf、MessagePack 与 pako，不伪装成密码调用；
- [已完成] 使用随机 URL、字段和函数名的 global/minified bundle/ESM closure/Worker/WASM holdout，已发布 callable 由独立服务端解密、验签或校验；
- [已完成] 没有专用 adapter 的 ESM + WASM holdout 仅靠通用 WebCrypto 边界、业务 frame 排序和 closure 恢复完成服务端认可的重放；
- [已完成] 录制停止后无 wrapper/timer/listener/channel context 残留，活跃录制的 CPU、输入大小、事件数和 retained memory 进入真实浏览器回归门禁。

实施顺序固定为“adapter host 与协议 -> 通用边界与未知函数 -> sm-crypto/node-forge -> 其余语义 adapter”。不得用继续堆叠库名称代替通用能力。完整决策、协议草案、目录设计、库优先级、测试矩阵和完成定义见 `docs/FRONTEND_CRYPTO_GENERALIZATION_ROADMAP.md`。

### Phase 4：分发与运营

- [已完成] Native Host 可执行程序、framing proxy、Chrome/Firefox argv 来源校验、Linux/macOS/Windows 安装器与 Chromium 真实传输 E2E；
- [已完成] managed storage schema、后台强制企业策略与 UI 锁定状态；
- [已完成] Chrome Store 实包自动预审和 reviewer packet；实际上传/批准为外部门禁；
- [已完成] Firefox MV3 AMO invoke-only 实包与 review packet；真机/签名/批准为外部门禁；
- [已完成] 权限说明、隐私政策和 Limited Use 披露；
- [已完成] 脱敏审计、session action timeline 与显式诊断导出；
- [已完成] Service Worker 启动、Bridge 连接错误、心跳延迟和 capability 聚合指标（仅本地，不远传）。

## 12. 验收原则

正式产品版本至少满足：

- 不会因 active tab 切换而操作错误页面；
- 每个高风险能力都能追溯到 user、task、grant、target 和 scope；
- 页面不能通过伪造普通消息扩展自己的权限；
- Store build 不通过通用 `eval(remoteCode)` 执行 Bridge 代码；
- User Scripts 未开启时给出明确降级和开启路径；
- Agent 默认使用 structured commands，Eval 是最后手段；
- 用户能看见、暂停、恢复和撤销 Agent 对浏览器的操作；
- 深度捕获命中后控制面立即可见，不依赖暂停页面执行脚本，控制面丢失时页面在 45 秒内自动恢复；
- 默认不记录或导出 Cookie、token、Eval 参数和页面正文；
- Chrome Store、Enterprise User Scripts 与 Enterprise injected fallback 关键路径有真实 Chromium E2E；Firefox 真机安装/运行是发布前外部门禁，不能由 Chromium 或静态审计替代；
- 前端加密深度能力必须通过不可导出 key、动态参数和服务端验签/解密的真实夹具，不能用固定字符串 mock 代替；
- Web Fuzzer 启用浏览器明文网关后，request transform 任何失败都不得发送明文；UI 必须分别保留逻辑明文与实际线上报文；
- Native Host 与 Yakit 实例身份、版本和连接状态可信。
