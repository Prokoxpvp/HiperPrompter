/* Teleprompter PWA — app.js (vanilla JS, bez zależności; PeerJS ładowany leniwie tylko dla pilota) */
(function () {
'use strict';

/* ===================== NARZĘDZIA ===================== */
var $ = function (id) { return document.getElementById(id); };
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function fmtDuration(sec) {
  if (!isFinite(sec) || sec <= 0) return '—';
  sec = Math.round(sec);
  var m = Math.floor(sec / 60), s = sec % 60;
  if (m === 0) return '≈ ' + s + ' s';
  return '≈ ' + m + ' min ' + (s < 10 ? '0' : '') + s + ' s';
}
function wordCount(text) {
  var w = String(text).trim().split(/\s+/).filter(Boolean);
  return w.length;
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

var FONTS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  legible: 'Verdana, Tahoma, "DejaVu Sans", sans-serif'
};
var COLORS = {
  wb: { fg: '#ffffff', bg: '#000000' },
  yb: { fg: '#ffd400', bg: '#000000' },
  gb: { fg: '#7dff7d', bg: '#000000' },
  bw: { fg: '#000000', bg: '#ffffff' }
};
var DEFAULT_SETTINGS = {
  fontSize: 44, lineHeight: 1.4, margin: 6, colors: 'wb', font: 'sans',
  speed: 160, guide: 78, mirror: false, countdown: 3, autoRestart: false
};
var SPEED_MIN = 10, SPEED_MAX = 300;

/* ===================== MAGAZYN (localStorage) ===================== */
var LS_KEY = 'teleprompter.v1';
var store = { scripts: [] };

function storeLoad() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.scripts)) store = parsed;
    }
  } catch (e) { /* uszkodzone dane — start od zera */ }
  var migrated = false;
  store.scripts.forEach(function (s) {
    s.settings = Object.assign({}, DEFAULT_SETTINGS, s.settings || {});
    // normalizacja po zmianach wersji: odliczanie tylko 0/3/5, prędkość w nowym zakresie
    if ([0, 3, 5].indexOf(s.settings.countdown) === -1) { s.settings.countdown = 3; migrated = true; }
    var sp = clamp(s.settings.speed, SPEED_MIN, SPEED_MAX);
    if (sp !== s.settings.speed) { s.settings.speed = sp; migrated = true; }
  });
  if (migrated) storeSave();
}
function storeSave() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(store)); }
  catch (e) { alert('Nie udało się zapisać danych (pamięć pełna?)'); }
}
function getScript(id) {
  for (var i = 0; i < store.scripts.length; i++) if (store.scripts[i].id === id) return store.scripts[i];
  return null;
}
function sortedScripts() {
  return store.scripts.slice().sort(function (a, b) {
    return (b.lastUsed || b.createdAt || 0) - (a.lastUsed || a.createdAt || 0);
  });
}

/* ===================== SZACOWANY CZAS CZYTANIA ===================== */
var measurer = null;
function estimateSeconds(script, widthPx) {
  if (!script.text.trim()) return 0;
  if (!measurer) {
    measurer = document.createElement('div');
    measurer.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;word-wrap:break-word;font-weight:600;';
    document.body.appendChild(measurer);
  }
  var s = script.settings;
  widthPx = widthPx || Math.min(window.innerWidth, 640);
  var textWidth = widthPx * (1 - 2 * s.margin / 100);
  measurer.style.width = Math.max(50, textWidth) + 'px';
  measurer.style.fontSize = s.fontSize + 'px';
  measurer.style.lineHeight = s.lineHeight;
  measurer.style.fontFamily = FONTS[s.font] || FONTS.sans;
  measurer.innerHTML = buildContentHTML(script.text);
  var h = measurer.offsetHeight;
  return h / Math.max(1, s.speed);
}

/* ===================== TREŚĆ + ZNACZNIKI // ===================== */
function buildContentHTML(text) {
  var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  var html = '', buf = [];
  function flush() {
    if (buf.length) { html += '<div class="block">' + esc(buf.join('\n')) + '</div>'; buf = []; }
  }
  lines.forEach(function (line) {
    if (/^\s*\/\//.test(line)) {
      flush();
      var label = line.replace(/^\s*\/\/\s*/, '');
      html += '<div class="marker" data-marker>' + (label ? esc(label) : '&nbsp;') + '</div>';
    } else {
      buf.push(line);
    }
  });
  flush();
  return html || '<div class="block"></div>';
}

/* ===================== EKRAN 1: BIBLIOTEKA ===================== */
var elList = $('script-list'), elEmpty = $('empty-state');

function renderLibrary() {
  var scripts = sortedScripts();
  elEmpty.hidden = scripts.length > 0;
  elList.innerHTML = '';
  scripts.forEach(function (sc) {
    var item = document.createElement('div');
    item.className = 'script-item';
    var est = fmtDuration(estimateSeconds(sc));
    item.innerHTML =
      '<div class="info"><div class="name">' + esc(sc.name) + '</div>' +
      '<div class="meta">' + est + ' · ' + wordCount(sc.text) + ' słów</div></div>' +
      '<button class="btn-edit" type="button" aria-label="Edytuj">✎</button>' +
      '<button class="btn-play" type="button" aria-label="Start">▶</button>';
    item.querySelector('.btn-play').addEventListener('click', function () { openPrompter(sc.id); });
    item.querySelector('.btn-edit').addEventListener('click', function () { openEditor(sc.id); });
    item.querySelector('.info').addEventListener('click', function () { openEditor(sc.id); });
    elList.appendChild(item);
  });
}

/* ===================== EDYTOR ===================== */
var editorId = null;
function openEditor(id) {
  editorId = id || null;
  var sc = id ? getScript(id) : null;
  $('editor-name').value = sc ? sc.name : '';
  $('editor-text').value = sc ? sc.text : '';
  $('btn-editor-delete').hidden = !sc;
  $('btn-editor-duplicate').hidden = !sc;
  $('editor').hidden = false;
  if (!sc) $('editor-name').focus();
}
function closeEditor() { $('editor').hidden = true; editorId = null; }

$('btn-new').addEventListener('click', function () { openEditor(null); });
$('btn-editor-cancel').addEventListener('click', closeEditor);
$('btn-editor-save').addEventListener('click', function () {
  var name = $('editor-name').value.trim();
  var text = $('editor-text').value;
  if (!name) {
    var firstLine = text.trim().split('\n')[0] || '';
    name = firstLine.replace(/^\s*\/\/\s*/, '').slice(0, 40) || ('Skrypt ' + new Date().toLocaleDateString('pl-PL'));
  }
  if (editorId) {
    var sc = getScript(editorId);
    if (sc) { sc.name = name; sc.text = text; }
  } else {
    store.scripts.push({
      id: uid(), name: name, text: text,
      createdAt: Date.now(), lastUsed: null,
      settings: Object.assign({}, DEFAULT_SETTINGS)
    });
  }
  storeSave(); renderLibrary(); closeEditor();
});
$('btn-editor-delete').addEventListener('click', function () {
  if (!editorId) return;
  if (!confirm('Usunąć ten skrypt? Tej operacji nie można cofnąć.')) return;
  store.scripts = store.scripts.filter(function (s) { return s.id !== editorId; });
  storeSave(); renderLibrary(); closeEditor();
});
$('btn-editor-duplicate').addEventListener('click', function () {
  var sc = editorId && getScript(editorId);
  if (!sc) return;
  var copy = JSON.parse(JSON.stringify(sc));
  copy.id = uid(); copy.name = sc.name + ' (kopia)';
  copy.createdAt = Date.now(); copy.lastUsed = null;
  store.scripts.push(copy);
  storeSave(); renderLibrary(); closeEditor();
});

/* ===================== WAKE LOCK ===================== */
var wake = {
  sentinel: null, video: null, canvas: null, drawTimer: null, active: false,
  on: function () {
    this.active = true;
    var self = this;
    if ('wakeLock' in navigator && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen').then(function (s) {
        self.sentinel = s;
      }).catch(function () { self.fallback(); });
    } else {
      this.fallback();
    }
  },
  fallback: function () {
    // Awaryjnie: odtwarzanie "wideo" z canvas.captureStream utrzymuje ekran włączony
    try {
      var self = this;
      if (!this.video) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = 64; this.canvas.height = 64;
        var ctx = this.canvas.getContext('2d');
        var stream = this.canvas.captureStream(1);
        this.video = document.createElement('video');
        this.video.setAttribute('playsinline', '');
        this.video.muted = true;
        this.video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
        this.video.srcObject = stream;
        document.body.appendChild(this.video);
        this.drawTick = function () {
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 64, 64);
          ctx.fillStyle = 'rgba(255,255,255,0.01)';
          ctx.fillRect(Math.random() * 60, Math.random() * 60, 2, 2);
        };
      }
      this.drawTick();
      if (this.drawTimer) clearInterval(this.drawTimer);
      this.drawTimer = setInterval(this.drawTick, 1000);
      this.video.play().catch(function () { /* brak wake locka — aplikacja działa dalej */ });
    } catch (e) { /* brak wsparcia — działamy bez wake locka */ }
  },
  off: function () {
    this.active = false;
    if (this.sentinel) { try { this.sentinel.release(); } catch (e) {} this.sentinel = null; }
    if (this.drawTimer) { clearInterval(this.drawTimer); this.drawTimer = null; }
    if (this.video) { try { this.video.pause(); } catch (e) {} }
  }
};
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible' && wake.active && !wake.sentinel) wake.on();
});

/* ===================== EKRAN 2: PROMPTER ===================== */
var P = {
  script: null, pos: 0, maxPos: 0, playing: false,
  rafId: null, lastT: 0, markers: [], guideY: 0,
  controlsTimer: null, countdownTimer: null, endShown: false
};
var elPrompter = $('screen-prompter'),
    elViewport = $('prompter-viewport'),
    elContent = $('prompter-content'),
    elGuide = $('guide-line'),
    elCtrlTop = $('controls-top'),
    elCtrlBottom = $('controls-bottom'),
    elSlider = $('speed-slider'),
    elSpeedLabel = $('speed-label'),
    elPlayPause = $('btn-playpause'),
    elCountdown = $('countdown-overlay'),
    elCountNum = $('countdown-num'),
    elEnd = $('end-overlay');

function S() { return P.script ? P.script.settings : DEFAULT_SETTINGS; }

function applySettings() {
  var s = S(), col = COLORS[s.colors] || COLORS.wb;
  elPrompter.style.setProperty('--p-bg', col.bg);
  elPrompter.style.setProperty('--p-fg', col.fg);
  elContent.style.setProperty('--p-fs', s.fontSize + 'px');
  elContent.style.fontSize = s.fontSize + 'px';
  elContent.style.lineHeight = s.lineHeight;
  elContent.style.fontFamily = FONTS[s.font] || FONTS.sans;
  elContent.style.paddingLeft = s.margin + '%';
  elContent.style.paddingRight = s.margin + '%';
  elContent.style.color = col.fg;
  elGuide.style.borderTopColor = col.fg;
  layout();
}

function layout() {
  var vh = elViewport.clientHeight || window.innerHeight;
  var s = S();
  P.guideY = Math.round(vh * s.guide / 100);
  elGuide.style.top = P.guideY + 'px';
  elContent.style.paddingTop = P.guideY + 'px';
  elContent.style.paddingBottom = Math.max(0, vh - P.guideY) + 'px';
  P.maxPos = Math.max(0, elContent.offsetHeight - vh);
  // pozycje znaczników
  P.markers = [];
  var nodes = elContent.querySelectorAll('[data-marker]');
  for (var i = 0; i < nodes.length; i++) {
    P.markers.push(clamp(nodes[i].offsetTop - P.guideY, 0, P.maxPos));
  }
  P.pos = clamp(P.pos, 0, P.maxPos);
  renderPos();
}

function renderPos() {
  var mirror = S().mirror ? ' scaleX(-1)' : '';
  elContent.style.transform = 'translate3d(0,' + (-P.pos) + 'px,0)' + mirror;
}

function updateSpeedUI() {
  var s = S();
  elSlider.value = s.speed;
  elSpeedLabel.textContent = s.speed + ' px/s';
  var total = P.maxPos / Math.max(1, s.speed);
  $('prompter-esttime').textContent = fmtDuration(total);
  remoteSendState();
}

/* pętla przewijania — requestAnimationFrame */
function tick(t) {
  if (!P.playing) { P.rafId = null; return; }
  if (P.lastT) {
    var dt = Math.min(0.1, (t - P.lastT) / 1000); // ochrona przed skokami po wznowieniu karty
    P.pos += S().speed * dt;
    if (P.pos >= P.maxPos) {
      P.pos = P.maxPos;
      renderPos();
      onScrollEnd();
      return;
    }
    renderPos();
  }
  P.lastT = t;
  P.rafId = requestAnimationFrame(tick);
}

function showStartOverlay() { $('start-overlay').hidden = false; }
function hideStartOverlay() { $('start-overlay').hidden = true; }

function play() {
  if (P.playing || !P.script) return;
  hideEnd();
  hideStartOverlay();
  P.playing = true;
  P.lastT = 0;
  elPlayPause.textContent = '⏸';
  P.rafId = requestAnimationFrame(tick);
  scheduleControlsFade();
  remoteSendState();
}
function pause() {
  P.playing = false;
  if (P.rafId) { cancelAnimationFrame(P.rafId); P.rafId = null; }
  P.lastT = 0;
  elPlayPause.textContent = '▶';
  showControls(true);
  remoteSendState();
}
function togglePlay() { P.playing ? pause() : startWithCountdownIfAtTop(); }

function startWithCountdownIfAtTop() {
  hideStartOverlay();
  if (P.pos <= 1) startCountdown(play);
  else play();
}

function restart(withCountdown) {
  cancelCountdown();
  pause();
  P.pos = 0; renderPos(); hideEnd(); hideStartOverlay();
  if (withCountdown !== false) startCountdown(play);
  remoteSendState();
}

function onScrollEnd() {
  P.playing = false;
  if (P.rafId) { cancelAnimationFrame(P.rafId); P.rafId = null; }
  elPlayPause.textContent = '▶';
  P.endShown = true;
  $('chk-auto-restart').checked = !!S().autoRestart;
  elEnd.hidden = false;
  showControls(true);
  remoteSendState();
  if (S().autoRestart) {
    setTimeout(function () {
      if (P.endShown && P.script) restart(true);
    }, 1500);
  }
}
function hideEnd() { P.endShown = false; elEnd.hidden = true; }

/* odliczanie */
function startCountdown(cb) {
  cancelCountdown();
  var n = S().countdown;
  if (!n || n <= 0) { cb(); return; } // odliczanie 0 s — start natychmiast
  elCountNum.textContent = n;
  elCountdown.hidden = false;
  P.countdownTimer = setInterval(function () {
    n--;
    if (n <= 0) {
      cancelCountdown();
      cb();
    } else {
      elCountNum.textContent = n;
    }
  }, 1000);
}
function cancelCountdown() {
  if (P.countdownTimer) { clearInterval(P.countdownTimer); P.countdownTimer = null; }
  elCountdown.hidden = true;
}
elCountdown.addEventListener('click', function (e) {
  e.stopPropagation();
  cancelCountdown();
  showControls(true);
});

/* znaczniki — skoki */
function jumpMarker(dirn) {
  if (!P.markers.length) return;
  var target = null;
  if (dirn > 0) {
    for (var i = 0; i < P.markers.length; i++) if (P.markers[i] > P.pos + 2) { target = P.markers[i]; break; }
    if (target === null) target = P.maxPos;
  } else {
    for (var j = P.markers.length - 1; j >= 0; j--) if (P.markers[j] < P.pos - 2) { target = P.markers[j]; break; }
    if (target === null) target = 0;
  }
  P.pos = clamp(target, 0, P.maxPos);
  hideEnd();
  renderPos();
  remoteSendState();
}

/* kontrolki: pojawianie / znikanie */
function showControls(sticky) {
  elCtrlTop.classList.remove('faded');
  elCtrlBottom.classList.remove('faded');
  if (!sticky) scheduleControlsFade(); else clearTimeout(P.controlsTimer);
  if (P.playing) scheduleControlsFade();
}
function scheduleControlsFade() {
  clearTimeout(P.controlsTimer);
  P.controlsTimer = setTimeout(function () {
    if (P.playing && $('settings-panel').hidden && $('remote-panel').hidden) {
      elCtrlTop.classList.add('faded');
      elCtrlBottom.classList.add('faded');
    }
  }, 3000);
}

/* otwarcie / zamknięcie prompteru */
function openPrompter(id) {
  var sc = getScript(id);
  if (!sc) return;
  P.script = sc;
  sc.lastUsed = Date.now();
  storeSave();
  elContent.innerHTML = buildContentHTML(sc.text);
  $('prompter-title').textContent = sc.name;
  var noMarkers = elContent.querySelectorAll('[data-marker]').length === 0;
  $('btn-marker-prev').style.display = noMarkers ? 'none' : '';
  $('btn-marker-next').style.display = noMarkers ? 'none' : '';
  P.pos = 0; hideEnd(); cancelCountdown();
  elPrompter.hidden = false;
  document.getElementById('screen-library').hidden = true;
  applySettings();
  syncSettingsUI();
  updateSpeedUI();
  renderPos();
  showControls(true);
  elPlayPause.textContent = '▶';
  wake.on();
  // pełny ekran (Android; na iOS niedostępne dla elementów — PWA standalone i tak jest pełnoekranowe)
  try {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(function () {});
    }
  } catch (e) {}
  showStartOverlay(); // tekst wstrzymany — start dopiero po naciśnięciu dużego przycisku
}

function closePrompter() {
  pause(); cancelCountdown(); hideEnd(); hideStartOverlay();
  wake.off();
  remoteHostSendBye();
  try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {}); } catch (e) {}
  elPrompter.hidden = true;
  $('settings-panel').hidden = true;
  $('remote-panel').hidden = true;
  document.getElementById('screen-library').hidden = false;
  P.script = null;
  renderLibrary();
}

/* zdarzenia prompteru */
elViewport.addEventListener('click', function () {
  if (!elCountdown.hidden || !elEnd.hidden || !$('start-overlay').hidden) return;
  if (P.playing) { pause(); }
  else { showControls(true); startWithCountdownIfAtTop(); }
});
$('btn-start-go').addEventListener('click', function (e) {
  e.stopPropagation();
  hideStartOverlay();
  startCountdown(play);
});
$('btn-start-settings').addEventListener('click', function (e) {
  e.stopPropagation();
  syncSettingsUI();
  $('settings-panel').hidden = false;
});
$('btn-start-remote').addEventListener('click', function (e) {
  e.stopPropagation();
  openRemotePanel();
});
$('btn-remote-quick').addEventListener('click', function (e) {
  e.stopPropagation();
  pause();
  openRemotePanel();
});
$('btn-exit').addEventListener('click', function (e) { e.stopPropagation(); closePrompter(); });
elPlayPause.addEventListener('click', function (e) { e.stopPropagation(); togglePlay(); });
$('btn-restart').addEventListener('click', function (e) { e.stopPropagation(); restart(true); });
$('btn-marker-prev').addEventListener('click', function (e) { e.stopPropagation(); jumpMarker(-1); showControls(); });
$('btn-marker-next').addEventListener('click', function (e) { e.stopPropagation(); jumpMarker(1); showControls(); });
$('btn-again').addEventListener('click', function (e) { e.stopPropagation(); restart(true); });
$('btn-end-exit').addEventListener('click', function (e) { e.stopPropagation(); closePrompter(); });
$('chk-auto-restart').addEventListener('change', function () {
  S().autoRestart = this.checked; $('set-autorestart').checked = this.checked; storeSave();
  if (this.checked && P.endShown) {
    setTimeout(function () { if (P.endShown && P.script) restart(true); }, 800);
  }
});

function setSpeed(v) {
  var s = S();
  s.speed = clamp(Math.round(v), SPEED_MIN, SPEED_MAX);
  storeSaveDebounced();
  updateSpeedUI();
}
var saveTimer = null;
function storeSaveDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(storeSave, 400);
}
elSlider.addEventListener('input', function (e) { e.stopPropagation(); setSpeed(parseInt(this.value, 10)); showControls(); });
elSlider.addEventListener('click', function (e) { e.stopPropagation(); });
$('btn-speed-minus').addEventListener('click', function (e) { e.stopPropagation(); setSpeed(S().speed - 5); showControls(); });
$('btn-speed-plus').addEventListener('click', function (e) { e.stopPropagation(); setSpeed(S().speed + 5); showControls(); });

window.addEventListener('resize', function () {
  if (!elPrompter.hidden) {
    var rel = P.maxPos > 0 ? P.pos / P.maxPos : 0;
    layout();
    P.pos = rel * P.maxPos;
    renderPos();
  }
});

/* ===================== PANEL USTAWIEŃ ===================== */
var elSettings = $('settings-panel');
$('btn-settings').addEventListener('click', function (e) {
  e.stopPropagation();
  pause();
  syncSettingsUI();
  elSettings.hidden = false;
});
$('btn-settings-close').addEventListener('click', function () { elSettings.hidden = true; });

function syncSettingsUI() {
  var s = S();
  $('set-fontsize').value = s.fontSize; $('val-fontsize').textContent = s.fontSize + ' px';
  $('set-lineheight').value = Math.round(s.lineHeight * 100); $('val-lineheight').textContent = s.lineHeight.toFixed(2);
  $('set-margin').value = s.margin; $('val-margin').textContent = s.margin + '%';
  $('set-guide').value = s.guide; $('val-guide').textContent = s.guide + '%';
  $('set-mirror').checked = !!s.mirror;
  $('set-autorestart').checked = !!s.autoRestart;
  segSync('set-colors', 'colors', s.colors, 'data-colors');
  segSync('set-font', 'font', s.font, 'data-font');
  segSync('set-countdown', 'countdown', String(s.countdown), 'data-cd');
}
function segSync(containerId, key, val, attr) {
  var btns = $(containerId).querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('on', btns[i].getAttribute(attr) === String(val));
  }
}
function bindRange(inputId, valId, fn) {
  $(inputId).addEventListener('input', function () {
    fn(parseInt(this.value, 10));
    storeSaveDebounced();
    applySettings();
    updateSpeedUI();
    syncSettingsUI();
    renderLibraryLater();
  });
}
var libTimer = null;
function renderLibraryLater() { clearTimeout(libTimer); libTimer = setTimeout(renderLibrary, 800); }

bindRange('set-fontsize', 'val-fontsize', function (v) { S().fontSize = clamp(v, 24, 72); });
bindRange('set-lineheight', 'val-lineheight', function (v) { S().lineHeight = clamp(v, 110, 200) / 100; });
bindRange('set-margin', 'val-margin', function (v) { S().margin = clamp(v, 0, 16); });
bindRange('set-guide', 'val-guide', function (v) { S().guide = clamp(v, 20, 92); });

$('set-colors').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  S().colors = b.getAttribute('data-colors');
  storeSave(); applySettings(); syncSettingsUI();
});
$('set-font').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  S().font = b.getAttribute('data-font');
  storeSave(); applySettings(); updateSpeedUI(); syncSettingsUI(); renderLibraryLater();
});
$('set-countdown').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  S().countdown = parseInt(b.getAttribute('data-cd'), 10);
  storeSave(); syncSettingsUI();
});
$('set-mirror').addEventListener('change', function () {
  S().mirror = this.checked; storeSave(); renderPos();
});
$('set-autorestart').addEventListener('change', function () {
  S().autoRestart = this.checked; $('chk-auto-restart').checked = this.checked; storeSave();
});

/* ===================== PILOT — WSPÓLNE ===================== */
var PEER_CDN = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
var PEER_PREFIX = 'twprompt-';
function loadPeerJS() {
  return new Promise(function (resolve, reject) {
    if (window.Peer) { resolve(); return; }
    if (!navigator.onLine) { reject(new Error('offline')); return; }
    var s = document.createElement('script');
    s.src = PEER_CDN;
    var to = setTimeout(function () { reject(new Error('timeout')); }, 12000);
    s.onload = function () { clearTimeout(to); resolve(); };
    s.onerror = function () { clearTimeout(to); reject(new Error('load')); };
    document.head.appendChild(s);
  });
}
function randomCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', out = '';
  for (var i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/* ===================== PILOT — HOST (telefon z prompterem) ===================== */
var host = { peer: null, conns: [], code: null };

$('btn-open-remote').addEventListener('click', function () {
  elSettings.hidden = true;
  openRemotePanel();
});
$('btn-remote-close').addEventListener('click', function () { $('remote-panel').hidden = true; });

function remoteStatus(msg, cls) {
  var el = $('remote-status');
  el.textContent = msg;
  el.className = cls || '';
}

function openRemotePanel() {
  $('remote-panel').hidden = false;
  if (host.peer && !host.peer.destroyed) { return; } // już działa
  remoteStatus('Łączenie z serwerem…');
  $('remote-qr').innerHTML = '';
  $('remote-code').textContent = '';
  loadPeerJS().then(function () {
    host.code = randomCode();
    try { host.peer = new Peer(PEER_PREFIX + host.code, { debug: 0 }); }
    catch (e) { remoteStatus('Nie udało się uruchomić pilota. Prompter działa normalnie.', 'err'); return; }
    host.peer.on('open', function () {
      var url = location.origin + location.pathname + '?pilot=' + host.code;
      var qr = window.qrEncode ? qrEncode(url) : null;
      if (qr) $('remote-qr').appendChild(qrToCanvas(qr, 6, 4));
      else $('remote-qr').textContent = url;
      $('remote-code').textContent = host.code;
      remoteStatus('Czekam na drugi telefon…');
    });
    host.peer.on('connection', function (conn) {
      conn.on('open', function () {
        host.conns.push(conn);
        remoteStatus('✓ Pilot połączony', 'ok');
        remoteSendState();
      });
      conn.on('data', function (d) { handleRemoteCmd(d); });
      conn.on('close', function () {
        host.conns = host.conns.filter(function (c) { return c !== conn; });
        if (!host.conns.length) remoteStatus('Pilot rozłączony. Czekam na połączenie…');
      });
    });
    host.peer.on('error', function (err) {
      remoteStatus('Błąd połączenia (' + (err.type || 'nieznany') + '). Pilot niedostępny — prompter działa normalnie.', 'err');
    });
    host.peer.on('disconnected', function () {
      try { host.peer.reconnect(); } catch (e) {}
    });
  }).catch(function () {
    remoteStatus('Brak internetu lub nie można pobrać modułu pilota. Prompter działa normalnie bez pilota.', 'err');
  });
}

function handleRemoteCmd(d) {
  if (!d || d.t !== 'cmd' || !P.script) return;
  switch (d.cmd) {
    case 'toggle': togglePlay(); break;
    case 'restart': restart(true); break;
    case 'faster': setSpeed(S().speed + 5); break;
    case 'slower': setSpeed(S().speed - 5); break;
    case 'next': jumpMarker(1); break;
    case 'prev': jumpMarker(-1); break;
    case 'adj': remoteAdj(d.key, d.delta); break;
    case 'set': remoteSet(d.key, d.value); break;
  }
  showControls();
}

function remoteAdj(key, delta) {
  var s = S();
  delta = Number(delta) || 0;
  if (key === 'fontSize') s.fontSize = clamp(s.fontSize + delta, 24, 72);
  else if (key === 'lineHeight') s.lineHeight = Math.round(clamp(s.lineHeight + delta, 1.1, 2.0) * 100) / 100;
  else if (key === 'guide') s.guide = clamp(s.guide + delta, 20, 92);
  else return;
  storeSaveDebounced(); applySettings(); syncSettingsUI(); updateSpeedUI();
}

function remoteSet(key, value) {
  var s = S();
  if (key === 'colors' && COLORS[value]) s.colors = value;
  else if (key === 'font' && FONTS[value]) s.font = value;
  else if (key === 'mirror') s.mirror = !!value;
  else if (key === 'autoRestart') {
    s.autoRestart = !!value;
    $('chk-auto-restart').checked = s.autoRestart;
    if (s.autoRestart && P.endShown) {
      setTimeout(function () { if (P.endShown && P.script) restart(true); }, 800);
    }
  }
  else return;
  storeSave(); applySettings(); renderPos(); syncSettingsUI(); updateSpeedUI();
}

function remoteSendState() {
  if (!host.conns.length || !P.script) return;
  var s = S();
  var msg = {
    t: 'state',
    playing: P.playing,
    speed: s.speed,
    progress: P.maxPos > 0 ? P.pos / P.maxPos : 0,
    name: P.script.name,
    counting: !elCountdown.hidden,
    settings: {
      fontSize: s.fontSize, lineHeight: s.lineHeight, guide: s.guide,
      colors: s.colors, font: s.font, mirror: !!s.mirror, autoRestart: !!s.autoRestart
    }
  };
  host.conns.forEach(function (c) { try { c.send(msg); } catch (e) {} });
}
setInterval(function () { if (P.playing) remoteSendState(); }, 1000);

function remoteHostSendBye() {
  host.conns.forEach(function (c) { try { c.send({ t: 'bye' }); } catch (e) {} });
}

/* ===================== PILOT — KONTROLER (drugi telefon) ===================== */
var rc = { peer: null, conn: null };

function openRemoteScreen(prefillCode) {
  $('screen-library').hidden = true;
  $('screen-prompter').hidden = true;
  $('screen-remote').hidden = false;
  if (prefillCode) {
    $('remote-code-input').value = prefillCode;
    rcConnect(prefillCode);
  }
}
$('btn-remote-mode').addEventListener('click', function () { openRemoteScreen(''); });
$('btn-remote-exit').addEventListener('click', function () {
  if (rc.conn) { try { rc.conn.close(); } catch (e) {} rc.conn = null; }
  if (rc.peer) { try { rc.peer.destroy(); } catch (e) {} rc.peer = null; }
  $('screen-remote').hidden = true;
  $('screen-library').hidden = false;
  history.replaceState(null, '', location.pathname);
  renderLibrary();
});
$('btn-remote-connect').addEventListener('click', function () {
  var code = $('remote-code-input').value.trim().toUpperCase();
  if (code.length < 4) { rcStatus('Wpisz kod z ekranu prompteru', 'err'); return; }
  rcConnect(code);
});

function rcStatus(msg, cls) {
  var el = $('remote-conn-status');
  el.textContent = msg;
  el.className = cls || '';
}

function rcConnect(code) {
  rcStatus('Łączenie…');
  loadPeerJS().then(function () {
    if (rc.peer) { try { rc.peer.destroy(); } catch (e) {} }
    rc.peer = new Peer({ debug: 0 });
    var opened = false;
    rc.peer.on('open', function () {
      var conn = rc.peer.connect(PEER_PREFIX + code, { reliable: true });
      var to = setTimeout(function () {
        if (!opened) rcStatus('Nie znaleziono prompteru o kodzie ' + code + '. Sprawdź kod i internet na obu telefonach.', 'err');
      }, 10000);
      conn.on('open', function () {
        opened = true; clearTimeout(to);
        rc.conn = conn;
        rcStatus('✓ Połączono', 'ok');
        $('remote-pair-box').hidden = true;
        $('remote-controls').hidden = false;
      });
      conn.on('data', function (d) { rcOnData(d); });
      conn.on('close', function () {
        rcStatus('Rozłączono', 'err');
        $('remote-controls').hidden = true;
        $('remote-pair-box').hidden = false;
      });
      conn.on('error', function () {
        rcStatus('Błąd połączenia. Spróbuj ponownie.', 'err');
      });
    });
    rc.peer.on('error', function (err) {
      rcStatus('Błąd: ' + (err.type || 'nieznany') + '. Sprawdź internet i spróbuj ponownie.', 'err');
    });
  }).catch(function () {
    rcStatus('Brak internetu — pilot wymaga połączenia na obu telefonach.', 'err');
  });
}

function rcSegMark(containerId, attr, val) {
  var btns = $(containerId).querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('on', btns[i].getAttribute(attr) === String(val));
  }
}

function rcOnData(d) {
  if (!d) return;
  if (d.t === 'state') {
    $('remote-script-name').textContent = d.name || '';
    $('remote-progress').querySelector('.bar').style.width = Math.round((d.progress || 0) * 100) + '%';
    $('rc-speed-val').textContent = 'Prędkość: ' + d.speed + ' px/s';
    $('rc-toggle').textContent = d.counting ? '⏳ Odliczanie…' : (d.playing ? '⏸ Pauza' : '▶ Start');
    if (d.settings) {
      $('rcs-fs-val').textContent = d.settings.fontSize + ' px';
      $('rcs-lh-val').textContent = Number(d.settings.lineHeight).toFixed(2);
      $('rcs-guide-val').textContent = d.settings.guide + '%';
      rcSegMark('rcs-colors', 'data-colors', d.settings.colors);
      rcSegMark('rcs-font', 'data-font', d.settings.font);
      $('rcs-mirror').checked = !!d.settings.mirror;
      $('rcs-autorestart').checked = !!d.settings.autoRestart;
    }
  } else if (d.t === 'bye') {
    rcStatus('Prompter zamknięty na drugim telefonie', 'err');
  }
}
function rcSend(cmd) {
  if (rc.conn && rc.conn.open) { try { rc.conn.send({ t: 'cmd', cmd: cmd }); } catch (e) {} }
}
$('rc-toggle').addEventListener('click', function () { rcSend('toggle'); });
$('rc-restart').addEventListener('click', function () { rcSend('restart'); });
$('rc-faster').addEventListener('click', function () { rcSend('faster'); });
$('rc-slower').addEventListener('click', function () { rcSend('slower'); });
$('rc-next').addEventListener('click', function () { rcSend('next'); });
$('rc-prev').addEventListener('click', function () { rcSend('prev'); });

function rcSendObj(obj) {
  if (rc.conn && rc.conn.open) { try { rc.conn.send(obj); } catch (e) {} }
}
$('rcs-fs-minus').addEventListener('click', function () { rcSendObj({ t: 'cmd', cmd: 'adj', key: 'fontSize', delta: -2 }); });
$('rcs-fs-plus').addEventListener('click', function () { rcSendObj({ t: 'cmd', cmd: 'adj', key: 'fontSize', delta: 2 }); });
$('rcs-lh-minus').addEventListener('click', function () { rcSendObj({ t: 'cmd', cmd: 'adj', key: 'lineHeight', delta: -0.05 }); });
$('rcs-lh-plus').addEventListener('click', function () { rcSendObj({ t: 'cmd', cmd: 'adj', key: 'lineHeight', delta: 0.05 }); });
$('rcs-guide-minus').addEventListener('click', function () { rcSendObj({ t: 'cmd', cmd: 'adj', key: 'guide', delta: -2 }); });
$('rcs-guide-plus').addEventListener('click', function () { rcSendObj({ t: 'cmd', cmd: 'adj', key: 'guide', delta: 2 }); });
$('rcs-colors').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  rcSendObj({ t: 'cmd', cmd: 'set', key: 'colors', value: b.getAttribute('data-colors') });
});
$('rcs-font').addEventListener('click', function (e) {
  var b = e.target.closest('button'); if (!b) return;
  rcSendObj({ t: 'cmd', cmd: 'set', key: 'font', value: b.getAttribute('data-font') });
});
$('rcs-mirror').addEventListener('change', function () { rcSendObj({ t: 'cmd', cmd: 'set', key: 'mirror', value: this.checked }); });
$('rcs-autorestart').addEventListener('change', function () { rcSendObj({ t: 'cmd', cmd: 'set', key: 'autoRestart', value: this.checked }); });

/* ===================== BANNER INSTALACJI ===================== */
var deferredInstall = null;
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  deferredInstall = e;
  maybeShowInstallBanner();
});
function isStandalone() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
}
function maybeShowInstallBanner() {
  if (isStandalone()) return;
  var dismissed = false;
  try { dismissed = localStorage.getItem('teleprompter.installDismissed') === '1'; } catch (e) {}
  if (dismissed) return;
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var txt = $('install-text');
  if (isIOS) {
    txt.innerHTML = '<strong>Zainstaluj aplikację:</strong> naciśnij przycisk Udostępnij <span style="font-size:16px">⎋</span> w Safari, a potem „Do ekranu początkowego".';
  } else if (deferredInstall) {
    txt.innerHTML = '<strong>Zainstaluj aplikację</strong> na ekranie głównym — działa też offline.';
    $('btn-install').hidden = false;
  } else {
    txt.innerHTML = '<strong>Zainstaluj aplikację:</strong> menu przeglądarki (⋮) → „Dodaj do ekranu głównego".';
  }
  $('install-banner').hidden = false;
}
$('btn-install').addEventListener('click', function () {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  deferredInstall.userChoice.then(function () {
    deferredInstall = null;
    $('install-banner').hidden = true;
  });
});
$('btn-install-close').addEventListener('click', function () {
  try { localStorage.setItem('teleprompter.installDismissed', '1'); } catch (e) {}
  $('install-banner').hidden = true;
});

/* ===================== SERVICE WORKER ===================== */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline będzie niedostępny — apka działa */ });
  });
}

/* ===================== START ===================== */
storeLoad();
var params = new URLSearchParams(location.search);
var pilotCode = params.get('pilot');
if (pilotCode) {
  openRemoteScreen(pilotCode.trim().toUpperCase());
} else {
  renderLibrary();
  maybeShowInstallBanner();
}

})();
