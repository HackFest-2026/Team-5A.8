#!/usr/bin/env bash
# BizPilot AI - start (Linux/macOS)
cd "$(dirname "$0")"
python3 -m pip install -q -r requirements.txt
[ -f .env ] && set -a && . ./.env && set +a
cd backend && python3 app.py
