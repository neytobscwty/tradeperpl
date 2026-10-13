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
    command = """
printf 'active='; systemctl is-active trade-perpl-bot.service 2>/dev/null || true
printf 'enabled='; systemctl is-enabled trade-perpl-bot.service 2>/dev/null || true
printf 'dir='; test -d /root/trade_perpl_bot && echo yes || echo no
printf 'users='; python3 -c 'import json,pathlib; p=pathlib.Path("/root/trade_perpl_bot/data/users.json"); print(len(json.loads(p.read_text())) if p.exists() else 0)' 2>/dev/null || echo unreadable
printf 'master_key='; grep -q '^CREDENTIALS_MASTER_KEY=.' /root/trade_perpl_bot/.env 2>/dev/null && echo configured || echo missing
printf 'token='; grep -q '^TELEGRAM_BOT_TOKEN=.' /root/trade_perpl_bot/.env 2>/dev/null && echo configured || echo missing
journalctl -u trade-perpl-bot.service -n 15 --no-pager -o cat 2>/dev/null | sed -E 's/[A-Za-z0-9_-]{35,}/[redacted]/g'
cd /root/trade_perpl_bot
printf 'remote_index_sha256='; sha256sum src/index.ts | cut -d' ' -f1
printf 'remote_live_sha256='; sha256sum src/live.ts | cut -d' ' -f1
./node_modules/.bin/tsx scripts/read-only-smoke.ts
./node_modules/.bin/tsx scripts/inspect-live-account.ts
"""
    _stdin, stdout, stderr = client.exec_command(command, timeout=30)
    print(stdout.read().decode("utf-8", "replace"), end="")
    error = stderr.read().decode("utf-8", "replace").strip()
    if error:
        raise RuntimeError(error)
finally:
    client.close()
