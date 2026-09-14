<#
.SYNOPSIS
  Provisions the local G10 trusted controller of mediabox-mcp (PR05, section 5
  as revised on 2026-09-14).

.DESCRIPTION
  Run once from an elevated Windows PowerShell opened by the maintainer, in
  the repository:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\controller\Install-G10Controller.ps1

  Staging (also available alone, without administrator rights, with -StageOnly):
    - copies the runtime binary and libraries, the model weights, Node and
      ffmpeg that the sealed profile names, and the GitHub Actions runner, into
      an area only the maintainer (and later the account) can use, and
      verifies every file against the sealed profile.

  Then, as administrator:
    - creates the dedicated standard account (no administrator group, hidden
      from the sign-in screen) and stores its password for the maintainer
      only (DPAPI);
    - grants the account read access to the staged area and write access only
      to its storage, temporary, npm cache and runner folders;
    - adds firewall rules: the account cannot reach private networks, and the
      evaluated binaries (evaluation node, runtime, ffmpeg) only reach loopback;
    - denies the account every data location: the other local drives and the
      top-level folders of the system drive that are not part of Windows;
    - writes the provisioning file the controller checks, readable but not
      writable by the account;
    - runs the controller's isolation checks from inside the account.

  Denying the data drives rewrites the inherited permissions of every file on
  them. On large drives this takes a long time; it is safe to interrupt and
  run the script again. Uninstall-G10Controller.ps1 reverts everything.
#>
[CmdletBinding()]
param(
  [string]$Root = 'E:\mediabox-g10',
  [string]$Account = 'mediabox-g10',
  [switch]$StageOnly
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ProvisioningDir = Join-Path $env:ProgramData 'mediabox-g10'
$ProvisioningFile = Join-Path $ProvisioningDir 'controller.json'
$CredentialFile = Join-Path $env:LOCALAPPDATA 'mediabox-g10\account.clixml'
$FirewallGroup = 'mediabox-g10'
$RunnerLabel = 'mediabox-g10'
$RunnerVersion = '2.337.0'
$RunnerSha256 = '1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc'
$NodeVersion = 'v22.19.0'
$PublicProbe = '1.1.1.1'
$SystemSid = 'S-1-5-18'
$AdministratorsSid = 'S-1-5-32-544'
# Prints the outcome of one TCP connection: EACCES means the firewall refused it.
$ConnectProbe = @'
import net from 'node:net';
const socket = net.connect({ host: process.argv[2], port: Number(process.argv[3]) });
const done = (outcome) => { process.stdout.write(outcome); socket.destroy(); process.exit(0); };
socket.setTimeout(4000, () => done('timeout'));
socket.once('connect', () => done('connected'));
socket.once('error', (err) => done(err.code || 'error'));
'@

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function Test-Elevated {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Robocopy([string]$Source, [string]$Destination, [string[]]$Arguments) {
  & robocopy $Source $Destination @Arguments /NJH /NJS /NP /NFL /NDL /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $Source -> $Destination failed with exit code $LASTEXITCODE" }
  $global:LASTEXITCODE = 0
}

function New-AccessRule([string]$Sid, [string]$Rights) {
  $identity = New-Object Security.Principal.SecurityIdentifier($Sid)
  return New-Object Security.AccessControl.FileSystemAccessRule($identity, [Security.AccessControl.FileSystemRights]$Rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow')
}

# Replaces the permissions of a folder with exactly $Grants, without inheritance.
function Set-ProtectedAcl([string]$Path, [object[]]$Grants) {
  $item = Get-Item -LiteralPath $Path -Force
  $acl = $item.GetAccessControl('Access')
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  foreach ($grant in $Grants) { $acl.AddAccessRule((New-AccessRule $grant.Sid $grant.Rights)) }
  $item.SetAccessControl($acl)
}

function Add-FolderGrant([string]$Path, [string]$Sid, [string]$Rights) {
  $item = Get-Item -LiteralPath $Path -Force
  $acl = $item.GetAccessControl('Access')
  $acl.AddAccessRule((New-AccessRule $Sid $Rights))
  $item.SetAccessControl($acl)
}

function New-RandomPassword {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+=-_'.ToCharArray()
  $bytes = New-Object byte[] 40
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  # The prefix guarantees every character class the local password policy may require.
  return 'Aa1!' + (-join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] }))
}

function Invoke-Staging {
  $declarations = Get-Content -Raw (Join-Path $RepoRoot 'evals\local-agent\profile-declarations.json') | ConvertFrom-Json
  $profilePath = Join-Path $RepoRoot "ci\model-profiles\$($declarations.profileId).json"
  $sealed = Get-Content -Raw $profilePath | ConvertFrom-Json
  Write-Step "Staging the controller files for profile $($declarations.profileId) in $Root"

  if (-not (Test-Path $Root)) { New-Item -ItemType Directory -Path $Root | Out-Null }
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  Set-ProtectedAcl $Root @(@{ Sid = $SystemSid; Rights = 'FullControl' }, @{ Sid = $AdministratorsSid; Rights = 'FullControl' }, @{ Sid = $me; Rights = 'FullControl' })
  foreach ($sub in 'ollama', 'models', 'toolchain\node', 'toolchain\node-eval', 'toolchain\ffmpeg', 'runner', 'storage', 'tmp', 'npm-cache') {
    $path = Join-Path $Root $sub
    if (-not (Test-Path $path)) { New-Item -ItemType Directory -Path $path | Out-Null }
  }

  $ollamaSource = Join-Path $env:LOCALAPPDATA 'Programs\Ollama'
  if (-not (Test-Path (Join-Path $ollamaSource 'ollama.exe'))) { throw "Ollama is not installed in $ollamaSource" }
  Write-Step 'Copying the runtime (ollama.exe and its libraries)'
  Invoke-Robocopy $ollamaSource (Join-Path $Root 'ollama') @('ollama.exe')
  Invoke-Robocopy (Join-Path $ollamaSource 'lib') (Join-Path $Root 'ollama\lib') @('/MIR')

  if ($env:OLLAMA_MODELS) { $modelsSource = $env:OLLAMA_MODELS } else { $modelsSource = Join-Path $env:USERPROFILE '.ollama\models' }
  $modelName, $modelTag = $sealed.model.name.Split(':')
  $manifestRel = "manifests\registry.ollama.ai\library\$modelName\$modelTag"
  $manifestSource = Join-Path $modelsSource $manifestRel
  if (-not (Test-Path $manifestSource)) { throw "model $($sealed.model.name) is not in $modelsSource" }
  Write-Step "Copying the weights of $($sealed.model.name)"
  $manifestTarget = Join-Path $Root "models\$manifestRel"
  New-Item -ItemType Directory -Force -Path (Split-Path $manifestTarget) | Out-Null
  Copy-Item -LiteralPath $manifestSource -Destination $manifestTarget -Force
  $manifest = Get-Content -Raw $manifestSource | ConvertFrom-Json
  $blobs = @($manifest.config.digest) + @($manifest.layers | ForEach-Object { $_.digest }) | ForEach-Object { $_.Replace(':', '-') }
  Invoke-Robocopy (Join-Path $modelsSource 'blobs') (Join-Path $Root 'models\blobs') $blobs

  $nodeExe = (& node -p 'process.execPath' | Out-String).Trim()
  $version = (& $nodeExe --version | Out-String).Trim()
  if ($version -ne $NodeVersion) { throw "node $version found; the controller toolchain is $NodeVersion" }
  $nodeDir = Split-Path $nodeExe
  Write-Step "Copying Node $version"
  $toolNode = Join-Path $Root 'toolchain\node'
  Invoke-Robocopy $nodeDir $toolNode @('node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd')
  foreach ($module in 'npm', 'corepack') { Invoke-Robocopy (Join-Path $nodeDir "node_modules\$module") (Join-Path $toolNode "node_modules\$module") @('/MIR') }
  Invoke-Robocopy $nodeDir (Join-Path $Root 'toolchain\node-eval') @('node.exe')

  $ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
  $ffmpegItem = Get-Item -LiteralPath $ffmpeg
  if ($ffmpegItem.LinkType -and $ffmpegItem.Target) { $ffmpeg = @($ffmpegItem.Target)[0] }
  $ffmpegDir = Split-Path $ffmpeg
  Write-Step "Copying ffmpeg from $ffmpegDir"
  $ffmpegFiles = @('ffmpeg.exe', 'ffprobe.exe') + @(Get-ChildItem -LiteralPath $ffmpegDir -Filter *.dll | ForEach-Object { $_.Name })
  Invoke-Robocopy $ffmpegDir (Join-Path $Root 'toolchain\ffmpeg') $ffmpegFiles

  $runnerDir = Join-Path $Root 'runner'
  $marker = Join-Path $runnerDir '.mediabox-runner-version'
  $current = ''
  if (Test-Path $marker) { $current = (Get-Content -Raw $marker).Trim() }
  if ($current -ne $RunnerVersion -or -not (Test-Path (Join-Path $runnerDir 'bin\Runner.Listener.exe'))) {
    Write-Step "Downloading the GitHub Actions runner $RunnerVersion"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $zip = Join-Path $Root "tmp\actions-runner-win-x64-$RunnerVersion.zip"
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip" -OutFile $zip
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
    if ($hash -ne $RunnerSha256) { Remove-Item -LiteralPath $zip -Force; throw "runner archive hash $hash differs from the published $RunnerSha256" }
    Get-ChildItem -LiteralPath $runnerDir -Force | Remove-Item -Recurse -Force
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $runnerDir)
    Get-ChildItem -LiteralPath $runnerDir -Recurse -File | Unblock-File
    Set-Content -LiteralPath $marker -Value $RunnerVersion -Encoding Ascii
    Remove-Item -LiteralPath $zip -Force
  }

  Write-Step 'Verifying the staged files against the sealed profile'
  & (Join-Path $Root 'toolchain\node\node.exe') (Join-Path $RepoRoot 'scripts\controller\verify-staging.mjs') --root $Root
  if ($LASTEXITCODE -ne 0) { throw 'The staged files do not match the sealed profile.' }
}

# --- Staging -----------------------------------------------------------------

Invoke-Staging
if ($StageOnly) {
  Write-Step 'Staging done. No account, permission or firewall rule was changed.'
  return
}
if (-not (Test-Elevated)) { throw 'Run this script from an elevated PowerShell, or pass -StageOnly to stage the files only.' }

# --- Account -----------------------------------------------------------------

Write-Step "Creating the dedicated account $Account"
$password = ConvertTo-SecureString (New-RandomPassword) -AsPlainText -Force
if (Get-LocalUser -Name $Account -ErrorAction SilentlyContinue) {
  Set-LocalUser -Name $Account -Password $password -PasswordNeverExpires $true -UserMayNotChangePassword $true
  Enable-LocalUser -Name $Account
} else {
  # Windows limits the description of a local account to 48 characters.
  New-LocalUser -Name $Account -Password $password -Description 'mediabox-mcp G10 trusted controller' -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires | Out-Null
}
$sid = (Get-LocalUser -Name $Account).SID.Value
# Users, Performance Monitor Users and Performance Log Users: the memory
# sampler reads the GPU counters as the maintainer does in the lab.
foreach ($groupSid in 'S-1-5-32-545', 'S-1-5-32-558', 'S-1-5-32-559') {
  try { Add-LocalGroupMember -SID $groupSid -Member $sid -ErrorAction Stop }
  catch { if ($_.FullyQualifiedErrorId -notlike 'MemberExists*') { throw } }
}
$userList = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
if (-not (Test-Path $userList)) { New-Item -Path $userList -Force | Out-Null }
New-ItemProperty -Path $userList -Name $Account -Value 0 -PropertyType DWord -Force | Out-Null
$credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$Account", $password)
New-Item -ItemType Directory -Force -Path (Split-Path $CredentialFile) | Out-Null
$credential | Export-Clixml -LiteralPath $CredentialFile

# --- Permissions of the controller area ----------------------------------------

Write-Step 'Granting the account its folders'
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Set-ProtectedAcl $Root @(@{ Sid = $SystemSid; Rights = 'FullControl' }, @{ Sid = $AdministratorsSid; Rights = 'FullControl' }, @{ Sid = $me; Rights = 'FullControl' }, @{ Sid = $sid; Rights = 'ReadAndExecute' })
foreach ($sub in 'storage', 'tmp', 'npm-cache', 'runner') { Add-FolderGrant (Join-Path $Root $sub) $sid 'Modify' }
New-Item -ItemType Directory -Force -Path (Join-Path $ProvisioningDir 'bin') | Out-Null
Set-ProtectedAcl $ProvisioningDir @(@{ Sid = $SystemSid; Rights = 'FullControl' }, @{ Sid = $AdministratorsSid; Rights = 'FullControl' }, @{ Sid = $me; Rights = 'ReadAndExecute' }, @{ Sid = $sid; Rights = 'ReadAndExecute' })

Write-Step 'Creating the account profile'
$first = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/d /c exit 0' -Credential $credential -LoadUserProfile -WorkingDirectory $Root -WindowStyle Hidden -Wait -PassThru
if ($first.ExitCode -ne 0) { throw "Could not start a process as $Account (exit code $($first.ExitCode))." }

# --- Firewall ------------------------------------------------------------------

Write-Step 'Adding the firewall rules'
Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
$privateNetworks = @('LocalSubnet', 'DefaultGateway', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '224.0.0.0/4', '255.255.255.255', 'fc00::/7', 'fe80::/10', 'ff00::/8')
$notLoopback = @('0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255', '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
$rules = New-Object System.Collections.Generic.List[object]
New-NetFirewallRule -Name 'mediabox-g10-account-private' -DisplayName 'mediabox-g10: account off private networks' -Group $FirewallGroup -Direction Outbound -Action Block -LocalUser "D:(A;;CC;;;$sid)" -RemoteAddress $privateNetworks -Profile Any | Out-Null
$rules.Add([ordered]@{ name = 'mediabox-g10-account-private'; direction = 'Outbound'; scope = 'account'; program = $null })
$evaluated = @(Get-ChildItem -LiteralPath (Join-Path $Root 'ollama') -Recurse -Filter *.exe) + @(Get-ChildItem -LiteralPath (Join-Path $Root 'toolchain\ffmpeg') -Filter *.exe) + @(Get-Item -LiteralPath (Join-Path $Root 'toolchain\node-eval\node.exe'))
foreach ($exe in $evaluated) {
  $key = ($exe.FullName.Substring($Root.Length + 1) -replace '[\\. ]', '-').ToLowerInvariant()
  foreach ($direction in 'Outbound', 'Inbound') {
    if ($direction -eq 'Outbound') { $prefix = 'out' } else { $prefix = 'in' }
    $name = "mediabox-g10-$prefix-$key"
    New-NetFirewallRule -Name $name -DisplayName "mediabox-g10: $($exe.Name) loopback only ($direction)" -Group $FirewallGroup -Direction $direction -Action Block -Program $exe.FullName -RemoteAddress $notLoopback -Profile Any | Out-Null
    $rules.Add([ordered]@{ name = $name; direction = $direction; scope = 'program'; program = $exe.FullName })
  }
}

# A per-account rule is the one condition Windows could accept without
# enforcing it, so both kinds of rule are proven from inside the account now,
# before the long permission rewrite below.
$probeDir = Join-Path $Root 'tmp\installer'
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
$probeFile = Join-Path $probeDir 'connect-probe.mjs'
[IO.File]::WriteAllText($probeFile, $ConnectProbe, [Text.Encoding]::ASCII)
$gateway = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop
if (-not $gateway -or $gateway -eq '0.0.0.0') { throw 'No default gateway to probe. Connect the machine to its network and run the script again.' }

function Invoke-AccountProbe([string]$Node, [string]$Target, [int]$Port) {
  $out = Join-Path $probeDir "probe-$([guid]::NewGuid().ToString('N')).txt"
  Start-Process -FilePath $Node -ArgumentList "`"$probeFile`" $Target $Port" -Credential $credential -LoadUserProfile -WorkingDirectory $probeDir -RedirectStandardOutput $out -Wait | Out-Null
  $text = ''
  if (Test-Path $out) {
    $text = ([string](Get-Content -Raw $out)).Trim()
    Remove-Item -LiteralPath $out -Force
  }
  return $text
}

Write-Step 'Proving the firewall rules from inside the account'
$lanOutcome = Invoke-AccountProbe (Join-Path $Root 'toolchain\node\node.exe') $gateway 80
if ($lanOutcome -ne 'EACCES') {
  throw "The account reached the private gateway $gateway with outcome '$lanOutcome': Windows does not enforce the per-account rule here. The installation stopped before changing any permission on the data drives. See docs/blueprints/handoffs/PR05-LOCAL-CONTROLLER.es.md, section 9."
}
Write-Host '    ok   the account cannot reach the private gateway (EACCES)'
$publicOutcome = Invoke-AccountProbe (Join-Path $Root 'toolchain\node-eval\node.exe') $PublicProbe 443
if ($publicOutcome -ne 'EACCES') {
  throw "The evaluation node reached $PublicProbe with outcome '$publicOutcome': the program rules are not enforced. The installation stopped before changing any permission on the data drives."
}
Write-Host '    ok   the evaluation node cannot reach a public address (EACCES)'

# --- Data locations ------------------------------------------------------------

Write-Step "Denying $Account every data location (inherited permissions are rewritten; large drives take long)"
$systemDrive = $env:SystemDrive
$windowsFolders = @('Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Users', '$Recycle.Bin', '$WinREAgent', '$SysReset', '$Windows.~BT', '$Windows.~WS', 'System Volume Information', 'Recovery', 'PerfLogs', 'Config.Msi', 'Documents and Settings', 'OneDriveTemp', 'Windows.old', 'ESD', 'Boot', 'EFI')
$denied = New-Object System.Collections.Generic.List[string]
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Where-Object { $_.DeviceID -ne $systemDrive } | ForEach-Object { $denied.Add("$($_.DeviceID)\") }
Get-ChildItem -LiteralPath "$systemDrive\" -Directory -Force | Where-Object { ($windowsFolders -notcontains $_.Name) -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | ForEach-Object { $denied.Add($_.FullName) }
$public = Join-Path $systemDrive 'Users\Public'
if (Test-Path $public) { $denied.Add($public) }
# Everything but reading attributes, permissions and synchronizing: the account
# can still traverse to its own protected area on the same drive.
$denyRights = '(OI)(CI)(RD,WD,AD,REA,WEA,X,DC,WA,D,WDAC,WO)'
$partial = @()
foreach ($target in $denied) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  Write-Host "    $target ..." -NoNewline
  & icacls $target /deny "*${sid}:$denyRights" /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { $partial += $target; Write-Host (' some files failed ({0:n0} s)' -f $watch.Elapsed.TotalSeconds) -ForegroundColor Yellow }
  else { Write-Host (' done ({0:n0} s)' -f $watch.Elapsed.TotalSeconds) }
  $global:LASTEXITCODE = 0
}

# --- Provisioning file -----------------------------------------------------------

Write-Step "Writing $ProvisioningFile"
$provisioning = [ordered]@{
  schemaVersion = 1
  provisionedAt = (Get-Date).ToUniversalTime().ToString('o')
  installer = 'scripts/controller/Install-G10Controller.ps1'
  account = [ordered]@{ name = $Account; sid = $sid }
  maintainer = [ordered]@{ profile = $env:USERPROFILE }
  root = $Root
  storage = (Join-Path $Root 'storage')
  tmp = (Join-Path $Root 'tmp')
  npmCache = (Join-Path $Root 'npm-cache')
  toolchain = [ordered]@{ node = (Join-Path $Root 'toolchain\node\node.exe'); evalNode = (Join-Path $Root 'toolchain\node-eval\node.exe'); ffmpegDir = (Join-Path $Root 'toolchain\ffmpeg') }
  runtime = [ordered]@{ ollamaExe = (Join-Path $Root 'ollama\ollama.exe'); modelsDir = (Join-Path $Root 'models') }
  firewall = [ordered]@{ group = $FirewallGroup; rules = $rules.ToArray() }
  deniedPaths = $denied.ToArray()
  runner = [ordered]@{ label = $RunnerLabel; namePrefix = "$RunnerLabel-"; dir = (Join-Path $Root 'runner') }
  probes = [ordered]@{ publicAddress = $PublicProbe; publicPort = 443 }
}
[IO.File]::WriteAllText($ProvisioningFile, ($provisioning | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
$wrapper = "@echo off`r`n`"$(Join-Path $Root 'toolchain\node\node.exe')`" %*`r`nexit /b %ERRORLEVEL%`r`n"
[IO.File]::WriteAllText((Join-Path $ProvisioningDir 'bin\node.cmd'), $wrapper, [Text.Encoding]::ASCII)

# --- Checks from inside the account ------------------------------------------------

Write-Step "Running the controller's isolation checks as $Account"
$probeDir = Join-Path $Root 'tmp\installer'
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
Copy-Item -LiteralPath (Join-Path $RepoRoot 'evals\local-agent\controller-isolation.mjs') -Destination (Join-Path $probeDir 'controller-isolation.mjs') -Force
$selfTest = Join-Path $probeDir 'isolation.json'
$selfTestErrors = Join-Path $probeDir 'isolation.err'
$check = Start-Process -FilePath (Join-Path $Root 'toolchain\node\node.exe') -ArgumentList "`"$(Join-Path $probeDir 'controller-isolation.mjs')`" --self-test --json" -Credential $credential -LoadUserProfile -WorkingDirectory $probeDir -RedirectStandardOutput $selfTest -RedirectStandardError $selfTestErrors -Wait -PassThru
$isolationOk = $false
if ((Test-Path $selfTest) -and (Get-Item $selfTest).Length -gt 0) {
  $result = Get-Content -Raw $selfTest | ConvertFrom-Json
  foreach ($c in $result.checks) {
    if ($c.ok) { Write-Host "    ok   $($c.id): $($c.detail)" } else { Write-Host "    FAIL $($c.id): $($c.detail)" -ForegroundColor Yellow }
  }
  $isolationOk = [bool]$result.ok
} else {
  Write-Host "    the self-test produced no result (exit code $($check.ExitCode)):" -ForegroundColor Yellow
  if (Test-Path $selfTestErrors) { Get-Content $selfTestErrors | ForEach-Object { Write-Host "    $_" } }
}

$pdh = Join-Path $probeDir 'gpu-counters.txt'
$counterProbe = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList "-NoProfile -NonInteractive -Command `"(New-Object Diagnostics.PerformanceCounterCategory 'GPU Process Memory').GetInstanceNames().Count`"" -Credential $credential -LoadUserProfile -WorkingDirectory $probeDir -RedirectStandardOutput $pdh -Wait -PassThru
$instances = 0
if (Test-Path $pdh) { [void][int]::TryParse(([string](Get-Content -Raw $pdh)).Trim(), [ref]$instances) }
if ($counterProbe.ExitCode -eq 0 -and $instances -gt 0) { Write-Host "    ok   gpu-counters: the account reads $instances GPU memory counter instances" }
else { Write-Host '    FAIL gpu-counters: the account cannot read the GPU Process Memory counters' -ForegroundColor Yellow; $isolationOk = $false }

Write-Step 'Summary'
Write-Host "Account:       $Account ($sid), standard user, hidden from the sign-in screen"
Write-Host "Controller:    $Root"
Write-Host "Provisioning:  $ProvisioningFile"
Write-Host "Firewall:      group $FirewallGroup, $($rules.Count) rules"
Write-Host "Denied:        $($denied.Count) data locations"
if ($partial.Count) { Write-Host "Partly denied: $($partial -join ', ') (icacls reported files it could not change)" -ForegroundColor Yellow }
if ($isolationOk) {
  Write-Host ''
  Write-Host 'The isolation checks pass. Next, from a normal (not elevated) PowerShell in the repository:'
  Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\controller\Start-G10Controller.ps1 -Rehearsal'
} else {
  Write-Host ''
  Write-Host 'Some checks failed. A readable removable drive only needs to be unplugged; any other failure needs fixing' -ForegroundColor Yellow
  Write-Host 'before a trusted run (see docs/blueprints/handoffs/PR05-LOCAL-CONTROLLER.es.md).' -ForegroundColor Yellow
  exit 1
}
