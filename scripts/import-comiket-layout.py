# コミックマーケット準備会の「会場案内図・配置図」（サークル参加者向けの PDF。C108 では C108AppealEnclosure.pdf）から、
# 机1つずつの位置と番号を読み取り、配置のファイル（エディタで読み込める comiket3d-layout）にする。
# PDF も、できたファイルも git に入れない（data/private/ に置く。準備会の資料なので、公開に使うかは準備会に確かめてから）。
#
# 使い方：python scripts/import-comiket-layout.py 配置図.pdf [出力.json]
#   （PyMuPDF が要る：pip install pymupdf。出力の既定は data/private/layout-c108.json）
#   できたファイルを、島のエディタの「机の配置（管理用）」→「読み込み」で入れる。
#
# やり方
# ・配置図の机は、番号の入った小さな四角。四角と番号の位置を読み、となり合う四角を「島」（2列）・「壁ぞいの列」（1列）にまとめる
# ・列の名前（ア・A・あ・a など）の文字を、島の並ぶ列の上下（南ホールは左右）から探して、島をその列に入れる
# ・配置図は縮尺どおりではない（机が正方形で描かれている）。そこで
#     - 島や壁ぞいの列の「真ん中」だけを、配置図の壁の位置と会場データ（src/data/venue.json）のホールの壁の位置で写す
#       （西1・西2 は L 字なので、L の曲がり角で区切って、区切りごとにのばし方を変える）
#     - 島の中の机は、本物の机の大きさ（1.8m × 0.45m）でならべ直す
# ・配置図の壁の位置（pt）は、図に目盛りを重ねて読んだもの（下の ZONES）

import json, math, sys, collections
from datetime import datetime, timezone
from pathlib import Path
import fitz

ROOT = Path(__file__).resolve().parent.parent
DESK_L, DESK_D = 1.8, 0.45
venue = json.loads((ROOT / "src/data/venue.json").read_text(encoding="utf-8"))
HALLS = {h["id"]: h for h in venue["halls"]}

KATA = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨ"
HIRA = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよ"
WALL_BLOCKS = {"ア", "A", "a", "あ", "め"}
# ページ（0 から）→ 列の名前に使う文字、机の四角の一辺（pt）
PAGES = {2: (set(KATA), 7.7), 3: (set("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), 11.4), 4: (set(HIRA) | set("abcdefghijklmnopqrstuvwxyz"), 5.9)}
# 配置図の注記「〜にはサークル配置はありません」の机（四角だけ描かれているものは除く）
NO_CIRCLE = {("W2", "あ"): set(range(16, 22)) | {35} | set(range(62, 66)), ("W1", "め"): {20} | set(range(62, 66)), ("E3", "ア"): set(range(89, 93))}


def unit(a, b):
    dx, dz = b[0] - a[0], b[1] - a[1]
    n = math.hypot(dx, dz)
    return (dx / n, dz / n)


def rect_zone(hid, angle_deg, xs, ys):
    """ホールの四角い外形：配置図の右 → 会場の angle_deg の向き。外形の範囲を、配置図の xs・ys（pt）に合わせる"""
    poly = HALLS[hid]["poly"]
    r = (math.cos(math.radians(angle_deg)), math.sin(math.radians(angle_deg)))
    dn = (-r[1], r[0])
    us = [p[0] * r[0] + p[1] * r[1] for p in poly]
    vs = [p[0] * dn[0] + p[1] * dn[1] for p in poly]
    u0, v0 = min(us), min(vs)
    origin = (r[0] * u0 + dn[0] * v0, r[1] * u0 + dn[1] * v0)
    return {"hall": hid, "origin": origin, "r": r, "dn": dn, "xs": xs, "us": [0, max(us) - u0], "ys": ys, "vs": [0, max(vs) - v0]}


def corner_zone(hid, o, right_to, xs, us, ys, vs):
    """角 o から、配置図の右 → 角 right_to の向き。xs↔us、ys↔vs を区切りごとにのばす"""
    poly = HALLS[hid]["poly"]
    r = unit(poly[o], poly[right_to])
    return {"hall": hid, "origin": tuple(poly[o]), "r": r, "dn": (-r[1], r[0]), "xs": xs, "us": us, "ys": ys, "vs": vs}


# 配置図のホールの壁（pt）と会場データのホール。
# 東1〜3：配置図の右 → 会場の 147°（東1 の側、南西）、下 → ガレリアの側。南：配置図の上が南2（会場の南東）で、右 → 147°
ZONES = {
    2: [rect_zone("E3", 147, [31, 352], [76, 378]), rect_zone("E2", 147, [352, 665], [76, 378]), rect_zone("E1", 147, [665, 997], [76, 378])],
    3: [corner_zone("E7", 0, 9, [75, 800], [0, 125.9], [103, 827], [0, 119.8])],
    4: [
        rect_zone("S2", 147, [494, 742], [69, 300]),
        rect_zone("S1", 147, [494, 742], [300, 522]),
        corner_zone("W1", 2, 1, [140, 300, 409], [0, 39.8, 86.6], [691, 848, 1143], [0, 52.6, 145.5]),
        corner_zone("W2", 11, 6, [449, 560, 720], [0, 41.2, 87.3], [691, 848, 1143], [0, 52.2, 140.5]),
    ],
}
# 配置図の中のホールの外形（壁ぞいの机が、どちらの壁を向くかを決める）
OUTLINES = {
    "E1": [(665, 76), (997, 76), (997, 378), (665, 378)],
    "E2": [(352, 76), (665, 76), (665, 378), (352, 378)],
    "E3": [(31, 76), (352, 76), (352, 378), (31, 378)],
    "E7": [(75, 103), (800, 103), (800, 251), (793, 261), (447, 827), (75, 827)],
    "S2": [(494, 69), (742, 69), (742, 300), (494, 300)],
    "S1": [(494, 300), (742, 300), (742, 522), (494, 522)],
    "W1": [(140, 691), (409, 691), (409, 848), (300, 848), (300, 1143), (140, 1143)],
    "W2": [(449, 691), (720, 691), (720, 1143), (560, 1143), (560, 848), (449, 848)],
}


def interp(x, xs, us):
    for i in range(len(xs) - 1):
        if x <= xs[i + 1] or i == len(xs) - 2:
            t = (x - xs[i]) / (xs[i + 1] - xs[i])
            return us[i] + t * (us[i + 1] - us[i])


def to_venue(z, x, y):
    u, v = interp(x, z["xs"], z["us"]), interp(y, z["ys"], z["vs"])
    return (z["origin"][0] + z["r"][0] * u + z["dn"][0] * v, z["origin"][1] + z["r"][1] * u + z["dn"][1] * v)


def read_cells(doc):
    pages = {}
    for pi, (alpha, size) in PAGES.items():
        p = doc[pi]
        sq = [it[1] for dr in p.get_drawings() for it in dr["items"] if it[0] == "re" and abs(it[1].width - size) < 0.3 and abs(it[1].height - size) < 0.3]
        words = p.get_text("words")
        nums = [w for w in words if w[4].isdigit() and len(w[4]) == 2]
        cells = []
        for r in sq:
            cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
            hit = [w for w in nums if abs((w[0] + w[2]) / 2 - cx) < size / 2 and abs((w[1] + w[3]) / 2 - cy) < size / 2]
            if not hit:
                continue
            n = int(min(hit, key=lambda w: math.hypot((w[0] + w[2]) / 2 - cx, (w[1] + w[3]) / 2 - cy))[4])
            # 色をつけた机は四角が重なって2つある。同じ番号で同じ所なら1つに
            if not any(o["n"] == n and abs(o["x"] - cx) < size / 2 and abs(o["y"] - cy) < size / 2 for o in cells):
                cells.append({"x": cx, "y": cy, "n": n})
        labels = [{"x": (w[0] + w[2]) / 2, "y": (w[1] + w[3]) / 2, "t": w[4]} for w in words if len(w[4]) == 1 and w[4] in alpha and w[3] - w[1] < 14]
        pages[pi] = (size, cells, labels)
    return pages


def components(cells, size):
    left = set(range(len(cells)))
    out = []
    while left:
        st = [left.pop()]
        cur = []
        while st:
            k = st.pop()
            cur.append(cells[k])
            near = [j for j in left if abs(cells[j]["x"] - cells[k]["x"]) < size * 1.15 and abs(cells[j]["y"] - cells[k]["y"]) < size * 1.15]
            for j in near:
                left.discard(j)
                st.append(j)
        out.append(cur)
    return out


def groups(vals, size):
    vals = sorted(vals)
    g = [[vals[0]]]
    for a in vals[1:]:
        if a - g[-1][-1] > size * 0.5:
            g.append([a])
        else:
            g[-1].append(a)
    return [sum(x) / len(x) for x in g]


def hall_of(pi, block, num):
    if pi == 2:
        if block == "ア":
            return "E1" if num <= 39 else "E2" if num <= 56 else "E3"
        i = KATA.index(block)
        return "E1" if i <= KATA.index("ス") else "E2" if i <= KATA.index("ハ") else "E3"
    if pi == 3:
        return "E7"
    if block == "a":
        return "S2" if num <= 32 else "S1"
    if block in "bcdefghij":
        return "S2"
    if block in "klmnopqrst":
        return "S1"
    return "W1" if HIRA.index(block) >= HIRA.index("つ") else "W2"


def nearest_edge(hid, x, y, along=None):
    """配置図の外形のいちばん近い辺。along（配置図の向き）があれば、それと平行に近い辺だけから"""
    poly = OUTLINES[hid]
    best = None
    for i in range(len(poly)):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % len(poly)]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        if along is not None and abs(dx * along[1] - dy * along[0]) / L > 0.5:
            continue
        t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (L * L)))
        d = math.hypot(x - ax - t * dx, y - ay - t * dy)
        if best is None or d < best[0]:
            best = (d, (dx / L, dy / L), (ax + t * dx, ay + t * dy))
    return best


def point_in(p, poly):
    x, z = p
    c = False
    for i in range(len(poly)):
        x1, z1 = poly[i]
        x2, z2 = poly[i - 1]
        if (z1 > z) != (z2 > z) and x < (x2 - x1) * (z - z1) / (z2 - z1) + x1:
            c = not c
    return c


def inside_hall(hid, at, margin=1.2):
    """壁ぞいの机が会場データのホールの外に出たら（配置図と会場データで壁の形が少し違う所）、いちばん近い壁の内側へ寄せる"""
    poly = HALLS[hid]["poly"]
    if point_in(at, poly):
        return at
    best = None
    for i in range(len(poly)):
        (ax, az), (bx, bz) = poly[i], poly[(i + 1) % len(poly)]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz
        t = max(0, min(1, ((at[0] - ax) * dx + (at[1] - az) * dz) / L2))
        q = (ax + t * dx, az + t * dz)
        d = math.hypot(at[0] - q[0], at[1] - q[1])
        if best is None or d < best[0]:
            L = math.sqrt(L2)
            n = (-dz / L, dx / L)
            if not point_in((q[0] + n[0] * 0.1, q[1] + n[1] * 0.1), poly):
                n = (-n[0], -n[1])
            best = (d, (q[0] + n[0] * margin, q[1] + n[1] * margin))
    return best[1]


VIEW_D = 1.4  # 地図で描く机の奥行き（サークルの座る側へのばす。VenueView の TOP_DESK_D・VIEW_DESK_D と同じ）
WALL_GAP = 0.5  # 描いた机と壁のあいだ（壁ぎわの柱が入る）


def keep_in(hid, pt, margin):
    """pt をホールの壁から margin 以上内側にするための動き（dx, dz）。もう足りていれば (0, 0)"""
    poly = HALLS[hid]["poly"]
    inside = point_in(pt, poly)
    best = None
    for i in range(len(poly)):
        (ax, az), (bx, bz) = poly[i], poly[(i + 1) % len(poly)]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz
        if L2 < 1e-6:
            continue
        t = max(0, min(1, ((pt[0] - ax) * dx + (pt[1] - az) * dz) / L2))
        q = (ax + t * dx, az + t * dz)
        d = math.hypot(pt[0] - q[0], pt[1] - q[1])
        if best is None or d < best[0]:
            L = math.sqrt(L2)
            n = (-dz / L, dx / L)
            if not point_in((q[0] + n[0] * 0.05, q[1] + n[1] * 0.05), poly):
                n = (-n[0], -n[1])
            best = (d, q, n)
    d, q, n = best
    if inside and d >= margin:
        return (0.0, 0.0)
    return (q[0] + n[0] * margin - pt[0], q[1] + n[1] * margin - pt[1])


def drawn_corners(at, axis, side):
    """地図で描く机の四すみ（机の中心 at、長い辺の向き axis、サークルの座る向き side）"""
    out = (VIEW_D - DESK_D) / 2
    cx, cz = at[0] + side[0] * out, at[1] + side[1] * out
    return [(cx + axis[0] * a * DESK_L / 2 + side[0] * b * VIEW_D / 2, cz + axis[1] * a * DESK_L / 2 + side[1] * b * VIEW_D / 2) for a in (-1, 1) for b in (-1, 1)]


def push_run(hid, run):
    """机の並び（島・壁ぞいの列）を、描いた机がどれも壁から WALL_GAP 以上内側になるまで、並びごと動かす"""
    for _ in range(40):
        worst = (0.0, 0.0)
        for d in run:
            for c in drawn_corners(d["at"], d["axis"], d["side"]):
                m = keep_in(hid, c, WALL_GAP)
                if math.hypot(*m) > math.hypot(*worst):
                    worst = m
        if math.hypot(*worst) < 0.01:
            return
        for d in run:
            d["at"] = (d["at"][0] + worst[0] * 1.02, d["at"][1] + worst[1] * 1.02)


def separate(desks):
    """壁ぞいの机どうしが、描いた大きさで重なっていたら、長い辺の向きに離す（ばらばらに壁から離したときに起きる）"""
    walls = [d for d in desks if not d["island"]]
    for _ in range(20):
        moved = False
        for i, a in enumerate(walls):
            for b in walls[i + 1:]:
                if a["hall"] != b["hall"] or math.hypot(a["at"][0] - b["at"][0], a["at"][1] - b["at"][1]) > 3:
                    continue
                ax = a["axis"]
                if abs(ax[0] * b["axis"][0] + ax[1] * b["axis"][1]) < 0.9:
                    continue  # 向きの違う机（角）は、ここでは扱わない
                du = (b["at"][0] - a["at"][0]) * ax[0] + (b["at"][1] - a["at"][1]) * ax[1]
                dv = -(b["at"][0] - a["at"][0]) * ax[1] + (b["at"][1] - a["at"][1]) * ax[0]
                if abs(dv) > VIEW_D * 0.9:
                    continue
                need = DESK_L + 0.06 - abs(du)
                if need > 0:
                    sgn = 1 if du >= 0 else -1
                    for d, k in ((a, -0.5), (b, 0.5)):
                        d["at"] = (d["at"][0] + ax[0] * sgn * k * need, d["at"][1] + ax[1] * sgn * k * need)
                    moved = True
        if not moved:
            return


def on_outline(pt, poly, tol=1.0):
    for i in range(len(poly)):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % len(poly)]
        dx, dy = bx - ax, by - ay
        t = max(0, min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / (dx * dx + dy * dy)))
        if math.hypot(pt[0] - ax - t * dx, pt[1] - ay - t * dy) < tol:
            return True
    return False


def zone_at(pi, x, y, pad=12):
    """配置図の点 (x, y) を含む区切り（なければ None）"""
    for z in ZONES[pi]:
        if z["xs"][0] - pad <= x <= z["xs"][-1] + pad and z["ys"][0] - pad <= y <= z["ys"][-1] + pad:
            return z
    return None


def wall_point(hid, at, inset):
    """会場データのホールの壁のいちばん近い点から inset だけ内側"""
    poly = HALLS[hid]["poly"]
    best = None
    for i in range(len(poly)):
        (ax, az), (bx, bz) = poly[i], poly[(i + 1) % len(poly)]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz
        if L2 < 1e-6:
            continue
        t = max(0, min(1, ((at[0] - ax) * dx + (at[1] - az) * dz) / L2))
        q = (ax + t * dx, az + t * dz)
        d = math.hypot(at[0] - q[0], at[1] - q[1])
        if best is None or d < best[0]:
            L = math.sqrt(L2)
            n = (-dz / L, dx / L)
            if not point_in((q[0] + n[0] * 0.05, q[1] + n[1] * 0.05), poly):
                n = (-n[0], -n[1])
            best = (d, (q[0] + n[0] * inset, q[1] + n[1] * inset))
    return best[1]


def venue_edge_dir(hid, q):
    """会場データのホールの、点 q がのっている（いちばん近い）辺の向き"""
    poly = HALLS[hid]["poly"]
    best = None
    for i in range(len(poly)):
        (ax, az), (bx, bz) = poly[i], poly[(i + 1) % len(poly)]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz
        if L2 < 1e-6:
            continue
        t = max(0, min(1, ((q[0] - ax) * dx + (q[1] - az) * dz) / L2))
        d = math.hypot(q[0] - ax - t * dx, q[1] - az - t * dz)
        if best is None or d < best[0]:
            L = math.sqrt(L2)
            best = (d, (dx / L, dz / L))
    return best[1]


def path_points(dr):
    """描画の形の点（線・曲線の端・四角の四すみ）"""
    pts = []
    for it in dr["items"]:
        if it[0] == "l":
            pts += [(it[1].x, it[1].y), (it[2].x, it[2].y)]
        elif it[0] == "c":
            pts += [(it[1].x, it[1].y), (it[4].x, it[4].y)]
        elif it[0] == "re":
            r = it[1]
            pts += [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)]
        elif it[0] == "qu":
            q = it[1]
            pts += [(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.lr.x, q.lr.y), (q.ll.x, q.ll.y)]
    return pts


def read_features(doc, desks):
    """柱（小さな黒い四角）と、壁の切れ目（ホールの外形にそって、黒い壁が描かれていない所＝出入口・シャッター）"""
    pillars, openings = [], []
    for pi in ZONES:
        p = doc[pi]
        dark = [dr["rect"] for dr in p.get_drawings() if dr.get("fill") and max(dr["fill"]) < 0.3]
        is_pillar = lambda r: abs(r.width - r.height) < 0.6 and 2.5 <= r.width <= 8.5
        for r in dark:
            if not is_pillar(r):
                continue
            x, y = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
            z = zone_at(pi, x, y, pad=6)
            if not z:
                continue
            hid = z["hall"]
            e = nearest_edge(hid, x, y)
            wall_pillar = bool(e and e[0] < max(10, PAGES[pi][1] * 1.8))
            if wall_pillar:
                # 壁ぎわの柱：会場データの壁の線の上（半分が壁に入る）
                at = wall_point(hid, to_venue(z, x, y), 0.0)
            else:
                # 島の中などの柱：配置図でいちばん近い机の四角から見た位置を、その机の会場での位置にあてはめる
                near = [d for d in desks if d["pdf"][0] == pi and abs(d["pdf"][1] - x) < d["pdf"][3] * 1.2 and abs(d["pdf"][2] - y) < d["pdf"][3] * 1.2]
                if near:
                    d = min(near, key=lambda d: math.hypot(d["pdf"][1] - x, d["pdf"][2] - y))
                    _, cx, cy, sz, pal, _ = d["pdf"]
                    da = ((x - cx) * pal[0] + (y - cy) * pal[1]) / sz  # 机の長い辺の向き（配置図）
                    dc = ((x - cx) * -pal[1] + (y - cy) * pal[0]) / sz  # それと直角
                    ax_, ac_ = d["axis"], (-d["axis"][1], d["axis"][0])
                    # 配置図の「直角の向き」が会場でどちら向きかは、区切りの向きで決める
                    vx, vz = z["r"][0] * -pal[1] + z["dn"][0] * pal[0], z["r"][1] * -pal[1] + z["dn"][1] * pal[0]
                    if vx * ac_[0] + vz * ac_[1] < 0:
                        ac_ = (-ac_[0], -ac_[1])
                    at = (d["at"][0] + ax_[0] * da * DESK_L + ac_[0] * dc * DESK_D, d["at"][1] + ax_[1] * da * DESK_L + ac_[1] * dc * DESK_D)
                    hid = d["hall"]
                else:
                    at = to_venue(z, x, y)
                if not point_in(at, HALLS[hid]["poly"]):
                    at = wall_point(hid, at, 0.0)
                    wall_pillar = True
            pillars.append({"hall": hid, "at": [round(at[0], 2), round(at[1], 2)], "wall": wall_pillar})
        # 壁の切れ目：配置図の黒い壁（細長い塗り）を、同じ線の上にあるものどうしでまとめ、となり合う壁のあいだのすき間を出入口とする。
        # 壁が描かれていない辺（トラックヤード側など）や、壁の曲がり角・段差は、切れ目にしない
        segs = []
        for dr in p.get_drawings():
            if not (dr.get("fill") and max(dr["fill"]) < 0.3):
                continue
            pts = path_points(dr)
            if len(pts) < 3:
                continue
            cx = sum(q[0] for q in pts) / len(pts); cy = sum(q[1] for q in pts) / len(pts)
            sxx = sum((q[0] - cx) ** 2 for q in pts); syy = sum((q[1] - cy) ** 2 for q in pts); sxy = sum((q[0] - cx) * (q[1] - cy) for q in pts)
            ang = 0.5 * math.atan2(2 * sxy, sxx - syy)
            ux, uy = math.cos(ang), math.sin(ang)
            us = [(q[0] - cx) * ux + (q[1] - cy) * uy for q in pts]
            vs = [-(q[0] - cx) * uy + (q[1] - cy) * ux for q in pts]
            length, thick = max(us) - min(us), max(vs) - min(vs)
            if thick > 9 or length < max(3 * thick, 5):
                continue  # 柱・大きな塊・小さな印
            if not zone_at(pi, cx, cy, pad=15):
                continue
            if ux < 0 or (abs(ux) < 1e-6 and uy < 0):
                ux, uy = -ux, -uy
            off = -cx * uy + cy * ux  # 線の位置（向きに直角）
            t0 = min((q[0] * ux + q[1] * uy) for q in pts); t1 = max((q[0] * ux + q[1] * uy) for q in pts)
            segs.append({"ux": ux, "uy": uy, "off": off, "t0": t0, "t1": t1, "thick": thick})
        groups = []
        for sg in segs:
            g = next((g for g in groups if abs(g[0]["ux"] * sg["uy"] - g[0]["uy"] * sg["ux"]) < 0.05 and abs(g[0]["off"] - sg["off"]) < 3), None)
            if g:
                g.append(sg)
            else:
                groups.append([sg])
        for g in groups:
            g.sort(key=lambda x: x["t0"])
            ux, uy, off = g[0]["ux"], g[0]["uy"], sum(x["off"] for x in g) / len(g)
            end_t = g[0]["t1"]
            for sg in g[1:]:
                gap = sg["t0"] - end_t
                ta, tb = end_t, sg["t0"]
                tm = (ta + tb) / 2
                # 壁の段差（切れ目のすぐ内か外に、平行な壁がその切れ目をふさいでいる）は出入口ではない
                jog = any(abs(o["ux"] * uy - o["uy"] * ux) < 0.05 and 2 < abs(o["off"] - off) < 30 and o["t0"] - 2 <= tm <= o["t1"] + 2 for o in segs)
                if 4 <= gap <= 120 and not jog:
                    pa_ = (ux * ta - uy * off, uy * ta + ux * off)
                    pb_ = (ux * tb - uy * off, uy * tb + ux * off)
                    mx, my = (pa_[0] + pb_[0]) / 2, (pa_[1] + pb_[1]) / 2
                    z = zone_at(pi, mx, my, pad=15)
                    e = None
                    if z:
                        # どのホールの壁か：配置図の外形のいちばん近い辺（15pt 以内）
                        best = None
                        for hid in {zz["hall"] for zz in ZONES[pi]}:
                            ee = nearest_edge(hid, mx, my)
                            if ee and (best is None or ee[0] < best[0][0]):
                                best = (ee, hid)
                        if best and best[0][0] < 15:
                            hid = best[1]
                            z = next((zz for zz in ZONES[pi] if zz["hall"] == hid), z)
                            va, vb = to_venue(z, *pa_), to_venue(z, *pb_)
                            openings.append({"hall": hid, "a": [round(va[0], 2), round(va[1], 2)], "b": [round(vb[0], 2), round(vb[1], 2)],
                                             "pdf": [pi, round(pa_[0], 1), round(pa_[1], 1), round(pb_[0], 1), round(pb_[1], 1)]})
                end_t = max(end_t, sg["t1"])
    # 建物の固い部分と部屋の壁：配置図の黒い塗りのうち、柱（小さな四角）でも、ホールの外壁（外形の線の上）でもないもの。
    # 大きな塊（自販機・ロッカーの棟、角の小部屋など）と、トイレ・給湯室などの囲みの壁。地図では低い箱にする
    structures = []
    for pi in ZONES:
        p = doc[pi]
        hids = {z["hall"] for z in ZONES[pi]}
        for dr in p.get_drawings():
            if not (dr.get("fill") and max(dr["fill"]) < 0.3) or any(it[0] == "c" for it in dr["items"]):
                continue  # 丸い印（? の案内など）は除く
            r = dr["rect"]
            if abs(r.width - r.height) < 0.6 and r.width <= 8.5:
                continue  # 柱
            if r.width < 1 or r.height < 1:
                continue
            pts = path_points(dr)
            if len(pts) < 3:
                continue
            # 細長い壁（部屋の囲み）か、大きな塊か
            cx0 = sum(q[0] for q in pts) / len(pts); cy0 = sum(q[1] for q in pts) / len(pts)
            sxx = sum((q[0] - cx0) ** 2 for q in pts); syy = sum((q[1] - cy0) ** 2 for q in pts); sxy = sum((q[0] - cx0) * (q[1] - cy0) for q in pts)
            ang = 0.5 * math.atan2(2 * sxy, sxx - syy)
            us = [(q[0] - cx0) * math.cos(ang) + (q[1] - cy0) * math.sin(ang) for q in pts]
            vs = [-(q[0] - cx0) * math.sin(ang) + (q[1] - cy0) * math.cos(ang) for q in pts]
            length, thick = max(us) - min(us), max(vs) - min(vs)
            near_out = min(min(nearest_edge(h, x, y)[0] for h in hids) for x, y in pts)
            if thick <= 9:
                # 細い壁：外壁（外形の線から 12pt 以内）と、長い線（ホールの境目など、120pt より長い）は除く
                far = min(min(nearest_edge(h, x, y)[0] for h in hids) for x, y in [(cx0, cy0)])
                if far < 12 or length > 120:
                    continue
            elif all(min(nearest_edge(h, x, y)[0] for h in hids) < 6 for x, y in pts):
                continue  # 外壁そのもの
            cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
            z = zone_at(pi, cx, cy, pad=20)
            if not z:
                continue
            # 塗りの形の外まわり（四角ならその四すみ、ほかは点の並び）
            poly = [to_venue(z, x, y) for x, y in pts]
            dedup = []
            for q in poly:
                if not dedup or math.hypot(q[0] - dedup[-1][0], q[1] - dedup[-1][1]) > 0.05:
                    dedup.append(q)
            mxv = sum(q[0] for q in dedup) / len(dedup); mzv = sum(q[1] for q in dedup) / len(dedup)
            # ホールの床に少しでもかかるものだけ（ホールとガレリアのあいだの部屋の帯は、会場データにないので出さない）
            near_hall = any(point_in(q, HALLS[z["hall"]]["poly"]) for q in dedup)
            if len(dedup) >= 3 and near_hall:  # ホールから離れた所（アトリウムの案内のアイコンなど）は除く
                structures.append({"hall": z["hall"], "poly": [[round(x, 2), round(y, 2)] for x, y in dedup]})
    return {"pillars": pillars, "openings": openings, "structures": structures}


def main():
    pdf = Path(sys.argv[1])
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "data/private/layout-c108.json"
    doc = fitz.open(pdf)
    pages = read_cells(doc)
    # 列（ホール, 列の名前）ごとの机：{n, at（会場）, axis（机の長い辺の向き、会場）, side_dir（サークルが座る向き、会場）, island}
    blocks = collections.defaultdict(list)
    cells_done = []  # 置いた机（柱の位置を、近くの机からの位置で決めるのに使う）
    for pi, (size, cells, labels) in pages.items():
        zones = ZONES[pi]
        island_labels = [l for l in labels if l["t"] not in WALL_BLOCKS]
        for cs in components(cells, size):
            xs, ys = groups([c["x"] for c in cs], size), groups([c["y"] for c in cs], size)
            mx, my = sum(c["x"] for c in cs) / len(cs), sum(c["y"] for c in cs) / len(cs)
            island = min(len(xs), len(ys)) == 2 and max(len(xs), len(ys)) >= 4 and len(cs) == len(xs) * len(ys)
            if island:
                vertical = len(ys) > len(xs)
                key = (lambda l: (abs(l["x"] - mx) < size * 1.2, -abs(l["y"] - my))) if vertical else (lambda l: (abs(l["y"] - my) < size * 1.2, -abs(l["x"] - mx)))
                lab = max(island_labels, key=key)
                assert key(lab)[0], f"列の名前が見つからない島 {pi} {mx:.0f},{my:.0f}"
                block = lab["t"]
            else:
                block = "ア" if pi == 2 else "A" if pi == 3 else "a" if my < 560 else "め" if mx < 445 else "あ"
            hid = hall_of(pi, block, cs[0]["n"])
            zone = next(z for z in zones if z["hall"] == hid and z["xs"][0] - 15 <= mx <= z["xs"][-1] + 15 and z["ys"][0] - 15 <= my <= z["ys"][-1] + 15)

            def vdir(dx, dy):  # 配置図の向き → 会場の向き（区切りののばし方は向きに効かない）
                x, z = zone["r"][0] * dx + zone["dn"][0] * dy, zone["r"][1] * dx + zone["dn"][1] * dy
                n = math.hypot(x, z)
                return (x / n, z / n)

            run = []  # この並びの机。あとで並びごと壁から離す

            def place(c, at, axis, side_dir, across=None, pdf_along=None):
                h = hall_of(pi, block, c["n"])
                d = {"n": c["n"], "at": at, "axis": axis, "side": side_dir, "island": island, "hall": h,
                     "pdf": (pi, c["x"], c["y"], size, pdf_along or (0, 1), across or (-axis[1], axis[0]))}
                run.append(d)
                if c["n"] not in NO_CIRCLE.get((h, block), ()):
                    blocks[(h, block)].append(d)

            # まっすぐな壁ぞいの列：机の真ん中が1本の線にのる（斜めの壁ぞいに少しずつずれて並ぶ机は、1つずつ置く）
            straight = len(cs) >= 2 and (max(c["x"] for c in cs) - min(c["x"] for c in cs) < size * 0.4 or max(c["y"] for c in cs) - min(c["y"] for c in cs) < size * 0.4)
            if island or straight:
                # 島・まっすぐな壁ぞいの列：真ん中だけ写して、机は本物の大きさでならべる
                vertical = len(ys) > len(xs)
                along = (0, 1) if vertical else (1, 0)
                axis = vdir(*along)
                across = vdir(*((1, 0) if vertical else (0, 1)))
                cx, cz = to_venue(zone, mx, my)
                center_along = my if vertical else mx
                center_across = mx if vertical else my
                if not island:
                    e = nearest_edge(hid, mx, my, along)
                    to_wall = (e[2][0] - mx, e[2][1] - my) if e else (0, 0)
                    wall_side = vdir(*to_wall) if math.hypot(*to_wall) > 0.01 else across
                for c in cs:
                    a = ((c["y"] if vertical else c["x"]) - center_along) / size * DESK_L
                    if island:
                        k = 1 if (c["x"] if vertical else c["y"]) > center_across else -1
                        b = k * DESK_D / 2
                        side_dir = (across[0] * k, across[1] * k)  # 島の外側に座る
                    else:
                        b = 0
                        side_dir = wall_side  # 壁の側に座る
                    at = (cx + axis[0] * a + across[0] * b, cz + axis[1] * a + across[1] * b)
                    place(c, at, axis, side_dir, across, along)
                push_run(hid, run)
            else:
                # 1つだけの机・斜めの壁ぞいの机：机ごとに写して、いちばん近い壁にそろえる
                for c in cs:
                    e = nearest_edge(hid, c["x"], c["y"])
                    at = to_venue(zone, c["x"], c["y"])
                    # 向きは会場データのいちばん近い壁にそろえる（配置図と会場データで、斜めの壁の角度が少し違う）
                    q = wall_point(hid, at, 0.0)
                    axis = venue_edge_dir(hid, q)
                    to_wall = (q[0] - at[0], q[1] - at[1])
                    n = math.hypot(*to_wall)
                    side_dir = (to_wall[0] / n, to_wall[1] / n) if n > 0.01 else (-axis[1], axis[0])
                    if abs(side_dir[0] * axis[0] + side_dir[1] * axis[1]) > 0.5:
                        side_dir = (-axis[1], axis[0]) if (-axis[1]) * to_wall[0] + axis[0] * to_wall[1] >= 0 else (axis[1], -axis[0])
                    run = []
                    pdf_along = e[1]
                    place(c, at, axis, side_dir, (-axis[1], axis[0]), pdf_along)
                    push_run(hid, run)
                    cells_done.extend(run)
                continue
            cells_done.extend(run)

    # 離したことで壁に近づいた机を、もう一度壁から離す（2回まわす）
    for _ in range(2):
        separate(cells_done)
        for d in cells_done:
            if not d["island"]:
                push_run(d["hall"], [d])

    # 列ごとに、列の向き・始点・机の位置（u, v）にする
    lines = []
    order = {"東": KATA + "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "西": HIRA, "南": "abcdefghijklmnopqrstuvwxyz"}
    for (hid, block), ds in sorted(blocks.items(), key=lambda kv: (kv[0][0], order[HALLS[kv[0][0]]["building"]].index(kv[0][1]))):
        wall = block in WALL_BLOCKS
        if wall:
            # 壁ぞいの列：列の向きはホールの向き、始点はいちばん番号の小さい机
            ax = ds[0]["axis"]
            first = min(ds, key=lambda d: d["n"])["at"]
            ang = math.atan2(ax[1], ax[0])
            start = first
        else:
            ax = ds[0]["axis"]
            ang = math.atan2(ax[1], ax[0])
            c, s = math.cos(ang), math.sin(ang)
            us = [d["at"][0] * c + d["at"][1] * s for d in ds]
            vs = [-d["at"][0] * s + d["at"][1] * c for d in ds]
            u0, vm = min(us) - DESK_L / 2, sum(vs) / len(vs)
            start = (u0 * c - vm * s, u0 * s + vm * c)
        c, s = math.cos(ang), math.sin(ang)
        desks = []
        for d in sorted(ds, key=lambda d: d["n"]):
            dx, dz = d["at"][0] - start[0], d["at"][1] - start[1]
            u, v = dx * c + dz * s, -dx * s + dz * c
            turn = math.atan2(d["axis"][1], d["axis"][0]) - ang
            turn = math.atan2(math.sin(turn), math.cos(turn))
            # サークルが座る側：机の長い辺の向きの左手（-sin, cos）なら 1
            ta = ang + turn
            left = (-math.sin(ta), math.cos(ta))
            side = 1 if d["side"][0] * left[0] + d["side"][1] * left[1] >= 0 else -1
            desk = {"n": d["n"], "u": round(u, 2), "v": round(v, 2), "side": side}
            if abs(turn) > 1e-3:
                desk["turn"] = round(turn, 4)
            desks.append(desk)
        line = {"hall": hid, "block": block, "start": [round(start[0], 2), round(start[1], 2)], "angle": round(ang, 4), "segments": [], "desks": desks}
        if wall:
            line["wall"] = True
        lines.append(line)

    features = read_features(doc, cells_done)
    out = {"format": "comiket3d-layout", "version": 1, "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": pdf.name, "note": "コミックマーケット108 の配置図から写した机の配置（参考）。位置は配置図からの目安で、数m ずれることがある", "lines": lines, "features": features}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    per = collections.Counter()
    for l in lines:
        per[l["hall"]] += len(l["desks"])
    print(f"柱 {len(features['pillars'])}・壁の切れ目 {len(features['openings'])}・塊と囲み {len(features['structures'])}")
    print(f"列 {len(lines)}・机 {sum(per.values())}（スペース {2 * sum(per.values())}）", dict(sorted(per.items())), "→", out_path)


main()
