@echo off
chcp 65001 >nul
cd /d "%~dp0"
title New Hire Sim Training - Mock Demo (8999 + 8848)
echo.
echo   [1/2] Starting mock LLM on port 8999 (OpenAI-compatible, no API key needed)
start "mock-llm" /min cmd /c "node server/mock-llm.js 8999"
timeout /t 2 >nul
echo   [2/2] Starting backend on http://127.0.0.1:8848
echo.
node server/index.js
echo.
echo   Server stopped. Press any key to close.
pause >nul
