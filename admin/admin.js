(function () {
  "use strict";

  var PAGE_SIZE = 20;

  var state = {
    records: [],
    query: "",
    status: "all",
    category: "all",
    visibleCount: PAGE_SIZE,
    editingId: null,
    pendingDeleteId: null,
    lastSync: null,
    busy: false
  };

  var elements = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    elements.gate = document.getElementById("dmGate");
    elements.gateForm = document.getElementById("dmGateForm");
    elements.gateMessage = document.getElementById("dm-gate-message");
    elements.gateButton = document.getElementById("dm-login");
    elements.email = document.getElementById("dm-email");
    elements.password = document.getElementById("dm-password");
    elements.shell = document.getElementById("dmShell");
    elements.account = document.getElementById("dm-account");
    elements.logout = document.getElementById("dm-logout");

    elements.form = document.getElementById("record-form");
    elements.formTitle = document.getElementById("form-title");
    elements.editId = document.getElementById("edit-id");
    elements.save = document.getElementById("save-button");
    elements.cancelEdit = document.getElementById("cancel-edit");
    elements.reset = document.getElementById("reset-button");
    elements.refresh = document.getElementById("refresh-button");
    elements.notice = document.getElementById("admin-notice");
    elements.list = document.getElementById("quick-record-list");
    elements.count = document.getElementById("quick-count");
    elements.more = document.getElementById("admin-more");
    elements.search = document.getElementById("admin-search-input");
    elements.statusFilter = document.getElementById("admin-status-filter");
    elements.categoryFilter = document.getElementById("admin-category-filter");
    elements.recordCategory = document.getElementById("record-category");
    elements.themeToggle = document.getElementById("theme-toggle");
    elements.exportCsv = document.getElementById("export-csv");
    elements.bulkInput = document.getElementById("bulk-input");
    elements.bulkCheck = document.getElementById("bulk-check");
    elements.bulkSave = document.getElementById("bulk-save");
    elements.bulkResult = document.getElementById("bulk-result");

    elements.gateForm.addEventListener("submit", handleLogin);
    elements.logout.addEventListener("click", handleLogout);
    elements.form.addEventListener("submit", handleSave);
    elements.reset.addEventListener("click", function () { window.setTimeout(exitEditMode, 0); });
    elements.cancelEdit.addEventListener("click", function () {
      elements.form.reset();
      exitEditMode();
    });
    elements.refresh.addEventListener("click", function () { loadRecords(false); });
    elements.search.addEventListener("input", function () {
      state.query = elements.search.value;
      state.visibleCount = PAGE_SIZE;
      renderList();
    });
    elements.statusFilter.addEventListener("change", function () {
      state.status = elements.statusFilter.value;
      state.visibleCount = PAGE_SIZE;
      renderList();
    });
    elements.categoryFilter.addEventListener("change", function () {
      state.category = elements.categoryFilter.value;
      state.visibleCount = PAGE_SIZE;
      renderList();
    });
    elements.themeToggle.addEventListener("click", toggleTheme);
    elements.exportCsv.addEventListener("click", exportCsv);
    elements.bulkCheck.addEventListener("click", function () { runBulk(false); });
    elements.bulkSave.addEventListener("click", function () { runBulk(true); });
    elements.more.addEventListener("click", function () {
      state.visibleCount += PAGE_SIZE;
      renderList();
    });

    applySiteAvatars();
    fillCategoryControls();
    initTheme();
    startGate();
  }

  /* Bundled picture is only 100x100; SOOP serves the full-size original. */
  function applySiteAvatars() {
    var url = window.DoomiData.soopAvatarUrl(window.DoomiData.soopId);
    if (!url) return;
    Array.prototype.forEach.call(document.querySelectorAll("img.site-avatar"), function (image) {
      var fallback = image.src;
      image.addEventListener("error", function () { image.src = fallback; }, { once: true });
      image.referrerPolicy = "no-referrer";
      image.src = url;
    });
  }

  async function startGate() {
    if (!window.DoomiData.isConfigured()) {
      showGate(window.DoomiData.setupMessage());
      elements.gateButton.disabled = true;
      return;
    }
    var session = await window.DoomiData.getSession();
    if (session) openAdmin(session);
    else showGate("");
    window.DoomiData.onAuthChange(function (nextSession) {
      if (nextSession) openAdmin(nextSession);
      else showGate("");
    });
  }

  function showGate(message) {
    elements.gate.hidden = false;
    elements.shell.hidden = true;
    elements.gateMessage.textContent = message || "";
    elements.gateMessage.classList.toggle("error", Boolean(message));
  }

  function openAdmin(session) {
    elements.gate.hidden = true;
    elements.shell.hidden = false;
    var email = session && session.user ? session.user.email : "";
    elements.account.textContent = email || "로그인됨";
    /* Ad blockers sometimes hide admin-prefixed containers; re-assert once. */
    window.setTimeout(function () { elements.shell.hidden = false; }, 1200);
    loadRecords(false);
  }

  async function handleLogin(event) {
    event.preventDefault();
    if (!elements.gateForm.reportValidity()) return;
    elements.gateButton.disabled = true;
    elements.gateMessage.classList.remove("error");
    elements.gateMessage.textContent = "확인 중이에요.";
    try {
      await window.DoomiData.signIn(elements.email.value, elements.password.value);
      elements.password.value = "";
    } catch (error) {
      elements.gateMessage.classList.add("error");
      elements.gateMessage.textContent = error instanceof Error ? error.message : "로그인하지 못했어요.";
    } finally {
      elements.gateButton.disabled = false;
    }
  }

  async function handleLogout() {
    await window.DoomiData.signOut();
    state.records = [];
    showGate("");
  }

  async function loadRecords(silent) {
    setBusy(true);
    if (!silent) announce("데이터를 확인하고 있어요.", "success");
    try {
      state.records = await window.DoomiData.listRecords();
      state.lastSync = new Date().toISOString();
      render();
      if (!silent) announce(state.records.length.toLocaleString("ko-KR") + "건을 불러왔어요.", "success");
    } catch (error) {
      announce(error instanceof Error ? error.message : "데이터를 불러오지 못했어요.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(event) {
    event.preventDefault();
    if (!elements.form.reportValidity()) return;
    var input = {
      soopId: document.getElementById("soop-id").value.trim(),
      nickname: document.getElementById("nickname").value.trim(),
      description: document.getElementById("description").value.trim(),
      category: elements.recordCategory.value,
      status: document.getElementById("record-status").value === "done" ? "done" : "active"
    };
    if (!input.soopId || !input.nickname || !input.description) {
      announce("아이디, 닉네임, 업보 내용을 모두 입력해 주세요.", "error");
      return;
    }

    setBusy(true);
    try {
      if (state.editingId !== null) {
        await window.DoomiData.updateRecord(state.editingId, input);
        announce(input.nickname + "님의 기록을 수정했어요.", "success");
      } else {
        await window.DoomiData.createRecord(input);
        announce(input.nickname + "님의 업보를 저장했어요.", "success");
      }
      elements.form.reset();
      exitEditMode();
      await loadRecords(true);
      document.getElementById("soop-id").focus();
    } catch (error) {
      announce(error instanceof Error ? error.message : "업보를 저장하지 못했어요.", "error");
    } finally {
      setBusy(false);
    }
  }

  function enterEditMode(record) {
    state.editingId = record.id;
    elements.editId.value = String(record.id);
    document.getElementById("soop-id").value = record.soopId;
    document.getElementById("nickname").value = record.nickname;
    document.getElementById("description").value = record.description;
    document.getElementById("record-status").value = record.status;
    elements.recordCategory.value = record.category;
    elements.formTitle.textContent = "업보 수정";
    elements.save.textContent = "수정 저장";
    elements.cancelEdit.hidden = false;
    renderList();
    document.getElementById("soop-id").focus();
  }

  function exitEditMode() {
    state.editingId = null;
    elements.editId.value = "";
    elements.formTitle.textContent = "새 업보 등록";
    elements.save.textContent = "저장하기";
    elements.cancelEdit.hidden = true;
    renderList();
  }

  async function toggleStatus(record) {
    setBusy(true);
    try {
      await window.DoomiData.updateRecordStatus(record.id, record.status === "done" ? "active" : "done");
      announce(record.nickname + "님의 상태를 바꿨어요.", "success");
      await loadRecords(true);
    } catch (error) {
      announce(error instanceof Error ? error.message : "상태를 바꾸지 못했어요.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function removeRecord(record) {
    if (state.pendingDeleteId !== record.id) {
      state.pendingDeleteId = record.id;
      renderList();
      window.setTimeout(function () {
        if (state.pendingDeleteId === record.id) {
          state.pendingDeleteId = null;
          renderList();
        }
      }, 5000);
      return;
    }
    state.pendingDeleteId = null;
    setBusy(true);
    try {
      await window.DoomiData.deleteRecord(record.id);
      if (state.editingId === record.id) {
        elements.form.reset();
        exitEditMode();
      }
      announce(record.nickname + "님의 기록을 삭제했어요.", "success");
      await loadRecords(true);
    } catch (error) {
      announce(error instanceof Error ? error.message : "기록을 삭제하지 못했어요.", "error");
    } finally {
      setBusy(false);
    }
  }

  function render() {
    var stats = window.DoomiData.statsFor(state.records);
    setText("admin-total", stats.total.toLocaleString("ko-KR"));
    setText("admin-active", stats.active.toLocaleString("ko-KR"));
    setText("admin-done", stats.done.toLocaleString("ko-KR"));
    setText("admin-last-sync", shortTime(state.lastSync));
    renderList();
  }

  function filteredRecords() {
    var keyword = state.query.trim().toLocaleLowerCase("ko");
    return state.records.filter(function (record) {
      if (state.status !== "all" && record.status !== state.status) return false;
      if (state.category !== "all" && record.category !== state.category) return false;
      if (!keyword) return true;
      return (record.nickname + " " + record.soopId + " " + record.description)
        .toLocaleLowerCase("ko").includes(keyword);
    });
  }

  function renderList() {
    var filtered = filteredRecords();
    var visible = filtered.slice(0, state.visibleCount);
    elements.count.textContent = filtered.length.toLocaleString("ko-KR") + "건";
    elements.list.replaceChildren();

    if (!visible.length) {
      var empty = document.createElement("p");
      empty.className = "no-records";
      empty.textContent = state.records.length ? "조건에 맞는 기록이 없어요." : "아직 저장된 기록이 없어요.";
      elements.list.appendChild(empty);
      elements.more.hidden = true;
      return;
    }

    visible.forEach(function (record) {
      elements.list.appendChild(makeRow(record));
    });
    elements.more.hidden = state.visibleCount >= filtered.length;
  }

  function makeRow(record) {
    var article = document.createElement("article");
    if (state.editingId === record.id) article.className = "is-editing";

    var identity = document.createElement("span");
    var nickname = document.createElement("b");
    nickname.textContent = record.nickname;
    var soopId = document.createElement("small");
    soopId.textContent = record.soopId + (record.source === "weplab" ? " · 룰렛 연동" : "");
    var category = document.createElement("small");
    category.className = "row-category";
    category.textContent = window.DoomiData.categoryLabel(record.category);
    identity.append(nickname, soopId, category);

    var description = document.createElement("p");
    description.textContent = record.description;

    var actions = document.createElement("span");
    actions.className = "row-actions";

    var statusButton = document.createElement("button");
    statusButton.type = "button";
    statusButton.className = "status " + (record.status === "done" ? "done" : "active");
    statusButton.textContent = record.status === "done" ? "완료" : "진행 중";
    statusButton.disabled = state.busy;
    statusButton.setAttribute("aria-label", record.nickname + "님의 기록을 " + (record.status === "done" ? "진행 중" : "완료") + "으로 바꾸기");
    statusButton.addEventListener("click", function () { toggleStatus(record); });

    var editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "row-edit";
    editButton.textContent = "수정";
    editButton.disabled = state.busy;
    editButton.setAttribute("aria-label", record.nickname + "님의 기록 수정");
    editButton.addEventListener("click", function () { enterEditMode(record); });

    var deleteButton = document.createElement("button");
    deleteButton.type = "button";
    var pending = state.pendingDeleteId === record.id;
    deleteButton.className = pending ? "row-delete confirm" : "row-delete";
    deleteButton.textContent = pending ? "정말 삭제" : "삭제";
    deleteButton.disabled = state.busy;
    deleteButton.setAttribute("aria-label", record.nickname + "님의 기록 삭제");
    deleteButton.addEventListener("click", function () { removeRecord(record); });

    actions.append(statusButton, editButton, deleteButton);
    article.append(identity, description, actions);
    return article;
  }

  function announce(message, tone) {
    elements.notice.textContent = message;
    elements.notice.className = "admin-notice " + (tone === "error" ? "error" : "success");
  }

  function setBusy(value) {
    state.busy = value;
    elements.save.disabled = value;
    elements.reset.disabled = value;
    elements.refresh.disabled = value;
    elements.bulkCheck.disabled = value;
    elements.bulkSave.disabled = value;
    elements.exportCsv.disabled = value;
    renderList();
  }

  function shortTime(value) {
    if (!value) return "아직 없음";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  /* ---------- category ---------- */

  function fillCategoryControls() {
    window.DoomiData.categories.forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      elements.recordCategory.appendChild(option);

      var filterOption = document.createElement("option");
      filterOption.value = item.value;
      filterOption.textContent = item.label;
      elements.categoryFilter.appendChild(filterOption);
    });
  }

  /* ---------- dark mode ---------- */

  function initTheme() {
    paintTheme(document.body.classList.contains("dark"));
  }

  function toggleTheme() {
    var dark = !document.body.classList.contains("dark");
    document.body.classList.toggle("dark", dark);
    try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch (_error) {}
    paintTheme(dark);
  }

  function paintTheme(dark) {
    elements.themeToggle.setAttribute("aria-pressed", dark ? "true" : "false");
    elements.themeToggle.setAttribute("aria-label", dark ? "밝은 화면으로" : "어두운 화면으로");
  }

  /* ---------- CSV export ---------- */

  function csvCell(value) {
    var text = String(value == null ? "" : value);
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function exportCsv() {
    var rows = filteredRecords();
    if (!rows.length) {
      announce("내보낼 기록이 없어요.", "error");
      return;
    }
    var header = ["아이디", "닉네임", "업보 내용", "분류", "상태", "등록일", "완료일", "등록 경로"];
    var lines = [header.map(csvCell).join(",")];
    rows.forEach(function (record) {
      lines.push([
        record.soopId,
        record.nickname,
        record.description,
        window.DoomiData.categoryLabel(record.category),
        record.status === "done" ? "완료" : "진행 중",
        window.DoomiData.formatDateTime(record.createdAt),
        record.completedAt ? window.DoomiData.formatDateTime(record.completedAt) : "",
        record.source === "weplab" ? "룰렛 연동" : "직접 등록"
      ].map(csvCell).join(","));
    });

    /* The BOM is what stops Excel from turning Korean into 뜁 on open. */
    var blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "두미업보_" + window.DoomiData.dateKey(new Date()) + ".csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    announce(rows.length.toLocaleString("ko-KR") + "건을 내보냈어요.", "success");
  }

  /* ---------- bulk paste ---------- */

  /* Splits one CSV line, honouring "quoted, fields" and doubled quotes. */
  function splitLine(line) {
    if (line.indexOf("\t") >= 0 && line.indexOf('"') < 0) return line.split("\t");
    var cells = [];
    var current = "";
    var quoted = false;
    for (var i = 0; i < line.length; i += 1) {
      var ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
        else if (ch === '"') quoted = false;
        else current += ch;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === "," || ch === "\t") {
        cells.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    cells.push(current);
    return cells;
  }

  function matchCategory(text) {
    var value = String(text || "").trim();
    if (!value) return window.DoomiData.categories[0].value;
    var byValue = window.DoomiData.categories.filter(function (item) { return item.value === value; })[0];
    if (byValue) return byValue.value;
    var byLabel = window.DoomiData.categories.filter(function (item) {
      return item.label === value || item.label.replace(/\s+/g, "") === value.replace(/\s+/g, "");
    })[0];
    return byLabel ? byLabel.value : null;
  }

  function parseBulk(text) {
    var rows = [];
    var errors = [];
    String(text || "").split(/\r?\n/).forEach(function (line, index) {
      if (!line.trim()) return;
      var cells = splitLine(line).map(function (cell) { return cell.trim(); });
      var lineNo = index + 1;

      if (cells.length < 3) {
        errors.push(lineNo + "번째 줄: 칸이 3개보다 적어요.");
        return;
      }
      var soopId = cells[0], nickname = cells[1], description = cells[2];
      if (!soopId || !nickname || !description) {
        errors.push(lineNo + "번째 줄: 아이디·닉네임·내용 중 빈 칸이 있어요.");
        return;
      }
      if (soopId.length > 80 || nickname.length > 80) {
        errors.push(lineNo + "번째 줄: 아이디나 닉네임이 80자를 넘어요.");
        return;
      }
      if (description.length > 1000) {
        errors.push(lineNo + "번째 줄: 업보 내용이 1000자를 넘어요.");
        return;
      }

      var category = matchCategory(cells[3]);
      if (category === null) {
        errors.push(lineNo + "번째 줄: 분류 \"" + cells[3] + "\" 를 모르겠어요.");
        return;
      }

      var statusText = String(cells[4] || "").trim();
      var status = "active";
      if (statusText) {
        if (/^(완료|done)$/i.test(statusText)) status = "done";
        else if (/^(진행 ?중|active)$/i.test(statusText)) status = "active";
        else {
          errors.push(lineNo + "번째 줄: 상태 \"" + statusText + "\" 를 모르겠어요.");
          return;
        }
      }

      rows.push({ soopId: soopId, nickname: nickname, description: description,
                  category: category, status: status });
    });
    return { rows: rows, errors: errors };
  }

  function showBulkResult(parsed, saved) {
    elements.bulkResult.hidden = false;
    elements.bulkResult.replaceChildren();

    var summary = document.createElement("p");
    summary.className = parsed.errors.length ? "bulk-summary warn" : "bulk-summary ok";
    summary.textContent = saved
      ? parsed.rows.length.toLocaleString("ko-KR") + "건을 등록했어요."
      : parsed.rows.length.toLocaleString("ko-KR") + "건 등록 가능"
        + (parsed.errors.length ? " · " + parsed.errors.length + "줄은 건너뜁니다" : "");
    elements.bulkResult.appendChild(summary);

    if (parsed.errors.length) {
      var list = document.createElement("ul");
      parsed.errors.slice(0, 12).forEach(function (message) {
        var item = document.createElement("li");
        item.textContent = message;
        list.appendChild(item);
      });
      if (parsed.errors.length > 12) {
        var more = document.createElement("li");
        more.textContent = "…그 밖에 " + (parsed.errors.length - 12) + "줄";
        list.appendChild(more);
      }
      elements.bulkResult.appendChild(list);
    }
  }

  async function runBulk(save) {
    var parsed = parseBulk(elements.bulkInput.value);
    if (!parsed.rows.length) {
      showBulkResult(parsed, false);
      announce(parsed.errors.length ? "등록할 수 있는 줄이 없어요." : "붙여넣은 내용이 없어요.", "error");
      return;
    }
    if (!save) {
      showBulkResult(parsed, false);
      announce("검사만 했어요. 저장하려면 전부 등록을 누르세요.", "success");
      return;
    }

    setBusy(true);
    try {
      await window.DoomiData.createRecords(parsed.rows);
      showBulkResult(parsed, true);
      announce(parsed.rows.length.toLocaleString("ko-KR") + "건을 등록했어요.", "success");
      elements.bulkInput.value = "";
      await loadRecords(true);
    } catch (error) {
      announce(error instanceof Error ? error.message : "한 번에 등록하지 못했어요.", "error");
    } finally {
      setBusy(false);
    }
  }

  function setText(id, value) {
    var element = document.getElementById(id);
    if (element) element.textContent = String(value);
  }
})();
