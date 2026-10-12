@echo off
rem Start the local Ollama server (127.0.0.1:11434) with models on D:\ollama.
rem The console's "local model" engine probes this port; when it is down the
rem AI pages say "CodeBuddy 与本地模型都不可用". Keep this window open while
rem using local-model features; close it to stop the server.
setlocal
set "OLLAMA_EXE=D:\ollama\ollama.exe"
set "OLLAMA_MODELS=D:\ollama\models"
if not exist "%OLLAMA_EXE%" (
  echo [X] ollama.exe not found at:
  echo     %OLLAMA_EXE%
  pause
  exit /b 1
)
rem Already running? Then nothing to do.
curl -s -m 2 -o nul http://127.0.0.1:11434/api/tags
if %errorlevel%==0 (
  echo [OK] Ollama is already running at 127.0.0.1:11434
  echo Close this window or press any key to exit.
  pause >nul
  exit /b 0
)
echo ============================================================
echo  Ollama starting...
echo  - Models dir: %OLLAMA_MODELS%
echo  - Keep this window OPEN while using local-model features.
echo  - Close this window to stop Ollama.
echo ============================================================
"%OLLAMA_EXE%" serve
pause
