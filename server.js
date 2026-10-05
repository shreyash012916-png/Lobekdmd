import http from 'node:http';
import { extname, join, normalize } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\\/]$/, '');
const PORT = Number(process.env.PORT || 10000);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() || '';
const GEMINI_API_BASE = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
const JSON_LIMIT = 256 * 1024;
const PDF_LIMIT = 10 * 1024 * 1024;
const DOCUMENT_TTL_MS = 55 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const ALLOWED = new Set([
  'pump_on',
  'pump_off',
  'auto_on',
  'auto_off',
  'machine_on',
  'machine_off',
  'emergency_stop',
]);

const sessions = new Map();

const SYSTEM = `You are ORBITA, the calm voice of a school science-exhibition mission-control system.

The physical exhibit has two zones:
1. AGRICULTURE: ESP32, soil-moisture sensor, water pump, automatic irrigation.
2. INDUSTRY: ESP32/ESP32-CAM and a demonstrator machine.

Your responsibilities:
- Answer naturally and fluently.
- Never invent sensor readings; use CURRENT STATUS only when supplied.
- Understand conversational requests such as "check the farm", "is the soil dry?", "turn the pump on", or "stop the machine".
- When a physical action is explicitly requested or clearly necessary, return a validated action.
- Automatic irrigation means the ESP32 performs the actual moisture-threshold decision; you may enable/disable auto mode but must not claim you physically measured the soil yourself.
- Emergency stop is allowed only when the user clearly requests a shutdown/stop.
- If the request is ambiguous, ask a concise clarification and return no actions.

Return JSON only with this shape:
{
  "reply": "natural language answer",
  "actions": [
    {"zone":"agriculture|industry","action":"pump_on|pump_off|auto_on|auto_off|machine_on|machine_off|emergency_stop"}
  ]
}
Do not return Markdown fences.`;

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body) || body instanceof Uint8Array;
  const data = isBuffer ? Buffer.from(body) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const contentType = headers['Content-Type'] || (isBuffer ? 'application/octet-stream' : 'application/json; charset=utf-8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

async function readJson(req, maxBytes = JSON_LIMIT) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('Request is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { statusCode: 400 }); }
}

function safePath(urlPath) {
  const pathname = decodeURIComponent((urlPath || '/').split('?')[0]);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const normalized = normalize(join(ROOT, relative));
  if (normalized !== ROOT && !normalized.startsWith(ROOT + '/')) return null;
  return normalized;
}

async function staticFile(urlPath, res) {
  const filepath = safePath(urlPath);
  if (!filepath) return send(res, 403, { ok: false, error: 'Forbidden.' });
  try {
    const data = await readFile(filepath);
    const type = MIME[extname(filepath).toLowerCase()] || 'application/octet-stream';
    return send(res, 200, data, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  } catch (error) {
    if (error.code === 'ENOENT') return send(res, 404, { ok: false, error: 'Not found.' });
    return send(res, 500, { ok: false, error: 'Could not read resource.' });
  }
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, value] of sessions) {
    if (now - value.createdAt > DOCUMENT_TTL_MS) sessions.delete(id);
  }
}

function getSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) return null;
  const session = sessions.get(sessionId);
  if (Date.now() - session.createdAt > DOCUMENT_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function sanitizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter(action =>
      action &&
      (action.zone === 'agriculture' || action.zone === 'industry') &&
      ALLOWED.has(action.action),
    )
    .slice(0, 5);
}

function parseGeminiText(text) {
  const cleaned = String(text || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned || '{}');
    return {
      reply: String(parsed.reply || 'I received that command.').slice(0, 1600),
      actions: sanitizeActions(parsed.actions),
    };
  } catch {
    return { reply: cleaned || 'I could not parse the mission response.', actions: [] };
  }
}

function buildHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-8).map(item => ({
    role: item?.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(item?.text || '').slice(0, 1400) }],
  }));
}

async function callGemini({ message, history, status, document }) {
  const context = {
    currentStatus: status || {},
    missionBriefSummary: document?.summary || '',
  };
  const prompt = `${SYSTEM}\n\nMISSION CONTEXT:\n${JSON.stringify(context).slice(0, 7000)}\n\nUSER REQUEST:\n${message}`;
  const parts = [{ text: prompt }];

  if (document?.base64 && /pdf|brief|document|instruction|plan|according|file|uploaded/i.test(message)) {
    parts.push({ inlineData: { mimeType: document.mimeType, data: document.base64 } });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(
      `${GEMINI_API_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [...buildHistory(history), { role: 'user', parts }],
          generationConfig: {
            temperature: 0.25,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                reply: { type: 'STRING' },
                actions: {
                  type: 'ARRAY',
                  items: {
                    type: 'OBJECT',
                    properties: {
                      zone: { type: 'STRING', enum: ['agriculture', 'industry'] },
                      action: { type: 'STRING', enum: [...ALLOWED] },
                    },
                    required: ['zone', 'action'],
                  },
                },
              },
              required: ['reply', 'actions'],
            },
          },
        }),
        signal: controller.signal,
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `Gemini returned HTTP ${response.status}.`);
    const text = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
    return parseGeminiText(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function uploadPdf(req, res) {
  if (!GEMINI_API_KEY) return send(res, 503, { ok: false, error: 'Gemini is not configured. Add GEMINI_API_KEY in Render.' });
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > PDF_LIMIT + 1024 * 1024) return send(res, 413, { ok: false, error: 'PDF is too large. Keep the exhibition brief under 10 MB.' });

  const request = new Request(`http://orbita.local${req.url}`, {
    method: 'POST',
    headers: req.headers,
    body: req,
    duplex: 'half',
  });
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return send(res, 400, { ok: false, error: 'Choose a PDF file.' });
  if (file.type !== 'application/pdf' && !String(file.name || '').toLowerCase().endsWith('.pdf')) return send(res, 415, { ok: false, error: 'Only PDF files are supported.' });
  if (file.size > PDF_LIMIT) return send(res, 413, { ok: false, error: 'PDF is too large. Keep it under 10 MB.' });

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.subarray(0, 4).toString('ascii') !== '%PDF') return send(res, 400, { ok: false, error: 'The selected file does not look like a valid PDF.' });

  const base64 = buffer.toString('base64');
  const summaryParts = [
    { text: 'Read the attached PDF as the mission brief for this exhibition. Produce a compact operational summary in plain text with: project purpose, hardware zones, sensors/actuators, planned automation, commands the assistant should understand, safety notes, and any pin/IP/API details explicitly stated. Do not invent missing details.' },
    { inlineData: { mimeType: 'application/pdf', data: base64 } },
  ];

  let summary = '';
  try {
    const response = await fetch(
      `${GEMINI_API_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: summaryParts }], generationConfig: { temperature: 0.15 } }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || `Gemini returned HTTP ${response.status}.`);
    summary = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim() || 'PDF loaded. No summary was returned.';
  } catch (error) {
    return send(res, 502, { ok: false, error: `PDF was received but Gemini could not read it: ${error.message}` });
  }

  cleanupSessions();
  const id = crypto.randomUUID();
  sessions.set(id, {
    id,
    name: String(file.name || 'mission-brief.pdf').slice(0, 120),
    mimeType: 'application/pdf',
    base64,
    summary: summary.slice(0, 8000),
    createdAt: Date.now(),
  });
  return send(res, 200, { ok: true, sessionId: id, name: String(file.name || 'mission-brief.pdf'), summary: summary.slice(0, 8000) });
}

async function api(req, res) {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'GET' && url === '/api/health') {
    return send(res, 200, {
      ok: true,
      gemini: Boolean(GEMINI_API_KEY),
      model: GEMINI_MODEL,
      uptime: Number(process.uptime().toFixed(1)),
      node: process.version,
    });
  }

  if (req.method === 'POST' && url === '/api/instructions') {
    try { return await uploadPdf(req, res); }
    catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'PDF upload failed.' }); }
  }

  if (req.method === 'POST' && url === '/api/assistant') {
    if (!GEMINI_API_KEY) return send(res, 503, { ok: false, error: 'Gemini is not configured. Add GEMINI_API_KEY in Render Environment Variables.' });
    try {
      const data = await readJson(req);
      if (!String(data.message || '').trim()) return send(res, 400, { ok: false, error: 'Message is required.' });
      const document = getSession(String(data.sessionId || ''));
      const result = await callGemini({
        message: String(data.message).trim().slice(0, 3000),
        history: data.history,
        status: data.status,
        document,
      });
      return send(res, 200, { ok: true, ...result, model: GEMINI_MODEL, document: document ? { name: document.name, summary: document.summary } : null });
    } catch (error) {
      const isTimeout = error?.name === 'AbortError';
      return send(res, isTimeout ? 504 : 502, { ok: false, error: isTimeout ? 'Gemini took too long to respond. Try the command again.' : error.message || 'Gemini request failed.' });
    }
  }

  return send(res, 404, { ok: false, error: 'Unknown API route.' });
}

const server = http.createServer(async (req, res) => {
  try {
    if ((req.url || '').startsWith('/api/')) return await api(req, res);
    return await staticFile(req.url || '/', res);
  } catch (error) {
    return send(res, 500, { ok: false, error: error.message || 'Server error.' });
  }
});

server.headersTimeout = 35_000;
server.requestTimeout = 35_000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ORBITA listening on 0.0.0.0:${PORT}`);
  console.log(`Gemini: ${GEMINI_API_KEY ? 'configured' : 'NOT configured'}`);
});
