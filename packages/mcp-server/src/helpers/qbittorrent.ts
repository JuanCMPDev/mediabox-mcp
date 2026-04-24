import { QBIT_URL, QBIT_USER, QBIT_PASS } from "../config.js";

let qbitCookie: string | null = null;

export async function qbitLogin(): Promise<void> {
  const res = await fetch(`${QBIT_URL}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: QBIT_USER, password: QBIT_PASS }),
  });
  const text = await res.text();
  if (text !== "Ok.") throw new Error("qBittorrent login failed");
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (cookie) qbitCookie = cookie;
}

export async function qbitApi(endpoint: string, method: "GET" | "POST" = "GET", body?: Record<string, string>): Promise<any> {
  if (!qbitCookie) await qbitLogin();
  const opts: RequestInit = { method, headers: { Cookie: qbitCookie! } };
  if (body) { (opts.headers as Record<string, string>)["Content-Type"] = "application/x-www-form-urlencoded"; opts.body = new URLSearchParams(body); }
  let res = await fetch(`${QBIT_URL}/api/v2/${endpoint}`, opts);
  if (res.status === 403) { await qbitLogin(); opts.headers = { Cookie: qbitCookie! }; if (body) (opts.headers as Record<string, string>)["Content-Type"] = "application/x-www-form-urlencoded"; res = await fetch(`${QBIT_URL}/api/v2/${endpoint}`, opts); }
  if (!res.ok) throw new Error(`qBit ${res.status}: ${await res.text()}`);
  const ct = res.headers.get("content-type");
  return ct?.includes("json") ? res.json() : res.text();
}
