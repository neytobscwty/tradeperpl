"""Deploy only the Telegram message layout, preserving a remote backup."""

from __future__ import annotations

import sys
import subprocess
import difflib
from datetime import datetime, timezone
from pathlib import Path

import paramiko

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root.parent / "sniper"))
from deploy_direct_engine import connection_details


host, password = connection_details()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username="root", password=password, timeout=20, allow_agent=False, look_for_keys=False)
remote = "/root/trade_perpl_bot/src/index.ts"
backup = f"{remote}.bak-ui-{datetime.now(timezone.utc):%Y%m%d%H%M%S}"
try:
    with client.open_sftp() as sftp:
        with sftp.open(remote, "rb") as source:
            old = source.read()
        baseline = subprocess.check_output(["git", "-c", f"safe.directory={root.as_posix()}", "show", "HEAD:src/index.ts"], cwd=root)
        if old.replace(b"\r\n", b"\n").rstrip(b"\n") != baseline.replace(b"\r\n", b"\n").rstrip(b"\n"):
            diff = "".join(list(difflib.unified_diff(baseline.decode("utf-8", "replace").splitlines(keepends=True), old.decode("utf-8", "replace").replace("\r\n", "\n").splitlines(keepends=True), fromfile="local HEAD", tofile="remote"))[:160])
            print(diff.encode("ascii", "backslashreplace").decode("ascii"))
            raise RuntimeError("Remote index.ts differs from local HEAD; refusing to overwrite remote changes")
        with sftp.open(backup, "wb") as saved:
            saved.write(old)
        with sftp.open(f"{remote}.tmp", "wb") as target:
            target.write((root / "src/index.ts").read_bytes())
        sftp.posix_rename(f"{remote}.tmp", remote)
    command = "cd /root/trade_perpl_bot && npm run typecheck && npm test && systemctl restart trade-perpl-bot.service && systemctl is-active trade-perpl-bot.service"
    _stdin, stdout, stderr = client.exec_command(command, timeout=120)
    output = stdout.read().decode("utf-8", "replace")
    error = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    print(output, end="")
    if error:
        print(error, end="", file=sys.stderr)
    if code:
        print(f"Deployment checks failed. Remote backup: {backup}", file=sys.stderr)
        raise SystemExit(code)
    print(f"Remote backup: {backup}")
finally:
    client.close()
