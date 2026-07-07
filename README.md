# VozLab

**Transcripción y narración de voz con IA, 100 % local en tu PC (Windows).**

VozLab convierte audio en texto y texto en voz, todo en tu ordenador:

- 🎙️ **Transcripción** de audio y vídeo (subir archivo, grabar micrófono, grabar una reunión, audio de una pestaña del navegador o grabación de pantalla).
- 👥 **Identificación de hablantes** (diarización) offline.
- ✨ **Procesado con IA**: limpiar texto, resumen ejecutivo y acta de reunión (vía [Ollama](https://ollama.com), opcional).
- 🔊 **Narración (texto → voz)** con voces predefinidas o **clonando tu propia voz**. Motor local gratuito ([Chatterbox](https://github.com/resemble-ai/chatterbox)) o [ElevenLabs](https://elevenlabs.io) en la nube (opcional, con tu API key).

---

## Instalación (Windows 10/11)

Abre **PowerShell** y ejecuta:

```powershell
irm https://raw.githubusercontent.com/vprototype84/VozLab/main/install.ps1 | iex
```

Esto descarga la última versión y la instala **solo para tu usuario** (no pide permisos de administrador). Al terminar, abre **VozLab** desde el menú Inicio.

> ¿Prefieres hacerlo a mano? Descarga `VozLab-Setup-x.y.z.exe` desde la
> [página de Releases](https://github.com/vprototype84/VozLab/releases) y ejecútalo.

**Primer arranque:** la app prepara su entorno y descarga los modelos de voz la primera vez que los usas (la narración descarga ~1,8 GB una sola vez). Requiere conexión a Internet en ese primer uso.

**Aviso de Windows SmartScreen:** el instalador no está firmado digitalmente, así que Windows puede mostrar «Windows protegió tu PC». Pulsa **Más información › Ejecutar de todas formas**.

## Desinstalación

Desde **Configuración › Aplicaciones › Aplicaciones instaladas › VozLab › Desinstalar** (o «Agregar o quitar programas»).

---

## Desarrollo

Requisitos: [Node.js](https://nodejs.org) 18+, Python 3.10+ y (para transcribir en desarrollo) `ffmpeg` en el `PATH`.

```powershell
npm install
npm run dev            # arranca la app en modo desarrollo (Electron + backend)
```

Compilar los instaladores de Windows:

```powershell
npm run build:win           # instalador NSIS + portable
npm run build:win:portable  # solo el ejecutable portable
```

> **Nota:** algunos binarios que la app empaqueta (ffmpeg, `uv`, modelos de
> diarización ONNX) **no** se incluyen en el repositorio por tamaño; están en
> `.gitignore` (`resources/bin/`, `resources/ffmpeg/`, `models/diarization/*.onnx`).
> Para compilar un instalador distribuible debes tenerlos colocados en esas
> rutas. El código fuente aquí publicado sirve para desarrollar y para alojar el
> instalador oficial en Releases.

## Estructura

| Carpeta | Contenido |
|---|---|
| `electron/` | Proceso principal de Electron (arranque, provisión del runtime, ventana). |
| `backend/` | Servidor Python (FastAPI): transcripción, diarización, IA y TTS. |
| `renderer/` | Interfaz de usuario (HTML/CSS/JS). |
| `build/` | Script del instalador NSIS. |
| `install.ps1` | Instalador one-liner para usuarios finales. |

---

Hecho con ❤️ · La app se distribuye tal cual, sin garantías.
