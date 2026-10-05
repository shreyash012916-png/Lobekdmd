@echo off
setlocal
cd /d "%~dp0"
echo.
echo ORBITA Mission Control
node --version
if errorlevel 1 (
  echo Node.js 20+ is required.
  pause
  exit /b 1
)
echo Starting ORBITA on http://localhost:10000
node server.js
pause
