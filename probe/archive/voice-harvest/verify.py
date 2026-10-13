import json
import os

BASE = r"D:\Hima\App\yidongyunpan\移动云盘同步盘\Harness\project\纳西妲_中文配音"
MP3 = os.path.join(BASE, "mp3")
man = json.load(open(os.path.join(BASE, "manifest.json"), encoding="utf-8"))

files = sorted(os.listdir(MP3))
print("files on disk:", len(files))
print("manifest rows:", len(man))

missing = [m["序号"] for m in man if not os.path.exists(os.path.join(BASE, m["音频文件"]))]
print("missing files:", missing or "none")

bad_magic = []
bad_size = []
for m in man:
    p = os.path.join(BASE, m["音频文件"])
    with open(p, "rb") as f:
        head = f.read(3)
    sz = os.path.getsize(p)
    # ID3 tag, or MPEG frame sync 0xFF Ex
    if not (head == b"ID3" or (head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)):
        bad_magic.append((m["序号"], head.hex()))
    if sz != m["字节数"] or sz < 1024:
        bad_size.append((m["序号"], sz, m["字节数"]))
print("bad magic:", bad_magic or "none")
print("bad size:", bad_size or "none")

# no duplicate audio content
from collections import Counter
c = Counter(m["md5"] for m in man)
dups = {k: v for k, v in c.items() if v > 1}
print("duplicate audio content:", dups or "none")

empty_text = [m["序号"] for m in man if not m["台词文本"].strip()]
print("empty text:", empty_text or "none")

total = sum(m["字节数"] for m in man)
print("total: %.2f MB" % (total / 1024 / 1024))
print()
print("--- sample filenames ---")
for f in files[:5] + files[-3:]:
    print("  ", f)
