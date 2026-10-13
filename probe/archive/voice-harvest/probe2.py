import json
import os
import re
import urllib.parse

OUT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(OUT, "content_5111.json")

raw = open(SRC, encoding="utf-8").read()
doc = json.loads(raw)
content = doc["data"]["content"]

lines = []


def w(s=""):
    lines.append(str(s))


w("title: " + content["title"])
w("tabs:")
for i, it in enumerate(content["contents"]):
    w(f"  [{i}] {it.get('name')}  textLen={len(it.get('text') or '')}")

# collect every obc-tmpl block's data-data
blocks = []  # (tab_index, tab_name, parsed_data_list)
for i, it in enumerate(content["contents"]):
    html = it.get("text") or ""
    for m in re.finditer(r'data-data="([^"]*)"', html):
        enc = m.group(1)
        try:
            dec = urllib.parse.unquote(enc)
            data = json.loads(dec)
        except Exception as e:
            blocks.append((i, it.get("name"), None, f"PARSE_ERR {e}"))
            continue
        blocks.append((i, it.get("name"), data, None))

w("\nblocks found: %d" % len(blocks))
for i, name, data, err in blocks:
    if err:
        w(f"  tab[{i}] {name}: {err}")
        continue
    keys = [(d.get("tmplKey"), d.get("partKey")) for d in data]
    w(f"  tab[{i}] {name}: {keys}")

# dump the voice blocks in full
voice_blocks = []
for i, name, data, err in blocks:
    if err or not data:
        continue
    for d in data:
        if d.get("partKey") == "voiceTab" or d.get("tmplKey") == "voice":
            voice_blocks.append((i, name, d))

w("\nvoice blocks: %d" % len(voice_blocks))
for i, name, d in voice_blocks:
    open(os.path.join(OUT, "voice_raw_%d.json" % i), "w", encoding="utf-8").write(
        json.dumps(d, ensure_ascii=False, indent=2))

# also scan the raw html of every tab for audio-ish urls
w("\n--- audio-ish URL scan over whole payload ---")
pats = [
    r'https?://[^"\'\\\s<>)]+\.(?:mp3|ogg|wav|m4a)',
    r'https?://[^"\'\\\s<>)]+\.(?:mp3|ogg|wav|m4a)\?[^"\'\\\s<>)]*',
]
found = []
for p in pats:
    for m in re.finditer(p, raw, re.I):
        found.append(m.group(0))
uniq = sorted(set(found))
w("unique audio urls: %d" % len(uniq))
for u in uniq[:40]:
    w("  " + u)
if len(uniq) > 40:
    w("  ... (%d more)" % (len(uniq) - 40))

w("\n--- count of key tokens in whole payload ---")
for kw in ["voiceTab", "语音", "audio", ".mp3", "mp3", "cvName", "cv", "台词", "分类"]:
    w(f"  {kw!r}: {raw.count(kw)}")

open(os.path.join(OUT, "voice_report.txt"), "w", encoding="utf-8").write("\n".join(lines))
print("report written")
