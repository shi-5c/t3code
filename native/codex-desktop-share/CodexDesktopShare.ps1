[CmdletBinding()]
param(
    [ValidateSet('Preflight', 'Enable', 'Status', 'Restore')] [string]$Action = 'Preflight',
    [switch]$ReplaceExisting,
    [switch]$Share
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Lifecycle.psm1') -Force

$root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'T3Code\CodexDesktopShare'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$shellSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$packageName = 'OpenAI.Codex'
$registryName = 'CODEX_CLI_PATH'
$reviewedCliHashes = @{
    '26.1111.9664.0' = '49B0AD59A400C0812791D5F5518E9CDDB2A32E21E918801800655DBAB29382A1'
    '26.1117.4957.0' = '4069ACDD8D101830F63EA5E2775883BFECF8A152AE87EE1B0EF9F14204F850F9'
}

function Get-DesktopInstall {
    $installs = @(Get-AppxPackage -Name $packageName | Where-Object Name -CEQ $packageName)
    if ($installs.Count -ne 1) { throw 'Expected one Codex Desktop Store installation for the current user.' }
    $package = $installs[0]
    if ([string]$package.SignatureKind -ne 'Store' -or [string]$package.Status -ne 'Ok' -or
        [string]$package.Architecture -ne 'X64') { throw 'Unsupported Codex Desktop Store package.' }
    $manifest = Get-AppxPackageManifest -Package $package
    $launch = @($manifest.Package.Applications.Application | Where-Object {
        ([string]$_.Executable).Replace('/', '\') -ieq 'app\ChatGPT.exe'
    })
    if ($launch.Count -ne 1 -or $launch[0].Id -cnotmatch '^[A-Za-z0-9._-]+$') {
        throw 'Could not identify the original Codex Desktop launch entry.'
    }
    return @{
        Version = $package.Version.ToString()
        Desktop = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
        Cli = Join-Path $package.InstallLocation 'app\resources\codex.exe'
        AppId = "$($package.PackageFamilyName)!$($launch[0].Id)"
    }
}

function Read-UserSetting {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    if ($null -eq $key) { return @{ present = $false } }
    try {
        if ($key.GetValueNames() -notcontains $registryName) { return @{ present = $false } }
        return @{
            present = $true
            kind = $key.GetValueKind($registryName).ToString()
            value = $key.GetValue($registryName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        }
    } finally { $key.Dispose() }
}

function Write-UserSetting($Value) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        if ($Value.present) {
            $key.SetValue($registryName, $Value.value, [Microsoft.Win32.RegistryValueKind]$Value.kind)
        } else { $key.DeleteValue($registryName, $false) }
        $key.Flush()
    } finally { $key.Dispose() }
    if (-not ('T3DesktopEnvironmentNotification' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class T3DesktopEnvironmentNotification {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hwnd, uint message, UIntPtr wParam, string name, uint flags, uint timeout, out UIntPtr result);
}
'@
    }
    $result = [UIntPtr]::Zero
    $null = [T3DesktopEnvironmentNotification]::SendMessageTimeout(
        [IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 750, [ref]$result
    )
}

function Test-ProcessOwner($Process) {
    $owner = Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    return $null -ne $owner -and $owner.ReturnValue -eq 0 -and $owner.Sid -eq $ownerSid
}

function Assert-InteractiveSession {
    $shell = Get-CimInstance Win32_Process -Filter "Name='explorer.exe' AND SessionId=$shellSession"
    $owned = @($shell | Where-Object { $null -ne $_ -and (Test-ProcessOwner $_) })
    if ($shellSession -eq 0 -or $owned.Count -eq 0) {
        throw 'Run this command as the current interactive Windows Desktop user.'
    }
}

function Assert-ReviewedInstall($Install) {
    $expectedHash = $reviewedCliHashes[$Install.Version]
    if (-not $expectedHash -or -not [IO.File]::Exists($Install.Cli) -or
        (Get-FileHash -LiteralPath $Install.Cli -Algorithm SHA256).Hash -cne $expectedHash) {
        throw 'Codex Desktop or the packaged CLI differs from the reviewed Windows build.'
    }
    if (-not [IO.File]::Exists($compiler)) { throw 'The Windows .NET Framework compiler is unavailable.' }
    $machine = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
    try {
        if ($null -ne $machine -and $machine.GetValueNames() -contains $registryName) {
            throw 'A machine-level CODEX_CLI_PATH override is present. This command manages the user setting.'
        }
    } finally { if ($machine) { $machine.Dispose() } }
}

function Get-DesktopProcesses($Install) {
    Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' AND SessionId=$shellSession" |
        Where-Object {
            $_.ExecutablePath -ieq $Install.Desktop -and
            (Test-ProcessOwner $_)
        }
}

function Stop-Desktop($Install) {
    $desktopProcesses = @(Get-DesktopProcesses $Install)
    if ($desktopProcesses.Count -eq 0) { return }

    # Closing the main window can leave the Electron app running in the tray.
    if (-not ('T3DesktopRestartManager' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;

public static class T3DesktopRestartManager
{
    [StructLayout(LayoutKind.Sequential)]
    private struct UniqueProcess
    {
        public int Id;
        public FILETIME StartTime;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern uint RmStartSession(out uint session, uint flags, StringBuilder key);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern uint RmRegisterResources(
        uint session, uint fileCount, string[] files, uint processCount, [In] UniqueProcess[] processes,
        uint serviceCount, string[] services);

    [DllImport("rstrtmgr.dll")]
    private static extern uint RmShutdown(uint session, uint flags, IntPtr callback);

    [DllImport("rstrtmgr.dll")]
    private static extern uint RmEndSession(uint session);

    public static uint Shutdown(int[] processIds, long[] startTimes)
    {
        var processes = new UniqueProcess[processIds.Length];
        for (int index = 0; index < processIds.Length; index++)
        {
            long time = startTimes[index];
            processes[index] = new UniqueProcess
            {
                Id = processIds[index],
                StartTime = new FILETIME { dwLowDateTime = unchecked((int)time), dwHighDateTime = (int)(time >> 32) }
            };
        }
        uint session;
        uint status = RmStartSession(out session, 0, new StringBuilder(33));
        if (status != 0) return status;
        try
        {
            status = RmRegisterResources(session, 0, null, (uint)processes.Length, processes, 0, null);
            return status == 0 ? RmShutdown(session, 0, IntPtr.Zero) : status;
        }
        finally
        {
            RmEndSession(session);
        }
    }
}
'@
    }

    $processIds = [Collections.Generic.List[int]]::new()
    $startTimes = [Collections.Generic.List[long]]::new()
    $desktopIds = @($desktopProcesses.ProcessId)
    foreach ($entry in $desktopProcesses | Where-Object { $desktopIds -notcontains $_.ParentProcessId }) {
        $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $process -or $process.Path -ine $Install.Desktop -or $process.SessionId -ne $shellSession) {
            continue
        }
        $started = $process.StartTime.ToUniversalTime()
        if ([Math]::Abs(($started - $entry.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 10) { continue }
        $processIds.Add($process.Id)
        $startTimes.Add($started.ToFileTimeUtc())
    }
    if ($processIds.Count -gt 0) {
        $result = [T3DesktopRestartManager]::Shutdown($processIds.ToArray(), $startTimes.ToArray())
        if ($result -ne 0 -and @(Get-DesktopProcesses $Install).Count -gt 0) {
            throw "Windows did not close Codex Desktop gracefully (Restart Manager $result)."
        }
    }

    $timeout = [Diagnostics.Stopwatch]::StartNew()
    while ($timeout.Elapsed.TotalSeconds -lt 15) {
        if (@(Get-DesktopProcesses $Install).Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    throw 'Codex Desktop did not quit. Close it from its tray menu and retry.'
}

function Test-ForwardChain($Install, [string]$Candidate) {
    $desktop = @(Get-DesktopProcesses $Install)
    if ($desktop.Count -eq 0) { return $false }
    $candidateName = [IO.Path]::GetFileName($Candidate)
    $forwarders = @(Get-CimInstance Win32_Process -Filter "Name='$candidateName' AND SessionId=$shellSession" |
        Where-Object { $_.ExecutablePath -ieq $Candidate })
    foreach ($forwarder in $forwarders) {
        if (-not @($desktop | Where-Object {
            $_.ProcessId -eq $forwarder.ParentProcessId -and $_.CreationDate -le $forwarder.CreationDate
        }).Count) { continue }
        $children = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + [uint32]$forwarder.ProcessId)
        if (@($children | Where-Object {
            $_.ExecutablePath -ieq $Install.Cli -and $_.CreationDate -ge $forwarder.CreationDate
        }).Count) { return $true }
    }
    return $false
}

function Test-ShareEndpoint([string]$Candidate) {
    $endpoint = [IO.Path]::ChangeExtension($Candidate, '.endpoint')
    return [IO.File]::Exists($endpoint)
}

function Start-Desktop($Install, [string]$Candidate) {
    $launch = @{ FilePath = (Join-Path $env:SystemRoot 'explorer.exe')
        ArgumentList = ('shell:AppsFolder\' + $Install.AppId); WindowStyle = 'Hidden' }
    Start-Process @launch
    $timeout = [Diagnostics.Stopwatch]::StartNew()
    while ($timeout.Elapsed.TotalSeconds -lt 30) {
        if ($Candidate -and (Test-ForwardChain $Install $Candidate) -and
            (-not $Share -or (Test-ShareEndpoint $Candidate))) { return }
        if (-not $Candidate) {
            foreach ($entry in @(Get-DesktopProcesses $Install)) {
                $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
                if ($null -ne $process -and $process.MainWindowHandle -ne 0) { return }
            }
        }
        Start-Sleep -Milliseconds 350
    }
    throw 'The original launch entry did not reach the expected Codex Desktop process.'
}

function Install-Forwarder($Install, [string]$Candidate) {
    $binding = [IO.Path]::ChangeExtension($Candidate, '.cs')
    try {
        $source = 'internal static class PinnedCli { internal const string Path = @"' +
            $Install.Cli.Replace('"', '""') + '"; internal const string DesktopPath = @"' +
            $Install.Desktop.Replace('"', '""') + '"; internal const bool Share = ' +
            $Share.IsPresent.ToString().ToLowerInvariant() + '; }'
        [IO.File]::WriteAllText($binding, $source, [Text.Encoding]::Unicode)
        $compilerArgs = @('/nologo', '/optimize+', '/target:exe', '/platform:x64', '/reference:System.Security.dll',
            "/out:$Candidate", (Join-Path $PSScriptRoot 'Forwarder.cs'), (Join-Path $PSScriptRoot 'ShareBridge.cs'), $binding)
        & $compiler @compilerArgs | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($Candidate)) {
            throw 'Could not build the Codex Desktop stock CLI forwarder.'
        }
    } finally { [IO.File]::Delete($binding) }
}

$operations = @{
    ReadSetting = { Read-UserSetting }
    WriteSetting = { param($value) Write-UserSetting $value }
    IsRunning = { @(Get-DesktopProcesses (Get-DesktopInstall)).Count -gt 0 }
    Install = {
        param($candidate)
        $target = Get-DesktopInstall
        Assert-ReviewedInstall $target
        Install-Forwarder $target $candidate
    }
    Stop = { Assert-InteractiveSession; Stop-Desktop (Get-DesktopInstall) }
    Start = { param($candidate) Start-Desktop (Get-DesktopInstall) $candidate }
    IsForwarding = {
        param($candidate)
        (Test-ForwardChain (Get-DesktopInstall) $candidate) -and (-not $Share -or (Test-ShareEndpoint $candidate))
    }
}

if ($Action -in @('Preflight', 'Enable')) {
    Assert-InteractiveSession
    $install = Get-DesktopInstall
    Assert-ReviewedInstall $install
    if ($Share -and $install.Version -ne '26.1117.4957.0') {
        throw 'This Codex Desktop version has no verified WebSocket launch configuration.'
    }
}

if ($Action -eq 'Preflight') {
    [pscustomobject]@{
        status = 'Ready'
        version = $install.Version
        userOverridePresent = (Read-UserSetting).present
        desktopRunning = @(Get-DesktopProcesses $install).Count -gt 0
    } | ConvertTo-Json -Compress
    return
}

$result = Invoke-ShareLifecycle -Action $Action -Root $root -Operations $operations -ReplaceExisting:$ReplaceExisting
[pscustomobject]@{ status = $result } | ConvertTo-Json -Compress
