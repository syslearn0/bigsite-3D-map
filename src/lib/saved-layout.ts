// 端末に保存した配置。エディタの書きかけ（DRAFT_KEY）と、メインの地図で使う配置（LAYOUT_KEY）
import { parseLayoutFeatures, parseLayoutFile, toLayoutFile, type LayoutFeatures, type Line } from "./layout";

export const LAYOUT_KEY = "comiket3d:layout";
export const DRAFT_KEY = "comiket3d:layout-draft";

export function loadLayout(key: string): Line[] | null {
  try {
    return parseLayoutFile(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return null;
  }
}

// 配置といっしょに保存した会場のつくり（柱・壁の切れ目）
export function loadLayoutFeatures(key: string): LayoutFeatures | null {
  try {
    return parseLayoutFeatures(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return null;
  }
}

export function saveLayout(key: string, lines: Line[], features?: LayoutFeatures | null): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(toLayoutFile(lines, features)));
    return true;
  } catch {
    return false;
  }
}

export function clearLayout(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {}
}
