(function () {
  "use strict";

  /* Pulls past WefLab records for a chosen period.

     WefLab has no public API, so instead of guessing one this takes a request
     the admin copied out of their own browser while doing a period search,
     finds the dates inside it, swaps in the wanted period and replays it.
     Whatever comes back is shown raw so the admin can point at the list and
     say which field is which. */

  var SETTING_KEY = "weflab-history";

  var el = {};
  var parsedRequest = null;
  var dateSlots = [];
  var lastResponse = null;
  var rows = [];
  var fieldNames = [];

  var settings = { curl: "", fromSlot: 0, toSlot: 1, listPath: "", map: {} };

  var TARGETS = [
    { key: "nickname", label: "닉네임", guess: /nick|name|user_?name|sender|donator|닉/i },
    { key: "soopId", label: "SOOP 아이디", guess: /(^|_)id$|user_?id|login|uid|아이디/i },
    { key: "description", label: "업보 내용", guess: /item|result|reward|prize|roulette|content|message|당첨|내용/i },
    { key: "createdAt", label: "날짜", guess: /date|time|created|reg|일시|날짜/i },
    { key: "eventId", label: "중복 방지 키", guess: /event|uid|uuid|seq|no$|key|번호/i }
  ];

  window.DoomiWeflabHistory = { init: init };

  function init() {
    [
      "wh-curl", "wh-parse", "wh-parsed", "wh-slots", "wh-from", "wh-to",
      "wh-run", "wh-note", "wh-raw", "wh-list-path", "wh-rows", "wh-fields",
      "wh-import", "wh-save", "wh-result"
    ].forEach(function (id) { el[camel(id)] = document.getElementById(id); });

    el.whParse.addEventListener("click", parseCurl);
    el.whRun.addEventListener("click", run);
    el.whImport.addEventListener("click", importRows);
    el.whSave.addEventListener("click", saveSettings);
    el.whListPath.addEventListener("change", function () {
      settings.listPath = el.whListPath.value;
      extractRows();
    });

    var today = new Date();
    el.whTo.value = isoDay(today);
    el.whFrom.value = isoDay(new Date(today.getTime() - 29 * 86400000));

    loadSettings();
  }

  function camel(id) { return id.replace(/-([a-z])/g, function (_a, c) { return c.toUpperCase(); }); }
  function isoDay(date) { return window.DoomiData.dateKey(date); }

  async function loadSettings() {
    try {
      var stored = await window.DoomiData.getSetting(SETTING_KEY);
      if (stored) settings = Object.assign(settings, stored);
    } catch (_error) { /* nothing saved yet */ }
    if (settings.curl) {
      el.whCurl.value = settings.curl;
      parseCurl(true);
    }
  }

  async function saveSettings() {
    settings.curl = el.whCurl.value.trim();
    settings.fromSlot = Number(el.whFromSlotValue || settings.fromSlot) || 0;
    settings.listPath = el.whListPath.value || settings.listPath;
    TARGETS.forEach(function (t) {
      var select = document.getElementById("wh-map-" + t.key);
      if (select) settings.map[t.key] = select.value;
    });
    try {
      await window.DoomiData.saveSetting(SETTING_KEY, settings);
      note("저장했어요. 다음에 열면 그대로 씁니다.", false);
    } catch (error) {
      note(error instanceof Error ? error.message : "저장하지 못했어요.", true);
    }
  }

  function note(message, isError) {
    el.whNote.textContent = message || "";
    el.whNote.classList.toggle("error", Boolean(isError));
  }

  /* ---------- cURL ---------- */

  /* Handles the shape browsers produce: quoted url, repeated -H, --data-raw. */
  function parseCurl(quiet) {
    var text = el.whCurl.value.trim();
    if (!text) { note("복사한 요청을 붙여 넣어 주세요.", true); return; }

    var tokens = text.match(/'[^']*'|"(?:\\.|[^"])*"|\S+/g) || [];
    var request = { method: "", url: "", headers: {}, body: null };

    for (var i = 0; i < tokens.length; i += 1) {
      var token = unquote(tokens[i]);
      if (token === "curl") continue;
      if (token === "-X" || token === "--request") { request.method = unquote(tokens[++i] || "GET"); continue; }
      if (token === "-H" || token === "--header") {
        var header = unquote(tokens[++i] || "");
        var split = header.indexOf(":");
        if (split > 0) request.headers[header.slice(0, split).trim()] = header.slice(split + 1).trim();
        continue;
      }
      if (token === "-b" || token === "--cookie") { request.headers.Cookie = unquote(tokens[++i] || ""); continue; }
      if (/^(--data(-raw|-binary|-urlencode)?|-d)$/.test(token)) {
        request.body = unquote(tokens[++i] || "");
        continue;
      }
      if (/^--compressed|--location|-L|-s|--silent|-i|--insecure|-k$/.test(token)) continue;
      if (/^https?:\/\//.test(token) && !request.url) request.url = token;
    }

    if (!request.url) { note("요청에서 주소를 찾지 못했어요. curl 전체를 붙여 넣었는지 확인해 주세요.", true); return; }
    if (!request.method) request.method = request.body ? "POST" : "GET";

    parsedRequest = request;
    findDateSlots();
    renderParsed();
    if (!quiet) {
      note(dateSlots.length
        ? "요청을 읽었어요. 날짜로 보이는 자리를 " + dateSlots.length + "개 찾았습니다."
        : "요청은 읽었는데 날짜 자리를 못 찾았어요. 기간 검색을 한 번 하고 그 요청을 복사해 주세요.",
        !dateSlots.length);
    }
  }

  function unquote(token) {
    if (!token) return "";
    if ((token[0] === "'" && token.slice(-1) === "'") || (token[0] === '"' && token.slice(-1) === '"')) {
      return token.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    return token;
  }

  /* Finds every date-looking run in the url and body so one can be marked as
     the start of the period and another as the end. */
  function findDateSlots() {
    dateSlots = [];
    var pattern = /\d{4}-\d{2}-\d{2}|\d{4}\/\d{2}\/\d{2}|\d{4}\.\d{2}\.\d{2}|\b\d{8}\b/g;
    ["url", "body"].forEach(function (part) {
      var value = parsedRequest[part];
      if (!value) return;
      var match;
      while ((match = pattern.exec(value)) !== null) {
        dateSlots.push({ part: part, index: match.index, value: match[0] });
      }
    });
  }

  function renderParsed() {
    el.whParsed.hidden = false;
    el.whParsed.replaceChildren();

    var line = document.createElement("p");
    line.className = "wh-line";
    line.textContent = parsedRequest.method + "  " + shorten(parsedRequest.url, 90);
    var meta = document.createElement("small");
    meta.textContent = "헤더 " + Object.keys(parsedRequest.headers).length + "개"
      + (parsedRequest.body ? " · 본문 있음" : "");
    el.whParsed.append(line, meta);

    el.whSlots.replaceChildren();
    if (!dateSlots.length) {
      el.whSlots.hidden = true;
      return;
    }
    el.whSlots.hidden = false;

    [["시작일 자리", "fromSlot"], ["종료일 자리", "toSlot"]].forEach(function (pair, order) {
      var wrap = document.createElement("label");
      wrap.className = "wf-field";
      var name = document.createElement("span");
      name.textContent = pair[0];
      var select = document.createElement("select");
      select.id = "wh-slot-" + pair[1];
      dateSlots.forEach(function (slot, index) {
        var option = document.createElement("option");
        option.value = String(index);
        option.textContent = (slot.part === "url" ? "주소" : "본문") + " · " + slot.value;
        select.appendChild(option);
      });
      var stored = settings[pair[1]];
      select.value = String(stored !== undefined && stored < dateSlots.length ? stored : Math.min(order, dateSlots.length - 1));
      select.addEventListener("change", function () { settings[pair[1]] = Number(select.value); });
      settings[pair[1]] = Number(select.value);
      wrap.append(name, select);
      el.whSlots.appendChild(wrap);
    });
  }

  function shorten(text, max) {
    return text.length > max ? text.slice(0, max) + "…" : text;
  }

  /* ---------- run ---------- */

  function withDates() {
    var request = {
      method: parsedRequest.method,
      url: parsedRequest.url,
      headers: parsedRequest.headers,
      body: parsedRequest.body
    };
    if (!dateSlots.length) return request;

    var wanted = {};
    wanted[settings.fromSlot] = el.whFrom.value;
    wanted[settings.toSlot] = el.whTo.value;

    /* Replace from the end so earlier offsets stay valid. */
    var ordered = dateSlots.map(function (slot, index) { return { slot: slot, index: index }; })
      .filter(function (entry) { return wanted[entry.index]; })
      .sort(function (a, b) { return b.slot.index - a.slot.index; });

    ordered.forEach(function (entry) {
      var slot = entry.slot;
      var replacement = matchShape(slot.value, wanted[entry.index]);
      var target = request[slot.part];
      request[slot.part] = target.slice(0, slot.index) + replacement
        + target.slice(slot.index + slot.value.length);
    });
    return request;
  }

  /* Keeps whatever separator style the original used. */
  function matchShape(sample, isoDate) {
    var parts = isoDate.split("-");
    if (/^\d{8}$/.test(sample)) return parts.join("");
    if (sample.indexOf("/") >= 0) return parts.join("/");
    if (sample.indexOf(".") >= 0) return parts.join(".");
    return parts.join("-");
  }

  async function run() {
    if (!parsedRequest) { note("먼저 요청을 읽어 주세요.", true); return; }
    if (!el.whFrom.value || !el.whTo.value) { note("기간을 정해 주세요.", true); return; }
    if (el.whFrom.value > el.whTo.value) { note("시작일이 종료일보다 늦어요.", true); return; }

    el.whRun.disabled = true;
    note("위플랩에서 가져오는 중이에요.", false);
    try {
      var response = await fetch("/api/weflab/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withDates())
      });
      var payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "가져오지 못했어요.");

      lastResponse = payload;
      renderRaw(payload);
      if (payload.hint) { note(payload.hint, true); return; }
      if (!payload.json) { note("JSON이 아닌 응답이 왔어요. 아래 원본을 확인해 주세요.", true); return; }

      fillListPaths(payload.json);
      extractRows();
    } catch (error) {
      note(error instanceof Error ? error.message : "가져오지 못했어요.", true);
    } finally {
      el.whRun.disabled = false;
    }
  }

  function renderRaw(payload) {
    el.whRaw.replaceChildren();
    var block = document.createElement("details");
    var summary = document.createElement("summary");
    summary.textContent = "원본 응답 (HTTP " + payload.status + ")";
    var body = document.createElement("pre");
    body.textContent = payload.json
      ? JSON.stringify(payload.json, null, 2).slice(0, 6000)
      : (payload.text || "");
    block.append(summary, body);
    el.whRaw.appendChild(block);
  }

  /* Any array of objects in the response is a candidate record list. */
  function fillListPaths(value) {
    var paths = [];
    (function walk(node, path, depth) {
      if (depth > 4 || !node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        if (node.length && typeof node[0] === "object") paths.push({ path: path, count: node.length });
        return;
      }
      Object.keys(node).forEach(function (key) {
        walk(node[key], path ? path + "." + key : key, depth + 1);
      });
    })(value, "", 0);

    el.whListPath.replaceChildren();
    if (!paths.length) {
      var none = document.createElement("option");
      none.value = "";
      none.textContent = "— 목록을 못 찾음 —";
      el.whListPath.appendChild(none);
      return;
    }
    paths.sort(function (a, b) { return b.count - a.count; });
    paths.forEach(function (entry) {
      var option = document.createElement("option");
      option.value = entry.path;
      option.textContent = (entry.path || "(최상위)") + "  ·  " + entry.count + "건";
      el.whListPath.appendChild(option);
    });
    el.whListPath.value = settings.listPath && paths.some(function (p) { return p.path === settings.listPath; })
      ? settings.listPath : paths[0].path;
    settings.listPath = el.whListPath.value;
  }

  function extractRows() {
    rows = [];
    if (!lastResponse || !lastResponse.json) return;
    var node = lastResponse.json;
    if (settings.listPath) {
      settings.listPath.split(".").forEach(function (key) { node = node ? node[key] : null; });
    }
    /* map() would pass index and array into flattenRow's own parameters. */
    rows = Array.isArray(node) ? node.map(function (item) { return flattenRow(item); }) : [];
    fieldNames = rows.length ? Object.keys(rows[0]) : [];
    renderRows();
    renderFields();
    note(rows.length ? rows.length + "건을 찾았어요. 칸을 지정한 뒤 넣기를 누르세요."
                     : "이 목록에는 기록이 없어요.", !rows.length);
  }

  function flattenRow(value, prefix, out) {
    out = out || {}; prefix = prefix || "";
    if (!value || typeof value !== "object") return out;
    Object.keys(value).forEach(function (key) {
      var item = value[key];
      var path = prefix ? prefix + "." + key : key;
      if (item && typeof item === "object" && !Array.isArray(item)) flattenRow(item, path, out);
      else out[path] = item;
    });
    return out;
  }

  function renderRows() {
    el.whRows.replaceChildren();
    if (!rows.length) return;
    var table = document.createElement("table");
    var head = document.createElement("tr");
    fieldNames.slice(0, 6).forEach(function (name) {
      var th = document.createElement("th");
      th.textContent = name;
      head.appendChild(th);
    });
    table.appendChild(head);
    rows.slice(0, 5).forEach(function (row) {
      var tr = document.createElement("tr");
      fieldNames.slice(0, 6).forEach(function (name) {
        var td = document.createElement("td");
        td.textContent = String(row[name] === undefined ? "" : row[name]).slice(0, 40);
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    el.whRows.appendChild(table);
  }

  function renderFields() {
    el.whFields.replaceChildren();
    if (!fieldNames.length) return;
    TARGETS.forEach(function (target) {
      var wrap = document.createElement("label");
      wrap.className = "wf-field";
      var name = document.createElement("span");
      name.textContent = target.label;
      var select = document.createElement("select");
      select.id = "wh-map-" + target.key;
      var blank = document.createElement("option");
      blank.value = ""; blank.textContent = "— 사용 안 함 —";
      select.appendChild(blank);
      fieldNames.forEach(function (field) {
        var option = document.createElement("option");
        option.value = field;
        var sample = String(rows[0][field] === undefined ? "" : rows[0][field]);
        option.textContent = field + (sample && sample.length < 22 ? "  (" + sample + ")" : "");
        select.appendChild(option);
      });
      var chosen = settings.map[target.key];
      if (!chosen) chosen = fieldNames.filter(function (f) { return target.guess.test(f); })[0] || "";
      select.value = chosen;
      settings.map[target.key] = chosen;
      wrap.append(name, select);
      el.whFields.appendChild(wrap);
    });
  }

  /* ---------- import ---------- */

  async function importRows() {
    if (!rows.length) { note("가져온 기록이 없어요.", true); return; }
    TARGETS.forEach(function (t) {
      var select = document.getElementById("wh-map-" + t.key);
      if (select) settings.map[t.key] = select.value;
    });

    var prepared = [];
    var skipped = 0;
    rows.forEach(function (row) {
      var pick = function (key) {
        var field = settings.map[key];
        return field && row[field] !== undefined && row[field] !== null ? String(row[field]).trim() : "";
      };
      var description = pick("description");
      var nickname = pick("nickname");
      var soopId = pick("soopId");
      if (!description || (!nickname && !soopId)) { skipped += 1; return; }

      var when = pick("createdAt");
      var createdAt = when ? (window.DoomiData.parseInputDate(when) || isoOrNull(when)) : null;
      var eventId = pick("eventId");

      prepared.push({
        nickname: nickname || soopId,
        soopId: soopId || nickname,
        description: description,
        status: "active",
        category: "roulette",
        source: "weplab",
        createdAt: createdAt,
        sourceEventId: "weflab-h:" + (eventId || [soopId, description, when].join("|"))
      });
    });

    if (!prepared.length) { note("넣을 수 있는 줄이 없어요. 칸 지정을 확인해 주세요.", true); return; }

    el.whImport.disabled = true;
    var saved = 0, duplicates = 0, failed = 0;
    try {
      for (var i = 0; i < prepared.length; i += 1) {
        try {
          await window.DoomiData.createRecord(prepared[i]);
          saved += 1;
        } catch (error) {
          if (error && error.duplicate) duplicates += 1;
          else failed += 1;
        }
      }
      el.whResult.hidden = false;
      el.whResult.textContent = saved + "건 넣었어요"
        + (duplicates ? " · 이미 있던 " + duplicates + "건은 건너뜀" : "")
        + (skipped ? " · 칸이 비어 " + skipped + "건 제외" : "")
        + (failed ? " · " + failed + "건 실패" : "");
      note("완료했어요.", false);
      if (window.DoomiAdmin && window.DoomiAdmin.reload) window.DoomiAdmin.reload();
    } finally {
      el.whImport.disabled = false;
    }
  }

  function isoOrNull(text) {
    var date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
})();
