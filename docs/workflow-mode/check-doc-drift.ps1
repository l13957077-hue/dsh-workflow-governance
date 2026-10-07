#Requires -Version 5.1
<#
Document-drift guard (key-set comparison).

Single source of truth for the switch list:
    local-plugins/dsh-workflow-governance/src/config.js  (the `switches` block)

Two checks, so it covers BOTH drift shapes seen in practice:
  1. KEY-SET: every `switches:` / `"switches":` block in docs must carry the SAME
     key set as src/config.js. This catches "list drift" (missing/extra keys) --
     the shape the earlier count-only regex could not see.
  2. COUNT WORDING: the prose counts "four switches" / "N ge kai guan" (Chinese,
     expressed as \u escapes so this file stays ASCII) must not reappear.

EPISTEMIC NOTE: check 1 (key-set) is a SEMANTIC check and is structurally
reliable. check 2 (count wording) is a SYNTACTIC BLACKLIST and can NEVER be
complete -- a count can always be reworded ("7 switch names", "switch count is
four", "四类开关", "VII"...). check 2 only pins the exact phrasings that already
drifted; do not keep widening it, that is whack-a-mole. To make counts fully
safe, invert to a whitelist (forbid any "switch key + number" combination outside
src/config.js) -- not done here.

Scanned: docs/ and local-plugins/ (*.md, *.yml). Excluded: outbox/, results/, node_modules/.
NOTE: uses -Recurse -File + Where-Object (not -Include/-Filter with -LiteralPath)
because those silently match nothing and would report a false CLEAN.

Exit 0 = clean, 1 = drift, 2 = setup failure.
#>
[CmdletBinding()]
param([string]$Root = '')
if (-not $Root) { $Root = if ($PSScriptRoot) { Split-Path (Split-Path $PSScriptRoot -Parent) -Parent } else { (Get-Location).Path } }

$cfgPath = Join-Path $Root 'local-plugins\dsh-workflow-governance\src\config.js'
if (-not (Test-Path -LiteralPath $cfgPath)) { Write-Error "config.js not found: $cfgPath"; exit 2 }

# --- truth key set from src/config.js ---
$cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8
$truthBlock = [regex]::Match($cfg, 'switches\s*:\s*Object\.freeze\(\{([^}]*)\}').Groups[1].Value
if (-not $truthBlock) { Write-Error 'could not read switches block from config.js'; exit 2 }
$truthBlock = $truthBlock -replace '/\*[\s\S]*?\*/', '' -replace '//[^\r\n]*', ''
$truthKeys = @([regex]::Matches($truthBlock, '["'']?(\w+)["'']?\s*:') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)

# second truth: the enabled subset from config.json (real install state)
$enabledKeys = @()
$cfgJsonPath = Join-Path $Root 'local-plugins\dsh-workflow-governance\config.json'
if (Test-Path -LiteralPath $cfgJsonPath) {
    try {
        $cj = Get-Content -LiteralPath $cfgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $enabledKeys = @($cj.switches.PSObject.Properties | Where-Object { $_.Value -eq $true } | ForEach-Object { $_.Name } | Sort-Object -Unique)
    } catch {
        Write-Error "config.json present but unreadable: $cfgJsonPath"
        exit 2
    }
}

$hits = New-Object System.Collections.Generic.List[string]

# --- collect .md files (avoid the -Include/-LiteralPath trap) ---
$files = New-Object System.Collections.Generic.List[string]
foreach ($r in @((Join-Path $Root 'docs'), (Join-Path $Root 'local-plugins'))) {
    if (-not (Test-Path -LiteralPath $r)) { continue }
    Get-ChildItem -LiteralPath $r -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -in @('.md', '.yml') -and $_.FullName -notmatch '\\outbox\\|\\results\\|\\node_modules\\' } |
      ForEach-Object { $files.Add($_.FullName) }
}

if ($files.Count -eq 0) { Write-Error "no files scanned under $Root (docs/ + local-plugins/ *.md, *.yml)"; exit 2 }

$skipped = 0
foreach ($f in $files) {
    $text = Get-Content -LiteralPath $f -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if (-not $text) { $skipped++; continue }

    # check 1: every `switches:` block must equal the full 7-key set OR the
    # enabled subset of config.json (the two legal shapes).
    foreach ($m in [regex]::Matches($text, 'switches["'']?\s*:\s*\{([^}]*)\}')) {
        $block = $m.Groups[1].Value -replace '/\*[\s\S]*?\*/', '' -replace '//[^\r\n]*', ''
        $blockKeys = @([regex]::Matches($block, '["'']?(\w+)["'']?\s*:') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
        $isFull = (($blockKeys -join ',') -eq ($truthKeys -join ','))
        $isEnabled = ($enabledKeys.Count -gt 0 -and ($blockKeys -join ',') -eq ($enabledKeys -join ','))
        if (-not $isFull -and -not $isEnabled) {
            $hits.Add("$f : switch block. full=[$($truthKeys -join ',')] enabled=[$($enabledKeys -join ',')] actual=[$($blockKeys -join ',')]")
        }
    }

    # check 2: count wording (Chinese as \u escapes)
    foreach ($m in [regex]::Matches($text, '(?i)\b(two|three|four|five|six|seven|eight|nine|ten)\b\s+switches\b|[0-9]+\s+switches\b|[0-9]+\s*\u4E2A\u5F00\u5173|[\u56DB\u4E94\u516D\u4E03\u516B]\s*\u4E2A\u5F00\u5173|\b(seven|eight|six|five|four)\b\s*[:\uFF1A]')) {
        $hits.Add("$f : count wording '$($m.Value)'")
    }
}

if ($skipped -gt 0) {
    Write-Host "DOC-DRIFT: INCOMPLETE - $skipped file(s) unreadable; scanned $($files.Count - $skipped) of $($files.Count)"
    exit 2
}

if ($hits.Count -eq 0) {
    Write-Host "DOC-DRIFT: CLEAN - every switches block matches src/config.js ($($truthKeys.Count) keys), no count wording"
    exit 0
}
Write-Host "DOC-DRIFT: $($hits.Count) hit(s) - truth keys = $($truthKeys -join ', '):"
$hits | ForEach-Object { Write-Host "  $_" }
exit 1
