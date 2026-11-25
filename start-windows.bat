@echo off
rem Mezuzah Checker - PC program. Keep this window open while you want the phone to sync.
cd /d "%~dp0"
where node >nul 2>nul || (echo Please install Node.js LTS from https://nodejs.org first. & pause & exit /b 1)
where tailscale >nul 2>nul && tailscale serve --bg 8080 >nul 2>nul
start "" http://localhost:8080/
node pc\server.js --port 8080
pause
