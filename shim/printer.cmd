@echo off
rem ===========================================================================
rem printer.cmd - entry shim for the AI printer skill (zero dependencies).
rem
rem   The command name is "printer", NOT "print". C:\Windows\System32\print.exe
rem   is a Windows built-in and System32 always comes first on PATH, so a
rem   print.cmd shim can never win and the built-in may really print a file.
rem   Never add a print.cmd shim; the name is printer.
rem
rem   Finds src\print-cli.mjs next to this file, one level up, or two levels up,
rem   forwards every argument unchanged and preserves the CLI exit code.
rem   Spaced and non-ASCII paths survive because every path is quoted and all
rem   arguments are passed through %* without re-tokenising.
rem
rem   ASCII only: cmd.exe reads .cmd files with the OEM/ANSI code page.
rem ===========================================================================
setlocal EnableExtensions DisableDelayedExpansion

set "SHIM_DIR=%~dp0"
set "PRINT_CLI="

if exist "%SHIM_DIR%src\print-cli.mjs" set "PRINT_CLI=%SHIM_DIR%src\print-cli.mjs"
if not defined PRINT_CLI if exist "%SHIM_DIR%..\src\print-cli.mjs" set "PRINT_CLI=%SHIM_DIR%..\src\print-cli.mjs"
if not defined PRINT_CLI if exist "%SHIM_DIR%..\..\src\print-cli.mjs" set "PRINT_CLI=%SHIM_DIR%..\..\src\print-cli.mjs"

if not defined PRINT_CLI (
  echo printer.cmd: cannot find src\print-cli.mjs under "%SHIM_DIR%" or its parent folders. 1>&2
  echo printer.cmd: reinstall with install.ps1, or run: node src\print-cli.mjs ... 1>&2
  exit /b 5
)

where node >nul 2>nul
if errorlevel 1 (
  echo printer.cmd: Node.js was not found in PATH. Install Node 18 or newer: https://nodejs.org/ 1>&2
  exit /b 5
)

node "%PRINT_CLI%" %*
set "PRINT_RC=%ERRORLEVEL%"
endlocal & exit /b %PRINT_RC%
