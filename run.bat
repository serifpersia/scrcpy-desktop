@echo off
setlocal EnableDelayedExpansion

color 0a

cls

echo.
echo   [1;33m---------------------------------------------[0m
echo   [1;36m               scrcpy-desktop                [0m        
echo   [1;33m---------------------------------------------[0m
echo   [1;34mhttps://github.com/serifpersia/scrcpy-desktop[0m
echo   [1;33m---------------------------------------------[0m
echo.
echo [1;32mStarting scrcpy desktop...[0m
echo.

echo  Installing dependencies with npm install...
call npm install
if %ERRORLEVEL% neq 0 (
    echo  Error: npm install failed!
    pause
    exit /b %ERRORLEVEL%
) else (
    echo  Success: npm install completed!
)
echo.

echo  Cleaning previous build artifacts...
call npm run clean
if %ERRORLEVEL% neq 0 (
    echo  Warning: npm run clean failed, proceeding anyway...
) else (
    echo  Success: Clean completed!
)
echo.

echo  Building project with npm run build...
call npm run build
if %ERRORLEVEL% neq 0 (
    echo  Error: npm run build failed!
    pause
    exit /b %ERRORLEVEL%
) else (
    echo  Success: npm run build completed!
)
echo.

echo  Packaging for Windows with npm run package:win...
call npm run package:win
if %ERRORLEVEL% neq 0 (
    echo  Error: npm run package:win failed!
    pause
    exit /b %ERRORLEVEL%
) else (
    echo  Success: Packaging for Windows completed!
)
echo.

echo  Running npm start...
call npm start
if %ERRORLEVEL% neq 0 (
    echo  Error: npm start failed!
    pause
    exit /b %ERRORLEVEL%
) else (
    echo  Success: npm start completed!
)

echo.
echo  All commands executed successfully!
echo  scrcpy desktop is now running.
pause
exit /b 0