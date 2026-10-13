import hashlib
import json
import os
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = r"D:\Hima\App\yidongyunpan\移动云盘同步盘\Harness\project\纳西妲_中文配音"
PROBE = r"D:\Hima\App\yidongyunpan\移动云盘同步盘\Harness\project\probe"
MP3 = os.path.join(BASE, "mp3")
os.makedirs(MP3, exist_ok=True)

items = json.load(open(os.path.join(PROBE, "voice_cn.json"), encoding="utf-8"))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

BAD = r'[\\/:*?"<>|\r\n\t]'


def safe(s):
    s = re.sub(BAD, "_", s).strip().rstrip(".")
    return s[:80]


def classify(name):
    if name.startswith("初次见面"):
        return "01 初识与问候"
    if name.startswith("闲聊"):
        return "02 闲聊"
    if name.split("…")[0].split("·")[0] in {
        "下雨的时候", "打雷的时候", "下雪的时候", "阳光很好", "起风的时候",
        "早上好", "中午好", "晚上好", "晚安"}:
        return "03 天气与时段问候"
    if name.startswith(("关于纳西妲自己", "想要了解纳西妲", "纳西妲的爱好", "纳西妲的烦恼")):
        return "04 关于纳西妲自己"
    if name.startswith(("关于我们", "关于「神之眼」", "有什么想要分享", "感兴趣的见闻")):
        return "05 见闻与分享"
    if name.startswith("关于"):
        return "06 关于他人"
    if name.startswith(("喜欢的食物", "讨厌的食物")):
        return "07 喜好"
    if name.startswith(("收到赠礼", "生日")):
        return "08 赠礼与生日"
    if name.startswith("突破的感受"):
        return "09 突破感受"
    if name.startswith(("元素战技", "元素爆发")):
        return "10 战斗·技能"
    if name.startswith(("打开宝箱", "生命值低", "同伴生命值低", "倒下", "重受击", "加入队伍")):
        return "11 战斗·探索与状态"
    return "99 未归类"


def fetch_one(idx, it):
    num = "%03d" % idx
    fname = f"{num}_{safe(it['name'])}.mp3"
    path = os.path.join(MP3, fname)
    url = it["audio"]
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Referer": "https://baike.mihoyo.com/",
                "Accept": "audio/webm,audio/ogg,audio/*;q=0.9,*/*;q=0.8",
            })
            with urllib.request.urlopen(req, timeout=60) as r:
                b = r.read()
                ctype = r.headers.get("Content-Type", "")
            if len(b) < 512 or "audio" not in ctype:
                raise ValueError(f"unexpected payload ctype={ctype} len={len(b)}")
            with open(path, "wb") as f:
                f.write(b)
            return dict(ok=True, idx=idx, file=fname, bytes=len(b),
                        md5=hashlib.md5(b).hexdigest(), ctype=ctype)
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
            time.sleep(1.2 * (attempt + 1))
    return dict(ok=False, idx=idx, file=fname, error=last, url=url)


records = []
with ThreadPoolExecutor(max_workers=8) as ex:
    futs = {ex.submit(fetch_one, i, it): i for i, it in enumerate(items, 1)}
    for f in as_completed(futs):
        records.append(f.result())

records.sort(key=lambda r: r["idx"])
by_idx = {r["idx"]: r for r in records}

ok = [r for r in records if r["ok"]]
fail = [r for r in records if not r["ok"]]
print(f"downloaded OK: {len(ok)}/{len(items)}")
for r in fail:
    print("  FAIL", r["idx"], r["file"], r["error"])

# ---------- manifest ----------
manifest = []
for i, it in enumerate(items, 1):
    r = by_idx[i]
    manifest.append({
        "序号": i,
        "分类": classify(it["name"]),
        "台词名": it["name"],
        "台词文本": it["content"],
        "字数": len(it["content"]),
        "音频文件": "mp3/" + r["file"] if r["ok"] else None,
        "字节数": r.get("bytes"),
        "md5": r.get("md5"),
        "来源URL": it["audio"],
        "下载状态": "ok" if r["ok"] else r.get("error"),
    })

json.dump(manifest, open(os.path.join(BASE, "manifest.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)

# CSV (utf-8-sig so Excel opens Chinese correctly)
import csv
with open(os.path.join(BASE, "纳西妲中文语音清单.csv"), "w", encoding="utf-8-sig", newline="") as f:
    wr = csv.DictWriter(f, fieldnames=list(manifest[0].keys()))
    wr.writeheader()
    wr.writerows(manifest)

# grouped markdown
lines = ["# 纳西妲 中文配音（汉语）全部语音 · 74 条", "",
         "来源：观测枢词条 `content_id=5111` 的「配音展示」模块（`partKey: voiceTab`，`attr[].name_ = 汉语`）。",
         "音频为官方 mp3 直链，未做任何转码。", ""]
groups = {}
for m in manifest:
    groups.setdefault(m["分类"], []).append(m)
for g in sorted(groups):
    lines.append(f"## {g}（{len(groups[g])} 条）")
    lines.append("")
    lines.append("| # | 台词名 | 文本 | 音频 |")
    lines.append("|---|---|---|---|")
    for m in groups[g]:
        txt = m["台词文本"].replace("|", "\\|")
        lines.append(f"| {m['序号']} | {m['台词名']} | {txt} | `{m['音频文件']}` |")
    lines.append("")

# plain text script
lines.append("## 纯文本台词稿")
lines.append("")
for m in manifest:
    lines.append(f"{m['序号']:03d} 【{m['分类']}】{m['台词名']}")
    lines.append(f"    {m['台词文本']}")
    lines.append("")

open(os.path.join(BASE, "纳西妲中文语音台词稿.md"), "w", encoding="utf-8").write("\n".join(lines))

total = sum(m["字节数"] or 0 for m in manifest)
print(f"manifest entries: {len(manifest)}")
print(f"total audio bytes: {total} ({total/1024/1024:.2f} MB)")
print("categories:", {k: len(v) for k, v in sorted(groups.items())})
