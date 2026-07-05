@echo off
setlocal
cd /d "%~dp0"

if not exist "data\" mkdir "data"

rem Files read directly by supjav-play.py: keep paths, clear contents.
type nul > "data\supjav-export.txt"
> "data\supjav-potplayer-library.json" echo {"version":1,"items":{}}

rem Generated media cache and resume state JSON: delete and let the app rebuild.
for %%D in ("cache" "data\supjav-potplayer-states" "supjav-potplayer-cache" "supjav-potplayer-states") do (
  if exist "%%~D\" rmdir /s /q "%%~D"
)

mkdir "data\supjav-potplayer-states" >nul 2>nul

for %%F in ("supjav-export.txt" "supjav-potplayer-library.json") do (
  if exist "%%~F" del /f /q "%%~F"
)

echo Supjav cache and history data cleared.
pause
