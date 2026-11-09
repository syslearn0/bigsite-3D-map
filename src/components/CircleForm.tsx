"use client";

import Link from "next/link";
// サークルの方が、自分のサークルを登録する画面（Google でログイン → 日・配置番号・サークル名・作品・キャラ・画像）。
// 作者が確かめて公開すると、地図の机に出る（歩いて見るときは、近くの机の上に画像とサークル名が出る）
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import layoutJson from "@/data/layout-sample.json";
import venueJson from "@/data/venue.json";
import { accountStore, api, initAccount } from "@/lib/account";
import { expandBooths, type HallLike, type Line } from "@/lib/layout";
import { PUB_KEYS, refreshPublished } from "@/lib/published";
import { loadLayout } from "@/lib/saved-layout";
import { DAYS, type Day } from "@/lib/tags";
import { AccountBox } from "./AccountBox";

type Mine = { id: number; day: Day; codes: string[]; name: string; works: string[]; chars: Record<string, string[]>; x: string; url: string; hasImage: boolean; status: "pending" | "approved" | "rejected"; note: string; updatedAt: number };
const STATUS = { pending: "作者の確認待ち", approved: "確認ずみ（公開されると地図に出ます）", rejected: "公開できませんでした" };
const MAX_IMG = 380_000;
const split = (s: string) => [...new Set(s.split(/[,、，\n]+/).map((x) => x.trim()).filter(Boolean))];

// 配置番号を整える：全角の英数字・いろいろな横棒を半角に、空白をとる。「東A01a」のように横棒がなくても読む
export function normCode(raw: string): string {
  let s = raw.normalize("NFKC").replace(/[‐‑‒–—―−ー－]/g, "-").replace(/\s+/g, "");
  s = s.replace(/^([東西南])(.+?)-?(\d{1,2})([abAB])$/, (_, b, blk, n, h) => `${b}${blk}-${n.padStart(2, "0")}${h.toLowerCase()}`);
  return s;
}
const CODE_RE = /^[東西南]\S{1,4}-\d{2}[ab]$/u;

// 画像を小さくする（長い辺 800px・webp。webp で書けないブラウザは jpeg）。380KB を超えるときは画質を下げる。
// あわせて、歩くときの机の札に出す小さい画像（160px の正方形。1 枚 5〜10KB）も作る
async function shrink(file: File): Promise<{ image: string; thumb: string }> {
  const bmp = await createImageBitmap(file);
  const T = 160, t = document.createElement("canvas");
  t.width = t.height = T;
  const k = Math.max(T / bmp.width, T / bmp.height);
  t.getContext("2d")!.drawImage(bmp, (T - bmp.width * k) / 2, (T - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
  let thumb = t.toDataURL("image/webp", 0.72);
  if (!thumb.startsWith("data:image/webp")) thumb = t.toDataURL("image/jpeg", 0.72);
  const scale = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  for (const q of [0.86, 0.75, 0.62, 0.5, 0.4]) {
    let url = c.toDataURL("image/webp", q);
    if (!url.startsWith("data:image/webp")) url = c.toDataURL("image/jpeg", q);
    if (url.length * 0.75 < MAX_IMG) return { image: url, thumb };
  }
  throw new Error("画像を小さくできませんでした。別の画像を選んでください");
}

export function CircleForm() {
  const acct = useSyncExternalStore(accountStore.subscribe, accountStore.get, accountStore.get);
  const [mine, setMine] = useState<Mine[]>([]);
  const [day, setDay] = useState<Day>(1);
  const [codes, setCodes] = useState("");
  const [name, setName] = useState("");
  const [x, setX] = useState("");
  const [url, setUrl] = useState("");
  const [works, setWorks] = useState("");
  const [chars, setChars] = useState<Record<string, string>>({});
  const [image, setImage] = useState<{ image: string; thumb: string } | null>(null); // 新しく選んだ画像（data URL。大・小）
  const [removeImage, setRemoveImage] = useState(false);
  const [agree, setAgree] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    initAccount();
  }, []);

  // 地図にある配置番号（公開された配置、なければ見本）。ないものを入れたときは注意だけ出す
  // （この画面はブラウザだけで描くので、端末の保存を読める）。地図を開いたことのない端末でも分かるよう、公開の配置を取り直す
  const [pubTick, setPubTick] = useState(0);
  useEffect(() => {
    refreshPublished().then((changed) => changed && setPubTick((t) => t + 1));
  }, []);
  const known = useMemo(() => {
    const pubLines = loadLayout(PUB_KEYS.layout);
    const lines = pubLines ?? (layoutJson as unknown as { lines: Line[] }).lines;
    return { set: new Set(expandBooths(lines, (venueJson as unknown as { halls: HallLike[] }).halls).map((b) => b.code)), real: !!pubLines, tick: pubTick };
  }, [pubTick]);

  const fill = (list: Mine[], d: Day) => {
    const m = list.find((c) => c.day === d);
    setCodes(m ? m.codes.join("、") : "");
    setName(m?.name ?? "");
    setX(m?.x ? "@" + m.x : "");
    setUrl(m?.url ?? "");
    setWorks(m ? m.works.join("、") : "");
    setChars(m ? Object.fromEntries(Object.entries(m.chars).map(([w, l]) => [w, l.join("、")])) : {});
    setImage(null);
    setRemoveImage(false);
  };
  useEffect(() => {
    if (!acct.me) return;
    api<{ circles: Mine[] }>("circle.php")
      .then((r) => {
        setMine(r.circles);
        const first = r.circles[0]?.day ?? 1;
        setDay(first);
        fill(r.circles, first);
      })
      .catch((e) => setMsg({ text: e.message, err: true }));
  }, [acct.me]);

  const current = mine.find((c) => c.day === day);
  const codeList = split(codes.replace(/\s+/g, "、")).map(normCode);
  const badCodes = codeList.filter((c) => !CODE_RE.test(c));
  const unknownCodes = codeList.filter((c) => CODE_RE.test(c) && !known.set.has(c));
  const workList = split(works);

  const submit = async () => {
    setMsg(null);
    if (!codeList.length || badCodes.length) return setMsg({ text: "配置番号を「東A-01a」の形で入れてください", err: true });
    if (codeList.length > 4) return setMsg({ text: "配置番号は 4 つまでです", err: true });
    if (!name.trim()) return setMsg({ text: "サークル名を入れてください", err: true });
    if (url && !/^https:\/\//.test(url.trim())) return setMsg({ text: "URL は https:// から始まるものを入れてください", err: true });
    if (!agree) return setMsg({ text: "下の確認にチェックを入れてください", err: true });
    setBusy(true);
    try {
      const r = await api<{ circles: Mine[] }>("circle.php", {
        body: {
          day,
          codes: codeList,
          name: name.trim(),
          x: x.trim(),
          url: url.trim(),
          works: workList,
          chars: Object.fromEntries(workList.map((w) => [w, split(chars[w] ?? "")]).filter(([, l]) => l.length)),
          image: image?.image,
          thumb: image?.thumb,
          removeImage,
        },
      });
      setMine(r.circles);
      fill(r.circles, day);
      setMsg({ text: "登録しました。作者が確かめてから地図に出ます（数日かかることがあります）" });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "登録できませんでした", err: true });
    }
    setBusy(false);
  };

  const remove = async () => {
    if (!confirm(`${day}日目の登録を取り消しますか？`)) return;
    setBusy(true);
    try {
      const r = await api<{ circles: Mine[] }>(`circle.php?day=${day}`, { method: "DELETE" });
      setMine(r.circles);
      fill(r.circles, day);
      setMsg({ text: "取り消しました" });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "取り消せませんでした", err: true });
    }
    setBusy(false);
  };

  return (
    <main className="page">
      <h1>サークルの登録</h1>
      <p style={{ margin: "0 0 4px" }}>
        <Link href="/">地図へ</Link>
      </p>
      <p>
        サークルの方が、配置番号・サークル名・作品・画像を入れると、作者が確かめたあと、この 3D マップの机に出ます（机を押したときと、歩いて見るときに近くの机の上）。
        登録は 1 日につき 1 件です（いくつかの日に出る方は、日ごとに登録してください）。
      </p>
      <p style={{ color: "var(--muted)", fontSize: ".85rem" }}>
        この地図は、コミックマーケット準備会・株式会社東京ビッグサイトとは関係のない非公式のものです。
        {!known.real && " いまの地図の配置は見本です（本当の配置ではありません）。"}
      </p>

      <h2>1. ログイン</h2>
      <p style={{ fontSize: ".85rem", color: "var(--muted)", margin: "0 0 6px" }}>なりすましを防ぐため、Google のアカウントでログインしてください。メールアドレスは公開しません。</p>
      <AccountBox compact />
      {acct.ready && !acct.available && <p className="err">サーバーにつながりません。時間をおいて、もう一度開いてください。</p>}

      {acct.me && (
        <>
          {acct.me.role === "banned" ? (
            <p className="err">このアカウントは止められています。</p>
          ) : (
            <>
              <h2>2. 登録の内容</h2>
              <div className="seg" role="group" aria-label="日" style={{ display: "flex" }}>
                {DAYS.map((d) => (
                  <button
                    key={d}
                    style={{ flex: 1 }}
                    aria-pressed={day === d}
                    onClick={() => {
                      setDay(d);
                      fill(mine, d);
                      setMsg(null);
                    }}
                  >
                    {d}日目{mine.some((c) => c.day === d) ? " ✓" : ""}
                  </button>
                ))}
              </div>
              {current && (
                <p className={current.status === "rejected" ? "warn" : "soft"} style={{ padding: "6px 10px", borderRadius: 6, fontSize: ".9rem" }}>
                  {day}日目の登録：{STATUS[current.status]}
                  {current.note && `（作者から：${current.note}）`}
                  <br />
                  <span style={{ color: "var(--muted)", fontSize: ".8rem" }}>内容を変えて送ると、もう一度確認待ちになります</span>
                </p>
              )}

              <label className="field">
                配置番号 <small>必須・「東A-01a」の形。2 スペースのときは「東A-01a、東A-01b」</small>
                <input type="text" value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="東A-01a" autoComplete="off" />
              </label>
              {codeList.length > 0 && (
                <div style={{ fontSize: ".85rem", marginTop: 4 }}>
                  読みとった番号：{codeList.join("・")}
                  {badCodes.length > 0 && <div className="err">形が違います：{badCodes.join("・")}（「東A-01a」のように、館・列・番号・a か b）</div>}
                  {unknownCodes.length > 0 && known.real && <div style={{ color: "var(--muted)" }}>地図の配置にない番号です：{unknownCodes.join("・")}（このまま送れます。作者が確かめます）</div>}
                </div>
              )}

              <label className="field">
                サークル名 <small>必須</small>
                <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                X（旧 Twitter）のアカウント <small>任意</small>
                <input type="text" value={x} maxLength={31} onChange={(e) => setX(e.target.value)} placeholder="@example" autoComplete="off" />
              </label>
              <label className="field">
                お品書き・サイトの URL <small>任意・https:// から</small>
                <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
              </label>
              <label className="field">
                作品 <small>任意・「、」で区切って 10 まで。地図の「ジャンル・作品」の絞り込みに使います</small>
                <input type="text" value={works} onChange={(e) => setWorks(e.target.value)} placeholder="作品名、作品名" />
              </label>
              {workList.slice(0, 10).map((w) => (
                <label key={w} className="field" style={{ fontWeight: 400 }}>
                  「{w}」のキャラ・グループ <small>任意・「、」で区切る</small>
                  <input type="text" value={chars[w] ?? ""} onChange={(e) => setChars((c) => ({ ...c, [w]: e.target.value }))} />
                </label>
              ))}

              <label className="field">
                画像 <small>任意・サークルカットなど。正方形に近いものが見やすいです（小さくしてから送ります）</small>
              </label>
              <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
                {image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={image.image} alt="選んだ画像" style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 8 }} />
                ) : current?.hasImage && !removeImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/image.php?id=${current.id}&t=${current.updatedAt}`} alt="登録した画像" style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 8 }} />
                ) : null}
                <label className="chip" style={{ cursor: "pointer" }}>
                  画像を選ぶ
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (!f) return;
                      try {
                        setImage(await shrink(f));
                        setRemoveImage(false);
                      } catch (err) {
                        setMsg({ text: err instanceof Error ? err.message : "画像を読めませんでした", err: true });
                      }
                    }}
                  />
                </label>
                {(image || (current?.hasImage && !removeImage)) && (
                  <button
                    className="chip"
                    onClick={() => {
                      setImage(null);
                      setRemoveImage(!!current?.hasImage);
                    }}
                  >
                    画像を外す
                  </button>
                )}
              </div>

              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 18, fontSize: ".9rem" }}>
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 5 }} />
                <span>
                  このサークルの本人（またはサークルの代表から頼まれた人）です。画像はこのサークルが使ってよいものです。入れた内容（メールアドレスをのぞく）が地図に公開されることに同意します。
                </span>
              </label>

              {msg && (
                <p className={msg.err ? "err" : "soft"} style={{ padding: "6px 10px", borderRadius: 6 }}>
                  {msg.text}
                </p>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                <button className="primary" disabled={busy} onClick={submit} style={{ minHeight: 46, padding: "0 22px", fontWeight: 700 }}>
                  {current ? "変更を送る" : "登録する"}
                </button>
                {current && (
                  <button disabled={busy} onClick={remove} style={{ minHeight: 46 }}>
                    {day}日目の登録を取り消す
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}

      <h2>よくある質問</h2>
      <p style={{ fontSize: ".9rem" }}>
        <b>すぐに地図に出ますか？</b> 作者が内容を確かめてから出します。<br />
        <b>同じ配置番号を、ほかの人がもう登録していると出ます。</b> なりすましのおそれがあるので、作者に知らせてください（メール：<a href="mailto:syslearn0@gmail.com">syslearn0@gmail.com</a>・X：
        <a href="https://x.com/riku819979" target="_blank" rel="noopener noreferrer">
          @riku819979
        </a>
        ）。<br />
        <b>消したいときは？</b> この画面の「登録を取り消す」で消せます。地図からは、次に作者が公開しなおしたときに消えます。
      </p>
      <p style={{ fontSize: ".85rem" }}>
        <Link href="/privacy/">プライバシーポリシー</Link>
      </p>
    </main>
  );
}
