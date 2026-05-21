@echo off
setlocal EnableExtensions

cd /d "%~dp0"

echo [1/4] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed or is not available in PATH.
    echo Install Node.js 20 or newer from https://nodejs.org
    pause
    exit /b 1
)

echo [2/4] Checking npm...
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo ERROR: npm.cmd is not available in PATH.
    pause
    exit /b 1
)

echo [3/4] Checking local .env...
if not exist ".env" (
    echo Creating .env with a generated encryption key...
    for /f "usebackq delims=" %%K in (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) do set "ENCRYPTION_KEY=%%K"
    if not defined ENCRYPTION_KEY (
        echo ERROR: Failed to generate ENCRYPTION_KEY.
        pause
        exit /b 1
    )
    > ".env" echo ENCRYPTION_KEY=%ENCRYPTION_KEY%
    >> ".env" echo PORT=3001
) else (
    echo .env already exists.
)

echo [4/4] Installing dependencies...
call npm.cmd install
if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)

echo.
echo Starting LLM Chatbot...
echo Open this URL once the dev server is ready:
echo http://localhost:5173/onboarding
echo.
call npm.cmd run dev

endlocal
