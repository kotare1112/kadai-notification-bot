// myFIT(UNIPA RX2.0)にログインし、クラスプロファイルの各授業の「課題提出」「テスト」一覧から未提出の項目を取り出す。
// ポータルの「期限あり」は全件を網羅しないため補助として使う。
// Browser Rendering の無料枠(1 日 10 分・アイドル 60 秒)に収めるため、DOM の解析はブラウザ内で行い、
// Worker 側は JSON を受け取るだけにする。ID とパスワードはログ・エラー文に出さない。
import puppeteer, { type Page } from "@cloudflare/puppeteer";
import { MyfitError, type MyfitCredentials } from "./errors.ts";
import { extractCourseList, extractCurrentCourse, extractDeadlineItems, type RawItem } from "./extract.ts";
import { mergeItems } from "./sync.ts";
import type { ScrapeResult } from "../sync.ts";

const TOP_URL = "https://my.fit.ac.jp/";
const LOGOUT_URL = "https://my.fit.ac.jp/logout-unipa.php";
const PORTAL_PATH = "/uprx/up/pk/pky001/Pky00102.xhtml";
const PORTAL_URL = `https://unipa.fit.ac.jp${PORTAL_PATH}`;
// クラスプロファイルで授業を巡回できる合計時間。超えたら残りの授業は読まない
const COURSES_BUDGET_MS = 240_000;
const NAV_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 60_000;
const POLL_MS = 500;
const MAX_MORE_CLICKS = 10;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ブラウザ内で実行してログイン画面の状態を返す(外部変数を使わない)。 */
function inspectLoginState() {
  const visible = (sel: string): boolean => {
    const el = document.querySelector<HTMLElement>(sel);
    return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const text = document.body?.innerText ?? "";
  const passwordError = document.querySelector<HTMLElement>("#passwordError");
  return {
    url: location.href,
    host: location.hostname,
    loginfmt: visible("input[name=loginfmt]"),
    loginfmtValue: document.querySelector<HTMLInputElement>("input[name=loginfmt]")?.value ?? "",
    passwd: visible("input[name=passwd]"),
    passwordError: !!passwordError && passwordError.getClientRects().length > 0 && (passwordError.textContent ?? "").trim() !== "",
    kmsiBack: visible("#idBtn_Back"),
    mfa:
      visible("#idDiv_SAOTCS_Proofs") ||
      visible("#idDiv_SAASTO_Title") ||
      visible("#idDiv_SAASDS_Title") ||
      location.href.includes("/SAS/") ||
      text.includes("本人確認") ||
      text.includes("サインイン要求を承認"),
    blocked: text.includes("アクセスがブロック") || /blocked/i.test(text),
  };
}
type LoginState = ReturnType<typeof inspectLoginState>;

async function readState(page: Page): Promise<LoginState | null> {
  try {
    return (await page.evaluate(`(${inspectLoginState.toString()})()`)) as LoginState;
  } catch {
    return null; // 画面遷移中(実行コンテキストが破棄された)
  }
}

async function login(page: Page, cred: MyfitCredentials): Promise<void> {
  await page.goto(TOP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // iframe(index-bene.php)内の pclogin フォームに ID だけを入れて送信する(パスワードは Microsoft 側で入力)
  const frameEl = await page.waitForSelector("iframe[src*='index-bene.php']", { timeout: 20_000 });
  const frame = await frameEl?.contentFrame();
  if (!frame) throw new MyfitError("layout_changed", "myFIT のログインフォームが見つかりません");
  await frame.waitForSelector("#pclogin input[name=fLoginID]", { timeout: 20_000 });
  await frame.type("#pclogin input[name=fLoginID]", cred.id);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }),
    frame.$eval("#pclogin", (f) => (f as HTMLFormElement).submit()),
  ]);

  // Entra ID → SAML 連鎖 → ポータルトップ。状態を見ながら進め、各入力は 1 回しか行わない。
  let usernameDone = false;
  let passwordDone = false;
  let kmsiDone = false;
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const s = await readState(page);
    if (!s) {
      await sleep(POLL_MS);
      continue;
    }
    if (s.host === "unipa.fit.ac.jp" && new URL(s.url).pathname === PORTAL_PATH) return;

    const onMicrosoft = s.host.endsWith("microsoftonline.com") || s.host.endsWith("microsoft.com");
    if (onMicrosoft) {
      if (s.blocked) throw new MyfitError("blocked", "Microsoft にアクセスをブロックされました");
      if (s.mfa) throw new MyfitError("mfa_required", "Microsoft が追加の本人確認を要求しました");
      if (passwordDone && s.passwordError) throw new MyfitError("bad_password", "パスワードが違います");

      if (s.loginfmt && !usernameDone) {
        usernameDone = true;
        // Entra のユーザー名は <ID>@bene.fit.ac.jp(通常は login_hint で事前入力済み)
        const upn = cred.id.includes("@") ? cred.id : `${cred.id}@bene.fit.ac.jp`;
        if (!s.loginfmtValue) await page.type("input[name=loginfmt]", upn);
        await page.click("#idSIButton9");
        await sleep(1500);
        continue;
      }
      if (s.passwd && !passwordDone) {
        passwordDone = true;
        await page.type("input[name=passwd]", cred.password);
        await page.click("#idSIButton9");
        await sleep(1500);
        continue;
      }
      if (passwordDone && !kmsiDone && s.kmsiBack && !s.passwd && !s.loginfmt) {
        kmsiDone = true;
        await page.click("#idBtn_Back"); // 「サインインの状態を維持しますか?」→ いいえ
        await sleep(1500);
        continue;
      }
    }
    await sleep(POLL_MS);
  }
  throw new MyfitError("timeout", "ログインが 60 秒以内に完了しませんでした");
}

/** 「もっと見る」を押して .dispTab_2 の行を増やす。押せたら true。 */
function clickMore(): boolean {
  const tab = document.querySelector(".dispTab_2");
  if (!tab) return false;
  const scopes = [tab, tab.closest(".ui-tabs-panel")];
  for (const scope of scopes) {
    const link = Array.from(scope?.querySelectorAll("a") ?? []).find((a) => (a.textContent ?? "").includes("もっと見る"));
    if (link) {
      (link as HTMLElement).click(); // タブが非表示でも onclick(PrimeFaces AJAX)が走るよう DOM 経由で押す
      return true;
    }
  }
  return false;
}

function countRows(): number {
  return document.querySelectorAll(".dispTab_2 li.ui-dataview-row").length;
}

async function evalNum(page: Page, fn: () => number): Promise<number> {
  return (await page.evaluate(`(${fn.toString()})()`)) as number;
}

async function loadAllRows(page: Page): Promise<void> {
  for (let i = 0; i < MAX_MORE_CLICKS; i++) {
    const before = await evalNum(page, countRows);
    const clicked = (await page.evaluate(`(${clickMore.toString()})()`)) as boolean;
    console.log(`myfit more: click=${i} rows=${before} linkFound=${clicked}`);
    if (!clicked) return; // リンクが無い = 全件表示済み
    // AJAX による差し替えで行数が増えるのを最大 8 秒待つ。増えなければ打ち切る。
    let grown = false;
    for (let t = 0; t < 40 && !grown; t++) {
      await sleep(200);
      try {
        grown = (await evalNum(page, countRows)) > before;
      } catch {
        // 差し替え中は無視して再試行
      }
    }
    if (!grown) {
      console.log(`myfit more: rows did not grow after click=${i} (now ${await evalNum(page, countRows).catch(() => -1)})`);
      return;
    }
  }
}

type Kind = "課題" | "テスト";
const MENU_LABEL: Record<Kind, string> = { 課題: "課題提出", テスト: "テスト" };
const TABLE_HEADER: Record<Kind, string> = { 課題: "課題提出終了日時", テスト: "テスト終了日時" };

/** ブラウザ内で条件式を繰り返し評価し、真になるのを待つ。遷移中の例外は無視して再試行する。 */
async function pollUntil(page: Page, expr: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await page.evaluate(expr)) return true;
    } catch {
      // 画面遷移中(実行コンテキストが破棄された)
    }
    await sleep(300);
  }
  return false;
}

/** ブラウザ内で click を実行する。遷移で実行コンテキストが壊れて例外になるのは正常なので握りつぶす。 */
async function clickIn(page: Page, expr: string): Promise<boolean> {
  try {
    return (await page.evaluate(expr)) as boolean;
  } catch {
    return true;
  }
}

/** ポータルトップの「クラスプロファイル」アイコン(p.infoClassprofile)の親の a を押す。 */
function clickClassProfile(): boolean {
  const icon = document.querySelector("p.infoClassprofile");
  const a = icon?.closest("a") as HTMLElement | null;
  if (!a) return false;
  a.click(); // onclick の PrimeFaces.submit('funcForm') による通常のフォーム送信
  return true;
}

/** 左の授業一覧の授業名(全 .classList、重複は除く)。 */
function listCourses(): string[] {
  const links = document.querySelectorAll(".classList a.ui-commandlink");
  const names: string[] = [];
  for (let i = 0; i < links.length; i++) {
    const t = (links[i].textContent ?? "").replace(/[\s　]+/g, " ").trim();
    if (t && names.indexOf(t) < 0) names.push(t);
  }
  return names;
}

/** 授業名が name の a を押す(AJAX → 隠しボタンのクリック → 遷移)。 */
function clickCourse(name: string): boolean {
  const links = document.querySelectorAll(".classList a.ui-commandlink");
  for (let i = 0; i < links.length; i++) {
    if ((links[i].textContent ?? "").replace(/[\s　]+/g, " ").trim() === name) {
      (links[i] as HTMLElement).click();
      return true;
    }
  }
  return false;
}

/** 機能メニューのボタン(TOP / 課題提出 / テスト …)を表示名で探して押す。無ければ false。 */
function clickMenu(label: string): boolean {
  const spans = document.querySelectorAll("button span.ui-button-text");
  for (let i = 0; i < spans.length; i++) {
    if ((spans[i].textContent ?? "").replace(/[\s　]+/g, "") === label) {
      (spans[i].closest("button") as HTMLElement).click(); // confirmIfModified → 次の隠しリンクをクリック
      return true;
    }
  }
  return false;
}

const call = (fn: Function, ...args: unknown[]) => `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
const inDoc = (fn: Function, ...args: unknown[]) => `(${fn.toString()})(document${args.map((a) => "," + JSON.stringify(a)).join("")})`;

/** ポータルトップからクラスプロファイルに入り、授業一覧が出るのを待つ。 */
async function enterClassProfile(page: Page): Promise<void> {
  if (!(await clickIn(page, call(clickClassProfile)))) throw new Error("classprofile link not found");
  if (!(await pollUntil(page, `document.querySelectorAll(".classList a.ui-commandlink").length > 0`, NAV_TIMEOUT_MS))) {
    throw new Error("course list not shown");
  }
}

/** 授業一覧が見える状態にする(見えなければ「TOP」ボタンで戻る)。 */
async function ensureCourseList(page: Page): Promise<void> {
  const has = `document.querySelectorAll(".classList a.ui-commandlink").length > 0`;
  if (await pollUntil(page, has, 1_500)) return;
  await clickIn(page, call(clickMenu, "TOP"));
  if (!(await pollUntil(page, has, NAV_TIMEOUT_MS))) throw new Error("course list not shown");
}

async function currentCourse(page: Page): Promise<string | null> {
  try {
    return (await page.evaluate(inDoc(extractCurrentCourse))) as string | null;
  } catch {
    return null;
  }
}

async function switchCourse(page: Page, name: string): Promise<void> {
  await ensureCourseList(page);
  if ((await currentCourse(page)) !== name) {
    if (!(await clickIn(page, call(clickCourse, name)))) throw new Error("course link not found");
    const end = Date.now() + NAV_TIMEOUT_MS;
    while ((await currentCourse(page)) !== name) {
      if (Date.now() > end) throw new Error("course switch timed out");
      await sleep(300);
    }
  }
}

/** 現在の授業の一覧(課題提出 / テスト)を開いて取り出す。メニューにボタンが無ければ null(その授業には無い)。 */
async function fetchKind(page: Page, kind: Kind, course: string): Promise<RawItem[] | null> {
  const label = MENU_LABEL[kind];
  const hasButton = `Array.from(document.querySelectorAll("button span.ui-button-text")).some((s) => (s.textContent || "").replace(/[\\s　]+/g, "") === ${JSON.stringify(label)})`;
  if (!(await pollUntil(page, hasButton, 3_000))) return null;
  await clickIn(page, call(clickMenu, label));
  const header = JSON.stringify(TABLE_HEADER[kind]);
  const shown = `Array.from(document.querySelectorAll("table thead th")).some((t) => (t.textContent || "").replace(/[\\s　]+/g, "").includes(${header}))`;
  if (!(await pollUntil(page, shown, NAV_TIMEOUT_MS))) throw new Error("list not shown");
  return (await page.evaluate(inDoc(extractCourseList, kind, course))) as RawItem[];
}

interface CourseScrape {
  items: RawItem[];
  complete: boolean;
}

async function scrapeCourses(page: Page): Promise<CourseScrape> {
  const items: RawItem[] = [];
  let complete = true;
  let names: string[];
  try {
    await enterClassProfile(page);
    names = (await page.evaluate(call(listCourses))) as string[];
  } catch (e) {
    console.log(`myfit classprofile failed: ${(e as Error)?.name ?? "Error"} ${(e as Error)?.message ?? ""}`);
    return { items, complete: false };
  }
  console.log(`myfit courses: ${names.length}`);

  const start = Date.now();
  for (let n = 0; n < names.length; n++) {
    const name = names[n];
    if (Date.now() - start > COURSES_BUDGET_MS) {
      console.log(`myfit courses: time budget exceeded, skipped ${names.length - n} course(s)`);
      complete = false;
      break;
    }
    const counts: string[] = [];
    let step = "switch";
    try {
      await switchCourse(page, name);
      for (const kind of ["課題", "テスト"] as const) {
        step = kind;
        const got = await fetchKind(page, kind, name);
        counts.push(`${kind}=${got ? got.length : "-"}`);
        if (got) items.push(...got);
      }
    } catch (e) {
      complete = false;
      console.log(`myfit course failed: ${name} step=${step} ${(e as Error)?.name ?? "Error"} ${(e as Error)?.message ?? ""}`);
      // 画面が想定外の状態に残った可能性があるので、ポータル経由でクラスプロファイルに入り直す
      try {
        await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        await enterClassProfile(page);
      } catch {
        // 次の授業の switchCourse が失敗として扱う
      }
      continue;
    }
    console.log(`myfit course: ${name} ${counts.join(" ")}`);
  }
  return { items, complete };
}

export async function scrapeMyfit(browserBinding: Fetcher, cred: MyfitCredentials): Promise<ScrapeResult> {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    // esbuild の keepNames が差し込む __name をブラウザ内でも未定義にしないための保険
    await page.evaluateOnNewDocument("globalThis.__name = globalThis.__name || ((f) => f);");
    try {
      await login(page, cred);
      try {
        await page.waitForSelector(".dispTab_2", { timeout: 20_000 });
      } catch {
        throw new MyfitError("layout_changed", "ポータルに入れましたが「期限あり」の一覧が見つかりません");
      }
      // 補助: ポータルの「期限あり」(日付のみ。全件は載らない)
      await loadAllRows(page);
      const portal = (await page.evaluate(inDoc(extractDeadlineItems))) as RawItem[];
      // 主: 各授業の「課題提出」「テスト」一覧
      const { items, complete } = await scrapeCourses(page);
      return { items: mergeItems(items, portal), complete };
    } finally {
      // 同じ ID の同時ログインが警告されるので、成否にかかわらずログアウトする
      try {
        await page.goto(LOGOUT_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
      } catch {
        // ログアウト失敗は握りつぶし、ブラウザを閉じてセッションを捨てる
      }
    }
  } catch (e) {
    if (e instanceof MyfitError) throw e;
    const name = (e as Error)?.name;
    if (name === "TimeoutError") throw new MyfitError("timeout", "myFIT の画面待機がタイムアウトしました");
    throw new MyfitError("unknown", `予期しないエラー: ${name ?? "Error"}`);
  } finally {
    await browser.close().catch(() => {});
  }
}
