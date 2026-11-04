// 端末に保存した配置。エディタの書きかけ（DRAFT_KEY）と、メインの地図で使う配置（LAYOUT_KEY）
import { parseLayoutFile, toLayoutFile, type Line } from "./layout";

export const LAYOUT_KEY = "comiket3d:layout";
export const DRAFT_KEY = "comiket3d:layout-draft";

export function loadLayout(key: string): Line[] | null {
  try {
    return parseLayoutFile(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return null;
  }
}

export function saveLayout(key: string, lines: Line[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(toLayoutFile(lines)));
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
