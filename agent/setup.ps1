<#
Sets up the TV Home PC agent for the current user (no admin needed):
writes agent\config.json and adds a Startup-folder shortcut that runs the agent hidden.

  .\setup.ps1 -TvIp <tv-ip> -Lat <lat> -Lon <lon> -Place "<town>"
  .\setup.ps1 -Remove     # delete the Startup shortcut and stop the agent
#>
param(
  [string]$TvIp,
  [double]$Lat,
  [double]$Lon,
  [string]$Place = "",
  [string]$Pythonw = "",
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$agent = Join-Path $here 'tvhome_agent.py'
$configPath = Join-Path $here 'config.json'
$shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'TV Home Agent.lnk'

function Stop-Agent {
  Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
    Where-Object { $_.CommandLine -like "*tvhome_agent.py*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

if ($Remove) {
  Stop-Agent
  if (Test-Path $shortcut) { Remove-Item $shortcut }
  "Removed startup shortcut and stopped the agent."
  return
}

if (-not $TvIp) { throw "Pass -TvIp <the TV's IP address>" }

if (-not $Pythonw) {
  $Pythonw = Get-ChildItem "$env:APPDATA\uv\python" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'pythonw.exe' } |
    Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Pythonw -or -not (Test-Path $Pythonw)) { throw "pythonw.exe not found; pass -Pythonw <path>" }

# The adapter that routes to the TV is the one Wake-on-LAN has to target.
$route = Find-NetRoute -RemoteIPAddress $TvIp | Select-Object -First 1
$mac = (Get-NetAdapter -InterfaceIndex $route.InterfaceIndex).MacAddress

$token = $null
if (Test-Path $configPath) { $token = (Get-Content $configPath -Raw | ConvertFrom-Json).token }
if (-not $token) { $token = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }) }

$config = [ordered]@{
  tv_ip = $TvIp
  token = $token
  name = $env:COMPUTERNAME
  mac = $mac
  weather = if ($PSBoundParameters.ContainsKey('Lat')) { [ordered]@{ lat = $Lat; lon = $Lon; label = $Place } } else { $null }
}
$config | ConvertTo-Json | Set-Content -Path $configPath -Encoding utf8

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($shortcut)
$lnk.TargetPath = $Pythonw
$lnk.Arguments = "`"$agent`""
$lnk.WorkingDirectory = $here
$lnk.Save()

Stop-Agent
Start-Process -FilePath $Pythonw -ArgumentList "`"$agent`"" -WorkingDirectory $here -WindowStyle Hidden
"Agent configured for TV $TvIp (PC $env:COMPUTERNAME, MAC $mac) and started. Startup shortcut: $shortcut"
