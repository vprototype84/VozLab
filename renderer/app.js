/* ═══════════════════════════════════════════════════
   TRANSCRIPTOR IA — app.js
   ═══════════════════════════════════════════════════ */

'use strict';

// ══════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════
const State = {
  currentFile:     null,   // File object
  currentFilename: '',
  currentJobId:    null,
  segments:        [],     // [{id, start, end, text, speaker}]
  speakerColors:   {},     // speakerName → colorIndex
  speakerColorIdx: 0,
  aiResult:        { action: '', label: '', text: '' },
  historyItems:    [],
  activeHistoryId: null,
  pendingMeetingJobId: null,  // audio de reunión ya en el servidor, pendiente de transcribir
  pendingVideoJobId:   null,  // job_id de grabación de pantalla con MP4 descargable
  recordingReady:  false,     // true cuando lo que hay para transcribir es una grabación (micro/reunión)
  diarizeEnabled:  true,      // false → renderizar texto limpio sin columna de hablantes
};

/** Muestra/oculta los botones de descarga y el aviso en la pantalla previa a transcribir. */
function updateFileinfoControls() {
  const dl      = document.getElementById('download-audio-btn');
  const dlVideo = document.getElementById('download-video-btn');
  const notice  = document.getElementById('fileinfo-notice');
  if (dl)      dl.classList.toggle('hidden', !State.recordingReady);
  if (dlVideo) dlVideo.classList.toggle('hidden', !State.pendingVideoJobId);
  if (notice)  notice.classList.toggle('hidden', !State.recordingReady);
}

// ══════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════
function fmtTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0
    ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function fmtDuration(secs) {
  if (!secs) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h} h ${m} min`;
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

function fmtFileSize(bytes) {
  const mb = bytes / 1024 / 1024;
  if (mb < 1)   return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 100) return `${mb.toFixed(1)} MB`;
  return `${mb.toFixed(0)} MB`;
}

function fileSizeHint(bytes) {
  const mb = bytes / 1024 / 1024;
  if (mb < 50)  return `${fmtFileSize(bytes)}`;
  if (mb < 200) return `${fmtFileSize(bytes)} — puede tardar unos minutos`;
  return `${fmtFileSize(bytes)} — archivo grande, la transcripción tardará un rato ☕`;
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('es-ES', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  } catch { return iso; }
}

function getSpeakerColorIdx(speaker) {
  if (!(speaker in State.speakerColors)) {
    State.speakerColors[speaker] = State.speakerColorIdx % 5;
    State.speakerColorIdx++;
  }
  return State.speakerColors[speaker];
}

function segmentsToPlainText(segments) {
  if (!State.diarizeEnabled) {
    return segments.map(s => s.text.trim()).filter(Boolean).join(' ');
  }
  const lines = [];
  let lastSpeaker = null;
  for (const seg of segments) {
    if (!seg.text.trim()) continue;
    if (seg.speaker !== lastSpeaker) {
      lines.push(`\n${seg.speaker}:`);
      lastSpeaker = seg.speaker;
    }
    lines.push(`[${fmtTime(seg.start)}] ${seg.text.trim()}`);
  }
  return lines.join('\n').trim();
}

function showToast(msg, type = 'default', duration = 3000) {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 220);
  }, duration);
}

/** Toast de confirmación con botones (no se auto-cierra). */
function showConfirmToast(msg, confirmLabel, onConfirm) {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast toast-confirm';
  const text = document.createElement('div');
  text.className = 'toast-confirm-text';
  text.textContent = msg;
  const actions = document.createElement('div');
  actions.className = 'toast-confirm-actions';
  const cancel = document.createElement('button');
  cancel.className = 'toast-btn toast-btn-cancel';
  cancel.textContent = 'Cancelar';
  const ok = document.createElement('button');
  ok.className = 'toast-btn toast-btn-danger';
  ok.textContent = confirmLabel || 'Confirmar';
  actions.append(cancel, ok);
  el.append(text, actions);
  container.appendChild(el);

  const close = () => { el.classList.add('removing'); setTimeout(() => el.remove(), 220); };
  cancel.addEventListener('click', close);
  ok.addEventListener('click', () => { close(); onConfirm(); });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ══════════════════════════════════════════════════
// SECTION VISIBILITY
// ══════════════════════════════════════════════════
const SECTIONS = ['sec-home','sec-upload','sec-recorder','sec-meeting','sec-screenrec','sec-tabsetup','sec-webmeeting','sec-fileinfo','sec-progress','sec-ai','sec-ai-results','sec-transcription','sec-tts-voices','sec-tts-narrate'];

// Secciones sin "chrome": ocultan la cabecera de ajustes y la barra lateral
// del Historial (menú principal y flujo de narración).
const CHROMELESS = new Set(['sec-home','sec-tts-voices','sec-tts-narrate']);

function showOnly(...ids) {
  if (!ids.includes('sec-ai')) {
    document.getElementById('scroll-ai-btn')?.classList.add('hidden');
  } else {
    AIStatus.refresh();
  }
  for (const id of SECTIONS) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !ids.includes(id));
  }
  const hideChrome = ids.some(id => CHROMELESS.has(id));
  document.getElementById('app')?.classList.toggle('no-chrome', hideChrome);
}

function showSection(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function hideSection(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

// ══════════════════════════════════════════════════
// DETECCIÓN DE CAPACIDADES
// ══════════════════════════════════════════════════

// La grabación usa getUserMedia. En la ventana nativa (WKWebView) funciona
// gracias al permiso de micrófono concedido por el lanzador.
const CAN_RECORD = typeof navigator !== 'undefined'
  && !!navigator.mediaDevices
  && typeof navigator.mediaDevices.getUserMedia === 'function';

// ══════════════════════════════════════════════════
// AUDIO RECORDER
// ══════════════════════════════════════════════════
const ICON_PAUSE  = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const ICON_RESUME = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="6 4 20 12 6 20 6 4"/></svg>';

const Recorder = {
  mediaRecorder: null,
  chunks:        [],
  startTime:     null,
  timerInterval: null,
  audioCtx:      null,
  analyser:      null,
  animFrame:     null,
  paused:        false,
  pausedAccum:   0,
  pauseStart:    0,

  _elapsed() {
    let p = this.pausedAccum;
    if (this.paused) p += Date.now() - this.pauseStart;
    return Math.floor((Date.now() - this.startTime - p) / 1000);
  },

  togglePause() {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;
    const btn = document.getElementById('pause-rec-btn');
    if (this.paused) {
      this.mediaRecorder.resume();
      this.pausedAccum += Date.now() - this.pauseStart;
      this.paused = false;
      if (btn) btn.innerHTML = ICON_PAUSE + 'Pausar';
    } else {
      this.mediaRecorder.pause();
      this.pauseStart = Date.now();
      this.paused = true;
      if (btn) btn.innerHTML = ICON_RESUME + 'Reanudar';
    }
  },

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast(
        'Tu sistema no expone el micrófono al WebView. Puedes subir el archivo de audio directamente.',
        'info', 6000
      );
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      const msg = err.name === 'NotAllowedError'
        ? 'Permiso de micrófono denegado. Actívalo en Configuración de Windows → Privacidad y seguridad → Micrófono.'
        : 'No se pudo acceder al micrófono: ' + err.message;
      showToast(msg, 'error', 6000);
      return;
    }

    // Audio context for waveform
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);

    // Media recorder
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    this.mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];

    this.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.mediaRecorder.onstop = () => {
      const mimeType = this.mediaRecorder.mimeType || 'audio/webm';
      const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(this.chunks, { type: mimeType });
      const fname = `grabacion_${Date.now()}.${ext}`;
      State.currentFile = new File([blob], fname, { type: mimeType });
      State.currentFilename = fname;
      State.pendingMeetingJobId = null;
      State.recordingReady = true;
      showOnly('sec-fileinfo');
      UI.setFileInfo(fname, 'Grabación completada');
      updateFileinfoControls();
    };

    this.mediaRecorder.start(250);
    this.startTime = Date.now();
    this.paused = false;
    this.pausedAccum = 0;
    const pb = document.getElementById('pause-rec-btn');
    if (pb) pb.innerHTML = ICON_PAUSE + 'Pausar';

    this.timerInterval = setInterval(() => {
      document.getElementById('rec-time').textContent = fmtTime(this._elapsed());
    }, 1000);

    this._drawWaveform();
    showOnly('sec-recorder');
  },

  stop() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      this.mediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
    clearInterval(this.timerInterval);
    cancelAnimationFrame(this.animFrame);
    if (this.audioCtx) { this.audioCtx.close(); this.audioCtx = null; }
  },

  cancel() {
    this.stop();
    this.mediaRecorder = null;
    showOnly('sec-upload');
  },

  _drawWaveform() {
    const canvas = document.getElementById('waveform');
    const ctx = canvas.getContext('2d');
    const bufLen = this.analyser.frequencyBinCount;
    const data = new Uint8Array(bufLen);

    const draw = () => {
      this.animFrame = requestAnimationFrame(draw);
      this.analyser.getByteTimeDomainData(data);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#FAF8F5';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.lineWidth = 2;
      ctx.strokeStyle = '#C97B5F';
      ctx.beginPath();

      const slice = canvas.width / bufLen;
      let x = 0;
      for (let i = 0; i < bufLen; i++) {
        const v = data[i] / 128.0;
        const y = (v * canvas.height) / 2;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        x += slice;
      }
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
    };
    draw();
  },
};

// ══════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════
const UI = {
  setFileInfo(name, sub) {
    document.getElementById('fileinfo-name').textContent = name;
    document.getElementById('fileinfo-sub').textContent = sub || '—';
  },

  updateProgress(pct, msg) {
    document.getElementById('progress-bar').style.width = pct + '%';
    document.getElementById('progress-pct').textContent = pct + '%';
    if (msg) document.getElementById('progress-msg').textContent = msg;
  },

  addLiveSegment(seg) {
    const container = document.getElementById('live-segments');
    const el = document.createElement('div');
    el.className = 'live-seg-text';
    el.textContent = seg.text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  },

  renderSegments(segments) {
    if (typeof _stopPreview === 'function') _stopPreview();
    const wrap = document.getElementById('segments-wrap');
    wrap.innerHTML = '';
    wrap.classList.toggle('no-speakers', !State.diarizeEnabled);

    // Build speaker→colorIdx map without resetting State's counter
    const localMap = {};
    let localIdx = 0;
    for (const seg of segments) {
      if (!(seg.speaker in localMap)) {
        localMap[seg.speaker] = localIdx % 5;
        localIdx++;
      }
    }
    // Sync with State
    State.speakerColors = localMap;
    State.speakerColorIdx = localIdx;

    let prevSpeaker = null;

    for (const seg of segments) {
      const colorIdx = localMap[seg.speaker] ?? 0;
      const el = document.createElement('div');
      el.className = 'segment';
      el.dataset.segId = seg.id;

      const showSpeakerHeader = seg.speaker !== prevSpeaker;
      prevSpeaker = seg.speaker;

      el.innerHTML = `
        <div class="segment-speaker-col">
          ${showSpeakerHeader ? `
          <input
            class="speaker-name-input spk-color-${colorIdx} spk-bg-${colorIdx}"
            type="text"
            value="${escHtml(seg.speaker)}"
            data-speaker="${escHtml(seg.speaker)}"
            data-seg-id="${seg.id}"
            title="Clic para renombrar (renombra todos los segmentos de este hablante)"
          >` : `<div style="height:22px"></div>`}
          <span class="segment-time">${fmtTime(seg.start)}</span>
        </div>
        <div class="segment-text-col">
          <div
            class="segment-text"
            contenteditable="true"
            data-seg-id="${seg.id}"
            data-placeholder="(segmento vacío)"
          >${escHtml(seg.text)}</div>
        </div>
      `;
      wrap.appendChild(el);
    }

    document.getElementById('seg-count').textContent =
      `${segments.length} segmento${segments.length !== 1 ? 's' : ''}`;

    renderSpeakerPanel(segments);

    // Attach speaker rename listeners
    wrap.querySelectorAll('.speaker-name-input').forEach(input => {
      input.addEventListener('focus', e => { e.target.dataset.oldValue = e.target.value; });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
        if (e.key === 'Escape') { e.target.value = e.target.dataset.oldValue; e.target.blur(); }
      });
      input.addEventListener('blur', e => {
        const oldName = e.target.dataset.oldValue || e.target.dataset.speaker;
        const newName = e.target.value.trim() || oldName;
        if (newName !== oldName) {
          renameSpeaker(oldName, newName);
        }
      });
    });

    // Attach text edit listeners
    wrap.querySelectorAll('.segment-text').forEach(div => {
      div.addEventListener('blur', e => {
        const id = parseInt(e.target.dataset.segId, 10);
        const seg = State.segments.find(s => s.id === id);
        if (seg) seg.text = e.target.textContent.trim();
      });
    });
  },

  renderHistory(items) {
    const list = document.getElementById('history-list');
    if (!items || !items.length) {
      list.innerHTML = `<div class="history-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <p>Sin transcripciones anteriores</p>
      </div>`;
      return;
    }

    const pinIcon = `<svg class="hist-pin-ico" viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M14 4v5l2 3v2h-4v5l-1 1-1-1v-5H6v-2l2-3V4H7V2h8v2z"/></svg>`;

    const itemHTML = item => `
      <div class="history-item ${item.id === State.activeHistoryId ? 'active' : ''} ${item.pinned ? 'pinned' : ''}"
           data-history-id="${item.id}">
        <div class="history-item-main">
          <div class="history-item-name" title="${escHtml(item.filename || '—')}">
            ${item.pinned ? pinIcon : ''}${escHtml(item.filename || '(sin nombre)')}
          </div>
          <div class="history-item-meta">
            ${fmtDate(item.date)} · ${fmtDuration(item.duration)}
          </div>
        </div>
        <button class="history-item-menu-btn" title="Opciones"
                data-id="${item.id}" data-pinned="${item.pinned ? '1' : '0'}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
            <circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>
          </svg>
        </button>
      </div>`;

    const pinned = items.filter(i => i.pinned);
    const recent = items.filter(i => !i.pinned);

    let html = '';
    if (pinned.length) {
      html += `<div class="history-group-label">${pinIcon}<span>Fijados</span></div>`;
      html += pinned.map(itemHTML).join('');
    }
    if (recent.length) {
      html += `<div class="history-group-label ${pinned.length ? 'with-top' : ''}"><span>Recientes</span></div>`;
      html += recent.map(itemHTML).join('');
    }
    list.innerHTML = html;

    list.querySelectorAll('.history-item-main').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.closest('.history-item').dataset.historyId;
        loadHistoryItem(id);
      });
    });

    list.querySelectorAll('.history-item-menu-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openHistoryMenu(btn, btn.dataset.id, btn.dataset.pinned === '1');
      });
    });
  },
};

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════════
// SPEAKER PANEL
// ══════════════════════════════════════════════════
const SPK_DOT_COLORS = ['#C97B5F','#8FA68E','#7B9BC9','#B07BC9','#C9B87B'];

function renderSpeakerPanel(segments) {
  const panel  = document.getElementById('speaker-panel');
  const cards  = document.getElementById('speaker-cards');
  if (!panel || !cards) return;

  if (!State.diarizeEnabled) { panel.classList.add('hidden'); return; }

  // Recoge hablantes únicos + su primer segmento (para el preview de audio)
  const firstSeg = {};
  for (const seg of segments) {
    if (!(seg.speaker in firstSeg)) firstSeg[seg.speaker] = seg;
  }
  const speakers = Object.keys(firstSeg);

  if (speakers.length === 0) { panel.classList.add('hidden'); return; }

  panel.classList.remove('hidden');
  cards.innerHTML = '';

  const hasAudio = !!State.currentJobId;

  speakers.forEach(name => {
    const colorIdx = State.speakerColors[name] ?? 0;
    const seg0     = firstSeg[name];
    const text0    = seg0.text || '';
    const preview  = text0.slice(0, 55) + (text0.length > 55 ? '…' : '');

    const otherSpeakers = speakers.filter(s => s !== name);
    const mergeOptions = otherSpeakers.map(s =>
      `<option value="${escHtml(s)}">↳ ${escHtml(s)}</option>`
    ).join('');

    const card = document.createElement('div');
    card.className = 'speaker-card';
    card.innerHTML = `
      <button class="speaker-play-btn" title="Escuchar a este hablante (~5 s)"
              data-start="${seg0.start}" data-end="${seg0.end}"
              ${hasAudio ? '' : 'disabled'}>
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
      </button>
      <div class="speaker-card-dot" style="background:${SPK_DOT_COLORS[colorIdx % SPK_DOT_COLORS.length]}"></div>
      <div class="speaker-card-body">
        <input class="speaker-card-input spk-card-name"
               type="text" value="${escHtml(name)}"
               data-speaker="${escHtml(name)}"
               placeholder="Nombre del hablante"
               title="Pulsa Enter para renombrar">
        <div class="speaker-card-preview">${escHtml(preview)}</div>
      </div>
      ${otherSpeakers.length > 0 ? `
      <select class="merge-speaker-select" title="Fusionar este hablante con otro">
        <option value="" disabled selected>Fusionar con…</option>
        ${mergeOptions}
      </select>` : ''}
    `;
    cards.appendChild(card);

    const playBtn = card.querySelector('.speaker-play-btn');
    if (playBtn && hasAudio) {
      playBtn.addEventListener('click', () => {
        previewSpeaker(parseFloat(playBtn.dataset.start),
                       parseFloat(playBtn.dataset.end), playBtn);
      });
    }

    const mergeSelect = card.querySelector('.merge-speaker-select');
    if (mergeSelect) {
      mergeSelect.addEventListener('change', e => {
        const toName = e.target.value;
        if (!toName) return;
        mergeSpeaker(name, toName);
      });
    }

    const input = card.querySelector('.spk-card-name');
    input.addEventListener('focus', e => { e.target.dataset.oldValue = e.target.value; });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
      if (e.key === 'Escape') { e.target.value = e.target.dataset.oldValue || e.target.value; e.target.blur(); }
    });
    input.addEventListener('blur', e => {
      const oldName = e.target.dataset.oldValue || e.target.dataset.speaker;
      const newName = e.target.value.trim();
      if (!newName || newName === oldName) { e.target.value = oldName; return; }
      renameSpeaker(oldName, newName);
      e.target.dataset.speaker  = newName;
      e.target.dataset.oldValue = newName;
      // Actualizar preview del mismo hablante en este panel
      const firstSeg = State.segments.find(s => s.speaker === newName);
      if (firstSeg) {
        const p = card.querySelector('.speaker-card-preview');
        const t = (firstSeg.text || '').slice(0, 55);
        if (p) p.textContent = t + (firstSeg.text.length > 55 ? '…' : '');
      }
    });
  });
}

// ══════════════════════════════════════════════════
// PREVIEW DE AUDIO POR HABLANTE
// ══════════════════════════════════════════════════
const _ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
const _ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
let _previewTimer = null;
let _previewBtn   = null;

function _resetPreviewBtn() {
  if (_previewBtn) { _previewBtn.classList.remove('playing'); _previewBtn.innerHTML = _ICON_PLAY; }
  _previewBtn = null;
}

function _stopPreview() {
  const audio = document.getElementById('preview-audio');
  clearTimeout(_previewTimer);
  _previewTimer = null;
  if (audio) { audio.pause(); }
  _resetPreviewBtn();
}

/** Reproduce ~5 s del audio a partir de `start` para identificar al hablante. */
function previewSpeaker(start, end, btn) {
  const audio = document.getElementById('preview-audio');
  if (!audio || !State.currentJobId) {
    showToast('No hay audio disponible para este audio', 'error');
    return;
  }
  // Si ya está sonando ESTE botón → parar (toggle).
  if (_previewBtn === btn) { _stopPreview(); return; }
  _stopPreview();

  const src = `/api/audio/${State.currentJobId}`;
  const needsLoad = !audio.src.endsWith(src);
  if (needsLoad) audio.src = src;

  const dur = Math.min(5, Math.max(1.5, (end || start + 5) - start));

  const startPlayback = () => {
    try { audio.currentTime = Math.max(0, start); } catch {}
    audio.play().then(() => {
      _previewBtn = btn;
      btn.classList.add('playing');
      btn.innerHTML = _ICON_STOP;
      _previewTimer = setTimeout(_stopPreview, dur * 1000);
    }).catch(err => {
      showToast('No se pudo reproducir el audio: ' + err.message, 'error');
      _resetPreviewBtn();
    });
  };

  // Con preload="none" el browser no carga nada hasta audio.load().
  // Llamar load() siempre garantiza que loadedmetadata dispare.
  if (audio.readyState >= 1) {
    startPlayback();
  } else {
    audio.addEventListener('loadedmetadata', startPlayback, { once: true });
    audio.load();
  }
}

// Parar el preview si el audio termina por su cuenta.
document.addEventListener('DOMContentLoaded', () => {
  const audio = document.getElementById('preview-audio');
  if (audio) audio.addEventListener('ended', _stopPreview);

  const diarizeToggle = document.getElementById('diarize-toggle');
  const numSpkGroup   = document.getElementById('num-speakers-group');
  function syncNumSpeakersVisibility() {
    if (numSpkGroup) numSpkGroup.style.display = diarizeToggle?.checked ? '' : 'none';
  }
  diarizeToggle?.addEventListener('change', syncNumSpeakersVisibility);
  syncNumSpeakersVisibility();
});

// ══════════════════════════════════════════════════
// SPEAKER MERGE
// ══════════════════════════════════════════════════
function mergeSpeaker(fromName, toName) {
  for (const seg of State.segments) {
    if (seg.speaker === fromName) seg.speaker = toName;
  }
  delete State.speakerColors[fromName];
  UI.renderSegments(State.segments);
  renderSpeakerPanel(State.segments);
}

// ══════════════════════════════════════════════════
// SPEAKER RENAME
// ══════════════════════════════════════════════════
function renameSpeaker(oldName, newName) {
  // Update state
  let count = 0;
  for (const seg of State.segments) {
    if (seg.speaker === oldName) { seg.speaker = newName; count++; }
  }

  // Update color map
  if (oldName in State.speakerColors) {
    State.speakerColors[newName] = State.speakerColors[oldName];
    delete State.speakerColors[oldName];
  }

  // Update all DOM inputs with old name
  document.querySelectorAll(`.speaker-name-input[data-speaker="${CSS.escape(oldName)}"]`).forEach(input => {
    input.value = newName;
    input.dataset.speaker = newName;
    input.dataset.oldValue = newName;
  });

  showToast(`"${oldName}" → "${newName}" (${count} segmento${count !== 1 ? 's' : ''})`, 'success');
  renderSpeakerPanel(State.segments);
}

// ══════════════════════════════════════════════════
// TRANSCRIPTION FLOW
// ══════════════════════════════════════════════════

/** Sube el archivo con progreso real (XHR) y devuelve el job_id */
function uploadWithProgress(file, language, modelSize, diarize, numSpeakers) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('language', language);
    formData.append('model_size', modelSize);
    formData.append('diarize', diarize ? 'true' : 'false');
    formData.append('num_speakers', numSpeakers || 0);

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        const raw = Math.round((e.loaded / e.total) * 90);
        const pct = _mapProgress('upload', raw);
        const mb  = (e.loaded / 1024 / 1024).toFixed(1);
        const tot = (e.total  / 1024 / 1024).toFixed(1);
        UI.updateProgress(pct, `Subiendo… ${mb} / ${tot} MB`);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Respuesta inválida del servidor')); }
      } else {
        let detail = `HTTP ${xhr.status}`;
        try { detail = JSON.parse(xhr.responseText).detail || detail; } catch {}
        reject(new Error(detail));
      }
    });

    xhr.addEventListener('error',   () => reject(new Error('Error de red')));
    xhr.addEventListener('timeout', () => reject(new Error('Tiempo de espera agotado')));

    xhr.open('POST', '/api/transcribe');
    xhr.send(formData);
  });
}

async function startTranscription(file) {
  const language    = document.getElementById('lang-select').value;
  const modelSize   = document.getElementById('model-select').value;
  const diarize     = document.getElementById('diarize-toggle')?.checked ?? true;
  const numSpeakers = parseInt(document.getElementById('num-speakers-select')?.value || '0', 10);
  State.diarizeEnabled = diarize;

  showOnly('sec-progress');
  startProgressTimer();
  UI.updateProgress(0, 'Preparando subida…');
  document.getElementById('live-segments').innerHTML = '';

  let jobId;
  try {
    const data = await uploadWithProgress(file, language, modelSize, diarize, numSpeakers);
    jobId = data.job_id;
  } catch (err) {
    showToast('Error al subir el archivo: ' + err.message, 'error');
    showOnly('sec-fileinfo');
    return;
  }

  streamTranscription(jobId, 'sec-fileinfo');
}

/** Descarga el audio (en M4A) pendiente de transcribir. Convierte en el servidor. */
async function downloadCurrentAudio() {
  const btn = document.getElementById('download-audio-btn');
  let jobId = State.pendingMeetingJobId;

  // Micro: el audio está en el navegador; lo subimos al servidor para convertirlo/descargarlo.
  if (!jobId) {
    if (!State.currentFile) return;
    if (btn) btn.disabled = true;
    showToast('Preparando la descarga…', 'info', 2500);
    try {
      const fd = new FormData();
      fd.append('file', State.currentFile, State.currentFilename || 'grabacion.webm');
      const res = await fetch('/api/stash', { method: 'POST', body: fd });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      jobId = (await res.json()).job_id;
    } catch (err) {
      showToast('No se pudo preparar la descarga: ' + err.message, 'error');
      if (btn) btn.disabled = false;
      return;
    }
    if (btn) btn.disabled = false;
  }

  const base = (State.currentFilename || 'audio').replace(/[^\w]+/g, '_') || 'audio';
  const a = document.createElement('a');
  a.href = `/api/download/${jobId}?name=${encodeURIComponent(base)}`;
  a.download = base + '.m4a';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('Descargando audio (M4A)… revisa tu carpeta de Descargas', 'info', 4000);
}

/** Descarga el MP4 de pantalla generado por screenrec_stop. */
async function downloadCurrentVideo() {
  const jobId = State.pendingVideoJobId;
  if (!jobId) { showToast('No hay vídeo disponible', 'error'); return; }
  const base = (State.currentFilename || 'grabacion').replace(/[^\w]+/g, '_') || 'grabacion';
  const a = document.createElement('a');
  a.href = `/api/download-video/${jobId}?name=${encodeURIComponent(base)}`;
  a.download = base + '.mp4';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast('Descargando vídeo MP4… revisa tu carpeta de Descargas', 'info', 4000);
}

// ══════════════════════════════════════════════════
// PROGRESS — remapeo, timer y mensajes rotativos
// ══════════════════════════════════════════════════

const _TX_MESSAGES = [
  "Convirtiendo ondas de voz en palabras…",
  "Analizando patrones fonéticos…",
  "Separando la señal del ruido de fondo…",
  "Tejiendo el hilo del discurso…",
  "La IA está tomando notas…",
  "Identificando matices del habla…",
  "Procesando el lenguaje hablado…",
  "Descifrando el código de la voz…",
  "Transformando vibraciones en texto…",
  "Escuchando con atención máxima…",
  "Reconociendo idioma y acento…",
  "Las palabras toman forma…",
  "Segmentando el flujo de habla…",
  "El texto emerge del silencio…",
  "Procesando la cadencia de la voz…",
  "Convirtiendo el tiempo en texto…",
  "Aprendiendo el ritmo de la conversación…",
  "Análisis espectral del audio en curso…",
  "Cada fonema cuenta…",
  "El habla se convierte en historia…",
];

let _txStartTime      = null;
let _timerInterval    = null;
let _msgInterval      = null;
let _lastMsgIdx       = -1;
let _lastMappedPct    = 8;
let _msgRotating      = false;
let _audioDurationSec = 0;
let _estTxSecs        = 0;
let _estDiarSecs      = 0;
let _diarPhaseStart   = null;

function _mapProgress(source, raw) {
  if (source === 'upload') return Math.round((raw / 90) * 8);
  return 8 + Math.round(raw * 0.92);
}

function _fmtTime(ms) {
  const s   = Math.floor(ms / 1000);
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

function startProgressTimer() {
  _txStartTime   = Date.now();
  _lastMappedPct = 8;
  const elapsed  = document.getElementById('timer-elapsed');
  const remaining = document.getElementById('timer-remaining');
  const timerEl  = document.getElementById('progress-timer');
  if (timerEl) timerEl.classList.remove('hidden');
  if (remaining) remaining.textContent = 'calculando…';

  clearInterval(_timerInterval);
  _timerInterval = setInterval(() => {
    if (!_txStartTime) return;
    const ms = Date.now() - _txStartTime;
    if (elapsed) elapsed.textContent = _fmtTime(ms);
    if (remaining && _lastMappedPct > 14) {
      if (_diarPhaseStart) {
        // Fase diarización: estimar dentro de esta fase
        const diarMs  = Date.now() - _diarPhaseStart;
        const diarPct = Math.max(0, _lastMappedPct - 93);
        if (diarPct >= 1) {
          const estDiarTotal = diarMs * 7 / diarPct;
          const estDiarLeft  = Math.max(0, estDiarTotal - diarMs);
          remaining.textContent = '~' + _fmtTime(estDiarLeft) + ' restante (hablantes)';
        } else if (_estDiarSecs > 0 || _audioDurationSec > 0) {
          // Estimación inicial de la fase de hablantes (estimación del backend).
          const estDiarTotal = (_estDiarSecs > 0 ? _estDiarSecs * 1000 : _audioDurationSec * 180);
          const estDiarLeft  = Math.max(0, estDiarTotal - diarMs);
          remaining.textContent = '~' + _fmtTime(estDiarLeft) + ' restante (hablantes)';
        }
        // Sin duración conocida: mantener el texto anterior (no resetear a 'calculando…')
      } else if (_estTxSecs > 0 || _audioDurationSec > 0) {
        // Fase transcripción: usar la estimación del backend (factor por modelo).
        const estTotal = (_estTxSecs > 0 ? _estTxSecs * 1000 : _audioDurationSec * 500);
        const estLeft  = Math.max(0, estTotal - ms);
        remaining.textContent = '~' + _fmtTime(estLeft) + ' restante';
      } else {
        const estTotal = ms * 100 / _lastMappedPct;
        const estLeft  = Math.max(0, estTotal - ms);
        remaining.textContent = '~' + _fmtTime(estLeft) + ' restante';
      }
    }
  }, 1000);
}

function stopProgressTimer() {
  clearInterval(_timerInterval);
  _timerInterval    = null;
  _txStartTime      = null;
  _audioDurationSec = 0;
  _estTxSecs        = 0;
  _estDiarSecs      = 0;
  _diarPhaseStart   = null;
  const timerEl = document.getElementById('progress-timer');
  if (timerEl) timerEl.classList.add('hidden');
}

function startMessageRotation() {
  if (_msgRotating) return;
  _msgRotating = true;

  const el = document.getElementById('progress-msg');
  function showNext() {
    if (!el) return;
    let idx;
    do { idx = Math.floor(Math.random() * _TX_MESSAGES.length); }
    while (idx === _lastMsgIdx && _TX_MESSAGES.length > 1);
    _lastMsgIdx = idx;
    el.style.opacity = '0';
    setTimeout(() => {
      el.textContent  = _TX_MESSAGES[idx];
      el.style.opacity = '1';
    }, 400);
  }

  showNext();
  _msgInterval = setInterval(showNext, 7500);
}

function stopMessageRotation(finalMsg) {
  clearInterval(_msgInterval);
  _msgInterval = null;
  _msgRotating = false;
  const el = document.getElementById('progress-msg');
  if (el && finalMsg) {
    el.style.opacity = '0';
    setTimeout(() => { el.textContent = finalMsg; el.style.opacity = '1'; }, 400);
  }
}

/** Abre el stream SSE de transcripción de un job ya creado (subida o reunión).
 *  startPct: progreso mínimo al conectar (8 por defecto; 50 en reuniones para no retroceder). */
function streamTranscription(jobId, errorSection = 'sec-upload', startPct = 8) {
  State.currentJobId = jobId;
  State.segments = [];
  State.speakerColors = {};
  State.speakerColorIdx = 0;

  if (!_txStartTime) startProgressTimer();
  UI.updateProgress(Math.max(startPct, _mapProgress('sse', 0)), 'Conectando…');

  const source = new EventSource(`/api/transcribe/${jobId}/stream`);

  source.onmessage = e => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }

    switch (data.status) {
      case 'started': {
        if (data.audio_duration) _audioDurationSec = data.audio_duration;
        _estTxSecs   = data.est_tx_secs   || 0;
        _estDiarSecs = data.est_diar_secs || 0;
        const pct = _mapProgress('sse', data.progress || 0);
        _lastMappedPct = pct;
        UI.updateProgress(pct);
        startMessageRotation();
        break;
      }

      case 'loading':
      case 'progress': {
        const pct = _mapProgress('sse', data.progress || 0);
        _lastMappedPct = pct;
        if (pct >= 90 && !_diarPhaseStart) _diarPhaseStart = Date.now();
        UI.updateProgress(pct);
        startMessageRotation();
        break;
      }

      case 'segment': {
        const pct = _mapProgress('sse', data.progress || 50);
        _lastMappedPct = pct;
        if (pct >= 90 && !_diarPhaseStart) _diarPhaseStart = Date.now();
        UI.updateProgress(pct);
        State.segments.push(data.segment);
        UI.addLiveSegment(data.segment);
        break;
      }

      case 'completed':
        source.close();
        State.segments = data.segments || State.segments;
        stopMessageRotation('¡Transcripción completada!');
        stopProgressTimer();
        UI.updateProgress(100);
        setTimeout(() => {
          document.getElementById('retx-bar')?.classList.add('hidden');
          showOnly('sec-transcription', 'sec-ai');
          UI.renderSegments(State.segments);
          loadHistory();
          showToast('Transcripción guardada en ~/Transcripciones', 'success');
        }, 600);
        break;

      case 'error':
        source.close();
        stopMessageRotation();
        stopProgressTimer();
        showToast('Error: ' + (data.message || 'desconocido'), 'error', 5000);
        showOnly(errorSection);
        break;
    }
  };

  source.onerror = () => {
    source.close();
    stopMessageRotation();
    stopProgressTimer();
    if (!State.segments.length) {
      showToast('Se perdió la conexión con el servidor', 'error');
      showOnly(errorSection);
    }
  };
}

// ══════════════════════════════════════════════════
// VISUALIZADOR DE ONDA COMPARTIDO (Meeting + ScreenRec)
// ══════════════════════════════════════════════════
function drawAudioWave(canvasId, arr, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#FAF8F5';
  ctx.fillRect(0, 0, w, h);

  const n = arr.length;
  if (n === 0) return;
  const bw = w / n;

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0,    color + '44');
  grad.addColorStop(0.25, color + 'CC');
  grad.addColorStop(0.5,  color);
  grad.addColorStop(0.75, color + 'CC');
  grad.addColorStop(1,    color + '44');

  ctx.shadowBlur  = 10;
  ctx.shadowColor = color + '66';
  ctx.fillStyle   = grad;

  for (let i = 0; i < n; i++) {
    const v  = Math.min(1, arr[i]);
    const bh = Math.max(2, v * (h - 8));
    ctx.fillRect(i * bw + bw * 0.15, (h - bh) / 2, Math.max(1, bw * 0.7), bh);
  }
  ctx.shadowBlur = 0;
}

// ══════════════════════════════════════════════════
// GRABACIÓN DE REUNIÓN (audio del sistema + micrófono)
// ══════════════════════════════════════════════════
const Meeting = {
  jobId:    null,
  startTime: null,
  timer:    null,
  pollTimer: null,
  paused:   false,
  pausedAccum: 0,
  pauseStart: 0,
  N:        150,
  micWave:  [],
  sysWave:  [],

  _elapsed() {
    let p = this.pausedAccum;
    if (this.paused) p += Date.now() - this.pauseStart;
    return Math.floor((Date.now() - this.startTime - p) / 1000);
  },

  async start() {
    try {
      const res = await fetch('/api/meeting/start', { method: 'POST' });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { detail = (await res.json()).detail || detail; } catch {}
        if (res.status === 403) {
          showToast(detail, 'info', 9000);
        } else {
          showToast('No se pudo iniciar la grabación: ' + detail, 'error', 7000);
        }
        return;
      }
      this.jobId = (await res.json()).job_id;
      this.startTime = Date.now();
      this.paused = false; this.pausedAccum = 0;
      this.micWave = new Array(this.N).fill(0);
      this.sysWave = new Array(this.N).fill(0);
      const pb = document.getElementById('pause-meeting-btn');
      if (pb) pb.innerHTML = ICON_PAUSE + 'Pausar';
      showOnly('sec-meeting');
      this.timer = setInterval(() => this._tick(), 1000);
      this.pollTimer = setInterval(() => this._poll(), 70);
      this._tick();
    } catch (err) {
      showToast('No se pudo iniciar la grabación: ' + err.message, 'error');
    }
  },

  _tick() {
    const el = document.getElementById('meeting-time');
    if (el) el.textContent = fmtTime(this._elapsed());
  },

  async _poll() {
    if (this.jobId) {
      try {
        const r = await fetch(`/api/meeting/levels?job_id=${this.jobId}`);
        if (r.ok) {
          const d = await r.json();
          const micTarget = this.paused ? 0 : (d.mic || 0);
          const micPrev   = this.micWave[this.micWave.length - 1] || 0;
          this.micWave.push(micTarget > micPrev ? micPrev * 0.1 + micTarget * 0.9 : micPrev * 0.75 + micTarget * 0.25);
          const sysTarget = this.paused ? 0 : (d.sys || 0);
          const sysPrev   = this.sysWave[this.sysWave.length - 1] || 0;
          this.sysWave.push(sysTarget > sysPrev ? sysPrev * 0.1 + sysTarget * 0.9 : sysPrev * 0.75 + sysTarget * 0.25);
          if (this.micWave.length > this.N) this.micWave.shift();
          if (this.sysWave.length > this.N) this.sysWave.shift();
        }
      } catch { /* ignore */ }
    }
    this._drawWave('wave-mic', this.micWave, '#C97B5F');
    this._drawWave('wave-sys', this.sysWave, '#8FA68E');
  },

  _drawWave(canvasId, arr, color) { drawAudioWave(canvasId, arr, color); },

  async togglePause() {
    if (!this.jobId) return;
    const btn = document.getElementById('pause-meeting-btn');
    const ep = this.paused ? 'resume' : 'pause';
    try {
      await fetch(`/api/meeting/${ep}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: this.jobId }),
      });
    } catch { /* ignore */ }
    if (this.paused) {
      this.pausedAccum += Date.now() - this.pauseStart;
      this.paused = false;
      if (btn) btn.innerHTML = ICON_PAUSE + 'Pausar';
    } else {
      this.pauseStart = Date.now();
      this.paused = true;
      if (btn) btn.innerHTML = ICON_RESUME + 'Reanudar';
    }
  },

  _stopTimers() {
    clearInterval(this.timer); this.timer = null;
    clearInterval(this.pollTimer); this.pollTimer = null;
  },

  async stop() {
    if (!this.jobId) return;
    this._stopTimers();
    const jobId = this.jobId;
    this.jobId = null;

    const language    = document.getElementById('lang-select').value;
    const modelSize   = document.getElementById('model-select').value;
    const diarize     = document.getElementById('diarize-toggle')?.checked ?? true;
    const numSpeakers = parseInt(document.getElementById('num-speakers-select')?.value || '0', 10);
    State.diarizeEnabled = diarize;

    showOnly('sec-progress');
    UI.updateProgress(40, 'Procesando el audio capturado…');

    try {
      const res = await fetch('/api/meeting/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId, language, model_size: modelSize, diarize, num_speakers: numSpeakers }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { detail = (await res.json()).detail || detail; } catch {}
        showToast('No se pudo procesar la reunión: ' + detail, 'error', 7000);
        showOnly('sec-upload');
        return;
      }
      const data = await res.json();
      // Pantalla de revisión: permite descargar el audio antes de transcribir.
      const stamp = new Date().toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      State.currentFile = null;
      State.currentFilename = `Reunión ${stamp}`;
      State.pendingMeetingJobId = data.job_id;
      State.recordingReady = true;
      showOnly('sec-fileinfo');
      UI.setFileInfo(State.currentFilename, 'Reunión grabada (sistema + micrófono)');
      updateFileinfoControls();
    } catch (err) {
      showToast('Error al detener la grabación: ' + err.message, 'error');
      showOnly('sec-upload');
    }
  },

  async cancel() {
    if (!this.jobId) { showOnly('sec-upload'); return; }
    this._stopTimers();
    const jobId = this.jobId; this.jobId = null;
    try {
      await fetch('/api/meeting/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId }),
      });
    } catch { /* ignore */ }
    showOnly('sec-upload');
    showToast('Grabación cancelada', 'info');
  },
};

// ══════════════════════════════════════════════════
// GRABACIÓN DE PANTALLA CON VÍDEO
// ══════════════════════════════════════════════════
const ScreenRec = {
  jobId: null, startTime: null, timer: null, pollTimer: null,
  paused: false, pausedAccum: 0, pauseStart: 0,
  N: 150, micWave: [], sysWave: [],

  _elapsed() {
    let p = this.pausedAccum;
    if (this.paused) p += Date.now() - this.pauseStart;
    return Math.floor((Date.now() - this.startTime - p) / 1000);
  },

  async start() {
    try {
      const res = await fetch('/api/screenrec/start', { method: 'POST' });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { detail = (await res.json()).detail || detail; } catch {}
        if (res.status === 403) {
          showToast(detail, 'info', 9000);
        } else {
          showToast('No se pudo iniciar la grabación: ' + detail, 'error', 7000);
        }
        return;
      }
      this.jobId = (await res.json()).job_id;
      this.startTime = Date.now();
      this.paused = false; this.pausedAccum = 0;
      this.micWave = new Array(this.N).fill(0);
      this.sysWave = new Array(this.N).fill(0);
      const pb = document.getElementById('pause-screenrec-btn');
      if (pb) pb.innerHTML = ICON_PAUSE + 'Pausar';
      showOnly('sec-screenrec');
      this.timer     = setInterval(() => this._tick(), 1000);
      this.pollTimer = setInterval(() => this._poll(), 70);
      this._tick();
    } catch (err) {
      showToast('No se pudo iniciar la grabación: ' + err.message, 'error');
    }
  },

  _tick() {
    const el = document.getElementById('screenrec-time');
    if (el) el.textContent = fmtTime(this._elapsed());
  },

  async _poll() {
    if (this.jobId) {
      try {
        const r = await fetch(`/api/screenrec/levels?job_id=${this.jobId}`);
        if (r.ok) {
          const d = await r.json();
          const micTarget = this.paused ? 0 : (d.mic || 0);
          const micPrev   = this.micWave[this.micWave.length - 1] || 0;
          this.micWave.push(micTarget > micPrev ? micPrev * 0.1 + micTarget * 0.9 : micPrev * 0.75 + micTarget * 0.25);
          const sysTarget = this.paused ? 0 : (d.sys || 0);
          const sysPrev   = this.sysWave[this.sysWave.length - 1] || 0;
          this.sysWave.push(sysTarget > sysPrev ? sysPrev * 0.1 + sysTarget * 0.9 : sysPrev * 0.75 + sysTarget * 0.25);
          if (this.micWave.length > this.N) this.micWave.shift();
          if (this.sysWave.length > this.N) this.sysWave.shift();
        }
      } catch { /* ignore */ }
    }
    this._drawWave('screenrec-wave-mic', this.micWave, '#C97B5F');
    this._drawWave('screenrec-wave-sys', this.sysWave, '#8FA68E');
  },

  _drawWave(canvasId, arr, color) { drawAudioWave(canvasId, arr, color); },

  async togglePause() {
    if (!this.jobId) return;
    const btn = document.getElementById('pause-screenrec-btn');
    const ep  = this.paused ? 'resume' : 'pause';
    try {
      await fetch(`/api/screenrec/${ep}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: this.jobId }),
      });
    } catch { /* ignore */ }
    if (this.paused) {
      this.pausedAccum += Date.now() - this.pauseStart;
      this.paused = false;
      if (btn) btn.innerHTML = ICON_PAUSE + 'Pausar';
    } else {
      this.pauseStart = Date.now();
      this.paused = true;
      if (btn) btn.innerHTML = ICON_RESUME + 'Reanudar';
    }
  },

  _stopTimers() {
    clearInterval(this.timer); this.timer = null;
    clearInterval(this.pollTimer); this.pollTimer = null;
  },

  async stop() {
    if (!this.jobId) return;
    this._stopTimers();
    const jobId = this.jobId;
    this.jobId = null;

    const language    = document.getElementById('lang-select').value;
    const modelSize   = document.getElementById('model-select').value;
    const diarize     = document.getElementById('diarize-toggle')?.checked ?? true;
    const numSpeakers = parseInt(document.getElementById('num-speakers-select')?.value || '0', 10);
    State.diarizeEnabled = diarize;

    showOnly('sec-progress');
    UI.updateProgress(40, 'Procesando vídeo y audio capturados…');

    try {
      const res = await fetch('/api/screenrec/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId, language, model_size: modelSize, diarize, num_speakers: numSpeakers }),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { detail = (await res.json()).detail || detail; } catch {}
        showToast('No se pudo procesar la grabación: ' + detail, 'error', 7000);
        showOnly('sec-upload');
        return;
      }
      const data = await res.json();
      const stamp = new Date().toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      State.currentFile = null;
      State.currentFilename = `Pantalla ${stamp}`;
      State.pendingMeetingJobId = data.job_id;
      State.pendingVideoJobId   = data.has_video ? data.job_id : null;
      State.recordingReady = true;
      showOnly('sec-fileinfo');
      UI.setFileInfo(State.currentFilename, 'Grabación de pantalla (vídeo + audio)');
      updateFileinfoControls();
    } catch (err) {
      showToast('Error al detener la grabación: ' + err.message, 'error');
      showOnly('sec-upload');
    }
  },

  async cancel() {
    if (!this.jobId) { showOnly('sec-upload'); return; }
    this._stopTimers();
    const jobId = this.jobId; this.jobId = null;
    try {
      await fetch('/api/screenrec/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId }),
      });
    } catch { /* ignore */ }
    showOnly('sec-upload');
    showToast('Grabación cancelada', 'info');
  },
};

// ══════════════════════════════════════════════════
// REUNIÓN WEB (grabación en el navegador del sistema)
// ══════════════════════════════════════════════════
const WebMeeting = {
  sessionId:    null,
  sseSource:    null,
  startTime:    null,
  timerInterval: null,
  _diarize:     false,
  _numSpeakers: 0,

  _elapsed() {
    return this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
  },

  async start({ diarize = false, numSpeakers = 0 } = {}) {
    this._diarize     = diarize;
    this._numSpeakers = numSpeakers;
    const language  = document.getElementById('lang-select').value;
    const modelSize = document.getElementById('model-select').value;

    try {
      const res = await fetch(
        `/api/open-meeting-booth?lang=${language}&model=${modelSize}` +
        `&diarize=${diarize ? 'true' : 'false'}&speakers=${numSpeakers}`
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      this.sessionId = data.session_id;
    } catch (err) {
      showToast('No se pudo abrir la cabina de grabación: ' + err.message, 'error');
      return;
    }

    this.startTime = Date.now();
    const pb = document.getElementById('pause-meeting-btn');
    if (pb) pb.innerHTML = ICON_PAUSE + 'Pausar';

    const stopBtn = document.getElementById('stop-webmeeting-btn');
    if (stopBtn) { stopBtn.disabled = false; stopBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2"/></svg> Detener y transcribir'; }

    showOnly('sec-webmeeting');
    this.timerInterval = setInterval(() => {
      const el = document.getElementById('webmeeting-time');
      if (el) el.textContent = fmtTime(this._elapsed());
    }, 1000);

    this._listenForCompletion();
  },

  _listenForCompletion() {
    if (!this.sessionId) return;
    this.sseSource = new EventSource(`/api/meeting-booth/ready/${this.sessionId}`);

    this.sseSource.onmessage = e => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      this.sseSource.close();
      this.sseSource = null;
      clearInterval(this.timerInterval);
      this.timerInterval = null;
      const sid = this.sessionId;
      this.sessionId = null;

      if (data.job_id) {
        // Sincronizar el header global con los ajustes que eligió el usuario en el setup
        State.diarizeEnabled = this._diarize;
        const diarizeToggle = document.getElementById('diarize-toggle');
        const numSpkSelect  = document.getElementById('num-speakers-select');
        if (diarizeToggle) {
          diarizeToggle.checked = this._diarize;
          diarizeToggle.dispatchEvent(new Event('change'));
        }
        if (numSpkSelect) numSpkSelect.value = String(this._numSpeakers || 0);

        const stamp = new Date().toLocaleString('es-ES', {
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        });
        State.currentFile = null;
        State.currentFilename = `Audio pestaña ${stamp}`;
        State.pendingMeetingJobId = data.job_id;
        State.recordingReady = true;
        showOnly('sec-fileinfo');
        UI.setFileInfo(State.currentFilename, 'Grabada en el navegador (audio de pestaña)');
        updateFileinfoControls();
      } else if (!data.error || data.error === 'cancelled') {
        showOnly('sec-upload');
      } else {
        showToast('Error en la cabina de grabación: ' + data.error, 'error');
        showOnly('sec-upload');
      }
    };

    this.sseSource.onerror = () => {
      if (!this.sessionId) return; // ya cancelado
      this.sseSource?.close();
      this.sseSource = null;
      clearInterval(this.timerInterval);
      this.timerInterval = null;
      this.sessionId = null;
      showToast('Se perdió la conexión con la cabina de grabación', 'error');
      showOnly('sec-upload');
    };
  },

  async requestStop() {
    if (!this.sessionId) return;
    const btn = document.getElementById('stop-webmeeting-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Deteniendo…'; }
    try {
      await fetch(`/api/meeting-booth/request-stop/${this.sessionId}`, { method: 'POST' });
    } catch { /* ignore — el booth lo detectará en el siguiente poll */ }
  },

  async cancel() {
    clearInterval(this.timerInterval);
    this.timerInterval = null;
    this.sseSource?.close();
    this.sseSource = null;
    const sid = this.sessionId;
    this.sessionId = null;
    if (sid) {
      try {
        await fetch(`/api/meeting-booth/cancel/${sid}`, { method: 'POST' });
      } catch { /* ignore */ }
    }
    showOnly('sec-upload');
  },
};

// ══════════════════════════════════════════════════
// RE-TRANSCRIPCIÓN (mismo audio, distintos ajustes)
// ══════════════════════════════════════════════════
async function retranscribe() {
  if (!State.currentJobId) {
    showToast('No hay transcripción activa para repetir', 'error');
    return;
  }

  const val         = document.getElementById('retx-speakers')?.value || 'nodiar';
  const diarize     = val !== 'nodiar';
  const numSpeakers = diarize ? (parseInt(val, 10) || 0) : 0;
  State.diarizeEnabled = diarize;
  const language    = document.getElementById('lang-select').value;
  const modelSize   = document.getElementById('model-select').value;

  // Cerrar la barra de config
  document.getElementById('retx-bar')?.classList.add('hidden');

  showOnly('sec-progress');
  startProgressTimer();
  UI.updateProgress(0, 'Preparando re-transcripción…');
  document.getElementById('live-segments').innerHTML = '';

  try {
    const res = await fetch('/api/retranscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id:       State.currentJobId,
        language,
        model_size:   modelSize,
        diarize,
        num_speakers: numSpeakers,
      }),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`;
      showToast('No se pudo re-transcribir: ' + detail, 'error', 6000);
      showOnly('sec-transcription', 'sec-ai');
      return;
    }
    const { job_id: newJobId } = await res.json();
    streamTranscription(newJobId, 'sec-transcription');
  } catch (err) {
    showToast('Error al re-transcribir: ' + err.message, 'error');
    showOnly('sec-transcription', 'sec-ai');
  }
}

// ══════════════════════════════════════════════════
// AI PROCESSING
// ══════════════════════════════════════════════════
const ACTION_META = {
  clean:   { label: 'Texto limpio',       icon: '✨' },
  summary: { label: 'Resumen ejecutivo',  icon: '📋' },
  minutes: { label: 'Acta de reunión',    icon: '📝' },
};

// Estado de Ollama/modelo de IA — controla si los botones "Procesar con IA"
// están activos, y el botón de instalación/descarga bajo demanda dentro del
// propio panel (nada de esto se comprueba durante la instalación de la app).
const AIStatus = {
  state: 'checking',   // 'checking' | 'ready' | 'no_model' | 'not_running'
  _pollTimer: null,

  async refresh() {
    try {
      const res = await fetch('/api/ollama/status');
      const data = await res.json();
      this.state = data.state;
      const tag = document.getElementById('ai-model-tag');
      if (tag && data.model) tag.textContent = data.model;
    } catch {
      this.state = 'not_running';
    }
    this._render();
  },

  _render() {
    const ready = this.state === 'ready';
    document.querySelectorAll('.ai-btn').forEach(b => { b.disabled = !ready; });

    const box  = document.getElementById('ai-unavailable');
    const text = document.getElementById('ai-unavailable-text');
    const btn  = document.getElementById('ai-install-btn');
    if (!box || !text || !btn) return;

    box.classList.toggle('hidden', ready);
    if (ready) return;

    if (this.state === 'not_running') {
      text.textContent = 'Ollama no está instalado o no está corriendo. Las funciones de IA (Limpiar, Resumen, Acta) usan un modelo de lenguaje local, 100% en tu PC.';
      btn.textContent = 'Instalar Ollama + modelo de IA';
      btn.dataset.mode = 'install';
    } else {
      text.textContent = 'Ollama está instalado, pero falta descargar el modelo de IA.';
      btn.textContent = 'Descargar modelo de IA';
      btn.dataset.mode = 'model-only';
    }
  },

  onInstallClick() {
    const mode = document.getElementById('ai-install-btn')?.dataset.mode;
    const msg = mode === 'install'
      ? 'Se descargará el instalador de Ollama y el modelo de IA (gemma4:e2b, ~7,2 GB): unos 8 GB en total, y puede tardar varios minutos según tu conexión. ¿Continuar?'
      : 'Se descargará el modelo de IA (gemma4:e2b, ~7,2 GB). Puede tardar varios minutos según tu conexión. ¿Continuar?';
    showConfirmToast(msg, 'Descargar', () => {
      if (mode === 'install') this._installOllama();
      else this._pullModel();
    });
  },

  async _installOllama() {
    this._showProgress('Descargando el instalador de Ollama…');
    try {
      await window.transcriptorIA.installOllama();
    } catch (err) {
      this._hideProgress();
      showToast('No se pudo iniciar la instalación de Ollama: ' + err.message, 'error');
      return;
    }
    this._updateProgress(null, 'Se ha abierto el instalador de Ollama — complétalo y espera aquí…');
    this._pollUntilInstalled(Date.now());
  },

  _pollUntilInstalled(startedAt) {
    clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(async () => {
      await this.refresh();
      if (this.state === 'ready') { this._hideProgress(); return; }
      if (this.state === 'no_model') { await this._pullModel(); return; }
      if (Date.now() - startedAt > 10 * 60 * 1000) {
        this._hideProgress();
        showToast('Sigue sin detectarse Ollama. Termina el instalador y vuelve a intentarlo desde este panel.', 'info', 8000);
        return;
      }
      this._pollUntilInstalled(startedAt);
    }, 4000);
  },

  async _pullModel() {
    this._showProgress('Descargando modelo de IA…');
    try {
      const res = await fetch('/api/ollama/pull-model', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.slice(6));
          if (data.error) throw new Error(data.error);
          if (data.total && data.completed) {
            const pct = Math.min(100, Math.round((data.completed / data.total) * 100));
            this._updateProgress(pct, `Descargando modelo de IA… ${pct}%`);
          } else if (data.status) {
            this._updateProgress(null, data.status);
          }
          if (data.done) {
            this._hideProgress();
            await this.refresh();
            if (this.state === 'ready') showToast('Modelo de IA listo', 'success');
          }
        }
      }
    } catch (err) {
      this._hideProgress();
      showToast('Error al descargar el modelo de IA: ' + err.message, 'error');
    }
  },

  _showProgress(msg) {
    document.getElementById('ai-install-progress')?.classList.remove('hidden');
    this._updateProgress(0, msg);
  },
  _updateProgress(pct, msg) {
    const bar   = document.getElementById('ai-install-progress-bar');
    const pctEl = document.getElementById('ai-install-progress-pct');
    const msgEl = document.getElementById('ai-install-progress-msg');
    if (pct != null && bar)   bar.style.width = pct + '%';
    if (pct != null && pctEl) pctEl.textContent = pct + '%';
    if (msgEl) msgEl.textContent = msg;
  },
  _hideProgress() {
    document.getElementById('ai-install-progress')?.classList.add('hidden');
  },
};

async function processWithAI(action) {
  if (AIStatus.state !== 'ready') {
    showToast('Las funciones de IA no están disponibles todavía.', 'error');
    return;
  }

  const plainText = segmentsToPlainText(State.segments);
  if (!plainText.trim()) {
    showToast('No hay transcripción para procesar', 'error');
    return;
  }

  // Show results section and clear
  showSection('sec-ai-results');
  const body = document.getElementById('ai-result-body');
  const thinking = document.getElementById('ai-thinking');
  const label = document.getElementById('ai-res-label');
  const icon = document.getElementById('ai-res-icon');

  const meta = ACTION_META[action] || ACTION_META.clean;
  label.textContent = meta.label;
  icon.textContent = meta.icon;
  body.textContent = '';
  thinking.classList.remove('hidden');

  // Disable AI buttons while processing
  document.querySelectorAll('.ai-btn').forEach(b => b.classList.add('loading'));

  State.aiResult = { action, label: meta.label, text: '' };

  try {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: plainText, action }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.chunk) {
            State.aiResult.text += data.chunk;
            body.textContent = State.aiResult.text;
            body.scrollTop = body.scrollHeight;
          }
          if (data.error) throw new Error(data.error);
          if (data.done) thinking.classList.add('hidden');
        } catch (parseErr) {
          if (parseErr.message !== 'Unexpected end of JSON input') {
            throw parseErr;
          }
        }
      }
    }
  } catch (err) {
    thinking.classList.add('hidden');
    const hint = AIStatus.state === 'no_model'
      ? 'Falta descargar el modelo de IA — vuelve al panel "Procesar con IA" para hacerlo.'
      : 'Ollama no está disponible ahora mismo — vuelve al panel "Procesar con IA" para instalarlo.';
    body.textContent = 'Error al procesar con IA: ' + err.message + '\n\n' + hint;
    showToast('Error con la IA: ' + err.message, 'error', 5000);
    AIStatus.refresh();
  } finally {
    document.querySelectorAll('.ai-btn').forEach(b => b.classList.remove('loading'));
    thinking.classList.add('hidden');
  }
}

// ══════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════
async function doExport(format, useAiResult) {
  const segs = State.segments;
  const processed = useAiResult ? State.aiResult.text : '';
  const actionLabel = useAiResult ? State.aiResult.label : '';
  const filename = State.currentFilename.replace(/\.[^.]+$/, '') || 'transcripcion';

  try {
    const res = await fetch(`/api/export/${format}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments: segs, processed, action_label: actionLabel, filename, show_timestamps: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const blob = await res.blob();
    downloadBlob(blob, `${filename}.${format}`);
    showToast(`Exportado como ${filename}.${format}`, 'success');
  } catch (err) {
    showToast('Error al exportar: ' + err.message, 'error');
  }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(
    () => showToast('Copiado al portapapeles', 'success'),
    () => showToast('No se pudo copiar', 'error'),
  );
}

// ══════════════════════════════════════════════════
// HISTORY
// ══════════════════════════════════════════════════
async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    if (!res.ok) return;
    State.historyItems = await res.json();
    UI.renderHistory(State.historyItems);
  } catch { /* server might not be ready yet */ }
}

async function loadHistoryItem(id) {
  try {
    const res = await fetch(`/api/history/${id}`);
    if (!res.ok) { showToast('No se pudo cargar la transcripción', 'error'); return; }
    const data = await res.json();

    State.segments = data.segments || [];
    State.currentFilename = data.filename || 'transcripcion';
    State.currentJobId = data.id;
    State.activeHistoryId = id;
    State.aiResult = { action: '', label: '', text: '' };
    State.diarizeEnabled = true;

    // Update active state in sidebar
    document.querySelectorAll('.history-item').forEach(el => {
      el.classList.toggle('active', el.dataset.historyId === id);
    });

    showOnly('sec-transcription', 'sec-ai');
    hideSection('sec-ai-results');
    UI.renderSegments(State.segments);

    showToast(`Cargado: ${data.filename || 'transcripcion'}`, 'info');
  } catch (err) {
    showToast('Error al cargar: ' + err.message, 'error');
  }
}

// ── Menú de opciones (⋮) de cada elemento del historial ──────────
function closeHistoryMenu() {
  document.querySelectorAll('.history-menu').forEach(m => m.remove());
  document.removeEventListener('click', closeHistoryMenu);
}

function openHistoryMenu(btn, id, pinned) {
  const existing = document.querySelector('.history-menu');
  closeHistoryMenu();
  if (existing && existing.dataset.id === id) return; // toggle

  const menu = document.createElement('div');
  menu.className = 'history-menu';
  menu.dataset.id = id;
  menu.innerHTML = `
    <button class="history-menu-item" data-act="pin">
      <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M14 4v5l2 3v2h-4v5l-1 1-1-1v-5H6v-2l2-3V4H7V2h8v2z"/></svg>
      ${pinned ? 'Desanclar' : 'Anclar'}
    </button>
    <button class="history-menu-item danger" data-act="del">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      Borrar
    </button>`;
  document.body.appendChild(menu);

  const r = btn.getBoundingClientRect();
  menu.style.top  = `${r.bottom + 4}px`;
  menu.style.left = `${Math.min(r.left, window.innerWidth - 160)}px`;

  menu.querySelector('[data-act="pin"]').addEventListener('click', e => {
    e.stopPropagation(); closeHistoryMenu(); togglePinHistory(id, !pinned);
  });
  menu.querySelector('[data-act="del"]').addEventListener('click', e => {
    e.stopPropagation(); closeHistoryMenu(); deleteHistoryItem(id);
  });

  // Cerrar al hacer clic fuera (en el siguiente tick para no auto-cerrarse)
  setTimeout(() => document.addEventListener('click', closeHistoryMenu), 0);
}

async function togglePinHistory(id, pinned) {
  try {
    const res = await fetch(`/api/history/${id}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await loadHistory();
    showToast(pinned ? 'Anclado' : 'Desanclado', 'success');
  } catch (err) {
    showToast('No se pudo anclar: ' + err.message, 'error');
  }
}

async function deleteHistoryItem(id) {
  try {
    const res = await fetch(`/api/history/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (State.activeHistoryId === id) {
      State.activeHistoryId = null;
      State.segments = [];
      showOnly('sec-upload');
    }
    await loadHistory();
    showToast('Transcripción borrada', 'success');
  } catch (err) {
    showToast('No se pudo borrar: ' + err.message, 'error');
  }
}

function deleteAllHistory() {
  if (!State.historyItems || !State.historyItems.length) {
    showToast('El historial ya está vacío', 'info');
    return;
  }
  showConfirmToast(
    `¿Seguro que quieres borrar las ${State.historyItems.length} transcripciones del historial?`,
    'Borrar todo',
    async () => {
      try {
        const res = await fetch('/api/history', { method: 'DELETE' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        State.activeHistoryId = null;
        State.segments = [];
        showOnly('sec-upload');
        await loadHistory();
        showToast('Historial borrado', 'success');
      } catch (err) {
        showToast('No se pudo borrar: ' + err.message, 'error');
      }
    }
  );
}

// ══════════════════════════════════════════════════
// TTS — Narrador de Voz
// ══════════════════════════════════════════════════
const TTS = {
  voices:             { predefined: [], custom: [] },
  currentJobId:       null,
  cloneBlob:          null,
  cloneExt:           'webm',
  cloneRecorder:      null,
  cloneChunks:        [],
  cloneStream:        null,
  cloneTimer:         null,
  cloneStartTime:     null,
  _previewingVoiceId: null,   // voz cuyo preview está sonando ahora mismo

  async loadVoices() {
    try {
      const res = await fetch('/api/tts/voices');
      if (!res.ok) return;
      this.voices = await res.json();
      this._renderVoiceLists();
      this._populateVoiceSelect();
    } catch { /* servidor aún no listo */ }
  },

  openVoices() {
    showOnly('sec-tts-voices');
    this.loadVoices();
    this._switchTab('predefined');
  },

  openNarrate() {
    showOnly('sec-tts-narrate');
    this._populateVoiceSelect();
    this._syncLanguageToVoice();
    this.loadProfiles();
    this.loadSettings();
    this._resetNarratePanel();
    // Empieza a cargar el modelo en segundo plano mientras la usuaria escribe.
    // (Con ElevenLabs el backend lo ignora: no hay modelo local que cargar.)
    fetch('/api/tts/preload', { method: 'POST' }).catch(() => {});
    this._checkModelStatus();
  },

  // Carga el motor activo y la config de ElevenLabs desde el backend.
  async loadSettings() {
    try {
      const res = await fetch('/api/tts/settings');
      if (!res.ok) return;
      const s = await res.json();
      this.settings = s;
      const engineSel = document.getElementById('narrate-engine');
      if (engineSel) engineSel.value = s.engine || 'chatterbox';

      // Poblar el selector de modelo de ElevenLabs (una vez).
      const modelSel = document.getElementById('el-model');
      if (modelSel && s.elevenlabs?.models) {
        modelSel.innerHTML = Object.entries(s.elevenlabs.models)
          .map(([id, label]) => `<option value="${escHtml(id)}">${escHtml(label)}</option>`).join('');
        modelSel.value = s.elevenlabs.model;
      }
      // Si ya hay clave guardada, mostrar pista (no la clave completa).
      const statusEl = document.getElementById('el-key-status');
      if (statusEl) {
        if (s.elevenlabs?.configured) {
          statusEl.textContent = `✓ Clave configurada (${s.elevenlabs.key_hint})`;
          statusEl.className = 'el-key-status ok';
        } else {
          statusEl.textContent = '';
          statusEl.className = 'el-key-status';
        }
      }
      this._toggleEngineUI(s.engine || 'chatterbox', s.elevenlabs?.configured);
    } catch { /* servidor aún no listo */ }
  },

  // Muestra/oculta el bloque de config de ElevenLabs según el motor elegido.
  _toggleEngineUI(engine, configured) {
    const cfg = document.getElementById('elevenlabs-config');
    if (cfg) cfg.classList.toggle('hidden', engine !== 'elevenlabs');
    // Si es ElevenLabs y aún no hay clave, dejar el bloque visible para configurarla.
    if (engine === 'elevenlabs' && !configured && cfg) cfg.classList.remove('hidden');
  },

  // Cambia el motor activo (se guarda al instante en el backend).
  async _onEngineChange() {
    const engine = document.getElementById('narrate-engine')?.value || 'chatterbox';
    const configured = !!this.settings?.elevenlabs?.configured;
    this._toggleEngineUI(engine, configured);
    try {
      const res = await fetch('/api/tts/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine }),
      });
      if (res.ok) {
        this.settings = (await res.json()).settings;
        showToast(engine === 'elevenlabs' ? 'Motor: ElevenLabs' : 'Motor: Chatterbox (local)', 'success', 2500);
      } else {
        const d = (await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`;
        showToast('No se pudo cambiar el motor: ' + d, 'error');
      }
    } catch (e) {
      showToast('No se pudo cambiar el motor: ' + e.message, 'error');
    }
    // Re-evaluar el estado (con EL no hay descarga de modelo).
    if (engine === 'chatterbox') fetch('/api/tts/preload', { method: 'POST' }).catch(() => {});
    this._checkModelStatus();
    // Los valores de slider (velocidad/estabilidad/similitud) del perfil difieren
    // entre motores — reaplicar para el motor recién elegido.
    const profSel = document.getElementById('narrate-profile');
    if (profSel?.value) this._applyProfileToSliders(profSel.value);
  },

  // Guarda y valida la API key + modelo de ElevenLabs.
  async saveElevenLabsSettings() {
    const keyInput = document.getElementById('el-api-key');
    const modelSel = document.getElementById('el-model');
    const statusEl = document.getElementById('el-key-status');
    const btn      = document.getElementById('el-save-btn');

    const key   = keyInput?.value.trim() || '';
    const model = modelSel?.value || undefined;

    const body = { engine: 'elevenlabs', elevenlabs_model: model };
    if (key) body.elevenlabs_api_key = key;

    if (statusEl) { statusEl.textContent = 'Validando…'; statusEl.className = 'el-key-status'; }
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/api/tts/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

      this.settings = data.settings;
      if (keyInput) keyInput.value = '';               // no retener la clave en el DOM
      document.getElementById('narrate-engine').value = 'elevenlabs';
      if (statusEl) {
        const acc = data.account;
        const rem = acc && acc.characters_remaining != null
          ? ` · ${acc.characters_remaining.toLocaleString('es')} créditos restantes` : '';
        statusEl.textContent = `✓ Clave válida (plan ${acc?.tier || '—'})${rem}`;
        statusEl.className = 'el-key-status ok';
      }
      showToast('ElevenLabs configurado correctamente', 'success');
      this._checkModelStatus();
    } catch (e) {
      if (statusEl) { statusEl.textContent = '✕ ' + e.message; statusEl.className = 'el-key-status err'; }
      showToast('ElevenLabs: ' + e.message, 'error', 6000);
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  // Rellena el selector de perfiles desde el backend (una sola vez) y aplica
  // los valores de slider (velocidad/estabilidad/similitud) del perfil activo.
  _profileParams: {},

  async loadProfiles() {
    const sel = document.getElementById('narrate-profile');
    if (!sel) return;
    if (sel.dataset.loaded !== '1') {
      try {
        const res = await fetch('/api/tts/profiles');
        if (!res.ok) return;
        const profiles = await res.json();
        if (!Array.isArray(profiles) || !profiles.length) return;
        this._profileParams = {};
        profiles.forEach(p => { this._profileParams[p.id] = p.sliders || {}; });
        sel.innerHTML = profiles.map(p =>
          `<option value="${escHtml(p.id)}" title="${escHtml(p.description || '')}">${escHtml(p.name)}</option>`
        ).join('');
        sel.value = 'normal';                 // perfil por defecto
        sel.dataset.loaded = '1';
      } catch { return; /* servidor aún no listo */ }
    }
    this._applyProfileToSliders(sel.value);
  },

  // Coloca los 3 sliders (velocidad/estabilidad/similitud) según los valores que
  // implica el perfil elegido para el motor activo (Chatterbox o ElevenLabs).
  _applyProfileToSliders(profileId) {
    const params = this._profileParams[profileId];
    if (!params) return;
    const engine = document.getElementById('narrate-engine')?.value || 'chatterbox';
    const s = params[engine] || params.chatterbox;
    if (!s) return;
    const speedEl = document.getElementById('narrate-speed');
    const stabEl  = document.getElementById('narrate-stability');
    const simEl   = document.getElementById('narrate-similarity');
    if (speedEl) speedEl.value = s.speed;
    if (stabEl)  stabEl.value  = s.stability;
    if (simEl)   simEl.value   = s.similarity;
    this._updateSliderReadouts();
  },

  // Actualiza los textos "1.05×" / "62%" junto a cada slider.
  _updateSliderReadouts() {
    const speedEl = document.getElementById('narrate-speed');
    const stabEl  = document.getElementById('narrate-stability');
    const simEl   = document.getElementById('narrate-similarity');
    const speedVal = document.getElementById('narrate-speed-val');
    const stabVal  = document.getElementById('narrate-stability-val');
    const simVal   = document.getElementById('narrate-similarity-val');
    if (speedEl && speedVal) speedVal.textContent = parseFloat(speedEl.value).toFixed(2) + '×';
    if (stabEl && stabVal)   stabVal.textContent  = Math.round(parseFloat(stabEl.value) * 100) + '%';
    if (simEl && simVal)     simVal.textContent   = Math.round(parseFloat(simEl.value) * 100) + '%';
  },

  // Ajusta el selector de idioma al idioma por defecto de la voz elegida.
  // Es solo una sugerencia: la usuaria puede cambiarlo (p. ej. voz en español → inglés).
  _syncLanguageToVoice() {
    const voiceSel = document.getElementById('narrate-voice');
    const langSel  = document.getElementById('narrate-language');
    if (!voiceSel || !langSel) return;
    const all = [...this.voices.predefined, ...this.voices.custom];
    const voice = all.find(v => v.id === voiceSel.value);
    if (voice && (voice.language === 'es' || voice.language === 'en')) {
      langSel.value = voice.language;
    }
  },

  _switchTab(tabName) {
    document.querySelectorAll('.voice-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.voice-tab-content').forEach(el => {
      el.classList.toggle('hidden', el.id !== `tab-${tabName}`);
    });
  },

  _renderVoiceLists() {
    const predEl  = document.getElementById('predefined-voices-list');
    const custEl  = document.getElementById('custom-voices-list');

    if (predEl) {
      if (!this.voices.predefined.length) {
        predEl.innerHTML = `<div class="voices-empty">
          <p>No hay voces predefinidas.</p>
          <p class="voices-empty-sub">Ejecuta <code>bash setup_voices.sh</code> desde la carpeta del proyecto para generarlas.</p>
        </div>`;
      } else {
        predEl.innerHTML = this.voices.predefined.map(v => this._voiceCard(v, false)).join('');
        this._attachCardListeners(predEl, false);
      }
    }

    if (custEl) {
      if (!this.voices.custom.length) {
        custEl.innerHTML = '<div class="voices-empty"><p>Aún no tienes voces clonadas.</p></div>';
      } else {
        custEl.innerHTML = this.voices.custom.map(v => this._voiceCard(v, true)).join('');
        this._attachCardListeners(custEl, true);
      }
    }
  },

  _voiceCard(v, canDelete) {
    const lang = v.language === 'es' ? 'Español' : 'English';
    const genderIcon = v.gender === 'female' ? '♀' : v.gender === 'male' ? '♂' : '✦';
    const id = escHtml(v.id);
    return `<div class="voice-card">
      <div class="voice-card-info">
        <div class="voice-card-name">${escHtml(v.name)}</div>
        <div class="voice-card-meta">
          <span class="voice-badge">${lang}</span>
          <span class="voice-badge">${genderIcon}</span>
        </div>
      </div>
      <div class="voice-card-actions">
        <button class="btn btn-sm voice-preview-btn" data-voice-id="${id}" title="Escuchar voz de referencia">
          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><polygon points="6 4 20 12 6 20 6 4"/></svg>
          Escuchar
        </button>
        ${canDelete ? `<button class="btn btn-sm voice-delete-btn" data-voice-id="${id}" title="Eliminar voz">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          Eliminar
        </button>` : ''}
      </div>
    </div>`;
  },

  _attachCardListeners(container, canDelete) {
    container.querySelectorAll('.voice-preview-btn').forEach(btn => {
      btn.addEventListener('click', () => TTS.previewVoice(btn.dataset.voiceId, btn));
    });
    if (canDelete) {
      container.querySelectorAll('.voice-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => TTS.deleteVoice(btn.dataset.voiceId));
      });
    }
  },

  _populateVoiceSelect() {
    const sel = document.getElementById('narrate-voice');
    if (!sel) return;
    const all = [...this.voices.predefined, ...this.voices.custom];
    if (!all.length) {
      sel.innerHTML = '<option value="">Sin voces disponibles</option>';
      return;
    }
    const parts = [];
    if (this.voices.predefined.length) {
      parts.push('<optgroup label="Voces predefinidas">');
      this.voices.predefined.forEach(v => {
        parts.push(`<option value="${escHtml(v.id)}">${escHtml(v.name)}</option>`);
      });
      parts.push('</optgroup>');
    }
    if (this.voices.custom.length) {
      parts.push('<optgroup label="Mis voces clonadas">');
      this.voices.custom.forEach(v => {
        parts.push(`<option value="${escHtml(v.id)}">${escHtml(v.name)}</option>`);
      });
      parts.push('</optgroup>');
    }
    const prev = sel.value;
    sel.innerHTML = parts.join('');
    if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
  },

  previewVoice(voiceId, btn) {
    const audio = document.getElementById('preview-audio');
    if (!audio) return;

    // Misma voz ya sonando → parar
    if (this._previewingVoiceId === voiceId) {
      audio.pause();
      audio.currentTime = 0;
      this._resetPreviewBtn(btn);
      this._previewingVoiceId = null;
      return;
    }

    // Otra voz sonando → pararla y restaurar su botón
    if (this._previewingVoiceId) {
      audio.pause();
      audio.currentTime = 0;
      const prevBtn = document.querySelector(
        `.voice-preview-btn[data-voice-id="${CSS.escape(this._previewingVoiceId)}"]`
      );
      if (prevBtn) this._resetPreviewBtn(prevBtn);
      this._previewingVoiceId = null;
    }

    // Reproducir nueva voz
    audio.src = `/api/tts/preview/${encodeURIComponent(voiceId)}`;
    audio.load();
    audio.play().catch(e => showToast('No se pudo reproducir: ' + e.message, 'error'));
    this._previewingVoiceId = voiceId;
    this._setPreviewBtnPlaying(btn);

    const reset = () => {
      this._resetPreviewBtn(btn);
      this._previewingVoiceId = null;
    };
    audio.addEventListener('ended', reset, { once: true });
    audio.addEventListener('error', reset, { once: true });
  },

  _setPreviewBtnPlaying(btn) {
    if (!btn) return;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> Detener`;
    btn.title = 'Detener reproducción';
  },

  _resetPreviewBtn(btn) {
    if (!btn) return;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><polygon points="6 4 20 12 6 20 6 4"/></svg> Escuchar`;
    btn.title = 'Escuchar voz de referencia';
  },

  async deleteVoice(voiceId) {
    showConfirmToast(
      '¿Eliminar esta voz clonada? No se puede deshacer.',
      'Eliminar',
      async () => {
        try {
          const res = await fetch(`/api/tts/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          showToast('Voz eliminada', 'success');
          await this.loadVoices();
        } catch (err) {
          showToast('Error al eliminar: ' + err.message, 'error');
        }
      }
    );
  },

  async _checkModelStatus() {
    const notice = document.getElementById('narrate-model-notice');
    const msg    = document.getElementById('narrate-model-msg');
    // Evita varios sondeos solapados si se reabre el panel.
    this._modelPollToken = (this._modelPollToken || 0) + 1;
    const token = this._modelPollToken;

    const poll = async () => {
      if (token !== this._modelPollToken) return;   // cancelado por otra apertura
      try {
        const res = await fetch('/api/tts/model-status');
        if (!res.ok) return;
        const data = await res.json();
        if (data.ready) {
          notice?.classList.add('hidden');
          return;                                    // listo: dejar de sondear
        }
        if (data.error) {
          notice?.classList.remove('hidden');
          if (msg) msg.textContent = 'Error al cargar el modelo: ' + data.error;
          return;                                    // error: dejar de sondear
        }
        // Carga rápida en memoria (modelo ya descargado): no molestamos con un
        // aviso — el botón "Generar" ya espera solo si hiciera falta. Solo
        // avisamos de la primera descarga, que sí es larga (~1,8 GB).
        if (data.cached) {
          notice?.classList.add('hidden');
        } else {
          notice?.classList.remove('hidden');
          if (msg) msg.textContent = 'Descargando el modelo de voz por primera vez (~1,8 GB). Solo ocurre una vez.';
        }
      } catch { /* servidor aún no listo */ }
      setTimeout(poll, 1500);                        // seguir sondeando hasta ready
    };
    poll();
  },

  _resetNarratePanel() {
    document.getElementById('narrate-result')?.classList.add('hidden');
    document.getElementById('narrate-progress')?.classList.add('hidden');
    const btn = document.getElementById('narrate-generate-btn');
    if (btn) btn.disabled = false;
    const audio = document.getElementById('narrate-audio-player');
    if (audio) { audio.pause(); audio.src = ''; }
    this.currentJobId = null;
  },

  async generate() {
    const text     = document.getElementById('narrate-text')?.value.trim() || '';
    const voiceId  = document.getElementById('narrate-voice')?.value || '';
    const format   = document.getElementById('narrate-format')?.value || 'mp3';
    const language = document.getElementById('narrate-language')?.value || 'es';
    const profile  = document.getElementById('narrate-profile')?.value || 'normal';
    const speed      = parseFloat(document.getElementById('narrate-speed')?.value);
    const stability  = parseFloat(document.getElementById('narrate-stability')?.value);
    const similarity = parseFloat(document.getElementById('narrate-similarity')?.value);

    if (!text)    { showToast('Escribe un texto para narrar', 'error'); return; }
    if (!voiceId) { showToast('Selecciona una voz', 'error'); return; }

    const btn = document.getElementById('narrate-generate-btn');
    if (btn) btn.disabled = true;
    document.getElementById('narrate-result')?.classList.add('hidden');

    const progress = document.getElementById('narrate-progress');
    if (progress) progress.classList.remove('hidden');
    const bar    = document.getElementById('narrate-progress-bar');
    const pctEl  = document.getElementById('narrate-progress-pct');
    const msgEl  = document.getElementById('narrate-progress-msg');
    if (bar)   bar.style.width = '5%';
    if (pctEl) pctEl.textContent = '5%';
    if (msgEl) msgEl.textContent = 'Enviando solicitud…';

    try {
      const res = await fetch('/api/tts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text, voice_id: voiceId, output_format: format, language, profile,
          speed: Number.isFinite(speed) ? speed : undefined,
          stability: Number.isFinite(stability) ? stability : undefined,
          similarity: Number.isFinite(similarity) ? similarity : undefined,
        }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`;
        throw new Error(detail);
      }
      const { job_id } = await res.json();
      this.currentJobId = job_id;
      this._pollGeneration(job_id);
    } catch (err) {
      if (btn) btn.disabled = false;
      progress?.classList.add('hidden');
      showToast('Error al iniciar la generación: ' + err.message, 'error');
    }
  },

  _pollGeneration(jobId) {
    const bar   = document.getElementById('narrate-progress-bar');
    const pctEl = document.getElementById('narrate-progress-pct');
    const msgEl = document.getElementById('narrate-progress-msg');
    const btn   = document.getElementById('narrate-generate-btn');

    const statusMsgs = {
      pending:       'En cola…',
      loading_model: 'Descargando modelo de voz (primera vez, ~1,2 GB)…',
      generating:    'Sintetizando la voz…',
    };

    const iv = setInterval(async () => {
      try {
        const res = await fetch(`/api/tts/status/${jobId}`);
        if (!res.ok) return;
        const data = await res.json();

        const pct = data.progress || 0;
        if (bar)   bar.style.width = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';
        if (msgEl) msgEl.textContent = statusMsgs[data.status] || 'Procesando…';

        if (data.status === 'completed') {
          clearInterval(iv);
          this._showResult(jobId);
        } else if (data.status === 'error') {
          clearInterval(iv);
          document.getElementById('narrate-progress')?.classList.add('hidden');
          if (btn) btn.disabled = false;
          showToast('Error en la generación: ' + (data.error || 'desconocido'), 'error', 7000);
        }
      } catch { /* reintenta en el siguiente tick */ }
    }, 1500);
  },

  _showResult(jobId) {
    document.getElementById('narrate-progress')?.classList.add('hidden');
    const audio = document.getElementById('narrate-audio-player');
    if (audio) {
      audio.src = `/api/tts/download/${jobId}?_t=${Date.now()}`;
      audio.load();
    }
    document.getElementById('narrate-result')?.classList.remove('hidden');
    const btn = document.getElementById('narrate-generate-btn');
    if (btn) btn.disabled = false;

    const dlBtn = document.getElementById('narrate-download-btn');
    if (dlBtn) {
      dlBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = `/api/tts/download/${jobId}`;
        a.download = '';
        a.click();
      };
    }
    showToast('Audio generado correctamente', 'success');
  },

  // ── Grabación de voz para clonación ──────────────
  async startCloneRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast('Tu sistema no soporta la grabación desde el navegador', 'error');
      return;
    }
    try {
      // Sin AGC ni cancelación de eco: alteran el nivel y el timbre del clip de
      // referencia, y el clonador reproduce esos artefactos. La supresión de
      // ruido se mantiene (ruido de fondo también se clona).
      this.cloneStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: true,
                 channelCount: 1, sampleRate: 48000 },
        video: false,
      });
    } catch (err) {
      showToast('No se pudo acceder al micrófono: ' + err.message, 'error');
      return;
    }

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    this.cloneExt    = 'webm';
    this.cloneChunks = [];
    this.cloneRecorder = new MediaRecorder(this.cloneStream, mime ? { mimeType: mime } : undefined);
    this.cloneRecorder.ondataavailable = e => { if (e.data.size > 0) this.cloneChunks.push(e.data); };
    this.cloneRecorder.onstop = () => {
      this.cloneBlob = new Blob(this.cloneChunks, { type: this.cloneRecorder.mimeType || 'audio/webm' });
      const url = URL.createObjectURL(this.cloneBlob);
      const preview = document.getElementById('clone-audio-preview');
      if (preview) preview.src = url;
      document.getElementById('clone-preview')?.classList.remove('hidden');
    };
    this.cloneRecorder.start(250);
    this.cloneStartTime = Date.now();

    document.getElementById('clone-record-btn')?.classList.add('hidden');
    document.getElementById('clone-stop-btn')?.classList.remove('hidden');
    document.getElementById('clone-rec-time')?.classList.remove('hidden');
    document.getElementById('clone-preview')?.classList.add('hidden');

    this.cloneTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.cloneStartTime) / 1000);
      const t = document.getElementById('clone-rec-time');
      if (t) t.textContent = fmtTime(elapsed);
    }, 1000);
  },

  stopCloneRecording() {
    clearInterval(this.cloneTimer);
    this.cloneTimer = null;
    if (this.cloneRecorder && this.cloneRecorder.state !== 'inactive') {
      this.cloneRecorder.stop();
    }
    if (this.cloneStream) {
      this.cloneStream.getTracks().forEach(t => t.stop());
      this.cloneStream = null;
    }
    document.getElementById('clone-record-btn')?.classList.remove('hidden');
    document.getElementById('clone-stop-btn')?.classList.add('hidden');
  },

  resetCloneRecording() {
    this.stopCloneRecording();
    this.cloneBlob = null;
    document.getElementById('clone-preview')?.classList.add('hidden');
    const t = document.getElementById('clone-rec-time');
    if (t) { t.classList.add('hidden'); t.textContent = '00:00'; }
  },

  async saveClonedVoice() {
    if (!this.cloneBlob) {
      showToast('Primero graba tu voz de referencia', 'error');
      return;
    }
    const name    = document.getElementById('clone-name')?.value.trim() || '';
    const lang    = document.getElementById('clone-lang')?.value || 'es';
    const refText = document.getElementById('clone-script-text')?.textContent.trim() || '';
    if (!name) { showToast('Dale un nombre a tu voz', 'error'); return; }

    const saveBtn = document.getElementById('clone-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Guardando…'; }

    try {
      const fd = new FormData();
      fd.append('audio', this.cloneBlob, `clone.${this.cloneExt}`);
      fd.append('name', name);
      fd.append('ref_text', refText);
      fd.append('language', lang);

      const res = await fetch('/api/tts/clone', { method: 'POST', body: fd });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`;
        throw new Error(detail);
      }
      const data = await res.json();
      showToast(`Voz "${data.name}" guardada`, 'success');
      this.resetCloneRecording();
      const inp = document.getElementById('clone-name');
      if (inp) inp.value = '';
      await this.loadVoices();
    } catch (err) {
      showToast('Error al guardar la voz: ' + err.message, 'error');
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg> Guardar voz`;
      }
    }
  },

  _updateCloneScript() {
    const lang = document.getElementById('clone-lang')?.value || 'es';
    const box  = document.getElementById('clone-script-text');
    if (!box) return;
    box.textContent = lang === 'en'
      ? 'Hello, this is my voice. I am reading this text so the system can learn how I sound. My pronunciation is clear and natural. I speak at a moderate pace for better synthesis quality. This system will allow me to narrate texts using my own voice in the future. It is important to maintain a consistent tone without background noise for the best results.'
      : 'Hola, esta es mi voz. Voy a leer este texto para que el sistema pueda aprender cómo sueno. Mi pronunciación es clara y natural. Hablo con una velocidad moderada para facilitar la transcripción y síntesis. Este sistema me permitirá narrar textos con mi propia voz más adelante. Es importante mantener un tono constante y sin ruidos de fondo para obtener mejores resultados.';
  },

  init() {
    this.loadVoices();
    document.getElementById('clone-lang')?.addEventListener('change', () => this._updateCloneScript());
    document.getElementById('narrate-text')?.addEventListener('input', e => {
      const n = document.getElementById('narrate-char-n');
      if (n) n.textContent = e.target.value.length;
    });
  },
};

// ══════════════════════════════════════════════════
// EVENT WIRING
// ══════════════════════════════════════════════════
function initEvents() {
  const fileInput = document.getElementById('file-input');

  // ── Browse button
  document.getElementById('browse-btn').addEventListener('click', () => fileInput.click());

  // ── File input change
  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    State.currentFile = file;
    State.currentFilename = file.name;
    State.pendingMeetingJobId = null;
    State.pendingVideoJobId = null;
    State.recordingReady = false;
    showOnly('sec-fileinfo');
    UI.setFileInfo(file.name, fileSizeHint(file.size));
    updateFileinfoControls();
    fileInput.value = '';
  });

  // ── Drag & drop
  const dropZone = document.getElementById('drop-zone');
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    State.currentFile = file;
    State.currentFilename = file.name;
    State.pendingMeetingJobId = null;
    State.pendingVideoJobId = null;
    State.recordingReady = false;
    showOnly('sec-fileinfo');
    UI.setFileInfo(file.name, fileSizeHint(file.size));
    updateFileinfoControls();
  });

  // ── Record button
  document.getElementById('record-btn').addEventListener('click', () => Recorder.start());

  // ── Stop recording
  document.getElementById('stop-rec-btn').addEventListener('click', () => Recorder.stop());
  document.getElementById('pause-rec-btn').addEventListener('click', () => Recorder.togglePause());

  // ── Cancel recorder
  document.getElementById('close-recorder-btn').addEventListener('click', () => Recorder.cancel());

  // ── Meeting recorder (audio del sistema + micro)
  document.getElementById('meeting-btn').addEventListener('click', () => Meeting.start());
  document.getElementById('stop-meeting-btn').addEventListener('click', () => Meeting.stop());
  document.getElementById('pause-meeting-btn').addEventListener('click', () => Meeting.togglePause());
  document.getElementById('close-meeting-btn').addEventListener('click', () => Meeting.cancel());

  // ── Grabación de pantalla con vídeo
  document.getElementById('screenrec-btn').addEventListener('click', () => ScreenRec.start());
  document.getElementById('stop-screenrec-btn').addEventListener('click', () => ScreenRec.stop());
  document.getElementById('pause-screenrec-btn').addEventListener('click', () => ScreenRec.togglePause());
  document.getElementById('close-screenrec-btn').addEventListener('click', () => ScreenRec.cancel());
  document.getElementById('download-video-btn').addEventListener('click', downloadCurrentVideo);

  // ── Audio de pestaña: mostrar panel de configuración
  document.getElementById('web-meeting-btn').addEventListener('click', () => showOnly('sec-tabsetup'));
  document.getElementById('close-tabsetup-btn').addEventListener('click', () => showOnly('sec-upload'));

  // Mostrar/ocultar selector de nº hablantes según la opción elegida
  document.querySelectorAll('input[name="tab-diarize"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const speakersRow = document.getElementById('tabsetup-speakers-row');
      speakersRow.classList.toggle('hidden', radio.value !== 'speakers');
    });
  });

  // Iniciar grabación en el navegador con la config del panel de setup
  document.getElementById('start-tabrecording-btn').addEventListener('click', () => {
    const mode        = document.querySelector('input[name="tab-diarize"]:checked')?.value || 'none';
    const diarize     = mode === 'speakers';
    const numSpeakers = diarize
      ? parseInt(document.getElementById('tab-num-speakers')?.value || '0', 10)
      : 0;
    WebMeeting.start({ diarize, numSpeakers });
  });

  // Controles del panel de espera
  document.getElementById('stop-webmeeting-btn').addEventListener('click', () => WebMeeting.requestStop());
  document.getElementById('close-webmeeting-btn').addEventListener('click', () => WebMeeting.cancel());

  // ── Re-transcribir (mismo audio, ajustes distintos)
  document.getElementById('retranscribe-btn').addEventListener('click', () => {
    const bar = document.getElementById('retx-bar');
    bar?.classList.toggle('hidden');
  });
  document.getElementById('retx-close-btn').addEventListener('click', () => {
    document.getElementById('retx-bar')?.classList.add('hidden');
  });
  document.getElementById('retx-go-btn').addEventListener('click', retranscribe);

  // ── Change file
  document.getElementById('change-file-btn').addEventListener('click', () => {
    State.currentFile = null;
    State.pendingMeetingJobId = null;
    State.pendingVideoJobId = null;
    State.recordingReady = false;
    showOnly('sec-upload');
  });

  // ── Download original audio (antes de transcribir)
  document.getElementById('download-audio-btn').addEventListener('click', downloadCurrentAudio);

  // ── Transcribe button
  document.getElementById('transcribe-btn').addEventListener('click', () => {
    if (State.pendingMeetingJobId) {
      const jid = State.pendingMeetingJobId;
      State.pendingMeetingJobId = null;
      State.recordingReady = false;
      showOnly('sec-progress');
      UI.updateProgress(50, 'Transcribiendo la reunión…');
      streamTranscription(jid, 'sec-upload', 50);
      return;
    }
    if (!State.currentFile) { showToast('Selecciona un archivo primero', 'error'); return; }
    State.recordingReady = false;
    startTranscription(State.currentFile);
  });

  // ── New transcription
  document.getElementById('new-trans-btn').addEventListener('click', () => {
    State.currentFile = null;
    State.currentFilename = '';
    State.currentJobId = null;
    State.pendingMeetingJobId = null;
    State.pendingVideoJobId = null;
    State.recordingReady = false;
    State.segments = [];
    State.speakerColors = {};
    State.speakerColorIdx = 0;
    State.aiResult = { action:'', label:'', text:'' };
    State.activeHistoryId = null;
    document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
    const sp = document.getElementById('speaker-panel');
    if (sp) sp.classList.add('hidden');
    showOnly('sec-upload');
  });

  // ── Copy transcription
  document.getElementById('copy-trans-btn').addEventListener('click', () => {
    copyToClipboard(segmentsToPlainText(State.segments));
  });

  // ── Export transcription
  document.getElementById('export-txt-btn').addEventListener('click', () => doExport('txt', false));
  document.getElementById('export-docx-btn').addEventListener('click', () => doExport('docx', false));

  // ── AI buttons
  document.querySelectorAll('.ai-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', () => processWithAI(btn.dataset.action));
  });
  document.getElementById('ai-install-btn')?.addEventListener('click', () => AIStatus.onInstallClick());

  // ── AI results: copy / export / close
  document.getElementById('copy-ai-btn').addEventListener('click', () => {
    copyToClipboard(State.aiResult.text);
  });
  document.getElementById('export-ai-txt-btn').addEventListener('click', () => doExport('txt', true));
  document.getElementById('export-ai-docx-btn').addEventListener('click', () => doExport('docx', true));
  document.getElementById('close-ai-btn').addEventListener('click', () => hideSection('sec-ai-results'));

  // ── Refresh history
  document.getElementById('refresh-history-btn').addEventListener('click', loadHistory);
  document.getElementById('clear-history-btn').addEventListener('click', deleteAllHistory);

  // ── Menú principal y navegación de vuelta ────────
  document.getElementById('home-transcribe-btn')?.addEventListener('click', () => showOnly('sec-upload'));
  document.getElementById('home-narrate-btn')?.addEventListener('click', () => TTS.openNarrate());
  document.getElementById('upload-back-btn')?.addEventListener('click', () => showOnly('sec-home'));
  document.getElementById('brand-home-btn')?.addEventListener('click', () => showOnly('sec-home'));

  // ── TTS: Narrador de Voz ─────────────────────────
  // "Narración" abre directamente el narrador; gestionar voces es una opción
  // secundaria dentro del panel y vuelve al narrador al cerrarse.
  document.getElementById('narrate-manage-voices-btn')?.addEventListener('click', () => TTS.openVoices());
  document.getElementById('close-voices-btn')?.addEventListener('click', () => TTS.openNarrate());
  document.getElementById('close-narrate-btn')?.addEventListener('click', () => showOnly('sec-home'));

  document.querySelectorAll('.voice-tab').forEach(btn => {
    btn.addEventListener('click', () => TTS._switchTab(btn.dataset.tab));
  });

  document.getElementById('clone-record-btn')?.addEventListener('click', () => TTS.startCloneRecording());
  document.getElementById('clone-stop-btn')?.addEventListener('click', () => TTS.stopCloneRecording());
  document.getElementById('clone-redo-btn')?.addEventListener('click', () => TTS.resetCloneRecording());
  document.getElementById('clone-save-btn')?.addEventListener('click', () => TTS.saveClonedVoice());

  document.getElementById('narrate-voice')?.addEventListener('change', () => TTS._syncLanguageToVoice());
  document.getElementById('narrate-generate-btn')?.addEventListener('click', () => TTS.generate());
  document.getElementById('narrate-new-btn')?.addEventListener('click', () => TTS._resetNarratePanel());

  document.getElementById('narrate-profile')?.addEventListener('change', (e) => TTS._applyProfileToSliders(e.target.value));
  ['narrate-speed', 'narrate-stability', 'narrate-similarity'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => TTS._updateSliderReadouts());
  });

  document.getElementById('narrate-engine')?.addEventListener('change', () => TTS._onEngineChange());
  document.getElementById('narrate-engine-config-btn')?.addEventListener('click', () => {
    document.getElementById('elevenlabs-config')?.classList.toggle('hidden');
  });
  document.getElementById('el-save-btn')?.addEventListener('click', () => TTS.saveElevenLabsSettings());
}

// ══════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  showOnly('sec-home');
  initEvents();
  TTS.init();
  await loadHistory();

  // La grabación funciona de forma nativa (WKWebView con permiso de micrófono).
  // No se desactiva el botón: si el micrófono fallara, start() avisa con detalle.
});
