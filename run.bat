@echo off
REM BizPilot AI - start (Windows)
cd /d %~dp0
python -m pip install -q -r requirements.txt
cd backend
python app.py
