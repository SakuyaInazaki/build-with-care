@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "DESK_PNPM="
for /f "delims=" %%P in ('where pnpm.cmd 2^>nul') do if not defined DESK_PNPM set "DESK_PNPM=%%P"
if not defined DESK_PNPM if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd" set "DESK_PNPM=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd"
if not defined DESK_PNPM (
  echo 请先安装 Node.js 24 和 pnpm 11，然后重新打开。
  pause
  exit /b 1
)
if not exist node_modules (
  call "%DESK_PNPM%" install --frozen-lockfile
  if errorlevel 1 goto failed
)
echo 正在准备“在场”工作台...
call "%DESK_PNPM%" build
if errorlevel 1 goto failed
echo 启动后请打开 http://127.0.0.1:4317 ，保持本窗口运行。
call "%DESK_PNPM%" start
if errorlevel 1 goto failed
exit /b 0
:failed
echo 启动未完成，请查看上方提示。若端口已占用，可直接打开已有工作台。
pause
exit /b 1
