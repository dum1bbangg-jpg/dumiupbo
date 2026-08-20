/* Looks at a WefLab alert URL from the server and reports how to listen to it.

   The alert URL is an HTML page meant for an OBS browser source; the live
   events arrive over a socket that the page's own script opens. The browser
   cannot read that page (different origin), but a Pages Function can, so this
   endpoint fetches it and reports the socket endpoints it can find.

   POST /api/weflab/probe   { "url": "https://..." }
   -> { ok, candidates: [...], hints: {...} }

   Nothing is stored here. The admin page decides what to connect to. */

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SCRIPTS = 8;
const TIMEOUT_MS = 10000;

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== "POST") {
    return json(405, { error: "POST만 지원합니다." }, { Allow: "POST" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "JSON 형식이 올바르지 않습니다." });
  }

  let target;
  try {
    target = new URL(String(body.url || "").trim());
  } catch {
    return json(400, { error: "주소 형식이 올바르지 않습니다. https:// 로 시작해야 합니다." });
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return json(400, { error: "http 또는 https 주소여야 합니다." });
  }

  let page;
  try {
    page = await fetchText(target.toString());
  } catch (error) {
    return json(502, { error: "알림 주소를 열지 못했습니다: " + error.message });
  }

  const found = new Map();
  collect(found, page.text, target, "알림 페이지");

  /* The socket address usually lives in a bundled script, not the page itself. */
  const scripts = scriptUrls(page.text, target).slice(0, MAX_SCRIPTS);
  for (const scriptUrl of scripts) {
    try {
      const script = await fetchText(scriptUrl);
      collect(found, script.text, target, shortName(scriptUrl));
    } catch {
      /* one unreadable bundle should not fail the whole probe */
    }
  }

  const candidates = [...found.values()].sort((a, b) => b.score - a.score);

  return json(200, {
    ok: true,
    finalUrl: page.finalUrl,
    scanned: 1 + scripts.length,
    socketIo: /socket\.io/i.test(page.text) || scripts.some((u) => /socket\.io/i.test(u)),
    candidates: candidates.slice(0, 12),
    hints: {
      token: guessToken(target),
      note: candidates.length
        ? "가장 위 후보부터 연결해 보세요."
        : "소켓 주소를 못 찾았습니다. 알림 주소가 맞는지 확인해 주세요.",
    },
  });
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        /* Alert pages are built for OBS; a normal browser UA gets the same page. */
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "*/*",
      },
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) break;
      chunks.push(value);
    }
    const merged = new Uint8Array(size > MAX_BYTES ? MAX_BYTES : size);
    let offset = 0;
    for (const chunk of chunks) {
      if (offset + chunk.length > merged.length) break;
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return { text: new TextDecoder().decode(merged), finalUrl: response.url };
  } finally {
    clearTimeout(timer);
  }
}

function scriptUrls(html, base) {
  const urls = [];
  const pattern = /<script[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    try {
      urls.push(new URL(match[1], base).toString());
    } catch {
      /* skip malformed src */
    }
  }
  return urls;
}

/* Pull anything that looks like a socket endpoint out of a blob of code. */
function collect(found, text, base, source) {
  const add = (raw, score) => {
    let value = raw.replace(/["'`\\]/g, "").trim();
    if (!value || value.length > 400) return;
    try {
      const url = new URL(value, base);
      if (!/^wss?:|^https?:/.test(url.protocol)) return;
      value = url.toString();
    } catch {
      return;
    }
    const existing = found.get(value);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    found.set(value, { url: value, score, sources: [source] });
  };

  for (const match of text.matchAll(/wss?:\/\/[^\s"'`<>()]+/gi)) add(match[0], 100);
  for (const match of text.matchAll(/["'`](\/socket\.io[^\s"'`<>]*)["'`]/gi)) add(match[1], 80);
  for (const match of text.matchAll(/io\(\s*["'`]([^"'`]+)["'`]/gi)) add(match[1], 90);
  for (const match of text.matchAll(/new\s+WebSocket\(\s*["'`]([^"'`]+)["'`]/gi)) add(match[1], 100);
  for (const match of text.matchAll(/new\s+EventSource\(\s*["'`]([^"'`]+)["'`]/gi)) add(match[1], 70);
}

function guessToken(target) {
  const segments = target.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  if (/^[A-Za-z0-9_-]{12,}$/.test(last)) return last;
  for (const [, value] of target.searchParams) {
    if (/^[A-Za-z0-9_-]{12,}$/.test(value)) return value;
  }
  return "";
}

function shortName(url) {
  try {
    const parts = new URL(url).pathname.split("/");
    return parts[parts.length - 1] || url;
  } catch {
    return url;
  }
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
