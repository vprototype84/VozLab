'use strict';
/**
 * Provisión del runtime de Python (vía uv) y de los modelos de diarización,
 * en %LOCALAPPDATA%\TranscriptorIA — igual patrón que NarraVoz.
 *
 * Se ejecuta una sola vez (marcador .provisioned). Detecta si hay GPU NVIDIA
 * disponible para instalar la build de PyTorch con CUDA en vez de la de CPU.
 */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

function run(cmd, args, opts = {}, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...opts, shell: false });
    let stderr = '';
    proc.stdout.on('data', (d) => onLine && onLine(d.toString()));
    proc.stderr.on('data', (d) => { stderr += d.toString(); onLine && onLine(d.toString()); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} salió con código ${code}\n${stderr.slice(-800)}`));
    });
  });
}

function hasNvidiaGpu() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['-L'], { timeout: 5000 }, (err, stdout) => {
      if (!err && stdout && stdout.toLowerCase().includes('gpu')) {
        resolve(true);
        return;
      }
      // Fallback: WMI (más lento, pero funciona sin el driver de NVIDIA en PATH).
      execFile(
        'powershell',
        ['-NoProfile', '-Command',
         "(Get-CimInstance Win32_VideoController).Name -join ','"],
        { timeout: 8000 },
        (err2, stdout2) => {
          resolve(!err2 && /nvidia|geforce|quadro|rtx|gtx/i.test(stdout2 || ''));
        },
      );
    });
  });
}

function download(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        download(res.headers.location, destPath, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} descargando ${url}`));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let loaded = 0;
      res.on('data', (chunk) => {
        loaded += chunk.length;
        if (onProgress && total) onProgress(loaded / total);
      });
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', reject);
  });
}

const DIARIZATION_MODELS = {
  segmentationArchive:
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
  embedding:
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx',
};

async function ensureDiarizationModels(modelsDir, log) {
  const segDir = path.join(modelsDir, 'diarization', 'sherpa-onnx-pyannote-segmentation-3-0');
  const segModel = path.join(segDir, 'model.onnx');
  const embModel = path.join(modelsDir, 'diarization', 'speaker_embedding.onnx');

  fs.mkdirSync(path.join(modelsDir, 'diarization'), { recursive: true });

  if (!fs.existsSync(embModel)) {
    log('Descargando modelo de identificación de hablantes (embeddings, ~25 MB)…');
    await download(DIARIZATION_MODELS.embedding, embModel, (p) => log(`  embeddings… ${(p * 100).toFixed(0)}%`));
  }

  if (!fs.existsSync(segModel)) {
    log('Descargando modelo de segmentación de hablantes (~7 MB)…');
    const archivePath = path.join(modelsDir, 'diarization', 'segmentation.tar.bz2');
    await download(DIARIZATION_MODELS.segmentationArchive, archivePath, (p) => log(`  segmentación… ${(p * 100).toFixed(0)}%`));
    // tar viene incluido en Windows 10 1803+ y soporta bz2.
    await run('tar', ['-xjf', archivePath, '-C', path.join(modelsDir, 'diarization')]);
    fs.unlinkSync(archivePath);
  }
}

/**
 * appPaths: { runtimeDir, venvDir, pythonInstallDir, uvCacheDir, uvBin,
 *             backendDir, modelsDir, requirementsPath }
 */
async function provisionRuntime(appPaths, log) {
  const provisionedMarker = path.join(appPaths.runtimeDir, '.provisioned');
  if (fs.existsSync(provisionedMarker)) {
    log('Runtime ya provisionado.');
    return;
  }

  fs.mkdirSync(appPaths.runtimeDir, { recursive: true });

  const env = {
    ...process.env,
    UV_PYTHON_INSTALL_DIR: appPaths.pythonInstallDir,
    UV_CACHE_DIR: appPaths.uvCacheDir,
    UV_NO_PROGRESS: '1',
  };

  log('Comprobando GPU NVIDIA…');
  const hasGpu = await hasNvidiaGpu();
  log(hasGpu ? 'GPU NVIDIA detectada: se instalará PyTorch con soporte CUDA.'
             : 'Sin GPU NVIDIA: se instalará PyTorch para CPU.');

  log('Instalando Python 3.11 (vía uv)…');
  await run(appPaths.uvBin, ['python', 'install', '3.11'], { env }, log);

  log('Creando entorno virtual…');
  await run(appPaths.uvBin, ['venv', '--python', '3.11', appPaths.venvDir], { env }, log);

  const pip = ['pip', 'install', '--python', appPaths.venvDir];

  // Chatterbox 0.1.7 exige torch/torchaudio 2.6.0 (cu124 con GPU, cpu si no).
  const torchIndex = hasGpu
    ? 'https://download.pytorch.org/whl/cu124'
    : 'https://download.pytorch.org/whl/cpu';

  log('Instalando PyTorch…');
  await run(appPaths.uvBin, [
    ...pip, 'torch==2.6.0', 'torchaudio==2.6.0',
    '--index-url', torchIndex,
  ], { env }, log);

  log('Instalando dependencias del backend (puede tardar varios minutos)…');
  await run(appPaths.uvBin, [
    ...pip, '-r', appPaths.requirementsPath,
    '--extra-index-url', torchIndex,
  ], { env }, log);

  log('Descargando modelos de diarización…');
  await ensureDiarizationModels(appPaths.modelsDir, log);

  fs.writeFileSync(provisionedMarker, new Date().toISOString());
  log('Provisión completada.');

  // Liberar espacio: la caché de uv puede ocupar varios GB tras la instalación.
  try {
    fs.rmSync(appPaths.uvCacheDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

module.exports = { provisionRuntime, hasNvidiaGpu };
