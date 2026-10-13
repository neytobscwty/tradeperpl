import re
import requests
from urllib.parse import urljoin

base = "https://app.perpl.xyz"
html = requests.get(base, timeout=20).text
for asset in re.findall(r'(?:src|href)=["\']([^"\']+\.js[^"\']*)', html):
    url = urljoin(base, asset)
    body = requests.get(url, timeout=30).content
    target = ".test-tmp/perpl-app.js"
    open(target, "wb").write(body)
    print(f"{url} -> {target} ({len(body)} bytes)")
