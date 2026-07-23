# Proxy Routing Architecture

> Status: production baseline, 2026-07-18

## Product boundary

The proxy workspace solves three browser-level tasks:

1. maintain reusable proxy endpoints;
2. select an endpoint directly or through deterministic automatic routing;
3. consume large community rule lists without moving list traversal into the request path.

`Yakit MITM` is a built-in HTTP proxy endpoint. The extension can route a site to it, but does not start, stop, configure, or introspect Yak MITM. MITM traffic policy remains owned by Yak/Yakit. This keeps browser routing independent from engine lifecycle and still allows the extension rules to act as an inexpensive upstream filter.

## Runtime model

```text
Options / Popup / floating panel
        |
        | typed runtime request + Valibot validation
        v
Background proxy service
        |
        +-- settings.proxy.v1
        |     endpoints, manual rules, source summaries, runtime state
        |
        +-- IndexedDB: yakit-proxy-rules
        |     source revisions, 512-rule chunks, compiled PAC artifacts
        |
        +-- compiler
        |     manual branches + source host tries + precompiled regex slow path
        v
browser.proxy.settings
        |
        v
FindProxyForURL(url, host)
```

IndexedDB is not queried by `FindProxyForURL`. It is an asset repository for download, editing, search, paging, export, and compilation. The browser receives one immutable PAC snapshot, so a request never waits for extension messaging, storage, React, or a service worker wake-up.

## Routing order

Automatic routing has one explicit order:

1. enabled manual rules, ordered by `order`;
2. enabled rule sources, ordered by `order`;
3. the configured default endpoint.

Within a source without custom SwitchyOmega results, exclusion rules are evaluated before positive rules. A source exclusion uses `bypassProfileId`; a positive rule uses `matchProfileId`. SwitchyOmega lists with `@with result` retain file order and resolve `+name` against an endpoint ID or display name. An unknown or non-routable result is an application error, never a silent fallback.

Only `direct` and `fixed_servers` endpoints may be automatic-routing results. `system` and external `pac_script` profiles can be selected directly, but cannot be nested inside the generated PAC.

## Supported source formats

- AutoProxy and base64-encoded GFWList syntax, including `@@` exclusions;
- SwitchyOmega Conditions, including typed host/URL wildcard and regex conditions plus `@with result`;
- plain domain lists;
- hosts files with IPv4/IPv6 followed by one or more hostnames.

Auto detection is intentionally conservative. Unsupported cosmetic Adblock rules are ignored and counted. Invalid domains and regular expressions are reported with bounded diagnostics. A downloaded revision with zero usable rules is rejected.

GitHub `/blob/` URLs are converted to `raw.githubusercontent.com`. Updates use `ETag` and `Last-Modified` validators, run on a 30-minute browser alarm, and honor each source's update interval. A source is limited to 10 MB.

## Storage and memory

`source-revisions` stores the original decoded content and metadata. `rule-chunks` stores normalized rules in 512-item chunks indexed by source and revision. Normal paging reads only intersecting chunks. Search streams chunks with an IndexedDB cursor and retains only the requested result page in memory.

`compiled-artifacts` caches PAC output by a deterministic configuration revision. Only the eight newest artifacts are retained. Source updates are staged under a new revision; the old revision remains referenced until parse, compile, browser application, and state commit succeed. Obsolete revisions are pruned after a successful commit.

Configuration exchange includes source content for reproducibility, excludes proxy passwords, limits each source to 10 MB, and limits aggregate embedded source content to 25 MB.

## PAC compiler

Manual rules are expected to stay small and compile to ordered conditions. Large host-exact and host-suffix source rules compile into reversed-label tries shared by result group. URL wildcard and regex rules are created once as top-level `RegExp` objects rather than reconstructed per request.

The generated artifact is rejected above 4 MB. It warns above 1 MB or when more than 1,000 conditions enter the regex slow path. Regular expressions are compiled and validated before `browser.proxy.settings` changes.

The regression suite compiles and executes a 50,000-domain source. This protects the central performance property: large domain lists add trie data, not 50,000 sequential `if` statements and not 50,000 extension-side listeners.

## Atomicity and failure behavior

All state mutations use the shared background mutation queue. Applying automatic routing compiles from the exact state held inside that queue, changes `browser.proxy.settings`, and commits the matching runtime revision before the next edit can enter.

A rule-source response is discarded if its URL or format changed while the request was in flight. Download, parse, compile, PAC-size, endpoint-resolution, and browser-API failures leave the preceding source revision and live PAC in place. The UI exposes the error and labels the source as using its previous version.

Deleting an active fixed endpoint is rejected. Saving an active endpoint reapplies it immediately. Import switches the browser and state to direct mode together; imported automatic rules remain explicitly dirty until the user applies them.

## Browser limitations

Chrome may pass only scheme, hostname, and port to PAC for HTTPS URLs. Host conditions are therefore the reliable default. URL path, query, keyword, and regex conditions remain available for HTTP and browser-dependent cases, and the editor displays this limitation beside URL conditions.

Proxy authentication credentials are separate from durable settings. Usernames are part of an endpoint; passwords live in `storage.session` and an in-memory cache. `onAuthRequired` selects credentials by proxy challenger host and port. No request-level rule hit collector is installed.

## UI ownership

- Popup: see the live mode, explain the current site's route, assign the exact current hostname to any Direct/HTTP(S)/SOCKS/Yakit MITM endpoint, restore subscription/default routing, and switch the browser's global mode independently.
- Options / Proxy endpoints: maintain Direct, System, fixed HTTP(S)/SOCKS, PAC, bypass, and session authentication settings.
- Options / Automatic routing: inspect applied/dirty state, choose defaults, explain a URL, edit and reorder manual rules, and view compilation metrics.
- Options / Rule subscriptions: add, update, enable, reorder, search, page, import, and export rule sources.
- Floating panel: switch to automatic routing or a fixed endpoint without loading the management workspace.

These surfaces share the same runtime request handlers. There is no UI-only proxy implementation.

## Verification

Required checks for changes to this subsystem:

```bash
pnpm compile
pnpm test
pnpm build
pnpm verify:ui
```

Unit tests cover condition families, real PAC execution, exclusions, source-result validation, parser formats, and 50,000-domain compilation. Browser E2E verifies runtime schemas, direct mode, deterministic reorder/preview, fail-open PAC output, session authentication, automatic application, screenshots, and service-worker recovery.
