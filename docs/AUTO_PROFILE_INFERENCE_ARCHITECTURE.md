# Browser Profile 自动推断与 AI 协作架构

## 1. 产品决定

自动推断 Profile 不是明文网关的辅助功能，而是浏览器现场的默认完成路径。

用户不应先理解混淆变量、复制密钥、编写包装函数，再手工配置参数路径和输出映射。正常流程必须从一次真实业务操作开始：

```text
用户执行登录 / 查询 / 提交
  -> Recorder 生成有界业务 Trace
  -> 确定性推断器关联明文点、页面调用和请求字段
  -> 已知模式直接生成候选
  -> 未知模式请求 AI 解释业务帧和参数语义
  -> 必要时引导用户再执行一次操作以捕获业务闭包
  -> 编译为文档绑定的 Profile
  -> 使用录制样本做页面内回放校验
```

手写 JavaScript 保留为高级模式，不再作为主流程或文档中的首选方案。

本设计不包含“发送真实 HTTP 请求验证”。真实请求仍由 Yak / Web Fuzzer 的既有数据面负责。本阶段只负责发现、推断、捕获、编译和页面内样本校验。

## 2. 用户结果

以一次 CryptoJS 调用为例，默认界面应展示：

```text
已识别请求转换

POST /api/login
JSON 明文 -> CryptoJS.AES.encrypt -> body.encryptedData

输入    argument 0 <- 请求明文 JSON
Key     argument 1 <- 页面内 WordArray · 16 B
IV      options.iv <- 页面内 WordArray · 16 B
模式    CBC / Pkcs7
输出    toString -> URL encode -> encryptedData

证据 4 项 · 高置信度
[生成 Profile]
```

`_0x67b862` 一类混淆名称只能出现在折叠的原始证据中。主界面使用 `Key`、`IV`、`明文输入`、`请求字段` 等语义角色。

用户应能回答三个问题：

1. 插件为什么认为这是加密链路；
2. 哪些结论是确定事实，哪些是推测；
3. 还需要用户执行什么操作才能完成 Profile。

## 3. 设计原则

### 3.1 证据先于 AI

指纹相等、请求字段解析、调用顺序、运行时对象类型和调用栈属于确定性证据。AI 不重复判断这些事实，只消费其结构化结果。

### 3.2 AI 不能成为执行边界

AI 可以：

- 给业务 frame 排序；
- 将参数标注为 payload、key、iv、nonce、timestamp 或 signature；
- 从有限源码片段中解释序列化和包装步骤；
- 在多个候选之间给出理由；
- 建议下一次捕获点。

AI 不可以：

- 直接提交任意 JavaScript 作为生产 Profile；
- 引用不存在的事件、frame、参数或页面函数；
- 读取或输出 key、Cookie、token、密码等原始值；
- 绕过 grant、document、origin 或人工接管状态；
- 将猜测标记为已经验证的事实。

### 3.3 页面是执行环境，不是密钥导出器

Key、IV、CryptoKey、key promise、WASM 实例和闭包变量继续保留在原页面。Profile 只保存页面内 opaque callable 引用和经过校验的参数映射。

### 3.4 已知模式不依赖 AI，未知模式不依赖库清单

WebCrypto、CryptoJS、JSEncrypt 以及后续 sm-crypto、node-forge 等已知模式，连同 URLSearchParams、JSON、FormData 和常见编码链，应优先由确定性规则推断。AI 只处理业务语义和未知代码，避免增加延迟、成本和不确定性。

录制协议只暴露统一的 `crypto` 事件，库差异进入结构化 `adapterId / providerKind / family / operation / algorithm / mode / padding / encoding / state / key metadata`。推断器、时间线、Deep Capture 和 Agent 不再分别判断 `webcrypto`、`cryptojs` 等事件类型。新增密码库时只扩展 MAIN-world adapter、扩展自带的 manifest 和受限元数据归一化器，不扩展整条产品协议。

已知 adapter 只负责提供更准确的参数角色、算法和状态语义，不是通用性的唯一来源。对于 ESM/Webpack 闭包、Worker、WASM 或完全未知的业务封装，系统必须从请求/消息边界和调用栈恢复上层业务 callable；算法尚未命名不能单独成为 `insufficient-evidence`。adapter 协议的开放化、Worker/MessagePort 边界、高价值库优先级与反靶场特化验收见 [`FRONTEND_CRYPTO_GENERALIZATION_ROADMAP.md`](FRONTEND_CRYPTO_GENERALIZATION_ROADMAP.md)。

### 3.5 无兼容负担

插件尚未正式投入使用。页面配方、运行时适配器和 Transform Profile 可以直接收敛到新模型，不保留旧数据迁移或双写逻辑。

## 4. 总体架构

```text
MAIN-world Recorder
  | bounded events + opaque handles + semantic argument metadata
  v
Evidence Normalizer
  | request fields / call slots / encodings / exact & normalized links
  v
Evidence Graph
  | proven edges + supported edges + hypotheses
  +-----------------------+
  |                       |
  v                       v
Deterministic Inference   AI Analysis
  | known patterns          | frame ranking / semantic labels / unknown code
  +-----------+-------------+
              v
       Candidate Merger
              | schema validation + evidence reference validation
              v
       Pipeline Compiler v2
              | page callable graph, no arbitrary generated code
              v
       Local Sample Replay
              | deterministic compare or structural assertions
              v
       Document-bound Profile
```

推断计算在扩展后台完成。Yakit、Options 和 AI Agent 读取同一候选结构，不各自实现一套启发式规则。

## 5. Evidence Graph

### 5.1 节点

```ts
type EvidenceNode =
  | RecordingEventNode
  | RecordedValueNode
  | RequestFieldNode
  | CallableNode
  | CallArgumentNode
  | StackFrameNode
  | SourceExcerptNode
```

节点只使用录制会话内稳定 ID。原始敏感值不是图节点属性。

### 5.2 边

```ts
type EvidenceStrength = "proven" | "supported" | "hypothesis"

type EvidenceEdgeKind =
  | "exact-value"
  | "normalized-value"
  | "parent-call"
  | "same-trace"
  | "stack-frame"
  | "argument-role"
  | "request-destination"
```

- `exact-value`：同一录制盐下的指纹完全相同；
- `normalized-value`：经过有界白名单转换后相同，例如 URL decode、JSON field extraction 或 Base64 表示；
- `parent-call`：Recorder 的同步父调用关系；
- `same-trace`：弱证据，只证明时间和用户操作相关；
- `hypothesis`：只能由 AI 或启发式产生，必须列出依据。

### 5.3 请求边界归一化

网络事件在边界处解析，不全局 Hook `JSON.stringify` 或 `encodeURIComponent`：

- JSON：递归提取最多 64 层、100,000 节点；
- `application/x-www-form-urlencoded`：字段级 URL decode；
- `FormData`：字段名、字符串值和文件元数据；
- Headers：规范化名称但保留原始大小写用于展示；
- Query：字段级解析；
- 原始 body：保留整体指纹和类型。

归一化候选只允许白名单操作并设置总预算。不得对每个值进行无界编码组合爆炸。

### 5.4 参数语义

Recorder 对已知库记录参数角色而不是变量名：

```ts
interface CallArgumentEvidence {
  index: number
  role: "data" | "key" | "iv" | "algorithm" | "options" | "signature" |
    "salt" | "nonce" | "aad" | "unknown"
  dataType: string
  byteLength?: number
  replaceable: boolean
  retained: boolean
  summary?: string
}
```

例如 CryptoJS AES：

- `argument 0`：data，可替换；
- `argument 1`：key，不导出，页面内保留；
- `argument 2`：options，提取 mode、padding 和 IV 长度，不提取 IV 值。

例如 JSEncrypt RSA：

- `argument 0`：UTF-8 data，可替换；对象输入按稳定 JSON 序列化后再交给原函数；
- receiver：保留实际 JSEncrypt 实例，不重建、不导出；
- key：只记录 public/private、模数位数和本次录制随机加盐的指纹；
- padding：记录 `PKCS1-v1_5` 等可解释元数据；
- output：记录 Base64 形态并与 JSON/Form/Header/Query 请求字段做 exact link；
- 公私钥 PEM、模数、指数和页面实例永不进入候选或 AI 上下文。

如果一次 RSA 输出精确进入一个请求字段，且原函数、receiver 和参数模板仍在当前 document 中，候选可以直接进入 `ready`，不要求用户填写函数表达式或先进入 Deep Capture。

## 6. 统一 Page Callable

当前页面配方和深度捕获适配器表达的是同一概念：在当前文档中可重复调用的页面函数。两套注册表应合并为 `BrowserPageCallable`。

```ts
interface BrowserPageCallable {
  id: string
  kind: "recorded-call" | "business-closure" | "global-function"
  name: string
  target: BrowserTarget
  lifecycle: "document"
  inputSlots: CallableInputSlot[]
  output: CallableOutputShape
  provenance: {
    recordingId?: string
    traceId?: string
    eventId?: string
    frameId?: string
    sourceUrl?: string
    lineNumber?: number
  }
}
```

`recorded-call` 保存原函数、receiver、固定参数模板和可替换槽位；`business-closure` 保存 CDP 暂停时捕获的业务函数与闭包；两者使用同一执行、授权、生命周期和审计接口。

Profile 不再引用 `recipeId` 或 `adapterId`，只引用 `callableId`。

## 7. Pipeline v2

手工 JavaScript 中常见的 JSON 序列化、编码、调用和封装应变成可审计的类型化节点：

```ts
type PipelineNode =
  | { kind: "context.read"; path: string }
  | { kind: "builtin"; operation: BuiltinOperation; inputs: NodeRef[]; options?: object }
  | { kind: "page.call"; callableId: string; arguments: NodeRef[] }
  | { kind: "output.write"; destination: string; source: NodeRef; encoding: ValueEncoding }
```

首批 `BuiltinOperation`：

```text
value.literal
json.stringify
json.parse
text.toString
url.encode
url.decode
base64.encode
base64.decode
hex.encode
hex.decode
object.pick
object.compose
form.compose
```

`value.literal` 只允许字符串、数字、布尔值或 `null`，用于编译器生成固定的协议元数据，例如表单
`Content-Type`。它不接受输入，也不能持有函数、对象或页面秘密。

每个节点有明确输入输出类型和大小预算。未知操作不能通过 AI 临时创造；用户确实需要自定义代码时，进入独立的高级节点，并沿用程序 Eval 的高风险授权。

## 8. 推断候选

候选不是立即生效的 Profile：

```ts
interface BrowserProfileInferenceCandidate {
  id: string
  recordingId: string
  traceId: string
  target: BrowserTarget
  request: { eventId: string; method: string; url: string }
  direction: "request" | "response"
  status: "ready" | "capture-required" | "mapping-required" | "insufficient-evidence"
  confidence: { score: number; level: "high" | "medium" | "low" }
  summary: string
  pipeline: PipelineNodeDraft[]
  evidence: InferenceEvidenceRef[]
  missing: InferenceMissingStep[]
  aiContext: BrowserInferenceAIContext
}
```

置信度不是 AI 的主观百分比。分数由固定规则产生，并在 UI 中解释：

- 请求字段与加密输出 exact link：强加分；
- 可重复 callable 已保留：强加分；
- 同一用户 Trace 且顺序正确：中等加分；
- 仅时间接近：弱加分；
- 多个同分候选：降分；
- 缺少输入映射或输出封装：状态不能为 ready。

## 9. 自动业务函数捕获

低层 `CryptoJS.AES.encrypt` 或 `crypto.subtle.encrypt` 往往不足以构造完整线上报文。推断器应把它作为断点入口，然后寻找上层业务函数。

```text
候选指出需要业务 callable
  -> 用户点击“自动捕获完整加密流程”
  -> 插件在已知低层调用处 arm 一次性断点
  -> 用户重复相同操作
  -> 页面暂停并立即显示控制面
  -> 后台排除 Hook/依赖帧，并使用多来源共同祖先提示排序页面帧
  -> 纯函数用 selected-frame；负责 DOM 取值/组包/发送的函数用 request-transaction
  -> 页面立即恢复
  -> 新明文映射到参数或页面控件，仅返回被拦截的线上 envelope
```

录制器只从每个来源事件的有界同步栈提取页面帧提示，并对 `functionName + script URL` 求交集；支持来源更多、平均深度更浅的共同祖先优先。捕获入口选择最早已确认的密码来源，而不是已经离开上层异步函数后的 Fetch 边界。后台再结合真实 CDP `scriptId`、函数位置、来源分类和副作用检查做最终选择，因此前端不能通过提交 URL、行号或函数名把任意对象伪装成推荐帧。

当最高候选唯一、可解析且未发现副作用时，默认路径使用 `selected-frame`。如果多个密码来源的最近共同页面祖先本身包含网络、DOM 或条件导航，系统不会跳过它去选更外层的事件 handler，而是建立 `request-transaction`：保留真实函数、receiver 和固定参数，在页面内替换明文控件，拦截唯一的目标 Fetch/XHR/Beacon/Form，校验所有预期输出字段后回滚 DOM。

存储副作用、多个或未授权请求、无法唯一绑定函数、或共同祖先证据并列时，系统保持页面暂停并解释原因。函数引用表达式只存在于高级模式。页面暂停不等待远程 AI；AI 只能在页面恢复后基于同一份有界证据做解释和候选补丁。

函数捕获后，后台从 `Function.prototype.toString` 恢复包括默认参数在内的有序参数名。单参数业务函数默认读取整个逻辑 Body；多参数且名称可靠时，引导配置生成 `body.<parameter>` 读取节点；`arg0` 这类占位名不会被冒充为已确认字段。Options 同时从已授权暂停帧的 local/block/closure scope 取同名原始值，构造一次性的本地回放 Body。完整暂停作用域始终只存在于当前会话；只有用户明确生成并保存明文网关后，选中的短时样本才会复制到独立的本机回放草稿。该草稿按 `profileId + request/response` 隔离，不写入 Profile、Bridge、审计、Yak/AI、诊断或导出，并可由用户单独清空。

### 9.1 多密码调用按请求建图

一个请求可能同时包含 AES ciphertext、RSA-encrypted session key、HMAC signature、nonce 和 timestamp。即使每个低层输出都与请求字段精确匹配，也不能把这些调用分别保存后独立回放：它们可能共享同一随机 key、IV、nonce 或闭包状态。

推断器因此按请求边界合并多个来源，生成一个 request-level candidate：

```text
plaintext -----------------> AES.encrypt ----------> body.data
dynamic AES key -----------> JSEncrypt.encrypt ----> body.encryptedKey
canonical request fields --> HMAC.sign ------------> header.X-Sign
                               |
                               +-- 同一上层业务 callable 保证动态值一致
```

界面展示每个密码调用及其线上目标，但状态固定为 `capture-required`。用户点击“自动捕获完整加密流程”时，Deep Capture 优先在仍保留上层业务调用栈的密码来源处武装断点，并捕获一次上层业务封装；系统不会把多个看似 ready 的低层调用拆成多个可执行 Profile，也不会误导用户反复缩短已经足够短的录制操作。

### 9.2 请求事务的输入与输出契约

`request-transaction` 对明文只暴露一个 `body` 输入槽，对 Pipeline 返回被页面业务代码生成的整个请求 Body。因此 AES + RSA 之类多输出流程会直接编译为：

```text
context.read(body)
  -> page.call(sendDataAesRsa 请求事务)
  -> output.write(body)
```

事务保留暂停现场的 URL/event/receiver 等固定参数。逻辑 Body 是对象时，先按 input `name/id` 向页面控件做同名映射；参数名明确是 `payload/data/body/request/params/input` 时才直接替换参数。已混淆的单参数如果其保留值解析后等于目标 URL，必须继续保留，不得被明文对象覆盖。

## 10. AI Agent 集成

### 10.1 绑定资源

Yakit 从浏览器集成页启动 AI 分析时，附加一个类型化资源：

```text
AttachedResourceInfo.type = browser_session
AttachedResourceInfo.key  = context
```

Value 只在 Yak 进程内解析，包含 device、grant、document、selected trace 和 candidate ID。渲染给模型的内容只包含安全摘要，不暴露 device token、grant secret 或录制值。

资源必须绑定：

```text
timeline session
AI task
deviceId
grantId
tabId + frameId + documentId + origin
expiresAt
```

### 10.2 Agent 工具

不要把几十个 Bridge RPC 原样暴露给模型，也不要提供通用 `method + params` 工具。首批提供三个领域工具：

```text
browser_observe
  page summary / actionable nodes / trace / inference / status / diff

browser_inference
  list candidates / inspect evidence / arm capture / choose callable /
  propose mapping / compile candidate / local replay

browser_act
  stable node action / tab activation / human handoff
```

工具回调从当前 AI task 的 `browser_session` 资源解析绑定，AI 参数中不存在 `deviceId`、`grantId` 或任意 Bridge method。

`browser_observe` 默认只读；`browser_inference` 的读取和推断无需额外确认，arm debugger、创建 callable 和发布 Profile 使用现有细分 scope；`browser_act` 遵循 Agent review policy 和人机接管状态。

### 10.3 AI 输出 Schema

AI 只能返回候选补丁：

```ts
interface AIInferencePatch {
  candidateId: string
  labels: Array<{ evidenceId: string; role: SemanticRole; reason: string }>
  preferredFrameId?: string
  argumentBindings?: Array<{ slotId: string; contextPath: string; reason: string }>
  suggestedBuiltins?: Array<{ operation: BuiltinOperation; evidenceIds: string[] }>
  unresolved: string[]
}
```

Candidate Merger 必须验证所有 ID 存在、document 未变化、操作在白名单内、映射路径合法。验证失败只产生新的待处理项，不能退化为执行 AI 代码。

## 11. UI / UX

录制是入口，自动推断是录制完成后的主结果。三列工作台保持不变：

```text
Trace 列 | 数据流与候选 | 推断证据 / 下一步
```

右侧主区域按状态显示：

- `ready`：一键生成 Profile；
- `capture-required`：解释原因并提供“自动捕获完整加密流程”；
- `mapping-required`：只让用户选择少量无法确定的明文字段；
- `insufficient-evidence`：建议重新录制，并明确缺少哪类证据。

证据采用三种强度：

- 已证实：实线和明确措辞；
- 有支持：普通文本并展示依据；
- 待确认：虚线或次级文本，不使用成功色。

AI 是候选的解释者，不单独占据一个聊天面板。主要入口是“让 AI 深入分析”，结果回填到同一证据区域。需要继续对话时再打开 Yakit AI 会话，并携带相同 `browser_session` 资源。

手工 Pipeline 编辑器移入“高级编辑”，默认只展示推断出的可读流程和少量可修改字段。

默认 Profile 编辑器不是节点画布，而是三个业务决定：

```text
1. 明文从哪里来
2. 交给哪个页面函数
3. 线上结果写到哪里
```

当第三步选择“写入表单字段”并填写 `encryptedData` 时，编译器自动生成
`form.compose(keys=["encryptedData"])`、固定 Content-Type、Header 输出和 Body 输出。用户不需要看到或填写
`keys`、节点 ID、输入引用和输出引用。已有非规范 DAG 不会被静默改写，只能继续在高级模式中编辑，或由用户明确替换为引导流程。

## 12. 性能预算

- 单次快照最多 500 事件、每事件 48 个 evidence；
- 图构建使用 fingerprint/path 索引，目标复杂度 `O(E + V)`；
- normalized link 每值最多生成 8 个白名单变体；
- 候选最多 16 个，发送给 AI 的候选最多 3 个；
- scope 每次最多 8 个 frame，源码片段按需读取并限制总字节；
- 推断结果按 `recordingId + event revision` 缓存，增量追加事件时只处理新增部分；
- 不在页面主线程执行全量源码搜索、AST 构建或全局 JSON/URL 编码 Hook；
- Pipeline 在目标 document 内一次执行完成，每次请求/响应只跨扩展到页面边界一次，不按节点往返；
- 页面暂停路径绝不等待网络或 AI。

## 13. 隐私与授权

- 默认推断只使用指纹、类型、长度、路径、算法摘要和源码位置；
- 敏感录制预览即使被用户开启，也不自动进入 AI context；
- Key、IV、CryptoKey 和闭包值只显示语义、类型与长度；
- 源码片段可能包含硬编码 secret，发送 AI 前先进行字面量脱敏并由用户授权；
- 推断读取使用 `browser.recording.read`；
- scope/source 深入读取使用 `browser.debugger.read`；
- arm/resume 与 callable 创建使用 `browser.debugger.control`；
- callable 创建、执行与本地回放使用 `browser.callable.execute`；从暂停 frame 捕获 callable 还需要 `browser.debugger.control`；
- Profile 发布使用 `browser.transform.manage`；
- document、origin 或 grant 变化后候选立即标记 stale，不静默重绑。

## 14. 生命周期与恢复

Profile 是 document-bound。刷新后不能继续调用旧闭包，但推断定义可以保留为恢复计划：

```text
页面刷新
  -> callable stale
  -> Profile disabled
  -> 插件按原 operation / script / route 重新 arm
  -> 用户正常执行一次业务操作
  -> 重新捕获 callable
  -> 本地样本校验
  -> 用户确认后重新启用
```

恢复计划不保存 key 或源码计算结果，只保存捕获入口、业务 frame 特征、参数语义和映射结构。

## 15. 分阶段实现

### P0：证据与候选基线

- [已完成] 使用统一 `crypto` 事件记录 WebCrypto / CryptoJS / JSEncrypt / sm-crypto / node-forge 的 adapter、provider kind、family、调用、参数角色、类型、长度和 state/retained 状态；
- [已完成] MAIN-world 密码适配器注册表支持稳定 adapter 与运行时晚加载 adapter；
- [已完成] JSEncrypt RSA encrypt/decrypt/sign/verify 保留真实 receiver，并仅输出公私钥类型、位数和加盐指纹；
- [已完成] 为 CryptoJS 结果补充安全的字符串表示 evidence；
- [已完成] 从 exact link、请求字段和调用顺序生成只读候选；
- [已完成] Options / Yakit 展示置信度、证据和缺失步骤；
- [已完成] 候选结构可通过 `browser.recording.get` 提供给 Agent。

### P1：统一 Callable 与 Pipeline v2

- [已完成] 删除 recipe / adapter 双模型，不保留旧方法别名或迁移分支；
- [已完成] 页面 callable 使用统一注册表、来源信息、生命周期和命名 input slot schema；
- [已完成] Pipeline v2 使用有序 DAG，并加入类型化 context.read / builtin / page.call / output.write 节点；
- [已完成] builtin 限定为 JSON、文本、URL、Base64、Hex、对象和表单组合白名单；
- [已完成] 输出支持 body、字段级 body、header 和 query，并由 Yak 二次限制 URL 只能改变 query；
- [已完成] 单条 exact value link 且保留可执行调用句柄的 stateless/receiver 模式可直接编译候选；stateful/stream 模式必须捕获上层 callable；
- [已完成] 同一请求的多个密码来源合并为 request-level candidate，并强制捕获上层业务 callable 以保持动态值关系；
- [已完成] JSON 字段、表单字段、Header、Query 和完整 Body 会编译为对应的引导式输出，不要求用户理解 DAG；
- [已完成] 录制短时样本自动填入 Options/Yakit 明文网关本地回放，并允许编辑后恢复原样本；
- 为页面内回放生成确定性/结构性断言。

### P2：自动业务函数捕获

- [已完成] 候选一键 arm，并在已有捕获等待或页面暂停时拒绝覆盖；
- [已完成] 业务 frame 使用来源、边界距离、函数可解析性、副作用、命名和作用域信息做确定性排序；
- 参数槽位与 request context 自动映射；
- 文档刷新后的引导式重新捕获。

### P3：Yak AI Agent

- `browser_session` attached resource；
- task-bound 三个 Agent 工具；
- AIInferencePatch schema 与 Candidate Merger；
- Yakit 从候选直接启动带上下文的 AI 会话；
- Agent 操作写入现有 session timeline。

### P4：复杂应用

- Axios/interceptor、GraphQL、WebSocket frame、protobuf 与自定义 serializer；
- [已完成] 按通用化路线迁移 adapter host，加入 sm-crypto、node-forge 与 Beacon/Worker/MessagePort 边界，并通过随机 ESM + WASM holdout；
- jsrsasign、jose 与后续现代密码生态按真实样本继续推进；
- sourcemap 存在时的业务 frame 增强；
- 多候选对比和跨操作共用 callable 识别。

P4 的实现顺序、协议草案、性能门禁和随机化测试矩阵以 [`FRONTEND_CRYPTO_GENERALIZATION_ROADMAP.md`](FRONTEND_CRYPTO_GENERALIZATION_ROADMAP.md) 为准。

## 16. 验收夹具

至少覆盖：

1. 固定 CryptoJS AES，混淆变量名，JSON 字段输出；
2. 真实 JSEncrypt RSA + form-urlencoded `data` 字段，独立服务端用私钥解密验收；保留实例 receiver，停止录制后对象明文仍可回放；
3. RSA 候选和 AI 上下文只包含 key 类型、位数与加盐指纹，不包含 PEM 或模数；
4. WebCrypto AES-GCM + HMAC，闭包内不可导出 key 和动态 nonce/IV；
5. AES + RSA + HMAC 同请求多来源图，不允许拆分低层调用回放；
6. 动态 key promise，页面刷新后重新捕获；
7. Axios interceptor 中的请求签名；
8. Form URL encode 和 Header signature；
9. 自定义业务 wrapper，低层库调用不足以构造完整报文；
10. 未知函数与多个同分业务 frame，AI 只能补全候选，不能直接执行代码；
11. WASM 导出函数，只能观察输入输出和业务 wrapper；
12. 敏感预览开启时，AI payload、审计和诊断仍不含原始值；
13. 500 事件 / 24,000 evidence 的性能与内存预算。

## 17. 目标目录

```text
src/features/browser-recording/
  evidence.ts
  recorder.ts

src/features/browser-inference/
  graph.ts
  normalize.ts
  rules/
  candidates.ts
  compiler.ts
  ai-context.ts

src/features/browser-callable/
  registry.ts
  execute.ts
  lifecycle.ts

src/features/browser-transform/
  pipeline-v2.ts
  profile.ts
  replay.ts
```

Yak 侧将 `browser_session` 资源解析和 Agent 工具放在独立包中，依赖一个最小的 Bridge caller interface，避免 `common/ai` 直接依赖 gRPC Server。
