// アプリのアイコン（ホーム画面用）を作る。使い方：npm run make:icons
import sharp from "sharp";

// 紺の角丸の四角に、斜めから見た床（ひし形）と白い「3D」。maskable 用は、中身を中央の安全な範囲（80%）に収める
const svg = (size: number, maskable: boolean) => {
  const pad = maskable ? 0 : size * 0.06;
  const r = maskable ? 0 : size * 0.22;
  const k = maskable ? 0.8 : 1;
  const c = size / 2;
  const w = size * 0.34 * k, h = size * 0.17 * k, y = size * 0.66;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect x="${pad}" y="${pad}" width="${size - pad * 2}" height="${size - pad * 2}" rx="${r}" fill="#1f3f7a"/>
  <polygon points="${c - w},${y} ${c},${y - h} ${c + w},${y} ${c},${y + h}" fill="#6ea0ff"/>
  <text x="50%" y="${size * 0.42}" text-anchor="middle" dominant-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${size * 0.3 * k}" fill="#ffffff">3D</text>
</svg>`;
};

for (const [name, size, maskable] of [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-512.png", 512, true],
  ["apple-touch-icon.png", 180, true],
] as const) {
  await sharp(Buffer.from(svg(size, maskable))).png().toFile(`public/${name}`);
  console.log(name);
}
