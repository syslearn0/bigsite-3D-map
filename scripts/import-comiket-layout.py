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


def main():
    pdf = Path(sys.argv[1])
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "data/private/layout-c108.json"
    doc = fitz.open(pdf)
    pages = read_cells(doc)
    # 列（ホール, 列の名前）ごとの机：{n, at（会場）, axis（机の長い辺の向き、会場）, side_dir（サークルが座る向き、会場）, island}
    blocks = collections.defaultdict(list)
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

            def place(c, at, axis, side_dir):
                h = hall_of(pi, block, c["n"])
                if c["n"] in NO_CIRCLE.get((h, block), ()):
                    return
                if not island:
                    # 机の両端のどちらかが外に出ていたら、その端を内側へ寄せたぶん机ごと動かす
                    for k in (0, 0.5, -0.5):
                        end = (at[0] + axis[0] * DESK_L * k, at[1] + axis[1] * DESK_L * k)
                        moved = inside_hall(h, end)
                        at = (at[0] + moved[0] - end[0], at[1] + moved[1] - end[1])
                blocks[(h, block)].append({"n": c["n"], "at": at, "axis": axis, "side": side_dir, "island": island})

            if island or (min(len(xs), len(ys)) == 1 and len(cs) >= 2):
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
                    place(c, at, axis, side_dir)
            else:
                # 1つだけの机・斜めの壁ぞいの机：机ごとに写して、いちばん近い壁にそろえる
                for c in cs:
                    e = nearest_edge(hid, c["x"], c["y"])
                    axis = vdir(*e[1])
                    to_wall = (e[2][0] - c["x"], e[2][1] - c["y"])
                    side_dir = vdir(*to_wall) if math.hypot(*to_wall) > 0.01 else (-axis[1], axis[0])
                    place(c, to_venue(zone, c["x"], c["y"]), axis, side_dir)

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

    out = {"format": "comiket3d-layout", "version": 1, "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "source": pdf.name, "note": "コミックマーケット108 の配置図から写した机の配置（参考）。位置は配置図からの目安で、数m ずれることがある", "lines": lines}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    per = collections.Counter()
    for l in lines:
        per[l["hall"]] += len(l["desks"])
    print(f"列 {len(lines)}・机 {sum(per.values())}（スペース {2 * sum(per.values())}）", dict(sorted(per.items())), "→", out_path)


main()
