$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Lifecycle.psm1') -Force

function Assert-True($Value, [string]$Message) {
    if (-not $Value) { throw $Message }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('t3-share-test-' + [Guid]::NewGuid().ToString('N'))
$missing = @{ present = $false }
$expandable = @{ present = $true; kind = 'ExpandString'; value = '%LocalAppData%\example.exe' }
$changed = @{ present = $true; kind = 'String'; value = 'another-launcher.exe' }
$state = @{
    setting = $missing; events = [Collections.Generic.List[string]]::new(); forwarding = $false
    failStart = $false; conflictOnStart = $false; failStop = $false
}
$operations = @{
    ReadSetting = { $state.setting }
    WriteSetting = { param($value) $state.setting = $value; $state.events.Add('write') }
    IsRunning = { $true }
    IsForwarding = { $state.forwarding }
    Install = { param($path) [IO.File]::WriteAllText($path, 'fixture') }
    Stop = {
        $state.events.Add('stop')
        if ($state.failStop) { throw 'Synthetic quit failure.' }
        $state.forwarding = $false
    }
    Start = {
        param($bridge)
        if ($bridge) {
            $state.events.Add('start-bridge')
            if ($state.conflictOnStart) { $state.setting = $changed; throw 'Synthetic configuration conflict.' }
            if ($state.failStart) { throw 'Synthetic launch failure.' }
            $state.forwarding = $true
        } else { $state.events.Add('start-stock') }
    }
}

try {
    $result = Invoke-ShareLifecycle -Action Enable -Root $root -Operations $operations
    Assert-True ($result -eq 'Forwarding') 'A healthy activation should be reported as forwarding.'
    Assert-True ($state.setting.present -and $state.setting.kind -eq 'String') 'The managed override is active.'
    Assert-True (($state.events -join ',') -eq 'stop,write,start-bridge') 'Desktop must stop before the setting changes.'
    Assert-True ((Invoke-ShareLifecycle -Action Enable -Root $root -Operations $operations) -eq 'Forwarding') 'Enable is idempotent.'
    $state.forwarding = $false
    Assert-True ((Invoke-ShareLifecycle -Action Status -Root $root -Operations $operations) -eq 'Configured') 'A closed Desktop is configured without a live forwarding chain.'
    $endpoint = [IO.Path]::ChangeExtension($state.setting.value, '.endpoint')
    $pendingKey = "$endpoint.$([Guid]::NewGuid().ToString('N')).key"
    [IO.File]::WriteAllText($endpoint, 'fixture endpoint')
    [IO.File]::WriteAllText($pendingKey, 'fixture incomplete startup')
    $null = Invoke-ShareLifecycle -Action Restore -Root $root -Operations $operations
    Assert-True (-not [IO.File]::Exists($endpoint) -and -not [IO.File]::Exists($pendingKey)) 'Restore removes data owned by the retired bridge generation.'
    Assert-True (-not $state.setting.present) 'Restore preserves a missing registry value.'
    Assert-True (($state.events -join ',') -eq 'stop,write,start-bridge,write,stop,start-stock') 'Restore resets the setting before launching stock.'
    Assert-True ((Invoke-ShareLifecycle -Action Restore -Root $root -Operations $operations) -eq 'Unconfigured') 'Restore is idempotent.'

    $state.setting = $expandable
    $state.events.Clear()
    try { $null = Invoke-ShareLifecycle -Action Enable -Root $root -Operations $operations; throw 'Unexpected enable.' }
    catch { Assert-True ($_.Exception.Message -like '*existing user override*') 'An external override requires explicit replacement.' }
    Assert-True ($state.events.Count -eq 0) 'Declining to replace an override must not restart the app.'
    $state.failStart = $true
    try { $null = Invoke-ShareLifecycle -Action Enable -Root $root -Operations $operations -ReplaceExisting; throw 'Unexpected enable.' }
    catch { Assert-True ($_.Exception.Message -like '*restored*') 'A launch failure must report successful rollback.' }
    Assert-True ($state.setting.kind -eq 'ExpandString' -and $state.setting.value -ceq $expandable.value) 'Rollback restores the raw expandable value and its type.'
    Assert-True (($state.events -join ',') -eq 'stop,write,start-bridge,write,stop,start-stock') 'Rollback opens stock after restoring the prior setting.'

    $state.failStart = $false
    $state.conflictOnStart = $true
    try { $null = Invoke-ShareLifecycle -Action Enable -Root $root -Operations $operations -ReplaceExisting; throw 'Unexpected enable.' }
    catch { Assert-True ($_.Exception.Message -like '*recovery*') 'Concurrent changes must retain recovery information.' }
    Assert-True ($state.setting.value -ceq $changed.value) 'Rollback must preserve an independently edited value.'
    Assert-True ((Invoke-ShareLifecycle -Action Status -Root $root -Operations $operations) -eq 'Conflict') 'The interrupted transaction remains visible.'
    $state.setting = $expandable
    $state.conflictOnStart = $false
    $state.failStop = $true
    try { $null = Invoke-ShareLifecycle -Action Restore -Root $root -Operations $operations; throw 'Unexpected restore.' }
    catch { Assert-True ($_.Exception.Message -like '*restart*') 'Failure after registry restoration must keep restart pending.' }
    Assert-True ((Invoke-ShareLifecycle -Action Status -Root $root -Operations $operations) -eq 'RestartPending') 'An interrupted restore is resumable.'
    $state.failStop = $false
    Assert-True ((Invoke-ShareLifecycle -Action Restore -Root $root -Operations $operations) -eq 'Restored') 'Retry completes the interrupted restoration.'

    $source = Join-Path $root 'BridgeAssertions.cs'
    $binary = Join-Path $root 'bridge-assertions.exe'
    [IO.File]::WriteAllText($source, @'
using System;
using System.Linq;

internal static class PinnedCli
{
    internal const string Path = "codex.exe";
    internal const string DesktopPath = "desktop.exe";
    internal const bool Share = true;
}

internal static class BridgeAssertions
{
    private static int Main()
    {
        var owner = new[] { "-c", "features.code_mode_host=true", "app-server",
            "--analytics-default-enabled", "-c", "features.prefer_mxc=true", "-c",
            "plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true" };
        if (!ShareBridge.IsDesktopOwner(owner))
            throw new Exception("The observed Desktop owner arguments must enter the bridge.");
        if (!ShareBridge.IsDesktopOwner(owner.Concat(new[] {
            "--mcp-launch-cwd", "server", "root with spaces", "workdir" }).ToArray()))
            throw new Exception("Known plugin launch working directories must be forwarded.");
        if (ShareBridge.IsDesktopOwner(owner.Concat(new[] { "--listen", "stdio://" }).ToArray()) ||
            ShareBridge.IsDesktopOwner(owner.Concat(new[] { "--print-startup-config" }).ToArray()) ||
            ShareBridge.IsDesktopOwner(new[] { "-c", "features.prefer_mxc=true", "app-server" }))
            throw new Exception("Alternate transports, setup queries and ambiguous owners must use stock CLI behavior.");
        return 0;
    }
}
'@)
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $compile = @('/nologo', '/target:exe', '/platform:x64', '/reference:System.Security.dll',
        '/main:BridgeAssertions', "/out:$binary", (Join-Path $PSScriptRoot 'Forwarder.cs'),
        (Join-Path $PSScriptRoot 'ShareBridge.cs'), $source)
    & $compiler @compile
    Assert-True ($LASTEXITCODE -eq 0) 'The Windows forwarder must compile.'
    & $binary
    Assert-True ($LASTEXITCODE -eq 0) 'The bridge launch classifier must preserve stock calls.'
    'Codex Desktop lifecycle cases passed.'
} finally {
    if ([IO.Directory]::Exists($root)) {
        foreach ($file in [IO.Directory]::EnumerateFiles($root)) { [IO.File]::Delete($file) }
        [IO.Directory]::Delete($root)
    }
}
