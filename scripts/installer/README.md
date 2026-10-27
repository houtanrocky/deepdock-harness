# Windows desktop bridge app

The per-user installer bundles Node.js and a native Windows desktop app with a
system tray menu. Choose the project folder during setup, then open **DeepDock
Harness Bridge** from the Start menu. The bridge stays stopped until you click
**Start bridge**. DeepDock is not added to Windows startup. Upgrading removes the
startup shortcut made by the original installer and preserves the pairing token.

## Pair the extension

1. In the desktop app's **Bridge** tab, click **Start bridge**, then **Copy token**.
2. Open DeepSeek with the extension loaded. In the DeepDock Harness panel, click
   **Open Settings > Bridge token**, paste the token, and **Save settings**.
3. Click **Test connection**, then **Enable agent**.

Both the app's **Help & setup** tab and the extension's **Help** tab explain these
steps, tray controls, and connection recovery. The token is copied only when you
ask; it is never displayed in the app or passed on the command line.

**Stop bridge** requests an authenticated shutdown and reports errors visibly.
Stop or finish active tasks in the extension first. **Force stop bridge...** asks
for confirmation and shows the exact process IDs, server paths, and runtimes. It
can stop this installation's bridge or an older DeepDock bridge on the configured
loopback port, including one launched from source with system Node.js. Recovery
checks the Node entrypoint, DeepDock server code, Windows account ownership, and
process creation time before ending the process tree. Unrelated services and
DeepDock bridges on other ports are excluded. Unverified port owners produce a
visible error. Use this to recover without Task Manager, even with a stale token.

Closing the window keeps the app in the tray. Double-click its tray icon to
reopen it; right-click for Start, Stop, Copy token, Help, and Exit. **Exit** stops
the bridge before closing the app; a failed shutdown keeps the controls available.
Launching the app again restores the existing window.

## Build and verify

On Windows, install [Inno Setup 6](https://jrsoftware.org/isinfo.php), then run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/installer/build-installer.ps1
powershell -NoProfile -STA -ExecutionPolicy Bypass -File scripts/installer/test-desktop.ps1
```

The build checks the pinned Node.js 22.18.0 x64 archive against the official
SHA-256 checksum, compiles the desktop app with the Windows .NET Framework 4 C#
compiler, and creates `dist/installer/DeepDock-Harness-Bridge-Setup-0.2.1-x64.exe`.
The UI smoke test uses an isolated temporary installation and configuration. It
checks Start, Stop, token copy, Help, tray restore, legacy recovery with another
runtime and token, other-port isolation, Exit, and installer shutdown. Screenshots are saved
under `dist/installer/evidence/`. Run `npm test` for controller regression tests.

## Installed files and settings

- App: `%LOCALAPPDATA%\Programs\DeepDock Harness Bridge\DeepDock.exe`
- Configuration and token: `%APPDATA%\DeepDock\config.json`
- Audit and bridge logs: `%APPDATA%\DeepDock\audit.jsonl` and `logs\`
- Start menu: **DeepDock Harness Bridge** and **Uninstall**
- Installed `start-deepdock.cmd` and `stop-deepdock.cmd` use the bundled runtime
  and installed configuration. The repository stop script also discovers the
  installed configuration, even when no source configuration exists.

Upgrade and uninstall ask the desktop app to stop and exit before replacing or
removing its files. Uninstall preserves configuration and logs; delete the
DeepDock folder under AppData separately to remove the saved token too. The
installer targets Windows x64 and packages the bridge app; install the browser
extension separately. Git and DeepSeek Harness are optional external tools.
