@echo off
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0supjav-play.py"
) else (
  python "%~dp0supjav-play.py"
)
