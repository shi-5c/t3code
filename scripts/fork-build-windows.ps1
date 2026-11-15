param([ValidateSet('x64', 'arm64')][string]$Architecture = 'x64')
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$origin = (& git -C $repoRoot remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0 -or $origin -notmatch 'github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$') { throw 'Set origin to your GitHub fork before building.' }
$updateRepository = $Matches[1]
if ($updateRepository -eq 'pingdotgg/t3code') { throw 'Build fork releases with your own origin so updates retain the bridge.' }
$previous = $env:T3CODE_DESKTOP_UPDATE_REPOSITORY
try {
    $env:T3CODE_DESKTOP_UPDATE_REPOSITORY = $updateRepository
    Push-Location -LiteralPath $repoRoot
    try {
        & vp run "dist:desktop:win:$Architecture"
        if ($LASTEXITCODE -ne 0) { throw "Desktop build failed ($LASTEXITCODE)." }
    } finally { Pop-Location }
} finally { $env:T3CODE_DESKTOP_UPDATE_REPOSITORY = $previous }
