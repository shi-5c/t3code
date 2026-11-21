Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-SameSetting($Left, $Right) {
    return $Left.present -eq $Right.present -and (
        -not $Left.present -or ($Left.kind -ceq $Right.kind -and $Left.value -ceq $Right.value)
    )
}

function Assert-Setting($Setting) {
    if ($Setting.present -isnot [bool] -or ($Setting.present -and (
        $Setting.kind -cnotin @('String', 'ExpandString') -or $Setting.value -isnot [string]
    ))) { throw 'Invalid or unsupported CODEX_CLI_PATH value.' }
}

function Read-Transaction([string]$Journal) {
    if (-not [IO.File]::Exists($Journal)) { return }
    $transaction = [IO.File]::ReadAllText($Journal) | ConvertFrom-Json
    if ($transaction.version -ne 1 -or $transaction.id -cnotmatch '^[a-f0-9]{32}$' -or
        $transaction.phase -cnotin @('prepared', 'closing', 'activating', 'forwarding', 'restoring') -or
        $transaction.wasRunning -isnot [bool] -or $transaction.imageHash -cnotmatch '^([0-9A-F]{64})?$') {
        throw 'Invalid Codex Desktop recovery journal.'
    }
    Assert-Setting $transaction.previous
    return $transaction
}

function Save-Transaction([string]$Journal, $Transaction) {
    $temporary = "$Journal.pending"
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Transaction | ConvertTo-Json -Compress -Depth 5))
    $file = [IO.File]::Open($temporary, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $file.Write($bytes, 0, $bytes.Length)
        $file.Flush($true)
    } finally { $file.Dispose() }
    if ([IO.File]::Exists($Journal)) {
        [IO.File]::Replace($temporary, $Journal, "$Journal.previous")
        [IO.File]::Delete("$Journal.previous")
    }
    else { [IO.File]::Move($temporary, $Journal) }
}

function Get-ManagedSetting([string]$Root, $Transaction) {
    return @{ present = $true; kind = 'String'; value = (Join-Path $Root ("forward-" + $Transaction.id + ".exe")) }
}

function Restore-Transaction([string]$Journal, $Transaction, $Managed, [hashtable]$Operations) {
    $current = & $Operations.ReadSetting
    $matchesManaged = Test-SameSetting $current $Managed
    if (-not $matchesManaged -and -not (Test-SameSetting $current $Transaction.previous)) {
        throw 'CODEX_CLI_PATH changed independently. Recovery journal retained.'
    }

    $phase = $Transaction.phase
    if ($phase -in @('activating', 'forwarding', 'restoring') -or $matchesManaged) {
        $Transaction.phase = 'restoring'
        Save-Transaction $Journal $Transaction
        if ($matchesManaged) { & $Operations.WriteSetting $Transaction.previous }
        if (-not (Test-SameSetting (& $Operations.ReadSetting) $Transaction.previous)) {
            throw 'Previous CODEX_CLI_PATH did not read back. Recovery journal retained.'
        }
        try {
            & $Operations.Stop
            if ($Transaction.wasRunning) { & $Operations.Start $null }
        } catch { throw 'The original setting was restored. A Desktop restart is still needed. Run Restore to retry.' }
    } elseif ($phase -eq 'closing' -and $Transaction.wasRunning -and -not (& $Operations.IsRunning)) {
        & $Operations.Start $null
    }

    if ([IO.File]::Exists($Managed.value) -and $Transaction.imageHash -and
        (Get-FileHash -LiteralPath $Managed.value -Algorithm SHA256).Hash -ceq $Transaction.imageHash) {
        $endpoint = [IO.Path]::ChangeExtension($Managed.value, '.endpoint')
        [IO.File]::Delete($endpoint)
        $name = [IO.Path]::GetFileName($endpoint)
        $generationFile = '^' + [regex]::Escape($name) + '\.[0-9a-f]{32}\.(key|pending)$'
        foreach ($file in Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($endpoint)) -File -Filter "$name.*") {
            if ($file.Name -cmatch $generationFile) { [IO.File]::Delete($file.FullName) }
        }
        [IO.File]::Delete($Managed.value)
    }
    [IO.File]::Delete($Journal)
    [IO.File]::Delete("$Journal.pending")
    [IO.File]::Delete("$Journal.previous")
}

function Invoke-ShareLifecycle {
    param(
        [Parameter(Mandatory)] [ValidateSet('Enable', 'Restore', 'Status')] [string]$Action,
        [Parameter(Mandatory)] [string]$Root,
        [Parameter(Mandatory)] [hashtable]$Operations,
        [switch]$ReplaceExisting
    )

    $Root = [IO.Path]::GetFullPath($Root)
    if ($Action -ne 'Enable' -and -not [IO.Directory]::Exists($Root)) { return 'Unconfigured' }
    # Use a user-local journal and never follow reparse points through a managed directory.
    for ($directory = [IO.DirectoryInfo]::new($Root); $null -ne $directory; $directory = $directory.Parent) {
        if ($directory.Exists -and ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The Codex Desktop bridge directory must not use filesystem redirection.'
        }
    }
    [void][IO.Directory]::CreateDirectory($Root)
    $lock = [IO.FileStream]::new(
        (Join-Path $Root 'transaction.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose
    )
    try {
        $journal = Join-Path $Root 'transaction.json'
        $transaction = Read-Transaction $journal
        $current = & $Operations.ReadSetting
        Assert-Setting $current
        if ($null -ne $transaction) {
            $managed = Get-ManagedSetting $Root $transaction
            $isManaged = Test-SameSetting $current $managed
            if ($Action -eq 'Restore') {
                Restore-Transaction $journal $transaction $managed $Operations
                return 'Restored'
            }
            if ($transaction.phase -eq 'forwarding' -and $isManaged -and
                [IO.File]::Exists($managed.value) -and
                (Get-FileHash -LiteralPath $managed.value -Algorithm SHA256).Hash -ceq $transaction.imageHash) {
                if (& $Operations.IsForwarding $managed.value) { return 'Forwarding' }
                if ($Action -eq 'Status') { return 'Configured' }
                throw 'The forwarder is configured but has no running Desktop. Open Desktop or run Restore.'
            }
            if ($Action -eq 'Enable') { throw 'A recovery journal is present. Run Restore before enabling.' }
            if ($isManaged -or (Test-SameSetting $current $transaction.previous)) { return 'RestartPending' }
            return 'Conflict'
        }
        if ($Action -ne 'Enable') { return 'Unconfigured' }
        if ($current.present -and -not $ReplaceExisting) {
            throw 'An existing user override is present. Confirm replacement before enabling.'
        }
        $transaction = [pscustomobject]@{
            version = 1
            id = [Guid]::NewGuid().ToString('N')
            previous = $current
            wasRunning = [bool](& $Operations.IsRunning)
            imageHash = ''
            phase = 'prepared'
        }
        $managed = Get-ManagedSetting $Root $transaction
        Save-Transaction $journal $transaction
        try {
            & $Operations.Install $managed.value
            $transaction.imageHash = (Get-FileHash -LiteralPath $managed.value -Algorithm SHA256).Hash
            $transaction.phase = 'closing'
            Save-Transaction $journal $transaction
            & $Operations.Stop
            if (-not (Test-SameSetting (& $Operations.ReadSetting) $current)) {
                throw 'CODEX_CLI_PATH changed before activation.'
            }
            $transaction.phase = 'activating'
            Save-Transaction $journal $transaction
            & $Operations.WriteSetting $managed
            if (-not (Test-SameSetting (& $Operations.ReadSetting) $managed)) {
                throw 'The managed setting did not read back.'
            }
            & $Operations.Start $managed.value
            $transaction.phase = 'forwarding'
            Save-Transaction $journal $transaction
            return 'Forwarding'
        } catch {
            $failure = $_.Exception.Message
            try { Restore-Transaction $journal $transaction $managed $Operations }
            catch { throw "Codex Desktop bridge activation failed. Restore using the recovery journal. $($_.Exception.Message)" }
            throw "Codex Desktop bridge activation failed. The original setting was restored. $failure"
        }
    } finally { $lock.Dispose() }
}

Export-ModuleMember -Function Invoke-ShareLifecycle
