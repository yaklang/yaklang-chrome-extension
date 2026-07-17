# Yakit Browser Agent Native Host

The Native Host is a small stdio-to-loopback-WebSocket transport. It does not store pairing credentials and does not execute browser commands itself. It forwards the normal Bridge v3 server challenge and extension authentication messages; Yak validates the origin-bound paired device signature and returns the engine identity, engine instance, connection, session, task, grant, protocol, and capability identity.

Build from the Yak repository:

```bash
go build -o yakit-browser-agent-host ./common/browser/nativehostcmd
```

Install for Linux or macOS, using the ID shown by `chrome://extensions` for an unpacked build:

```bash
./native-host/install.sh \
  --host-binary /absolute/path/to/yakit-browser-agent-host \
  --extension-id YOUR_CHROME_EXTENSION_ID
```

On Windows, run PowerShell without administrator privileges:

```powershell
.\native-host\install.ps1 -HostBinary C:\path\yakit-browser-agent-host.exe -ExtensionId YOUR_CHROME_EXTENSION_ID
```

The installer registers Chrome, Chromium, Edge, Brave, and Firefox per-user locations. Chrome supplies its extension origin to the host. Firefox supplies the Native Host manifest path and add-on ID; the host verifies that ID against `allowed_extensions` before deriving its Bridge origin. It writes only the loopback endpoint to the user configuration directory. Run with `--uninstall` on POSIX or `-Uninstall` on Windows to remove the registrations; uninstall does not require an extension ID. When Chrome runs on Windows and development runs in WSL, build/install the Windows host with `install.ps1`; a Linux Native Host cannot be launched by Windows Chrome.
