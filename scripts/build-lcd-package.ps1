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

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$firmwareRoot = Join-Path $repositoryRoot 'firmware\esp32-4848s040'
$buildRoot = Join-Path $firmwareRoot '.pio\build\esp32-4848s040'
$releaseSource = Join-Path $firmwareRoot 'release'
$outputRoot = Join-Path $repositoryRoot 'dist'
$protocolSource = Get-Content -Raw -LiteralPath (Join-Path $firmwareRoot 'src\serial_protocol.h')
$versionMatch = [regex]::Match($protocolSource, 'firmware\\\":\\\"(?<version>\d+\.\d+\.\d+)')
if (-not $versionMatch.Success) {
  throw 'Could not read the firmware version from serial_protocol.h.'
}
$firmwareVersion = $versionMatch.Groups['version'].Value
$assetBaseName = "CCMeter-LCD-Firmware-$firmwareVersion"
$mergedImageName = "CCMeter-ESP32-4848S040-$firmwareVersion.bin"
$archivePath = Join-Path $outputRoot "$assetBaseName.zip"
$stageRoot = Join-Path $env:TEMP ("ccmeter-lcd-package-" + [guid]::NewGuid().ToString('N'))

$platformioRoot = if ($env:PLATFORMIO_CORE_DIR) {
  $env:PLATFORMIO_CORE_DIR
} else {
  Join-Path $env:USERPROFILE '.platformio'
}
$frameworkRoot = Join-Path $platformioRoot 'packages\framework-arduinoespressif32'

$segments = [ordered]@{
  '0x0' = Join-Path $buildRoot 'bootloader.bin'
  '0x8000' = Join-Path $buildRoot 'partitions.bin'
  '0xe000' = Join-Path $frameworkRoot 'tools\partitions\boot_app0.bin'
  '0x10000' = Join-Path $buildRoot 'firmware.bin'
}

foreach ($segment in $segments.GetEnumerator()) {
  if (-not (Test-Path -LiteralPath $segment.Value)) {
    throw "Missing firmware segment $($segment.Value). Run PlatformIO build first."
  }
}
foreach ($sourceFile in @('Install-CCMeter-LCD.ps1', 'SETUP.html')) {
  $sourcePath = Join-Path $releaseSource $sourceFile
  if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Missing release file $sourcePath"
  }
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
$mergedImagePath = Join-Path $stageRoot $mergedImageName

$segmentData = @()
foreach ($segment in $segments.GetEnumerator()) {
  $offset = [Convert]::ToInt32($segment.Key.Substring(2), 16)
  $bytes = [IO.File]::ReadAllBytes($segment.Value)
  $segmentData += [pscustomobject]@{ Offset = $offset; Bytes = $bytes; Path = $segment.Value }
}
$segmentData = @($segmentData | Sort-Object Offset)
for ($index = 1; $index -lt $segmentData.Count; $index++) {
  $previousEnd = $segmentData[$index - 1].Offset + $segmentData[$index - 1].Bytes.Length
  if ($previousEnd -gt $segmentData[$index].Offset) {
    throw "Firmware segments overlap near $($segmentData[$index].Path)."
  }
}
$mergedLength = ($segmentData | ForEach-Object { $_.Offset + $_.Bytes.Length } | Measure-Object -Maximum).Maximum
if ($mergedLength -le 0 -or $mergedLength -gt 0x1000000) {
  throw "Merged firmware length $mergedLength is outside the 16 MB flash."
}

$fillBuffer = New-Object byte[] 65536
for ($index = 0; $index -lt $fillBuffer.Length; $index++) { $fillBuffer[$index] = 0xFF }
$stream = [IO.File]::Open($mergedImagePath, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $remaining = $mergedLength
  while ($remaining -gt 0) {
    $writeLength = [Math]::Min($remaining, $fillBuffer.Length)
    $stream.Write($fillBuffer, 0, $writeLength)
    $remaining -= $writeLength
  }
  foreach ($segment in $segmentData) {
    $stream.Position = $segment.Offset
    $stream.Write($segment.Bytes, 0, $segment.Bytes.Length)
  }
} finally {
  $stream.Dispose()
}

Copy-Item -LiteralPath (Join-Path $releaseSource 'Install-CCMeter-LCD.ps1') -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $releaseSource 'SETUP.html') -Destination $stageRoot

$imageHash = Get-Sha256 $mergedImagePath
"$imageHash  $mergedImageName" | Set-Content -LiteralPath (Join-Path $stageRoot 'SHA256SUMS.txt') -Encoding ascii

Compress-Archive -Path (Join-Path $stageRoot '*') -DestinationPath $archivePath -CompressionLevel Optimal -Force
if (-not (Test-Path -LiteralPath $archivePath)) {
  throw 'The LCD firmware archive was not created.'
}

$archiveHash = Get-Sha256 $archivePath
[pscustomobject]@{
  Archive = $archivePath
  ArchiveSha256 = $archiveHash
  FirmwareSha256 = $imageHash
  FirmwareVersion = $firmwareVersion
}
