@echo off
rem 双击本文件即可安装（窗口会停住，能看到结果）
rem 也可传参数： install.cmd -DryRun   或   install.cmd -AddToPath -WithDsh -DshHome "$env:USERPROFILE\.dsh\home"
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %* -Pause
set RC=%ERRORLEVEL%
endlocal & exit /b %RC%
