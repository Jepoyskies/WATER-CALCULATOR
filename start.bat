@echo off
title Water Delivery Manager
cd /d "%~dp0"

set PORT=8000
set PYCMD=

rem 1) the "py" launcher that ships with python.org installs
where py >nul 2>nul && set PYCMD=py

rem 2) plain "python" on the PATH
if not defined PYCMD (
    where python >nul 2>nul && set PYCMD=python
)

rem 3) the usual per-user install location
if not defined PYCMD (
    if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set PYCMD="%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
)
if not defined PYCMD (
    if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set PYCMD="%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
)

if not defined PYCMD (
    echo.
    echo   Could not find Python on this computer.
    echo.
    echo   You can still open index.html directly by double-clicking it.
    echo   Everything works except that your browser may keep the saved
    echo   data tied to the file, so use the Backup tab often.
    echo.
    pause
    exit /b 1
)

echo.
echo   Water Delivery Manager
echo   ----------------------
echo   Starting the local server on http://localhost:%PORT%
echo.
echo   Keep this window open while you use the app.
echo   Close it (or press Ctrl+C) when you are done.
echo.

start "" "http://localhost:%PORT%/"
%PYCMD% -m http.server %PORT% --bind 127.0.0.1
