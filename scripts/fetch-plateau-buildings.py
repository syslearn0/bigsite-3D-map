# 「周辺も表示」の建物の形と高さ：国土交通省 Project PLATEAU の 3D 都市モデル（東京都23区、CityGML 2020年度）の建築物を、
# indigo-lab が Mapbox Vector Tile にしたもの（https://github.com/indigo-lab/plateau-tokyo23ku-building-mvt-2020）から取る。
# 形は屋根の外形（LOD0）、高さは計測高さ（measuredHeight）。範囲は fetch-osm-surroundings.ts と同じ。
# タイルの境目で切れた建物は、建物 ID ごとにつなぎ直す。data/plateau/buildings.json に [{id, h, poly: [[lat, lon], ...]}] で保存する。
# 使い方：python scripts/fetch-plateau-buildings.py → npm run build:venue
# 出典：3D都市モデル（Project PLATEAU）東京都23区（国土交通省）CC BY 4.0 を加工して作成
import json
import math
import os
import urllib.request

import mapbox_vector_tile
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union

S, W, N, E = 35.6225, 139.7835, 35.6375, 139.8045
Z = 16
URL = 'https://indigo-lab.github.io/plateau-tokyo23ku-building-mvt-2020/{z}/{x}/{y}.pbf'


def tile_of(lat, lon):
    n = 2 ** Z
    return int((lon + 180) / 360 * n), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)


def lonlat(x, y, tx, ty, extent):
    # タイルの中の座標（y は下から上：mapbox_vector_tile の既定）→ 経度・緯度
    n = 2 ** Z
    gx = tx + x / extent
    gy = ty + 1 - y / extent
    lon = gx / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * gy / n))))
    return lon, lat


x0, y0 = tile_of(N, W)
x1, y1 = tile_of(S, E)
pieces = {}
heights = {}
for tx in range(x0, x1 + 1):
    for ty in range(y0, y1 + 1):
        req = urllib.request.Request(URL.format(z=Z, x=tx, y=ty), headers={'User-Agent': 'comiket-3d-prototype'})
        try:
            data = urllib.request.urlopen(req, timeout=60).read()
        except Exception as e:  # 建物のないタイル（海など）は 404
            print('なし', tx, ty, e)
            continue
        layer = mapbox_vector_tile.decode(data).get('bldg')
        if not layer:
            continue
        ext = layer['extent']
        for f in layer['features']:
            p = f['properties']
            bid = next((v for k, v in p.items() if k.endswith('ID') and isinstance(v, str)), None)
            h = p.get('measuredHeight')
            if not bid or not h or h <= 0:
                continue
            g = f['geometry']
            polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates'] if g['type'] == 'MultiPolygon' else []
            for rings in polys:
                outer = [lonlat(x, y, tx, ty, ext) for x, y in rings[0]]
                holes = [[lonlat(x, y, tx, ty, ext) for x, y in r] for r in rings[1:]]
                pg = Polygon(outer, holes).buffer(0)
                if pg.is_empty:
                    continue
                # タイルのふち（少しはみ出して描かれる所）で切る
                lo0, la1 = lonlat(0, ext, tx, ty, ext)
                lo1, la0 = lonlat(ext, 0, tx, ty, ext)
                pg = pg.intersection(Polygon([(lo0, la0), (lo1, la0), (lo1, la1), (lo0, la1)]))
                if pg.is_empty:
                    continue
                pieces.setdefault(bid, []).append(pg)
                heights[bid] = h

out = []
for bid, ps in pieces.items():
    u = unary_union(ps)
    parts = list(u.geoms) if isinstance(u, MultiPolygon) else [u]
    for pg in parts:
        if pg.geom_type != 'Polygon' or pg.area <= 0:
            continue
        c = pg.centroid
        if not (S <= c.y <= N and W <= c.x <= E):
            continue
        pg = pg.simplify(2e-6)
        out.append({'id': bid, 'h': round(heights[bid], 1), 'poly': [[round(la, 7), round(lo, 7)] for lo, la in pg.exterior.coords[:-1]]})
os.makedirs('data/plateau', exist_ok=True)
json.dump({
    'source': '3D都市モデル（Project PLATEAU）東京都23区（CityGML 2020年度）国土交通省、CC BY 4.0。indigo-lab/plateau-tokyo23ku-building-mvt-2020 から',
    'bbox': [S, W, N, E],
    'buildings': out,
}, open('data/plateau/buildings.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(f'{len(out)} 棟を data/plateau/buildings.json に保存')
