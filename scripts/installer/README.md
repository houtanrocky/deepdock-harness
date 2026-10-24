# Windows bridge installer

The installer creates a per-user DeepDock Bridge installation. It bundles Node.js, asks which existing project folder DeepDock may access, creates a local pairing token, copies that token to the clipboard, and starts the bridge in the background. The bridge starts again when the user signs in if the startup option remains enabled. The browser extension is packaged separately.

## Build

On Windows, install [Inno Setup 6](https://jrsoftware.org/isinfo.php), then run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/installer/build-installer.ps1
```

The script downloads the pinned Node.js 22.18.0 Windows x64 archive from nodejs.org, checks its SHA-256 against the official checksum file, stages the bridge, and compiles `dist/installer/DeepDock-Bridge-Setup-0.1.0-x64.exe`.

## Installed files and settings

- Program files: `%LOCALAPPDATA%\Programs\DeepDock Bridge`
- Configuration and pairing token: `%APPDATA%\DeepDock\config.json`
- Audit and bridge logs: `%APPDATA%\DeepDock\audit.jsonl` and `%APPDATA%\DeepDock\logs\`
- Start Menu shortcuts: **Start bridge** and **Stop bridge**

Uninstalling removes the app and its startup shortcut. It preserves the user's configuration and logs under `%APPDATA%\DeepDock`; delete that folder separately if you want to remove the saved token and settings too. Git and DeepSeek Harness remain optional external tools for their respective features.

The installer targets Windows x64 and does not install or package the browser extension.
