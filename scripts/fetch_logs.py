import os
import requests
import sys

token = os.environ.get("GH_TOKEN_VAR", "")
run_id = sys.argv[1]
url = f"https://api.github.com/repos/roco007/kbm-remote/actions/runs/{run_id}/jobs"
d = requests.get(url, headers={"Authorization": f"Bearer {token}"}).json()
for j in d.get("jobs", []):
    print(f"=== JOB: {j['name']} | {j['conclusion']} ===")
    log_url = f"https://api.github.com/repos/roco007/kbm-remote/actions/jobs/{j['id']}/logs"
    log = requests.get(log_url, headers={"Authorization": f"Bearer {token}"}).text
    lines = log.splitlines()
    print("\n".join(lines[-60:]))
    print()
