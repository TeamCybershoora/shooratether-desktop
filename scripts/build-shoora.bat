@echo off
echo ========================================================
echo        Building SHOORA TETHER Desktop IDE
echo            Cybershoora Pvt. Ltd.
echo ========================================================

set VSCODE_SKIP_NODE_VERSION_CHECK=1

echo [1/4] Compiling SHOORA AI Extension...
cd extensions\shoora-ai
call npm install --no-package-lock
call npx tsc
cd ..\..

echo [2/4] Compiling SHOORA TETHER Client Core...
call npm run compile

echo [3/4] Packaging Windows Client Binaries...
call npm run gulp vscode-win32-x64-min
call npm run gulp vscode-win32-x64-inno-updater

echo [4/4] Generating Windows Installer (.exe)...
call npm run gulp vscode-win32-x64-user-setup

echo ========================================================
echo Build Complete! Check .build/win32-x64/user-setup for .exe installer!
echo ========================================================
pause
