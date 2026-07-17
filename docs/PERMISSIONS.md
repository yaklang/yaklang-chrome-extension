# Permission Inventory

Every permission maps to a shipped, user-facing feature. Future functionality is not a reason to retain an unused permission.

| Permission | Purpose | User control |
| --- | --- | --- |
| `proxy` | Apply direct/system/fixed/PAC profiles and deterministic routing rules. | Profiles and rules are visible and switchable; passwords are session-only. |
| `storage` | Store split settings, active session, bounded audit and aggregate metrics. | Audit, action timeline and metrics can be cleared; diagnostics export is explicit. |
| `tabs` | Resolve the exact user-selected tab and open Options/Yakit workflow pages. | Grant and target picker identify the tab. |
| `scripting` | Run packaged frame probes, stable-node operations and page observation. | Page operations are explicit and scoped. |
| `cookies` | Provide the Cookie Editor and explicitly granted authentication context. | Values are hidden and exports redacted by default. |
| `declarativeNetRequest` | Change the real outbound User-Agent request header. | Named UA rules are visible and removable. |
| `webRequest` | Capture bounded Fetch/XHR/Form metadata and proxy rule hits. | Capture starts explicitly; headers/body are off by default. |
| `webNavigation` | Track frame/document identity and SPA/document lifecycle. | Used to reject stale or cross-origin targets. |
| `webRequestAuthProvider` (Chrome) / `webRequestBlocking` (Firefox) | Answer proxy authentication challenges. | Username is in the profile; password is browser-session-only. |
| `userScripts` (Chrome Store/Enterprise) | Execute user/Agent-selected page code through Chrome's documented MAIN-world User Scripts API. | Chrome also requires the user to enable Allow User Scripts; expression/program grants are separate. |
| `nativeMessaging` (optional) | Connect to the installed local Yakit Native Host. | Requested only when the user selects Native Host in Options. |
| `<all_urls>` host access | Support authenticated testing on the HTTP(S) site selected by the user, the floating task control, frame inventory and request capture. | Site panel rules and task-bound grants narrow actual Agent access. Browser-internal pages remain unavailable. |

`activeTab` is intentionally not requested. Firefox AMO does not request `userScripts`; its public build is invoke-only and excludes general page function invocation/Eval. Chrome Store does not package the injected Eval bridge.

References: [Chrome minimum permission policy FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), [Chrome MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements), and [Mozilla Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/).
