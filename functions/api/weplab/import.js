/* Receives normalized roulette rows from the desktop collector and stores them
   in Supabase. Runs on Cloudflare Pages Functions at /api/weplab/import.

   Required environment variables (Cloudflare Pages > Settings > Variables):
     SUPABASE_URL              https://<project>.supabase.co
     SUPABASE_SERVICE_ROLE_KEY service_role key, keep secret, never in client code
     DOOMI_BRIDGE_TOKEN        same value as token in doomi-site-bridge.json

   Dedup key is event_uid + stage stored as source_event_id. Existing rows are
   never overwritten, so a record already marked done stays done. */

const MAX_ITEMS = 500;
const MAX_BODY_BYTES = 1024 * 1024;

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return json(405, { error: "POST만 지원합니다." }, { Allow: "POST" });
  }

  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DOOMI_BRIDGE_TOKEN"]
    .filter((name) => !String(env[name] || "").trim());
  if (missing.length) {
    return json(503, { error: "서버 환경 변수가 설정되지 않았습니다: " + missing.join(", ") });
  }

  if (!authorized(request, env.DOOMI_BRIDGE_TOKEN)) {
    return json(401, { error: "토큰이 올바르지 않습니다." });
  }

  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) {
    return json(413, { error: "요청 본문이 너무 큽니다." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "JSON 형식이 올바르지 않습니다." });
  }

  if (!body || !Array.isArray(body.items) || body.items.length < 1) {
    return json(400, { error: "items 배열에 가져올 기록을 넣어 주세요." });
  }
  if (body.items.length > MAX_ITEMS) {
    return json(400, { error: `한 번에 최대 ${MAX_ITEMS}개까지 보낼 수 있습니다.` });
  }

  let rows;
  try {
    rows = body.items.map(normalizeRow);
  } catch (error) {
    return json(400, { error: error.message });
  }

  const unique = new Map();
  for (const row of rows) unique.set(row.source_event_id, row);
  const payload = [...unique.values()];
  const duplicatesInBatch = rows.length - payload.length;

  const base = String(env.SUPABASE_URL).trim().replace(/\/+$/, "");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY).trim();
  const response = await fetch(
    `${base}/rest/v1/debts?on_conflict=source_event_id`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=representation",
      },
      body: JSON.stringify(payload),
    },
  );

  const text = await response.text();
  if (!response.ok) {
    // 4xx from PostgREST means the same rows will fail again; let the desktop
    // collector quarantine them instead of retrying forever.
    const status = response.status >= 400 && response.status < 500 ? 400 : 502;
    return json(status, { error: "Supabase 저장 실패", detail: text.slice(0, 500) });
  }

  let inserted = [];
  try {
    inserted = JSON.parse(text);
  } catch {
    inserted = [];
  }

  return json(200, {
    imported: inserted.length,
    skipped: payload.length - inserted.length + duplicatesInBatch,
    lastSync: new Date().toISOString(),
  });
}

function authorized(request, expected) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return constantTimeEqual(match[1].trim(), String(expected).trim());
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normalizeRow(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${index + 1}번째 기록이 객체가 아닙니다.`);
  }

  const eventUid = requiredText(value.event_uid, "event_uid", 180, index);
  const item = requiredText(value.item, "item", 1000, index);
  const stage = Number(value.stage ?? 0);
  if (!Number.isInteger(stage) || stage < 0 || stage > 10000) {
    throw new Error(`${index + 1}번째 기록의 stage가 올바르지 않습니다.`);
  }

  const viewerId = optionalText(value.viewer_id, 80);
  const viewerName = optionalText(value.viewer_name, 80);
  const occurredAt = normalizeDate(value.occurred_at) || new Date().toISOString();
  const status = value.status === "done" ? "done" : "active";

  return {
    nickname: viewerName || viewerId || "익명",
    soop_id: viewerId || "unknown",
    description: item,
    status,
    source: "weplab",
    category: "roulette",
    source_event_id: `${eventUid}:${stage}`,
    created_at: occurredAt,
    completed_at: status === "done" ? occurredAt : null,
  };
}

function requiredText(value, label, max, index) {
  const text = String(value == null ? "" : value).trim();
  if (!text) throw new Error(`${index + 1}번째 기록에 ${label}이(가) 없습니다.`);
  return text.slice(0, max);
}

function optionalText(value, max) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
