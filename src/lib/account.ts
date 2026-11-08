// サーバー（Xserver の PHP、/api/*.php）とのやりとりと、Google ログイン。
// ログインは任意。サーバーがないとき（開発中の next dev・Vercel）は、ログインの欄を出さない。

export type Role = "user" | "pending" | "collab" | "admin" | "banned";
export type Me = { id: number; name: string; email: string; role: Role };

type State = { ready: boolean; available: boolean; me: Me | null; clientId: string };
let state: State = { ready: false, available: false, me: null, clientId: "" };
const listeners = new Set<() => void>();
const set = (s: Partial<State>) => {
  state = { ...state, ...s };
  listeners.forEach((f) => f());
};
export const accountStore = {
  subscribe(f: () => void) {
    listeners.add(f);
    return () => listeners.delete(f);
  },
  get: () => state,
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// 書きこみは X-S3D の印をつける（ほかのサイトからの送信を断るため。サーバーは同じオリジンかも確かめる）
export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch("/api/" + path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: { "X-S3D": "1", ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(res.status, "サーバーの返事が読めません");
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? `エラー（${res.status}）`);
  return data as T;
}

let started: Promise<void> | null = null;
// 最初に 1 回：サーバーがあるか・ログインしているかを聞く
export function initAccount(): Promise<void> {
  started ??= (async () => {
    try {
      const r = await api<{ me: Me | null; clientId: string }>("me.php");
      set({ ready: true, available: !!r.clientId, me: r.me, clientId: r.clientId });
    } catch {
      set({ ready: true, available: false, me: null });
    }
  })();
  return started;
}

export async function refreshMe() {
  try {
    const r = await api<{ me: Me | null; clientId: string }>("me.php");
    set({ me: r.me });
    return r.me;
  } catch {
    return state.me;
  }
}

// ---- Google Identity Services（ログインのボタン） ----
type Gis = {
  accounts: {
    id: {
      initialize(o: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: string; auto_select?: boolean; itp_support?: boolean }): void;
      renderButton(el: HTMLElement, o: Record<string, unknown>): void;
      disableAutoSelect(): void;
    };
  };
};
declare global {
  interface Window {
    google?: Gis;
  }
}
let gisLoad: Promise<Gis> | null = null;
function loadGis(): Promise<Gis> {
  gisLoad ??= new Promise((resolve, reject) => {
    if (window.google?.accounts) return resolve(window.google);
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => (window.google ? resolve(window.google) : reject(new Error("gis")));
    s.onerror = () => {
      gisLoad = null;
      reject(new Error("Google のログインを読みこめませんでした"));
    };
    document.head.appendChild(s);
  });
  return gisLoad;
}

let initialized = false;
let onLoginError: ((m: string) => void) | null = null;
// el に Google のログインのボタンを描く。押してログインできたら me が変わる
export async function renderLoginButton(el: HTMLElement, onError?: (m: string) => void) {
  onLoginError = onError ?? null;
  const g = await loadGis();
  if (!initialized) {
    g.accounts.id.initialize({
      client_id: state.clientId,
      itp_support: true,
      callback: async ({ credential }) => {
        try {
          const r = await api<{ me: Me }>("auth.php", { body: { credential } });
          set({ me: r.me });
        } catch (e) {
          onLoginError?.(e instanceof Error ? e.message : "ログインできませんでした");
        }
      },
    });
    initialized = true;
  }
  el.innerHTML = "";
  g.accounts.id.renderButton(el, { type: "standard", theme: "outline", size: "large", text: "signin_with", shape: "pill", locale: "ja", width: 240 });
}

export async function logout() {
  try {
    await api("auth.php", { method: "DELETE" });
  } catch {}
  window.google?.accounts.id.disableAutoSelect();
  set({ me: null });
}

export const ROLE_LABEL: Record<Role, string> = {
  user: "利用者",
  pending: "協力者（申しこみ中）",
  collab: "協力者",
  admin: "作者",
  banned: "停止中",
};
