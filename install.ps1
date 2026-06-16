# token-tracker installer (Windows).
#
#   irm https://raw.githubusercontent.com/A-Gift-Of-Flame/token-tracker/main/install.ps1 | iex
#   # or, from a clone:  ./install.ps1
#
# End to end, no follow-up commands:
#   1. checks Node >= 22.5
#   2. puts `tt` on your PATH (user scope)
#   3. signs you in to your server (GitHub device flow) with auto-push on
#   4. installs the always-on Scheduled Task so usage syncs forever
#
# Re-running is safe. Optional: $env:TT_ENDPOINT to skip the prompt.

$ErrorActionPreference = 'Stop'
function Say  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "warn: $m" -ForegroundColor Yellow }

# --- 1. Node ---------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js not found. Install Node >= 22.5 from https://nodejs.org and re-run."
}
$v = (node -p 'process.versions.node').Split('.')
if ([int]$v[0] -lt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -lt 5)) {
  throw "Node >= 22.5 required (found $(node -v)). Upgrade and re-run."
}
Say "Node $(node -v) OK"

# --- locate source ---------------------------------------------------------
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
if ($scriptDir -and (Test-Path (Join-Path $scriptDir 'bin/tt.js'))) {
  $src = $scriptDir
} else {
  $src = Join-Path $env:LOCALAPPDATA 'token-tracker\repo'
  Say "Fetching token-tracker into $src"
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git not found and not running from a clone." }
  if (Test-Path (Join-Path $src '.git')) {
    git -C $src pull --ff-only --quiet
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path $src) | Out-Null
    git clone --depth 1 https://github.com/A-Gift-Of-Flame/token-tracker.git $src --quiet
  }
}

# --- 2. PATH ---------------------------------------------------------------
$binDir = Join-Path $env:LOCALAPPDATA 'token-tracker\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shim = Join-Path $binDir 'tt.cmd'
"@echo off`r`nnode `"$src\bin\tt.js`" %*" | Set-Content -Encoding ascii $shim
$tt = $shim
Say "Installed: $tt"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
  Warn "Added $binDir to your PATH. Open a new terminal for `tt` to resolve."
}

# --- 3. sign in (only if not already configured) ---------------------------
$dataDir   = if ($env:TOKEN_TRACKER_DIR) { $env:TOKEN_TRACKER_DIR } else { Join-Path $env:USERPROFILE '.token-tracker' }
$remoteJson = Join-Path $dataDir 'remote.json'
if (Test-Path $remoteJson) {
  Say "Already signed in ($remoteJson) - leaving auth as is."
} else {
  $endpoint = $env:TT_ENDPOINT
  if (-not $endpoint) { $endpoint = Read-Host 'Server URL (e.g. https://tt.example.com)' }
  if ($endpoint) {
    Say "Signing in to $endpoint (GitHub device flow, auto-push on)"
    & cmd /c "`"$tt`" login --github --endpoint $endpoint --auto-push"
  }
}

# --- 4. boot service -------------------------------------------------------
Say "Installing always-on sync service"
if ($env:TT_PRESENCE -eq '1') {
  & cmd /c "`"$tt`" service install --presence"
} else {
  & cmd /c "`"$tt`" service install"
}

Say "Done. Usage now syncs automatically, forever. Nothing else to run."
