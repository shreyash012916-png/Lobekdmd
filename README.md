# ORBITA — Smart Industry × Agriculture Mission Control

ORBITA is a Render-ready mission-control web app for a science-exhibition model with two ESP-controlled zones: **Agriculture** and **Industry**.

## What is fixed in Build 02

- Fixed the blank-page bug where HTML was being returned as a JSON-serialized Node Buffer instead of HTML.
- Added bounded request timeouts so Gemini or ESP requests cannot sit on an endless “buffering” state.
- Added explicit Gemini/server/voice/link states and visible error feedback.
- Added an immersive mission-control interface with live telemetry, console history, command bus, radar/core visuals, quick commands, and simulation mode.
- Added a **Mission Brief** dock: upload a PDF containing your project plan, instructions, pin notes, wiring notes, or exhibition script. Gemini reads it and ORBITA can use the resulting context for document-specific questions.
- Added a dedicated **TEST VOICE** button so you can verify that the browser is actually speaking before the exhibition starts.
- Kept the Gemini key server-side.
- Added short local ESP request timeouts and a clear HTTPS/private-LAN warning.

## Render deployment

Create a **Web Service** from the repository root.

Build command:

```text
npm install
```

Start command:

```text
npm start
```

Environment variables:

```text
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.8-flash
```

The server reads Render's `PORT` and listens on `0.0.0.0`.

## Local Windows run

Double-click `start.bat`, or run:

```text
node server.js
```

Then open `http://localhost:10000`.

For the physical exhibition, local hosting is normally the most reliable control arrangement because the device running the page and the ESP32 boards can be on the same Wi-Fi network.

## Gemini

The assistant uses Gemini through the server-side API. The current integration uses the Gemini `generateContent` endpoint and asks for structured JSON containing only `reply` and validated hardware `actions`.

The model default is `gemini-3.8-flash`, but `GEMINI_MODEL` can override it.

If `GEMINI_API_KEY` is missing, ORBITA remains usable for the interface and simulation mode, but real Gemini commands are intentionally disabled with a clear message.

## Voice

**Voice output:** uses the browser/device Web Speech `speechSynthesis` API. It is widely available across modern browsers.

**Voice input:** uses `SpeechRecognition` / `webkitSpeechRecognition` when the browser supports it. Speech recognition is not uniformly supported across browsers, so the text command bar is kept as a full fallback.

Use **TEST VOICE** in System Config before the exhibition. Then press **TALK TO ORBITA** and speak a command.

## Mission Brief PDF

Open **MISSION BRIEF** and upload a PDF under **10 MB**.

ORBITA will:

1. Send the PDF to Gemini for a compact operational summary.
2. Keep a temporary document session for about an hour.
3. Use the summary during normal assistant requests.
4. Attach the original PDF data to document-specific requests (for example: “According to the uploaded brief, what is the agriculture workflow?”).

This build intentionally keeps the local exhibition brief under 10 MB to avoid oversized browser/server requests. Google's current Gemini documentation allows PDF inputs up to 50 MB for the standard inline method, while larger/reused files can use the Files API.

## ESP32 API contract

Set the Agriculture and Industry base URLs in **System Config**.

Example:

```text
http://192.168.1.50
http://192.168.1.51
```

### Agriculture

```text
GET  /api/status
POST /api/pump     { "on": true }
POST /api/auto     { "enabled": true }
```

Expected status fields may include:

```json
{
  "soil": 38,
  "pump": false,
  "auto": true,
  "waterTank": 82,
  "temperature": 27.4,
  "humidity": 61
}
```

### Industry

```text
GET  /api/status
POST /api/machine { "on": true }
POST /api/stop    { "stop": true }
```

Expected status fields may include:

```json
{
  "online": true,
  "machine": false,
  "temperature": 31.2,
  "vibration": 0.08,
  "load": 42,
  "camera": "http://192.168.1.51/stream"
}
```

The dashboard also attempts legacy aliases (`/status`, `/pump`, `/auto`, `/machine`, `/stop`).

## Network reality for a school exhibition

A Render-hosted server is on the public internet and normally cannot reach an ESP32 at `192.168.x.x`. ORBITA therefore uses this control path:

```text
Browser → Gemini planner on Render → validated action → Browser → local ESP32
```

The browser must be able to reach the ESPs. If ORBITA is opened over HTTPS while the ESPs only expose plain HTTP, browser security may block the request. For the exhibition, run ORBITA locally on the control laptop/PC over the same Wi-Fi as the ESP32 boards, or expose the ESP endpoints through a properly secured HTTPS setup.

## Simulation mode

Enable **Simulation mode** from System Config or press **SIMULATION ON**. No hardware calls are sent. The dashboard shows realistic sample telemetry so you can rehearse the exhibition without the physical model.

## Safety behavior

Gemini is not given unrestricted HTTP control. Its output is validated against a fixed action allowlist before any browser-to-ESP command is attempted.

Allowed actions:

```text
pump_on
pump_off
auto_on
auto_off
machine_on
machine_off
emergency_stop
```

The firmware should still implement its own hardware-level safety limits. The web app is an exhibition control surface, not a substitute for electrical protection or motor-driver safety circuitry.
