@echo off
cd /d "%~dp0"
if not exist data mkdir data
node --disable-warning=ExperimentalWarning server\index.js >> data\server.log 2>&1
