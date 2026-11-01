# The harness gate for the Apexus CAD product.
#
# Written for an agent, not a human: terse one-line results, full detail in
# .harness/logs/, one greppable marker (ERROR) so the next step is always
# `Select-String ERROR .harness/logs/*.log`.
#
#   .\harness.ps1 check            static checks (symbols, imports, paths, exports)
#   .\harness.ps1 verify           typecheck -> tests -> smoke, full gate
#   .\harness.ps1 verify tests     one step only (typecheck | tests | smoke)
#   .\harness.ps1 report           PASS / ERROR per step, from the summaries
#   .\harness.ps1 next             highest-priority unpassed feature with deps met
#   .\harness.ps1 tick <id>        set passes = true
#   .\harness.ps1 untick <id>      set passes = false
#
# Every step writes .harness/logs/<step>.log and .harness/logs/<step>.status
# ("PASS" or "ERROR"). Exit code is 0 only when every step asked for passed.

param(
  [Parameter(Position = 0)][string]$Command = "report",
  [Parameter(Position = 1)][string]$Step = ""
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Logs = Join-Path $Root ".harness\logs"
$Checks = Join-Path $Root ".harness\checks"
$Features = Join-Path $Root "feature_list.json"
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

function Write-Status([string]$Name, [bool]$Ok) {
  $word = if ($Ok) { "PASS" } else { "ERROR" }
  Set-Content -Path (Join-Path $Logs "$Name.status") -Value $word -Encoding utf8
  if ($Ok) { Write-Output "PASS $Name" } else { Write-Output "ERROR $Name  see $Name.log" }
}

# Runs one step: a label, a command line, and the working directory.
function Invoke-Step([string]$Name, [scriptblock]$Body, [string]$Dir = $Root) {
  $log = Join-Path $Logs "$Name.log"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Push-Location $Dir
  try {
    & $Body *>&1 | Tee-Object -FilePath $log | Out-Null
    $code = $LASTEXITCODE
  } catch {
    $_ | Out-File -FilePath $log -Append
    $code = 1
  } finally {
    Pop-Location
  }
  $sw.Stop()
  Add-Content -Path $log -Value ""
  Add-Content -Path $log -Value "[harness] $Name exit=$code seconds=$([math]::Round($sw.Elapsed.TotalSeconds, 1))"
  Write-Status $Name ($code -eq 0)
}

function Get-Features {
  Get-Content -Raw -Path $Features | ConvertFrom-Json
}

function Set-Passes([string]$Id, [bool]$Value) {
  $text = [IO.File]::ReadAllText($Features)
  # Only the passes field of the named entry is touched; everything else,
  # including formatting, is left byte-identical by anchoring on the id.
  $pattern = '("id"\s*:\s*"' + [regex]::Escape($Id) + '"(?:(?!"id").)*?"passes"\s*:\s*)(true|false)'
  $rx = [regex]::new($pattern, [Text.RegularExpressions.RegexOptions]::Singleline)
  if (-not $rx.IsMatch($text)) { throw "feature $Id not found (or has no passes field)" }
  $m = $rx.Match($text)
  $word = $Value.ToString().ToLower()
  $new = $text.Substring(0, $m.Groups[1].Index) + $m.Groups[1].Value + $word + $text.Substring($m.Groups[2].Index + $m.Groups[2].Length)
  [IO.File]::WriteAllText($Features, $new, [Text.UTF8Encoding]::new($false))
  Write-Output "$Id passes=$Value"
}

switch ($Command.ToLower()) {
  "check" {
    $scripts = @(Get-ChildItem -Path $Checks -Filter *.py -ErrorAction SilentlyContinue | Sort-Object Name)
    if ($scripts.Count -eq 0) { Write-Output "ERROR checks  see no .py in .harness\checks"; exit 1 }
    $failed = 0
    foreach ($s in $scripts) {
      Invoke-Step ("check-" + $s.BaseName) { python -X utf8 $s.FullName }
      if ((Get-Content (Join-Path $Logs ("check-" + $s.BaseName + ".status"))) -ne "PASS") { $failed++ }
    }
    if ($failed -gt 0) { exit 1 }
  }
  "verify" {
    $steps = if ($Step) { @($Step) } else { @("typecheck", "typecheck-app", "tests", "smoke", "ui") }
    $failed = 0
    foreach ($s in $steps) {
      switch ($s.ToLower()) {
        "typecheck" { Invoke-Step "typecheck" { & "$Root\..\sketchup\node_modules\.bin\tsc.cmd" -p "$Root\tsconfig.json" --noEmit } }
        # --reporter=json keeps the console quiet; the summary is the status file.
        "tests" { Invoke-Step "tests" { & "$Root\..\sketchup\node_modules\.bin\vitest.cmd" run --root $Root --reporter=default } }
        "typecheck-app" { Invoke-Step "typecheck-app" { & "$Root\..\sketchup\node_modules\.bin\tsc.cmd" -p "$Root\apps\app\tsconfig.json" --noEmit } }
        "smoke" { Invoke-Step "smoke" { node scripts/smoke.mjs } }
        # The UI step serves `dist`, so it builds first: a smoke test of a stale
        # bundle passes against code nobody is running.
        "ui" {
          Invoke-Step "ui" {
            Push-Location "$Root\apps\app"
            try { node node_modules\vite\bin\vite.js build; if ($LASTEXITCODE -ne 0) { throw "vite build failed" } }
            finally { Pop-Location }
            node scripts/ui-smoke.mjs
          }
        }
        default { throw "unknown step '$s' (typecheck | typecheck-app | tests | smoke | ui)" }
      }
      if ((Get-Content (Join-Path $Logs "$s.status")) -ne "PASS") { $failed++ }
    }
    if ($failed -gt 0) { exit 1 }
  }
  "report" {
    $any = Get-ChildItem -Path $Logs -Filter *.status -ErrorAction SilentlyContinue | Sort-Object Name
    if (-not $any) { Write-Output "ERROR none  see no step has run yet"; exit 1 }
    $failed = 0
    foreach ($f in $any) {
      $word = (Get-Content $f.FullName -Raw).Trim()
      $name = $f.BaseName
      if ($word -eq "PASS") { Write-Output "PASS $name" } else { Write-Output "ERROR $name  see $name.log"; $failed++ }
    }
    if ($failed -gt 0) { exit 1 }
  }
  "next" {
    $doc = Get-Features
    $done = @{}
    foreach ($f in $doc.features) { $done[$f.id] = [bool]$f.passes }
    $pick = $doc.features | Where-Object {
      -not $_.passes -and (@($_.depends_on | Where-Object { -not $done[$_] }).Count -eq 0)
    } | Sort-Object priority | Select-Object -First 1
    if (-not $pick) { Write-Output "no open feature with satisfied dependencies"; exit 0 }
    Write-Output "$($pick.id)`t$($pick.title)"
    foreach ($a in $pick.acceptance) { Write-Output "  - $a" }
  }
  { $_ -in "tick", "untick" } {
    if (-not $Step) { throw "usage: harness.ps1 tick <id>" }
    Set-Passes $Step ($Command -eq "tick")
  }
  default { Write-Output "usage: harness.ps1 [check|verify [step]|report|next|tick <id>|untick <id>]"; exit 1 }
}

