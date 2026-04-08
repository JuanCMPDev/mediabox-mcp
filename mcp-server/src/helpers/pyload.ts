import { PYLOAD_URL } from "../config.js";

let pyloadCookie: string | null = null;
let pyloadCsrf: string | null = null;

async function pyloadLogin() {
  const res = await fetch(`${PYLOAD_URL}/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ do: "login", username: "pyload", password: "pyload" }), redirect: "manual" });
  pyloadCookie = res.headers.get("set-cookie")?.split(";")[0] || null;
  if (!pyloadCookie) throw new Error("PyLoad login failed");
  const dash = await fetch(`${PYLOAD_URL}/dashboard`, { headers: { Cookie: pyloadCookie } });
  const html = await dash.text();
  pyloadCsrf = html.match(/csrf-token" content="([^"]+)"/)?.[1] || null;
}

export async function pyloadApi(endpoint: string, method: "GET" | "POST" = "GET", body?: Record<string, string>): Promise<any> {
  if (!pyloadCookie) await pyloadLogin();
  const headers: Record<string, string> = { Cookie: pyloadCookie! };
  if (pyloadCsrf) headers["X-CSRFToken"] = pyloadCsrf;
  const opts: RequestInit = { method, headers };
  if (body) { headers["Content-Type"] = "application/x-www-form-urlencoded"; opts.body = new URLSearchParams(body); }
  let res = await fetch(`${PYLOAD_URL}/api/${endpoint}`, opts);
  if (res.status === 401 || res.status === 403) { await pyloadLogin(); headers.Cookie = pyloadCookie!; if (pyloadCsrf) headers["X-CSRFToken"] = pyloadCsrf; res = await fetch(`${PYLOAD_URL}/api/${endpoint}`, { ...opts, headers }); }
  if (!res.ok) throw new Error(`PyLoad ${res.status}: ${await res.text()}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
