// 緯度経度と、会場の中のメートル座標（x：東、z：南）の行き来。three.js の床（XZ 平面）にそのまま使える。

export type XZ = [number, number];

const R = 6371000;
const rad = Math.PI / 180;

export function project(origin: { lat: number; lon: number }, lat: number, lon: number): XZ {
  const x = (lon - origin.lon) * rad * R * Math.cos(origin.lat * rad);
  const z = -(lat - origin.lat) * rad * R;
  return [Math.round(x * 10) / 10, Math.round(z * 10) / 10];
}

export function unproject(origin: { lat: number; lon: number }, [x, z]: XZ) {
  return { lat: origin.lat - z / rad / R, lon: origin.lon + x / rad / R / Math.cos(origin.lat * rad) };
}

export function pointInPolygon([x, z]: XZ, poly: XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function centroid(poly: XZ[]): XZ {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f;
    cx += (poly[j][0] + poly[i][0]) * f;
    cz += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return poly[0];
  return [cx / (3 * a), cz / (3 * a)];
}

function hull(points: XZ[]): XZ[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: XZ, a: XZ, b: XZ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XZ[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: XZ[] = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// 面積が一番小さい、傾いた長方形。ホールの向き（島を並べる向き）を決めるのに使う。
// angle：長方形の u 軸の向き（x 軸から z 軸へ回す角、ラジアン）。u が長い辺。
export type Rect = { center: XZ; angle: number; length: number; width: number };

export function minAreaRect(poly: XZ[]): Rect {
  const h = hull(poly);
  let best: Rect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < h.length; i++) {
    const [ax, az] = h[i];
    const [bx, bz] = h[(i + 1) % h.length];
    const angle = Math.atan2(bz - az, bx - ax);
    const c = Math.cos(angle), s = Math.sin(angle);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, z] of h) {
      const u = x * c + z * s;
      const v = -x * s + z * c;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea - 1e-6) {
      bestArea = area;
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      const center: XZ = [cu * c - cv * s, cu * s + cv * c];
      const lu = maxU - minU, lv = maxV - minV;
      best = lu >= lv ? { center, angle, length: lu, width: lv } : { center, angle: angle + Math.PI / 2, length: lv, width: lu };
    }
  }
  return best!;
}
