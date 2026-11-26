@echo off
cd /d "%~dp0"

echo Please exit the ResearchTube Python Agent from the system tray before updating.
echo Press any key to continue after closing it.
pause >nul

echo Updating repository...
git fetch origin main || goto error
git reset --hard origin/main || goto error
git clean -fd -- extension/ || goto error

echo Installing Extension dependencies...
call npm.cmd ci --prefix extension || goto error

echo Building Extension...
call npm.cmd run build --prefix extension || goto error

echo Installing Windows Python Agent runtime dependencies...
python -m pip install -r agent/requirements-windows.txt || goto error

echo Installing Cloudflare dependencies...
call npm.cmd ci --prefix cloudflare-worker || goto error

echo Applying Cloudflare D1 migrations...
call npm.cmd run db:remote --prefix cloudflare-worker || goto error

echo Deploying Cloudflare Worker...
call npm.cmd run deploy --prefix cloudflare-worker || goto error

echo.
echo UPDATE COMPLETED SUCCESSFULLY
echo Start agent\researchtube_agent.pyw and reload the Chrome extension.
echo Reconnect ResearchTube in ChatGPT to obtain new OAuth tokens.
pause
exit /b 0

:error
echo.
echo UPDATE FAILED
pause
exit /b 1