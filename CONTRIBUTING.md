# Contributing to DeepDock Harness

Start with an issue describing the concrete behavior you want to fix or add. For a bug, include the extension and bridge versions, browser version, selected permission mode, expected behavior, and a small reproduction. Remove pairing tokens, private conversation text, and project secrets from examples and screenshots.

Use Node.js 22.18 or newer. Clone the repository, run `npm ci`, then follow [DEVELOPMENT.md](DEVELOPMENT.md) for setup and the source map. The companion installer currently targets Windows x64.

Before opening a pull request, run the checks appropriate to your change:

```powershell
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

For bridge changes, also run `node bridge/build.js`. Browser tests use local fixtures and a fixture bridge, not your DeepSeek account. Visible UI changes should include a screenshot with example data. Changes to the live chat adapter should be checked against both semantic and observed layout fixtures.

Keep changes focused and follow the surrounding JavaScript style. Preserve workspace guards, loopback authentication, saved permission policy, execution checkpoints, and the rule against automatically replaying uncertain effects. Add bridge tools through the [registry contract](bridge/tool-modules/README.md).

Never commit `bridge/config.json`, credentials, logs, or generated `.dsh-pro/` data. Publish packaged downloads through GitHub Releases rather than adding installers or extension ZIPs to Git history.

A pull request should explain the problem, the resulting behavior, and the checks run. Call out changes to permissions, authentication, command execution, or data handling. Security reports follow [SECURITY.md](SECURITY.md).
