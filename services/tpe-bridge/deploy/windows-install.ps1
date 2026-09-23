<#
.SYNOPSIS
  Installe le pont TPE (services/tpe-bridge) comme service Windows sur le PC comptoir.

.DESCRIPTION
  1. Installe Node.js LTS via winget s'il est absent (ou si la version est < 20).
  2. Copie le dossier autonome (dist/ + node_modules/ + package.json) vers $InstallDir.
  3. Crée bridge.config.json s'il n'existe pas (copie de l'exemple, jeton aléatoire).
  4. Enregistre un service Windows :
       - via NSSM (https://nssm.cc) si nssm.exe est disponible dans le PATH ou $NssmPath  (recommandé :
         redémarrage automatique, rotation du journal, arrêt propre par Ctrl+C → SIGINT) ;
       - sinon via une Tâche planifiée « au démarrage » exécutant node (fallback sans dépendance) ;
       - `-UseSc` force `sc.exe create`, qui NE fonctionne PAS directement avec node.exe (node n'est pas
         un exécutable de service Windows) : ce mode n'est fourni que pour un wrapper type WinSW.

  Prérequis : dossier autonome produit par `pnpm --filter @pos/tpe-bridge deploy --prod --legacy <dossier>`
  (voir deploy/README.md) ou, à défaut, `services/tpe-bridge` après `pnpm install` + `pnpm build`.

.PARAMETER Source
  Dossier contenant dist/, package.json et node_modules/ (défaut : le parent de ce script).
.PARAMETER InstallDir
  Dossier cible (défaut : C:\ProgramData\MaPapeterie\tpe-bridge).
.PARAMETER ServiceName
  Nom du service (défaut : MaPapeterieTpeBridge).
.PARAMETER NssmPath
  Chemin de nssm.exe si non présent dans le PATH.
.PARAMETER UseTask
  Force la Tâche planifiée même si NSSM est disponible.
.PARAMETER UseSc
  Force sc.exe (voir remarque ci-dessus).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\deploy\windows-install.ps1 -Source C:\tmp\tpe-bridge-deploy
#>
[CmdletBinding()]
param(
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [string]$InstallDir = 'C:\ProgramData\MaPapeterie\tpe-bridge',
  [string]$ServiceName = 'MaPapeterieTpeBridge',
  [string]$NssmPath = '',
  [switch]$UseTask,
  [switch]$UseSc
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Ce script doit être lancé dans une console PowerShell « Exécuter en tant qu''administrateur ».'
  }
}

function Get-NodeMajor {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  $version = (& $node.Source --version) -replace '^v', ''
  return [int]($version.Split('.')[0])
}

function Install-NodeIfNeeded {
  if ((Get-NodeMajor) -ge 20) {
    Write-Host "Node.js $(node --version) déjà présent."
    return
  }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'Node.js >= 20 est requis et winget est indisponible : installez Node.js LTS depuis https://nodejs.org puis relancez.'
  }
  Write-Host 'Installation de Node.js LTS via winget…'
  winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements --silent
  # Recharge le PATH machine pour cette session.
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if ((Get-NodeMajor) -lt 20) { throw 'Node.js n''est pas détecté après installation : ouvrez une nouvelle console et relancez.' }
}

function Copy-Bundle {
  foreach ($required in @('dist\index.js', 'package.json')) {
    if (-not (Test-Path (Join-Path $Source $required))) {
      throw "Fichier manquant dans $Source : $required. Lancez d'abord `pnpm --filter @pos/tpe-bridge build` (voir deploy/README.md)."
    }
  }
  if (-not (Test-Path (Join-Path $Source 'node_modules'))) {
    Write-Warning "$Source ne contient pas node_modules : le service échouera au démarrage. Utilisez `pnpm deploy --prod --legacy` (README)."
  }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'logs') | Out-Null
  Write-Host "Copie de $Source vers $InstallDir…"
  robocopy $Source $InstallDir /E /XD .git test src simulator /XF bridge.config.json *.map /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy a échoué (code $LASTEXITCODE)" }
}

function Ensure-Config {
  $config = Join-Path $InstallDir 'bridge.config.json'
  if (Test-Path $config) {
    Write-Host "Configuration existante conservée : $config"
    return
  }
  $example = Join-Path $InstallDir 'bridge.config.example.json'
  if (-not (Test-Path $example)) { $example = Join-Path $Source 'bridge.config.example.json' }
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = [Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', ''
  $json = Get-Content $example -Raw | ConvertFrom-Json
  $json.token = $token
  $json | ConvertTo-Json -Depth 6 | Set-Content -Path $config -Encoding UTF8
  Write-Warning "bridge.config.json créé avec un jeton aléatoire : renseignez tpe.host, printer.host et allowedOrigins, puis reportez le jeton dans la PWA."
  # Restreint la lecture du fichier (contient le jeton) aux administrateurs et SYSTEM.
  icacls $config /inheritance:r /grant:r 'SYSTEM:F' /grant:r 'Administrators:F' | Out-Null
}

function Find-Nssm {
  if ($NssmPath -and (Test-Path $NssmPath)) { return $NssmPath }
  $cmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Install-WithNssm([string]$nssm) {
  $node = (Get-Command node).Source
  $existing = & $nssm status $ServiceName 2>$null
  if ($LASTEXITCODE -eq 0 -and $existing) {
    Write-Host "Service $ServiceName existant : arrêt et mise à jour."
    & $nssm stop $ServiceName | Out-Null
  } else {
    & $nssm install $ServiceName $node (Join-Path $InstallDir 'dist\index.js') | Out-Null
  }
  & $nssm set $ServiceName AppDirectory $InstallDir | Out-Null
  & $nssm set $ServiceName DisplayName 'Ma Papeterie POS - pont TPE' | Out-Null
  & $nssm set $ServiceName Description 'Pont HTTP local vers le TPE Caisse-AP et l''imprimante ESC/POS' | Out-Null
  & $nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
  & $nssm set $ServiceName AppEnvironmentExtra "NODE_ENV=production" "BRIDGE_CONFIG=$InstallDir\bridge.config.json" "LOG_PRETTY=0" | Out-Null
  & $nssm set $ServiceName AppStdout (Join-Path $InstallDir 'logs\bridge.log') | Out-Null
  & $nssm set $ServiceName AppStderr (Join-Path $InstallDir 'logs\bridge.log') | Out-Null
  & $nssm set $ServiceName AppRotateFiles 1 | Out-Null
  & $nssm set $ServiceName AppRotateBytes 10485760 | Out-Null
  & $nssm set $ServiceName AppStopMethodConsole 5000 | Out-Null   # Ctrl+C → arrêt propre (SIGINT)
  & $nssm set $ServiceName AppExit Default Restart | Out-Null
  & $nssm set $ServiceName AppRestartDelay 3000 | Out-Null
  & $nssm start $ServiceName | Out-Null
  Write-Host "Service $ServiceName installé et démarré via NSSM. Journal : $InstallDir\logs\bridge.log"
}

function Install-WithTask {
  $node = (Get-Command node).Source
  $taskName = $ServiceName
  $action = New-ScheduledTaskAction -Execute $node -Argument '"dist\index.js"' -WorkingDirectory $InstallDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Ma Papeterie POS - pont TPE (démarrage automatique)' | Out-Null
  [Environment]::SetEnvironmentVariable('BRIDGE_CONFIG', "$InstallDir\bridge.config.json", 'Machine')
  [Environment]::SetEnvironmentVariable('LOG_PRETTY', '0', 'Machine')
  Start-ScheduledTask -TaskName $taskName
  Write-Host "Tâche planifiée $taskName créée (au démarrage, compte SYSTEM) et lancée."
  Write-Host 'Remarque : sans NSSM, la sortie n''est pas journalisée dans un fichier ; utilisez l''Observateur d''événements ou installez NSSM.'
}

function Install-WithSc {
  # sc.exe exige un exécutable implémentant l'API des services Windows : node.exe ne l'est pas.
  # Ce mode suppose un wrapper (ex. WinSW renommé tpe-bridge.exe + tpe-bridge.xml) déjà placé dans $InstallDir.
  $wrapper = Join-Path $InstallDir 'tpe-bridge.exe'
  if (-not (Test-Path $wrapper)) {
    throw "sc.exe : wrapper $wrapper introuvable. Installez NSSM (recommandé) ou WinSW, ou utilisez -UseTask."
  }
  sc.exe create $ServiceName binPath= "`"$wrapper`"" start= auto DisplayName= 'Ma Papeterie POS - pont TPE' | Out-Null
  sc.exe description $ServiceName 'Pont HTTP local vers le TPE Caisse-AP et l''imprimante ESC/POS' | Out-Null
  sc.exe failure $ServiceName reset= 86400 actions= restart/3000/restart/3000/restart/3000 | Out-Null
  sc.exe start $ServiceName | Out-Null
  Write-Host "Service $ServiceName créé via sc.exe (wrapper $wrapper)."
}

Assert-Admin
Install-NodeIfNeeded
Copy-Bundle
Ensure-Config

if ($UseSc) {
  Install-WithSc
} elseif (-not $UseTask -and (Find-Nssm)) {
  Install-WithNssm (Find-Nssm)
} else {
  if (-not $UseTask) { Write-Warning 'nssm.exe introuvable : repli sur une Tâche planifiée. Installez NSSM (winget install NSSM.NSSM) pour un vrai service.' }
  Install-WithTask
}

Write-Host ''
Write-Host 'Vérification : Invoke-RestMethod http://127.0.0.1:8787/health'
try {
  Start-Sleep -Seconds 2
  Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' | ConvertTo-Json -Depth 4
} catch {
  Write-Warning "Le pont ne répond pas encore : $($_.Exception.Message). Consultez le journal."
}
