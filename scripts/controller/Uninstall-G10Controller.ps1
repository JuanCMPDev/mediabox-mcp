<#
.SYNOPSIS
  Removes the local G10 trusted controller installed by Install-G10Controller.ps1.

.DESCRIPTION
  Run from an elevated Windows PowerShell:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\controller\Uninstall-G10Controller.ps1 [-RemoveFiles]

  Removes the firewall rules, the deny entries on the data locations (which
  rewrites inherited permissions again), the account and its profile, the
  provisioning file and the stored password. -RemoveFiles also deletes the
  controller area: runtime, weights, toolchain, runner and the raw
  observations in storage, which PR05 asks to keep for 90 days.
#>
[CmdletBinding()]
param(
  [string]$Account = 'mediabox-g10',
  [string]$Root = 'E:\mediabox-g10',
  [switch]$RemoveFiles
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script from an elevated PowerShell.' }

$ProvisioningDir = Join-Path $env:ProgramData 'mediabox-g10'
$ProvisioningFile = Join-Path $ProvisioningDir 'controller.json'
$provisioning = $null
if (Test-Path $ProvisioningFile) { $provisioning = Get-Content -Raw $ProvisioningFile | ConvertFrom-Json }
$user = Get-LocalUser -Name $Account -ErrorAction SilentlyContinue
$sid = $null
if ($user) { $sid = $user.SID.Value } elseif ($provisioning) { $sid = $provisioning.account.sid }

Write-Step 'Removing the firewall rules'
Get-NetFirewallRule -Group 'mediabox-g10' -ErrorAction SilentlyContinue | Remove-NetFirewallRule

if ($sid) {
  if ($provisioning) {
    Write-Step 'Removing the deny entries (inherited permissions are rewritten; large drives take long)'
    foreach ($target in @($provisioning.deniedPaths)) {
      Write-Host "    $target"
      & icacls $target /remove:d "*$sid" /C /Q | Out-Null
      $global:LASTEXITCODE = 0
    }
  }
  if (Test-Path $Root) {
    foreach ($sub in 'storage', 'tmp', 'npm-cache', 'runner') {
      $path = Join-Path $Root $sub
      if (Test-Path $path) { & icacls $path /remove "*$sid" /C /Q | Out-Null }
    }
    & icacls $Root /remove "*$sid" /C /Q | Out-Null
    $global:LASTEXITCODE = 0
  }
  $accountProfile = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }
  if ($accountProfile) {
    Write-Step 'Removing the account profile'
    $accountProfile | Remove-CimInstance
  }
}

if ($user) {
  Write-Step "Removing the account $Account"
  Remove-LocalUser -Name $Account
}
$userList = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'
if (Test-Path $userList) { Remove-ItemProperty -Path $userList -Name $Account -ErrorAction SilentlyContinue }
if (Test-Path $ProvisioningDir) { Remove-Item -LiteralPath $ProvisioningDir -Recurse -Force }
$credentialDir = Join-Path $env:LOCALAPPDATA 'mediabox-g10'
if (Test-Path $credentialDir) { Remove-Item -LiteralPath $credentialDir -Recurse -Force }
if ($RemoveFiles -and (Test-Path $Root)) {
  Write-Step "Deleting $Root"
  Remove-Item -LiteralPath $Root -Recurse -Force
}
Write-Step 'Done. Runner registrations left on GitHub, if any, can be listed with: gh api repos/JuanCMPDev/mediabox-mcp/actions/runners'
