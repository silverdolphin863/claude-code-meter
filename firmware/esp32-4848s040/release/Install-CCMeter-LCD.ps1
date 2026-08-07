param(
  [string]$Port = 'auto',
  [switch]$IUnderstandThisReplacesFirmware,
  [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'

function Get-Sha256 {
  param([string]$Path)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  $inputStream = [IO.File]::OpenRead($Path)
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($inputStream))).Replace('-', '')
  } finally {
    $inputStream.Dispose()
    $sha256.Dispose()
  }
}

if (-not $IUnderstandThisReplacesFirmware -and -not $ValidateOnly) {
  throw 'Flashing replaces the current screen firmware. Read SETUP.html, then rerun with -IUnderstandThisReplacesFirmware.'
}

$images = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'CCMeter-ESP32-4848S040-*.bin' -File)
if ($images.Count -ne 1) {
  throw 'The package must contain exactly one CC Meter ESP32-4848S040 image.'
}
$image = $images[0]

$checksumPath = Join-Path $PSScriptRoot 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $checksumPath)) {
  throw 'SHA256SUMS.txt is missing.'
}
$checksumLine = (Get-Content -LiteralPath $checksumPath | Select-Object -First 1).Trim()
$checksumParts = $checksumLine -split '\s+', 2
if ($checksumParts.Count -ne 2 -or $checksumParts[1] -ne $image.Name) {
  throw 'The firmware checksum manifest is invalid.'
}
$actualHash = Get-Sha256 $image.FullName
if ($actualHash -ne $checksumParts[0]) {
  throw 'The firmware image checksum does not match. Download the package again.'
}

if ($Port -eq 'auto') {
  $displayDevices = @(Get-CimInstance Win32_PnPEntity |
    Where-Object {
      $_.PNPDeviceID -like 'USB\VID_1A86&PID_7523*' -and
      $_.Name -match '\((COM\d+)\)'
    })
  if ($displayDevices.Count -eq 0) {
    throw 'The ESP32-4848S040 CH340 serial port was not found. Pass it explicitly, for example -Port COM3.'
  }
  if ($displayDevices.Count -gt 1) {
    throw 'Multiple CH340 serial devices are connected. Disconnect the others or pass the display port explicitly, for example -Port COM3.'
  }
  if ($displayDevices[0].Name -notmatch '\((COM\d+)\)') {
    throw 'The display COM port could not be read.'
  }
  $Port = $Matches[1]
}
if ($Port -notmatch '^COM\d+$') {
  throw 'Port must be auto or a COM port such as COM3.'
}

$runner = $null
$candidates = @(
  @{ Name = 'esptool.exe'; Prefix = @() },
  @{ Name = 'esptool'; Prefix = @() },
  @{ Name = 'py.exe'; Prefix = @('-m', 'esptool') },
  @{ Name = 'python.exe'; Prefix = @('-m', 'esptool') },
  @{ Name = 'python'; Prefix = @('-m', 'esptool') }
)
foreach ($candidate in $candidates) {
  $command = Get-Command $candidate.Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) { continue }
  & $command.Source @($candidate.Prefix) version *> $null
  if ($LASTEXITCODE -eq 0) {
    $runner = @{ Command = $command.Source; Prefix = $candidate.Prefix }
    break
  }
}
if (-not $runner) {
  throw 'Espressif esptool is required. Install Python 3, run py -m pip install esptool, then rerun this script.'
}

if ($ValidateOnly) {
  Write-Output "Package checksum, esptool, and display port $Port are ready. No flash was written."
  return
}

function Invoke-Esptool {
  param([string[]]$Arguments)
  & $runner.Command @($runner.Prefix) @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "esptool failed with exit code $LASTEXITCODE"
  }
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $PSScriptRoot "CCMeter-factory-backup-$timestamp.bin"

Write-Output "Backing up the complete 16 MB factory image from $Port..."
Invoke-Esptool @('--chip', 'esp32s3', '--port', $Port, '--baud', '460800',
  'read_flash', '0x0', '0x1000000', $backupPath)
if ((Get-Item -LiteralPath $backupPath).Length -ne 16777216) {
  throw 'The factory backup is incomplete. The CC Meter image was not written.'
}

Write-Output "Writing CC Meter to $Port..."
Invoke-Esptool @('--chip', 'esp32s3', '--port', $Port, '--baud', '460800',
  'write_flash', '0x0', $image.FullName)

Write-Output 'CC Meter LCD firmware was installed successfully.'
Write-Output "Factory backup: $backupPath"
