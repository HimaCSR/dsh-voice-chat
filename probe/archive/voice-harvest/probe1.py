import json
import os
import re
import sys
import urllib.request
import urllib.error

OUT = os.path.dirname(os.path.abspath(__file__))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def get(url, timeout=30, headers=None):
    h = {
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def report(title):
    print("\n" + "=" * 70)
    print(title)
    print("=" * 70)


# ---------- 1. SPA HTML: find the JS bundles ----------
report("1) SPA HTML of content/5111")
try:
    st, body = get("https://baike.mihoyo.com/ys/obc/content/5111/detail")
    html = body.decode("utf-8", "replace")
    open(os.path.join(OUT, "page.html"), "w", encoding="utf-8").write(html)
    print("status:", st, "bytes:", len(html))
    srcs = re.findall(r'<script[^>]+src="([^"]+)"', html)
    links = re.findall(r'<link[^>]+href="([^"]+)"', html)
    print("scripts:")
    for s in srcs:
        print("   ", s)
    print("links:")
    for s in links:
        print("   ", s)
    for kw in ["语音", "voice", "Voice", "audio", "ogg"]:
        print(f"  html contains {kw!r}:", kw in html)
except Exception as e:
    print("ERR:", type(e).__name__, e)

# ---------- 2. content/info JSON: full-field scan ----------
report("2) content/info for 5111 - full scan")
try:
    st, body = get("https://api-takumi-static.mihoyo.com/common/blackboard/"
                   "ys_obc/v1/content/info?app_sn=ys_obc&content_id=5111")
    raw = body.decode("utf-8", "replace")
    open(os.path.join(OUT, "content_5111.json"), "w", encoding="utf-8").write(raw)
    print("status:", st, "bytes:", len(raw))
    data = json.loads(raw)
    c = data["data"]["content"]
    print("title:", c["title"])
    print("top-level keys:", list(c.keys()))
    print("contents[] tabs:")
    for i, it in enumerate(c["contents"]):
        print(f"   [{i}] name={it.get('name')!r} textLen={len(it.get('text') or '')}")
    for kw in ["语音", "voice", "Voice", "audio", "ogg", "wav", "mp3"]:
        print(f"  raw contains {kw!r}:", kw in raw)
    # percent-encoded / escaped forms
    for kw in ["%E8%AF%AD%E9%9F%B3", "\\u8bed\\u97f3", "8bed", "97f3"]:
        print(f"  raw contains {kw!r}:", kw in raw)
    # every template partKey / tmplKey present
    keys = sorted(set(re.findall(r'%22(tmplKey|partKey)%22%3A%22([^%]+)%22', raw)))
    print("  tmplKey/partKey pairs (percent-encoded form):")
    for k in keys:
        print("     ", k)
except Exception as e:
    print("ERR:", type(e).__name__, e)

# ---------- 3. reachability of external voice sources ----------
report("3) external voice sources reachability")
tests = [
    ("fandom-nahida-zh", "https://genshin-impact.fandom.com/wiki/Nahida/Voice-Overs/Chinese"),
    ("fandom-api", "https://genshin-impact.fandom.com/api.php?action=parse&page=Nahida%2FVoice-Overs%2FChinese&format=json&prop=wikitext"),
    ("huggingface", "https://huggingface.co/api/datasets/ultemica/genshin-impact-voices/tree/main"),
    ("honeyhunter", "https://genshin.honeyhunterworld.com/nahida_071/?lang=CHS"),
]
for name, url in tests:
    try:
        st, body = get(url, timeout=25)
        txt = body.decode("utf-8", "replace")
        print(f"{name}: HTTP {st}, {len(txt)} bytes; .ogg count={txt.count('.ogg')}")
        open(os.path.join(OUT, f"ext_{name}.txt"), "w", encoding="utf-8").write(txt)
    except urllib.error.HTTPError as e:
        print(f"{name}: HTTPError {e.code}")
    except Exception as e:
        print(f"{name}: ERR {type(e).__name__} {e}")

print("\nDONE")
