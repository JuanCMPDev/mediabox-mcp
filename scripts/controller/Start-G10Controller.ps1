<#
.SYNOPSIS
  Runs the G10 trusted controller of mediabox-mcp once on a reviewed commit
  (PR05, section 5 as revised on 2026-09-14).

.DESCRIPTION
  Run from the maintainer's normal (not elevated) PowerShell, in the
  repository, after Install-G10Controller.ps1:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\controller\Start-G10Controller.ps1 -Rehearsal
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\controller\Start-G10Controller.ps1 -Sha <commit>

  It stops the maintainer's Ollama, pushes a g10/ (or g10-rehearsal/) tag on
  the commit, registers a just-in-time runner that takes exactly that job,
  starts it under the dedicated account, follows the workflow run, removes
  the runner registration if it is still there, and restarts Ollama. After a
  live run it copies the evidence package into evals/evidence/<id>, points
  current.json at it and verifies it with the raw observations. Committing
  the evidence stays with the maintainer.

  Keep the machine idle during a live run (about 40 minutes): the performance
  thresholds are measured on it. Unplug removable drives first; the
  controller refuses to run while the account can read one.
#>
[CmdletBinding()]
param(
  [string]$Sha = 'HEAD',
  [switch]$Rehearsal,
  [string]$Repository = 'JuanCMPDev/mediabox-mcp',
  [string]$Remote = 'origin',
  [int]$TimeoutMinutes = 180
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ProvisioningFile = Join-Path $env:ProgramData 'mediabox-g10\controller.json'
$CredentialFile = Join-Path $env:LOCALAPPDATA 'mediabox-g10\account.clixml'
$WorkflowPath = '.github/workflows/g10-controller.yml'
$StatusContext = 'g10/trusted-controller'
$OllamaApp = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'

# Runs as the dedicated account. The just-in-time configuration travels in a
# file, deleted at once, because CreateProcessWithLogonW (behind Start-Process
# -Credential) accepts at most 1024 characters of command line. The runner
# refuses a folder whose parents the account cannot list, and the data drive
# denies the account listing its root, so every run starts from a fresh copy
# of the staged runner inside the account profile; its diagnostic logs are
# copied back next to the staged runner for the maintainer.
$RunnerStarter = @'
param([string]$ConfigFile, [string]$SourceDir)
$jit = (Get-Content -Raw -LiteralPath $ConfigFile).Trim()
Remove-Item -LiteralPath $ConfigFile -Force
$runnerDir = Join-Path $env:USERPROFILE 'actions-runner'
& robocopy $SourceDir $runnerDir /MIR /XD _diag _work /NJH /NJS /NP /NFL /NDL /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { exit 90 }
$work = Join-Path $runnerDir '_work'
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
Set-Location -LiteralPath $runnerDir
& (Join-Path $runnerDir 'run.cmd') --jitconfig $jit
$code = $LASTEXITCODE
& robocopy (Join-Path $runnerDir '_diag') (Join-Path $SourceDir '_diag') /E /NJH /NJS /NP /NFL /NDL /R:1 /W:1 | Out-Null
exit $code
'@

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

# Native commands are judged by their exit code. Windows PowerShell turns
# their stderr into error records when its own output is redirected, which
# must not abort the script while the command succeeds.
function Invoke-Native {
  $exe = $args[0]
  $rest = @($args | Select-Object -Skip 1)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $exe @rest } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { throw "$exe $($rest -join ' ') failed with exit code $LASTEXITCODE" }
  return $out
}

function Invoke-GhJson {
  $out = Invoke-Native gh @args
  if ($out) { return (($out | Out-String) | ConvertFrom-Json) }
  return $null
}

# --- Preconditions -------------------------------------------------------------

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this from a normal PowerShell, not an elevated one.' }
if (-not (Test-Path $ProvisioningFile)) { throw 'The controller is not provisioned. Run Install-G10Controller.ps1 as administrator first.' }
$provisioning = Get-Content -Raw $ProvisioningFile | ConvertFrom-Json
$credential = Import-Clixml -LiteralPath $CredentialFile
$full = ((Invoke-Native git -C $RepoRoot rev-parse "$Sha^{commit}") | Out-String).Trim()
Invoke-GhJson api "repos/$Repository/commits/$full" | Out-Null
$removable = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | Where-Object { $_.FileSystem })
if ($removable.Count) { throw "Unplug the removable drive(s) $(($removable | ForEach-Object { $_.DeviceID }) -join ', '): the controller refuses to run while the account can read them." }
if (-not $Rehearsal) {
  & git -C $RepoRoot merge-base --is-ancestor $full HEAD
  if ($LASTEXITCODE -ne 0) { throw "The working copy must contain $full to verify its evidence. Check out that commit or a descendant." }
  if (-not (Test-Path (Join-Path $RepoRoot 'packages\chat-core\dist\index.js'))) { throw 'Build the working copy first (npm run ci:build): the verifier re-scores the raw observations with it.' }
}

$stoppedOllama = @(Get-Process -Name 'ollama app', 'ollama' -ErrorAction SilentlyContinue)
if ($stoppedOllama.Count) {
  Write-Step 'Stopping your Ollama for the duration of the run'
  $stoppedOllama | Stop-Process -Force
  Start-Sleep -Seconds 3
}
if (Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue) { throw 'Something still listens on port 11434; stop it and run again.' }

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmss')
if ($Rehearsal) { $kind = 'g10-rehearsal' } else { $kind = 'g10' }
$tag = "$kind/$($full.Substring(0, 8))-$stamp"
$runnerName = "$($provisioning.runner.namePrefix)$stamp"
$handoff = Join-Path $provisioning.tmp "jit-$stamp.txt"
$starter = Join-Path $provisioning.tmp 'start-runner.ps1'
$jit = $null
$tagPushed = $false
$runnerProcess = $null
$run = $null

# --- Run -------------------------------------------------------------------------

try {
  Write-Step "Registering the just-in-time runner $runnerName"
  $jit = Invoke-GhJson api --method POST "repos/$Repository/actions/runners/generate-jitconfig" -f "name=$runnerName" -F runner_group_id=1 -f 'labels[]=self-hosted' -f 'labels[]=Windows' -f 'labels[]=X64' -f "labels[]=$($provisioning.runner.label)" -f work_folder=_work

  Write-Step "Tagging $full as $tag"
  Invoke-Native git -C $RepoRoot tag $tag $full | Out-Null
  Invoke-Native git -C $RepoRoot push -q $Remote "refs/tags/$tag" | Out-Null
  $tagPushed = $true

  Write-Step "Starting the runner as $($provisioning.account.name)"
  [IO.File]::WriteAllText($handoff, $jit.encoded_jit_config, [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText($starter, $RunnerStarter, [Text.Encoding]::ASCII)
  $runnerProcess = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$starter`" -ConfigFile `"$handoff`" -SourceDir `"$($provisioning.runner.dir)`"" -Credential $credential -LoadUserProfile -WorkingDirectory $provisioning.tmp -WindowStyle Minimized -PassThru

  Write-Step 'Waiting for the workflow run'
  $deadline = (Get-Date).AddMinutes(5)
  while (-not $run) {
    Start-Sleep -Seconds 10
    try {
      $runs = Invoke-GhJson api "repos/$Repository/actions/runs?head_sha=$full&event=push&per_page=50"
      $run = @($runs.workflow_runs | Where-Object { $_.path -eq $WorkflowPath -and $_.head_branch -eq $tag }) | Select-Object -First 1
    } catch { Write-Host "    could not list the runs, retrying: $($_.Exception.Message)" }
    if (-not $run -and (Get-Date) -gt $deadline) { throw "No $WorkflowPath run appeared for $tag." }
  }
  Write-Host "    $($run.html_url)"
  $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
  $last = ''
  do {
    Start-Sleep -Seconds 30
    # A failed poll is retried; it must never end a run that is still going.
    try { $run = Invoke-GhJson api "repos/$Repository/actions/runs/$($run.id)" }
    catch { Write-Host "    could not read the run, retrying: $($_.Exception.Message)"; continue }
    $state = "$($run.status) $($run.conclusion)".Trim()
    if ($state -ne $last) { Write-Host ('    {0:HH:mm:ss} {1}' -f (Get-Date), $state); $last = $state }
    if ($run.status -ne 'completed' -and $runnerProcess.HasExited -and $run.status -eq 'queued') {
      throw "The runner exited before taking the job (exit code $($runnerProcess.ExitCode)); its logs are in $(Join-Path $provisioning.runner.dir '_diag')."
    }
    if ((Get-Date) -gt $deadline) { throw "The run did not finish in $TimeoutMinutes minutes: $($run.html_url)" }
  } until ($run.status -eq 'completed')
} finally {
  $runnerExited = $false
  if ($runnerProcess) { $runnerExited = $runnerProcess.WaitForExit(120000) }
  if ($jit) {
    # A just-in-time runner removes itself after its job; this only clears one
    # that never ran or did not finish.
    try {
      Invoke-Native gh api --method DELETE "repos/$Repository/actions/runners/$($jit.runner.id)" | Out-Null
      Write-Step 'Removed the runner registration'
    } catch { }
    if ($runnerProcess -and -not $runnerExited) { [void]$runnerProcess.WaitForExit(60000) }
  }
  if (Test-Path -LiteralPath $handoff) { Remove-Item -LiteralPath $handoff -Force }
  # Without a runner, a queued job of this tag would wait for a day and could
  # be taken by the next runner; cancel what did not finish.
  if ($tagPushed -and (-not $run -or $run.status -ne 'completed')) {
    try {
      $pending = Invoke-GhJson api "repos/$Repository/actions/runs?head_sha=$full&event=push&per_page=50"
      foreach ($stale in @($pending.workflow_runs | Where-Object { $_.head_branch -eq $tag -and $_.status -ne 'completed' })) {
        Write-Step "Cancelling the unfinished run $($stale.id)"
        Invoke-Native gh api --method POST "repos/$Repository/actions/runs/$($stale.id)/cancel" | Out-Null
      }
    } catch { Write-Host "    could not cancel the unfinished run: $($_.Exception.Message)" }
  }
  if ($stoppedOllama.Count -and (Test-Path $OllamaApp)) {
    Write-Step 'Restarting your Ollama'
    Start-Process -FilePath $OllamaApp
  }
}

Write-Step "Run $($run.id): $($run.conclusion)"
if ($run.conclusion -ne 'success') { throw "The controller run did not succeed: $($run.html_url)" }
if ($Rehearsal) {
  Write-Host "The rehearsal passed end to end. Its dev package stays in $($provisioning.storage)."
  return
}

# --- Evidence ----------------------------------------------------------------------

$statuses = Invoke-GhJson api "repos/$Repository/commits/$full/statuses?per_page=100"
$binding = @($statuses | Where-Object { $_.context -eq $StatusContext -and $_.target_url -like "*/actions/runs/$($run.id)/attempts/*" }) | Select-Object -First 1
if (-not $binding) { throw "The bind job published no $StatusContext status for run $($run.id)." }
$experiment = ($binding.description -split ' ')[2]
$package = Join-Path $provisioning.storage "$experiment\package"
$target = Join-Path $RepoRoot "evals\evidence\$experiment"
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Path (Join-Path $package '*') -Destination $target -Force
[IO.File]::WriteAllText((Join-Path $RepoRoot 'evals\evidence\current.json'), "{`n  `"experimentId`": `"$experiment`"`n}`n", (New-Object Text.UTF8Encoding($false)))

Write-Step "Verifying $experiment with its raw observations"
$env:GITHUB_TOKEN = ((Invoke-Native gh auth token) | Out-String).Trim()
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & node (Join-Path $RepoRoot 'scripts\ci\verify-evidence.mjs') --require-class trusted-controller --evidence $target --observations (Join-Path $provisioning.storage $experiment)
  $verified = ($LASTEXITCODE -eq 0)
} finally {
  $ErrorActionPreference = $previous
  Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue
}
if (-not $verified) { throw 'The evidence did not verify; see the errors above.' }
Write-Step 'Evidence verified'
Write-Host 'Commit it with:'
Write-Host "  git add evals/evidence/$experiment evals/evidence/current.json"
Write-Host "  git commit -m `"evals(g10): record trusted-controller experiment $experiment`""
