# scripts/setup.ps1 — provisión del entorno de DESARROLLO para TranscriptorIA.
# (La provisión de producción la hace electron/provision.js en el primer arranque
#  de la app empaquetada). Este script:
#   1. Comprueba Node.js 18+
#   2. npm install
#   3. Descarga uv.exe -> resources/bin/uv.exe
#   4. Descarga ffmpeg.exe/ffprobe.exe -> resources/ffmpeg/
#   5. Crea .venv/ con Python 3.11 (vía uv) y instala dependencias
#      (con CUDA si hay GPU NVIDIA, si no CPU)
#   6. Crea voices/custom/ si no existe (voces clonadas en desarrollo)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Test-NvidiaGpu {
    try {
        $out = & nvidia-smi -L 2>$null
        if ($LASTEXITCODE -eq 0 -and $out -match "GPU") { return $true }
    } catch {}
    try {
        $gpu = (Get-CimInstance Win32_VideoController).Name -join ","
        return $gpu -match "NVIDIA|GeForce|Quadro|RTX|GTX"
    } catch { return $false }
}

Write-Host "==> Comprobando Node.js..."
$nodeVersion = (node --version) -replace "v", ""
if ([version]($nodeVersion.Split("-")[0]) -lt [version]"18.0.0") {
    throw "Se requiere Node.js 18+. Versión actual: $nodeVersion"
}

Write-Host "==> npm install"
Push-Location $root
npm install
Pop-Location

$binDir = Join-Path $root "resources\bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$uvExe = Join-Path $binDir "uv.exe"
if (-not (Test-Path $uvExe)) {
    Write-Host "==> Descargando uv.exe..."
    $uvZip = Join-Path $binDir "uv.zip"
    Invoke-WebRequest -Uri "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip" -OutFile $uvZip
    Expand-Archive -Path $uvZip -DestinationPath $binDir -Force
    Remove-Item $uvZip
}

$ffmpegDir = Join-Path $root "resources\ffmpeg"
New-Item -ItemType Directory -Force -Path $ffmpegDir | Out-Null
if (-not (Test-Path (Join-Path $ffmpegDir "ffmpeg.exe"))) {
    Write-Host "==> Descargando ffmpeg/ffprobe..."
    $ffZip = Join-Path $ffmpegDir "ffmpeg.zip"
    Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip" -OutFile $ffZip
    $tmpExtract = Join-Path $ffmpegDir "_tmp"
    Expand-Archive -Path $ffZip -DestinationPath $tmpExtract -Force
    $binSrc = Get-ChildItem -Path $tmpExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    Copy-Item $binSrc.FullName -Destination (Join-Path $ffmpegDir "ffmpeg.exe")
    Copy-Item (Join-Path $binSrc.Directory.FullName "ffprobe.exe") -Destination (Join-Path $ffmpegDir "ffprobe.exe")
    Remove-Item $tmpExtract -Recurse -Force
    Remove-Item $ffZip
}

Write-Host "==> Creando entorno virtual (.venv) con Python 3.11..."
$venvDir = Join-Path $root ".venv"
& $uvExe python install 3.11
& $uvExe venv --python 3.11 $venvDir

$hasGpu = Test-NvidiaGpu
if ($hasGpu) {
    Write-Host "==> GPU NVIDIA detectada: instalando PyTorch con CUDA."
    $torchIndex = "https://download.pytorch.org/whl/cu124"
} else {
    Write-Host "==> Sin GPU NVIDIA: instalando PyTorch para CPU."
    $torchIndex = "https://download.pytorch.org/whl/cpu"
}

# Chatterbox 0.1.7 exige torch/torchaudio 2.6.0 → fijamos esa versión (cu124).
& $uvExe pip install --python $venvDir torch==2.6.0 torchaudio==2.6.0 --index-url $torchIndex
& $uvExe pip install --python $venvDir -r (Join-Path $root "backend\requirements.txt") --extra-index-url $torchIndex

$voicesCustom = Join-Path $root "voices\custom"
New-Item -ItemType Directory -Force -Path $voicesCustom | Out-Null

$diarDir = Join-Path $root "models\diarization"
$segDir = Join-Path $diarDir "sherpa-onnx-pyannote-segmentation-3-0"
New-Item -ItemType Directory -Force -Path $segDir | Out-Null
$embModel = Join-Path $diarDir "speaker_embedding.onnx"
if (-not (Test-Path $embModel)) {
    Write-Host "==> Descargando modelo de identificación de hablantes (~25 MB)..."
    Invoke-WebRequest -Uri "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx" -OutFile $embModel
}
$segModel = Join-Path $segDir "model.onnx"
if (-not (Test-Path $segModel)) {
    Write-Host "==> Descargando modelo de segmentación de hablantes (~7 MB)..."
    $segArchive = Join-Path $diarDir "segmentation.tar.bz2"
    Invoke-WebRequest -Uri "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" -OutFile $segArchive
    tar -xjf $segArchive -C $diarDir
    Remove-Item $segArchive
}

Write-Host ""
Write-Host "==> Listo. Arranca la app en desarrollo con: npm run dev"
