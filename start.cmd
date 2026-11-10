@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24.9 或更新版本。
  pause
  exit /b 1
)
if not exist node_modules (
  echo 即将下载项目依赖到本项目目录，不安装模型权重。
  call npm ci --ignore-scripts
  if errorlevel 1 goto failed
)
if not exist .venv\Scripts\python.exe (
  echo 即将创建本项目独立 Python 环境并下载文档处理依赖。
  call npm run setup
  if errorlevel 1 goto failed
)
call npm run build
if errorlevel 1 goto failed
echo 打开 http://127.0.0.1:3220 ，自定义端口请查看终端实际地址。
call npm start
if errorlevel 1 goto failed
exit /b 0
:failed
echo 启动未完成，请保留上面的实际错误信息；不要删除私有数据目录。
pause
exit /b 1
