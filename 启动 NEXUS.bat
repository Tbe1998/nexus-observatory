@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title NEXUS 启动器

rem ===============================================================
rem  NEXUS · 实时运算中枢 —— Windows 启动入口
rem  1) 找可用的 Python 3（跳过 Microsoft Store 占位程序）
rem  2) 缺 psutil 自动安装
rem  3) 隐藏启动采样服务 → 等健康检查通过 → 打开浏览器
rem  启动失败会停在窗口里并打开 nexus.log，不再一闪而过
rem ===============================================================

set "PYEXE="
set "PYARG="

rem ---- 1. py 启动器 ----
where py >nul 2>nul
if not errorlevel 1 (
  for /f "usebackq delims=" %%i in (`py -3 -c "import sys;sys.stdout.write(sys.executable)" 2^>nul`) do (
    if exist "%%i" set "PYEXE=%%i"
  )
)

rem ---- 2. python 命令（排除商店占位：它执行后没有输出） ----
if not defined PYEXE (
  where python >nul 2>nul
  if not errorlevel 1 (
    for /f "usebackq delims=" %%i in (`python -c "import sys;sys.stdout.write(sys.executable)" 2^>nul`) do (
      if exist "%%i" set "PYEXE=%%i"
    )
  )
)

rem ---- 3. 常见安装路径兜底 ----
if not defined PYEXE (
  for %%d in ("%LOCALAPPDATA%\Programs\Python" "%ProgramFiles%\Python*" "%ProgramFiles(x86)%\Python*") do (
    for /d %%p in (%%d) do (
      if exist "%%p\python.exe" if not defined PYEXE set "PYEXE=%%p\python.exe"
    )
  )
)

if not defined PYEXE (
  echo.
  echo   [!] 没有找到可用的 Python 3。
  echo.
  echo       请安装 Python 3.9 或更高版本：https://www.python.org/downloads/
  echo       安装第一步务必勾选 "Add python.exe to PATH"。
  echo       如果是从 Microsoft Store 装的那个 python 占位程序，请改用官网安装包。
  echo.
  echo   按任意键查看更详细的环境诊断…
  pause >nul
  call "%~dp0诊断 NEXUS.bat"
  exit /b 1
)

for %%v in ("%PYEXE%") do set "PYDIR=%%~dpv"
set "PYW=%PYDIR%pythonw.exe"
if not exist "%PYW%" set "PYW=%PYEXE%"

echo   使用 Python：%PYEXE%

rem ---- 依赖 ----
"%PYEXE%" -c "import psutil" >nul 2>nul
if errorlevel 1 (
  echo   缺少依赖 psutil，正在安装…
  "%PYEXE%" -m pip install --disable-pip-version-check -q -i https://pypi.tuna.tsinghua.edu.cn/simple psutil
  if errorlevel 1 "%PYEXE%" -m pip install --disable-pip-version-check -q --user psutil
  "%PYEXE%" -c "import psutil" >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   [!] psutil 安装失败，请手动执行：
    echo       "%PYEXE%" -m pip install psutil
    echo.
    pause
    exit /b 1
  )
)

rem ---- 已在运行就直接开页面 ----
set "PORT=8768"
if exist "%~dp0nexus.port" for /f "usebackq delims=" %%p in ("%~dp0nexus.port") do set "PORT=%%p"
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:!PORT!/api/health; if($r.Content -match 'nexus'){exit 0}}catch{}; exit 1" >nul 2>nul
if not errorlevel 1 (
  echo   NEXUS 已在运行，直接打开页面。
  start "" http://127.0.0.1:!PORT!/
  exit /b 0
)

rem ---- 隐藏启动 ----
echo   正在启动采样服务…
start "" "%PYW%" "%~dp0sampler.py" --port !PORT! --no-browser

set /a TRIES=0
:wait
timeout /t 1 /nobreak >nul
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:!PORT!/api/health; if($r.StatusCode -eq 200){exit 0}}catch{}; exit 1" >nul 2>nul
if not errorlevel 1 goto ok
set /a TRIES+=1
if !TRIES! lss 12 goto wait

echo.
echo   [X] 采样服务在 12 秒内没有起来。
echo       常见原因：端口被占用 / Python 缺少组件 / 杀毒软件拦截。
echo.
if exist "%~dp0nexus.log" (
  echo   ---------- nexus.log ----------
  type "%~dp0nexus.log"
  echo   -----------------------------
  start "" notepad "%~dp0nexus.log"
)
echo.
echo   按任意键运行完整诊断…
pause >nul
call "%~dp0诊断 NEXUS.bat"
exit /b 1

:ok
echo   启动成功：http://127.0.0.1:!PORT!/
start "" http://127.0.0.1:!PORT!/
exit /b 0
