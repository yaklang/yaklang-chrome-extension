#!/usr/bin/env bash
set -euo pipefail

host_name="com.yaklang.browser_agent"
host_binary=""
extension_id=""
firefox_id="browser-agent@yaklang.com"
endpoint="ws://127.0.0.1:64333/extension"
uninstall=false

usage() {
  printf '%s\n' "Usage: $0 --extension-id ID [--host-binary PATH] [--endpoint WS_URL] [--firefox-id ID] [--uninstall]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host-binary) host_binary="${2:-}"; shift 2 ;;
    --extension-id) extension_id="${2:-}"; shift 2 ;;
    --firefox-id) firefox_id="${2:-}"; shift 2 ;;
    --endpoint) endpoint="${2:-}"; shift 2 ;;
    --uninstall) uninstall=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin)
    install_root="$HOME/Library/Application Support/Yakit/BrowserAgent"
    config_root="$HOME/Library/Application Support/yakit"
    chrome_roots=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    )
    firefox_root="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    ;;
  Linux)
    install_root="${XDG_DATA_HOME:-$HOME/.local/share}/yakit/browser-agent"
    config_root="${XDG_CONFIG_HOME:-$HOME/.config}/yakit"
    chrome_roots=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    )
    firefox_root="$HOME/.mozilla/native-messaging-hosts"
    ;;
  *) printf 'Unsupported operating system. Use install.ps1 on Windows.\n' >&2; exit 1 ;;
esac

manifest_name="$host_name.json"
if [[ "$uninstall" == true ]]; then
  for directory in "${chrome_roots[@]}" "$firefox_root"; do rm -f "$directory/$manifest_name"; done
  rm -f "$install_root/yakit-browser-agent-host" "$config_root/browser-agent-native-host.json"
  printf 'Removed %s manifests and host binary.\n' "$host_name"
  exit 0
fi

if [[ -z "$extension_id" ]]; then printf '%s\n' '--extension-id is required for Chrome/Chromium.' >&2; exit 2; fi
if [[ -z "$host_binary" ]]; then host_binary="$(command -v yakit-browser-agent-host || true)"; fi
if [[ -z "$host_binary" || ! -x "$host_binary" ]]; then
  printf '%s\n' 'Host binary not found. Build it with: go build -o yakit-browser-agent-host ./common/browser/nativehostcmd' >&2
  exit 1
fi
if [[ ! "$endpoint" =~ ^wss?://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?/ ]]; then
  printf '%s\n' 'Endpoint must use ws:// or wss:// with an explicit loopback host.' >&2
  exit 2
fi

mkdir -p "$install_root" "$config_root"
install -m 0755 "$host_binary" "$install_root/yakit-browser-agent-host"
printf '{"endpoint":"%s"}\n' "$endpoint" > "$config_root/browser-agent-native-host.json"

for directory in "${chrome_roots[@]}"; do
  mkdir -p "$directory"
  printf '{\n  "name": "%s",\n  "description": "Yakit Browser Agent Native Host",\n  "path": "%s",\n  "type": "stdio",\n  "allowed_origins": ["chrome-extension://%s/"]\n}\n' \
    "$host_name" "$install_root/yakit-browser-agent-host" "$extension_id" > "$directory/$manifest_name"
done

mkdir -p "$firefox_root"
printf '{\n  "name": "%s",\n  "description": "Yakit Browser Agent Native Host",\n  "path": "%s",\n  "type": "stdio",\n  "allowed_extensions": ["%s"]\n}\n' \
  "$host_name" "$install_root/yakit-browser-agent-host" "$firefox_id" > "$firefox_root/$manifest_name"

printf 'Installed %s at %s\n' "$host_name" "$install_root/yakit-browser-agent-host"
