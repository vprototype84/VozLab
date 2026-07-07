'use strict';
const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const http = require('http');
const { provisionRuntime } = require('./provision');

const PORT = 8000;
const APP_URL = `http://127.0.0.1:${PORT}`;
const isDev = !app.isPackaged;

let mainWindow = null;
let backendProc = null;

function getPaths() {
  const localAppData = process.env.LOCALAPPDATA || app.getPath('appData');
  const runtimeRoot = path.join(localAppData, 'TranscriptorIA');

  const backendDir = isDev
    ? path.join(__dirname, '..', 'backend')
    : path.join(process.resourcesPath, 'backend');

  const pythonBin = isDev
    ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
    : path.join(runtimeRoot, 'runtime', 'venv', 'Scripts', 'python.exe');

  const ffmpegDir = isDev
    ? null // usa el ffmpeg del PATH en desarrollo
    : path.join(process.resourcesPath, 'ffmpeg');

  // Voces "predefined" empaquetadas con la app (solo lectura en producción,
  // dentro de resources/backend/voices); voces "custom" del usuario en
  // %APPDATA%\TranscriptorIA (escribible, persiste entre actualizaciones).
  const userDataRoot = path.join(app.getPath('appData'), 'TranscriptorIA');

  return {
    runtimeDir: path.join(runtimeRoot, 'runtime'),
    venvDir: path.join(runtimeRoot, 'runtime', 'venv'),
    pythonInstallDir: path.join(runtimeRoot, 'runtime', 'python'),
    uvCacheDir: path.join(runtimeRoot, 'runtime', 'uvcache'),
    uvBin: isDev
      ? path.join(__dirname, '..', 'resources', 'bin', 'uv.exe')
      : path.join(process.resourcesPath, 'bin', 'uv.exe'),
    modelsDir: path.join(runtimeRoot, 'models'),
    backendDir,
    pythonBin,
    requirementsPath: path.join(backendDir, 'requirements.txt'),
    ffmpegBin: ffmpegDir ? path.join(ffmpegDir, 'ffmpeg.exe') : 'ffmpeg',
    ffprobeBin: ffmpegDir ? path.join(ffmpegDir, 'ffprobe.exe') : 'ffprobe',
    ttsHome: path.join(runtimeRoot, 'models', 'tts'),
    // Chatterbox descarga sus pesos vía HuggingFace Hub; cacheamos en la carpeta
    // de modelos de la app (escribible y persistente entre actualizaciones).
    hfHome: path.join(runtimeRoot, 'models', 'hf'),
    voicesBuiltinDir: isDev ? path.join(__dirname, '..', 'voices') : path.join(backendDir, '..', 'voices'),
    voicesUserDir: path.join(userDataRoot, 'voices'),
    tempDir: path.join(userDataRoot, 'tmp'),
  };
}

function waitForServer(url, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(`${url}/api/status`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      }).on('error', retry);
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('El backend no respondió a tiempo.'));
      setTimeout(tick, 800);
    };
    tick();
  });
}

function bootBackend(appPaths) {
  fs.mkdirSync(appPaths.ttsHome, { recursive: true });
  fs.mkdirSync(appPaths.hfHome, { recursive: true });
  fs.mkdirSync(path.join(appPaths.voicesUserDir, 'custom'), { recursive: true });
  fs.mkdirSync(appPaths.tempDir, { recursive: true });

  backendProc = spawn(appPaths.pythonBin, [path.join(appPaths.backendDir, 'main.py')], {
    cwd: appPaths.backendDir,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      HF_HOME: appPaths.hfHome,
      TTS_HOME: appPaths.ttsHome,
      TRANSCRIPTORIA_FFMPEG: appPaths.ffmpegBin,
      TRANSCRIPTORIA_FFPROBE: appPaths.ffprobeBin,
      TRANSCRIPTORIA_VOICES_BUILTIN: appPaths.voicesBuiltinDir,
      TRANSCRIPTORIA_VOICES_USER: appPaths.voicesUserDir,
      TRANSCRIPTORIA_TMP: appPaths.tempDir,
    },
  });

  backendProc.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  backendProc.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  backendProc.on('exit', (code) => {
    console.log(`Backend salió con código ${code}`);
    backendProc = null;
  });
}

const OLLAMA_URL = 'http://127.0.0.1:11434';

function isOllamaRunning() {
  return new Promise((resolve) => {
    http.get(`${OLLAMA_URL}/api/tags`, (res) => { res.resume(); resolve(true); })
      .on('error', () => resolve(false));
  });
}

// Arranca "ollama serve" en segundo plano si no está ya corriendo, tanto en la
// versión instalada como en la portable. Requiere que Ollama esté instalado en
// el sistema (no se empaqueta con la app); si el binario no está en el PATH o
// ya hay un servidor escuchando, falla en silencio — las funciones de IA
// (Limpiar/Resumen/Acta) ya degradan solas cuando Ollama no está disponible.
async function ensureOllamaRunning(log) {
  try {
    if (await isOllamaRunning()) return;
    const proc = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    proc.on('error', (err) => log(`Ollama: no se pudo arrancar automáticamente (${err.message}).`));
    proc.unref();
  } catch (err) {
    log(`Ollama: no se pudo arrancar automáticamente (${err.message}).`);
  }
}

function killBackend() {
  if (!backendProc) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${backendProc.pid} /f /t`);
    } catch {
      /* ya pudo haber salido */
    }
  } else {
    backendProc.kill('SIGTERM');
  }
  backendProc = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: path.join(__dirname, '..', 'assets', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.maximize());
  mainWindow.on('closed', () => { mainWindow = null; });

  // El "Meeting Booth" (frontend/meeting-booth.html) usa getDisplayMedia para
  // compartir pestaña/ventana — hace falta registrar el handler de Electron
  // para que el diálogo nativo de selección de pantalla funcione dentro de
  // esta ventana (si no, getDisplayMedia falla silenciosamente).
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const { desktopCapturer } = require('electron');
    desktopCapturer.getSources({ types: ['window', 'screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    });
  }, { useSystemPicker: true });

  return mainWindow;
}

function registerPermissionHandlers() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (['media', 'microphone', 'camera', 'display-capture'].includes(permission)) {
      callback(true);
      return;
    }
    callback(false);
  });
}

ipcMain.handle('get-app-url', () => APP_URL);

async function main() {
  await app.whenReady();
  registerPermissionHandlers();

  const appPaths = getPaths();
  const win = createWindow();

  const provisionedMarker = path.join(appPaths.runtimeDir, '.provisioned');
  const needsProvisioning = !isDev && !fs.existsSync(provisionedMarker);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'loading.html'));
  win.show();

  const log = (msg) => {
    console.log(msg);
    win.webContents.send('provision-log', msg);
  };

  // No bloquea el arranque: se lanza en paralelo a la provisión/backend.
  ensureOllamaRunning(log);

  try {
    if (needsProvisioning) {
      await provisionRuntime(appPaths, log);
    }
    bootBackend(appPaths);
    await waitForServer(APP_URL);
    await win.loadURL(APP_URL);
  } catch (err) {
    log(`ERROR: ${err.message}`);
    console.error(err);
  }

  app.on('window-all-closed', () => {
    killBackend();
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', killBackend);
}

main();
