const $ = (selector) => document.querySelector(selector);

const state = {
  history: [],
  simulate: localStorage.getItem('orbita.sim') === '1',
  agricultureUrl: localStorage.getItem('orbita.ag') || '',
  industryUrl: localStorage.getItem('orbita.ind') || '',
  speakReplies: localStorage.getItem('orbita.speak') !== '0',
  status: {},
  sessionId: '',
  busy: false,
  recognition: null,
  listening: false,
  document: null,
};

const esc = (value) => String(value).replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[char]));

function log(message, type = '') {
  const el = $('#log');
  const row = document.createElement('div');
  row.className = `log-entry ${type}`;
  row.innerHTML = `<time>${new Date().toLocaleTimeString([], { hour12: false })}</time><span>${esc(message)}</span>`;
  el.prepend(row);
}

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function setStatus(selector, online) {
  const el = $(selector);
  el.classList.toggle('online', online);
  el.innerHTML = `<i></i> ${online ? 'ONLINE' : 'OFFLINE'}`;
}

function formatNumber(value, suffix = '') {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}${suffix}` : '—';
}

function boolText(value) { return value === true ? 'ON' : value === false ? 'OFF' : '—'; }

function renderStatus(data) {
  state.status = data;
  setStatus('#agStatus', Boolean(data.agriculture?.online));
  setStatus('#inStatus', Boolean(data.industry?.online));
  $('#soil').textContent = formatNumber(data.agriculture?.soil);
  $('#tank').textContent = formatNumber(data.agriculture?.waterTank);
  $('#air').textContent = formatNumber(data.agriculture?.temperature);
  $('#pumpState').textContent = boolText(data.agriculture?.pump);
  $('#autoState').textContent = boolText(data.agriculture?.auto);
  $('#load').textContent = formatNumber(data.industry?.load);
  $('#vibration').textContent = Number.isFinite(Number(data.industry?.vibration)) ? Number(data.industry.vibration).toFixed(2) : '—';
  $('#indAir').textContent = formatNumber(data.industry?.temperature);
  $('#machineState').textContent = boolText(data.industry?.machine);
  const cam = data.industry?.camera || '';
  $('#cameraState').textContent = cam ? 'LINK' : '—';
  if (cam) {
    $('#camImage').src = cam;
    $('#camImage').hidden = false;
    $('#camPlaceholder').hidden = true;
  } else {
    $('#camImage').hidden = true;
    $('#camPlaceholder').hidden = false;
  }
}

function isPrivateTarget(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (['localhost', '127.0.0.1'].includes(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    const parts = host.split('.').map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    return false;
  } catch { return false; }
}

function mixedContentWarning(url) {
  return location.protocol === 'https:' && /^http:\/\//i.test(url) && isPrivateTarget(url)
    ? 'The page is HTTPS but the ESP is HTTP on a private LAN; this browser may block the control request. Run ORBITA locally on the same Wi-Fi for the exhibition, or serve the ESP endpoint over HTTPS.'
    : '';
}

async function esp(zone, paths, options = {}) {
  const base = zone === 'agriculture' ? state.agricultureUrl : state.industryUrl;
  if (!base) throw new Error(`${zone === 'agriculture' ? 'Agriculture' : 'Industry'} ESP IP is not configured.`);
  const warning = mixedContentWarning(base);
  if (warning) throw new Error(warning);
  const root = base.replace(/\/+$/, '');
  let last = '';
  for (const path of paths) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2600);
    try {
      const response = await fetch(root + path, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        cache: 'no-store',
      });
      if (response.ok) return await response.json().catch(() => ({ ok: true }));
      last = `${path} → HTTP ${response.status}`;
    } catch (error) {
      last = error?.name === 'AbortError' ? `${path} → timeout` : `${path} → ${error.message}`;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(last || 'ESP request failed.');
}

async function readStatus(zone) { return esp(zone, ['/api/status', '/status']); }

async function getStatus(silent = false) {
  if (state.simulate) {
    const simulated = {
      ok: true,
      agriculture: { online: true, soil: 34, pump: false, auto: true, waterTank: 86, temperature: 27.2, humidity: 61 },
      industry: { online: true, machine: true, temperature: 31.1, vibration: 0.08, load: 43, camera: '' },
    };
    renderStatus(simulated);
    if (!silent) log('Simulation telemetry synchronized.', 'ok');
    return simulated;
  }
  const data = { ok: true };
  for (const zone of ['agriculture', 'industry']) {
    const configured = zone === 'agriculture' ? state.agricultureUrl : state.industryUrl;
    if (!configured) {
      data[zone] = { online: false, error: 'Not configured' };
      continue;
    }
    try {
      const x = await readStatus(zone);
      if (zone === 'agriculture') {
        data[zone] = {
          online: true,
          soil: Number(x.soil ?? x.soilMoisture ?? x.moisture),
          pump: Boolean(x.pump ?? x.pumpOn),
          auto: Boolean(x.auto ?? x.automatic),
          waterTank: Number(x.waterTank ?? x.tank),
          temperature: Number(x.temperature ?? x.temp),
          humidity: Number(x.humidity ?? 0),
        };
      } else {
        data[zone] = {
          online: true,
          machine: Boolean(x.machine ?? x.machineOn ?? x.motor),
          temperature: Number(x.temperature ?? x.temp),
          vibration: Number(x.vibration ?? 0),
          load: Number(x.load ?? 0),
          camera: x.camera ?? x.stream ?? x.cameraUrl ?? '',
        };
      }
    } catch (error) {
      data[zone] = { online: false, error: error.message };
    }
  }
  renderStatus(data);
  if (!silent) log('Telemetry synchronized.', 'ok');
  return data;
}

async function action(zone, actionName) {
  if (state.simulate) {
    log(`SIMULATION ✓ ${actionName.replaceAll('_', ' ')} → ${zone}.`, 'ok');
    updateMissionState('SIMULATION');
    return true;
  }
  try {
    let paths;
    let body;
    if (zone === 'agriculture' && actionName.startsWith('pump_')) {
      paths = ['/api/pump', '/pump']; body = { on: actionName === 'pump_on' };
    } else if (zone === 'agriculture' && actionName.startsWith('auto_')) {
      paths = ['/api/auto', '/auto']; body = { enabled: actionName === 'auto_on' };
    } else if (zone === 'industry' && actionName.startsWith('machine_')) {
      paths = ['/api/machine', '/machine']; body = { on: actionName === 'machine_on' };
    } else if (zone === 'industry' && actionName === 'emergency_stop') {
      paths = ['/api/stop', '/stop']; body = { stop: true };
    } else {
      throw new Error(`Unsupported action: ${actionName}`);
    }
    await esp(zone, paths, { method: 'POST', body });
    log(`✓ ${actionName.replaceAll('_', ' ')} confirmed by ${zone}.`, 'ok');
    await getStatus(true);
    return true;
  } catch (error) {
    log(`Hardware command failed: ${error.message}`, 'error');
    toast(error.message, 'error');
    return false;
  }
}

function addBubble(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `bubble ${role}`;
  wrap.innerHTML = `<small>${role === 'bot' ? 'ORBITA' : 'YOU'}</small><p>${esc(text)}</p>`;
  $('#chat').appendChild(wrap);
  $('#chat').scrollTop = $('#chat').scrollHeight;
}

function setCommandState(label, busy = false) {
  $('#commandState').textContent = label;
  $('#sendBtn').disabled = busy;
  $('#sendBtn').classList.toggle('busy', busy);
  $('#commandInput').disabled = busy;
  state.busy = busy;
}

function updateMissionState(label) {
  $('#missionState').textContent = label;
}

function speak(text) {
  if (!state.speakReplies || !('speechSynthesis' in window) || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.96;
  utterance.pitch = 0.9;
  utterance.volume = 1;
  utterance.lang = 'en-IN';
  window.speechSynthesis.speak(utterance);
}

async function sendMessage(prefilled = '') {
  if (state.busy) return;
  const input = $('#commandInput');
  const message = (prefilled || input.value).trim();
  if (!message) return;
  input.value = '';
  addBubble('user', message);
  log(`USER → ${message}`);
  setCommandState('ORBITA THINKING…', true);
  updateMissionState('ANALYZING');
  const started = performance.now();
  try {
    const response = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        history: state.history,
        status: state.status,
        sessionId: state.sessionId,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `Assistant unavailable (HTTP ${response.status}).`);
    const elapsed = Math.round(performance.now() - started);
    $('#latency').textContent = `${elapsed} ms`;
    state.history.push({ role: 'user', text: message }, { role: 'assistant', text: data.reply });
    state.history = state.history.slice(-10);
    addBubble('bot', data.reply);
    log(`ORBITA → ${data.reply}`, 'ok');
    $('#modelName').textContent = String(data.model || 'GEMINI 3.8 FLASH').toUpperCase();
    updateMissionState((data.actions || []).length ? 'EXECUTING' : 'SYSTEM NOMINAL');
    for (const planned of data.actions || []) await action(planned.zone, planned.action);
    speak(data.reply);
    setCommandState('READY', false);
    updateMissionState('SYSTEM NOMINAL');
  } catch (error) {
    addBubble('bot', `I couldn't complete that: ${error.message}`);
    log(`Assistant error: ${error.message}`, 'error');
    toast(error.message, 'error');
    setCommandState('READY', false);
    updateMissionState('LINK CHECK');
  }
}

function setupVoice() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    $('#voiceLabel').textContent = 'TEXT VOICE UNAVAILABLE';
    $('#voiceTech').textContent = 'TEXT FALLBACK';
    $('#voiceStatus').textContent = 'VOICE INPUT LIMITED';
    log('Speech recognition is not available in this browser. Text commands remain active.');
    return;
  }
  const recognition = new Recognition();
  state.recognition = recognition;
  recognition.lang = 'en-IN';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    state.listening = true;
    $('#voiceBtn').classList.add('recording');
    $('#voiceLabel').textContent = 'LISTENING…';
    $('#voiceStatus').textContent = 'MIC LIVE';
    updateMissionState('LISTENING');
  };
  recognition.onresult = (event) => {
    const last = event.results[event.results.length - 1];
    const transcript = last?.[0]?.transcript || '';
    $('#commandInput').value = transcript;
    if (last.isFinal) sendMessage(transcript);
  };
  recognition.onerror = (event) => {
    state.listening = false;
    $('#voiceBtn').classList.remove('recording');
    $('#voiceLabel').textContent = 'TALK TO ORBITA';
    $('#voiceStatus').textContent = 'VOICE READY';
    log(`Voice input error: ${event.error}.`, 'error');
    toast(`Voice input: ${event.error}.`, 'error');
    updateMissionState('SYSTEM NOMINAL');
  };
  recognition.onend = () => {
    state.listening = false;
    $('#voiceBtn').classList.remove('recording');
    $('#voiceLabel').textContent = 'TALK TO ORBITA';
    $('#voiceStatus').textContent = 'VOICE READY';
    if (!state.busy) updateMissionState('SYSTEM NOMINAL');
  };

  $('#voiceBtn').addEventListener('click', () => {
    if (state.listening) { recognition.stop(); return; }
    if (state.busy) return;
    try { recognition.start(); }
    catch { log('Microphone is already starting.'); }
  });
}

async function healthCheck() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const data = await response.json();
    $('#aiStatus').textContent = data.gemini ? 'LINKED' : 'ADD API KEY';
    $('#aiStatus').className = data.gemini ? 'linked' : '';
    $('#modelName').textContent = String(data.model || 'GEMINI 3.8 FLASH').toUpperCase();
    $('#missionState').textContent = data.gemini ? 'SYSTEM NOMINAL' : 'GEMINI KEY REQUIRED';
    log(data.gemini ? 'Gemini intelligence link ready.' : 'Gemini is not configured yet. Add GEMINI_API_KEY on Render.', data.gemini ? 'ok' : 'error');
  } catch (error) {
    $('#aiStatus').textContent = 'SERVER ERROR';
    log(`Health check failed: ${error.message}`, 'error');
  }
}

function openSettings() {
  $('#agUrl').value = state.agricultureUrl;
  $('#indUrl').value = state.industryUrl;
  $('#simulate').checked = state.simulate;
  $('#speakReplies').checked = state.speakReplies;
  $('#settingsModal').classList.add('open');
  $('#settingsModal').setAttribute('aria-hidden', 'false');
}

function closeSettings() {
  $('#settingsModal').classList.remove('open');
  $('#settingsModal').setAttribute('aria-hidden', 'true');
}

async function uploadPdf(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) return toast('Please choose a PDF file.', 'error');
  if (file.size > 10 * 1024 * 1024) return toast('Keep the PDF under 10 MB.', 'error');
  $('#briefState').textContent = 'READING…';
  $('#dropZone').classList.add('loading');
  log(`Uploading mission brief: ${file.name}`);
  const form = new FormData();
  form.append('file', file);
  try {
    const response = await fetch('/api/instructions', { method: 'POST', body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `PDF upload failed (HTTP ${response.status}).`);
    state.sessionId = data.sessionId;
    state.document = { name: data.name, summary: data.summary };

    $('#briefState').textContent = 'ACTIVE';
    $('#briefName').textContent = data.name;
    $('#briefSummary').textContent = data.summary || 'Brief loaded.';
    $('#briefFile').hidden = false;
    $('#dropZone').hidden = true;
    addBubble('bot', `Mission brief loaded: ${data.name}. I’ll use it when answering document-specific questions.`);
    log('Mission brief processed by Gemini.', 'ok');
    toast('Mission brief active.', 'ok');
  } catch (error) {
    $('#briefState').textContent = 'ERROR';
    log(`Brief error: ${error.message}`, 'error');
    toast(error.message, 'error');
  } finally {
    $('#dropZone').classList.remove('loading');
    $('#pdfInput').value = '';
  }
}

function clearBrief() {
  state.sessionId = '';
  state.document = null;

  $('#briefFile').hidden = true;
  $('#dropZone').hidden = false;
  $('#briefState').textContent = 'NO FILE';
  log('Mission brief removed.');
}

function bind() {
  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => action(button.dataset.zone, button.dataset.action));
  });
  document.querySelectorAll('[data-prompt]').forEach((button) => {
    button.addEventListener('click', () => sendMessage(button.dataset.prompt));
  });
  $('#sendBtn').addEventListener('click', () => sendMessage());
  $('#commandInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); sendMessage(); }
  });
  $('#clearLog').addEventListener('click', () => { $('#log').innerHTML = ''; });
  $('#clearChat').addEventListener('click', () => { $('#chat').innerHTML = '<div class="bubble bot"><small>ORBITA</small><p>Console cleared. Mission control ready.</p></div>'; state.history = []; });
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#closeSettings').addEventListener('click', closeSettings);
  $('#settingsModal').addEventListener('click', (event) => { if (event.target === $('#settingsModal')) closeSettings(); });
  $('#saveSettings').addEventListener('click', async () => {
    state.agricultureUrl = $('#agUrl').value.trim();
    state.industryUrl = $('#indUrl').value.trim();
    state.simulate = $('#simulate').checked;
    state.speakReplies = $('#speakReplies').checked;
    localStorage.setItem('orbita.ag', state.agricultureUrl);
    localStorage.setItem('orbita.ind', state.industryUrl);
    localStorage.setItem('orbita.sim', state.simulate ? '1' : '0');
    localStorage.setItem('orbita.speak', state.speakReplies ? '1' : '0');
    closeSettings();
    $('#demoBtn').textContent = state.simulate ? 'SIMULATION ON' : 'SIMULATION OFF';
    log('System configuration saved.', 'ok');
    await getStatus();
  });
  $('#testVoice').addEventListener('click', () => speak('ORBITA voice link is active. Mission control is ready.'));
  $('#testConnections').addEventListener('click', async () => {
    const result = $('#testResult');
    result.textContent = 'Testing links…';
    const data = await getStatus(true);
    result.textContent = `Agriculture: ${data.agriculture?.online ? 'ONLINE' : 'OFFLINE'} · Industry: ${data.industry?.online ? 'ONLINE' : 'OFFLINE'}`;
  });
  $('#demoBtn').addEventListener('click', async () => {
    state.simulate = !state.simulate;
    localStorage.setItem('orbita.sim', state.simulate ? '1' : '0');
    $('#demoBtn').textContent = state.simulate ? 'SIMULATION ON' : 'SIMULATION OFF';
    log(state.simulate ? 'Simulation mode enabled. No hardware calls will be sent.' : 'Simulation mode disabled.', state.simulate ? 'ok' : '');
    await getStatus();
  });
  $('#pdfInput').addEventListener('change', (event) => uploadPdf(event.target.files?.[0]));
  ['dragenter', 'dragover'].forEach(type => $('#dropZone').addEventListener(type, (event) => { event.preventDefault(); $('#dropZone').classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(type => $('#dropZone').addEventListener(type, (event) => { event.preventDefault(); $('#dropZone').classList.remove('drag'); }));
  $('#dropZone').addEventListener('drop', (event) => uploadPdf(event.dataTransfer.files?.[0]));
  $('#clearBrief').addEventListener('click', clearBrief);
  if (state.simulate) $('#demoBtn').textContent = 'SIMULATION ON';
}

function boot() {
  bind();
  setupVoice();
  $('#speakReplies').checked = state.speakReplies;
  $('#voiceTech').textContent = state.recognition ? 'BROWSER VOICE' : 'TEXT FALLBACK';
  const privateNotice = location.protocol === 'https:' ? 'HTTPS CONTROL PAGE' : 'LOCAL CONTROL PAGE';
  $('#networkMode').textContent = `CONTROL BUS: BROWSER → ESP32 · ${privateNotice}`;
  $('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
  log('ORBITA interface initialized.', 'ok');
  if (state.speakReplies && 'speechSynthesis' in window) log('Voice output ready.');
  healthCheck();
  getStatus(true);

}

setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false }); }, 1000);
setInterval(() => { if (!state.busy) getStatus(true); }, 6000);

window.addEventListener('error', (event) => {
  log(`UI error: ${event.message}`, 'error');
});
window.addEventListener('unhandledrejection', (event) => {
  log(`Async error: ${event.reason?.message || event.reason || 'unknown error'}`, 'error');
});

document.addEventListener('DOMContentLoaded', boot);
