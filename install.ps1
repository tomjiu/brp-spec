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

# P0 fix: script is IN the repo root, not a subdirectory
$ProjectDir = Split-Path -Parent $PSCommandPath
$ManifestTemplate = Join-Path $ProjectDir "native-manifest\org.brp.bridge.json"
$Binary = Join-Path $ProjectDir "bridge\target\release\brp-bridge.exe"

# ─── Error helper (red text, no PS stack trace) ───

function Write-ErrorRed {
  param([string]$Message)
  Write-Host $Message -ForegroundColor Red
}

# ─── Binary check (install only) ───

if (-not $Uninstall) {
  if (-not (Test-Path $Binary)) {
    Write-ErrorRed "ERROR: Bridge binary not found at $Binary"
    Write-ErrorRed "       Build it first: cd $ProjectDir\bridge; cargo build --release"
    exit 1
  }
  $BinaryPath = (Resolve-Path $Binary).Path
  Write-Host "[install] Binary: $BinaryPath"
}

# ─── Manifest template check ───

if (-not (Test-Path $ManifestTemplate)) {
  Write-ErrorRed "ERROR: Manifest template not found at $ManifestTemplate"
  exit 1
}

# ─── Persistent manifest directory (not TEMP — survives cleanup) ───

$ManifestDir = Join-Path $env:LOCALAPPDATA "brp-bridge"
if (-not (Test-Path $ManifestDir)) {
  New-Item -Path $ManifestDir -ItemType Directory -Force | Out-Null
}

# ─── Browser detection ───

function Detect-Browsers {
  $found = @()
  if (Test-Path "$env:LOCALAPPDATA\Mozilla\Firefox") { $found += "Firefox" }
  if (Test-Path "$env:APPDATA\Mozilla\Firefox") { $found += "Firefox" }
  if (Test-Path "$env:LOCALAPPDATA\zen") { $found += "Zen" }
  if (Test-Path "$env:APPDATA\zen") { $found += "Zen" }
  return ($found | Select-Object -Unique)
}

if ($Browser -eq "Detect") {
  $Detected = Detect-Browsers
  if ($Detected.Count -eq 0) {
    Write-Host "WARNING: Could not detect Firefox or Zen. Use -Browser to specify." -ForegroundColor Yellow
    Write-Host "  .\install.ps1 -Browser Firefox" -ForegroundColor Yellow
    exit 1
  }
  Write-Host "[detect] Found: $($Detected -join ', ')"
  $browserList = $Detected
} elseif ($Browser -eq "Both") {
  $browserList = @("Firefox", "Zen")
} else {
  $browserList = @($Browser)
}

# ─── Registry helpers ───

$RegPath = @{
  "Firefox" = "HKCU:\Software\Mozilla\NativeMessagingHosts\org.brp.bridge"
  "Zen"     = "HKCU:\Software\Mozilla\NativeMessagingHosts\org.brp.bridge"
}

function Install-Registry {
  param([string]$BrowserName)

  $key = $RegPath[$BrowserName]
  $parent = Split-Path -Parent $key

  if (-not $Uninstall) {
    # Create manifest with real binary path (UTF-8 no BOM via .NET API)
    $manifestFile = Join-Path $ManifestDir "org.brp.bridge-$BrowserName.json"
    $content = (Get-Content $ManifestTemplate -Raw) -replace `
      'PLACEHOLDER_ABSOLUTE_PATH_TO_BRP_BRIDGE_EXECUTABLE',
      $BinaryPath.Replace('\', '\\')
    # Firefox native messaging spec requires trailing newline
    if (-not $content.EndsWith("`n")) { $content += "`n" }
    # Write UTF-8 without BOM (PowerShell 5.x safe)
    [System.IO.File]::WriteAllText(
      $manifestFile,
      $content,
      [System.Text.UTF8Encoding]::new($false)
    )

    # Create/update registry
    if (-not (Test-Path $parent)) {
      New-Item -Path $parent -Force | Out-Null
    }
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name "(Default)" -Value $manifestFile

    Write-Host "[install] $BrowserName → registry: $key"
    Write-Host "          manifest: $manifestFile"
  }
  else {
    if (Test-Path $key) {
      Remove-Item -Path $key -Recurse -Force
      Write-Host "[uninstall] $BrowserName ← removed registry: $key"
    }
    else {
      Write-Host "[uninstall] $BrowserName — not installed (no registry key)"
    }
    # Clean up manifest file
    $manifestFile = Join-Path $ManifestDir "org.brp.bridge-$BrowserName.json"
    if (Test-Path $manifestFile) {
      Remove-Item $manifestFile -Force
    }
  }
}

# ─── Execute ───

foreach ($b in $browserList) {
  Install-Registry -BrowserName $b
}

Write-Host ""
if ($Uninstall) {
  Write-Host "Native messaging manifest(s) removed from registry."
}
else {
  Write-Host "Native messaging manifest(s) installed."
  Write-Host "   Next: Load the extension in Firefox/Zen -> about:debugging"
  Write-Host "         Then start the bridge: cd $ProjectDir\bridge; cargo run"
}
