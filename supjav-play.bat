@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0scripts\supjav-play.py"
) else (
  python "%~dp0scripts\supjav-play.py"
)
