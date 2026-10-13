from __future__ import annotations

import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / "sniper"))
from deploy_direct_engine import connection_details

host, password = connection_details()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username="root", password=password, timeout=20, allow_agent=False, look_for_keys=False)
try:
    _stdin, stdout, stderr = client.exec_command("cat /root/trade_perpl_bot/data/branding.json", timeout=20)
    print(stdout.read().decode("utf-8", "replace"))
    error = stderr.read().decode("utf-8", "replace")
    if error:
        print(error, file=sys.stderr)
finally:
    client.close()
