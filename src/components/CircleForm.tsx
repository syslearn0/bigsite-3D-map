"use client";

import Link from "next/link";
// サークルの方が、自分のサークルを登録する画面（Google でログイン → 日・配置番号・サークル名・作品・キャラ・画像）。
// 送るとすぐに地図の机に出る（歩いて見るときは、近くの机の上に画像とサークル名が出る）。いくつかの日に出るときは、まとめて登録できる
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import layoutJson from "@/data/layout-sample.json";
import venueJson from "@/data/venue.json";
import { accountStore, api, initAccount } from "@/lib/account";
import { expandBooths, normCode, type HallLike, type Line } from "@/lib/layout";
import { PUB_KEYS, refreshPublished } from "@/lib/published";
import { loadLayout } from "@/lib/saved-layout";
import { DAYS, type Day } from "@/lib/tags";
import { EVENT } from "@/lib/event";
import { AccountBox } from "./AccountBox";

type Mine = { id: number; day: Day; codes: string[]; name: string; works: string[]; chars: Record<string, string[]>; x: string; url: string; hasImage: boolean; status: "pending" | "approved" | "rejected"; note: string; updatedAt: number };
// published：作者がサークルの登録を公開しているか（していないあいだは、受け付けても地図に出ない）
const statusText = (s: Mine["status"], published: boolean) =>
  s === "rejected" ? "作者が止めています（地図に出ていません）" : published ? "地図に出ています" : "受け付けました（地図に出るのは、作者がサークルの登録の公開を始めてから）";
type Res = { circles: Mine[]; published: boolean };
const MAX_IMG = 380_000;
const split = (s: string) => [...new Set(s.split(/[,、，\n]+/).map((x) => x.trim()).filter(Boolean))];

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
  const [published, setPublished] = useState(false);
  // 出る日と、日ごとの配置番号（サークル名・作品・画像などは、どの日も同じ）
  const [days, setDays] = useState<Day[]>([1]);
  const [codesBy, setCodesBy] = useState<Record<Day, string>>({ 1: "", 2: "", 3: "" });
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

  const fill = (list: Mine[]) => {
    const m = list[0];
    setDays(list.length ? list.map((c) => c.day) : [1]);
    setCodesBy({ 1: "", 2: "", 3: "", ...Object.fromEntries(list.map((c) => [c.day, c.codes.join("、")])) });
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
    api<Res>("circle.php")
      .then((r) => {
        setMine(r.circles);
        setPublished(!!r.published);
        fill(r.circles);
      })
      .catch((e) => setMsg({ text: e.message, err: true }));
  }, [acct.me]);

  const sortedDays = [...days].sort();
  const parse = (d: Day) => {
    const list = split(codesBy[d].replace(/\s+/g, "、")).map(normCode);
    return { list, bad: list.filter((c) => !CODE_RE.test(c)), unknown: list.filter((c) => CODE_RE.test(c) && !known.set.has(c)) };
  };
  // 画像を見せる登録（どの日も同じ画像なので、画像のある最初の日）
  const current = mine.find((c) => c.hasImage) ?? mine[0];
  const dropped = mine.filter((c) => !days.includes(c.day)); // 前は出ると登録していたが、外した日
  const stoppedDays = mine.filter((c) => c.status === "rejected").map((c) => c.day); // 作者が止めた日（取り消せない）
  const workList = split(works);

  const submit = async () => {
    setMsg(null);
    if (!days.length) return setMsg({ text: "出る日を選んでください", err: true });
    for (const d of sortedDays) {
      const { list, bad } = parse(d);
      if (!list.length || bad.length) return setMsg({ text: `${d}日目の配置番号を「東A-01a」の形で入れてください`, err: true });
      if (list.length > 4) return setMsg({ text: `${d}日目の配置番号は 4 つまでです`, err: true });
    }
    if (!name.trim()) return setMsg({ text: "サークル名を入れてください", err: true });
    if (url && !/^https:\/\//.test(url.trim())) return setMsg({ text: "URL は https:// から始まるものを入れてください", err: true });
    if (!agree) return setMsg({ text: "下の確認にチェックを入れてください", err: true });
    if (dropped.length && !confirm(`${dropped.map((c) => c.day).join("・")}日目の登録を取り消します。よいですか？`)) return;
    setBusy(true);
    try {
      // 外した日の取り消しも、いっしょに送る（1 回の送信で、全部そろって変わる）
      const r = await api<Res>("circle.php", {
        body: {
          days: sortedDays.map((d) => ({ day: d, codes: parse(d).list })),
          drop: dropped.map((c) => c.day),
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
      setPublished(!!r.published);
      fill(r.circles);
      // 作者が止めた日は、送りなおしても地図に出ない（そう書く）
      const shown = r.circles.filter((c) => c.status !== "rejected").map((c) => c.day);
      const stopped = r.circles.filter((c) => c.status === "rejected").map((c) => c.day);
      setMsg({
        text:
          `${sortedDays.join("・")}日目を登録しました。` +
          (shown.length
            ? r.published
              ? `${shown.join("・")}日目は地図に出ています（開いている地図は、開き直すと出ます）。`
              : "いまは作者がサークルの登録の公開を止めているので、地図に出るのは公開が始まってからです。"
            : "") +
          (stopped.length ? `${stopped.join("・")}日目は作者が止めているので、地図に出ません。` : ""),
      });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "登録できませんでした", err: true });
    }
    setBusy(false);
  };

  // 登録したことを X で知らせる（登録してある内容から作る。作者が止めた日は書かない）。
  // リンクは、地図をその日・その机を選んだ状態で開く
  const shown = mine.filter((c) => c.status !== "rejected");
  const shareUrl = shown.length && published
    ? "https://x.com/intent/tweet?" +
      new URLSearchParams({
        text: `即売会 3D マップに「${shown[0].name}」を登録しました！\n${shown.map((c) => `${c.day}日目 ${c.codes.join("・")}`).join(" / ")}\n`,
        url: `https://sokubai3d.textetc.net/?day=${shown[0].day}&code=${encodeURIComponent(shown[0].codes[0])}`,
        hashtags: EVENT.hashtags.join(","),
      })
        .toString()
        .replace(/\+/g, "%20") // 空白は %20 に（+ のままだと、そのまま出ることがある）
    : "";

  const remove = async () => {
    if (!confirm(`登録（${mine.map((c) => c.day).join("・")}日目）をすべて取り消しますか？`)) return;
    setBusy(true);
    try {
      const r = await api<Res>("circle.php?day=all", { method: "DELETE" });
      setMine(r.circles);
      setPublished(!!r.published);
      fill(r.circles);
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
        サークルの方が、配置番号・サークル名・作品・画像を入れると、すぐにこの 3D マップの机に出ます（机を押したときと、歩いて見るときに近くの机の上）。
        いくつかの日に出る方は、出る日をすべて選んで、日ごとの配置番号を入れてください（まとめて 1 回で登録できます）。
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
              <div className="field" style={{ marginTop: 6 }}>
                出る日 <small>必須・いくつでも</small>
              </div>
              <div className="seg" role="group" aria-label="出る日" style={{ display: "flex" }}>
                {DAYS.map((d) => (
                  <button
                    key={d}
                    style={{ flex: 1 }}
                    aria-pressed={days.includes(d)}
                    onClick={() => {
                      // 作者が止めた日は外せない（取り消して出しなおすのを防ぐ）
                      if (days.includes(d) && stoppedDays.includes(d)) return setMsg({ text: `${d}日目の登録は作者が止めているので、外せません。作者に連絡してください`, err: true });
                      setDays((l) => (l.includes(d) ? l.filter((x) => x !== d) : [...l, d]));
                      setMsg(null);
                    }}
                  >
                    {days.includes(d) ? "✓ " : ""}
                    {d}日目
                  </button>
                ))}
              </div>
              {mine.length > 0 && (
                <div className="soft" style={{ padding: "6px 10px", borderRadius: 6, fontSize: ".9rem", marginTop: 8 }}>
                  {mine.map((c) => (
                    <div key={c.id} className={c.status === "rejected" ? "warn" : undefined}>
                      {c.day}日目の登録：{statusText(c.status, published)}
                      {c.note && `（作者から：${c.note}）`}
                    </div>
                  ))}
                  <span style={{ color: "var(--muted)", fontSize: ".8rem" }}>{published ? "変えて送ると、すぐ地図に出ます" : "変えて送ると、すぐ変わります"}</span>
                </div>
              )}
              {dropped.length > 0 && days.length > 0 && <p className="warn" style={{ padding: "6px 10px", borderRadius: 6, fontSize: ".9rem" }}>送ると、{dropped.map((c) => c.day).join("・")}日目の登録は取り消されます</p>}

              {sortedDays.map((d) => {
                const { list, bad, unknown } = parse(d);
                return (
                  <div key={d}>
                    <label className="field">
                      {sortedDays.length > 1 ? `${d}日目の配置番号` : "配置番号"} <small>必須・「東A-01a」の形。2 スペースのときは「東A-01a、東A-01b」</small>
                      <input type="text" value={codesBy[d]} onChange={(e) => setCodesBy((c) => ({ ...c, [d]: e.target.value }))} placeholder="東A-01a" autoComplete="off" />
                    </label>
                    {list.length > 0 && (
                      <div style={{ fontSize: ".85rem", marginTop: 4 }}>
                        読みとった番号：{list.join("・")}
                        {bad.length > 0 && <div className="err">形が違います：{bad.join("・")}（「東A-01a」のように、館・列・番号・a か b）</div>}
                        {unknown.length > 0 && known.real && <div style={{ color: "var(--muted)" }}>地図の配置にない番号です：{unknown.join("・")}（このまま送れますが、地図には出ません）</div>}
                      </div>
                    )}
                  </div>
                );
              })}

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
                  {mine.length ? "変更を送る" : "登録する"}
                </button>
                {mine.length > 0 && !stoppedDays.length && (
                  <button disabled={busy} onClick={remove} style={{ minHeight: 46 }}>
                    登録をすべて取り消す
                  </button>
                )}
              </div>
              {shareUrl && (
                <div className="soft" style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8 }}>
                  <div style={{ fontSize: ".9rem", marginBottom: 8 }}>登録したことを X（旧 Twitter）で知らせる（文は、送る前に書きかえられます）</div>
                  <a className="primary" href={shareUrl} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", minHeight: 42, padding: "0 18px", borderRadius: 8, fontWeight: 700, textDecoration: "none" }}>
                    X でポストする
                  </a>
                </div>
              )}
            </>
          )}
        </>
      )}

      <h2>よくある質問</h2>
      <p style={{ fontSize: ".9rem" }}>
        <b>すぐに地図に出ますか？</b> はい、送るとすぐに出ます（開いている地図は、開き直すと出ます）。いたずらなどの登録は、作者が止めることがあります。<br />
        <b>同じ配置番号を、ほかの人がもう登録していると出ます。</b> なりすましのおそれがあるので、作者に知らせてください（メール：<a href="mailto:syslearn0@gmail.com">syslearn0@gmail.com</a>・X：
        <a href="https://x.com/riku819979" target="_blank" rel="noopener noreferrer">
          @riku819979
        </a>
        ）。<br />
        <b>消したいときは？</b> この画面の「登録をすべて取り消す」で消せます。1 日だけ消すときは、その日の選択を外して「変更を送る」を押してください。地図からもすぐに消えます（作者が止めた登録は、作者に連絡してください）。<br />
        <b>「短いあいだに何度も送られています」と出ました。</b> いたずらを防ぐため、送れるのは 1 分に 3 回・1 時間に 15 回までです。少し待ってから送ってください。
      </p>
      <p style={{ fontSize: ".85rem" }}>
        <Link href="/privacy/">プライバシーポリシー</Link>
      </p>
    </main>
  );
}
