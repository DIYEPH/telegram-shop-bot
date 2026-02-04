@echo off
title Telegram Shop Bot
color 0A

echo ========================================
echo        TELEGRAM SHOP BOT
echo ========================================
echo.

:: Check if node_modules exists
if not exist "node_modules\" (
    echo [!] Chua cai dat dependencies...
    echo [*] Dang chay: npm install
    echo.
    npm install
    echo.
)

echo [*] Dang khoi dong bot...
echo [*] Nhan Ctrl+C de dung bot
echo.

node src/bot.js

:: If bot crashes, pause to see error
echo.
echo [!] Bot da dung. Nhan phim bat ky de dong...
pause > nul
