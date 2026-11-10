// いま対象にしている催し（次の回に変えるときは、ここだけ書きかえる）
export const EVENT = {
  name: "C109",
  // サークルが登録したことを X でポストするときのハッシュタグ（# はつけない）
  hashtags: ["即売会3Dマップ", "C109", "コミケ"],
  // 1・2・3 日目の曜日（コミケ Web カタログのチェックリスト CSV の「参加日」を、何日目かに読みかえる）。
  // C109 は 2026 年 12 月 29 日（火）・30 日（水）・31 日（木）
  weekdays: ["火", "水", "木"],
  // 1・2・3 日目の日付（日本の時刻）。「✓ 行った」は、その日になってから出す
  dates: ["2026-12-29", "2026-12-30", "2026-12-31"],
};

// きょうの日付（日本の時刻。"2026-12-29" の形）。開発中だけ、localStorage の comiket3d:dev-today で変えられる
export function todayJst(): string {
  if (process.env.NODE_ENV !== "production") {
    try {
      const t = localStorage.getItem("comiket3d:dev-today");
      if (t) return t;
    } catch {}
  }
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

// その日（1・2・3 日目）になったか（当日とそのあと）
export const dayStarted = (day: 1 | 2 | 3, today = todayJst()) => today >= EVENT.dates[day - 1];

// 「12月29日」の形
export const dateLabel = (day: 1 | 2 | 3) => {
  const [, m, d] = EVENT.dates[day - 1].split("-").map(Number);
  return `${m}月${d}日`;
};
