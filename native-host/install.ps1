param(
  [string]$ExtensionId = "",
  [string]$HostBinary = "yakit-browser-agent-host.exe",
  [string]$FirefoxId = "browser-agent@yaklang.com",
  [string]$Endpoint = "ws://127.0.0.1:64333/extension",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$HostName = "com.yaklang.browser_agent"
$InstallRoot = Join-Path $env:LOCALAPPDATA "Yakit\BrowserAgent"
$ConfigRoot = Join-Path $env:APPDATA "yakit"
$ManifestPath = Join-Path $InstallRoot "$HostName.json"
$RegistryTargets = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
)

function Write-JsonFile {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][object]$Value)
  [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 4), $script:Utf8NoBom)
}

if ($Uninstall) {
  foreach ($Target in $RegistryTargets) { Remove-Item $Target -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $ConfigRoot "browser-agent-native-host.json") -Force -ErrorAction SilentlyContinue
  Write-Host "Removed $HostName."
  exit 0
}

if ($Endpoint -notmatch '^wss?://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?/') {
  throw "Endpoint must use ws:// or wss:// with an explicit loopback host."
}
if ([string]::IsNullOrWhiteSpace($ExtensionId)) {
  throw "ExtensionId is required when installing the Native Host."
}
$ResolvedBinary = (Resolve-Path $HostBinary).Path
New-Item $InstallRoot -ItemType Directory -Force | Out-Null
New-Item $ConfigRoot -ItemType Directory -Force | Out-Null
$InstalledBinary = Join-Path $InstallRoot "yakit-browser-agent-host.exe"
Copy-Item $ResolvedBinary $InstalledBinary -Force
Write-JsonFile -Path (Join-Path $ConfigRoot "browser-agent-native-host.json") -Value @{ endpoint = $Endpoint }

Write-JsonFile -Path $ManifestPath -Value @{
  name = $HostName
  description = "Yakit Browser Agent Native Host"
  path = $InstalledBinary
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

$FirefoxManifestPath = Join-Path $InstallRoot "$HostName.firefox.json"
Write-JsonFile -Path $FirefoxManifestPath -Value @{
  name = $HostName
  description = "Yakit Browser Agent Native Host"
  path = $InstalledBinary
  type = "stdio"
  allowed_extensions = @($FirefoxId)
}

foreach ($Target in $RegistryTargets) {
  New-Item $Target -Force | Out-Null
  $Value = if ($Target -like "*Mozilla*") { $FirefoxManifestPath } else { $ManifestPath }
  Set-Item $Target -Value $Value
}
Write-Host "Installed $HostName at $InstalledBinary"
