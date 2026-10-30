@echo off
setlocal EnableExtensions
title BOSS Login - Lixingtianxia

rem ============================================================
rem  Lixingtianxia BOSS login launcher
rem  Opens the BOSS login page directly (https://login.zhipin.com/),
rem  you log in there, come back and press ENTER -- the session is
rem  saved to data\cookies\boss.json.
rem
rem  KEEP THIS FILE PURE ASCII. Chinese inside a .cmd gets mangled
rem  by the GBK code page and can even break the parser
rem  ("... is not a recognized command"). All user-facing Chinese
rem  comes from the Node script instead.
rem
rem  Why login.zhipin.com and not www.zhipin.com: measured -- the
rem  homepage redirects by city (extra hop, easy to land on a blank
rem  intermediate state), and /login or /web/geek/job/ both bounce
rem  to a "security verification" page. The login subdomain opens
rem  the actual form (phone + SMS code) on the first try.
rem ============================================================

set "PROJ=%~dp0"
if "%PROJ:~-1%"=="\" set "PROJ=%PROJ:~0,-1%"
cd /d "%PROJ%"

echo.
echo  ==========================================================
echo   BOSS Login  ^|  Lixingtianxia
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
echo   Install the LTS build from https://nodejs.org
echo   then run this launcher again.
echo.
pause
exit /b 1

:found
rem --- put this Node's own folder FIRST on PATH so a bare "node" resolves here ---
for %%I in ("%NODEEXE%") do set "NODEDIR=%%~dpI"
set "PATH=%NODEDIR%;%PATH%"

echo   Node.js : %NODEEXE%
"%NODEEXE%" -v
echo.
echo  ----------------------------------------------------------
echo   A browser window will open on the BOSS login page.
echo   Log in there, then come back to THIS window and press ENTER.
echo.
echo   Not seeing the login page? Look for the window whose title
echo   mentions zhipin / BOSS. This black console window is not it.
echo   Blank page? Wait 5 minutes and retry -- BOSS rate-limits
echo   repeated opens and silently shows a blank page.
echo   Old blank window from an earlier try left open? The script
echo   now detects it, clears it and retries automatically. Worst
echo   case it uses a one-shot window -- login still saves cookies.
echo  ----------------------------------------------------------
echo.

"%NODEEXE%" save-cookies-boss.mjs --persist %*
set "RC=%ERRORLEVEL%"

echo.
echo  ==========================================================
echo   Done (exit code %RC%)
echo  ==========================================================
echo.
pause
exit /b %RC%


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
