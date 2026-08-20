/* Replays a request the admin copied out of their own browser.

   WefLab keeps the past records behind a dashboard login, and a browser cannot
   call that dashboard from our origin. So the admin copies one working request
   ("Copy as cURL" in the network tab), the admin page swaps the dates in it, and
   this endpoint replays it server-side and hands back whatever came out.

   POST /api/weflab/fetch  { method, url, headers, body }
   -> { ok, status, contentType, json | text }

   The credentials inside that request never leave the admin's own database row;
   this function just forwards them once and returns the answer. */

const TIMEOUT_MS = 20000;
const MAX_BYTES = 4 * 1024 * 1024;

/* Hop-by-hop and fetch-controlled headers must not be forwarded verbatim. */
const DROP_HEADERS = new Set([
  "host", "content-length", "connection", "keep-alive", "transfer-encoding",
  "upgrade", "proxy-authorization", "proxy-connection", "te", "trailer",
  "accept-encoding",
]);

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== "POST") {
    return json(405, { error: "POST만 지원합니다." }, { Allow: "POST" });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "JSON 형식이 올바르지 않습니다." });
  }

  let target;
  try {
    target = new URL(String(payload.url || "").trim());
  } catch {
    return json(400, { error: "주소 형식이 올바르지 않습니다." });
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return json(400, { error: "http 또는 https 주소여야 합니다." });
  }

  const method = String(payload.method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH"].includes(method)) {
    return json(400, { error: "지원하지 않는 방식입니다." });
  }

  const headers = new Headers();
  const source = payload.headers && typeof payload.headers === "object" ? payload.headers : {};
  for (const [name, value] of Object.entries(source)) {
    if (DROP_HEADERS.has(String(name).toLowerCase())) continue;
    try {
      headers.set(name, String(value));
    } catch {
      /* skip header names fetch refuses */
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(target.toString(), {
      method,
      headers,
      body: method === "GET" ? undefined : (payload.body ?? null),
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    return json(502, { error: "위플랩에 요청하지 못했습니다: " + error.message });
  }
  clearTimeout(timer);

  const contentType = response.headers.get("content-type") || "";
  let text;
  try {
    text = (await response.text()).slice(0, MAX_BYTES);
  } catch (error) {
    return json(502, { error: "응답을 읽지 못했습니다: " + error.message });
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  /* A login page coming back as HTML is the usual failure, so name it. */
  const looksLikeLogin = !parsed && /login|로그인|sign\s*in/i.test(text.slice(0, 2000));

  return json(200, {
    ok: response.ok,
    status: response.status,
    contentType,
    json: parsed,
    text: parsed ? null : text.slice(0, 4000),
    hint: !response.ok
      ? "위플랩이 " + response.status + " 로 거절했습니다. 로그인이 만료됐을 수 있어요."
      : looksLikeLogin
        ? "로그인 화면이 돌아왔습니다. 위플랩에 다시 로그인한 뒤 요청을 새로 복사해 주세요."
        : "",
  });
}

function json(status, payload, extraHeaders) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(extraHeaders || {}),
    },
  });
}
