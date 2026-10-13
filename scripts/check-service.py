from __future__ import annotations

import sys
from pathlib import Path

import paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT.parent / "sniper"))
from deploy_direct_engine import connection_details

host, password = connection_details()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username="root", password=password, timeout=20, allow_agent=False, look_for_keys=False)
try:
    command = "systemctl status trade-perpl-bot.service --no-pager -l; journalctl -u trade-perpl-bot.service -n 80 --no-pager -o cat"
    _stdin, stdout, stderr = client.exec_command(command, timeout=30)
    print(stdout.read().decode("utf-8", "replace"), end="")
    error = stderr.read().decode("utf-8", "replace")
    if error:
        print(error, file=sys.stderr, end="")
finally:
    client.close()
