<#
Install the「Workflow 工作模式」preset into the DSH preset store, safely and verifiably.

    pwsh -File docs\workflow-mode\install-preset.ps1            # apply
    pwsh -File docs\workflow-mode\install-preset.ps1 -DryRun    # show the plan, write nothing

Why each step exists -- all measured on this machine, 2026-10-07:

 1. The live store copy had LOST its final `- id: workflow-governance` row (a truncated
    persona.text -> persona.prefix migration: 196 lines, ending on the two comment lines that
    used to introduce that row). The preset still parsed, so nothing complained -- but the
    session registered NO contract_workflow tool. The preset looked present and was unusable.
    This script ASSERTS that row exists after writing, because that is the failure that does
    not announce itself.

 2. `agent preset workflow: tool-todo (@deepseek-ai/dsh-tool-todo): invalid config:`
    (harness.log, 2026-10-06 x3) is what put the card at 「加载失败」. This build requires
    `config.allowParallelInProgress`; without it the whole preset fails validation.

 3. The registry validates the migration BACKUPS too
    (`<DSH_HOME>/.agent-presets/.persona-prefix-backups/<id>/`), so a stale backup of the same
    preset keeps the card failing even after the live copy is fixed. Both copies are therefore
    written from the same source.

 4. `Copy-Item -Recurse <srcDir> <existingDstDir>` does NOT replace. Measured: it produced
    `<dst>\workflow\agent.cordis.yml` while leaving `<dst>\agent.cordis.yml` untouched -- the
    edited preset was then never the one that loaded, and a stray subdirectory was left inside
    a directory the registry scans. Files are copied individually below.

 5. `cordis:group` around the shell rows is REQUIRED. Replacing that wrapper with a bare tool
    row makes EVERY card in the preset selector show 「加载失败」 (README, measured).
#>
[CmdletBinding()]
param(
  [string]$Source = "<workspace>\local-plugins\dsh-workflow-governance\presets\workflow",
  [string]$DshHome = "$env:APPDATA\dsh-desktop\harness",
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$live   = Join-Path $DshHome '.agent-presets\workflow'
$backup = Join-Path $DshHome '.agent-presets\.persona-prefix-backups\workflow'

Write-Host "source  : $Source"
Write-Host "live    : $live"
Write-Host "backup  : $backup"
Write-Host ''

# ---- 0) the source must be complete before we touch anything -----------------
foreach ($f in @('preset.yml', 'agent.cordis.yml')) {
  $p = Join-Path $Source $f
  if (-not (Test-Path $p)) { throw "source file missing: $p" }
}
$srcText  = [System.IO.File]::ReadAllText((Join-Path $Source 'agent.cordis.yml'), [System.Text.Encoding]::UTF8)
$srcLines = $srcText -split "`n"

$govRows   = @($srcLines | Where-Object { $_ -match '^- id: workflow-governance$' })
$goalRows  = @($srcLines | Where-Object { $_ -match '^- id: tool-goal$' })
$shellWrap = @($srcLines | Where-Object { $_ -match '^- id: persistent-shell$' })
$bareShell = @($srcLines | Where-Object { $_ -match '^- id: persistent-pwsh$' })
$todoCfg   = $srcText -match 'allowParallelInProgress:\s*true'
$bareExpr  = ($srcText -split "`n" | Where-Object { -not $_.TrimStart().StartsWith('#') }) -join "`n"

Write-Host "source checks:"
Write-Host ("  lines                         = {0}" -f $srcLines.Count)
Write-Host ("  root '- id: workflow-governance' rows = {0}  (must be 1)" -f $govRows.Count)
Write-Host ("  '- id: tool-goal' rows          = {0}  (must be 1)" -f $goalRows.Count)
Write-Host ("  '- id: persistent-shell' group  = {0}  (must be 1; a bare shell row breaks every card)" -f $shellWrap.Count)
Write-Host ("  bare '- id: persistent-pwsh'    = {0}  (must be 0)" -f $bareShell.Count)
Write-Host ("  allowParallelInProgress: true   = {0}" -f $todoCfg)
Write-Host ("  contains '!!js'                 = {0}  (must be False)" -f ($bareExpr -match '!!js'))
Write-Host ("  contains 'disabled:'            = {0}  (must be False)" -f ($bareExpr -match 'disabled:'))

if ($govRows.Count -ne 1 -or $goalRows.Count -ne 1 -or $shellWrap.Count -ne 1 -or $bareShell.Count -ne 0 -or -not $todoCfg) {
  throw 'SOURCE IS NOT INSTALLABLE -- fix the source checks above first. Nothing was written.'
}

# ---- 1) back up whatever is in the store now, OUTSIDE the scanned directories --
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$vault = Join-Path $DshHome ("preset-store-backup-$stamp")
Write-Host ''
Write-Host "backing up the current store to: $vault"
if (-not $DryRun) {
  New-Item -ItemType Directory -Force $vault | Out-Null
  foreach ($d in @($live, $backup)) {
    if (Test-Path $d) {
      $tag  = (Split-Path (Split-Path $d -Parent) -Leaf) + '-' + (Split-Path $d -Leaf)
      $dest = Join-Path $vault $tag
      New-Item -ItemType Directory -Force $dest | Out-Null
      Copy-Item (Join-Path $d '*') $dest -Force -Recurse -ErrorAction SilentlyContinue
      Write-Host "  saved $d"
    }
  }
}

if ($DryRun) { Write-Host ''; Write-Host 'DRY RUN -- nothing was written.'; exit 0 }

# ---- 2) write the live copy and the backup copy --------------------------------
# The LIVE copy is a preset directory: preset.yml + agent.cordis.yml.
# The migration-BACKUP directory holds ONLY agent.cordis.yml -- that is exactly what every
# other backup on this machine contains (checked: ultramath, ultramath-*, ...). The registry
# walks those backups to validate them, so the shape is kept identical rather than being
# turned into something that could read as a second, selectable preset.
New-Item -ItemType Directory -Force $live | Out-Null
Copy-Item -Force (Join-Path $Source 'preset.yml')       (Join-Path $live 'preset.yml')
Copy-Item -Force (Join-Path $Source 'agent.cordis.yml') (Join-Path $live 'agent.cordis.yml')
Write-Host "wrote $live   (preset.yml + agent.cordis.yml)"

New-Item -ItemType Directory -Force $backup | Out-Null
Copy-Item -Force (Join-Path $Source 'agent.cordis.yml') (Join-Path $backup 'agent.cordis.yml')
# A leftover preset.yml here would be an anomaly: no other backup has one.
$stray = Join-Path $backup 'preset.yml'
if (Test-Path $stray) { Remove-Item $stray -Force; Write-Host "removed stray $stray" }
Write-Host "wrote $backup   (agent.cordis.yml only, like every other backup)"

# ---- 3) verify what actually landed ------------------------------------------
Write-Host ''
Write-Host 'verifying the store:'
$bad = 0
foreach ($dst in @($live, $backup)) {
  $t = [System.IO.File]::ReadAllText((Join-Path $dst 'agent.cordis.yml'), [System.Text.Encoding]::UTF8)
  $l = $t -split "`n"
  $g = @($l | Where-Object { $_ -match '^- id: workflow-governance$' }).Count
  $k = @($l | Where-Object { $_ -match '^- id: tool-goal$' }).Count
  $w = @($l | Where-Object { $_ -match '^- id: persistent-shell$' }).Count
  $ok = ($g -eq 1) -and ($k -eq 1) -and ($w -eq 1)
  if (-not $ok) { $bad++ }
  Write-Host ("  [{0}] {1}" -f $(if ($ok) { 'OK ' } else { 'BAD' }), $dst)
  Write-Host ("        lines={0}  governance-row={1}  tool-goal={2}  shell-group={3}" -f $l.Count, $g, $k, $w)
}
$meta = [System.IO.File]::ReadAllText((Join-Path $live 'preset.yml'), [System.Text.Encoding]::UTF8)
Write-Host ("  preset.yml name line: {0}" -f (($meta -split "`n")[0]))

Write-Host ''
if ($bad -gt 0) {
  Write-Host "RESULT: $bad copy(ies) FAILED verification. Restore from $vault and re-check."
  exit 1
}
Write-Host 'RESULT: OK -- live and backup both carry the governance row.'
Write-Host 'Restart DSH; the preset selector should list「Workflow 工作模式」as loadable.'
Write-Host ''
Write-Host 'Rollback if needed:'
Write-Host ("  Copy-Item -Force '{0}\.agent-presets-workflow\*' '{1}'" -f $vault, $live)
