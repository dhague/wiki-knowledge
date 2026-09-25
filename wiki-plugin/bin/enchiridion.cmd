@echo off
setlocal

rem The Windows sibling of `bin/enchiridion` (see that file for the contract):
rem a shim that execs `node` against the esbuild bundle (ADR-0017),
rem forwarding every argument untouched. ENCHIRIDION_BIN overrides it.

set "plugin_root=%~dp0.."

if defined ENCHIRIDION_BIN (
    "%ENCHIRIDION_BIN%" %*
    exit /b %ERRORLEVEL%
)

rem In-plugin scripts\cli.cjs (the shipped bundle) wins over the sibling dev
rem build at ..\enchiridion-ts\dist\cli.cjs.
if exist "%plugin_root%\scripts\cli.cjs" (
    set "bundle=%plugin_root%\scripts\cli.cjs"
) else (
    set "bundle=%plugin_root%\..\enchiridion-ts\dist\cli.cjs"
)

node "%bundle%" %*
exit /b %ERRORLEVEL%
