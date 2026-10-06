@echo off
chcp 65001 >nul
cd /d "%~dp0"
title New Hire Sim Training - Server (8848)
echo.
echo   Starting backend on http://127.0.0.1:8848 ...
echo   Open the pages from that address (same-origin, no CORS needed).
echo.
node server/index.js
echo.
echo   Server stopped. Press any key to close.
pause >nul
