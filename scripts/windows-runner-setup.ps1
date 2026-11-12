<#
  NeoAcademy Windows runner — one-time setup on the Windows PC.

  Lets another computer (e.g. a Mac generating books) run Windows-only checks
  here over SSH, contained to:
    - a dedicated STANDARD (non-admin) account, "neorunner", with no secrets;
    - key-only login, and SSH limited to that one account (no other account,
      including administrators, can log in over SSH; no passwords at all);
    - SSH reachable only from the generating computer's IP address;
    - a scratch folder, C:\NeoRunner\work (each job gets its own subfolder,
      deleted afterwards).

  Run in PowerShell AS ADMINISTRATOR:
    powershell -ExecutionPolicy Bypass -File .\windows-runner-setup.ps1 `
      -PublicKey "ssh-ed25519 AAAA... you@mac" -AllowFrom 192.168.4.20

  -PublicKey : contents of ~/.ssh/neorunner.pub from the Mac
  -AllowFrom : the Mac's IP address
#>
param(
  [Parameter(Mandatory = $true)][string]$PublicKey,
  [Parameter(Mandatory = $true)][string]$AllowFrom,
  [string]$User = 'neorunner',
  [string]$WorkDir = 'C:\NeoRunner\work'
)
$ErrorActionPreference = 'Stop'

# The Windows feature and account commands only work in Windows PowerShell 5.1
# ("Class not registered" in PowerShell 7): re-run there automatically.
if ($PSVersionTable.PSEdition -eq 'Core') {
  Write-Host 'Re-running in Windows PowerShell 5.1 (needed for the Windows feature and account commands)...'
  $winPs = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  & $winPs -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -PublicKey $PublicKey -AllowFrom $AllowFrom -User $User -WorkDir $WorkDir
  exit $LASTEXITCODE
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script in PowerShell as Administrator.'
}
if ($PublicKey -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+') { throw 'PublicKey does not look like an SSH public key.' }

Write-Host '1/6 OpenSSH server'
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd

Write-Host "2/6 Standard account '$User' (not an administrator)"
if (-not (Get-LocalUser -Name $User -ErrorAction SilentlyContinue)) {
  # A long random password nobody knows: the account only logs in with the key.
  $chars = [char[]]'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#%+=?'
  $pw = -join (1..32 | ForEach-Object { $chars | Get-Random })
  New-LocalUser -Name $User -Password (ConvertTo-SecureString $pw -AsPlainText -Force) -PasswordNeverExpires -AccountNeverExpires -Description 'NeoAcademy Windows runner (key-only SSH)' | Out-Null
  Add-LocalGroupMember -Group 'Users' -Member $User -ErrorAction SilentlyContinue
}
if (Get-LocalGroupMember -Group 'Administrators' -Member $User -ErrorAction SilentlyContinue) {
  throw "'$User' is an administrator. Remove it from Administrators first; the runner must be a standard account."
}

Write-Host "3/6 Scratch folder $WorkDir"
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
icacls $WorkDir /grant "${User}:(OI)(CI)M" | Out-Null

Write-Host '4/6 Key-only login, limited to the runner account'
$keyFile = 'C:\ProgramData\ssh\neorunner_authorized_keys'
Set-Content -Path $keyFile -Value $PublicKey -Encoding ascii
# sshd requires: only SYSTEM and Administrators may write; the user may read.
icacls $keyFile /inheritance:r /grant 'SYSTEM:F' /grant 'Administrators:F' /grant "${User}:R" | Out-Null
$config = 'C:\ProgramData\ssh\sshd_config'
$block = @"

# NeoAcademy Windows runner
Match User $User
    AuthorizedKeysFile __PROGRAMDATA__/ssh/neorunner_authorized_keys
    PasswordAuthentication no
    AllowTcpForwarding no
    PermitTTY no
"@
$current = Get-Content -Raw -Path $config
if ($current -notmatch 'NeoAcademy Windows runner') { Add-Content -Path $config -Value $block }
# Only the runner account may log in over SSH, and never with a password.
# (Must sit at the TOP: settings after a "Match" section apply only inside it.)
$current = Get-Content -Raw -Path $config
if ($current -notmatch 'NeoAcademy: only the runner') {
  $top = "# NeoAcademy: only the runner account may log in over SSH`r`nAllowUsers $User`r`nPasswordAuthentication no`r`n`r`n"
  Set-Content -Path $config -Value ($top + $current) -Encoding ascii
}

Write-Host "5/6 Firewall: SSH only from $AllowFrom"
$rule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if ($rule) {
  Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -RemoteAddress $AllowFrom -Enabled True
} else {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (NeoAcademy runner)' -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress $AllowFrom -Action Allow | Out-Null
}

Write-Host '6/6 Restarting the SSH server'
Restart-Service sshd

Write-Host ''
Write-Host 'Done. Tools for Windows-only checks must be installed for all users (Program Files),'
Write-Host 'e.g. Visual Studio Build Tools (MSVC), CMake, or the Windows SDK Debugging Tools (cdb).'
Write-Host "From the Mac, test with:  ssh -i ~/.ssh/neorunner $User@<this PC's IP> `"echo ready`""
