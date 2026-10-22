@echo off
setlocal EnableExtensions

rem Build the current branch and link it as the global `codegraph` for
rem hands-on testing. Replaces any existing global install for as long
rem as the npm link is in place.
rem
rem Usage:
rem   scripts\local-install.bat           build + link
rem   scripts\local-install.bat --undo    unlink + install the declared official base version

pushd "%~dp0.." || exit /b 1

for /f "usebackq delims=" %%A in (`node -p "require('./package.json').name"`) do set "PKG=%%A"
if not defined PKG goto :fail

for /f "usebackq delims=" %%A in (`node -p "require('./package.json').version"`) do set "VERSION=%%A"
if not defined VERSION goto :fail

for /f "usebackq delims=" %%A in (`git rev-parse --abbrev-ref HEAD`) do set "BRANCH=%%A"
if not defined BRANCH set "BRANCH=(unknown)"

if "%~1"=="--undo" (
  echo - unlinking %PKG%
  call npm unlink -g "%PKG%" >nul 2>nul
  echo - installing official %PKG%@%VERSION%
  call npm install -g "%PKG%@%VERSION%" || goto :fail
  for /f "delims=" %%A in ('where codegraph 2^>nul') do (
    echo done: global codegraph -^> %%A
    goto :done
  )
  echo done: global codegraph -^> ^(not on PATH^)
  goto :done
)

if not "%~1"=="" (
  echo usage: scripts\local-install.bat [--undo]
  goto :fail
)

echo - building %PKG% %VERSION% (%BRANCH%)
call npm run build || goto :fail

echo - linking globally
call npm link || goto :fail

set "LINKED=(not on PATH)"
for /f "delims=" %%A in ('where codegraph 2^>nul') do (
  set "LINKED=%%A"
  goto :linked_found
)
:linked_found

echo.
echo global codegraph now points to this branch
echo   binary:  %LINKED%
echo   branch:  %BRANCH%
echo   version: %VERSION%
echo.
echo To restore the published version:
echo   scripts\local-install.bat --undo

:done
popd
exit /b 0

:fail
set "STATUS=%ERRORLEVEL%"
if "%STATUS%"=="0" set "STATUS=1"
popd
exit /b %STATUS%
