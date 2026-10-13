from __future__ import annotations

import sys
from datetime import datetime, timezone
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
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    with client.open_sftp() as sftp:
        for relative in (
            "src/index.ts",
            "src/chart.ts",
            "src/ui.ts",
            "src/perpl.ts",
            "src/personal.ts",
            "src/orders.ts",
            "tests/ui.test.ts",
            "tests/orders.test.ts",
            "scripts/smoke-trades.ts",
            "scripts/verify-smoke.ts",
            "scripts/inspect-history.ts",
            "scripts/inspect-live-account.ts",
            "scripts/send-notification-previews.ts",
            "scripts/send-layout-previews.ts",
            "scripts/test-book-refresh.ts",
            "scripts/test-candle-ranges.ts",
            "scripts/test-trigger-source.ts",
        ):
            local = ROOT / relative
            remote = f"/root/trade_perpl_bot/{relative}"
            try:
                with sftp.open(remote, "rb") as source:
                    previous = source.read()
                with sftp.open(f"{remote}.bak-{stamp}", "wb") as backup:
                    backup.write(previous)
            except FileNotFoundError:
                pass
            with sftp.open(f"{remote}.tmp", "wb") as target:
                target.write(local.read_bytes())
            sftp.posix_rename(f"{remote}.tmp", remote)
    command = """
set -e
cd /root/trade_perpl_bot
npm run typecheck
npm test
systemctl restart trade-perpl-bot.service
systemctl is-active trade-perpl-bot.service
journalctl -u trade-perpl-bot.service -n 8 --no-pager -o cat
"""
    _stdin, stdout, stderr = client.exec_command(command, timeout=90)
    output = stdout.read().decode("utf-8", "replace")
    error = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    print(output, end="")
    if error:
        print(error, end="")
    if code:
        raise SystemExit(code)
finally:
    client.close()
