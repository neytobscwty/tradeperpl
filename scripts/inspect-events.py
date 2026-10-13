import sys,json
from pathlib import Path
import paramiko
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root.parent/"sniper"))
from deploy_direct_engine import connection_details
host,password=connection_details()
c=paramiko.SSHClient();c.set_missing_host_key_policy(paramiko.AutoAddPolicy());c.connect(host,username="root",password=password,timeout=20,allow_agent=False,look_for_keys=False)
try:
 _,out,err=c.exec_command("journalctl -u trade-perpl-bot.service -n 100 --no-pager -o cat",timeout=30)
 print(out.read().decode());print(err.read().decode())
finally:c.close()
