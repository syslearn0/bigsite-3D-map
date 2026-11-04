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
        walls_ = [r for r in dark if not is_pillar(r)]
        hids = {z["hall"] for z in ZONES[pi]}
        for hid in hids:
            poly = OUTLINES[hid]
            for i in range(len(poly)):
                a, b = poly[i], poly[(i + 1) % len(poly)]
                # ほかのホールと分け合う辺（東1〜3・南1/2 の境）は、壁がなくてよいので数えない
                mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                shared = any(o != hid and on_outline(mid, OUTLINES[o]) for o in hids)
                if shared:
                    continue
                L = math.hypot(b[0] - a[0], b[1] - a[1])
                ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
                nx, ny = -uy, ux
                cov = []
                for k in range(int(L) + 1):
                    px, py = a[0] + ux * k, a[1] + uy * k
                    hit = any(r.x0 - 0.5 <= px + nx * t <= r.x1 + 0.5 and r.y0 - 0.5 <= py + ny * t <= r.y1 + 0.5 for t in range(-10, 11, 2) for r in walls_)
                    cov.append(hit)
                # 壁のない区間（角の近くの 4pt は数えない）。6pt（2m ほど）より短いものは描き方のすき間
                k = 4
                while k < len(cov) - 4:
                    if cov[k]:
                        k += 1
                        continue
                    j = k
                    while j < len(cov) - 4 and not cov[j]:
                        j += 1
                    if j - k >= 6:
                        z = zone_at(pi, a[0] + ux * (k + j) / 2, a[1] + uy * (k + j) / 2)
                        if z:
                            pa = to_venue(z, a[0] + ux * k, a[1] + uy * k)
                            pb = to_venue(z, a[0] + ux * j, a[1] + uy * j)
                            openings.append({"hall": hid, "a": [round(pa[0], 2), round(pa[1], 2)], "b": [round(pb[0], 2), round(pb[1], 2)]})
                    k = j
    return {"pillars": pillars, "openings": openings}


# ---- 会場案内図（PDF の2ページ目）：通行不可の場所・サークル入口 ----
# 案内図は略図で、全体を1つの式で写すと 10〜27m ずれる。そこで、ホールの角・駅などの対応点を集め、
# 写したい点の近くの対応点ほど重く見て、その点ごとに式を決める（近いほど対応点どおりに合う）
GUIDE = 1
GUIDE_MAIN_X = 940  # これより右は「2階」「4階」「会議棟1階」の小さな図と凡例
BLUE, GREY = (0.43, 0.81, 0.97), (0.82, 0.83, 0.83)
# 案内図のホールの形（水色の塗り）→ 会場データのホール。頂点は、いったん全体の式で写して、いちばん近いホールの角と組にする
GUIDE_HALLS = {"E7": (64, 365, 183, 481), "W1": (577, 192, 664, 322), "W2": (663, 192, 742, 321), "S": (676, 61, 748, 171)}
# 手で読んだ対応点（案内図の pt → 会場の m）
GUIDE_POINTS = [
    ((229.3, 285.3), (478.5, -173.2)), ((462.9, 285.3), (251.3, -23.9)), ((462.9, 354.9), (201.7, -99.0)), ((229.3, 351.4), (428.9, -248.3)),  # 東1〜3 の四すみ
    ((754, 533), (-255.7, -46.6)),  # ゆりかもめ 東京ビッグサイト駅
    ((556, 803), (-221.3, -516.3)),  # りんかい線 国際展示場駅
]


def near(c, rgb):
    return c is not None and all(abs(a - b) < 0.02 for a, b in zip(c, rgb))


def path_points(dr):
    pts = []
    for it in dr["items"]:
        if it[0] == "l":
            for q in (it[1], it[2]):
                if not pts or (abs(pts[-1][0] - q.x) > 0.01 or abs(pts[-1][1] - q.y) > 0.01):
                    pts.append((q.x, q.y))
        elif it[0] == "c":
            for q in (it[1], it[4]):
                if not pts or (abs(pts[-1][0] - q.x) > 0.01 or abs(pts[-1][1] - q.y) > 0.01):
                    pts.append((q.x, q.y))
        elif it[0] == "re":
            r = it[1]
            pts += [(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1)]
    return pts


def fit_affine(src, dst, w=None):
    """重みつきの最小二乗で、src → dst の一次変換（x' = a x + b y + c）"""
    n = len(src)
    w = w or [1.0] * n
    # 正規方程式（3×3）を2つ
    ata = [[0.0] * 3 for _ in range(3)]
    atb = [[0.0, 0.0] for _ in range(3)]
    for (x, y), (u, v), k in zip(src, dst, w):
        row = (x, y, 1.0)
        for i in range(3):
            for j in range(3):
                ata[i][j] += k * row[i] * row[j]
            atb[i][0] += k * row[i] * u
            atb[i][1] += k * row[i] * v

    def solve(m, b):
        m = [r[:] + [bb] for r, bb in zip(m, b)]
        for i in range(3):
            piv = max(range(i, 3), key=lambda r: abs(m[r][i]))
            m[i], m[piv] = m[piv], m[i]
            for r in range(3):
                if r != i:
                    f = m[r][i] / m[i][i]
                    m[r] = [a - f * c for a, c in zip(m[r], m[i])]
        return [m[i][3] / m[i][i] for i in range(3)]

    cu = solve(ata, [b[0] for b in atb])
    cv = solve(ata, [b[1] for b in atb])
    return lambda x, y: (cu[0] * x + cu[1] * y + cu[2], cv[0] * x + cv[1] * y + cv[2])


def read_guide(doc):
    p = doc[GUIDE]
    drs = p.get_drawings()
    # 対応点：手で読んだものに、案内図のホールの形の頂点と会場データのホールの角の組を足す
    src = [a for a, _ in GUIDE_POINTS]
    dst = [b for _, b in GUIDE_POINTS]
    rough = fit_affine(src, dst)
    for key, box in GUIDE_HALLS.items():
        dr = next(d for d in drs if near(d.get("fill"), BLUE) and all(abs(a - b) < 1.5 for a, b in zip(d["rect"], box)))
        ids = ["S1", "S2"] if key == "S" else [key]
        corners = [tuple(q) for i in ids for q in HALLS[i]["poly"]]
        # 頂点が多い形は、外の四すみ（いちばん外側の点）だけ使う
        pts = path_points(dr)
        xs, ys = [q[0] for q in pts], [q[1] for q in pts]
        for q in [(min(xs), min(ys)), (max(xs), min(ys)), (max(xs), max(ys)), (min(xs), max(ys))]:
            gq = min(pts, key=lambda t: math.hypot(t[0] - q[0], t[1] - q[1]))
            rx, rz = rough(*gq)
            c = min(corners, key=lambda t: math.hypot(t[0] - rx, t[1] - rz))
            if math.hypot(c[0] - rx, c[1] - rz) < 45:
                src.append(gq)
                dst.append(c)
    rough = fit_affine(src, dst)

    def to_v(x, y):
        w = [1 / (math.hypot(x - a, y - b) ** 2 + 400) for a, b in src]  # 20pt より近い所は同じくらいの重み
        f = fit_affine(src, dst, w)
        u, v = f(x, y)
        return [round(u, 1), round(v, 1)]

    areas, routes, marks = [], [], []
    for d in drs:
        r = d["rect"]
        if r.x0 > GUIDE_MAIN_X:
            continue
        if near(d.get("fill"), GREY):
            pts = path_points(d)
            # 大きな灰色（東7・8 の外と、国際展示場駅寄り）は一般参加者の待機列、ほかは通行不可
            kind = "wait" if r.width * r.height > 20000 or (r.height > 3 * r.width and r.height > 150) else "closed"
            areas.append({"kind": kind, "name": "一般参加者待機列" if kind == "wait" else "通行不可", "level": 1, "poly": [to_v(*q) for q in pts]})
        elif d["type"] == "s" and (near(d.get("color"), BLUE) and (d.get("width") or 0) >= 1.5):
            routes.append({"kind": "recommended", "pts": [to_v(*q) for q in path_points(d)]})
        elif d["type"] == "s" and d.get("dashes", "").startswith("[ 0 3") and (d.get("width") or 0) >= 1.9:
            routes.append({"kind": "circle", "pts": [to_v(*q) for q in path_points(d)]})
    words = p.get_text("words")
    for i, w in enumerate(words):
        cx, cy = (w[0] + w[2]) / 2, (w[1] + w[3]) / 2
        if cx > GUIDE_MAIN_X:
            continue
        if w[4] == "サークル入口" and i + 1 < len(words):
            code = words[i + 1][4]
            level = 2 if code == "CE" else 1  # CE はエントランスホール（2F）
            marks.append({"kind": "circle-entrance", "name": f"サークル入口{code}", "level": level, "at": to_v(cx, cy)})
    # 待ち合わせの大玉（凡例の「赤・灰・青」より上の、地図の中の字）
    for color, level, where in (("赤", 2, "東地区2F"), ("灰", 2, "エントランスホール"), ("青", 1, "西アトリウム")):
        w = next((w for w in words if w[4] == color and w[1] < 700 and w[0] < GUIDE_MAIN_X), None)
        if w:
            marks.append({"kind": "meeting", "name": f"大玉（{color}・{where}）", "level": level, "at": to_v((w[0] + w[2]) / 2, (w[1] + w[3]) / 2)})
    err = max(math.hypot(*(a - b for a, b in zip(to_v(*s_), d_))) for s_, d_ in zip(src, dst))
    print(f"案内図：対応点 {len(src)}（いちばんのずれ {err:.1f}m）・待機列と通行不可 {len(areas)}・経路 {len(routes)}・入口と大玉 {len(marks)}")
    # 地図に出すのは、通行不可の場所とサークル入口だけ（待機列・入場経路・待ち合わせの大玉は、略図からでは分かりにくいので入れない）
    return {"areas": [x for x in areas if x["kind"] == "closed"], "routes": [], "marks": [m for m in marks if m["kind"] == "circle-entrance"]}


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
    features.update(read_guide(doc))
    out = {"format": "comiket3d-layout", "version": 1, "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": pdf.name, "note": "コミックマーケット108 の配置図から写した机の配置（参考）。位置は配置図からの目安で、数m ずれることがある", "lines": lines, "features": features}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    per = collections.Counter()
    for l in lines:
        per[l["hall"]] += len(l["desks"])
    print(f"柱 {len(features['pillars'])}・壁の切れ目 {len(features['openings'])}")
    print(f"列 {len(lines)}・机 {sum(per.values())}（スペース {2 * sum(per.values())}）", dict(sorted(per.items())), "→", out_path)


main()
