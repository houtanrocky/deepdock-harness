# DeepDock Harness Privacy Policy

**Effective date:** October 24, 2026

**Developer:** [houtanrocky](https://github.com/houtanrocky)

**Contact:** [Project issue tracker](https://github.com/houtanrocky/deepdock-harness/issues) for privacy questions without sensitive data; [private vulnerability reporting](https://github.com/houtanrocky/deepdock-harness/security/advisories/new) for sensitive security reports.

**Project website:** https://houtanrocky.github.io/deepdock-harness/

DeepDock Harness is a browser extension that adds a coding-agent panel to DeepSeek Chat. It connects the conversation to a separately installed local DeepDock Harness Bridge so the user can request work on a selected project folder.

## Information DeepDock Harness handles

DeepDock Harness handles the contents of the active DeepSeek Chat conversation, including prompts, model responses, and task results needed to continue or recover a coding task. It also handles the conversation URL/path to separate saved conversations. The extension stores the bridge address, pairing token, selected workspace, permission mode, iteration settings, and custom selectors. Depending on the task, prompts or results can include source code, file paths, command text, or command output.

DeepDock Harness stores these settings and conversation checkpoints in Chrome extension storage on the user's device. Temporary handoff status is stored in session storage. The separately installed bridge writes its own audit and runtime logs locally. DeepDock Harness does not operate a server that receives this information and does not collect analytics or telemetry.

## How information is used and shared

DeepDock Harness uses conversation content to identify and carry out the user's requested coding task. It sends authenticated tool requests to the DeepDock Harness Bridge at `127.0.0.1`. The bridge can read or change files and run commands within its configured workspace according to the selected permission mode.

DeepDock Harness enters follow-up prompts and relevant context into the user's normal DeepSeek Chat conversation. DeepSeek receives that information and handles it under its own terms and privacy practices. Tool results may be included in follow-up prompts so the model can continue the task.

If the user invokes GitHub tools, the local GitHub CLI communicates with GitHub using the user's existing credentials. If the user invokes a handoff to DeepSeek Harness, that separately installed program and the model/provider configured for it process the handoff under their own terms and settings.

The extension does not sell user data, use it for advertising, or share it with the developer for analytics. It does not read the user's clipboard or access unrelated websites.

## Retention and deletion

Conversation checkpoints and settings remain in Chrome extension storage until the user clears the extension's stored data or removes the extension. Bridge configuration, audit records, logs, and task artifacts are stored separately on the user's computer. The user can delete those local files and the bridge's `.dsh-pro` task data from their computer.

## Security

The extension communicates with the bridge over HTTP on the loopback interface (`127.0.0.1`) and authenticates requests with a locally generated bearer token. The bridge is configured to listen only on the loopback interface and limits file access to configured workspaces. The user should protect access to their Windows account and should not share their bridge token.

## Changes and contact

Material changes to these practices will be reflected in this policy and the Chrome Web Store disclosures. For privacy questions, contact [PUBLIC PRIVACY CONTACT EMAIL].

---

Publisher action required: replace all bracketed placeholders, confirm the data flow for the exact release, and publish this policy at a stable public HTTPS URL before submitting.
