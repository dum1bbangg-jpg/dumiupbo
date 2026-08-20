(function () {
  "use strict";

  var MAX_ROWS = 5000;

  /* Change this list together with debts_category_check in supabase.sql.
     The roulette import API writes 'roulette'. */
  var CATEGORIES = [
    { value: "roulette", label: "룰렛 벌칙" },
    { value: "promise", label: "약속" },
    { value: "event", label: "이벤트" }
  ];
  var CATEGORY_VALUES = CATEGORIES.map(function (item) { return item.value; });
  var DEFAULT_CATEGORY = "roulette";

  function categoryLabel(value) {
    var found = CATEGORIES.filter(function (item) { return item.value === value; })[0];
    return found ? found.label : CATEGORIES[0].label;
  }

  function safeCategory(value) {
    return CATEGORY_VALUES.indexOf(value) >= 0 ? value : DEFAULT_CATEGORY;
  }

  var config = window.DOOMI_CONFIG || {};
  var url = String(config.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  var anonKey = String(config.SUPABASE_ANON_KEY || "").trim();
  var sdkReady = Boolean(window.supabase && typeof window.supabase.createClient === "function");
  var configured = Boolean(url && anonKey && sdkReady);
  var client = null;

  if (configured) {
    client = window.supabase.createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: "doomi-admin-auth"
      }
    });
  }

  function setupMessage() {
    if (!sdkReady) return "Supabase 라이브러리를 불러오지 못했어요. 네트워크 연결을 확인해 주세요.";
    return "config.js에 Supabase 주소와 anon 키를 넣어야 기록이 표시돼요.";
  }

  function notConfigured() {
    var error = new Error(setupMessage());
    error.code = "not-configured";
    return error;
  }

  function friendlyError(error, fallback) {
    if (!error) return new Error(fallback);
    var code = String(error.code || "");
    if (code === "42501" || error.status === 401 || error.status === 403) {
      return new Error("권한이 없어요. 관리자로 다시 로그인해 주세요.");
    }
    if (code === "42P01") {
      return new Error("debts 테이블이 없어요. supabase.sql을 먼저 실행해 주세요.");
    }
    if (code === "23505") {
      var duplicate = new Error("이미 등록된 기록이에요.");
      duplicate.duplicate = true;
      return duplicate;
    }
    return new Error(error.message || fallback);
  }

  function fromRow(row) {
    if (!row || typeof row !== "object") return null;
    return {
      id: row.id,
      nickname: String(row.nickname || ""),
      soopId: String(row.soop_id || ""),
      description: String(row.description || ""),
      status: row.status === "done" ? "done" : "active",
      source: row.source === "weplab" ? "weplab" : "manual",
      category: safeCategory(row.category),
      createdAt: row.created_at,
      completedAt: row.completed_at || null
    };
  }

  function requiredText(value, label, max) {
    var text = String(value == null ? "" : value).trim();
    if (!text) throw new Error(label + "을(를) 입력해 주세요.");
    if (text.length > max) throw new Error(label + "은(는) " + max + "자까지 입력할 수 있어요.");
    return text;
  }

  async function listRecords() {
    if (!configured) throw notConfigured();
    var result = await client
      .from("debts")
      .select("id,nickname,soop_id,description,status,source,category,created_at,completed_at")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(MAX_ROWS);
    if (result.error) throw friendlyError(result.error, "기록을 불러오지 못했어요.");
    return (result.data || []).map(fromRow).filter(Boolean);
  }

  async function createRecord(input) {
    if (!configured) throw notConfigured();
    var payload = {
      nickname: requiredText(input.nickname, "닉네임", 80),
      soop_id: requiredText(input.soopId, "SOOP ID", 80),
      description: requiredText(input.description, "업보 내용", 1000),
      status: input.status === "done" ? "done" : "active",
      category: safeCategory(input.category),
      source: input.source === "weplab" ? "weplab" : "manual"
    };
    if (input.createdAt) payload.created_at = input.createdAt;
    /* Lets the roulette connector rely on the unique index instead of the
       browser tab's memory, so a refresh cannot re-insert the same spin. */
    if (input.sourceEventId) payload.source_event_id = String(input.sourceEventId).slice(0, 180);
    var result = await client.from("debts").insert(payload).select().single();
    if (result.error) throw friendlyError(result.error, "업보를 저장하지 못했어요.");
    return fromRow(result.data);
  }

  async function createRecords(inputs) {
    if (!configured) throw notConfigured();
    var now = new Date().toISOString();
    var payload = inputs.map(function (input) {
      var row = {
        nickname: requiredText(input.nickname, "닉네임", 80),
        soop_id: requiredText(input.soopId, "SOOP ID", 80),
        description: requiredText(input.description, "업보 내용", 1000),
        status: input.status === "done" ? "done" : "active",
        category: safeCategory(input.category),
        source: "manual"
      };
      /* Backfilled rows keep their original date; without this every imported
         record would land on today and the calendar and stats would be wrong.
         Every row must carry the same keys: in a bulk insert a key missing from
         one object arrives as null and trips the not-null constraint. */
      row.created_at = input.createdAt || now;
      return row;
    });
    var result = await client.from("debts").insert(payload).select();
    if (result.error) throw friendlyError(result.error, "업보를 저장하지 못했어요.");
    return (result.data || []).map(fromRow).filter(Boolean);
  }

  async function updateRecord(id, patch) {
    if (!configured) throw notConfigured();
    var payload = {};
    if (Object.prototype.hasOwnProperty.call(patch, "nickname")) {
      payload.nickname = requiredText(patch.nickname, "닉네임", 80);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "soopId")) {
      payload.soop_id = requiredText(patch.soopId, "SOOP ID", 80);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "description")) {
      payload.description = requiredText(patch.description, "업보 내용", 1000);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "status")) {
      payload.status = patch.status === "done" ? "done" : "active";
    }
    if (Object.prototype.hasOwnProperty.call(patch, "category")) {
      payload.category = safeCategory(patch.category);
    }
    if (!Object.keys(payload).length) throw new Error("바꿀 내용이 없어요.");

    var result = await client.from("debts").update(payload).eq("id", id).select().single();
    if (result.error) throw friendlyError(result.error, "기록을 수정하지 못했어요.");
    return fromRow(result.data);
  }

  function updateRecordStatus(id, status) {
    return updateRecord(id, { status: status });
  }

  async function deleteRecord(id) {
    if (!configured) throw notConfigured();
    var result = await client.from("debts").delete().eq("id", id).select("id");
    if (result.error) throw friendlyError(result.error, "기록을 삭제하지 못했어요.");
    if (!result.data || !result.data.length) throw new Error("삭제할 기록을 찾지 못했어요.");
    return true;
  }

  /* site_settings has no anon policy, so these only work while logged in. */
  async function getSetting(key) {
    if (!configured) throw notConfigured();
    var result = await client.from("site_settings").select("value").eq("key", key).maybeSingle();
    if (result.error) throw friendlyError(result.error, "설정을 불러오지 못했어요.");
    return result.data ? result.data.value : null;
  }

  async function saveSetting(key, value) {
    if (!configured) throw notConfigured();
    var result = await client.from("site_settings")
      .upsert({ key: key, value: value, updated_at: new Date().toISOString() }, { onConflict: "key" })
      .select().single();
    if (result.error) throw friendlyError(result.error, "설정을 저장하지 못했어요.");
    return result.data.value;
  }

  async function getSession() {
    if (!configured) return null;
    var result = await client.auth.getSession();
    if (result.error) return null;
    return result.data ? result.data.session : null;
  }

  async function signIn(email, password) {
    if (!configured) throw notConfigured();
    var result = await client.auth.signInWithPassword({
      email: String(email || "").trim(),
      password: String(password || "")
    });
    if (result.error) {
      var message = /invalid login/i.test(result.error.message || "")
        ? "이메일 또는 비밀번호가 맞지 않아요."
        : result.error.message;
      throw new Error(message);
    }
    return result.data.session;
  }

  async function signOut() {
    if (!configured) return;
    await client.auth.signOut();
  }

  function onAuthChange(handler) {
    if (!configured) return function () {};
    var result = client.auth.onAuthStateChange(function (_event, session) { handler(session); });
    return function () {
      if (result && result.data && result.data.subscription) result.data.subscription.unsubscribe();
    };
  }

  /* SOOP serves profile pictures at LOGO/<first two chars>/<id>/<id>.jpg */
  function soopAvatarUrl(soopId) {
    var id = String(soopId == null ? "" : soopId).trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,}$/.test(id)) return "";
    return "https://profile.img.sooplive.co.kr/LOGO/" + id.slice(0, 2) + "/" + id + "/" + id + ".jpg";
  }

  /* Accepts 2026-08-18, 2026.08.18, 2026/08/18, optionally with HH:MM.
     Bare dates are read as Seoul time so a backfilled day lands on that day. */
  function parseInputDate(text) {
    var raw = String(text == null ? "" : text).trim();
    if (!raw) return null;
    var match = raw.match(/^(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var hour = match[4] === undefined ? 12 : Number(match[4]);
    var minute = match[5] === undefined ? 0 : Number(match[5]);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

    var iso = year + "-" + pad(month) + "-" + pad(day) + "T" + pad(hour) + ":" + pad(minute) + ":00+09:00";
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    /* Reject rolled-over dates such as 2026-02-31. */
    if (dateKey(date) !== year + "-" + pad(month) + "-" + pad(day)) return null;
    return date.toISOString();
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  /* YYYY-MM-DD HH:MM in Seoul time, for CSV that can be pasted back in. */
  function formatStamp(value) {
    if (!value) return "";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    var parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(date).reduce(function (acc, part) { acc[part.type] = part.value; return acc; }, {});
    return parts.year + "-" + parts.month + "-" + parts.day + " " + parts.hour + ":" + parts.minute;
  }

  function dateKey(value) {
    var date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(date);
    } catch (_error) {
      return date.toISOString().slice(0, 10);
    }
  }

  function statsFor(records) {
    var today = dateKey(new Date());
    return records.reduce(function (stats, record) {
      stats.total += 1;
      stats[record.status === "done" ? "done" : "active"] += 1;
      if (dateKey(record.createdAt) === today) stats.today += 1;
      return stats;
    }, { total: 0, active: 0, done: 0, today: 0 });
  }

  function formatShortDate(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || "");
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "2-digit",
      day: "2-digit"
    }).format(date).replace(/\. /g, ".").replace(/\.$/, "");
  }

  function formatLongDate(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || "");
    return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "long" }).format(date);
  }

  function formatDateTime(value) {
    if (!value) return "아직 없음";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  window.DoomiData = {
    isConfigured: function () { return configured; },
    setupMessage: setupMessage,
    listRecords: listRecords,
    createRecord: createRecord,
    createRecords: createRecords,
    updateRecord: updateRecord,
    updateRecordStatus: updateRecordStatus,
    deleteRecord: deleteRecord,
    getSetting: getSetting,
    saveSetting: saveSetting,
    getSession: getSession,
    signIn: signIn,
    signOut: signOut,
    onAuthChange: onAuthChange,
    statsFor: statsFor,
    categories: CATEGORIES,
    categoryLabel: categoryLabel,
    safeCategory: safeCategory,
    dateKey: dateKey,
    parseInputDate: parseInputDate,
    formatStamp: formatStamp,
    soopAvatarUrl: soopAvatarUrl,
    soopId: String(config.SOOP_ID || "").trim(),
    formatShortDate: formatShortDate,
    formatLongDate: formatLongDate,
    formatDateTime: formatDateTime
  };
})();
