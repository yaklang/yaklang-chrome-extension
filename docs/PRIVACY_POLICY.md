# Yakit Browser Agent Privacy Policy

Effective date: 2026-07-22

Yakit Browser Agent is a browser security-testing extension that connects browser context selected by the user to a Yak/Yakit engine running on the same computer. This policy describes the extension source in this repository and its official packaged builds.

## Data the extension handles

Depending on the command the user selects and the grant scopes they enable, the extension can handle:

- page URL, title, frame and document identity;
- bounded page text, forms, interactive element metadata, open Shadow DOM metadata, and authentication signals;
- Cookie metadata and values, including HttpOnly cookies exposed by the browser Cookies API;
- localStorage/sessionStorage keys, IndexedDB database/store/key inventory, and CacheStorage names; database and cache values are not collected;
- request URL, method, timing and status, plus request headers, Cookie and body only when sensitive capture is explicitly enabled;
- temporary business Traces covering page interactions, Fetch/XHR/Form/WebSocket/WebCrypto/CryptoJS and common transforms; bounded value previews require a separate sensitive scope;
- document-bound recorded-call page functions that retain opaque function/key references without exporting key material;
- during an explicitly armed Chromium Deep Capture, bounded call-frame names, source locations, `this` previews, and local/closure/module variable names, types and previews from the paused main document;
- document-bound business-closure page functions that retain a selected in-scope function and receiver inside page memory, plus bounded invocation arguments and results when the user or granted engine executes them;
- per-gateway local replay drafts containing the method, URL, headers, editable body and explicitly selected short sample used to validate a saved request or response transform;
- proxy, User-Agent header, floating-panel and Bridge settings;
- local operational metrics such as aggregate Bridge latency, connection errors, capability duration and Service Worker starts.

## How data is used

Data is used only to provide user-facing browser security workflows: inspect an authenticated page, operate explicitly selected elements, replay a selected request in Yakit, analyze authentication/signing behavior, or let an Agent continue after user-controlled QR/MFA/CAPTCHA handling. It is not used for advertising, credit decisions, user profiling, sale, or unrelated analytics.

## Data transmission

The extension has no developer-operated telemetry or analytics endpoint. Browser context is sent only after a user creates a time-limited grant or invokes a clearly labeled workflow. The destination is the user-configured Native Messaging host or an explicit loopback WebSocket endpoint. The default is `ws://127.0.0.1:64333/extension`.

The Native Host is a local transport to that loopback Yak Bridge. Bridge v3 still verifies the paired extension identity, browser extension Origin, task, grant, target and capability scopes. A website cannot access this channel.

## Local storage and retention

- Proxy, User-Agent, Bridge and floating-panel settings remain until the user changes them or removes the extension.
- The paired engine public identity and device ID are local settings. The extension's non-extractable P-256 private key remains in extension-owned IndexedDB; no reusable bearer token is stored. Proxy passwords, active grants, handoffs, action timelines and captured requests are session-scoped.
- Per-document fingerprint seeds, retained function/key handles and page-callable function objects remain only in that document's page memory. Starting a new recording, clearing it, grant expiry/revocation or a hard reload destroys recorder handles. A document restored from the browser's Back/Forward Cache retains its own heap and can resume those handles; a newly loaded document cannot. Manual stop keeps created callables only for the current live document.
- Recording previews are off by default and bounded when explicitly enabled. A live document keeps them in page memory. A user-started tab/frame recording may copy bounded document segments and navigation events to extension-only `storage.session`, allowing the Session to continue through login redirects without persisting values. There is at most one recording Session per target; it is removed by a new recording, explicit clear, tab close, or browser-session end. A document-bound Agent grant does not automatically continue recording into a new document. Session data is never written to persistent extension storage and never included in audit or AI request-analysis payloads.
- Deep Capture status and bounded pause previews are session-scoped so a suspended Service Worker can still resume or detach the correct tab. The page auto-resumes after 45 seconds unless an open control surface explicitly extends the deadline. Detach, tab closure, grant replacement, expiry or revocation removes the owned debugger session state.
- When the user explicitly generates and saves a Transform Gateway, the selected short sample and subsequent local-replay edits may be copied into a separate profile-and-direction-scoped `storage.local` draft. This draft is limited to 256 KiB, is not part of the portable profile, and is never included in Bridge/RPC calls, Yak or AI context, audit, diagnostics, or profile export. Request and response drafts are independent. The user can clear either draft, and deleting the gateway deletes both. Other paused scope values remain session-only and are not copied.
- Audit storage retains at most 500 metadata-only records. It omits page content, URLs, request parameters, Cookie/token values, Eval code, arguments and results.
- Context and request buffers are bounded and replaced or cleared by document, grant and session lifecycle.
- Operational metrics are aggregate local counters. They are included only when the user explicitly exports a diagnostics file.

## User control

The user selects the tab/frame, scopes and expiration for every Agent grant and can pause, resume or revoke it. Sensitive network fields, recording previews, callable execution, debugger read/control and program Eval each require separate controls or scopes. Deep Capture must be armed for a named crypto operation or request substring and pauses only the next match. Recording defaults to per-recording salted correlation fingerprints with no raw value preview. Cookie values are hidden by default. Exports are redacted by default. A Transform Gateway replay draft is visibly marked as local-only and can be cleared independently without deleting the gateway. The floating panel can be disabled globally, restricted to active tasks, or controlled with an allowlist/denylist.

Removing the extension deletes browser-managed extension storage. The Native Host installer has an uninstall option that removes its per-user manifests and copied executable.

## Security

The WebSocket Bridge accepts explicit loopback hosts only. First-time pairing requires the user to compare a six-digit code in the extension and Yakit. Later handshakes use mutually verified P-256 signatures and identify the engine, extension installation, connection and resumable session. Revoking a paired device closes its active connection. Grants bind task, tab, frame, document, origin, scopes and expiry. A grant cannot control a debugger session owned locally or by another grant. Pause status/keepalive/resume do not execute code in the paused page. Messages have runtime schemas, concurrency limits, cancellation, bounded payloads and chunk reassembly limits.

No system can guarantee absolute security. Do not use the extension against systems you are not authorized to test, and do not include secrets in public bug reports.

## Changes and contact

Material policy changes must accompany a product update and updated store disclosures. Questions or security reports can be opened at [yaklang/yaklang issues](https://github.com/yaklang/yaklang/issues); use a private security-reporting channel for sensitive vulnerability details.

Official policy references: [Chrome Web Store User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [Chrome Limited Use guidance](https://developer.chrome.com/docs/webstore/user_data), and [Mozilla Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/).
