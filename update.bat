@echo off
cd /d "%~dp0"

echo Updating repository...
git fetch origin main || goto error
git reset --hard origin/main || goto error
git clean -fd -- extension/ || goto error

echo Installing Extension dependencies...
call npm.cmd ci --prefix extension || goto error

echo Building Extension...
call npm.cmd run build --prefix extension || goto error

echo Installing Cloudflare dependencies...
call npm.cmd ci --prefix cloudflare-worker || goto error

echo Deploying Cloudflare Worker...
call npm.cmd run deploy --prefix cloudflare-worker || goto error

echo.
echo UPDATE COMPLETED SUCCESSFULLY
pause
exit /b 0

:error
echo.
echo UPDATE FAILED
pause
exit /b 1