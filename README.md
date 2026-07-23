# Yakit Browser Agent

Browser security tools and a consent-gated context bridge for Yak AI agents.

The WXT extension includes proxy profiles and PAC routing rules, Cookie and User-Agent tools, a Shadow DOM edge panel, authenticated-tab context capture, controlled execution in the page's real JavaScript world, and a Chromium Deep Capture debugger for real frontend crypto workflows. Structured context uses bounded text, forms, authentication signals, open Shadow DOM traversal, context diffs, and document-bound node references instead of exporting full page HTML. The Recorder discovers business Traces through one crypto-adapter model for WebCrypto, CryptoJS, JSEncrypt, sm-crypto, and node-forge, plus Beacon/Worker/SharedWorker/MessagePort boundaries. An exact receiver-bound primitive-to-request-field chain can become a plaintext gateway directly, while stateful or multi-call AES/RSA/signature envelopes are promoted to a request-level graph and captured as one business callable. Deep Capture can pause the next selected crypto call, message boundary, or request, deterministically rank live page frames, recover ESM/module script URLs, and retain an in-scope closure—including a closure holding a `CryptoKey` or `WebAssembly.Instance`—without exporting key material. The Browser Transform Gateway composes those callables with typed Pipeline v2 nodes so Yakit Web Fuzzer can edit plaintext while the live browser produces and consumes the real wire format. AI access is bound to a concrete tab, frame, document, origin, task, scope set, and expiration time. Yak/Yakit product assets are kept in `public/` and exposed to content scripts through explicit web-accessible resources.

When an Agent reaches a QR code, MFA, CAPTCHA, or device confirmation, it can create a human handoff. The target tab is focused, the extension presents the request in Popup, Options, and the edge panel, and the Agent receives a completion or cancellation event after the user decides. The network workspace can capture a granted document's real Fetch/XHR requests and open an authenticated replay packet in Yakit Web Fuzzer. Sensitive headers, Cookie, and body capture are off by default and session-only. A separate local audit log stores only method, target, timing, and outcome metadata; it does not store page content, Cookie values, Eval source, network payloads, arguments, or results.

## Development

```bash
pnpm install
pnpm dev
```

WXT intentionally refuses to launch browsers automatically when it detects WSL, even when WSLg and a Linux Chrome are available. Use the project runner instead:

```bash
pnpm dev:wsl
```

It keeps the development profile in `.wxt/chrome-wsl-profile`. Official Chrome 137+ no longer accepts `--load-extension`, so the first run opens `chrome://extensions`: enable Developer mode and load `.output/chrome-mv3-dev` once. The profile remembers it on later runs.

Chromium and Chrome for Testing still support automatic loading. Select one with:

```bash
CHROME_PATH=/path/to/chromium pnpm dev:wsl
```

Production builds:

```bash
# Chrome Web Store: User Scripts MAIN, no direct Eval bridge
pnpm build
# Explicitly named store output
pnpm build:store
# Managed/local deployment: User Scripts MAIN with packaged bridge fallback
pnpm build:enterprise
# Local/enterprise Firefox MV2 injected bridge
pnpm build:firefox
# Public Firefox MV3 AMO invoke-only package
pnpm build:firefox:amo
```

Chrome 138+ requires the user to enable **Allow User Scripts** on the extension details page before the store build can run page-world Eval. The extension reports this condition explicitly and does not fall back to direct Eval.

Production verification:

```bash
pnpm verify:production
pnpm verify:ui:store
pnpm verify:ui:enterprise
pnpm verify:ui:enterprise:fallback
pnpm verify:native
```

`verify:production` runs Vitest and enforces permission, managed-policy, execution-channel, `webRequest`, `debugger`, fixture-leakage, and web-accessible-resource policies across four packages. Content-script, background, recorder, compressed-background, and total package sizes remain visible as advisory reference metrics; exceeding those references does not block a build. Runtime performance is verified with bounded workloads and real browser flows instead of treating bundle size as a proxy for responsiveness. Browser E2E covers Chrome Store User Scripts, Enterprise User Scripts, and the Enterprise injected fallback, including document-bound grants, context diff, stable node operations, expression/program scope separation, pause/resume/revoke, human handoff, request capture, exact value and correlated channel Trace links, form/query field evidence, short-sample replay, recording-to-callable interaction, callable lifecycle management, same-tab navigation continuation and browser Back, deep-capture frame provenance/scope expansion, Yakit workflows, split storage, Service Worker restart, audit/diagnostic redaction, strict CSP, fail-closed tab teardown, and 320/390/desktop UI bounds. The Chromium fixture additionally uses real sm-crypto and minified node-forge browser bundles, a randomized non-global ESM closure holding a real WebAssembly instance, and an opaque Worker path; every retained callable/profile is checked by an independent server. The performance gate covers 1,000 small calls, 10 × 1 MiB calls, event exhaustion, oversized replay-handle rejection, and post-stop API restoration. `verify:native` builds the Go host and exercises Chromium Native Messaging through the host into a loopback Yak Bridge fixture; because Playwright cannot operate Chrome's toolbar permission prompt, only its disposable test copy pre-grants `nativeMessaging`, while the source Store package is asserted to remain optional.

Browser verification prefers `CHROMIUM_PATH`, then `CHROME_PATH`, Playwright's Chromium cache, Chrome for Testing, or system Chromium. It deliberately does not auto-select stable Google Chrome because current stable Chrome ignores unattended `--load-extension` startup flags.

## Pair with Yak and Yakit

The Yak gRPC process owns the local browser Bridge. The standard command starts Bridge v3 on `127.0.0.1:64333` automatically, so there is no separate Bridge script or shared token to configure:

```bash
go run common/yak/cmd/yak.go grpc --host 0.0.0.0
```

Open **系统设置 -> 浏览器集成** in Yakit, then open **引擎连接** in the extension and choose **查找本机 Yakit**. Both surfaces display the same six-digit verification code. Compare the code and approve the pending browser in Yakit. The approval persists an origin-bound device identity; later connections authenticate automatically with signed challenges. Removing the device in Yakit immediately disconnects it and requires a new approval.

To run a browser task, create a control sharing grant for the target tab in the extension, return to **系统设置 -> 浏览器集成**, and click the online browser row. The default browser-workspace view contains Plaintext Gateway, Recorder and Deep Capture modes; raw capability JSON and Yak code with request-bound `browser.ExtensionCall` remain advanced modes. Select a saved browser/profile pair from Web Fuzzer's **浏览器明文** control to make its editor the logical plaintext view; **明文 / 线上** shows the actual transmitted request and response beside it. Task state, logs, JSON results, cancellation, and errors are streamed in that workspace. Do not use the generic `ExecYakScript`/`grpc_execYak` runner for this flow: that runner starts a child Yak process and cannot own the parent gRPC process's live browser connections.

Advanced transport settings remain available for a non-default loopback port or Native Messaging deployment. `--browser-extension-bridge-port` changes the Yak listener, and `--disable-browser-extension-bridge` disables it explicitly.

## Native Host and deployment

Build the Native Messaging transport from the Yak repository and register it with the signed or unpacked extension ID:

```bash
go build -o yakit-browser-agent-host ./common/browser/nativehostcmd
./native-host/install.sh --host-binary /absolute/path/to/yakit-browser-agent-host --extension-id YOUR_EXTENSION_ID
```

Windows uses `native-host/install.ps1`. Native Messaging is an optional browser permission requested only when Native mode is selected. See [Browser Transform Gateway](docs/BROWSER_TRANSFORM_GATEWAY.md), [Deep Capture architecture](docs/DEEP_CAPTURE_ARCHITECTURE.md), the [frontend crypto generalization roadmap](docs/FRONTEND_CRYPTO_GENERALIZATION_ROADMAP.md), [Native Host installation](native-host/README.md), [enterprise policy](docs/ENTERPRISE_POLICY.md), [permissions](docs/PERMISSIONS.md), [privacy](docs/PRIVACY_POLICY.md), and the [release review packet](docs/store-review/RELEASE_CHECKLIST.md).
