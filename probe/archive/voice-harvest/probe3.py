import json
import os
import urllib.request

OUT = os.path.dirname(os.path.abspath(__file__))
d = json.load(open(os.path.join(OUT, "voice_raw_2.json"), encoding="utf-8"))
data = d["data"]

L = []
def w(s=""):
    L.append(str(s))

w("partKey: " + d["partKey"])
w("data.name: " + data.get("name", ""))
w("attr groups: %d" % len(data["attr"]))
w()
for a in data["attr"]:
    items = a.get("items") or []
    w(f'  [{a.get("name_")}] items={len(items)}')
    if items:
        w("      first: " + items[0]["name"])
        w("      last : " + items[-1]["name"])

# Chinese group
cn = None
for a in data["attr"]:
    if a.get("name_") in ("汉语", "中文", "国语"):
        cn = a
        break
w()
w("chinese group found: " + str(cn is not None))
items = cn["items"]
w("chinese item count: %d" % len(items))
w()
w("all chinese entries:")
for i, it in enumerate(items, 1):
    w(f'  {i:03d}\t{it["name"]}\t{len(it["content"])}字\t{it["audio"]}')

# schema key check
w()
w("item keys union: " + str(sorted({k for it in items for k in it.keys()})))

open(os.path.join(OUT, "voice_cn_list.txt"), "w", encoding="utf-8").write("\n".join(L))

# also dump a clean chinese-only json
json.dump(items, open(os.path.join(OUT, "voice_cn.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)

# verify one audio is really downloadable
u = items[0]["audio"]
req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://baike.mihoyo.com/"})
with urllib.request.urlopen(req, timeout=30) as r:
    b = r.read()
print("probe mp3:", r.status, len(b), "bytes", r.headers.get("Content-Type"))
open(os.path.join(OUT, "_probe_first.mp3"), "wb").write(b)
print("list written")
