@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   MOXIE 本地预览服务器
echo   打开:  http://localhost:4321/moxie-preview
echo   停止:  在本窗口按 Ctrl+C
echo   （别再双击 .html 文件，必须从上面这个网址点进去）
echo ============================================
start "" cmd /c "ping -n 4 127.0.0.1 >nul & start """" http://localhost:4321/moxie-preview"
npx --yes serve -l 4321 .
