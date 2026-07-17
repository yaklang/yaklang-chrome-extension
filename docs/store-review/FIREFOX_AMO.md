# Firefox AMO Review Packet

The public Firefox artifact is `pnpm build:firefox:amo`, producing Firefox MV3 in `.output/firefox-mv3-store`.

Mozilla's current Add-on Policies reserve `userScripts` for user-script managers. Yakit Browser Agent is not marketed as one, so the AMO artifact does not request `userScripts`, does not package `page-main-world.js`, and does not advertise `browser.invoke` or `browser.eval`. It retains structured context, document-bound node commands, request capture, observation, Cookie/UA/proxy tools and human handoff. Local or enterprise Firefox builds can use the injected adapter outside the public AMO channel.

The manifest targets Firefox 140+ and declares required built-in data consent categories: authentication information, browsing activity, website activity and website content. There is no remote technical/user-interaction telemetry; operational metrics stay local until the user exports a diagnostics file.

Official references: [Mozilla Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/) and [Firefox built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).

Reviewer steps mirror the Chrome structured-command flow but must confirm that no function-call/Eval tabs or Bridge capabilities are present. Native Messaging remains optional and any data sent to the local host remains subject to the same disclosure and user controls.

Owner-only remaining work: AMO account, signed submission, source-code archive if requested, hosted privacy URL, reviewer correspondence and approval.
