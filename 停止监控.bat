@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title NEXUS 停止监控

set "PORT=8768"
if exist "%~dp0nexus.port" (
  for /f "usebackq delims=" %%p in ("%~dp0nexus.port") do set "PORT=%%p"
)

echo   正在停止 NEXUS 采样服务（端口 !PORT!）...
powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing -Method POST -TimeoutSec 3 http://127.0.0.1:!PORT!/api/shutdown | Out-Null}catch{}" >nul 2>nul
timeout /t 1 /nobreak >nul

rem 兜底：按命令行匹配收掉残留的 pythonw/python 进程
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe' or Name='python.exe'\" | Where-Object { $_.CommandLine -like '*sampler.py*' } | ForEach-Object { try{ Stop-Process -Id $_.ProcessId -Force }catch{} }" >nul 2>nul

if exist "%~dp0nexus.port" del /q "%~dp0nexus.port" >nul 2>nul
if exist "%~dp0__pycache__" rd /s /q "%~dp0__pycache__" >nul 2>nul
echo   已停止。可以直接关闭浏览器页面。
timeout /t 2 /nobreak >nul
exit /b 0
