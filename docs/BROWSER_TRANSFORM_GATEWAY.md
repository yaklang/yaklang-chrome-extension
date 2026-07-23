# Browser Transform Gateway

## 1. Product contract

The Browser Transform Gateway exists for one concrete testing workflow:

> The operator edits and fuzzes meaningful plaintext in Yakit, while the live authenticated browser page performs the same encryption, signing, serialization, dynamic-parameter generation, or response decryption that the production application performs.

The result sent on the network must be accepted by the real server. A fixed codec demo, copied JavaScript function, or standalone mock key does not satisfy this contract.

The primary workflow is:

```text
real browser operation
  -> Recorder correlates user input, crypto calls, and network requests
  -> an exact recorded call is retained directly when it already covers the required transform
  -> otherwise Deep Capture pauses at the relevant higher-level business call
  -> operator retains the real in-scope function as a page callable
  -> operator composes callables and typed nodes into a request/response transform profile
  -> Yakit Web Fuzzer remains a plaintext editor
  -> Yak asks the selected live browser to transform the request immediately before sending
  -> Yak sends the resulting wire packet
  -> Yak optionally asks the browser to transform the wire response
  -> Yakit displays plaintext and preserves a separate wire view
```

The browser is therefore an execution environment, not a passive code source. Non-extractable `CryptoKey` objects, closure variables, key promises, runtime tokens, random generators, timestamps, WASM instances, and application serializers remain in the page that already owns them.

There are two valid discovery outcomes:

1. **Direct recorded callable.** One observed primitive already accepts the logical plaintext and its output is proven to enter one wire destination. For example, `JSEncrypt.encrypt` with its real instance receiver can map an object body to form field `data`. The operator generates the guided gateway directly; no function expression or debugger pause is required.
2. **Business callable.** A request combines multiple primitives or surrounding serialization/dynamic state. AES ciphertext, RSA-wrapped key, signature, nonce, timestamp, and request canonicalization are treated as one request graph, then Deep Capture retains the higher-level closure. The extension never replays those low-level calls independently merely because each output has an exact field link.

## 2. Relationship to JS-RPC and JS-Forward

JS-RPC, JS-Forward, browser-side hook tools, and this gateway share the same basic idea: forward values into a browser JavaScript environment and receive transformed values back. The important product difference is the ownership and workflow around that call.

| Concern | Traditional forwarding setup | Browser Transform Gateway |
| --- | --- | --- |
| Function discovery | User locates and exposes a function manually | Recorder and Deep Capture lead from a real request to the relevant business frame |
| Runtime environment | Usually a manually maintained browser tab or injected service | Explicitly selected, paired, document-bound authenticated tab |
| Data-plane integration | External HTTP port or custom script modifies packets | Native Web Fuzzer pre-send and post-response hooks in the owning Yak gRPC process |
| Request editing | Often ciphertext-oriented or script-oriented | Plaintext is the canonical editable request |
| Observability | Tool-specific logs | Plaintext request, wire request, wire response, plaintext response, and step timing |
| Lifecycle | Caller must notice stale pages/functions | Navigation and refresh fail with document/origin errors; no silent retargeting |
| Authorization | Commonly a shared local endpoint | Paired device, task, grant, target, scope, and capability schema |

An external forwarding port can be added later as another Yak data-plane adapter for Burp/Fiddler compatibility. It must reuse the same profile execution contract and must not become a second configuration or authorization system.

Research notes and comparisons are retained in [`study.md`](study.md). They inform discovery and UX, but the production acceptance criterion is always whether a server accepts the transformed packet.

## 3. Component responsibilities

### Browser extension

- discovers page-side data flow through Recorder;
- captures a real business closure through Chromium Deep Capture;
- stores only document-bound callable metadata and transform profiles;
- keeps an optional replay draft per profile and direction in extension-local storage after the operator saves a gateway;
- validates route, method, origin, document, function binding, paths, and output mappings;
- executes an ordered Pipeline v2 DAG in the live MAIN world;
- sends the complete validated DAG and packet through one extension-to-page round trip instead of crossing the boundary for every node;
- returns bounded URL/body/header mutations plus per-node duration;
- never exports closure bindings or key material.

The replay draft is deliberately not a field of the transform profile. It may contain a plaintext account, password,
token, request headers, or a selected short capture sample. It is keyed by `profileId + request/response`, stays in
`browser.storage.local`, and is excluded from profile export, Bridge/RPC capabilities, Yak/AI context, audit, and
diagnostics. Deleting a profile deletes both directional drafts. The editor autosaves at most 256 KiB per direction;
larger input remains usable in the current Options page but replaces no persisted value.

### Yak engine

- performs profile preflight through the Bridge owned by the current gRPC process;
- composes the browser transform with existing Web Fuzzer hot-patch hooks;
- calls the selected browser immediately before the real request and immediately after the real response;
- fails closed before network transmission if request conversion fails;
- emits an explicit synthetic `598 Browser Transform Failed` response if response conversion fails;
- preserves logical and wire packets separately in every Fuzzer result and history item.

### Yakit

- lists only online paired browsers and profiles visible to the active grant;
- provides the full profile editor in Browser Integration;
- lets Web Fuzzer select one browser/profile pair without leaving the request workflow;
- keeps `RequestRaw` and `ResponseRaw` as the canonical plaintext editor/display values;
- exposes `WireRequestRaw` and `WireResponseRaw` through a stable side-by-side comparison;
- restores the selected browser/profile when reopening Fuzzer history.

## 4. Transform profile

A profile is intentionally document-bound and contains:

- a name and enabled state;
- `tabId + frameId + documentId + origin`;
- allowed HTTP methods and a bounded wildcard URL pattern;
- an optional request pipeline;
- an optional response pipeline;
- `failMode: closed`;
- a bounded per-profile concurrency limit from 1 to 8.

Method, URL, headers, body, captured short sample, and the last local replay result are not profile fields. The first
five can be restored from the separate local-only replay draft; execution results and errors are never persisted.

At least one direction must be enabled. Every enabled direction contains at least one node and one `output.write` node.

A path-only URL pattern such as `/api/*` or `*/api/login` is restricted to the bound page origin. Cross-origin APIs must be intentional: use a full pattern such as `https://api.example.test/*`. This prevents a broadly reusable path rule from turning a page-held key into a cross-origin signing oracle.

### Pipeline v2 nodes

Each node has a stable ID and may reference only an earlier node. This makes the data flow explicit and prevents cycles or undeclared reads. The supported node kinds are:

| Node | Purpose |
| --- | --- |
| `context.read` | Read a safe path from the immutable input context |
| `builtin` | Apply one whitelisted JSON/text/URL/Base64/Hex/object/form operation |
| `page.call` | Invoke one document-bound `BrowserPageCallable` with referenced arguments |
| `output.write` | Write a referenced value to an allowed packet destination |

The normal editor presents these nodes through a three-step guided compiler: choose the plaintext source, choose the
live page callable, and choose the wire destination. The ordered DAG is an implementation detail under “Advanced
Pipeline”; operators do not manually select node references for common request encryption.

For example, choosing `form field` with the name `encryptedData` compiles to:

```text
context.read(body)
  -> page.call(recorded AES callable)
  -> form.compose(keys=["encryptedData"])
  -> output.write(body)

value.literal("application/x-www-form-urlencoded")
  -> output.write(header.Content-Type)
```

`value.literal` is a bounded whitelist operation that accepts only a primitive value and no inputs. It exists so the
compiler can express fixed protocol metadata without arbitrary JavaScript. Existing non-canonical DAGs remain in the
advanced editor and are never silently rewritten.

`context.read` accepts these safe roots:

```text
method
url
statusCode
headers.content-type
body
body.account
body.password
text
bodyBase64
query
query.name
```

Missing node IDs, forward references, duplicate IDs, malformed paths, and prototype traversal segments are rejected. Arbitrary JavaScript is not a Pipeline node.

The background validates the profile, route, origin and live document before dispatch. The selected document then evaluates the complete bounded DAG locally, including all `page.call` nodes, and returns one structured result. This keeps multi-node profiles from multiplying `scripting.executeScript` latency and keeps the Pipeline executor out of the always-on Service Worker bundle.

### Output nodes

An `output.write` maps a prior node result to exactly one supported destination:

```text
body                  replace the complete body
body.password         update a JSON body field
header.X-Sign         set a header; null/undefined removes it
query.signature       set a URL query field; null/undefined removes it
```

Output encoding is explicit: `auto`, `text`, `json`, or `base64`. Header names and values reject CR/LF injection. JSON and form field mapping preserve their structured wire format and never mutate object prototypes. The extension can return a query-mutated URL, but Yak independently verifies that scheme, hostname, effective port and path are unchanged before replacing the request target.

## 5. Ordering

Request execution order is deliberate:

```text
plaintext request in Web Fuzzer
  -> user beforeRequest hot patch
  -> browser request transform
  -> actual wire request
```

Response execution uses the inverse boundary:

```text
actual wire response
  -> browser response transform
  -> user afterRequest hot patch
  -> plaintext response in Web Fuzzer
```

This allows ordinary Web Fuzzer mutation logic to work on meaningful application data. The browser transform remains the last operation before transmission and the first operation after receipt.

Redirected requests are transformed independently. A redirect to a route outside the selected profile fails closed instead of leaking a plaintext request to an unintended endpoint.

## 6. Failure and lifecycle semantics

The request path never falls back to sending plaintext. Profile lookup failure, offline device, expired grant, stale document, changed origin, unavailable callable, route mismatch, illegal URL mutation, queue overflow, invalid mapping, timeout, and page exception all abort transmission.

The response path never presents undecoded wire data as if it were plaintext. It returns an explicit transformation failure while preserving the wire response for diagnosis.

Profiles are not portable secrets. They may remain visible after a navigation so the operator can understand what became stale, but execution requires the exact current document and all referenced page callables. A reload intentionally requires recapture and rebinding.

Local replay drafts can contain secrets even though profiles do not. Navigation or a temporarily stale callable keeps
the draft intact so the operator does not lose work. The operator can clear the current direction explicitly, and
deleting its owning profile removes both request and response drafts. The draft does not make a stale callable
executable and is never silently rebound to another origin.

Chromium is required for capturing closure-bound business callables. Firefox keeps Recorder-created callables but does not advertise or display the Transform Gateway and Deep Capture workspaces.

## 7. Bounds and performance

- request and response bodies are limited to 8 MiB;
- a profile has at most 64 nodes per direction;
- a builtin or page-call node has at most 64 input references;
- a profile queue is bounded to 128 waiting operations;
- per-profile concurrency is 1, 2, 4, or 8 in the UI;
- page-callable output is lossless within bounds; cycles, functions, symbols, excessive depth/nodes, and oversized values fail explicitly;
- parsed and mapped JSON is limited to 64 levels and 100,000 nodes before a page function is invoked;
- previews may be truncated, execution values are never silently truncated;
- Bridge messages remain under the existing 16 MiB aggregate limit and use chunking above 512 KiB.

Concurrency must reflect the page function's state model. Use `1` when the application mutates shared counters, nonce state, or token caches. Higher values are appropriate only after verifying that the retained business function is re-entrant.

## 8. Authorization

Transform capabilities are separated by intent:

| Capability | Scope |
| --- | --- |
| `browser.transform.profile.list` | `browser.transform.read` |
| `browser.transform.profile.save/delete` | `browser.transform.manage` |
| `browser.transform.execute` | `browser.transform.execute` |

The Bridge router revalidates the profile target against the active grant for list, save, delete, and execute. An existing profile ID cannot be rebound to another page document.

## 9. Acceptance criteria

The production fixture uses live request and response functions that close over non-extractable AES-GCM and HMAC keys. The request function creates a new timestamp, nonce, and IV per call, encrypts a JSON login payload, and signs the resulting envelope. The server returns a second AES-GCM envelope that only the retained page response function opens. Acceptance requires all of the following:

1. A plaintext account/password packet is transformed through the retained page closure.
2. The wire packet does not contain the plaintext password.
3. The independent test server verifies HMAC, decrypts AES-GCM, and recovers the original request values.
4. The server returns an encrypted response with no plaintext password, and the retained page closure restores it to JSON.
5. Repeated calls produce different nonce and IV values.
6. A mismatched path or implicit cross-origin URL fails closed.
7. Web Fuzzer preserves and displays both plaintext and wire packets in both directions.
8. Refreshing the bound document invalidates execution rather than silently using a new page.

Extension browser E2E covers the real page and server boundary. Yak unit tests cover hook ordering, request/response conversion, trace preservation, and failure behavior. Yakit TypeScript verification covers the integrated selector, editor, and packet comparison surfaces.

The browser E2E suite also covers the direct RSA path independently: the real JSEncrypt browser bundle receives a generated RSA public key, its Base64 ciphertext is linked to `application/x-www-form-urlencoded` field `data`, and a separate HTTP test server holding the private key must decrypt and recover the original JSON. Raw key material must remain absent from the candidate/AI context. After recording stops, both Bridge- and UI-created callables must still invoke the retained receiver with a new structured plaintext value whose ciphertext the server-side decryptor can open.

## 10. Current boundary

The first production data-plane integration is Yakit Web Fuzzer. Direct Burp/Fiddler interception, WebSocket frame transformation, streaming bodies, and unattended cross-document callable recovery remain outside the current contract. They should be built as explicit extensions of this gateway, not as hidden fallbacks.

Automatic Profile inference is now part of the core product path rather than a later convenience. Recorder evidence, retained page callables, deterministic rules and task-bound AI analysis must lead from one real browser operation to an explainable Profile candidate. The architecture, evidence contract, AI boundary and phased implementation are defined in [`AUTO_PROFILE_INFERENCE_ARCHITECTURE.md`](AUTO_PROFILE_INFERENCE_ARCHITECTURE.md).
