#Requires -Version 5.1
<#
Read-only preflight for the workflow-mode plugin set.
Runs on Windows PowerShell 5.1 and PowerShell 7+ (no PS7-only syntax).

What it does:
  * checks the host `dsh` CLI and the target profile
  * snapshots `--dump-config` (file + sha256) so rollback can be verified
  * resolves every package to a CANONICAL owner and a pin (version or commit)
  * flags packages with several same-named sources that need a human decision
  * reports whether the profile already carries a build-approval key

What it does NOT do:
  * it never installs, removes or upgrades anything
  * it never edits pnpm-workspace.yaml or any profile/config file
  * it never adds a wildcard allowBuilds entry

Exit codes: 0 = every row GO, 1 = at least one row is not GO, 2 = script failure.
#>
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [string]$SwarmOwner = '',
    [string]$ApprovalOwner = '',
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Continue'
if (-not $OutDir) {
    $here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
    $OutDir = Join-Path $here 'preflight-out'
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$script:notes = New-Object System.Collections.Generic.List[string]
function Note([string]$m) { $script:notes.Add($m) | Out-Null }

function Test-Cmd([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# Direct invocation only: no Start-Job / no runspaces, so this works under a
# confined shell as well as in a normal one.
function Invoke-Step {
    param([string]$Exe, [string[]]$ExeArgs)
    try {
        $out = & $Exe @ExeArgs 2>&1 | Out-String
        $code = $LASTEXITCODE
        return [pscustomobject]@{
            ok  = ($code -eq 0)
            out = "$out".Trim()
            err = $(if ($code -eq 0) { '' } else { "exit $code" })
        }
    }
    catch {
        return [pscustomobject]@{ ok = $false; out = ''; err = $_.Exception.Message }
    }
}

function Get-Prop($obj, [string]$name) {
    if ($null -eq $obj) { return $null }
    $p = $obj.PSObject.Properties[$name]
    if ($p) { return $p.Value }
    return $null
}

# ---------------------------------------------------------------- environment
Write-Host '== 1/5 environment ==' -ForegroundColor Cyan
$dshOk = Test-Cmd 'dsh'
$npmOk = Test-Cmd 'npm'
$gitOk = Test-Cmd 'git'
Write-Host ("  dsh     : {0}" -f $(if ($dshOk) { (Get-Command dsh).Source } else { 'NOT FOUND on PATH' }))
Write-Host ("  npm     : {0}" -f $(if ($npmOk) { (& npm --version 2>$null | Select-Object -First 1) } else { 'NOT FOUND' }))
Write-Host ("  git     : {0}" -f $(if ($gitOk) { (& git --version 2>$null | Select-Object -First 1) } else { 'NOT FOUND' }))
Write-Host ("  profile : {0}" -f $Profile)
if (-not $dshOk) { Note 'dsh is not on PATH: run this preflight from a shell where the DSH host CLI is available.' }

# ------------------------------------------------------------ config snapshot
Write-Host '== 2/5 config snapshot ==' -ForegroundColor Cyan
$snapshotPath = Join-Path $OutDir "dump-config-before-$Profile.txt"
$snapshotHash = ''
if ($dshOk) {
    $r = Invoke-Step -Exe 'dsh' -ExeArgs @('--profile', $Profile, '--dump-config')
    if ($r.ok -and $r.out) {
        Set-Content -LiteralPath $snapshotPath -Value $r.out -Encoding utf8
        $snapshotHash = (Get-FileHash -LiteralPath $snapshotPath -Algorithm SHA256).Hash
        $lineCount = ($r.out -split "`r?`n" | Where-Object { $_.Trim() }).Count
        Write-Host ("  saved   : {0}" -f $snapshotPath)
        Write-Host ("  sha256  : {0}" -f $snapshotHash)
        Write-Host ("  lines   : {0}" -f $lineCount)
    }
    else {
        Write-Host ("  FAILED  : {0}" -f $r.err) -ForegroundColor Yellow
        Note "dsh --profile $Profile --dump-config did not succeed; rollback cannot be verified yet."
    }
}
else {
    Write-Host '  skipped : dsh unavailable' -ForegroundColor Yellow
}

# ------------------------------------------------- build-approval workspace file
Write-Host '== 3/5 profile workspace file (build approvals) ==' -ForegroundColor Cyan
$searchRoots = @(
    (Join-Path $env:USERPROFILE '.dsh'),
    (Join-Path $env:APPDATA 'dsh'),
    (Join-Path $env:LOCALAPPDATA 'dsh')
) | Where-Object { Test-Path $_ }
$workspaceFiles = @()
foreach ($root in $searchRoots) {
    $workspaceFiles += @(Get-ChildItem -LiteralPath $root -Recurse -Filter 'pnpm-workspace.yaml' -File -ErrorAction SilentlyContinue)
}
if ($workspaceFiles.Count -eq 0) {
    Write-Host '  not found : no pnpm-workspace.yaml under the DSH config roots' -ForegroundColor Yellow
    Note 'No profile pnpm-workspace.yaml found. If a GitHub-source install reports allowBuilds, add ONLY the exact key it names, then retry. Never add a wildcard.'
}
else {
    foreach ($f in $workspaceFiles) {
        Write-Host ("  file    : {0}" -f $f.FullName)
        $hits = @(Select-String -LiteralPath $f.FullName -Pattern 'onlyBuiltDependencies|neverBuiltDependencies|allowBuilds' -ErrorAction SilentlyContinue)
        if ($hits.Count -gt 0) { $hits | ForEach-Object { Write-Host ("    L{0}: {1}" -f $_.LineNumber, $_.Line.Trim()) } }
        else { Write-Host '    (no build-approval keys present)' }
    }
}

# ------------------------------------------------------------ package audit
Write-Host '== 4/5 package source audit (read-only) ==' -ForegroundColor Cyan

$specs = @(
    [pscustomobject]@{ Gap = 'base'; Kind = 'github'; Ref = 'omdsh-dev/dsh_workflow';               Note = 'brief said dsh-external/dsh_workflow - that owner was NOT verifiable' }
    [pscustomobject]@{ Gap = 'R7';   Kind = 'npm';    Ref = '@gm-hz/dsh-dag-workflow';              Note = 'upstream repo GM-HZ/agent-dag-workflow' }
    [pscustomobject]@{ Gap = 'R3';   Kind = 'github'; Ref = 'CodermanYHZ/dsh-node-flow';             Note = '' }
    [pscustomobject]@{ Gap = 'R10';  Kind = 'github'; Ref = 'MoonlitDropOfBlood/dsh-agent-approval'; Note = 'brief said @duke-dsh-plugins/dsh-agent-approval - unverified scope; alt LAwLi3tCoding/dsh-approval-review' }
    [pscustomobject]@{ Gap = 'D7';   Kind = 'npm';    Ref = 'dsh-budget';                          Note = 'upstream PerryLink/dsh-budget' }
    [pscustomobject]@{ Gap = 'D6';   Kind = 'npm';    Ref = 'dsh-swarm-orchestrator';               Note = 'same-named sources exist (zhuchuovo | linkbag) - must be decided' }
)

$rows = @()
foreach ($s in $specs) {
    $owner = ''
    $pin = ''
    $verdict = 'GO'
    $detail = ''

    if ($s.Kind -eq 'npm') {
        if (-not $npmOk) { $verdict = 'BLOCKED'; $detail = 'npm not available' }
        else {
            $r = Invoke-Step -Exe 'npm' -ExeArgs @('view', $s.Ref, 'version', 'repository.url', '--json', '--fetch-timeout=30000', '--fetch-retries=1')
            if (-not $r.ok -or -not $r.out) {
                $verdict = 'BLOCKED'; $detail = "npm view failed ($($r.err)); offline or unreachable registry"
            }
            else {
                try {
                    $j = $r.out | ConvertFrom-Json
                    $pin = [string](Get-Prop $j 'version')
                    $repo = Get-Prop $j 'repository'
                    $repoUrl = if ($repo -is [string]) { $repo } else { [string](Get-Prop $repo 'url') }
                    if ($repoUrl -match 'github\.com[/:]([^/]+)/([^/\.]+)') { $owner = "$($Matches[1])/$($Matches[2])" }
                    else { $verdict = 'REVIEW'; $detail = "no GitHub owner in repository.url ('$repoUrl')" }
                    if (-not $pin) { $verdict = 'REVIEW'; $detail = 'could not read a version to pin' }
                }
                catch { $verdict = 'BLOCKED'; $detail = 'cannot parse npm output as JSON' }
            }
        }
        if ($s.Gap -eq 'D6' -and $verdict -eq 'GO') {
            if (-not $SwarmOwner) { $verdict = 'NEEDS-DECISION'; $detail = "resolved to $owner - confirm it, then pass -SwarmOwner '$owner'" }
            elseif ($owner -and ($owner -notlike "*$SwarmOwner*")) { $verdict = 'MISMATCH'; $detail = "resolved '$owner' does not match -SwarmOwner '$SwarmOwner'" }
        }
        if (-not $detail) { $detail = "resolved to $owner" }
    }
    else {
        if (-not $gitOk) { $verdict = 'BLOCKED'; $detail = 'git not available' }
        else {
            $url = "https://github.com/$($s.Ref).git"
            $env:GIT_TERMINAL_PROMPT = '0'
            $r = Invoke-Step -Exe 'git' -ExeArgs @('ls-remote', $url, 'HEAD')
            if (-not $r.ok -or -not $r.out) {
                $verdict = 'BLOCKED'; $detail = "git ls-remote failed ($($r.err)); offline or repo unreachable"
            }
            else {
                $sha = ($r.out -split '\s+')[0]
                if ($sha -match '^[0-9a-f]{40}$') { $pin = $sha; $owner = $s.Ref; $detail = "HEAD -> $sha" }
                else { $verdict = 'REVIEW'; $detail = 'unexpected ls-remote output' }
            }
        }
        if ($s.Gap -eq 'R10' -and $verdict -eq 'GO') {
            if (-not $ApprovalOwner) { $verdict = 'NEEDS-DECISION'; $detail = "candidate $owner - confirm it, then pass -ApprovalOwner '$owner'" }
            elseif ($owner -and ($owner -notlike "*$ApprovalOwner*")) { $verdict = 'MISMATCH'; $detail = "resolved '$owner' does not match -ApprovalOwner '$ApprovalOwner'" }
        }
    }

    $rows += [pscustomobject]@{
        Gap     = $s.Gap
        Kind    = $s.Kind
        Spec    = $s.Ref
        Owner   = $owner
        Pin     = $pin
        Verdict = $verdict
        Detail  = $detail
    }
}

Write-Host ''
Write-Host ($rows | Format-Table -AutoSize Gap, Kind, Spec, Owner, Pin, Verdict | Out-String -Width 220)
foreach ($row in $rows) { Write-Host ("  [{0}] {1}  {2}" -f $row.Verdict, $row.Spec, $row.Detail) }
Write-Host ''
Write-Host 'Coordinate notes (carried from the audit):' -ForegroundColor Cyan
foreach ($s in ($specs | Where-Object { $_.Note })) { Write-Host ("  {0,-5} {1}" -f $s.Gap, $s.Note) }

# ------------------------------------------------------------------ summary
Write-Host ''
Write-Host '== 5/5 summary ==' -ForegroundColor Cyan
$bad = @($rows | Where-Object { $_.Verdict -ne 'GO' })
Write-Host ("  snapshot : {0}" -f $(if ($snapshotHash) { $snapshotHash } else { 'not captured' }))
Write-Host ("  rows     : {0} total, {1} not GO" -f $rows.Count, $bad.Count)
foreach ($n in $script:notes) { Write-Host ("  note     : {0}" -f $n) -ForegroundColor Yellow }

$csvPath = Join-Path $OutDir 'preflight-packages.csv'
$rows | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding utf8
Write-Host ("  table    : {0}" -f $csvPath)

if ($bad.Count -eq 0 -and $dshOk -and $snapshotHash) {
    Write-Host 'PREFLIGHT: GO' -ForegroundColor Green
    Write-Host 'Next: review preflight-packages.csv, then run section 2 of HOST-INSTALL-CHECKLIST.md'
    exit 0
}
Write-Host 'PREFLIGHT: NOT GO - resolve the rows above before installing anything' -ForegroundColor Yellow
exit 1
