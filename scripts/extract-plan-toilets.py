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
# 東3（ほぼ画像だけ）・東7・東8（文字が絵）・西3・西4（溝が点線）は、下で手で読む
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
DOOR = re.compile(r"出入口|エントランス")  # 人が出入りする口
SHUTTER = re.compile(r"搬入口")
ESC = re.compile(r"^(ＥＳ|ES)$")  # エスカレーター
STAFF = re.compile(r"スタッフ|ｽﾀｯﾌ|従業員|控室")  # 搬入口（シャッター）。イベントによっては出入口に使われる

out = []
aids = []
doors = []  # {"hall", "level", "at", "kind": "出入口" | "搬入口"}
report = []
toiletRooms = []  # トイレの部屋の囲み（図面の壁から）
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
    # トイレの部屋の囲み：図面の壁（太さ 0.4pt 以上の縦横の線）を、文字の真ん中から上下左右へ探して、いちばん近い壁で囲まれた四角
    walls_h, walls_v = [], []
    for d in page.get_drawings():
        if (d.get("width") or 0) < 0.4 or d.get("fill"):
            continue
        for it in d["items"]:
            if it[0] != "l":
                continue
            a_, b_ = it[1], it[2]
            if abs(a_.y - b_.y) < 0.5 and abs(a_.x - b_.x) > 4:
                walls_h.append((min(a_.x, b_.x), max(a_.x, b_.x), a_.y))
            elif abs(a_.x - b_.x) < 0.5 and abs(a_.y - b_.y) > 4:
                walls_v.append((min(a_.y, b_.y), max(a_.y, b_.y), a_.x))
    def room_at(px, py):
        lim = 15 / PT  # 15m まで
        left = max((x for y0, y1, x in walls_v if y0 - 1 <= py <= y1 + 1 and px - lim < x < px - 2), default=None)
        right = min((x for y0, y1, x in walls_v if y0 - 1 <= py <= y1 + 1 and px + 2 < x < px + lim), default=None)
        up = max((y for x0, x1, y in walls_h if x0 - 1 <= px <= x1 + 1 and py - lim < y < py - 2), default=None)
        down = min((y for x0, x1, y in walls_h if x0 - 1 <= px <= x1 + 1 and py + 2 < y < py + lim), default=None)
        if None in (left, right, up, down):
            return None
        wm, hm = (right - left) * PT, (down - up) * PT
        if not (1.5 <= wm <= 15 and 1.5 <= hm <= 15):
            return None
        return [((x - cx) * PT, (y - cy) * PT) for x, y in ((left, up), (right, up), (right, down), (left, down))]
    rooms = []
    pts = []
    aid = []
    door = []
    for w in words:
        t = w[4]
        if AID.search(t):
            aid.append((hid, ((w[0] + w[2]) / 2 - cx) * PT, ((w[1] + w[3]) / 2 - cy) * PT))
        dk = "出入口" if DOOR.search(t) else "搬入口" if SHUTTER.search(t) else "ES" if ESC.match(t) else None
        if dk:
            door.append((dk, ((w[0] + w[2]) / 2 - cx) * PT, ((w[1] + w[3]) / 2 - cy) * PT))
        kind = "wc" if WC.search(t) else "hc" if HC.search(t) else None
        if not kind: continue
        px, py = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
        # スタッフ用のトイレ（「女子ｽﾀｯﾌ WC」など）は、来場者は使えないので入れない
        if any(STAFF.search(v[4]) and math.hypot((v[0] + v[2]) / 2 - px, (v[1] + v[3]) / 2 - py) < 30 for v in words):
            continue
        # 近くの「男子」「女子」
        g = None
        for v in words:
            if math.hypot((v[0] + v[2]) / 2 - px, (v[1] + v[3]) / 2 - py) < 40:
                if MALE.search(v[4]): g = "男子"
                elif FEMALE.search(v[4]): g = g or "女子"
        if MALE.search(t): g = "男子"
        elif FEMALE.search(t): g = "女子"
        pts.append(((px - cx) * PT, (py - cy) * PT, "多機能" if kind == "hc" else g or "トイレ"))
        rm = room_at(px, py)
        if rm and not any(all(abs(a[0] - b[0]) < 0.3 and abs(a[1] - b[1]) < 0.3 for a, b in zip(rm, r2)) for r2 in rooms):
            rooms.append(rm)
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
        door_world = [(center[0] + x * rx + y * dx, center[1] + x * rz + y * dz, dk) for dk, x, y in door]
        room_world = [[(round(center[0] + x * rx + y * dx, 2), round(center[1] + x * rz + y * dz, 2)) for x, y in rm] for rm in rooms]
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
            best = (score, k, world, ins, size_err, aid_world, (dx, dz), door_world, room_world)
    score, k, world, ins, size_err, aid_world, down, door_world, room_world = best
    for rw in room_world:
        toiletRooms.append({"hall": hid, "level": h["level"], "poly": [list(q) for q in rw]})
    for x, z, dk in door_world:
        doors.append({"hall": hid, "level": h["level"], "at": [round(x, 1), round(z, 1)], "kind": dk})
    for x, z in aid_world:
        aids.append({"level": h["level"], "at": [round(x, 1), round(z, 1)], "hall": hid})
    report.append(f"{hid}: ホールの範囲 {pw:.0f}×{ph:.0f}m（会場データ {L:.0f}×{W:.0f}m）、向き {k * 90}°、トイレの文字 {len(world)}（建物の中 {ins}）{"、向きは図面から" if hid in ORIENT else ""}")
    for x, z, kd in world:
        out.append({"hall": hid, "level": h["level"], "at": [round(x, 1), round(z, 1)], "kind": kd})

# ---- 文字を自動で読めない図面は、図面の画像を見て手で読んだ位置 ----
# 東3：A4 の図面（1/200 の A1 を縮めたもの。1pt ≒ 0.2m）。120dpi の画像の px で読んだ（1px = 0.6pt）。
#   向きは東1・東2 と同じ（下が東4〜6 との間の通路）。ホールの溝の中心を会場データの東3の中心に合わせる
# 東7・東8：A3 の図面（1/600。1pt ≒ 0.212m）。140dpi の画像の px で読んだ（1px = 72/140 pt）。
#   北の矢印が図面の左下を向くので、図面の右 → 会場の 135° の向き（会場データの辺の向きにそろえる）。
#   東7ホールの右下の直角の角を、会場データの東7のいちばん西の角に合わせる。
#   東8の図面は東7と同じ向き・縮尺で、両方に描かれたリンクスペースのトイレから、東8の図面の点 + (460, -1035) が東7の図面の点
# 西3・西4：1/200。西3の図面の pt で読んだ。西4の図面は中身が 90° 回っているので、両方にある搬入口の名前
#   （西3-A・西4-A）で西3の図面に重ねた（西4の点 (x, y) → 西3の図面 (502 + y - 209, 344 - x + 1109)。両方に描かれたトイレが重なる）。
#   向きは、図面の上が西4の側。西3ホールの溝の中心を会場データの西3の中心に合わせる
def nearest_axis(h, want):
    """会場データのホールの辺の向き（4通り）のうち、want（ラジアン）にいちばん近いもの"""
    _, ang, _, _ = min_rect(h["poly"])
    return min((ang + k * math.pi / 2 for k in range(4)), key=lambda a: abs(math.atan2(math.sin(a - want), math.cos(a - want))))

def toward(hid, ref):
    """ホール hid の中心から ref の中心への向き（ラジアン）"""
    c, _, _, _ = min_rect(halls[hid]["poly"])
    rp = halls[ref]["poly"]
    return math.atan2(sum(p[1] for p in rp) / len(rp) - c[1], sum(p[0] for p in rp) / len(rp) - c[0])

def place_doors(hid, a, anchor_world, pts):
    """出入口・搬入口を place と同じやり方で会場の座標に"""
    rx, rz = math.cos(a), math.sin(a); dx, dz = -rz, rx
    for (x, y), kind in pts:
        doors.append({"hall": hid, "level": halls[hid]["level"], "at": [round(anchor_world[0] + x * rx + y * dx, 1), round(anchor_world[1] + x * rz + y * dz, 1)], "kind": kind})

def place(hid, a, anchor_world, pts):
    """図面の点（anchor からの m。図面の右・下）を会場の座標に。a：図面の右が向く角"""
    rx, rz = math.cos(a), math.sin(a); dx, dz = -rz, rx
    for (x, y), kinds in pts:
        for kd in kinds:
            out.append({"hall": hid, "level": halls[hid]["level"], "at": [round(anchor_world[0] + x * rx + y * dx, 1), round(anchor_world[1] + x * rz + y * dz, 1)], "kind": kd})

# 東3
s3 = 0.6 * 0.0254 / 72 * 566  # px → m
c3, _, _, _ = min_rect(halls["E3"]["poly"])
a3 = nearest_axis(halls["E3"], toward("E3", "E5") - math.pi / 2)  # 図面の下が東5の側 → 図面の右はそこから 90° 戻した向き
place("E3", a3, c3, [(((x - 487) * s3, (y - 505) * s3), k) for (x, y), k in [
    ((270, 100), ["男子", "女子", "多機能"]),  # 左上、搬入口の側
    ((760, 965), ["男子", "女子", "多機能"]),  # 右下、通路の側
    ((610, 1210), ["男子", "女子", "多機能"]),  # 通路の向こう側
]])
place_doors("E3", a3, c3, [(((x - 487) * s3, (y - 505) * s3), k) for (x, y), k in [
    ((420, 932), "出入口"), ((575, 932), "出入口"),  # 通路の側
    ((420, 115), "搬入口"), ((575, 115), "搬入口"), ((45, 330), "搬入口"), ((45, 690), "搬入口"),  # 東3-B・A・C・D
]])
report.append("E3: 画像から手で読んだ 3 か所（出入口・搬入口 6）")

# 東7・東8
s7 = 72 / 140 * 0.0254 / 72 * 600
a7 = nearest_axis(halls["E7"], math.radians(135))
r7 = (math.cos(a7), math.sin(a7)); d7 = (-r7[1], r7[0])
corner = max(halls["E7"]["poly"], key=lambda v: v[0] * (r7[0] + d7[0]) + v[1] * (r7[1] + d7[1]))
e7 = [((1530, 1060), ["男子", "多機能"]), ((1530, 1215), ["女子", "多機能"]), ((1095, 60), ["女子", "多機能"]), ((1530, 75), ["男子"])]
e8 = [((740, 925), ["男子", "女子", "多機能"]), ((1430, 1320), ["男子", "女子", "多機能"])]
pts7 = [(((x - 1440) * s7, (y - 1290) * s7), k) for (x, y), k in e7 + [((x + 460, y - 1035), k) for (x, y), k in e8]]
place("E7", a7, corner, pts7[:4])
place("E8", a7, corner, pts7[4:])
place_doors("E7", a7, corner, [(((x - 1440) * s7, (y - 1290) * s7), k) for (x, y), k in [
    ((790, 1310), "搬入口"), ((1070, 1310), "搬入口"),  # 東7-A・B
    ((1520, 145), "出入口"),  # エントランス（リンクスペースの東）
]])
report.append("E7・E8: 画像から手で読んだ 6 か所（出入口・搬入口 3）")

# 西3・西4
c_w3, _, _, _ = min_rect(halls["W3"]["poly"])
a_w3 = nearest_axis(halls["W3"], toward("W3", "W4") + math.pi / 2)  # 図面の上が西4の側 → 図面の右はそこから 90° 進めた向き
w4 = lambda x, y: (502 + y - 209, 344 - x + 1109)
place("W3", a_w3, c_w3, [(((x - 849) * PT, (y - 1503) * PT), k) for (x, y), k in [
    ((510, 1190), ["男子", "多機能"]),  # 左（搬入口の側）
    ((512, 1484), ["女子", "多機能"]),
    ((1330, 840), ["男子", "女子", "多機能"]),  # 右上（西4との間の角）
    (w4(1449, 732), ["女子"]),
    (w4(1451, 1062), ["男子"]),
]])
# 西3・西4 の出入口・搬入口は、図面の文字の位置（西4 は西3 の図面に重ねる）
wd = []
for name, conv in [("E_W3_c", lambda x, y: (x, y)), ("E_W4_c", w4)]:
    for w in fitz.open(ROOT / "data/private" / f"{name}.pdf")[0].get_text("words"):
        dk = "出入口" if DOOR.search(w[4]) else "搬入口" if SHUTTER.search(w[4]) else None
        if dk:
            x, y = conv((w[0] + w[2]) / 2, (w[1] + w[3]) / 2)
            wd.append((((x - 849) * PT, (y - 1503) * PT), dk))
place_doors("W3", a_w3, c_w3, wd)
report.append(f"W3・W4: 図面の文字の位置から手で読んだ 5 か所（出入口・搬入口 {len(wd)}）")
# 西のアトリウムのエスカレーター（西3 の図面の「ＥＳＣ」）：4F に着く所は「ＥＳＣ」の段の上端、下る向きは段にそって
# 斜めの吹抜けの壁と平行（図面の左下）。図面で段の線を読んだ位置（pt）
rx_, rz_ = math.cos(a_w3), math.sin(a_w3); dx_, dz_ = -rz_, rx_
def w3v(x, y):
    x, y = (x - 849) * PT, (y - 1503) * PT
    return [round(c_w3[0] + x * rx_ + y * dx_, 1), round(c_w3[1] + x * rz_ + y * dz_, 1)]
esc_top = (1462, 1922)  # 段の上端の真ん中（4F）
esc_dir = (-350, 315)  # 段にそって下る向き（図面）
L_ = math.hypot(*esc_dir)
westEsc = {"top": w3v(*esc_top), "dir": [round(esc_dir[0] / L_ * rx_ + esc_dir[1] / L_ * dx_, 3), round(esc_dir[0] / L_ * rz_ + esc_dir[1] / L_ * dz_, 3)]}
report.append(f"西アトリウムのエスカレーター：4F の上端 {westEsc['top']}")

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
# 出入口・搬入口：同じ種類で 5m 以内は同じもの
door_merged = []
for d in doors:
    if not any(e["level"] == d["level"] and e["kind"] == d["kind"] and math.hypot(e["at"][0] - d["at"][0], e["at"][1] - d["at"][1]) < 5 for e in door_merged):
        door_merged.append(d)
# ---- 東展示棟 2F の吹き抜け：施設案内の「2F全体図」（facility_all.pdf の5ページ目）の、ガレリアの上の ×印の四角 ----
# 図面は90°回して描かれているので、回さない向き（PDF の中の座標）で読む。東1〜5 ホールの「上部」の ×印の四角の真ん中を
# 会場データのホールの真ん中に合わせる一次変換（裏返しも含む）で写す
def read_voids():
    f = ROOT / "data/private/facility_all.pdf"
    if not f.exists():
        return []
    p = fitz.open(f)[4]
    p.set_rotation(0)
    # 斜めの線の外枠（×の2本は同じ外枠になる）。外枠ごとに、向きのちがう斜め線が両方あるかを数える
    boxes = []  # [外枠, 向き(+1/-1) の集合]
    for dr in p.get_drawings():
        for it in dr["items"]:
            if it[0] != "l":
                continue
            a, b = it[1], it[2]
            if abs(b.x - a.x) > 3 and abs(b.y - a.y) > 6:
                bx = (min(a.x, b.x), min(a.y, b.y), max(a.x, b.x), max(a.y, b.y))
                sign = 1 if (b.x - a.x) * (b.y - a.y) > 0 else -1
                hit = next((q for q in boxes if all(abs(u - v) < 1.5 for u, v in zip(bx, q[0]))), None)
                if hit:
                    hit[1].add(sign)
                else:
                    boxes.append([bx, {sign}])
    xs = [q[0] for q in boxes if len(q[1]) == 2]  # × になっている四角だけ
    # ホールの「上部」の×：一辺 50〜60pt の正方形。東1〜3 は左、東4〜6 は右
    big = [q for q in xs if 50 < q[2] - q[0] < 60 and 50 < q[3] - q[1] < 60 and 330 < q[0] < 430 and 370 < q[1] < 600]
    left = sorted([q for q in big if q[0] < 400], key=lambda q: q[1])
    right = sorted([q for q in big if q[0] > 400], key=lambda q: q[1])
    if len(left) < 3 or len(right) < 3:
        return []
    src = [((q[0] + q[2]) / 2, (q[1] + q[3]) / 2) for q in left[:3] + right[:3]]
    def cen(hid):
        poly = halls[hid]["poly"]
        return (sum(x for x, _ in poly) / len(poly), sum(z for _, z in poly) / len(poly))
    dst = [cen(h) for h in ["E1", "E2", "E3", "E4", "E5", "E6"]]
    import numpy as np
    A = np.array([[x, y, 1] for x, y in src]); B = np.array(dst)
    M, *_ = np.linalg.lstsq(A, B, rcond=None)
    err = float(np.max(np.hypot(*(A @ M - B).T)))
    gx0, gx1 = left[0][2], right[0][0]  # ガレリア（左右のホールの × のあいだ）
    gy0, gy1 = min(q[1] for q in big), max(q[3] for q in big)
    voids = []
    voidStairs.clear()
    voidWalls.clear()
    for q in xs:
        if q[0] >= gx0 - 1 and q[2] <= gx1 + 1 and q[1] >= gy0 - 5 and q[3] <= gy1 + 5 and q[2] - q[0] >= 3 and q[3] - q[1] >= 8:
            corners = [(q[0], q[1]), (q[2], q[1]), (q[2], q[3]), (q[0], q[3])]
            voids.append([[round(float(v), 1) for v in np.array([x, y, 1]) @ M] for x, y in corners])
    # 吹き抜けの中の階段・エスカレーター：2F全体図では、吹き抜けの片方の端に、段（短い横線がならぶ）が描かれている。
    # 段の多い方の端が 2F に着く所。そこから吹き抜けの中へ、階段（幅の半分）とエスカレーター（となり）を 1F へ下ろす
    segs = []
    for dr in p.get_drawings():
        for it in dr["items"]:
            if it[0] == "l":
                segs.append((it[1].x, it[1].y, it[2].x, it[2].y))
    to_v = lambda x, y: [round(float(v), 1) for v in np.array([x, y, 1]) @ M]
    for q in xs:
        if not (q[0] >= gx0 - 1 and q[2] <= gx1 + 1 and q[1] >= gy0 - 5 and q[3] <= gy1 + 5 and q[2] - q[0] >= 3 and q[3] - q[1] >= 8):
            continue
        w = q[2] - q[0]
        treads = [((a + c) / 2, (b + d) / 2) for a, b, c, d in segs
                  if abs(d - b) < 0.3 and 0.15 * w < abs(c - a) < 0.7 * w and q[0] - 0.5 <= min(a, c) and max(a, c) <= q[2] + 0.5 and q[1] - 0.5 <= b <= q[3] + 0.5]
        if len(treads) < 4:
            continue
        ym = (q[1] + q[3]) / 2
        top_at_y0 = sum(1 for _, y in treads if y < ym) >= sum(1 for _, y in treads if y >= ym)
        ye, sgn = (q[1], 1) if top_at_y0 else (q[3], -1)
        run = 7.0  # 図面の pt（約 11m）。上の端は吹き抜けの縁から 0.3pt（約 0.5m）2F の床の下へ入れて、すき間を作らない
        # ストリートビュー：ガレリアの真ん中に、2F の真ん中の通路を支える壁があり、その壁にそって、階段とエスカレーターが
        # 吹き抜けの真ん中から両端へ（逆の向きに）上がっている。なので、どちらも吹き抜けの内側（ガレリアの真ん中の側）の辺にそわせる
        gmid = (gx0 + gx1) / 2
        inner = q[2] if abs(q[2] - gmid) < abs(q[0] - gmid) else q[0]
        voidWalls.append([to_v(inner, q[1]), to_v(inner, q[3])])  # 真ん中の壁（2F の真ん中の通路の下）
        # 2F全体図では、階段の段は吹き抜けの内側（真ん中の通路の側）の辺に描かれている。
        # ただし東4〜6 の側（図面の右）の吹き抜けは、ユーザーの確認で東4〜6 の側の辺に寄せる
        if (q[0] + q[2]) / 2 > gmid:
            outer = q[0] if inner == q[2] else q[2]
            stair_x = outer + (w * 0.22 if outer == q[0] else -w * 0.22)
            esc_x = outer + (w * 0.1 if outer == q[0] else -w * 0.1)
        else:
            stair_x = inner - (w * 0.22 if inner == q[2] else -w * 0.22)
            esc_x = inner - (w * 0.1 if inner == q[2] else -w * 0.1)
        voidStairs.append({"kind": "stairs", "from": to_v(stair_x, ye - sgn * 0.3), "to": to_v(stair_x, ye + sgn * run), "width": round(w * 0.4 * 1.64, 1)})
        # エスカレーターは、階段と反対の端で 2F に着く（ストリートビュー・写真：吹き抜けの下で、階段とエスカレーターが逆の向きに上がっている）
        yo = q[3] if top_at_y0 else q[1]
        voidStairs.append({"kind": "escalator", "from": to_v(esc_x, yo + sgn * 0.3), "to": to_v(esc_x, yo - sgn * run), "width": 1.6})
    report.append(f"東展示棟 2F の吹き抜け {len(voids)}（ホールの真ん中のずれ 最大 {err:.1f}m）")
    return voids

voidStairs = []  # 吹き抜けの中の階段・エスカレーター（2F の端 from → 1F to）
voidWalls = []  # 吹き抜けの内側の辺にそった壁（1F から 2F まで）
voids = read_voids()
(ROOT / "data/plan-toilets.json").write_text(json.dumps({"source": "株式会社東京ビッグサイト 主催者向け図面（白図）を参考に位置を読み取ったもの", "toilets": merged, "firstAid": aid_merged, "doors": door_merged, "voids": voids, "voidStairs": voidStairs, "voidWalls": voidWalls, "westEsc": westEsc, "toiletRooms": toiletRooms}, ensure_ascii=False, indent=1), encoding="utf-8")
print("\n".join(report))
print(f"トイレ {len(merged)} か所（文字 {len(out)}）・救護室 {len(aid_merged)} か所・出入口 {sum(d['kind'] == '出入口' for d in door_merged)}・搬入口 {sum(d['kind'] == '搬入口' for d in door_merged)} を data/plan-toilets.json に")
