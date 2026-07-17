# Release Checklist

## Automated gates

- `pnpm verify:production`
- `pnpm verify:ui:store`
- `pnpm verify:ui:enterprise`
- `pnpm verify:ui:enterprise:fallback`
- `pnpm verify:native` (real Chromium -> Native Host -> Yak Bridge transport; temporary test copy pre-grants the otherwise optional browser permission)
- `go test ./common/browser/... ./common/ai/aid/aitool/buildinaitools/yakscripttools` in Yak
- Store package has no injected Eval bridge.
- Firefox AMO package has no `page-main-world.js`, `userScripts`, `browser.invoke` or `browser.eval` capability.
- Required permissions match `docs/PERMISSIONS.md`; Native Messaging is optional.
- Windows manifests are written as UTF-8 without BOM and Chrome, Chromium, Edge, Brave and Firefox registrations are per-user.
- Diagnostic and audit fixtures contain no secrets, URLs, request payloads or Eval source.

## Human gates

- Review listing text, screenshots and single-purpose statement.
- Host and link the privacy policy.
- Complete Chrome privacy/Limited Use and Firefox data consent declarations.
- Build/sign Native Host binaries for Windows, macOS and Linux; scan and publish checksums.
- Replace unpacked extension IDs in Native Host manifests with signed IDs.
- Test current stable Chrome, Firefox, Windows, macOS and Linux packages on real machines.
- Run `go test ./common/ai/aid/aitool/buildinaitools/...` against a seeded, writable Yakit profile database; the recursive integration package expects existing built-in tools and is not a clean-profile unit test.
- Submit to Chrome Web Store and AMO, answer reviewer questions, and record approval/version IDs.

The human gates require external accounts, signing keys, store systems and operating systems. They cannot be truthfully marked approved from a source workspace; the repository contains the implementation and reviewer artifacts needed to execute them.
