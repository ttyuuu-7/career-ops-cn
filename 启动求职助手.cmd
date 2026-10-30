@echo off
setlocal EnableExtensions
title Lixingtianxia AI Job Assistant

rem ============================================================
rem  Lixingtianxia launcher - starts CodeBuddy CLI in project root
rem  Keep this file PURE ASCII. Chinese docs: see the guide file.
rem ============================================================

set "PROJ=%~dp0"
if "%PROJ:~-1%"=="\" set "PROJ=%PROJ:~0,-1%"
cd /d "%PROJ%"

set "CBC=%USERPROFILE%\.codebuddy-cli\codebuddy.cmd"

echo.
echo  ==========================================================
echo   Lixingtianxia  ^|  AI Job Search Assistant
echo  ==========================================================
echo.
echo   Checking Node.js ...
echo.

rem ---------- locate a usable Node.js (>= 18) ----------
set "NODEEXE="

if exist "%ProgramFiles%\nodejs\node.exe" call :try "%ProgramFiles%\nodejs\node.exe"
if defined NODEEXE goto :found

if exist "%ProgramFiles(x86)%\nodejs\node.exe" call :try "%ProgramFiles(x86)%\nodejs\node.exe"
if defined NODEEXE goto :found

if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" call :try "%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined NODEEXE goto :found

if exist "%APPDATA%\npm\node.exe" call :try "%APPDATA%\npm\node.exe"
if defined NODEEXE goto :found

call :scanwb
if defined NODEEXE goto :found

call :trywhere
if defined NODEEXE goto :found

echo  [ERROR] No Node.js 18+ found on this computer.
echo.
echo  Lixingtianxia needs Node.js 18 or newer.
echo  Install the LTS build from https://nodejs.org
echo  then run this launcher again.
echo.
pause
exit /b 1

:found
rem --- put this Node's own folder FIRST on PATH so a bare "node" resolves here ---
for %%I in ("%NODEEXE%") do set "NODEDIR=%%~dpI"
set "PATH=%NODEDIR%;%PATH%"

echo   Node.js : %NODEEXE%
echo   Node dir: %NODEDIR%
echo.

rem ---------- sanity check ----------
if not exist "%CBC%" goto :nocli

where node
echo.
echo   Data dir: %PROJ%
echo   CLI     : %CBC%
echo.
echo  ----------------------------------------------------------
echo   Login: already done. If not, a browser opens automatically.
echo   Free trial: 500 credits / month.
echo  ----------------------------------------------------------
echo.
echo   Try asking:
echo     evaluate this job: ^<paste the JD here^>
echo     review my resume
echo.
echo  ==========================================================
echo.

rem --- use a fixed free port: the CLI dies silently (EADDRINUSE)
rem --- if its auto-chosen port is taken by another process.
set "CB_PORT=52888"

"%CBC%" --add-dir "%PROJ%" --port %CB_PORT%
set "RC=%ERRORLEVEL%"

echo.
echo  ==========================================================
echo   Session ended (exit code %RC%)
echo  ==========================================================
echo.
pause
exit /b %RC%

:nocli
echo  [ERROR] CodeBuddy CLI not found at:
echo          %CBC%
echo.
echo  Reinstall with this one line:
echo.
echo    "%NODEDIR%npm.cmd" install -g @tencent-ai/codebuddy-code --prefix "%USERPROFILE%\.codebuddy-cli" --registry=https://registry.npmmirror.com
echo.
pause
exit /b 1


rem ---------- subroutine: validate a node candidate ----------
:try
if defined NODEEXE exit /b 0
if not exist %1 exit /b 0
%1 -e "process.exit(Math.min(18, +process.versions.node.split('.')[0]) - 18 ? 1 : 0)" >nul 2>&1
if errorlevel 1 exit /b 0
set "NODEEXE=%~f1"
exit /b 0

rem ---------- subroutine: scan WorkBuddy bundled node versions ----------
:scanwb
if not exist "%USERPROFILE%\.workbuddy\binaries\node\versions\" exit /b 0
for /f "delims=" %%D in ('dir /b /ad /o-n "%USERPROFILE%\.workbuddy\binaries\node\versions" 2^>nul') do call :try "%USERPROFILE%\.workbuddy\binaries\node\versions\%%D\node.exe"
exit /b 0

rem ---------- subroutine: accept PATH node if it is >= 18 ----------
:trywhere
for /f "delims=" %%P in ('where node 2^>nul') do call :try "%%P"
exit /b 0
