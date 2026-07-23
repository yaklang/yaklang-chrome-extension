# Limited Use Disclosure

Yakit Browser Agent handles browsing activity, website content, authentication information, Cookie/browser-storage data and selected network request data only to provide its prominently disclosed authenticated-browser security-testing features.

The extension's use of this data complies with the following commitments:

- Data is used only to display browser context to the user, execute the user's bounded security workflow, or transmit an explicitly granted operation to the user's local Yak/Yakit engine.
- Data is not sold or transferred for advertising, marketing, creditworthiness, lending, or unrelated profiling.
- Humans do not read user data except when the user deliberately includes a redacted diagnostic artifact in a support request, or when required for security, abuse prevention or law.
- There is no developer-operated telemetry endpoint. Aggregate operational metrics remain on device.
- Sensitive request fields and recording previews are off by default. Page-callable execution, debugger read/control and program Eval have separate high-risk scopes. Deep Capture is one-shot and auto-resumes after 45 seconds without an active control surface. Cookie exports are redacted by default.
- After the user explicitly saves a Transform Gateway, its bounded plaintext replay draft may remain in extension-local storage for that profile and request/response direction. It is visibly local-only, independently clearable, deleted with the profile, and excluded from Bridge/Yak/AI messages, diagnostics, audit and profile export.
- The local Native Host receives only the same purpose-bound messages the user authorized; it is not an independent data collector.

Store privacy-form answers, listing text and the hosted privacy policy must remain consistent with this disclosure and actual packaged behavior. See the [Chrome Limited Use guidance](https://developer.chrome.com/docs/webstore/user_data) and [Mozilla Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/).
