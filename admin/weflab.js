(function () {
  "use strict";

  /* WefLab connector.

     The exact message shape of a WefLab alert socket is not documented, so this
     does not assume one. It connects, shows whatever arrives verbatim, lists the
     fields it found, and lets the admin say which field is the nickname, the id
     and the roulette result. The mapping is stored in site_settings, which only
     authenticated users can read - the alert URL is a secret. */

  var SETTING_KEY = "weflab";
  var RECENT_LIMIT = 12;
  var RECONNECT_MS = 4000;

  var el = {};
  var socket = null;
  var manualClose = false;
  var reconnectTimer = null;
  var recent = [];
  var lastSample = null;
  var fieldNames = [];
  var seen = new Set();

  var settings = {
    url: "",
    socketUrl: "",
    autoSave: false,
    map: { nickname: "", soopId: "", description: "", eventId: "" }
  };

  var TARGETS = [
    { key: "nickname", label: "닉네임", guess: /nick|name|user_?name|sender|donator|from|아이디|닉/i },
    { key: "soopId", label: "SOOP 아이디", guess: /(^|_)id$|user_?id|login|uid|아이디/i },
    { key: "description", label: "업보 내용", guess: /item|result|reward|prize|roulette|content|message|msg|당첨|내용/i },
    { key: "eventId", label: "중복 방지 키 (선택)", guess: /event|uid|uuid|seq|no$|key/i }
  ];

  window.DoomiWeflab = { init: init };

  function init() {
    [
      "wf-url", "wf-probe", "wf-connect", "wf-disconnect", "wf-state", "wf-note",
      "wf-candidates", "wf-log", "wf-fields", "wf-auto", "wf-save", "wf-saved-count",
      "wf-test", "wf-clear-log"
    ].forEach(function (id) { el[camel(id)] = document.getElementById(id); });

    el.wfProbe.addEventListener("click", probe);
    el.wfConnect.addEventListener("click", function () { connect(el.wfUrl.value.trim()); });
    el.wfDisconnect.addEventListener("click", disconnect);
    el.wfSave.addEventListener("click", saveSettings);
    el.wfTest.addEventListener("click", sendTestEvent);
    el.wfClearLog.addEventListener("click", function () {
      recent = [];
      renderLog();
    });
    el.wfAuto.addEventListener("change", function () { settings.autoSave = el.wfAuto.checked; });

    loadSettings();
  }

  function camel(id) {
    return id.replace(/-([a-z])/g, function (_all, c) { return c.toUpperCase(); });
  }

  /* ---------- settings ---------- */

  async function loadSettings() {
    try {
      var stored = await window.DoomiData.getSetting(SETTING_KEY);
      if (stored) {
        settings = Object.assign(settings, stored);
        settings.map = Object.assign({ nickname: "", soopId: "", description: "", eventId: "" }, stored.map || {});
      }
    } catch (_error) {
      /* first run has no row yet */
    }
    el.wfUrl.value = settings.url || "";
    el.wfAuto.checked = Boolean(settings.autoSave);
    renderFields();
    setState("idle", settings.url ? "저장된 주소가 있습니다. 연결을 눌러 주세요." : "");
  }

  async function saveSettings() {
    settings.url = el.wfUrl.value.trim();
    settings.autoSave = el.wfAuto.checked;
    TARGETS.forEach(function (target) {
      var select = document.getElementById("wf-map-" + target.key);
      if (select) settings.map[target.key] = select.value;
    });
    el.wfSave.disabled = true;
    try {
      await window.DoomiData.saveSetting(SETTING_KEY, settings);
      note("설정을 저장했어요.", false);
    } catch (error) {
      note(error instanceof Error ? error.message : "설정을 저장하지 못했어요.", true);
    } finally {
      el.wfSave.disabled = false;
    }
  }

  /* ---------- probe ---------- */

  async function probe() {
    var url = el.wfUrl.value.trim();
    if (!url) { note("알림 주소를 먼저 넣어 주세요.", true); return; }

    el.wfProbe.disabled = true;
    note("알림 주소를 살펴보는 중이에요.", false);
    try {
      var response = await fetch("/api/weflab/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url })
      });
      var payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "확인하지 못했어요.");
      renderCandidates(payload);
      note(payload.candidates.length
        ? payload.candidates.length + "개의 연결 주소를 찾았어요. 하나를 골라 연결하세요."
        : "연결 주소를 못 찾았어요. 주소가 맞는지 확인해 주세요.", !payload.candidates.length);
    } catch (error) {
      note(error instanceof Error ? error.message : "확인하지 못했어요.", true);
    } finally {
      el.wfProbe.disabled = false;
    }
  }

  function renderCandidates(payload) {
    el.wfCandidates.replaceChildren();
    if (!payload.candidates.length) { el.wfCandidates.hidden = true; return; }
    el.wfCandidates.hidden = false;

    var title = document.createElement("p");
    title.className = "wf-sub";
    title.textContent = "찾은 연결 주소";
    el.wfCandidates.appendChild(title);

    payload.candidates.forEach(function (candidate) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "wf-candidate";
      var address = document.createElement("code");
      address.textContent = candidate.url;
      var where = document.createElement("small");
      where.textContent = candidate.sources.join(" · ");
      row.append(address, where);
      row.addEventListener("click", function () { connect(candidate.url); });
      el.wfCandidates.appendChild(row);
    });
  }

  /* ---------- connect ---------- */

  function connect(address) {
    if (!address) { note("연결할 주소가 없어요.", true); return; }
    disconnect(true);

    var wsUrl = address.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    settings.socketUrl = wsUrl;
    manualClose = false;
    setState("connecting", "");

    try {
      socket = new WebSocket(wsUrl);
    } catch (error) {
      setState("error", "연결하지 못했어요: " + error.message);
      return;
    }

    socket.addEventListener("open", function () {
      setState("open", "연결됐어요. 룰렛을 한 번 돌려 보세요.");
    });
    socket.addEventListener("message", function (event) { handleMessage(event.data); });
    socket.addEventListener("error", function () {
      setState("error", "연결 중 오류가 났어요. 주소를 다시 확인해 주세요.");
    });
    socket.addEventListener("close", function () {
      socket = null;
      if (manualClose) { setState("idle", "연결을 끊었어요."); return; }
      setState("error", "연결이 끊겼어요. 잠시 후 다시 시도합니다.");
      reconnectTimer = window.setTimeout(function () { connect(wsUrl); }, RECONNECT_MS);
    });
  }

  function disconnect(quiet) {
    manualClose = true;
    window.clearTimeout(reconnectTimer);
    if (socket) {
      try { socket.close(); } catch (_error) {}
      socket = null;
    }
    if (!quiet) setState("idle", "연결을 끊었어요.");
  }

  function setState(kind, message) {
    var labels = { idle: "연결 안 됨", connecting: "연결하는 중", open: "연결됨", error: "문제 있음" };
    el.wfState.textContent = labels[kind] || kind;
    el.wfState.className = "wf-state " + kind;
    el.wfConnect.disabled = kind === "connecting" || kind === "open";
    el.wfDisconnect.disabled = kind === "idle";
    if (message) note(message, kind === "error");
  }

  function note(message, isError) {
    el.wfNote.textContent = message || "";
    el.wfNote.classList.toggle("error", Boolean(isError));
  }

  /* ---------- incoming events ---------- */

  function handleMessage(raw) {
    var parsed = raw;
    if (typeof raw === "string") {
      try { parsed = JSON.parse(raw); } catch (_error) { parsed = raw; }
    }
    /* socket.io frames look like 42["event",{...}] */
    if (typeof parsed === "string") {
      var socketIo = parsed.match(/^\d+(\[.*\])$/);
      if (socketIo) {
        try { parsed = JSON.parse(socketIo[1]); } catch (_error) { /* keep string */ }
      }
    }
    var payload = Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string"
      ? parsed[1]
      : parsed;

    recent.unshift({ at: new Date(), value: payload });
    recent = recent.slice(0, RECENT_LIMIT);

    if (payload && typeof payload === "object") {
      lastSample = flatten(payload);
      var names = Object.keys(lastSample);
      if (names.join("|") !== fieldNames.join("|")) {
        fieldNames = names;
        renderFields();
      }
      if (settings.autoSave) saveFromEvent(lastSample);
    }
    renderLog();
  }

  function flatten(value, prefix, out) {
    out = out || {};
    prefix = prefix || "";
    Object.keys(value).forEach(function (key) {
      var item = value[key];
      var path = prefix ? prefix + "." + key : key;
      if (item && typeof item === "object" && !Array.isArray(item)) flatten(item, path, out);
      else out[path] = item;
    });
    return out;
  }

  function renderLog() {
    el.wfLog.replaceChildren();
    if (!recent.length) {
      var empty = document.createElement("p");
      empty.className = "wf-empty";
      empty.textContent = "아직 받은 게 없어요. 연결한 뒤 룰렛을 돌리면 여기 그대로 보입니다.";
      el.wfLog.appendChild(empty);
      return;
    }
    recent.forEach(function (entry) {
      var block = document.createElement("details");
      var summary = document.createElement("summary");
      summary.textContent = entry.at.toLocaleTimeString("ko-KR") + " · " + preview(entry.value);
      var body = document.createElement("pre");
      body.textContent = typeof entry.value === "string"
        ? entry.value
        : JSON.stringify(entry.value, null, 2);
      block.append(summary, body);
      el.wfLog.appendChild(block);
    });
  }

  function preview(value) {
    if (typeof value === "string") return value.slice(0, 60);
    try { return JSON.stringify(value).slice(0, 60); } catch (_error) { return "메시지"; }
  }

  /* ---------- field mapping ---------- */

  function renderFields() {
    el.wfFields.replaceChildren();
    if (!fieldNames.length) {
      var empty = document.createElement("p");
      empty.className = "wf-empty";
      empty.textContent = "메시지를 한 번 받아야 어떤 칸이 있는지 알 수 있어요.";
      el.wfFields.appendChild(empty);
      return;
    }

    TARGETS.forEach(function (target) {
      var wrap = document.createElement("label");
      wrap.className = "wf-field";
      var name = document.createElement("span");
      name.textContent = target.label;
      var select = document.createElement("select");
      select.id = "wf-map-" + target.key;

      var blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "— 사용 안 함 —";
      select.appendChild(blank);

      fieldNames.forEach(function (field) {
        var option = document.createElement("option");
        option.value = field;
        var sample = lastSample ? String(lastSample[field]) : "";
        option.textContent = field + (sample && sample.length < 24 ? "  (" + sample + ")" : "");
        select.appendChild(option);
      });

      var chosen = settings.map[target.key];
      if (!chosen) {
        chosen = fieldNames.filter(function (field) { return target.guess.test(field); })[0] || "";
      }
      select.value = chosen;
      settings.map[target.key] = chosen;

      wrap.append(name, select);
      el.wfFields.appendChild(wrap);
    });
  }

  /* ---------- saving ---------- */

  async function saveFromEvent(sample) {
    var pick = function (key) {
      var field = settings.map[key];
      return field && sample[field] !== undefined && sample[field] !== null ? String(sample[field]).trim() : "";
    };

    var nickname = pick("nickname");
    var soopId = pick("soopId");
    var description = pick("description");
    if (!description) return;
    if (!nickname && !soopId) return;

    var eventId = pick("eventId");
    var key = eventId || [nickname, soopId, description, Math.floor(Date.now() / 60000)].join("|");
    if (seen.has(key)) return;
    seen.add(key);

    try {
      await window.DoomiData.createRecord({
        nickname: nickname || soopId,
        soopId: soopId || nickname,
        description: description,
        status: "active",
        category: "roulette",
        source: "weplab",
        sourceEventId: "weflab:" + key
      });
      el.wfSavedCount.textContent = String(Number(el.wfSavedCount.textContent || 0) + 1);
      note(description + " — 저장했어요.", false);
      if (window.DoomiAdmin && window.DoomiAdmin.reload) window.DoomiAdmin.reload();
    } catch (error) {
      /* The unique index rejecting a repeat is the dedup working, not a fault. */
      if (error && error.duplicate) return;
      seen.delete(key);
      note(error instanceof Error ? error.message : "저장하지 못했어요.", true);
    }
  }

  /* Lets the admin prove the mapping and the saving path without waiting for a
     real roulette spin. */
  function sendTestEvent() {
    handleMessage(JSON.stringify({
      event: "roulette",
      nickname: "테스트두콩",
      user_id: "testkong",
      item: "테스트 업보 (연동 확인용)",
      amount: 10,
      event_uid: "weflab-test-" + Date.now()
    }));
    note("시험 메시지를 넣었어요. 아래에서 칸을 지정한 뒤 자동 저장을 켜고 다시 눌러 보세요.", false);
  }
})();
