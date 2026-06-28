# BRP Native Messaging Host Installer (Windows)
#
# Installs the native messaging manifest by adding a registry key:
#   HKCU\Software\Mozilla\NativeMessagingHosts\org.brp.bridge
# pointing to the manifest file with the real brp-bridge binary path.
#
# Usage:
#   .\install.ps1                     # Install with default browser detection
#   .\install.ps1 -Browser Firefox    # Install for Firefox only
#   .\install.ps1 -Browser Zen        # Install for Zen only
#   .\install.ps1 -Browser Both       # Install for both
#   .\install.ps1 -Uninstall          # Remove registry entries for all browsers
#   .\install.ps1 -Uninstall -Browser Firefox  # Remove Firefox only
#
# Requires: cargo build --release (bridge binary must exist)

param(
  [ValidateSet("Firefox", "Zen", "Both", "Detect")]
  [string]$Browser = "Detect",

  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath
$ProjectDir = Split-Path -Parent $ScriptDir
$ManifestTemplate = Join-Path $ProjectDir "native-manifest\org.brp.bridge.json"
$Binary = Join-Path $ProjectDir "bridge\target\release\brp-bridge.exe"

# ─── Binary check (install only) ───

if (-not $Uninstall) {
  if (-not (Test-Path $Binary)) {
    Write-Error "Bridge binary not found at $Binary"
    Write-Error "       Build it first: cd $ProjectDir\bridge; cargo build --release"
    exit 1
  }
  $BinaryPath = (Resolve-Path $Binary).Path
  Write-Host "[install] Binary: $BinaryPath"
}

# ─── Manifest template check ───

if (-not (Test-Path $ManifestTemplate)) {
  Write-Error "Manifest template not found at $ManifestTemplate"
  exit 1
}

# ─── Browser detection ───

function Detect-Browsers {
  $found = @()
  # Firefox
  if (Test-Path "$env:LOCALAPPDATA\Mozilla\Firefox") { $found += "Firefox" }
  if (Test-Path "$env:APPDATA\Mozilla\Firefox") { $found += "Firefox" }
  # Zen
  if (Test-Path "$env:LOCALAPPDATA\zen") { $found += "Zen" }
  if (Test-Path "$env:APPDATA\zen") { $found += "Zen" }
  return ($found | Select-Object -Unique)
}

if ($Browser -eq "Detect") {
  $Detected = Detect-Browsers
  if ($Detected.Count -eq 0) {
    Write-Warning "Could not detect Firefox or Zen. Use -Browser to specify."
    Write-Warning "  .\install.ps1 -Browser Firefox"
    exit 1
  }
  $Browser = ($Detected -join " ")
  Write-Host "[detect] Found: $Browser"
}

# ─── Registry helpers ───

$RegPath = @{
  "Firefox" = "HKCU:\Software\Mozilla\NativeMessagingHosts\org.brp.bridge"
  "Zen"     = "HKCU:\Software\Mozilla\NativeMessagingHosts\org.brp.bridge"
  # Zen also uses the Mozilla namespace for Native Messaging in current builds
}

function Install-Registry {
  param([string]$BrowserName)

  $key = $RegPath[$BrowserName]
  $parent = Split-Path -Parent $key
  $leaf   = Split-Path -Leaf $key

  if (-not $Uninstall) {
    # Create a copy of the manifest with the real binary path
    $tmpManifest = Join-Path $env:TEMP "org.brp.bridge-$BrowserName.json"
    (Get-Content $ManifestTemplate -Raw) `
      -replace 'PLACEHOLDER_ABSOLUTE_PATH_TO_BRP_BRIDGE_EXECUTABLE', $BinaryPath.Replace('\', '\\') `
      | Set-Content -Path $tmpManifest -Encoding UTF8 -NoNewline
    # Ensure newline at end (Firefox native messaging spec requires it)
    Add-Content -Path $tmpManifest -Value ""

    # Create/update registry
    if (-not (Test-Path $parent)) {
      New-Item -Path $parent -Force | Out-Null
    }
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name "(Default)" -Value $tmpManifest

    Write-Host "[install] $BrowserName → registry: $key"
    Write-Host "          manifest: $tmpManifest"
  }
  else {
    if (Test-Path $key) {
      Remove-Item -Path $key -Recurse -Force
      Write-Host "[uninstall] $BrowserName ← removed registry: $key"
    }
    else {
      Write-Host "[uninstall] $BrowserName — not installed (no registry key)"
    }
    # Also clean up temp manifest
    $tmpManifest = Join-Path $env:TEMP "org.brp.bridge-$BrowserName.json"
    if (Test-Path $tmpManifest) {
      Remove-Item $tmpManifest -Force
    }
  }
}

# ─── Execute ───

foreach ($b in ($Browser -split ' ')) {
  Install-Registry -BrowserName $b
}

Write-Host ""
if ($Uninstall) {
  Write-Host "✅ Native messaging manifest(s) removed from registry."
}
else {
  Write-Host "✅ Native messaging manifest(s) installed."
  Write-Host "   Next: Load the extension in Firefox/Zen → about:debugging"
  Write-Host "         Then start the bridge: cd $ProjectDir\bridge; cargo run"
}
