import { PYLOAD_URL, PYLOAD_USER, PYLOAD_PASS } from "../config.js";

let pyloadCookie: string | null = null;
let pyloadCsrf: string | null = null;

async function pyloadLogin() {
  // Step 1: GET login page to obtain session cookie + CSRF token
  const pageRes = await fetch(`${PYLOAD_URL}/login`);
  const pageCookie = pageRes.headers.get("set-cookie")?.split(";")[0] || null;
  const pageHtml = await pageRes.text();
  const csrf = pageHtml.match(/csrf-token" content="([^"]+)"/)?.[1] || "";

  // Step 2: POST login with CSRF token in the form body
  const res = await fetch(`${PYLOAD_URL}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(pageCookie ? { Cookie: pageCookie } : {}),
    },
    body: new URLSearchParams({
      do: "login",
      username: PYLOAD_USER,
      password: PYLOAD_PASS,
      _csrf_token: csrf,
    }),
    redirect: "manual",
  });

  pyloadCookie = res.headers.get("set-cookie")?.split(";")[0] || pageCookie;
  if (!pyloadCookie) throw new Error("PyLoad login failed");

  // Step 3: Get dashboard to extract fresh CSRF for API calls
  const dash = await fetch(`${PYLOAD_URL}/dashboard`, { headers: { Cookie: pyloadCookie } });
  const html = await dash.text();
  pyloadCsrf = html.match(/csrf-token" content="([^"]+)"/)?.[1] || null;
}

async function ensureAuth(): Promise<Record<string, string>> {
  if (!pyloadCookie) await pyloadLogin();
  const headers: Record<string, string> = { Cookie: pyloadCookie! };
  if (pyloadCsrf) headers["X-CSRFToken"] = pyloadCsrf;
  return headers;
}

export async function pyloadApiJson(endpoint: string, jsonBody: Record<string, any>): Promise<any> {
  let headers = await ensureAuth();
  headers["Content-Type"] = "application/json";
  let res = await fetch(`${PYLOAD_URL}/api/${endpoint}`, { method: "POST", headers, body: JSON.stringify(jsonBody) });
  if (res.status === 401 || res.status === 403) { await pyloadLogin(); headers = await ensureAuth(); headers["Content-Type"] = "application/json"; res = await fetch(`${PYLOAD_URL}/api/${endpoint}`, { method: "POST", headers, body: JSON.stringify(jsonBody) }); }
  if (!res.ok) throw new Error(`PyLoad ${res.status}: ${await res.text()}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

export async function pyloadApi(endpoint: string, method: "GET" | "POST" = "GET", body?: Record<string, string>): Promise<any> {
  let headers = await ensureAuth();
  const opts: RequestInit = { method, headers };
  if (body) { headers["Content-Type"] = "application/x-www-form-urlencoded"; opts.body = new URLSearchParams(body); }
  let res = await fetch(`${PYLOAD_URL}/api/${endpoint}`, opts);
  if (res.status === 401 || res.status === 403) { await pyloadLogin(); headers = await ensureAuth(); if (body) { headers["Content-Type"] = "application/x-www-form-urlencoded"; } res = await fetch(`${PYLOAD_URL}/api/${endpoint}`, { ...opts, headers }); }
  if (!res.ok) throw new Error(`PyLoad ${res.status}: ${await res.text()}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
