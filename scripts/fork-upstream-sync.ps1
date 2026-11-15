param([string]$Destination)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
function Invoke-Git([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs) {
    $result = & git -C $repoRoot @GitArgs
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArgs[0]) failed ($LASTEXITCODE)." }
    return $result
}
if (Invoke-Git @('status', '--porcelain')) { throw 'Commit or stash your changes before preparing an upstream merge.' }
$branch = Invoke-Git @('branch', '--show-current')
if (-not $branch) { throw 'Check out your fork branch first.' }
$url = Invoke-Git @('config', '--get', 'remote.upstream.url')
if ($url -notmatch 'github\.com[:/]pingdotgg/t3code(?:\.git)?$') { throw 'The upstream remote must point to pingdotgg/t3code.' }
Invoke-Git @('fetch', 'upstream', 'main') | Out-Host
& git -C $repoRoot merge-base --is-ancestor upstream/main HEAD
if ($LASTEXITCODE -eq 0) { Write-Host 'This branch already includes upstream/main.'; exit 0 }
if ($LASTEXITCODE -ne 1) { throw 'Cannot compare the fork with upstream/main.' }
$revision = (Invoke-Git @('rev-parse', '--short=12', 'upstream/main')).Trim()
$candidate = "sync/upstream-$revision"
if (-not $Destination) { $Destination = Join-Path (Split-Path $repoRoot -Parent) "t3code-upstream-$revision" }
$Destination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $Destination) { throw "Destination already exists: $Destination" }
Invoke-Git @('worktree', 'add', '-b', $candidate, $Destination, $branch) | Out-Host
& git -C $Destination merge --no-edit upstream/main
if ($LASTEXITCODE -ne 0) {
    throw "Resolve the merge in $Destination, then commit and run vp run check:changed. Your original checkout is unchanged."
}
Write-Host "Prepared $candidate in $Destination"
Write-Host "Validate there: vp install --frozen-lockfile; vp run check:changed $branch"
Write-Host "After desktop acceptance, merge it into $branch with: git merge --ff-only $candidate"
