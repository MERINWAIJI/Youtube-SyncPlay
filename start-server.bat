@echo off
chcp 65001 >nul
setlocal EnableExtensions
title YouTube SyncPlay 启动器
cd /d "%~dp0"

set "PORT=8787"
set "SERVER_TITLE=YT-SyncPlay-Server"
set "TUNNEL_TITLE=YT-SyncPlay-Tunnel"
set "TUNNEL_LOG=%TEMP%\yt-syncplay-tunnel.log"

if not exist "server\src\server.js" goto :no_server

rem ---------- 找运行环境：优先 Node.js，其次 Bun ----------
set "RUNTIME="
where node >nul 2>nul && set "RUNTIME=node"
if not defined RUNTIME where bun >nul 2>nul && set "RUNTIME=bun"
if not defined RUNTIME goto :no_runtime

rem ---------- 找 cloudflared ----------
set "CLOUDFLARED="
where cloudflared >nul 2>nul && set "CLOUDFLARED=cloudflared"
if not defined CLOUDFLARED if exist "%~dp0cloudflared.exe" set "CLOUDFLARED=%~dp0cloudflared.exe"
if not defined CLOUDFLARED if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CLOUDFLARED=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CLOUDFLARED if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CLOUDFLARED=%ProgramFiles%\cloudflared\cloudflared.exe"
if not defined CLOUDFLARED goto :no_cloudflared

rem ---------- 首次运行安装依赖 ----------
if exist "server\node_modules\ws" goto :deps_ok
echo [1/3] 首次运行，正在安装服务器依赖...
pushd server
if "%RUNTIME%"=="node" call npm install --omit=dev
if "%RUNTIME%"=="bun" call bun install
popd
if not exist "server\node_modules\ws" goto :deps_failed
:deps_ok

rem ---------- 启动服务器 ----------
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 goto :server_running
echo [2/3] 正在启动同步服务器（端口 %PORT%）...
start "%SERVER_TITLE%" /min /d "%~dp0server" cmd /k "%RUNTIME% src\server.js"
goto :start_tunnel
:server_running
echo [2/3] 端口 %PORT% 已有程序在监听，跳过启动服务器。

:start_tunnel
rem ---------- 启动隧道 ----------
echo [3/3] 正在启动 Cloudflare 隧道，请稍候...
del "%TUNNEL_LOG%" >nul 2>nul
start "%TUNNEL_TITLE%" /min cmd /k ""%CLOUDFLARED%" tunnel --url http://localhost:%PORT% --logfile "%TUNNEL_LOG%""

rem ---------- 等隧道地址出现（最多约 60 秒） ----------
set "URL="
set /a TRIES=0
:wait_url
timeout /t 2 /nobreak >nul
set /a TRIES+=1
if exist "%TUNNEL_LOG%" for /f "usebackq delims=" %%U in (`powershell -NoProfile -Command "$m = Select-String -Path $env:TUNNEL_LOG -Pattern 'https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $m.Matches[0].Value }"`) do set "URL=%%U"
if defined URL goto :got_url
if %TRIES% lss 30 goto :wait_url
goto :no_url

:got_url
set "WSS=%URL:https://=wss://%"
echo %WSS%| clip
echo.
echo ============================================================
echo   部署完成，服务器地址：
echo.
echo     %WSS%
echo.
echo   地址已复制到剪贴板。
echo   在扩展弹窗的“设置”里填入这个地址并保存，
echo   你和朋友都要填，然后重新创建房间。
echo ============================================================
echo.
echo 观影期间请不要关闭本窗口。
echo 看完后在本窗口按任意键，会自动关闭服务器和隧道。
pause >nul
goto :cleanup

:no_url
echo.
echo [错误] 60 秒内没有拿到隧道地址。
echo 请查看任务栏里最小化的 "%TUNNEL_TITLE%" 窗口中的报错信息。
echo 按任意键关闭服务器和隧道...
pause >nul
goto :cleanup

:cleanup
taskkill /fi "WINDOWTITLE eq %TUNNEL_TITLE%*" /t /f >nul 2>nul
taskkill /fi "WINDOWTITLE eq %SERVER_TITLE%*" /t /f >nul 2>nul
echo 已关闭。
timeout /t 2 /nobreak >nul
exit /b 0

:no_server
echo [错误] 找不到 server\src\server.js。
echo 请把本文件放在 Youtube-SyncPlay 文件夹的根目录（和 server、extension 文件夹同级）。
goto :fail

:no_runtime
echo [错误] 没有找到 Node.js 或 Bun，请先安装其中一个：https://nodejs.org
goto :fail

:no_cloudflared
echo [错误] 没有找到 cloudflared。
echo 请先安装（winget install Cloudflare.cloudflared），
echo 或者把 cloudflared.exe 放到本文件所在的文件夹里。
goto :fail

:deps_failed
echo [错误] 服务器依赖安装失败，请检查网络后重试。
goto :fail

:fail
echo.
pause
exit /b 1
