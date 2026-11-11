@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
chcp 65001 >nul 2>nul
title NEXUS 环境诊断
set "REPORT=%~dp0诊断结果.txt"
> "%REPORT%" echo NEXUS 环境诊断报告
>> "%REPORT%" echo 时间: %DATE% %TIME%
>> "%REPORT%" echo 目录: %~dp0
>> "%REPORT%" echo 系统: %OS% %PROCESSOR_ARCHITECTURE%
>> "%REPORT%" echo.

echo ==================================================
echo   NEXUS 环境诊断（结果同时写入 诊断结果.txt）
echo ==================================================
echo.

echo [1] 查找 Python
echo [1] 查找 Python >> "%REPORT%"
set "FOUND="
where py >> "%REPORT%" 2>&1
if not errorlevel 1 (
  py -3 -c "import sys;print('py -3 ->', sys.version.split()[0], sys.executable)" >> "%REPORT%" 2>&1
  for /f "usebackq delims=" %%i in (`py -3 -c "import sys;sys.stdout.write(sys.executable)" 2^>nul`) do set "FOUND=%%i"
)
where python >> "%REPORT%" 2>&1
python -c "import sys;print('python ->', sys.version.split()[0], sys.executable)" >> "%REPORT%" 2>&1
if not defined FOUND for /f "usebackq delims=" %%i in (`python -c "import sys;sys.stdout.write(sys.executable)" 2^>nul`) do set "FOUND=%%i"
if defined FOUND (echo   可用解释器: !FOUND!) else (echo   未找到可用的 Python 3)
>> "%REPORT%" echo 可用解释器: !FOUND!
>> "%REPORT%" echo.

echo [2] 检查 psutil
>> "%REPORT%" echo [2] 检查 psutil >> "%REPORT%"
if defined FOUND (
  "!FOUND!" -c "import psutil;print('psutil', psutil.__version__)" >> "%REPORT%" 2>&1
  "!FOUND!" -c "import psutil" >nul 2>nul
  if errorlevel 1 (echo   psutil 未安装) else (echo   psutil 正常)
) else (echo   跳过)
>> "%REPORT%" echo.

echo [3] 端口与运行状态
>> "%REPORT%" echo [3] 端口与运行状态 >> "%REPORT%"
netstat -ano | findstr ":8768" >> "%REPORT%" 2>&1
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8768/api/health; Write-Output ('健康检查: ' + $r.StatusCode + ' ' + $r.Content)}catch{Write-Output '健康检查: 未响应'}" >> "%REPORT%" 2>&1
for /f "usebackq delims=" %%l in (`powershell -NoProfile -Command "try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8768/api/health; Write-Output ('  ' + $r.Content)}catch{Write-Output '  服务未运行'}"`) do echo %%l
>> "%REPORT%" echo.

echo [4] 文件检查
>> "%REPORT%" echo [4] 文件检查 >> "%REPORT%"
for %%f in (sampler.py web\index.html web\app.js web\gl.js web\engines.js) do (
  if exist "%%f" (echo   OK   %%f) else (echo   缺失 %%f)
  >> "%REPORT%" echo %%f
)
>> "%REPORT%" echo.

echo [5] 直接前台运行一次采样（能看到真实报错）
>> "%REPORT%" echo [5] 前台采样测试 >> "%REPORT%"
if defined FOUND (
  "!FOUND!" "%~dp0sampler.py" --once >> "%REPORT%" 2>&1
  if errorlevel 1 (echo   [X] 采样失败，见上方输出) else (echo   [OK] 采样正常)
) else (echo   跳过)
>> "%REPORT%" echo.

echo.
echo 诊断完成。报告已保存：%REPORT%
echo 如果第 5 步报错，请把报告里的错误文字发给我。
echo.
pause
exit /b 0
