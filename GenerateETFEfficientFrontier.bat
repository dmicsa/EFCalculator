@echo off
setlocal
cd /d "%~dp0"
deno run -A .\Code\GenerateETFEfficientFrontier.ts %*