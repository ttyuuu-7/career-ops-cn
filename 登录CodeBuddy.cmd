@echo off
rem Re-login the CodeBuddy CLI. When the token expires the eval page says
rem "Authentication required" - running this opens the interactive login.
setlocal
set "CB=%USERPROFILE%\.codebuddy-cli\codebuddy.cmd"
if not exist "%CB%" (
  echo [X] CodeBuddy CLI not found at:
  echo     %CB%
  echo Install it first, then run this again.
  pause
  exit /b 1
)
echo ============================================================
echo  CodeBuddy re-login
echo  - A browser page will open for sign-in. Complete it there.
echo  - When the chat prompt shows up, you are logged in.
echo  - Then close this window and retry the evaluation page.
echo ============================================================
echo.
"%CB%"
echo.
echo Session ended. If the prompt worked, login is OK - close this
echo window and retry the evaluation page in the console.
pause
