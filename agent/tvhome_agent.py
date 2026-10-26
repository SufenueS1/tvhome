"""TV Home PC agent.

Registers this PC with the Home service on the TV and long-polls it for power
commands (shutdown / restart / sleep / lock / cancel). All connections go out
from the PC, so no inbound firewall rule is needed. Stdlib only.

Config: agent/config.json (created by setup.ps1, never committed).
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "config.json")
LOG = os.path.join(HERE, "agent.log")
CREATE_NO_WINDOW = 0x08000000


def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + msg
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > 512_000:
            os.replace(LOG, LOG + ".1")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def request(cfg, path, body=None, timeout=10):
    url = f"http://{cfg['tv_ip']}:8095{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET",
                                 headers={"Content-Type": "application/json", "X-Home-Key": cfg["token"]})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def run(args):
    subprocess.Popen(args, creationflags=CREATE_NO_WINDOW)


def do(action):
    log(f"command: {action}")
    if action == "shutdown":
        run(["shutdown", "/s", "/t", "15", "/c", "Shutting down from the TV. Run 'shutdown /a' to cancel."])
    elif action == "restart":
        run(["shutdown", "/r", "/t", "15", "/c", "Restarting from the TV. Run 'shutdown /a' to cancel."])
    elif action == "cancel":
        run(["shutdown", "/a"])
    elif action == "lock":
        run(["rundll32.exe", "user32.dll,LockWorkStation"])
    elif action == "sleep":
        # SetSuspendState via rundll32 hibernates when hibernation is on, so use the forms API.
        run(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command",
             "Add-Type -AssemblyName System.Windows.Forms;"
             "[System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"])


def main():
    with open(CONFIG, encoding="utf-8-sig") as f:
        cfg = json.load(f)
    registered = False
    backoff = 5
    log("agent started")
    while True:
        try:
            if not registered:
                request(cfg, "/pc/register", {"token": cfg["token"], "name": cfg["name"],
                                              "mac": cfg["mac"], "weather": cfg.get("weather")})
                registered = True
                backoff = 5
                log("registered with TV")
            reply = request(cfg, f"/pc/next?token={cfg['token']}", timeout=35)
            if reply.get("cmd"):
                do(reply["cmd"])
        except urllib.error.HTTPError as e:
            # 403 on /pc/next means the TV forgot us (config reset): register again.
            registered = False
            log(f"http {e.code}")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
        except (urllib.error.URLError, OSError, ValueError) as e:
            # TV off, TizenBrew closed, or the PC just woke up. Re-register on reconnect
            # in case the service restarted and lost the agent's address.
            registered = False
            log(f"tv unreachable: {e}")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    if "--once" in sys.argv:
        with open(CONFIG, encoding="utf-8-sig") as f:
            print(request(json.load(f), "/status"))
    else:
        main()
