# Security reports

Report a suspected vulnerability privately through [GitHub private vulnerability reporting](https://github.com/houtanrocky/deepdock-harness/security/advisories/new). Include the affected version, the relevant configuration with secrets removed, a small reproduction, and the impact you observed.

Do not include pairing tokens, API keys, private conversation history, or proprietary source files in public issues. Ordinary setup problems and redacted bug reports can go through the [issue tracker](https://github.com/houtanrocky/deepdock-harness/issues).

Security fixes target the latest release. The bridge is designed to listen on `127.0.0.1` and authenticate requests with a local token. Direct file tools validate workspace paths. Full access permits unrestricted shell commands, and local agent handoffs use the separate agent’s policy. Treat those choices as access to your development environment.

DeepDock Harness does not guarantee exactly-once execution after a crash or lost response. Review the workspace before resuming an uncertain operation. DeepSeek receives the prompts and tool results included in its normal chat interface under its own terms.
