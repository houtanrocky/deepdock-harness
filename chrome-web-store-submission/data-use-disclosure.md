# Chrome Web Store privacy practices fields

The Chrome Web Store requires the dashboard disclosures to match both the actual build and the published privacy policy. Google's policy says user data handled locally must still be disclosed. The extension processes chat content and saves it locally, so do not claim that it handles no user data.

## User data handled by this build

Select the matching categories in the dashboard's current data disclosure form. Dashboard labels may change; use the category definitions shown there.

- Website content: content from the active DeepSeek Chat conversation that the agent needs to read and continue the task.
- Web browsing activity: the DeepSeek conversation URL/path used to keep each conversation's saved history separate. DeepDock Harness does not monitor other sites.
- Personal communications and user-generated content: user prompts, model responses, and task/tool results saved as local conversation checkpoints or included in follow-up prompts.
- Authentication information: the bridge pairing token, stored in Chrome extension storage and sent only to the local bridge in an Authorization header.
- User activity: task submissions, task timestamps, iteration progress, and daily-send counts used for the coding-agent workflow. It does not log general keystrokes, mouse positions, or unrelated activity.
- Personally identifiable information: the active GitHub username returned when the user invokes the GitHub authentication-status tool. That account identifier can be saved as a tool result and included in relevant follow-up prompts.

Use the dashboard's exact **Web history** label for the saved DeepSeek conversation URL/path. All nine checkbox values and copy-ready justifications are in [PRIVACY-ANSWERS.md](PRIVACY-ANSWERS.md) and [privacy-fields.json](privacy-fields.json).

DeepDock Harness does not intentionally collect location, financial/payment information, or health information. It does not separately request real names, email addresses, or postal addresses as profile fields. Users can choose to put any kind of information into their DeepSeek conversation or project files; they should follow DeepSeek's own guidance for sensitive information.

## Where the data goes

- Chrome extension storage on the user's device stores settings, the bridge token, and conversation checkpoints.
- The local DeepDock Harness Bridge at `127.0.0.1` receives tool requests and returns tool results. Depending on the task, those requests and results can contain project paths, source text, command text, or command output. The bridge writes its own audit/runtime files locally.
- DeepSeek receives prompts and relevant context through the normal DeepSeek Chat interface, including task instructions and tool results needed for the model to continue. DeepDock Harness does not operate a server that receives this content.
- If the user explicitly invokes GitHub tools, the local GitHub CLI communicates with GitHub using the user's existing authentication.
- If the user explicitly hands a task to DeepSeek Harness, that separately installed local agent and its configured model/provider process the handoff according to their own configuration.

## Limited Use certification

The following statements describe the current source behavior; certify them in the dashboard only after confirming they remain true for the exact release:

- User data is used only to provide the coding-agent and recovery features described in the listing.
- User data is not sold, used for advertising, or shared with the extension developer for analytics.
- Data is transferred only to DeepSeek as part of the user's chat task, to the user's local bridge, and to GitHub or a configured local-agent provider when the user invokes those integrations.
- The developer does not receive chat transcripts, source files, bridge tokens, or usage telemetry from the extension.
