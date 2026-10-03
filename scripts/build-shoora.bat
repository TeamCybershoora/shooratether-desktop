@echo off
echo ========================================================
echo        Building SHOORA TETHER Desktop IDE
echo            Cybershoora Pvt. Ltd.
echo ========================================================

set VSCODE_SKIP_NODE_VERSION_CHECK=1

echo [1/3] Compiling SHOORA AI Extension...
cd extensions\shoora-ai
call npm install --no-package-lock
call npx tsc
cd ..\..

echo [2/3] Compiling SHOORA TETHER Client...
call npm run compile

echo [3/3] Packaging Executable...
call npm run gulp vscode-win32-x64-inno-updater

echo ========================================================
echo Build Complete! Check .build/win32-x64 for installers.
echo ========================================================
pause
