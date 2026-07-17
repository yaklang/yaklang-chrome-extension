# Chrome Web Store Review Packet

## Single purpose

Yakit Browser Agent provides consent-gated browser context and request workflows for authorized security testing with a local Yak/Yakit engine. Cookie, proxy, UA, observation and request tools support that single authenticated-browser testing workflow; they do not provide unrelated browsing, advertising or content features.

## Remote code policy

The Store build is produced by `pnpm build:store`.

- It requires Chrome 138+ and uses the documented `userScripts.execute({ world: "MAIN" })` path.
- `page-main-world.js` is absent from the package and web-accessible resources.
- Expression and program Eval use independent grant scopes; program mode is not in the default control preset.
- If Allow User Scripts is disabled, the UI reports the condition and does not fall back to injected Eval.
- Page results are untrusted and bounded. Structured context/node commands are preferred.

Chrome's MV3 policy names User Scripts as an API permitted to execute remote logic when used for its documented purpose: [Additional Requirements for Manifest V3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements).

## User data and Limited Use

The listing and privacy form must disclose authentication information, browsing activity, website content, Cookie/storage data, request data and local Native Messaging transmission. Data is handled only for the user-facing security workflow, sent only to the user's explicit local endpoint, never sold, never used for advertising, and not sent to developer analytics. Local processing still requires disclosure under the [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

## Reviewer test

1. Build with `pnpm build:store` and load `.output/chrome-mv3-store`.
2. Enable Allow User Scripts on the extension details page.
3. Open an HTTP(S) page, Options, and select the target tab.
4. Create a five-minute read grant and verify context succeeds but Eval is denied.
5. Create a control grant. Expression Eval succeeds; program Eval remains denied until separately enabled.
6. Start metadata-only request capture. Headers/body appear only after their explicit switches are enabled.
7. Trigger and complete a handoff; verify the action timeline and audit contain metadata only.
8. Inspect the Store artifact: no `page-main-world.js`, no `activeTab`, and `nativeMessaging` is optional.

Automated equivalent: `pnpm verify:ui:store`.

## Submission fields still requiring owner action

- Developer account ownership and verified contact details.
- Stable privacy-policy URL hosting `docs/PRIVACY_POLICY.md`.
- Final signed extension ID for Native Host allowlisting.
- Store screenshots/promotional assets selected from `.artifacts/ui`.
- Privacy questionnaire answers matching this packet.
- Actual upload, reviewer correspondence and approval.
