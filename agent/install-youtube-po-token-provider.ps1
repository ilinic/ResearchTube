<#
Installs the two local pieces required by bgutil-ytdlp-pot-provider:
  1. the yt-dlp plugin ZIP next to tools/yt-dlp/yt-dlp.exe;
  2. the BgUtils generator source in tools/youtube-pot-provider/.

The Agent invokes the generator through the already-installed Deno runtime.
Nothing is installed globally, no server is exposed, and PO Tokens are neither
written to configuration nor printed by this script.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$agentRoot = $PSScriptRoot
$toolsRoot = Join-Path $agentRoot "tools"
$ytDlpRoot = Join-Path $toolsRoot "yt-dlp"
$pluginRoot = Join-Path $ytDlpRoot "yt-dlp-plugins"
$providerRoot = Join-Path $toolsRoot "youtube-pot-provider"
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("researchtube-pot-" + [guid]::NewGuid().ToString("N"))

function Find-Deno {
  $local = Get-ChildItem -Path (Join-Path $toolsRoot "deno") -Filter "deno.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($local) { return $local.FullName }
  $fromPath = Get-Command deno -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }
  throw "Deno 2 or newer is required. Put deno.exe under agent/tools/deno first."
}

try {
  $deno = Find-Deno
  New-Item -ItemType Directory -Force -Path $pluginRoot, $temporaryRoot | Out-Null
  $release = Invoke-RestMethod -Headers @{ "User-Agent" = "ResearchTube installer" } -Uri "https://api.github.com/repos/Brainicism/bgutil-ytdlp-pot-provider/releases/latest"
  $plugin = @($release.assets | Where-Object { $_.name -eq "bgutil-ytdlp-pot-provider.zip" }) | Select-Object -First 1
  if (-not $plugin) { throw "The current bgutil release did not publish bgutil-ytdlp-pot-provider.zip." }

  $sourceZip = Join-Path $temporaryRoot "provider-source.zip"
  $pluginZip = Join-Path $pluginRoot "bgutil-ytdlp-pot-provider.zip"
  Invoke-WebRequest -UseBasicParsing -Uri $release.zipball_url -OutFile $sourceZip
  Invoke-WebRequest -UseBasicParsing -Uri $plugin.browser_download_url -OutFile $pluginZip
  Expand-Archive -Path $sourceZip -DestinationPath $temporaryRoot -Force
  $extracted = Get-ChildItem -Path $temporaryRoot -Directory | Where-Object { $_.FullName -ne $providerRoot } | Select-Object -First 1
  if (-not $extracted -or -not (Test-Path (Join-Path $extracted.FullName "server"))) { throw "Downloaded BgUtils source does not contain server/." }
  if (Test-Path $providerRoot) { Remove-Item -Recurse -Force $providerRoot }
  Move-Item -Path $extracted.FullName -Destination $providerRoot

  Push-Location (Join-Path $providerRoot "server")
  # The provider's current transitive native dependency is @swc/core. Deno
  # deliberately skips such scripts until explicitly approved. We approve only
  # that displayed package, then re-run installation to execute its postinstall.
  & $deno install --frozen
  if ($LASTEXITCODE -ne 0) { throw "Deno could not install BgUtils provider dependencies." }
  & $deno approve-scripts npm:@swc/core
  if ($LASTEXITCODE -ne 0) { throw "Deno could not approve the required @swc/core build script." }
  & $deno install --allow-scripts=npm:@swc/core --frozen
  if ($LASTEXITCODE -ne 0) { throw "Deno could not install BgUtils provider dependencies." }
  Pop-Location
  @{ provider = "bgutil"; version = [string]$release.tag_name; installedAt = [DateTime]::UtcNow.ToString("o") } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $providerRoot ".researchtube-provider-ready.json")
  Write-Host "ResearchTube PO-token provider installed. Restart the Local Agent."
}
finally {
  if (Test-Path $temporaryRoot) { Remove-Item -Recurse -Force $temporaryRoot }
}
