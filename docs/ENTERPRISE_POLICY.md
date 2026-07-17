# Enterprise Deployment

The extension includes `managed-storage-schema.json`. Managed values are read-only and rechecked by background command handlers, not only reflected in disabled UI controls.

Supported policies:

| Key | Type | Effect |
| --- | --- | --- |
| `bridgeTransport` | `native` or `websocket` | Locks transport. |
| `bridgeEndpoint` | string | Locks the explicit loopback WebSocket endpoint. |
| `nativeHost` | string | Locks the Native Messaging host name. |
| `autoConnect` | boolean | Locks startup connection behavior. |
| `disableWebSocket` | boolean | Requires Native Messaging. |
| `floatingPanelEnabled` | boolean | Enables or disables the page panel. |
| `maxGrantMinutes` | integer, 5-1440 | Caps every grant even if the UI requests longer. |
| `grantAllowedOrigins` | origin array | Rejects grants containing any other origin. |
| `allowProgramEval` | boolean | Can prohibit the independent program Eval scope. |

Example managed policy values:

```json
{
  "bridgeTransport": "native",
  "nativeHost": "com.yaklang.browser_agent",
  "autoConnect": true,
  "disableWebSocket": true,
  "maxGrantMinutes": 60,
  "grantAllowedOrigins": ["https://security-lab.example"],
  "allowProgramEval": false,
  "floatingPanelEnabled": true
}
```

Chrome/Edge administrators distribute these values using the platform's extension managed-storage policy and can force-install the signed extension ID. Firefox administrators use the `3rdparty.Extensions` policy for the add-on ID `browser-agent@yaklang.com`. Native Host registration remains an operating-system deployment step; see [native-host/README.md](../native-host/README.md).

The Chrome enterprise package prefers User Scripts MAIN for CSP-compatible page execution and retains the packaged injected bridge as a fallback when User Scripts is unavailable. Administrators should enable User Scripts for the extension in managed Chrome deployments when strict-site CSP execution is required; the fallback remains suitable for explicitly managed sites whose CSP permits it.

Device pairing identities are deliberately excluded from managed storage. Pair each extension installation locally through Yakit. The extension keeps its non-extractable private key in IndexedDB and Yak stores only the approved public device identity, so a broadly readable policy backend never becomes a credential store.
