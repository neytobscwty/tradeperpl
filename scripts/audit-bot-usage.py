"""Read-only aggregate usage check; never prints chat IDs or credentials."""

from __future__ import annotations

import sys
from pathlib import Path

import paramiko

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sniper"))
from deploy_direct_engine import connection_details


host, password = connection_details()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username="root", password=password, timeout=20, allow_agent=False, look_for_keys=False)
try:
    command = """python3 - <<'PY'
import json, pathlib, subprocess
p = pathlib.Path('/root/trade_perpl_bot/data/users.json')
users = json.loads(p.read_text()) if p.exists() else []
print('connected_users=', len(users))
print('user_store_modified_utc=', __import__('datetime').datetime.fromtimestamp(p.stat().st_mtime, __import__('datetime').timezone.utc).isoformat() if p.exists() else 'missing')
print('alerts_enabled=', sum(bool(u.get('alerts')) for u in users))
print('position_event_cursors=', sum(bool(u.get('lastEvent')) for u in users))
print('order_event_cursors=', sum(bool(u.get('lastOrderEvent')) for u in users))
print('service_active=', subprocess.run(['systemctl', 'is-active', 'trade-perpl-bot.service'], capture_output=True, text=True).stdout.strip())
PY"""
    _stdin, stdout, stderr = client.exec_command(command, timeout=30)
    output = stdout.read().decode("utf-8", "replace")
    error = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if code:
        raise RuntimeError(error or output)
    print(output, end="")
finally:
    client.close()
