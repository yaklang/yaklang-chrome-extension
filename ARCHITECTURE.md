# Yakit Browser Agent Architecture

## Goals

- Reuse a user's real, authenticated browser session without exporting a complete browser profile.
- Let an AI agent inspect a deliberately shared tab and request human takeover for QR codes, MFA, CAPTCHA, or device confirmation.
- Keep proxy, Cookie, User-Agent, page-context, and page-function capabilities behind one typed command boundary.
- Make grants short lived, tab scoped, visible, and revocable.

## Layers

### Capability layer

The background service owns browser capabilities. Every remote command passes through one router before it reaches browser APIs.

| Method | Required scope | Effect |
| --- | --- | --- |
| `browser.tabs` | `browser.tabs.read` | Lists only tabs included in the active grant |
| `browser.frames` | `browser.tabs.read` | Lists main, same-origin, and cross-origin frames for a granted tab |
| `browser.context` | `browser.dom.read` | Captures a bounded structured snapshot and diff; Storage and Cookie require their own scopes |
| `browser.node.inspect` | `browser.dom.read` | Inspects a document-bound node without returning the current input value |
| `browser.node.action` | `browser.dom.write` | Clicks, focuses, scrolls, or writes a value through a current node reference |
| `browser.cookies` | `browser.cookies.read` | Reads cookies for a granted tab |
| `browser.takeover` | `browser.tab.activate` | Focuses a granted tab for a human step |
| `browser.handoff.request` | `browser.human.takeover` | Starts a visible QR/MFA/CAPTCHA/device-confirmation handoff |
| `browser.handoff.status` | `browser.human.takeover` | Reads the current task's handoff state |
| `browser.network.status/list` | `browser.network.read` | Reads capture state and request metadata |
| `browser.network.start/stop/clear` | `browser.network.capture` | Controls a bounded capture session for a granted document |
| `browser.network.export` | `browser.network.sensitive.read` | Builds a replay packet from explicitly captured headers/body |
| `browser.invoke` | `browser.page.invoke` | Calls an existing page-world function by path |
| `browser.eval` expression | `browser.page.eval.expression` | Executes one parenthesized expression in a granted page world |
| `browser.eval` program | `browser.page.eval.program` | Executes statements and side effects under an independent high-risk scope |
| `browser.observe.*` | `browser.observation.read/control/sensitive.read` | Controls bounded Fetch/XHR/Form/WebSocket/WebCrypto/CryptoJS observation |
| `proxy.list` | `browser.proxy.read` | Lists extension proxy profiles |
| `proxy.switch` | `browser.proxy.write` | Switches the browser proxy profile |

The transport never calls browser APIs directly.

### Grant layer

A grant contains:

- an unpredictable session ID;
- a task ID;
- one or more explicit tab, frame, and document IDs with their origin and grant-time URL;
- an explicit set of capability scopes;
- creation and expiration timestamps.

Expired grants are rejected and removed. Reloading or navigating a document returns `stale_document`; navigation to a different origin returns `origin_changed`. Neither condition silently retargets an operation. The UI still offers read/control presets, but those presets only create concrete scope sets and are not stored as authorization levels. A remote caller cannot expand a grant. Only extension UI initiated by the user can create or replace one.

### Transport layer

Bridge v3 supports authenticated loopback WebSocket and optional Native Messaging:

```text
Browser extension -> ws://127.0.0.1:<port>/extension -> Yak engine / AI session
```

The Yak gRPC process owns this listener and starts it on `127.0.0.1:64333` by default. Yakit controls it through the existing `RequestYakURL` RPC with the `browser-extension://` schema, so pairing, approval, device rename and revocation do not add dedicated gRPC methods.

First-time pairing uses `/pairing`. The extension generates an origin-bound ECDSA P-256 installation identity and keeps its non-extractable private key in IndexedDB. Yak keeps a persistent engine identity under the Yakit home directory with owner-only file permissions. The plugin and Yakit derive the same six-digit code from both nonces, identities, origin and public keys; the user approves only after comparing that code. No bearer token is stored or copied.

The browser-profile `installationId` is stable across disconnects and local unpairing; clearing a pairing destroys the local signing key but does not manufacture a new browser installation. A later approved pairing with the same installation ID rotates the public credential in place while preserving the Yak `deviceId`, user-visible name and creation time. If browser storage was actually erased and a new installation ID is unavoidable, Yakit must explicitly choose whether to replace a matching offline identity or add a separate browser profile. Replacement is restricted to the same extension origin and client, so a shared Chrome extension ID is never used as an unsafe global deduplication key.

Every `/extension` connection starts with a signed engine challenge. The extension verifies the approved engine public key and replies with a signature from its paired installation key. Yak verifies both the installation ID and browser extension Origin before returning `hello_ack`. The connection is not reported ready until that acknowledgement confirms protocol, capabilities, engine identity, engine instance, connection and session identities. The authentication message also carries the current task/grant identity. A disconnected installation can resume its logical session while each physical connection receives a new ID. Revoking a device immediately closes its active connection. Heartbeats carry sequence/timestamps and expose round-trip latency.

Request IDs allow concurrent calls in both directions. The extension accepts at most eight engine-initiated in-flight requests, rejects duplicate IDs, supports cancellation, and applies a 16 MiB aggregate limit. Messages above 512 KiB are split into bounded 256 KiB chunks with transfer count/timeout limits. Yak forwards context cancellation and buffers extension events in a bounded queue exposed as `browser.ExtensionWaitEvent`.

### Yakit device tasks

Pairing and device CRUD remain on `RequestYakURL`. Executable work uses one server-streaming RPC, `ExecuteBrowserExtensionTask`, with stable routing fields (`task_id`, `device_id`, `schema`, JSON payload and timeout). The initial schemas are:

- `capability.call`: invokes one extension capability with `{method, params}` and returns its JSON result;
- `yak.script`: executes Yak in the owning gRPC process and injects a request-bound `browser.ExtensionCall` and `browser.ExtensionStatus` for the selected device.

The engine supports multiple simultaneous browser connections. Calls are routed by paired device ID, pending responses are bound to the target WebSocket, and a disconnect immediately fails that device's outstanding calls. A schema handler cannot silently fall back to another online browser.

Task events use a small common vocabulary (`queued`, `running`, `log`, `result`, `warning`, `error`, `cancelled`, `completed`) with monotonic sequence and timestamp fields. The RPC bounds payload size, timeout, concurrent scripts, per-event data and aggregate output; cancelling the stream propagates through the Yak context to the extension request.

The Yak runner is a controlled in-process context, not an operating-system sandbox. It prevents process exit, recovers VM panics and enforces resource bounds, but only trusted operator-authored code should use it. Untrusted or remotely supplied scripts require a future isolated worker. The generic `ExecYakScript` path is intentionally not reused because its child process does not own the parent process's live Bridge manager.

Native Messaging uses the same Bridge v3 challenge/auth envelope and paired identity contract:

```text
Browser extension -> registered Yakit Native Host -> loopback Yak Bridge -> running Yak engine
```

The Yak repository contains `common/browser/nativehostcmd`, a stdio framing proxy with loopback/origin validation. `native-host/install.sh` and `install.ps1` register per-user Chrome/Chromium/Edge/Brave/Firefox manifests. `nativeMessaging` is optional and requested only when the user explicitly saves Native mode.

## Human takeover

Agent workflows treat human participation as an explicit, persisted state transition:

1. The agent detects a QR code, MFA prompt, CAPTCHA, or device confirmation.
2. It calls `browser.handoff.request` for a document in the active control grant.
3. The extension focuses the tab, shows a badge, expands the target page panel, and displays the same request in Popup and Options.
4. The Agent pauses without polling sensitive content.
5. The user chooses **操作已完成** or **取消任务**.
6. The extension emits `browser.handoff.changed`; Yak receives it through `ExtensionWaitEvent`.
7. The Agent matches the handoff ID, captures a fresh context, and continues only after `completed`.

`browser.takeover` remains a short-lived focus action without a completion lifecycle.

## Network capture

Network capture uses the browser `webRequest` API rather than page-world Fetch/XHR monkey patches. This preserves the actual outgoing request headers, browser-added Cookie header, request body, redirect status, cache state, and timing. The listener is filtered to Fetch/XHR, ping, and related programmatic requests; images, stylesheets, scripts, fonts, and media are not collected.

Each capture session is bound to one tab, frame, and document. Chrome MV3 stores the bounded session in `storage.session`, so Service Worker suspension does not move sensitive records into persistent settings. Firefox MV2 keeps the same data in background memory. Defaults are metadata-only, 100 entries, and no request headers or body. Explicit sensitive capture is capped at 200 entries and 64 KiB per request body; the UI currently uses 100 entries and 32 KiB.

Generating a replay packet requires captured request headers. The packet is reconstructed as HTTP/1.1 with the observed header values and bounded body bytes. Truncated or omitted bodies produce an explicit limitation warning. Sending to Yakit is a confirmed Bridge request: Yak validates a maximum 2 MiB packet, saves a Web Fuzzer page configuration in the current project database, broadcasts the new tab to Yakit, and returns its `pageId` before the extension reports success.

## Page-world code

### Structured context and node references

`browser.context` no longer returns a full HTML document. A snapshot contains a 20 KiB body-text excerpt, bounded headings/forms, up to 400 actionable nodes discovered while scanning at most 10,000 elements, a full frame inventory, optional bounded Web Storage values, optional IndexedDB database/store/key metadata, optional CacheStorage names, bounded document/SPA lifecycle events, optional Cookie values, authentication signals, and a diff against the preceding snapshot for the same tab/frame. IndexedDB and Cache values are never collected. Open Shadow Roots are traversed recursively; the extension's own edge-panel Shadow Root is excluded.

Each actionable element is registered in the page's MAIN world and identified by `captureId + tabId + frameId + documentId + nodeId`. `browser.node.inspect` and `browser.node.action` resolve the registered `Element` directly instead of re-running a CSS selector. A new capture replaces the registry, a detached element is rejected, and a changed document fails target resolution. These paths return `stale_node` or `stale_document`; they never silently retarget a similar element.

Frame inventory combines `webNavigation.getAllFrames` with a bounded packaged probe in every accessible frame. Grants store an explicit target for each selected `tabId + frameId + documentId + origin`; selecting a tab authorizes only its main frame until the user separately selects child frames. `webNavigation.getFrame` verifies each remote operation against the current frame URL and document. Cross-origin navigation returns `origin_changed`, while same-origin document replacement returns `stale_document`.

Node inspection returns bounded identity, safe attributes, visibility, state, and viewport bounds. It deliberately excludes the current input value. Node actions support `click`, `focus`, `scroll`, and `setValue`; `setValue` uses native value setters plus input/change events, rejects file inputs, requires `browser.dom.write`, and never sends the supplied value to the audit writer. Programmatic click is a page-world click and is not represented as a trusted physical mouse event.

The authentication classification is a heuristic based on bounded DOM controls plus explicitly requested Cookie names and Storage keys. It is useful for workflow routing, but it is not proof that the server accepts the current session.

`PageExecutionAdapter` selects an execution mechanism at build time. Production/store Chrome builds use the Web Store-permitted User Scripts API:

```text
Background capability router
    -> userScripts.execute({ world: "MAIN" })
    -> structured { ok, result | error }
```

The default production build declares Chrome 138+, requires the user to enable Allow User Scripts, and physically omits `page-main-world.js`. It never silently falls back to direct Eval.

User Scripts receive the selected expression or program as direct script source; the Store path never calls `eval` on Bridge-provided text. Expression mode automatically returns its expression. Program mode is an async function body and requires an explicit `return` to produce a value; without one it returns `undefined`.

Development and local Firefox MV2 builds use WXT's packaged injection pattern. Enterprise Chrome prefers User Scripts and retains this pattern only as a managed fallback:

```text
Background capability router
    | tabs.sendMessage (extension-only)
Isolated content script
    | correlated CustomEvent on the injected script element
Unlisted page-main-world script
    | indirect eval / function invocation
The page's real window context
```

The old extension established the essential behavior by injecting `inject.js` and forwarding `CONTENT_EVAL_CODE` through `window.postMessage`. The current bridge preserves that capability while adding request IDs, Promise resolution, response timeouts, error propagation, cycle-safe result serialization, output limits, and content-script lifecycle cleanup. A timeout stops the extension from waiting for an asynchronous result; JavaScript cannot safely interrupt synchronous code, so an infinite loop can still block the target page.

Both adapters share the same expression/program return rules, result serializer, Promise behavior, timeout bounds, and error envelope. Local Eval is initiated by an explicit user action. Remote expression and program modes require separate scopes and a target whose tab, frame, document and origin still match. Because the page controls its JavaScript environment, all results remain untrusted input.

The public Firefox MV3 AMO channel is invoke-only at the extension boundary: it requests neither `userScripts` nor general page invocation/Eval, does not package `page-main-world.js`, and advertises neither Bridge capability. This follows Mozilla's current restriction of `userScripts` to user-script managers. Structured context, stable node commands, network capture, observation and human handoff remain available.

The same page bridge supports `browser.invoke` for the narrower case where the Agent already knows a concrete global function path. Fetch/XHR/Form/WebSocket/WebCrypto/CryptoJS observation uses the same grant and lifecycle boundaries through a separate bounded MAIN-world observer.

## Page UI loading

The content script is a roughly 10-12.2 KiB native DOM shell. It owns the Yak launcher, bridge indicator, drag position, left/right snapping, and handoff-triggered expansion. React, Radix, and the floating workbench are loaded in `floating.html` only after the user expands the launcher or a handoff targets that tab; the iframe is released after 60 seconds collapsed. Build auditing prevents the content script from exceeding its size budget.

Popup, Options, and the floating workbench share one token-based design system in `src/styles/`: `tokens.css` defines the palette, type scale (11-20px), radii, and shadows, including a full dark set under `[data-theme='dark']`; `ui.css` styles the shared Radix-backed components. The vivid brand orange is reserved for non-text accents; filled primary buttons and text links use a deeper AA-contrast orange. All surfaces are light-first — the orange yak mark is shown bare without a backing tile. The theme preference (`system`/`light`/`dark`) lives in its own `settings.appearance.v1` local-storage key, is written only from extension UI, and is applied to `<html data-theme>` by each entrypoint through `src/platform/storage/appearance.ts`; the content-script launcher reads the same key in-page (falling back to the OS scheme) to theme its shadow-DOM shell.

## Audit boundary

Audit events live under a separate storage key and are serialized independently from settings and active session state. The bounded log retains the latest 500 events. It records category, method/action, outcome, task ID, tab ID, duration, error code, and a fixed safe summary where applicable. Capability parameters and results are never passed to the audit writer. The Options activity view reads the latest 200 entries and lets the user clear them locally.

## Production operations

- State v7 uses separate durable proxy/UA/Bridge/panel keys and separate session grant/Bridge/action keys; mutation is serialized across domains and no legacy migration path exists.
- Agent actions have a session timeline and user pause/resume/revoke controls. Persistent audit remains metadata-only.
- Managed storage can lock transport, endpoint/host, grant duration/origins, program Eval and panel availability. Enforcement is in background handlers.
- Aggregate Service Worker, Bridge, heartbeat and capability metrics stay local. Explicit diagnostics export omits URLs, values, payloads, Eval code and task/grant identifiers.
- Public review artifacts live under `docs/store-review`; privacy, permission and enterprise deployment contracts live under `docs/`.
- Store/Enterprise Chromium E2E covers 320/390/desktop UI, service-worker restart, frame/document/origin boundaries, request/observation workflows, handoff, audit/diagnostic redaction and state concurrency. Go tests cover Bridge v3 pairing, code derivation, signed challenge/auth, revocation, YakURL control, chunking/session recovery and Native Messaging proxy framing.
