import hashlib
import json
import os
import urllib.request

BASE = r"D:\Hima\App\yidongyunpan\移动云盘同步盘\Harness\project\纳西妲_中文配音"
URL = ("https://uploadstatic.mihoyo.com/ys-obc/2022/11/02/16576950/"
       "207cb052df963f3dcf54fc020d19e419_4430928199053665394.mp3")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

man = json.load(open(os.path.join(BASE, "manifest.json"), encoding="utf-8"))
hit = [m for m in man if m["来源URL"] == URL]
print("【清单匹配】")
if hit:
    m = hit[0]
    for k in ("序号", "分类", "台词名", "台词文本", "音频文件", "字节数", "md5"):
        print(f"  {k}: {m[k]}")
else:
    print("  未在清单中找到该 URL")
    m = None

req = urllib.request.Request(URL, headers={"User-Agent": UA, "Referer": "https://baike.mihoyo.com/"})
with urllib.request.urlopen(req, timeout=60) as r:
    body = r.read()
    print("\n【线上文件】")
    print("  HTTP:", r.status)
    print("  Content-Type:", r.headers.get("Content-Type"))
    print("  Content-Length:", r.headers.get("Content-Length"))
    print("  实际字节:", len(body))
    print("  md5:", hashlib.md5(body).hexdigest())
    print("  Last-Modified:", r.headers.get("Last-Modified"))
    print("  Accept-Ranges:", r.headers.get("Accept-Ranges"))

if m:
    p = os.path.join(BASE, m["音频文件"])
    local = open(p, "rb").read()
    print("\n【本地文件】")
    print("  路径:", p)
    print("  字节:", len(local))
    print("  md5:", hashlib.md5(local).hexdigest())
    print("  与线上一致:", hashlib.md5(local).hexdigest() == hashlib.md5(body).hexdigest())
