# Deep Capture Architecture

## Product boundary

Deep Capture is for an authorized tester who can reproduce a real browser operation but does not want to rebuild a site's frontend encryption environment in a separate JS-RPC service.

The user chooses the business action and reproduces it once. Request-level inference selects the capture boundary and, when the evidence is unique, the background selects and retains the relevant business frame automatically. The user chooses a stack frame only when candidates are ambiguous; a function expression is an advanced fallback. The extension supplies the browser-only parts: the live document, lexical scope, non-extractable keys, dynamically generated IV/nonce/timestamp values, function receiver and authenticated session.

This is deliberately not a promise to autonomously solve QR codes, CAPTCHA, MFA, device confirmation or every obfuscated application. Those steps remain visible human actions. The product goal is to remove avoidable environment reconstruction after the user reaches the real business operation.

## Workflow

```text
Real user operation
  -> lightweight Recorder discovers a Trace and target operation
  -> Deep Capture arms one crypto function or request breakpoint
  -> Chromium pauses at the next real invocation
  -> call frames become visible immediately
  -> local / closure / module scopes are collected in parallel
  -> shared stack hints and CDP metadata rank page business frames
  -> a pure frame becomes a business closure; a send/DOM frame becomes a request transaction
  -> function object + receiver + fixed call-frame arguments stay inside the live document
  -> page resumes
  -> plaintext maps to formal parameters or matching page controls
  -> a request transaction captures the target envelope without sending it
  -> extension, Yakit or Yak invokes the page callable with new JSON arguments
  -> dynamic browser behavior and server validation remain real
```

The Recorder is the discovery/index layer. It records bounded interactions, requests, Beacon/WebSocket/Worker/MessagePort activity, unified WebCrypto/CryptoJS/JSEncrypt/sm-crypto/node-forge crypto calls, transforms, Trace membership, exact value links and explicitly correlated channel links. A recorded-call callable replays one eligible stateless or receiver-bound primitive by replacing its named data argument while retaining the original function, receiver and fixed argument template. Stateful sessions remain evidence and are promoted to their enclosing business closure.

Deep Capture is the runtime/context layer. It captures a business function from a paused lexical environment, so one business-closure callable may preserve several internal crypto calls, closure variables, key promises, dynamic parameters and serialization steps. If the closest common business function also reads DOM controls, builds the request and calls Fetch/XHR/Beacon/Form, the same frame is retained as a `request-transaction` instead of being skipped in favor of an outer click handler. Both sources use the same registry and execution protocol while retaining distinct provenance and input-slot metadata.

## Chromium implementation

The background service uses `chrome.debugger` and these Chrome DevTools Protocol domains:

- `Runtime` resolves the live wrapper function and reads object properties;
- `Debugger` enables pauses, function-call breakpoints, call frames, scopes and `evaluateOnCallFrame`;
- `DOMDebugger` installs a one-shot XHR/fetch URL breakpoint;
- `Network` prepares the session for later request correlation without intercepting traffic in this phase.

Crypto capture does not depend on a source `debugger` statement. Production minifiers may remove that statement, and page CSP may block dynamic code construction. Instead, the recorder exposes the exact installed adapter or communication-boundary wrapper by its opaque `wrapperHandleId`. The background sets `Debugger.setBreakpointOnFunctionCall` on that object and removes the breakpoint on the first pause. Request-only unknown code can still use a bounded XHR/fetch URL breakpoint.

Chrome may omit `callFrame.url` for ESM/module frames. The service therefore maintains a per-tab, 4,096-entry LRU-style `Debugger.scriptParsed` index and resolves the frame source from `location.scriptId`. This makes dynamically named ESM chunks first-class capture targets without scanning a bundler cache or exposing their exports on `window`.

Request capture uses `DOMDebugger.setXHRBreakpoint` with a bounded URL substring. It is also one-shot.

The current implementation supports Chromium main documents. Firefox does not request `debugger`, does not advertise Deep Capture Bridge capabilities and continues to provide Recorder-created callables.

## Pause control plane

A paused page cannot execute `scripting.executeScript`. Status, keepalive, resume, detach and callable creation must therefore never depend on an injected document probe.

During a pause, target authorization uses only:

- the grant's tab/frame/document/origin tuple;
- `tabs` and `webNavigation` state;
- extension session storage owned by the background;
- CDP commands on the already attached target.

Page execution is used only before the pause to install/resolve a target function and after the pause to list, invoke or delete retained callables. This separation prevents the debugger control plane from deadlocking on the page it controls.

## Two-stage collection

The pause event publishes a stack skeleton before reading scope properties. This gives UI and Bridge clients an immediately observable `paused` state and lets them extend the deadline. Scope collection then fills the first eight frames in parallel.

Current bounds are:

| Resource | Bound |
| --- | ---: |
| Pause watchdog | 45 seconds |
| Call frames | 14 |
| Frames with scope expansion | 8 |
| Scopes per frame | 6 |
| Variables per scope | 48 |
| Variable preview | 512 characters |
| Expandable variable detail | 4,096 characters per variable |
| Expandable detail per scope | 16,384 characters |
| Page callable arguments | 64 JSON values |
| Function expression | 4,096 characters |

The extension UI sends keepalive every 10 seconds while paused. Yakit uses `browser.deep_capture.keepalive` as its paused-state poll. If all control surfaces disappear, the alarm watchdog resumes the page automatically.

Every frame carries an explicit `sourceKind`: `extension-hook`, `page`, or `library`. Exact recorder/debugger wrapper names and extension URLs are classified as extension hooks; dependency/runtime URLs are classified as libraries; remaining frames are page code. Request-level inference contributes bounded common-ancestor hints from multiple source stacks. The background combines those hints with frame depth, CDP script identity, function location and risk inspection; the UI cannot supply trusted source metadata. Options and Yakit display the labels and reasons, and prevent an extension hook or dependency frame from being captured as a business callable. Scope rows are keyboard-operable expanders: the list keeps a compact preview, while the expanded block shows a bounded value or function-source detail with copy actions. This makes injected wrappers visibly different from application functions without exporting unbounded debugger data.

## Unified page callable

`browser.callable.create` with `source: deep-capture` has three explicit strategies. `selected-frame` resolves a pure function from the stored current call frame and rejects network/DOM/navigation/storage side effects. `request-transaction` retains the closest request-building business frame and its bounded request contract. `expression` remains an advanced fallback and passes the pure-function inspection gate. Client-provided source URLs and line numbers are not accepted. The returned function object and its frame receiver are placed in the shared `BrowserPageCallable` registry keyed by an opaque UUID. Recorder-created calls use the same registry with `source: recording`. Only metadata crosses the extension boundary:

- callable ID, name and kind;
- ordered input slots and output type/encoding;
- function name;
- source URL and line;
- recording/Trace/event provenance when available;
- creation time;
- for a request transaction, expected method, URL reference, output destinations and allowed boundary kinds;
- `document` lifecycle.

Formal parameter names are recovered from bounded function source, including parameters after the first default value, and become ordered input slots. Fixed parameter values and `this` are retained by reading the named parameters from the actual CDP call frame; the debugger evaluation wrapper's `arguments` object is never used as business input. Options may correlate those names with values already present in the authorized paused scope to initialize a local replay Body. That short-lived sample never enters Bridge payloads, audit records, callable metadata or profile storage.

A request transaction exposes one logical `body` input. Execution snapshots bounded form controls and DOM mutations, maps object fields to matching input names/IDs, and temporarily replaces Fetch, XHR send, Beacon and Form submit boundaries. Exactly one request must match the configured method and URL after resolving relative URLs against the current document. The body must contain every inferred destination, such as `body.encryptedData`, `body.encryptedKey` and `body.encryptedIv`. The real transport is never called; controls and observed DOM mutations are rolled back in `finally`. Multiple requests, another URL, an unsupported/file body, timeout, over-budget data or missing fields fail closed. Ordinary business closures also receive runtime transport guards so a transitive helper cannot silently send a request that shallow source inspection missed.

The registry does not export closure bindings, `CryptoKey` material or the function source. `browser.callable.execute` calls the retained function in the MAIN world and returns a bounded structured result. ArrayBuffer and typed-array results are normalized to byte metadata plus Base64. Execution results are lossless within the 8 MiB string/byte, 100,000-node and depth-32 bounds; cycles, functions, symbols and oversized structures fail explicitly. Only UI previews are truncated.

Page callables are the execution primitive used by the [Browser Transform Gateway](BROWSER_TRANSFORM_GATEWAY.md). Deep Capture discovers and retains the real business function; a Pipeline v2 profile reads plaintext request/response context, invokes one or more callables and writes explicit results back to the wire packet.

Navigation, reload or document destruction removes the registry naturally. Explicit deletion removes one callable. Callable IDs are not portable credentials.

## Authorization and lifecycle

Deep Capture adds three independent scopes:

| Scope | Allows |
| --- | --- |
| `browser.debugger.read` | Read status, call frames and scopes |
| `browser.debugger.control` | Attach, arm, keep alive, resume, detach and capture a function from a paused frame |
| `browser.callable.execute` | Create, execute and delete live-document page callables |

Remote calls remain bound to the active grant's tab, main frame, document, origin and expiry. A grant cannot control a local or different grant's debugger session. Grant replacement, expiry and revocation detach sessions owned by that grant. Tab closure removes session state. Chrome DevTools and an extension debugger may compete for the same target; the UI reports the attach/detach failure rather than silently changing targets.

## Real acceptance fixture

The production E2E fixture uses a local authenticated page with:

- native WebCrypto rather than a string mock;
- non-extractable AES-GCM and HMAC keys imported inside a closure;
- a local `buildLoginEnvelope` function that is not placed on `window`;
- dynamic timestamp, nonce and IV values;
- encrypted account/password JSON;
- an HMAC over envelope fields;
- server-side HMAC verification and AES-GCM decryption.

The test records a real operation containing AES-GCM and HMAC, infers their common `buildLoginEnvelope` ancestor, pauses on the earliest confirmed crypto source, automatically captures the selected frame, restores both `password` and defaulted `account` parameters, generates `body.password` and `body.account` bindings from the paused sample, and executes the complete local Pipeline. Independent server validation also invokes the closure with new credentials, asserts different nonce/IV values and accepts the generated envelope. A hash stub or a hard-coded frontend demo does not satisfy this acceptance criterion.

A second real-browser fixture covers the mixed AES + RSA request transaction at `127.0.0.1:82`. Three exact output links must select `sendDataAesRsa`, not its outer `onclick`. The test supplies new username/password values through the page controls, captures `encryptedData`, `encryptedKey` and `encryptedIv`, proves that neither deep-capture recovery nor callable replay added a browser request, and sends the captured envelope independently to the fixture server for acceptance.

## Known limits

- Chromium Deep Capture only; Firefox remains on recording and recorded-call page callables.
- Main document only in the current phase. Cross-frame debugging needs an explicit CDP target/session design rather than silently reusing frame grants.
- Source-map remapping is not implemented; URLs and generated line/column values come from CDP.
- Highly optimized, native, WASM-heavy or deliberately anti-debugging applications may expose incomplete names or scopes.
- Runtime transport interception covers dynamic global Fetch, XHR, Beacon and Form boundaries. A function that captured a private transport reference before interception, sends inside another Worker/realm, performs unconditional direct navigation, or mutates storage through an unobserved helper is not claimed as safely automatic; the current system must block on detected evidence or report the failed/stale transaction.
- DOM rollback is bounded and best-effort. It is not a general browser transaction or a replacement for a disposable test profile.
- The tester may need to select a function-valued scope variable or use the advanced in-scope expression when an anonymous or optimized frame cannot be resolved uniquely.
- The callable intentionally stays document-bound. Portable code generation requires a separate reviewed artifact model and cannot assume captured closure/key objects are serializable.

References: [Chrome Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger), [CDP Debugger domain](https://chromedevtools.github.io/devtools-protocol/tot/Debugger/), and [CDP DOMDebugger domain](https://chromedevtools.github.io/devtools-protocol/tot/DOMDebugger/).
