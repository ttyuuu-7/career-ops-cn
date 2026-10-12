@echo off
chcp 65001 >nul
title career-ops console
color 0A
setlocal

rem ============================================================
rem  career-ops local console -- one-click launcher
rem  (this copy lives in the project root)
rem
rem  Usage:
rem    double-click .......... start the console
rem    start-ui.cmd --check .. environment check only, no server
rem
rem  IMPORTANT: keep this file ASCII-only, with CRLF line endings.
rem  Chinese characters inside a .cmd break cmd.exe line parsing
rem  while the console codepage is 65001, so all Chinese docs live
rem  in the separate text file and the HTML manual, never in here.
rem ============================================================

set "PROJ=%~dp0"
set "PORT=7317"

cd /d "%PROJ%" >nul 2>nul
if not exist "AGENTS.md" goto noproj

echo.
echo   career-ops console
echo   ==========================================================
echo   project : %CD%

if not exist "ui\server.mjs" goto noui
if not exist "node_modules\js-yaml" goto nodeps

rem -- pick a Node.js 18 or newer ------------------------------
rem  The node on PATH on this machine is v16.14.0 (shipped with
rem  Visual Studio tooling), older than this project requires, so
rem  every candidate is probed and only a valid one is accepted.
set "NODE_EXE="
call :probe "%ProgramFiles%\nodejs\node.exe"
call :probe "%ProgramFiles(x86)%\nodejs\node.exe"
call :probe "%LOCALAPPDATA%\Programs\nodejs\node.exe"
call :probe "%APPDATA%\npm\node.exe"
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do call :probe "%%~fD\node.exe"
if not defined NODE_EXE for /f "delims=" %%N in ('where node 2^>nul') do call :probe "%%~fN"
if not defined NODE_EXE goto nonode

echo   node    : %NODE_EXE%
echo   address : http://127.0.0.1:%PORT%
echo   stop    : press Ctrl+C in this window
echo   ==========================================================
echo.

if /i "%~1"=="--check" goto check

rem ---------- start local Ollama if present (job evaluation AI uses it) ----
rem  Evaluation is hard-locked to the local model (qwen2.5:7b). If the server
rem  is not listening on 11434, start it minimized with the models dir used
rem  on this machine. Missing ollama.exe is not fatal: the console will just
rem  show "local model offline".
set "OLLAMA_EXE=D:\ollama\ollama.exe"
if not exist "%OLLAMA_EXE%" goto ollama_done
netstat -ano 2>nul | find "127.0.0.1:11434" | find "LISTENING" >nul 2>nul
if not errorlevel 1 goto ollama_done
echo   Starting local Ollama (models: D:\ollama\models) on port 11434 ...
set "OLLAMA_MODELS=D:\ollama\models"
start "ollama-serve" /min "%OLLAMA_EXE%" serve
ping -n 3 127.0.0.1 >nul
:ollama_done

echo   Opening browser in about 2 seconds ...
echo.
start "" cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:%PORT%"
"%NODE_EXE%" ui\server.mjs --port %PORT%

echo.
echo   Server stopped. You can close this window.
echo   If it came back immediately, port %PORT% may already be in use.
echo.
pause
exit /b 0

rem -- helper: accept a candidate node only if its major is 18+ ---
:probe
if defined NODE_EXE exit /b 0
set "CAND=%~f1"
if not exist "%CAND%" exit /b 0
"%CAND%" -e "process.exit(Math.min(18, +process.versions.node.split('.')[0]) - 18 ? 1 : 0)" >nul 2>nul
if errorlevel 1 exit /b 0
set "NODE_EXE=%CAND%"
exit /b 0

:check
echo   [check] environment OK. Server NOT started.
echo.
pause
exit /b 0

:noproj
echo.
echo   [ERROR] AGENTS.md not found -- this file is not in the project root.
echo.
echo   current dir: %CD%
echo.
pause
exit /b 1

:noui
echo.
echo   [ERROR] missing ui\server.mjs
echo   Expected at: %CD%\ui\
echo.
pause
exit /b 1

:nodeps
echo.
echo   [ERROR] dependencies not installed.
echo   Run this once in this folder:
echo.
echo     npm install
echo.
pause
exit /b 1

:nonode
echo.
echo   [ERROR] Node.js 18 or newer not found.
echo.
echo   node currently on PATH:
for /f "delims=" %%N in ('where node 2^>nul') do echo     %%N
for /f "delims=" %%V in ('node --version 2^>nul') do echo     version %%V
echo.
echo   This project requires Node.js 18+ .
echo   Download the LTS build: https://nodejs.org
echo.
pause
exit /b 1
