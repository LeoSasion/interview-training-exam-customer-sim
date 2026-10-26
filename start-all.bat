@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 新员工培训系统 · 一键启动
node start-all.js %*
if errorlevel 1 (
  echo.
  echo   [ERROR] 启动失败。请确认已安装 Node.js 22+ （node -v）。
  pause
)
