# Package horizon-discuss plugin zip for GitHub Release
# Usage: .\scripts\package.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version
$dist = Join-Path $root "dist"
$staging = Join-Path $dist "horizon-discuss"
$zipName = "horizon-discuss-$version.zip"
$zipPath = Join-Path $dist $zipName

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null

$files = @("main.js", "manifest.json", "styles.css", "agent-reach-fetch.py", "INSTALL.md")
foreach ($f in $files) {
  Copy-Item (Join-Path $root $f) (Join-Path $staging $f)
}

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $staging -DestinationPath $zipPath -Force

Write-Host "Created $zipPath"
