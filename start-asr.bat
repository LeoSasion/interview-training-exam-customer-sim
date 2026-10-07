@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Local ASR - FunASR SenseVoiceSmall (8997)
echo.
echo   Starting local ASR server on http://127.0.0.1:8997 ...
echo   Model: SenseVoiceSmall (CPU, ~15s first load; cached at D:\wbproject\_tools\msc)
echo   Requires one-time setup, see server\README.md "语音识别" section.
echo.
if not exist "D:\wbproject\_tools\asr-venv\Scripts\python.exe" (
  echo   [ERROR] venv not found. Run the one-time setup first:
  echo     python -m venv D:\wbproject\_tools\asr-venv
  echo     D:\wbproject\_tools\asr-venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
  echo     D:\wbproject\_tools\asr-venv\Scripts\python.exe -m pip install funasr numpy modelscope imageio-ffmpeg
  echo.
  pause
  exit /b 1
)
D:\wbproject\_tools\asr-venv\Scripts\python.exe voice\asr-server.py
echo.
echo   ASR server stopped. Press any key to close.
pause >nul
