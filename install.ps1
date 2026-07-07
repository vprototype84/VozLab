<#
  VozLab — instalador para Windows
  ---------------------------------
  Uso (en PowerShell):

      irm https://raw.githubusercontent.com/vprototype84/VozLab/main/install.ps1 | iex

  Descarga el instalador de la última versión publicada en GitHub Releases y lo
  ejecuta en silencio. Se instala solo para tu usuario (no requiere permisos de
  administrador) y queda registrado en Windows: podrás desinstalarlo desde
  «Configuración › Aplicaciones › TranscriptorIA › Desinstalar».
#>

$ErrorActionPreference = 'Stop'

$Owner = 'vprototype84'
$Repo  = 'VozLab'

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Cyan }

Write-Host ""
Write-Host "  ┌─────────────────────────────┐" -ForegroundColor DarkCyan
Write-Host "  │   Instalando VozLab          │" -ForegroundColor DarkCyan
Write-Host "  └─────────────────────────────┘" -ForegroundColor DarkCyan
Write-Host ""

# TLS 1.2 para compatibilidad con Windows/PowerShell antiguos.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

# 1) Localizar la última release y su instalador (*Setup*.exe).
$api = "https://api.github.com/repos/$Owner/$Repo/releases/latest"
try {
  $release = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'VozLab-Installer' }
} catch {
  Write-Host "  No se pudieron consultar las releases de $Owner/$Repo." -ForegroundColor Red
  Write-Host "  ¿Hay alguna versión publicada en https://github.com/$Owner/$Repo/releases ?" -ForegroundColor Red
  return
}

$asset = $release.assets | Where-Object { $_.name -like '*Setup*.exe' } | Select-Object -First 1
if (-not $asset) {
  Write-Host "  La última release ($($release.tag_name)) no incluye un instalador *Setup*.exe." -ForegroundColor Red
  return
}

Write-Host "  Versión:    $($release.tag_name)"
Write-Host "  Instalador: $($asset.name)  ($([math]::Round($asset.size / 1MB, 1)) MB)"
Write-Host ""

# 2) Descargar a la carpeta temporal.
$dest = Join-Path $env:TEMP $asset.name
Write-Step "Descargando…"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -UseBasicParsing
try { Unblock-File $dest } catch {}   # quita la «marca de la web» para evitar avisos extra

# 3) Instalar en silencio (per-usuario, sin admin).
Write-Step "Ejecutando el instalador…"
$proc = Start-Process -FilePath $dest -ArgumentList '/S' -PassThru -Wait
if ($proc.ExitCode -ne 0) {
  Write-Host "  El instalador terminó con código $($proc.ExitCode)." -ForegroundColor Yellow
}

Remove-Item $dest -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  ✓ VozLab instalado." -ForegroundColor Green
Write-Host "    Ábrelo desde el menú Inicio buscando «TranscriptorIA»." -ForegroundColor Green
Write-Host "    Desinstalar: Configuración › Aplicaciones › TranscriptorIA." -ForegroundColor DarkGray
Write-Host ""
