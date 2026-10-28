@echo off
rem Installs Cortex for this Windows user. Uses only the bundled, signed Python from python.org.
cd /d "%~dp0"
"%~dp0python\python.exe" "%~dp0install.py" %*
if errorlevel 1 (
  echo.
  echo Cortex could not be installed. See the message above.
  pause
)
