(function () {
  "use strict";

  var PAGE_SIZE = 20;
  var REFRESH_MS = 30000;
  var TREND_DAYS = 14;
  var VIEWS = ["records", "stats", "book", "calendar"];
  var TOOLBAR_VIEWS = { records: true, book: true };

  var state = {
    records: [],
    view: "records",
    query: "",
    status: "all",
    category: "all",
    sort: "latest",
    dateKey: "",
    bookSort: "total",
    month: "",
    visibleCount: PAGE_SIZE,
    loaded: false,
    lastSync: null,
    error: null
  };

  var elements = {};
  var modalTrigger = null;
  var openModal = null;
  var urlTimer = null;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    [
      "search-input", "clear-search", "status-filter", "category-filter", "sort-filter", "toolbar",
      "theme-toggle",
      "record-table-body", "mobile-records", "records-content", "records", "more-button",
      "empty-state", "empty-title", "empty-text", "reset-filters", "result-count",
      "last-sync", "data-note", "sync-badge", "sync-badge-text", "view-nav",
      "date-chip", "date-chip-label", "date-chip-clear",
      "drawer-backdrop", "detail-drawer", "drawer-close",
      "viewer-backdrop", "viewer-modal", "viewer-close", "viewer-see-records",
      "book-grid", "book-empty", "book-sort", "book-count",
      "calendar-grid", "month-label", "prev-month", "next-month", "month-summary",
      "progress-active", "progress-done", "legend-active", "legend-done", "done-rate",
      "trend-chart", "trend-note", "top-viewers", "top-debts"
    ].forEach(function (id) {
      elements[camel(id)] = document.getElementById(id);
    });
    VIEWS.forEach(function (name) {
      elements["view_" + name] = document.getElementById("view-" + name);
    });

    applySiteAvatar();
    fillCategoryFilter();
    initTheme();
    trackClickPoint();
    state.month = monthOf(window.DoomiData.dateKey(new Date()));
    restoreFromUrl();
    bindEvents();
    loadData(false);
    window.setInterval(function () { loadData(true); }, REFRESH_MS);
  }

  /* Bundled picture is only 100x100; SOOP serves the full-size original. */
  function applySiteAvatar() {
    var image = document.getElementById("site-avatar");
    var url = window.DoomiData.soopAvatarUrl(window.DoomiData.soopId);
    if (!image || !url) return;
    var fallback = image.src;
    image.addEventListener("error", function () { image.src = fallback; }, { once: true });
    image.referrerPolicy = "no-referrer";
    image.src = url;
  }

  function camel(id) {
    return id.replace(/-([a-z])/g, function (_all, letter) { return letter.toUpperCase(); });
  }

  function restoreFromUrl() {
    var params = new URLSearchParams(window.location.search);
    var status = params.get("status");
    var view = params.get("view");
    state.query = params.get("q") || "";
    state.status = status === "active" || status === "done" ? status : "all";
    state.sort = params.get("sort") === "oldest" ? "oldest" : "latest";
    state.dateKey = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") || "") ? params.get("date") : "";
    var category = params.get("category");
    state.category = window.DoomiData.categories.some(function (item) { return item.value === category; })
      ? category : "all";
    elements.categoryFilter.value = state.category;
    state.view = VIEWS.indexOf(view) >= 0 ? view : "records";
    elements.searchInput.value = state.query;
    elements.statusFilter.value = state.status;
    elements.sortFilter.value = state.sort;
    elements.clearSearch.hidden = !state.query;
    if (state.dateKey) state.month = monthOf(state.dateKey);
    applyView();
  }

  function bindEvents() {
    elements.viewNav.addEventListener("click", function (event) {
      var link = event.target.closest("a[data-view]");
      if (!link) return;
      event.preventDefault();
      setView(link.getAttribute("data-view"));
    });

    elements.searchInput.addEventListener("input", function () {
      state.query = elements.searchInput.value;
      state.visibleCount = PAGE_SIZE;
      elements.clearSearch.hidden = !state.query;
      render();
      queueUrlUpdate();
    });
    elements.clearSearch.addEventListener("click", function () {
      state.query = "";
      elements.searchInput.value = "";
      elements.clearSearch.hidden = true;
      state.visibleCount = PAGE_SIZE;
      render();
      queueUrlUpdate();
      elements.searchInput.focus();
    });
    elements.statusFilter.addEventListener("change", function () {
      state.status = elements.statusFilter.value;
      state.visibleCount = PAGE_SIZE;
      render();
      queueUrlUpdate();
    });
    elements.categoryFilter.addEventListener("change", function () {
      state.category = elements.categoryFilter.value;
      state.visibleCount = PAGE_SIZE;
      render();
      queueUrlUpdate();
    });
    elements.themeToggle.addEventListener("click", toggleTheme);
    elements.sortFilter.addEventListener("change", function () {
      state.sort = elements.sortFilter.value;
      state.visibleCount = PAGE_SIZE;
      renderRecords();
      queueUrlUpdate();
    });
    elements.moreButton.addEventListener("click", function () {
      state.visibleCount += PAGE_SIZE;
      renderRecords();
    });
    elements.resetFilters.addEventListener("click", resetFilters);
    elements.dateChipClear.addEventListener("click", function () {
      state.dateKey = "";
      state.visibleCount = PAGE_SIZE;
      render();
      queueUrlUpdate();
    });

    elements.bookSort.addEventListener("change", function () {
      state.bookSort = elements.bookSort.value;
      renderBook();
    });
    elements.prevMonth.addEventListener("click", function () { shiftMonth(-1); });
    elements.nextMonth.addEventListener("click", function () { shiftMonth(1); });

    elements.drawerClose.addEventListener("click", closeModals);
    elements.viewerClose.addEventListener("click", closeModals);
    elements.drawerBackdrop.addEventListener("mousedown", function (event) {
      if (event.target === elements.drawerBackdrop) closeModals();
    });
    elements.viewerBackdrop.addEventListener("mousedown", function (event) {
      if (event.target === elements.viewerBackdrop) closeModals();
    });
  }

  /* ---------- data ---------- */

  async function loadData(silent) {
    if (!silent) {
      elements.recordsContent.setAttribute("aria-busy", "true");
      elements.resultCount.textContent = "기록을 불러오는 중이에요";
    }
    try {
      state.records = await window.DoomiData.listRecords();
      state.loaded = true;
      state.error = null;
      state.lastSync = new Date().toISOString();
    } catch (error) {
      state.error = error;
      if (!state.loaded) state.records = [];
    } finally {
      elements.recordsContent.setAttribute("aria-busy", "false");
      render();
    }
  }

  function render() {
    renderStats();
    renderRecords();
    renderStatsView();
    renderBook();
    renderCalendar();
    renderConnection();
  }

  /* ---------- view switching ---------- */

  function setView(view) {
    if (VIEWS.indexOf(view) < 0) return;
    state.view = view;
    applyView();
    queueUrlUpdate();
  }

  function applyView() {
    VIEWS.forEach(function (name) {
      elements["view_" + name].hidden = name !== state.view;
    });
    Array.prototype.forEach.call(elements.viewNav.querySelectorAll("a[data-view]"), function (link) {
      link.classList.toggle("active", link.getAttribute("data-view") === state.view);
    });
    elements.toolbar.hidden = !TOOLBAR_VIEWS[state.view];
    elements.statusFilter.hidden = state.view !== "records";
    elements.sortFilter.hidden = state.view !== "records";
    elements.toolbar.classList.toggle("search-only", state.view === "book");
  }

  /* ---------- shared filtering ---------- */

  function matchesQuery(record) {
    var keyword = state.query.trim().toLocaleLowerCase("ko");
    if (!keyword) return true;
    return (record.nickname + " " + record.soopId + " " + record.description)
      .toLocaleLowerCase("ko").includes(keyword);
  }

  function filteredRecords() {
    return state.records.filter(function (record) {
      if (state.status !== "all" && record.status !== state.status) return false;
      if (state.category !== "all" && record.category !== state.category) return false;
      if (state.dateKey && window.DoomiData.dateKey(record.createdAt) !== state.dateKey) return false;
      return matchesQuery(record);
    }).sort(function (a, b) {
      var difference = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return state.sort === "latest" ? difference : -difference;
    });
  }

  /* ---------- 업보 기록 ---------- */

  function renderStats() {
    var stats = window.DoomiData.statsFor(state.records);
    setText("stat-total", stats.total.toLocaleString("ko-KR"));
    setText("stat-active", stats.active.toLocaleString("ko-KR"));
    setText("stat-done", stats.done.toLocaleString("ko-KR"));
    setText("stat-today", stats.today.toLocaleString("ko-KR"));
  }

  function renderRecords() {
    var filtered = filteredRecords();
    var visible = filtered.slice(0, state.visibleCount);
    var hasRecords = filtered.length > 0;
    var filtering = Boolean(state.query.trim()) || state.status !== "all"
      || state.category !== "all" || Boolean(state.dateKey);

    elements.resultCount.textContent = state.loaded
      ? filtered.length.toLocaleString("ko-KR") + "개의 기록을 찾았어요"
      : "기록을 준비하고 있어요";

    elements.dateChip.hidden = !state.dateKey;
    if (state.dateKey) {
      elements.dateChipLabel.textContent = window.DoomiData.formatLongDate(state.dateKey + "T00:00:00+09:00") + " 기록만";
    }

    elements.recordTableBody.replaceChildren();
    elements.mobileRecords.replaceChildren();
    visible.forEach(function (record) {
      elements.recordTableBody.appendChild(makeTableRow(record));
      elements.mobileRecords.appendChild(makeMobileCard(record));
    });

    elements.records.hidden = !hasRecords;
    elements.mobileRecords.hidden = !hasRecords;
    elements.emptyState.hidden = hasRecords;
    elements.moreButton.hidden = !hasRecords || state.visibleCount >= filtered.length;

    if (!hasRecords) {
      elements.emptyTitle.textContent = filtering ? "찾는 업보가 없어요" : "아직 등록된 업보가 없어요";
      elements.emptyText.textContent = filtering
        ? "검색어나 필터를 바꿔보세요."
        : "두콩이들의 첫 업보를 기다리는 중이에요.";
      elements.resetFilters.hidden = !filtering;
    }
  }

  function makeTableRow(record) {
    var row = document.createElement("tr");
    var nicknameCell = document.createElement("td");
    var detailButton = document.createElement("button");
    detailButton.className = "record-detail-button";
    detailButton.type = "button";
    detailButton.setAttribute("aria-label", record.nickname + "님의 업보 상세 보기");
    detailButton.addEventListener("click", function () { openDrawer(record, detailButton); });

    var avatar = document.createElement("span");
    avatar.className = "row-avatar";
    avatar.textContent = record.nickname.slice(0, 1);
    avatar.setAttribute("aria-hidden", "true");
    var nickname = document.createElement("b");
    nickname.textContent = record.nickname;
    detailButton.append(avatar, nickname);
    nicknameCell.appendChild(detailButton);

    row.appendChild(nicknameCell);
    row.appendChild(textCell(record.soopId));
    row.appendChild(textCell(record.description));
    var categoryCell = document.createElement("td");
    categoryCell.appendChild(categoryChip(record.category));
    row.appendChild(categoryCell);
    var statusCell = document.createElement("td");
    statusCell.appendChild(statusBadge(record.status));
    row.appendChild(statusCell);
    row.appendChild(textCell(window.DoomiData.formatShortDate(record.createdAt)));
    return row;
  }

  function makeMobileCard(record) {
    var button = document.createElement("button");
    button.className = "mobile-record-card";
    button.type = "button";
    button.setAttribute("aria-label", record.nickname + "님의 업보 상세 보기");
    button.addEventListener("click", function () { openDrawer(record, button); });

    var top = document.createElement("span");
    top.className = "mobile-record-top";
    var nickname = document.createElement("b");
    nickname.textContent = record.nickname;
    top.append(nickname, statusBadge(record.status));

    var description = document.createElement("span");
    description.className = "mobile-record-description";
    description.textContent = record.description;
    var meta = document.createElement("span");
    meta.className = "mobile-record-meta";
    meta.textContent = record.soopId + " · " + window.DoomiData.formatShortDate(record.createdAt);
    button.append(top, description, meta);
    button.insertBefore(categoryChip(record.category), meta);
    return button;
  }

  /* ---------- 통계 ---------- */

  function renderStatsView() {
    var stats = window.DoomiData.statsFor(state.records);
    var total = stats.total || 1;
    elements.progressActive.style.width = (stats.active / total * 100) + "%";
    elements.progressDone.style.width = (stats.done / total * 100) + "%";
    elements.legendActive.textContent = stats.active.toLocaleString("ko-KR");
    elements.legendDone.textContent = stats.done.toLocaleString("ko-KR");
    elements.doneRate.textContent = stats.total
      ? "완료율 " + Math.round(stats.done / stats.total * 100) + "%"
      : "아직 기록이 없어요";

    renderTrend();
    renderRank(elements.topViewers, topViewers(), "건");
    renderRank(elements.topDebts, topDebts(), "번");
  }

  function renderTrend() {
    var counts = {};
    state.records.forEach(function (record) {
      var key = window.DoomiData.dateKey(record.createdAt);
      counts[key] = (counts[key] || 0) + 1;
    });

    var today = new Date();
    var days = [];
    for (var i = TREND_DAYS - 1; i >= 0; i -= 1) {
      var date = new Date(today.getTime() - i * 86400000);
      var key = window.DoomiData.dateKey(date);
      days.push({ key: key, count: counts[key] || 0 });
    }
    var max = days.reduce(function (best, day) { return Math.max(best, day.count); }, 0);

    elements.trendChart.replaceChildren();
    days.forEach(function (day) {
      var column = document.createElement("span");
      column.className = "trend-col";
      column.title = day.key.slice(5).replace("-", ".") + " · " + day.count + "건";
      var bar = document.createElement("i");
      bar.style.height = max ? Math.max(4, day.count / max * 100) + "%" : "4px";
      if (!day.count) bar.classList.add("zero");
      column.appendChild(bar);
      elements.trendChart.appendChild(column);
    });

    var sum = days.reduce(function (acc, day) { return acc + day.count; }, 0);
    elements.trendNote.textContent = sum
      ? "최근 14일 동안 " + sum.toLocaleString("ko-KR") + "건 추가"
      : "최근 14일 동안 추가된 업보가 없어요";
  }

  function topViewers() {
    var map = new Map();
    state.records.forEach(function (record) {
      var key = record.soopId;
      var entry = map.get(key) || { label: record.nickname, sub: record.soopId, count: 0 };
      entry.count += 1;
      entry.label = record.nickname;
      map.set(key, entry);
    });
    return [...map.values()].sort(function (a, b) { return b.count - a.count; }).slice(0, 5);
  }

  function topDebts() {
    var map = new Map();
    state.records.forEach(function (record) {
      var entry = map.get(record.description) || { label: record.description, sub: "", count: 0 };
      entry.count += 1;
      map.set(record.description, entry);
    });
    return [...map.values()].sort(function (a, b) { return b.count - a.count; }).slice(0, 5);
  }

  function renderRank(container, rows, unit) {
    container.replaceChildren();
    if (!rows.length) {
      var empty = document.createElement("li");
      empty.className = "rank-empty";
      empty.textContent = "아직 기록이 없어요";
      container.appendChild(empty);
      return;
    }
    var max = rows[0].count || 1;
    rows.forEach(function (row, index) {
      var item = document.createElement("li");
      var rank = document.createElement("i");
      rank.className = "rank-no";
      rank.textContent = String(index + 1);
      var label = document.createElement("span");
      label.className = "rank-label";
      label.textContent = row.label;
      if (row.sub) {
        var sub = document.createElement("small");
        sub.textContent = row.sub;
        label.appendChild(sub);
      }
      var meter = document.createElement("span");
      meter.className = "rank-meter";
      var fill = document.createElement("i");
      fill.style.width = (row.count / max * 100) + "%";
      meter.appendChild(fill);
      var count = document.createElement("b");
      count.textContent = row.count.toLocaleString("ko-KR") + unit;
      item.append(rank, label, meter, count);
      container.appendChild(item);
    });
  }

  /* ---------- 업보 도감 ---------- */

  function viewerEntries() {
    var map = new Map();
    state.records.forEach(function (record) {
      var entry = map.get(record.soopId);
      if (!entry) {
        entry = {
          soopId: record.soopId, nickname: record.nickname,
          total: 0, active: 0, done: 0, kinds: new Map(), latest: record.createdAt
        };
        map.set(record.soopId, entry);
      }
      entry.total += 1;
      entry[record.status === "done" ? "done" : "active"] += 1;
      entry.kinds.set(record.description, (entry.kinds.get(record.description) || 0) + 1);
      if (new Date(record.createdAt) > new Date(entry.latest)) {
        entry.latest = record.createdAt;
        entry.nickname = record.nickname;
      }
    });
    return [...map.values()];
  }

  function renderBook() {
    var entries = viewerEntries().filter(function (entry) {
      if (!state.query.trim()) return true;
      var keyword = state.query.trim().toLocaleLowerCase("ko");
      return (entry.nickname + " " + entry.soopId).toLocaleLowerCase("ko").includes(keyword);
    });

    entries.sort(function (a, b) {
      if (state.bookSort === "name") return a.nickname.localeCompare(b.nickname, "ko");
      if (state.bookSort === "active") return b.active - a.active || b.total - a.total;
      if (state.bookSort === "done") return b.done - a.done || b.total - a.total;
      return b.total - a.total || a.nickname.localeCompare(b.nickname, "ko");
    });

    elements.bookCount.textContent = entries.length
      ? "두콩이 " + entries.length.toLocaleString("ko-KR") + "명이 모였어요"
      : "두콩이별로 모아 봤어요";
    elements.bookGrid.replaceChildren();
    elements.bookGrid.hidden = !entries.length;
    elements.bookEmpty.hidden = Boolean(entries.length);

    entries.forEach(function (entry) {
      elements.bookGrid.appendChild(makeViewerCard(entry));
    });
  }

  function makeViewerCard(entry) {
    var card = document.createElement("button");
    card.className = "book-card";
    card.type = "button";
    card.setAttribute("aria-label", entry.nickname + "님의 업보 도감 열기");
    card.addEventListener("click", function () { openViewer(entry, card); });

    card.appendChild(avatarNode(entry, "book-avatar"));

    var name = document.createElement("b");
    name.className = "book-name";
    name.textContent = entry.nickname;
    var id = document.createElement("small");
    id.className = "book-id";
    id.textContent = entry.soopId;

    var badge = document.createElement("span");
    badge.className = "book-badge";
    badge.textContent = "업보 " + entry.total.toLocaleString("ko-KR");

    var split = document.createElement("span");
    split.className = "book-split";
    var active = document.createElement("i");
    active.className = "active";
    active.textContent = "진행 " + entry.active;
    var done = document.createElement("i");
    done.className = "done";
    done.textContent = "완료 " + entry.done;
    split.append(active, done);

    card.append(name, id, badge, split);
    return card;
  }

  /* SOOP profile picture with an initial-letter fallback when it 404s. */
  function fillAvatar(node, entry) {
    node.replaceChildren();
    node.classList.remove("has-image");
    node.setAttribute("aria-hidden", "true");
    node.appendChild(document.createTextNode(entry.nickname.slice(0, 1)));

    var id = String(entry.soopId || "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,}$/.test(id)) return node;

    var image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.src = "https://profile.img.sooplive.co.kr/LOGO/" + id.slice(0, 2) + "/" + id + "/" + id + ".jpg";
    image.addEventListener("load", function () { node.classList.add("has-image"); });
    image.addEventListener("error", function () { image.remove(); });
    node.appendChild(image);
    return node;
  }

  function avatarNode(entry, className) {
    var wrap = document.createElement("span");
    wrap.className = className;
    return fillAvatar(wrap, entry);
  }

  /* ---------- 업보 캘린더 ---------- */

  function monthOf(dateKey) {
    return String(dateKey || "").slice(0, 7);
  }

  function shiftMonth(step) {
    var year = Number(state.month.slice(0, 4));
    var month = Number(state.month.slice(5, 7)) - 1 + step;
    var date = new Date(Date.UTC(year, month, 1));
    state.month = date.toISOString().slice(0, 7);
    renderCalendar();
  }

  function renderCalendar() {
    var counts = {};
    state.records.forEach(function (record) {
      var key = window.DoomiData.dateKey(record.createdAt);
      counts[key] = (counts[key] || 0) + 1;
    });

    var year = Number(state.month.slice(0, 4));
    var month = Number(state.month.slice(5, 7));
    elements.monthLabel.textContent = year + "년 " + month + "월";

    var first = new Date(Date.UTC(year, month - 1, 1));
    var daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    var leading = (first.getUTCDay() + 6) % 7;
    var todayKey = window.DoomiData.dateKey(new Date());
    var max = 0;
    var monthTotal = 0;

    for (var probe = 1; probe <= daysInMonth; probe += 1) {
      var probeKey = state.month + "-" + String(probe).padStart(2, "0");
      max = Math.max(max, counts[probeKey] || 0);
      monthTotal += counts[probeKey] || 0;
    }

    elements.calendarGrid.replaceChildren();
    for (var blank = 0; blank < leading; blank += 1) {
      var filler = document.createElement("span");
      filler.className = "cal-cell empty";
      elements.calendarGrid.appendChild(filler);
    }

    for (var day = 1; day <= daysInMonth; day += 1) {
      var key = state.month + "-" + String(day).padStart(2, "0");
      var count = counts[key] || 0;
      var cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cal-cell";
      cell.dataset.date = key;
      if (count) cell.classList.add("has-record");
      if (max && count) cell.classList.add("level-" + Math.min(4, Math.ceil(count / max * 4)));
      if (key === todayKey) cell.classList.add("today");
      if (key === state.dateKey) cell.classList.add("selected");

      var number = document.createElement("b");
      number.textContent = String(day);
      cell.appendChild(number);
      if (count) {
        var badge = document.createElement("i");
        badge.textContent = count;
        cell.appendChild(badge);
      }
      cell.setAttribute("aria-label", month + "월 " + day + "일 업보 " + count + "건");
      cell.addEventListener("click", pickDate);
      elements.calendarGrid.appendChild(cell);
    }

    elements.monthSummary.textContent = year + "년 " + month + "월 업보 " + monthTotal.toLocaleString("ko-KR") + "건";
  }

  function pickDate(event) {
    var key = event.currentTarget.dataset.date;
    state.dateKey = state.dateKey === key ? "" : key;
    state.status = "all";
    state.visibleCount = PAGE_SIZE;
    elements.statusFilter.value = "all";
    if (state.dateKey) setView("records");
    render();
    queueUrlUpdate();
  }

  /* ---------- shared ---------- */

  function statusBadge(status) {
    var badge = document.createElement("span");
    badge.className = "status " + (status === "done" ? "done" : "active");
    badge.textContent = status === "done" ? "완료" : "진행 중";
    return badge;
  }

  function textCell(value) {
    var cell = document.createElement("td");
    cell.textContent = value;
    return cell;
  }

  function renderConnection() {
    var healthy = state.loaded && !state.error;
    elements.syncBadge.classList.toggle("local", !healthy);
    elements.syncBadge.classList.toggle("api", healthy);
    elements.syncBadgeText.textContent = healthy ? "기록 연결됨" : "기록 준비 중";
    elements.lastSync.textContent = state.lastSync
      ? "마지막 확인 · " + window.DoomiData.formatDateTime(state.lastSync)
      : "";
    /* Setup and connection problems are an operator concern; the admin page
       shows the detail. Visitors only ever see the empty state. */
    elements.dataNote.hidden = !healthy;
    elements.dataNote.textContent = healthy ? "30초마다 새 기록을 자동으로 확인해요." : "";
  }

  function resetFilters() {
    state.query = "";
    state.status = "all";
    state.category = "all";
    state.dateKey = "";
    state.visibleCount = PAGE_SIZE;
    elements.searchInput.value = "";
    elements.statusFilter.value = "all";
    elements.categoryFilter.value = "all";
    elements.clearSearch.hidden = true;
    render();
    queueUrlUpdate();
    elements.searchInput.focus();
  }

  function queueUrlUpdate() {
    window.clearTimeout(urlTimer);
    urlTimer = window.setTimeout(function () {
      var params = new URLSearchParams();
      if (state.view !== "records") params.set("view", state.view);
      if (state.query.trim()) params.set("q", state.query.trim());
      if (state.status !== "all") params.set("status", state.status);
      if (state.category !== "all") params.set("category", state.category);
      if (state.sort !== "latest") params.set("sort", state.sort);
      if (state.dateKey) params.set("date", state.dateKey);
      var queryString = params.toString();
      try {
        window.history.replaceState(null, "", queryString ? "?" + queryString : window.location.pathname);
      } catch (_error) {
        // Some browsers block history changes on file:// pages.
      }
    }, 250);
  }

  /* ---------- modals ---------- */

  function openDrawer(record, trigger) {
    setText("detail-title", record.nickname);
    setText("detail-id", "SOOP ID · " + record.soopId);
    setText("detail-description", record.description);
    setText("detail-category", window.DoomiData.categoryLabel(record.category));
    setText("detail-created", window.DoomiData.formatLongDate(record.createdAt));
    setText("detail-source", record.source === "weplab" ? "룰렛 자동 연동" : "관리자 직접 등록");

    var status = document.getElementById("detail-status");
    status.className = "status " + (record.status === "done" ? "done" : "active");
    status.textContent = record.status === "done" ? "완료" : "진행 중";

    var completedRow = document.getElementById("detail-completed-row");
    completedRow.hidden = !record.completedAt;
    if (record.completedAt) setText("detail-completed", window.DoomiData.formatLongDate(record.completedAt));

    showModal(elements.drawerBackdrop, elements.drawerClose, trigger);
  }

  function openViewer(entry, trigger) {
    setText("viewer-name", entry.nickname);
    setText("viewer-id", "SOOP ID · " + entry.soopId);
    setText("viewer-total", entry.total.toLocaleString("ko-KR"));
    setText("viewer-active", entry.active.toLocaleString("ko-KR"));
    setText("viewer-done", entry.done.toLocaleString("ko-KR"));

    fillAvatar(document.getElementById("viewer-avatar"), entry);

    var list = document.getElementById("viewer-kinds");
    list.replaceChildren();
    [...entry.kinds.entries()]
      .filter(function (pair) { return pair[1] > 0; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .forEach(function (pair) {
        var item = document.createElement("li");
        var label = document.createElement("span");
        label.textContent = pair[0];
        var count = document.createElement("b");
        count.textContent = "×" + pair[1];
        item.append(label, count);
        list.appendChild(item);
      });

    elements.viewerSeeRecords.onclick = function () {
      closeModals();
      state.query = entry.soopId;
      state.dateKey = "";
      state.status = "all";
      state.category = "all";
      elements.categoryFilter.value = "all";
      state.visibleCount = PAGE_SIZE;
      elements.searchInput.value = entry.soopId;
      elements.clearSearch.hidden = false;
      elements.statusFilter.value = "all";
      setView("records");
      render();
    };

    showModal(elements.viewerBackdrop, elements.viewerClose, trigger);
  }

  function showModal(backdrop, closeButton, trigger) {
    modalTrigger = trigger;
    openModal = backdrop;
    placeForEmbed(backdrop);
    backdrop.hidden = false;
    document.body.style.overflow = "hidden";
    document.querySelector(".public-sidebar").setAttribute("inert", "");
    document.querySelector(".main-content").setAttribute("inert", "");
    window.addEventListener("keydown", modalKeydown);
    window.requestAnimationFrame(function () { closeButton.focus(); });
  }

  function closeModals() {
    if (!openModal) return;
    openModal.hidden = true;
    openModal = null;
    document.body.style.overflow = "";
    document.querySelector(".public-sidebar").removeAttribute("inert");
    document.querySelector(".main-content").removeAttribute("inert");
    window.removeEventListener("keydown", modalKeydown);
    if (modalTrigger) {
      var trigger = modalTrigger;
      window.requestAnimationFrame(function () { trigger.focus(); });
    }
  }

  function modalKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeModals();
      return;
    }
    if (event.key !== "Tab" || !openModal) return;
    var focusable = openModal.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])");
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function categoryChip(value) {
    var chip = document.createElement("span");
    chip.className = "cat-chip cat-" + window.DoomiData.safeCategory(value);
    chip.textContent = window.DoomiData.categoryLabel(value);
    return chip;
  }

  function fillCategoryFilter() {
    window.DoomiData.categories.forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      elements.categoryFilter.appendChild(option);
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

  /* ---------- embed-safe modal placement ---------- */

  /* Inside an iframe, position:fixed anchors to the whole frame box, which the
     SOOP app sizes at thousands of px. Modals would open far below the fold, so
     in embed we place them at the last click instead. */
  var lastClick = { x: 0, y: 0 };

  function trackClickPoint() {
    document.addEventListener("pointerdown", function (event) {
      lastClick.x = event.pageX;
      lastClick.y = event.pageY;
    }, true);
  }

  function placeForEmbed(backdrop) {
    /* Both cases take the backdrop out of the viewport's frame of reference:
       in an iframe fixed means the whole frame box, and under pcview's
       transform fixed is contained by the transformed body. */
    var detached = document.body.classList.contains("embed")
      || document.body.classList.contains("pcview");
    if (!detached) {
      backdrop.style.top = "";
      backdrop.style.left = "";
      backdrop.style.height = "";
      return;
    }
    /* window.innerHeight inside an iframe is the frame height, which the SOOP
       app sets to thousands of px - not what the reader can see. Cap it. */
    var viewport = Math.min(Math.max(320, window.innerHeight || 640), 720);
    var top = Math.max(0, lastClick.y - viewport * 0.2);
    backdrop.style.top = top + "px";
    backdrop.style.left = "0px";
    backdrop.style.height = viewport + "px";
  }

  function setText(id, value) {
    var element = document.getElementById(id);
    if (element) element.textContent = String(value);
  }
})();
