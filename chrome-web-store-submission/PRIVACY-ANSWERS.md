# Privacy tab — copy-ready answers

These answers match the version 0.2.2 extension package. The existing single-purpose, storage, and alarms explanations you entered describe the same behavior. The combined host explanation below also covers access to DeepSeek Chat.

## Single purpose description

DeepDock Harness turns a conversation on DeepSeek Chat into a user-controlled coding agent by connecting that conversation to local project tools through a separately installed loopback bridge.

## Storage justification

Stores the user's bridge address and pairing token, selected workspace, permission mode, iteration settings, custom DeepSeek selectors, conversation checkpoints, and daily-send counters. Temporary handoff state and tab ownership leases use session storage. This supports local task execution and recovery after a page reload or service-worker suspension. Data is kept in Chrome extension storage on the user's device.

## Alarms justification

Periodically wakes the extension service worker to check the status of a local-agent handoff if the DeepSeek tab is suspended. The alarm is created only while a handoff is being tracked and is cleared when no tracked handoffs remain.

## Host permission justification

http://127.0.0.1/* lets the service worker send authenticated JSON tool requests to the user's separately installed local bridge. Its port is configurable; settings reject non-loopback addresses, and requests carry the local pairing token in an Authorization header. https://chat.deepseek.com/* lets the content script add the agent panel, read the active conversation, detect task submissions, and enter follow-up prompts for the user's coding task. No other websites are monitored.

## Are you using remote code?

Select **No, I am not using Remote code**.

If the dashboard allows an explanation for this answer, use:

All JavaScript used by the extension is bundled in the uploaded package. It does not fetch or evaluate remote JavaScript or WebAssembly, load remote script tags, or use eval or new Function. The local bridge returns JSON tool definitions, results, and status data. Tool execution and optional agent handoff happen in a separately installed local process, not as remotely loaded code executed by the browser extension.

The bridge's tool data and the commands it runs locally are distinct from JavaScript or WebAssembly loaded and executed by the browser extension. This follows Chrome's [remote hosted code definition](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code).

## Data usage checkboxes

| Dashboard category | Select? | Reason for this build |
| --- | --- | --- |
| Personally identifiable information | **Yes** | The optional GitHub status tool returns the active GitHub username, an account identifier that can enter tool history and follow-up prompts. User-provided chat and files can also contain personal information. |
| Health information | No | No dedicated health-data feature or collection. |
| Financial and payment information | No | No payment or financial-data feature or collection. |
| Authentication information | **Yes** | The local bridge pairing token is saved and sent to the loopback bridge. |
| Personal communications | **Yes** | User task prompts, model replies, and relevant tool results are processed and saved in checkpoints. |
| Location | No | No geolocation or user-location collection. The fixed loopback address identifies the local bridge, not the user's location. |
| Web history | **Yes** | The active DeepSeek conversation origin/path identifies its saved checkpoint. General browser history is not read. |
| User activity | **Yes** | Task submissions, task timestamps, iteration progress, and daily-send counts support the agent workflow. It does not log general keystrokes, mouse positions, or unrelated activity. |
| Website content | **Yes** | The active DeepSeek conversation and task/tool text are read to carry out the coding task. |

Chrome requires disclosure of user data handled locally as well as data sent off the device. Do not claim that this extension handles no user data. See the [user-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

## Three certification checkboxes

For the current source, all three statements describe its behavior:

- **Check:** I do not sell or transfer user data to third parties, outside of the approved use cases.
- **Check:** I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- **Check:** I do not use or transfer user data to determine creditworthiness or for lending purposes.

Necessary transfers are limited to the local bridge, the user's DeepSeek task, and GitHub or a separately configured agent/provider when those tools are invoked. There is no developer telemetry or advertising data path. The checkboxes remain your publisher certification; keep them consistent with any practices outside this repository and with future changes.

## Privacy policy URL and transport

https://houtanrocky.github.io/deepdock-harness/privacy.html

The bridge uses HTTP at `127.0.0.1`, with a bearer token and loopback-only binding. The policy discloses this. Do not describe all communication as encrypted or guarantee store approval from these answers. Chrome's [secure-handling policy](https://developer.chrome.com/docs/webstore/program-policies/data-handling) is a separate review requirement.

Machine-readable copies are in [privacy-fields.json](privacy-fields.json). Every justification is below the dashboard's 1,000-character limit.
