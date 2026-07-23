# 前端密码能力通用化重构与适配器路线

> 状态：G0–G4 已完成并通过真实浏览器/独立验证器验收；G5 按真实样本继续推进
>
> 更新时间：2026-07-21
>
> 关联文档：[`AUTO_PROFILE_INFERENCE_ARCHITECTURE.md`](AUTO_PROFILE_INFERENCE_ARCHITECTURE.md)、[`DEEP_CAPTURE_ARCHITECTURE.md`](DEEP_CAPTURE_ARCHITECTURE.md)、[`BROWSER_TRANSFORM_GATEWAY.md`](BROWSER_TRANSFORM_GATEWAY.md)、[`study.md`](study.md)

## 1. 结论

当前实现的**数据模型、请求推断和 G4 高价值协议覆盖是通用的；WASM、流式协议与长尾生态仍需由真实样本继续驱动**。

现有靶场体验顺滑，主要因为它同时满足了三个有利条件：

1. 使用全局可访问的 `window.CryptoJS` 或 `window.JSEncrypt`；
2. 加密后通过常规 Fetch/Form 请求发送；
3. 密码调用输出可以和请求字段建立精确值关联。

生产代码并没有依赖 `127.0.0.1:82`、`/encrypt/aes.php`、`/encrypt/rsa.php`、固定用户名、固定密码或固定业务字段。请求字段推断也已经支持 JSON、Form、Header、Query 和完整 Body。因此当前实现不是为靶场硬编码的结果。

但“没有靶场硬编码”不等于“已经覆盖真实世界”。当前 MAIN-world 录制器通过有界 manifest 为以下可访问对象安装语义 Hook：

- 当前页面 Realm 的 `SubtleCrypto`；
- `CryptoJS`、`JSEncrypt`、`sm-crypto` 与 `node-forge`；
- `jsrsasign` 的 Signature/JWS/JWT/JWK；
- 页面显式暴露的 `jose` 高层 builder 与 verify/decrypt 函数。

没有全局导出的 ESM/Webpack 闭包、Worker 内密码运算、WASM 和完全未知的业务封装不会通过侵入 bundler cache 强行发现；它们继续走请求/消息边界、WebCrypto、证据图和 Deep Capture 业务闭包恢复。这是正式的通用路径，不是失败后的临时兜底。

因此本轮重构采用以下产品判断：

> 已知库适配器是语义加速器，不是产品能力的地基。请求与消息边界、业务函数恢复、文档绑定 callable 和服务端认可的真实回放，才是通用能力的地基。

最终验收不是“界面显示识别到 AES/RSA”，而是：

```text
用户执行一次真实操作
  -> 插件定位明文、页面业务调用和线上目标
  -> 已知库时给出准确算法语义，未知库时仍能定位业务封装
  -> 页面保留 key / IV / nonce / receiver / closure / WASM 状态
  -> Yakit Web Fuzzer 编辑明文
  -> 浏览器生成真实线上报文
  -> 独立服务端成功解密、验签或接受请求
```

算法名称可以暂时未知，业务链路不能因此不可用。

## 2. 重构目标与非目标

### 2.1 目标

- 支持全局库、打包闭包、混淆函数、Worker 消息边界和 WASM 外围业务函数；
- 已知密码库接入同一 adapter contract，不再把逻辑堆入 MAIN-world 录制器；
- 未知库也可以从请求/消息边界进入 Deep Capture，恢复上层业务 callable；
- 自动 Profile 以请求为中心，保留 AES + RSA + HMAC + timestamp 等同一业务上下文；
- 页面秘密始终留在页面对象、闭包、CryptoKey 或 WASM 内存中，不通过协议导出；
- 适配器安装、事件归一化、证据建图、AI 分析和 Profile 执行各自独立；
- 使用随机化、跨打包形态的真实服务端夹具证明没有按图索骥；
- 在录制开启时保持有界开销，录制停止后完整恢复页面 API 且不存在后台轮询。

### 2.2 非目标

- 不追求穷举所有 JavaScript 密码库；
- 不要求先还原算法、密钥或混淆源码才能使用明文网关；
- 不把页面 key、PEM、CryptoKey、闭包变量或 WASM 内存导出到扩展、Yak 或 AI；
- 不在页面主线程进行全量源码搜索、全局对象枚举或 AST 扫描；
- 不为某个站点、接口路径、字段名或靶场流程维护特殊规则；
- 不保留旧 provider 枚举、旧录制协议或旧适配器目录的迁移兼容层。

## 3. 四层通用架构

```text
L0 业务边界探针
   Fetch / XHR / Form / sendBeacon / WebSocket / Worker / MessagePort / Navigation
        |
        | 有界输入输出、调用顺序、同步/异步栈、值关联
        v
L1 通用运行时边界
   WebCrypto / random / encoding / WebAssembly 装载 / serializer 边界
        |
        | 原生算法元数据、TypedArray 形态、opaque object
        v
L2 已知语义适配器
   CryptoJS / JSEncrypt / sm-crypto / node-forge / jsrsasign / jose / sodium ...
        |
        | 参数角色、模式、padding、state model、可复跑能力
        v
L3 未知业务函数恢复
   请求断点 -> 页面业务帧排序 -> closure callable -> 自动 Profile
```

四层不是按顺序全部执行的流水线。L0 始终提供兜底证据；L1/L2 提供更强语义和更精确的断点；L3 在低层 primitive 不足、库不可见或业务封装复杂时恢复完整现场。

### 3.1 L0：业务边界是最低保证

请求和消息边界回答三个最重要的问题：

1. 哪段值真正离开了页面；
2. 它被写入 Body、字段、Header、Query、WebSocket frame 还是 Worker 消息；
3. 哪个页面调用链在边界之前构造了它。

现有 Fetch/XHR/Form/WebSocket 继续保留，并补齐：

- `navigator.sendBeacon`；
- `Worker.prototype.postMessage`；
- `MessagePort.prototype.postMessage`；
- `SharedWorker.port` 消息边界；
- 有界同步栈和可用时的异步栈来源；
- TypedArray、ArrayBuffer、Blob、FormData 和 transferable 的结构化摘要；
- 同一 Trace 内从输入、消息到请求的精确/归一化值关联。

页面侧边界看不到 Worker 内部每一步是事实，不应伪装成已识别。即使 Worker 内部无法安装密码适配器，插件仍可关联“页面明文消息 -> Worker 返回值 -> 请求字段”，并以消息边界或调用 Worker 的页面业务函数作为 callable 捕获入口。

Service Worker 内部运算不属于普通页面 MAIN world。第一阶段只保证通过 `webRequest` 和页面消息/请求边界观察真实线上结果；更深的 Worker/Service Worker 调试目标支持需要独立评估 CDP Target 生命周期，不能和页面适配器混为一个实现。

### 3.2 L1：通用运行时边界

首批运行时探针包括：

- WebCrypto `SubtleCrypto`；
- `crypto.getRandomValues` 和 `randomUUID` 的调用关系摘要，不记录随机原值；
- `TextEncoder` / `TextDecoder`、Base64、Hex 等有界编码链；
- `WebAssembly.instantiate` / `instantiateStreaming` 的模块与实例身份摘要；
- 请求边界处的 JSON、Form、Query 和 Header 结构化解析。

不得全局 Hook 每一次 `JSON.stringify`、`encodeURIComponent` 或遍历所有 WASM exports。高频通用函数只在请求边界归一化，或在已确定的 Trace/Deep Capture 窗口内按需观察，避免让正常页面承担持续成本。

WASM 的第一目标不是反编译算法，而是保留调用它的页面业务 wrapper、输入输出关联和实例生命周期。只要该 wrapper 能在原页面复跑，明文网关就不需要导出 WASM 内存或重写算法。

### 3.3 L2：已知语义适配器

适配器负责把“某个函数被调用”解释成统一语义：

- provider/adapter 身份；
- symmetric、asymmetric、digest、MAC、signature、KDF 或 key-management family；
- data、key、iv、nonce、aad、signature、options 等参数角色；
- algorithm、mode、padding、input/output encoding；
- stateless、receiver-bound、stateful-session、streaming 或 async-ready 状态模型；
- 是否可以安全保留原函数、receiver 和参数模板作为 recorded-call callable。

适配器不负责请求字段推断、UI 文案、AI prompt、Profile 编译或 Bridge RPC。新增库不应修改这些下游层。

### 3.4 L3：未知业务函数恢复

“不知道是哪一个库”不能成为终点。通用回退流程是：

```text
请求/消息边界已定位
  -> 武装下一次相同边界
  -> 用户重复一次真实操作
  -> 立即发布有界调用栈
  -> 排除 extension hook 和已知依赖 frame
  -> 结合参数相关性、请求接近度、源码位置、同步/异步父栈给业务 frame 排序
  -> 捕获完整业务 closure callable
  -> 页面恢复
  -> 用短时样本做页面内回放
```

页面函数叫 `encryptPayload`、`pack`、`request` 或 `_0x3f2a` 都不影响流程。AI 可以解释 frame 和参数语义，但只能返回引用既有 evidence 的候选补丁，不能生成并直接执行任意代码。

## 4. 适配器协议重构

### 4.1 删除封闭 provider 枚举

当前 `BrowserCryptoProvider` 是 `webcrypto | cryptojs | jsencrypt | forge | custom` 的封闭联合。继续添加库会迫使协议、归一化器、UI 和测试重复修改。

新协议使用有界 adapter ID 和稳定 provider kind：

```ts
type BrowserCryptoProviderKind =
  | "native"
  | "library"
  | "business"
  | "wasm"
  | "unknown"

interface BrowserRecordingCrypto {
  adapterId: string              // 受限 slug，例如 "webcrypto"、"sm-crypto"
  providerKind: BrowserCryptoProviderKind
  family: BrowserCryptoFamily
  operation: string              // 适配器内部稳定 operation ID
  algorithm?: string
  mode?: string
  padding?: string
  inputEncoding?: BrowserPageCallableValueEncoding
  outputEncoding?: BrowserPageCallableValueEncoding
  state?: {
    model: "stateless" | "receiver" | "session" | "stream" | "async-ready"
    correlationId?: string
    phase?: "create" | "init" | "update" | "final" | "one-shot"
  }
  key?: {
    kind: "public" | "private" | "secret" | "unknown"
    bits?: number
    fingerprint?: string
  }
}
```

`adapterId`、`operation` 和所有字符串必须限长并按字符集校验。UI 显示名来自扩展自带的 adapter manifest，不信任页面提供的 HTML 或展示文本。未知 ID 使用安全的纯文本回退标签。

Deep Capture 不再依赖 `CryptoJS.AES.encrypt` 这类展示字符串查找函数，而是绑定录制器已经保留的 wrapper handle：

```text
adapterId + operation + wrapperHandleId + documentId
```

这样库被混淆、别名导出或方法名重复时，也不会武装错误函数。

### 4.2 统一 adapter contract

```ts
interface PageCryptoAdapter {
  manifest: {
    id: string
    displayName: string
    providerKind: BrowserCryptoProviderKind
    dynamic: boolean
  }
  discover(context: AdapterDiscoveryContext): AdapterTarget[]
  install(target: AdapterTarget, host: AdapterHost): AdapterInstallation
}

interface AdapterInstallation {
  id: string
  operations: InstalledOperation[]
  restore(): void
}

interface AdapterHost {
  wrap(input: WrapOperationInput): InstalledOperation
  emit(input: NormalizedCryptoCall): void
  retain(input: RetainedCallInput): string | undefined
  fingerprint(value: unknown): ValueEvidence[]
}
```

公共 `wrap` 基础设施必须统一处理：

- 原 property descriptor、原函数和原 receiver；
- 同步返回、Promise resolve/reject 和库返回 `false/null` 的语义；
- re-entrancy 防护，避免适配器调用辅助方法时递归记录；
- 参数与输出大小预算；
- wrapper handle 与 Deep Capture 一次性断点；
- 页面后续替换函数时不覆盖页面的新值；
- restore 只恢复自己仍然拥有的 descriptor；
- 停止、清空、导航、grant 撤销和异常安装时的幂等清理。

适配器只能使用 host 提供的 evidence、emit 和 retain 能力，不各自维护事件队列、Trace、指纹算法或 callable registry。

### 4.3 状态型与流式 API

不能把所有库都按 `encrypt(data, key) -> ciphertext` 的一次函数处理。

例如 node-forge 常见调用链是：

```text
createCipher -> start -> update -> finish -> output
```

jsrsasign 的签名流程可能是：

```text
new Signature -> init -> updateString/updateHex -> sign
```

这些调用需要同一 `correlationId` 和 phase 序列。只有满足以下条件才允许生成 recorded-call callable：

- 可替换明文输入明确；
- 原 receiver/session 仍有效；
- 重放不会复用已经消费的流状态；
- 输出与请求目标存在 proven link；
- 调用没有网络、DOM、导航等额外副作用。

不满足时适配器只提供语义证据，并把候选标记为 `capture-required`，由 Deep Capture 保留上层一次性业务封装。

### 4.4 晚加载与打包形态

现有每秒扫描动态全局库的方式需要替换为有界调度：

- 录制开始时立即检查一次已知全局路径；
- 捕获动态 `<script>` load 后检查相关 adapter；
- 在交互、请求或消息边界前执行去重后的轻量 ensure；
- 必要时使用短期指数退避检查，达到预算后停止；
- 录制停止后不存在 timer 或扫描；
- 不枚举整个 `window`，只访问 manifest 声明的有界路径。

ESM/Webpack 闭包没有全局路径时，适配器不得尝试侵入 bundler module cache。此时依赖 L0 边界和 L3 业务函数恢复；这不是降级错误，而是设计好的通用路径。

## 5. 高价值库路线

优先级根据真实安全测试价值、浏览器出现频率、与现有能力互补程度和接入复杂度确定，不按 npm 下载量机械排序。

| 优先级 | 能力 | 主要价值 | 适配重点 | 产品行为 |
| --- | --- | --- | --- | --- |
| P0 | WebCrypto、CryptoJS、JSEncrypt | 当前基线 | 迁移到新 contract，行为不回退 | 继续支持 direct callable 与业务捕获 |
| P1 | `sm-crypto` | 国内系统常见 SM2/SM3/SM4 | mode、cipher mode、签名选项、编码与 key 摘要 | 一次函数可直连；组合链按请求捕获 |
| P1 | `node-forge` | RSA/PKI、AES、digest、HMAC、证书工具覆盖广 | receiver、cipher session、buffer、start/update/finish | 状态型默认捕获上层业务 callable |
| P2 | `jsrsasign` | RSA-PSS、ECDSA、JWS/JWT/JWK/X.509 | constructor session、update/sign/verify、编码 | 签名 envelope 以请求级候选处理 |
| P2 | `jose` | 现代 JWS/JWE/JWT/JWK/JWKS | Promise、WebCrypto、高层协议对象、ESM | 优先保留高层 async callable |
| P3 | `libsodium.js` | secretbox/box/sign、XChaCha、现代密码原语 | `sodium.ready`、TypedArray、JS/WASM 双实现 | async-ready adapter + 业务 wrapper |
| P3 | `TweetNaCl.js` | box/secretbox/sign 的轻量实现 | nonce/key TypedArray 与固定长度元数据 | 一次调用与请求字段关联 |
| P3 | `noble-*` | 现代曲线、hash、cipher 的模块化 ESM | 无全局对象、纯 ESM、细分包 | 以通用边界为主，显式导出时增强语义 |
| P4 | `OpenPGP.js` | PGP 消息、签名、密钥与流式处理 | async、stream、复杂对象和大数据预算 | 捕获高层业务调用，不展开低层原语 |

第一轮实际编码范围固定为：

1. 适配器基础设施与现有三种 provider 迁移；
2. Worker/MessagePort/sendBeacon 边界和未知业务函数回退；
3. `sm-crypto`；
4. `node-forge`。

`jsrsasign` 和 `jose` 紧随第一轮，但必须等状态模型和 async callable 在前两种新适配器上验证稳定后再进入。`libsodium.js`、TweetNaCl、noble 和 OpenPGP 不阻塞第一轮发布。

不优先为 SJCL、asmCrypto.js 等历史库建立专用 adapter。它们仍可走未知业务 callable；只有真实用户样本证明专用语义能显著降低操作成本时再加入。

### 5.1 非密码但必须纳入链路的转换

真实报文还常包含 serializer/compression，而不仅是密码 primitive：

- Axios interceptor；
- protobuf / protobufjs；
- MessagePack；
- gzip/deflate/pako；
- canonical JSON、参数排序、时间戳、requestId；
- URL/Form/Header 拼装。

这些能力不伪装成 crypto adapter。它们进入独立 transform/serializer evidence，最终与 crypto event 一起组成 request-level graph。明文网关必须保留整个 envelope，而不是只复跑某一个 AES 函数。

## 6. 目录设计

重构前 `page-recorder-main-world.ts` 同时包含录制状态、请求 Hook、密码库 Hook、指纹、callable 和执行逻辑，接近 1,500 行。G1–G3 已把 adapter contract/registry、五个库 adapter、通信边界、业务 frame 排序和 retained-call 预算移出入口；Fetch/XHR/Form/WebSocket、evidence/trace 与编码探针仍按下面的目标目录继续做物理拆分：

```text
src/entrypoints/page-recorder-main-world.ts
  只负责启动、协议握手和生命周期编排

src/features/browser-recording/main-world/
  recorder-host.ts
  event-budget.ts
  evidence.ts
  trace.ts
  retained-call.ts
  boundaries/
    fetch.ts
    xhr.ts
    form.ts
    beacon.ts
    websocket.ts
    worker-message.ts
    navigation.ts
  runtime/
    webcrypto.ts
    encoding.ts
    wasm.ts

src/features/browser-crypto/adapters/
  contract.ts
  registry.ts
  wrapper.ts
  webcrypto.ts
  cryptojs.ts
  jsencrypt.ts
  sm-crypto.ts
  node-forge.ts
  jsrsasign.ts
  jose.ts

src/features/browser-inference/
  graph.ts
  normalize.ts
  business-frame-ranker.ts
  rules/
  candidates.ts
  compiler.ts
  ai-context.ts
```

WXT 仍将这些模块编译进一个 MAIN-world entrypoint；拆文件是为了责任边界、独立测试和 tree-shaking，不意味着跨 world 增加消息往返。

## 7. 自动推断与 UI 契约

### 7.1 已知库

用户看到：

```text
已识别：sm-crypto SM2.encrypt
明文：argument 0
线上目标：body.data
证据：精确值关联 + 同一 Trace + 页面 callable 可用
```

### 7.2 未知库或闭包模块

用户看到：

```text
已定位：请求发送前的页面封装函数
算法：尚未命名，不影响继续捕获
线上目标：header.X-Sign + body.payload
下一步：重复一次操作，插件将保留完整页面函数
```

不得显示“未支持该密码库，所以无法继续”。只要 L0/L3 仍有路径，就应清楚说明已经知道什么、还缺什么，以及用户只需要完成哪一个真实动作。

### 7.3 候选状态

- `ready`：单一、无副作用、可复跑的调用已经与一个线上目标形成 proven link；
- `capture-required`：状态型 API、多密码调用、动态 key/nonce、未知闭包或完整 envelope 需要上层业务 callable；
- `mapping-required`：页面能力已保留，但明文来源或线上目标存在多个同分候选；
- `insufficient-evidence`：没有请求/消息边界或没有可验证的数据关联。

“算法未知”本身不构成 `insufficient-evidence`。

## 8. 防止靶场特化的测试矩阵

### 8.1 夹具维度

每种核心能力至少覆盖三种发布形态：

1. UMD/global；
2. Vite/Webpack/Rollup ESM closure；
3. Worker 或 WASM 外围业务 wrapper。

夹具按 seed 随机生成：

- URL 和接口路径；
- JSON/Form/Header/Query 字段名；
- 函数名、变量名和模块 chunk 名；
- JSON 嵌套深度与字段顺序；
- 编码链；
- 同一页面上的无关密码调用数量；
- 请求使用 Fetch、XHR、Form、sendBeacon 或 WebSocket；
- 跳转、SPA 路由和 BFCache 行为。

测试只保存 seed 和预期语义，不把固定字段名写入生产推断规则。采用 pairwise 组合覆盖主要交互，不构造不可维护的完整笛卡尔积。

### 8.2 正向场景

- CryptoJS AES、WebCrypto AES-GCM/HMAC、JSEncrypt RSA 当前能力不回退；
- sm-crypto 的 SM2 加密/签名、SM3、SM4 CBC；
- node-forge RSA 与 stateful AES cipher；
- AES session key + RSA wrapped key + HMAC + timestamp 的同请求 envelope；
- ESM 闭包内未知库只凭请求边界恢复业务 callable；
- Worker 内处理通过 postMessage 输入输出建立关联；
- WASM 内部算法未知，但页面 wrapper 可以生成服务端认可的报文；
- 请求加密和响应解密共用同一文档现场；
- 页面刷新后 callable 明确 stale，并能按恢复计划重新捕获。

### 8.3 反例场景

- 库已加载但从未参与目标请求；
- 同一种加密调用发生多次，只有一个输出进入请求；
- 两个输出内容相同但属于不同 Trace；
- 加密结果经过 Base64、URL encode、JSON/Form 包装后才进入请求；
- 页面在 Hook 后替换函数，停止录制不得覆盖页面新函数；
- 适配器安装一半失败，其他适配器和页面原 API 必须正常；
- 重放业务函数可能发送网络、修改 DOM 或触发导航时禁止 direct callable；
- 多个同分业务 frame 时不得以高置信度自动选中；
- key、PEM、CryptoKey、nonce 原值、闭包 secret 不得进入事件、AI、审计或诊断导出。

### 8.4 独立验收

每个可以发布为 Profile 的夹具都必须由独立服务端进行最终验证：

- 加密：服务端持有解密材料并恢复用户编辑后的明文；
- 签名：服务端使用独立验证逻辑通过签名；
- 响应解密：浏览器收到真实密文，Yakit 最终看到预期明文；
- 动态参数：连续回放的 nonce/IV/requestId 不得被错误固定；
- 失败路径：浏览器离线、document 变化或 callable 丢失时 fail closed，绝不发送明文。

至少保留一个实现完成前不向推断规则暴露字段/路径的 holdout fixture。它必须只依赖 adapter contract、边界证据和业务函数恢复通过验收。

### 8.5 生产源码泄漏门禁

构建审计增加 fixture leakage 检查：生产模块不得出现靶场 host、固定 endpoint、固定测试账号、seed 或专用字段映射。测试、E2E server 和文档示例可以出现这些值，但必须物理隔离于生产 bundle。

## 9. 性能与稳定性门禁

- 录制未开启时不安装密码/边界 wrapper，不运行 adapter timer；
- 录制停止后 descriptor、listener、timer 和 retained handle 完整清理；
- 不枚举整个 `window`，adapter discovery 只访问 manifest 声明路径；
- 单次事件、单值、单 Trace 和整个 Session 沿用硬预算，超过后计数并丢弃而不是继续分配；
- TypedArray/ArrayBuffer 指纹按大小预算处理，大对象只读取头尾有界片段和总长度；
- 请求边界归一化为 `O(payload bytes + evidence nodes)`，变体数量固定上限；
- event 到 background/UI 使用批量刷新，不因每个密码 primitive 触发 React 重渲染；
- wrapper 不改变原 Promise、异常、`this`、property descriptor 和返回值语义；
- 建立录制关闭、空闲录制、1,000 次小调用、10 次 1 MiB 调用和达到事件上限后的基准；
- 重构前先记录基线，Enterprise Chromium E2E 对 recorder 自身耗时、事件/handle 内存预算和页面返回语义设置回归阈值；包体积继续作为观测指标，不作为替代运行时性能的硬门槛。

## 10. 分阶段实施

### G0：重构基线与测量

- [x] 固化当前 93 项测试和 Chrome Store、Chrome Enterprise、Firefox MV2、Firefox AMO MV3 四渠道构建结果；
- [x] 为 recorder 关闭、运行、停止、1,000 次调用、10 次 1 MiB 调用和上限耗尽建立真实浏览器性能门禁；
- [x] 增加 production fixture leakage 审计；
- [x] 把现有 WebCrypto/CryptoJS/JSEncrypt E2E 设为不可回退基线。

### G1：协议与 adapter host

- [x] 删除封闭 `BrowserCryptoProvider` 和旧 `call` 展示字符串匹配；
- [x] 引入 adapter manifest、开放但有界的 `adapterId`、provider kind 和 state model；
- [x] 抽出 wrapper/descriptor restore、Promise、动态 session discovery、evidence 和 retained-call 预算逻辑；
- [x] 将 WebCrypto、CryptoJS、JSEncrypt 迁入独立 adapter；
- [x] 从 MAIN-world 入口拆出 adapter registry、五个库 adapter、通信边界和 retained-call 预算，不保留旧 adapter 分支；
- [x] Deep Capture 改为 wrapper handle 精确武装。

### G2：通用边界与未知函数路径

- [x] 增加 sendBeacon、Worker、SharedWorker 和 MessagePort 边界；
- [x] 记录有界同步来源、异步 Worker/MessagePort Trace 继承和 channel correlation；
- [x] 建立业务 frame 确定性排序器，并区分 extension hook、依赖库与页面代码；
- [x] 允许从未知请求/消息边界一键捕获业务 callable；
- [x] 算法未知时仍可生成可解释的 `capture-required` 候选；
- [x] 加入随机 ESM closure、真实 Worker 和 WASM instance holdout fixture；模块函数不暴露到 `window`，仍可被保留和复跑。

### G3：第一批高价值适配器

- [x] `sm-crypto`：SM2 encrypt/decrypt/sign/verify、SM3、SM4 encrypt/decrypt；
- [x] `node-forge`：RSA、digest/HMAC、对称 cipher session 与 buffer 输出；
- [x] 状态型 operation correlation、动态 session/output 方法发现和 replay eligibility 判定；
- [x] 独立服务端通过 SM2/SM4/RSA/AES/digest/HMAC/签名验收；
- [x] 全局库、拆分全局、真实 minified bundle、闭包与随机混淆变量共用同一 evidence graph 和推断规则。

### G3.5：自动恢复完整业务闭包

- [x] 多个密码调用按请求合并后，从各来源的有界同步栈提取共同页面祖先，不依赖接口路径、字段名或靶场函数名；
- [x] 以最早仍位于业务闭包内的已确认密码调用作为一次性断点入口，并把共同祖先作为 `frameHints` 交给后台确定性排序器；
- [x] `selected-frame` 由后台使用真实 CDP frame、函数位置和作用域绑定解析函数对象，不接受 UI 伪造的源码 URL 或行号；
- [x] 唯一且无副作用的页面业务帧自动保存为 `business-closure`；最近共同祖先本身负责 DOM 取值、组包和发请求时，保存为 `request-transaction`，不再跳过它去选外层 `onclick`；
- [x] 从函数源码恢复包括默认参数在内的有序参数名；单参数默认接收整个逻辑 Body，多参数且名称可靠时自动编译 `body.<parameter>` 输入映射；
- [x] 暂停帧的固定参数按已解析参数名从 CDP 作用域取值，不使用调试器包装层 `arguments`；混淆参数只有在无 DOM 映射、不是目标 URL 且无更强语义时才可尝试接收逻辑 Body；
- [x] 从已授权暂停现场的 local/block/closure scope 生成一次性本地回放样本；完整暂停作用域不持久化，只有用户明确保存明文网关时选中的短时样本进入独立、有界、可清理的本机回放草稿，且不进入 Profile、Bridge、审计、Yak/AI、诊断或导出；
- [x] `request-transaction` 在 MAIN world 中临时拦截 Fetch/XHR/Beacon/Form，精确校验 method + origin/path/query，把逻辑 Body 映射到同名表单控件，并在执行后回滚控件与有界 DOM 变更；
- [x] 事务只接受唯一目标请求，多请求、未授权 URL、超时、超 8 MiB Body 或缺少任一预期输出字段都 fail closed；普通 callable 在运行时也会拦截透传的网络/Form 副作用；
- [x] 真实 Chromium E2E 从 AES-GCM + HMAC 两个低层调用自动恢复 `buildLoginEnvelope`，生成双参数明文网关并执行完整 Pipeline。
- [x] 真实 `127.0.0.1:82` AES + RSA 流程自动选中 `sendDataAesRsa` 而非 `onclick`，回放产生 `encryptedData/encryptedKey/encryptedIv`，浏览器零真实泄漏请求，独立服务端接受新明文产生的 envelope。

### G4：协议与现代密码生态

- [x] `jsrsasign` 的 Signature/JWS/JWT/JWK 语义；
- [x] `jose` 的 SignJWT/CompactSign/CompactEncrypt 和对应 verify/decrypt；
- [x] Axios interceptor 产生的最终请求、JSON/Query canonicalization 和 Header signature request graph；
- [x] async callable、constructor session 和多输出 envelope 验收。

### G5：WASM、流式与长尾

- [ ] libsodium.js async-ready + JS/WASM 双形态；
- [ ] TweetNaCl 和 noble 系列；
- [ ] OpenPGP.js streaming；
- [ ] protobuf/MessagePack/compression transform evidence；
- [ ] 根据真实样本而不是库清单决定后续专用 adapter。

实施顺序是硬约束：G1/G2 没有通过通用 holdout 之前，不以继续堆叠库 Hook 代替架构重构。

### G0–G3.5 验收记录（2026-07-21）

- 单元/协议测试：26 个测试文件、116 项测试全部通过；
- 类型检查：TypeScript `--noEmit` 通过；
- 构建：Chrome Store、Chrome Enterprise、Firefox MV2、Firefox AMO MV3 全部通过；
- 生产审计：权限、执行渠道、fixture signature 泄漏检查通过；包体积只保留为 advisory；
- 真实浏览器：Chrome Store User Scripts、Chrome Enterprise User Scripts、Chrome Enterprise injected fallback 三条全流程 E2E 均通过；
- 语义 adapter：真实 `sm-crypto` 和真实 minified `node-forge` 浏览器包参与录制，独立 Node 服务端完成解密、摘要比对或验签；这些包只属于 dev/E2E 依赖，不进入插件生产运行时；
- 未知库 holdout：每轮随机生成 ESM 模块 URL、业务函数名、请求 URL 和 JSON 字段，业务函数不挂载到 `window`，闭包持有真实 `WebAssembly.Instance`；Deep Capture 通过 `scriptParsed` 的有界 `scriptId -> URL` 索引恢复来源、确定性选中纯业务帧并保存 callable，随后由独立服务端接受新明文生成的报文；
- Worker holdout：页面明文消息、异步 Worker 返回值和后续 Fetch 保持同一 Trace，消息通道只作为 correlated evidence，不伪装成 exact value link；
- 自动业务闭包：AES-GCM 与 HMAC 的来源栈共同指向未挂载到 `window` 的 `buildLoginEnvelope`；一次重现后自动捕获 `password/account` 两个参数，使用暂停现场样本生成 `body.password/body.account` 映射，并在本地执行完整四节点 Pipeline；
- 请求事务：混淆 AES + RSA 页面的三个密码调用共同指向直接读 DOM 并 Fetch 的 `sendDataAesRsa`；自动捕获后用新账号密码生成三字段 envelope，浏览器请求计数不增加，独立 Node 请求获得服务端 `success=true`；
- 性能样本（当前 WSL/Chromium 三种执行通道，作为回归参考而非跨机器 SLA）：录制关闭时 1,000 次轻量调用约 0.2–0.3 ms，录制开启约 34.0–46.4 ms，10 次 1 MiB 调用约 284.5–308.3 ms；自动化 E2E 使用宽松绝对门禁抵抗机器抖动；
- 内存门禁：事件数、单值、单 handle 和全部 retained handles 同时有界；3 MiB 单次输入仍可留下元数据事件，但不会生成长期持有页面参数的 replay handle；
- 清理：停止后 Fetch、XHR、WebSocket、Beacon、Worker、MessagePort、WebCrypto 和所有库方法恢复为页面原函数，timer/listener/channel context 清空。

### G4 验收记录（2026-07-21）

- callable 协议升级为显式 `resultMode + timeoutMs`；同步、Promise 与自动模式不再依赖隐式 `Promise.resolve`，异步超时后释放网络/DOM 防护 Hook，迟到结果不会重新写回；
- `request-transaction` 使用显式 `shape=envelope + paths`，声明路径必须与请求边界的 `expectedDestinations` 完全一致，空字段集、缺字段、重复请求、越权 URL 和超时继续 fail closed；
- evidence graph 新增 `state` link：`create -> init -> update -> final` 共享 correlation ID，但不伪装成 exact value；最终签名或密文进入请求时仍保持字段级 exact proof，不会把会话阶段误拆成多个输出源；
- JSON.stringify、URLSearchParams sort/toString 与 Axios request-builder 作为独立 transform evidence 进入图；只有活动 Trace 才记录，每个 Trace 最多 32 个准备阶段，不遍历 bundler cache；
- 真实 `jsrsasign 11.1.3` 完成 RSA Signature 会话与 JWK 隐私验收，真实 `jose 6.2.3` 完成 SignJWT、CompactSign、CompactEncrypt 及独立 verify/decrypt；测试依赖不进入生产运行时；
- 专项 Headless Chrome 加载真实 jsrsasign 浏览器包和真实 jose ESM，记录到构造器/异步阶段、JSON/Axios 与 Header 签名边界；Node 独立验证器接受页面签名、JWT 和 JWE，停止后 JSON、Axios 与协议构造器全部恢复；
- 单元/协议测试：31 个测试文件、135 项测试全部通过；TypeScript `--noEmit` 与 Chrome MV3 生产构建通过；生产产物未包含靶场 URL、固定凭据、私钥或测试库实现；
- `jsrsasign` 官方已公告进入停止支持周期，因此 Adapter 仅用于识别和复用目标页面已有实现，不代表建议新系统采用该库，也不会把它打进插件运行时。

## 11. 完成定义

本路线不能以“新增了几个库名称”宣布完成。至少同时满足：

- 现有三种 provider 全部迁移到独立 contract，MAIN-world entrypoint 不再拥有库特定实现；
- sm-crypto 和 node-forge 通过真实服务器加密/解密/验签；
- jsrsasign 与 jose 的状态/异步协议通过真实浏览器和独立验签/解密；
- 一个没有专用 adapter 的 ESM 闭包夹具仍能从请求边界恢复业务 callable；
- 一个 Worker 或 WASM 夹具在不知道内部算法实现的情况下生成服务端认可报文；
- 全局库、闭包库、混淆命名使用同一 evidence graph 和 Profile compiler；
- 随机化 URL、字段、变量名后无需修改生产规则；
- 多密码 envelope 保持动态 key/IV/nonce/signature 一致性；
- key material 不离开页面现场；
- 录制停止后无残留 Hook/timer，性能基准无未解释回退；
- Options、Yakit 与 AI 使用同一候选，不各自维护库特判。

## 12. 调研依据

以下资料用于确认库的官方能力面和接入形态，链接是调研依据，不表示必须把这些包作为插件运行时依赖打入生产包：

- [Web Cryptography API（W3C）](https://www.w3.org/TR/WebCryptoAPI/)
- [CryptoJS](https://github.com/brix/crypto-js)
- [JSEncrypt](https://github.com/travist/jsencrypt)
- [sm-crypto](https://github.com/JuneAndGreen/sm-crypto)
- [node-forge](https://github.com/digitalbazaar/forge)
- [jsrsasign](https://github.com/kjur/jsrsasign)
- [jose](https://github.com/panva/jose)
- [libsodium.js](https://github.com/jedisct1/libsodium.js)
- [TweetNaCl.js](https://github.com/dchest/tweetnacl-js)
- [noble-hashes](https://github.com/paulmillr/noble-hashes)、[noble-curves](https://github.com/paulmillr/noble-curves)、[noble-ciphers](https://github.com/paulmillr/noble-ciphers)
- [OpenPGP.js](https://github.com/openpgpjs/openpgpjs)
