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
    if "--logs" in sys.argv:
        since = "15 minutes ago" if "--logs-long" in sys.argv else "2 minutes ago"
        _stdin, stdout, stderr = client.exec_command(
            f"journalctl -u trade-perpl-bot.service --since '{since}' --no-pager -o cat",
            timeout=30,
        )
        print(stdout.read().decode("utf-8", "replace"), end="")
        print(stderr.read().decode("utf-8", "replace"), end="")
        raise SystemExit(stdout.channel.recv_exit_status())
    if "--verify" in sys.argv:
        target = "scripts/verify-smoke.ts --alert && systemctl restart trade-perpl-bot.service"
    elif "--state" in sys.argv:
        target = "scripts/verify-smoke.ts"
    elif "--history" in sys.argv:
        target = "scripts/inspect-history.ts"
    elif "--previews" in sys.argv:
        target = "scripts/send-notification-previews.ts"
    elif "--layouts" in sys.argv:
        target = "scripts/send-layout-previews.ts"
    elif "--book-refresh" in sys.argv:
        target = "scripts/test-book-refresh.ts"
    elif "--book-refresh-long" in sys.argv:
        target = "scripts/test-book-refresh.ts 150"
    elif "--book-refresh-2s" in sys.argv:
        target = "scripts/test-book-refresh.ts 150 2000"
    elif "--candles" in sys.argv:
        target = "scripts/test-candle-ranges.ts"
    elif "--trigger-source" in sys.argv:
        target = "scripts/test-trigger-source.ts"
    elif "--account" in sys.argv:
        target = "scripts/inspect-live-account.ts"
    else:
        target = "scripts/smoke-trades.ts"
    _stdin, stdout, stderr = client.exec_command(
        f"cd /root/trade_perpl_bot && npx tsx {target}",
        timeout=300,
    )
    while not stdout.channel.exit_status_ready():
        if stdout.channel.recv_ready():
            print(stdout.channel.recv(4096).decode("utf-8", "replace"), end="", flush=True)
        if stderr.channel.recv_stderr_ready():
            print(stderr.channel.recv_stderr(4096).decode("utf-8", "replace"), end="", flush=True)
    print(stdout.read().decode("utf-8", "replace"), end="")
    print(stderr.read().decode("utf-8", "replace"), end="")
    raise SystemExit(stdout.channel.recv_exit_status())
finally:
    client.close()
