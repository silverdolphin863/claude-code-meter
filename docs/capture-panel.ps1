$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $projectRoot 'dist'
$electronPath = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
$capturePath = Join-Path $PSScriptRoot 'panel.png'
$fixturePath = Join-Path $PSScriptRoot 'panel-fixture.js'
$userDataPath = Join-Path $distRoot 'showcase-user-data'
$stdoutPath = Join-Path $distRoot 'showcase-panel.log'
$stderrPath = Join-Path $distRoot 'showcase-panel.err.log'
$capturePort = 17384

if (-not (Test-Path -LiteralPath $electronPath)) {
  throw 'Electron is not installed. Run npm install first.'
}

if (Get-NetTCPConnection -LocalPort $capturePort -ErrorAction SilentlyContinue) {
  throw "Port $capturePort is already in use."
}

New-Item -ItemType Directory -Path $distRoot -Force | Out-Null

$env:PORT = [string]$capturePort
$env:WIDGET_CAPTURE = $capturePath
$env:WIDGET_MODE = 'full'
$env:WIDGET_EVAL = Get-Content -LiteralPath $fixturePath -Raw
$env:WIDGET_WAIT = '300'

$startOptions = @{
  FilePath = $electronPath
  ArgumentList = @('.', "--user-data-dir=$userDataPath")
  WorkingDirectory = $projectRoot
  WindowStyle = 'Hidden'
  PassThru = $true
  Wait = $true
  RedirectStandardOutput = $stdoutPath
  RedirectStandardError = $stderrPath
}
$process = Start-Process @startOptions

if ($process.ExitCode -ne 0) {
  $errorOutput = Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
  throw "Panel capture exited with code $($process.ExitCode). $errorOutput"
}

if (-not (Test-Path -LiteralPath $capturePath)) {
  throw 'Panel capture did not create docs\panel.png.'
}

Get-Item -LiteralPath $capturePath | Select-Object FullName, Length, LastWriteTime
