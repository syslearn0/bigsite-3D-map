# ビッグサイトの主催者向け図面（白図、data/private/E_*_c.pdf）から、トイレの位置を読み取って
# 会場の座標に直し、data/plan-toilets.json に書く。図面そのものは git に入れない（個人・非営利の参考としての利用）。
#
# 使い方：python scripts/extract-plan-toilets.py   （PyMuPDF が要る：pip install pymupdf）
#
# やり方
# ・図面の文字（「男子ＷＣ」「ＨＣ」「救護室」）の位置を読む
# ・図面の中のホールの範囲 = 床の灰色の溝（ピット）の外枠。縮尺 1/200 で 1pt = 0.0706m
# ・図面の向きは、4通り回して、ホールの縦横が OSM の形と合い、トイレが建物の中に入る向きを選ぶ
# ・ホールの中心を、会場データ（src/data/venue.json）のホールの中心に合わせる

import json, math, re, sys
from pathlib import Path
import fitz

ROOT = Path(__file__).resolve().parent.parent
PT = 0.0254 / 72 * 200  # 1/200 の図面の 1pt が実物で何 m か
venue = json.loads((ROOT / "src/data/venue.json").read_text(encoding="utf-8"))
osm = json.loads((ROOT / "data/osm/bigsight.json").read_text(encoding="utf-8"))
O = venue["origin"]

def project(lat, lon):
    r = math.pi / 180
    return ((lon - O["lon"]) * r * 6371000 * math.cos(O["lat"] * r), -(lat - O["lat"]) * r * 6371000)

def inside(p, poly):
    x, z = p; c = False
    for i in range(len(poly)):
        x1, z1 = poly[i]; x2, z2 = poly[i - 1]
        if (z1 > z) != (z2 > z) and x < (x2 - x1) * (z - z1) / (z2 - z1) + x1: c = not c
    return c

def min_rect(poly):
    best = None
    for i in range(len(poly)):
        (ax, az), (bx, bz) = poly[i], poly[(i + 1) % len(poly)]
        a = math.atan2(bz - az, bx - ax); c, s = math.cos(a), math.sin(a)
        us = [x * c + z * s for x, z in poly]; vs = [-x * s + z * c for x, z in poly]
        area = (max(us) - min(us)) * (max(vs) - min(vs))
        if best is None or area < best[0]:
            cu, cv = (max(us) + min(us)) / 2, (max(vs) + min(vs)) / 2
            best = (area, (cu * c - cv * s, cu * s + cv * c), a, max(us) - min(us), max(vs) - min(vs))
    return best[1:]  # 中心・u 軸の角・u の長さ・v の長さ

# 建物の外形（トイレがこの中に入る向きを選ぶ）
buildings = []
for e in osm["elements"]:
    if e.get("tags", {}).get("name") in ("東展示棟", "東新展示棟", "西展示棟", "南展示場") and e.get("geometry"):
        buildings.append([project(g["lat"], g["lon"]) for g in e["geometry"]])

halls = {h["id"]: h for h in venue["halls"]}
# 図面とホール。南3・南4・西3・西4 は 4F
# 東3（ほぼ画像だけ）・東7・東8（文字が絵）・西3・西4（溝が点線で、ホールの範囲と向きを決めきれない）は、まだ読めない
PLANS = {"E1": "E_E1_c", "E2": "E_E2_c", "W1": "E_W1_c", "W2": "E_W2_c", "S1": "E_S1_c", "S2": "E_S2_c", "S3": "E_S3_c", "S4": "E_S4_c"}
# 溝が点線で自動で取れない図面は、図面の画像から読んだホールの範囲（中心 x・y、幅・高さ、pt）
MANUAL = {"S3": (821, 611, 968, 1086), "S4": (838, 1440, 1017, 1174)}
# 図面の向き：図面の「下」か「右」が、どのホールの方を向くか（"-ID" ならそこから遠ざかる向き）。図面を見て決めた
# ・東1・東2：下が東4〜6 との間の通路（エスカレーター）、上が搬入口
# ・南1〜4：下がエントランスホール・西2 の搬入口（西展示棟の側）、上が南2（南4）の側
# ・西1・西2：上がトラックヤード。アトリウムをはさんで、西1 の右に西2
ORIENT = {"E1": ("down", "E5"), "E2": ("down", "E5"), "S1": ("down", "W1"), "S2": ("down", "W1"), "S3": ("down", "W1"), "S4": ("down", "W1"),
          "W1": ("right", "W2"), "W2": ("right", "-W1")}

WC = re.compile(r"ＷＣ|WC")
HC = re.compile(r"^ＨＣ$|^HC$")  # 多機能トイレ（「HC=2,285」のような天井高の書き込みは除く）
MALE = re.compile(r"男子")
FEMALE = re.compile(r"女子")
AID = re.compile(r"救護室")

out = []
aids = []
report = []
for hid, name in PLANS.items():
    f = ROOT / "data/private" / f"{name}.pdf"
    if not f.exists() or hid not in halls:
        report.append(f"{hid}: 図面かホールがない")
        continue
    page = fitz.open(f)[0]
    # 床の溝（灰色で塗った細長い四角）の外枠 = 図面の中のホールの範囲
    if hid in MANUAL:
        cx, cy, w_, h_ = MANUAL[hid]
        pw, ph = w_ * PT, h_ * PT
    else:
        # 溝は細長い灰色の塗り（凡例の四角や、大きな「東1」の文字は太いので除く）
        xs, ys = [], []
        for d in page.get_drawings():
            fill = d.get("fill")
            r = d["rect"]
            if fill and abs(fill[0] - fill[1]) < 0.02 and 0.6 < fill[0] < 0.9 and max(r.width, r.height) > 250 and min(r.width, r.height) < 20:
                xs += [r.x0, r.x1]; ys += [r.y0, r.y1]
        if not xs:
            report.append(f"{hid}: 床の溝が見つからない")
            continue
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        pw, ph = (max(xs) - min(xs)) * PT, (max(ys) - min(ys)) * PT
    words = page.get_text("words")
    pts = []
    aid = []
    for w in words:
        t = w[4]
        if AID.search(t):
            aid.append((hid, ((w[0] + w[2]) / 2 - cx) * PT, ((w[1] + w[3]) / 2 - cy) * PT))
        kind = "wc" if WC.search(t) else "hc" if HC.search(t) else None
        if not kind: continue
        px, py = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
        # 近くの「男子」「女子」
        g = None
        for v in words:
            if math.hypot((v[0] + v[2]) / 2 - px, (v[1] + v[3]) / 2 - py) < 40:
                if MALE.search(v[4]): g = "男子"
                elif FEMALE.search(v[4]): g = g or "女子"
        if MALE.search(t): g = "男子"
        elif FEMALE.search(t): g = "女子"
        pts.append(((px - cx) * PT, (py - cy) * PT, "多機能" if kind == "hc" else g or "トイレ"))
    h = halls[hid]
    center, ang, L, W = min_rect(h["poly"])
    best = None
    for k in range(4):
        a = ang + k * math.pi / 2
        rx, rz = math.cos(a), math.sin(a)  # 図面の右 → 会場のこの向き
        dx, dz = -rz, rx  # 図面の下（裏返さない回し方）
        # 図面のホールの縦横と、OSM の形の縦横が合うか
        along_u = (pw, ph) if k % 2 == 0 else (ph, pw)
        size_err = abs(along_u[0] - L) / L + abs(along_u[1] - W) / W
        world = [(center[0] + x * rx + y * dx, center[1] + x * rz + y * dz, kd) for x, y, kd in pts]
        aid_world = [(center[0] + x * rx + y * dx, center[1] + x * rz + y * dz) for _, x, y in aid]
        ins = sum(1 for x, z, _ in world if any(inside((x, z), b) for b in buildings))
        score = ins / max(1, len(world)) - size_err
        if hid in ORIENT:
            axis, ref = ORIENT[hid]
            sign = -1 if ref.startswith("-") else 1
            rp = halls[ref.lstrip("-")]["poly"]
            vx, vz = sum(p[0] for p in rp) / len(rp) - center[0], sum(p[1] for p in rp) / len(rp) - center[1]
            ux, uz = (dx, dz) if axis == "down" else (rx, rz)
            score = sign * (ux * vx + uz * vz) / math.hypot(vx, vz)  # 決めた向きにいちばん近いものを選ぶ
        if best is None or score > best[0]:
            best = (score, k, world, ins, size_err, aid_world, (dx, dz))
    score, k, world, ins, size_err, aid_world, down = best
    for x, z in aid_world:
        aids.append({"level": h["level"], "at": [round(x, 1), round(z, 1)], "hall": hid})
    report.append(f"{hid}: ホールの範囲 {pw:.0f}×{ph:.0f}m（会場データ {L:.0f}×{W:.0f}m）、向き {k * 90}°、トイレの文字 {len(world)}（建物の中 {ins}）{"、向きは図面から" if hid in ORIENT else ""}")
    for x, z, kd in world:
        out.append({"hall": hid, "level": h["level"], "at": [round(x, 1), round(z, 1)], "kind": kd})

# 同じトイレ（隣の図面にも描かれているもの・男女が並ぶもの）を、6m 以内でまとめる
merged = []
for t in out:
    for m in merged:
        if m["level"] == t["level"] and math.hypot(m["at"][0] - t["at"][0], m["at"][1] - t["at"][1]) < 6:
            if t["kind"] not in m["kinds"]: m["kinds"].append(t["kind"])
            break
    else:
        merged.append({"level": t["level"], "at": t["at"], "kinds": [t["kind"]], "hall": t["hall"]})

aid_merged = []
for a in aids:
    if not any(b["level"] == a["level"] and math.hypot(b["at"][0] - a["at"][0], b["at"][1] - a["at"][1]) < 10 for b in aid_merged):
        aid_merged.append(a)
(ROOT / "data/plan-toilets.json").write_text(json.dumps({"source": "株式会社東京ビッグサイト 主催者向け図面（白図）を参考に位置を読み取ったもの", "toilets": merged, "firstAid": aid_merged}, ensure_ascii=False, indent=1), encoding="utf-8")
print("\n".join(report))
print(f"トイレ {len(merged)} か所（文字 {len(out)}）・救護室 {len(aid_merged)} か所を data/plan-toilets.json に")
