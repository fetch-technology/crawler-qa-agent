// ----- copy helper + toast -----
let _toastTimer = null;
function showToast(msg, kind = "info") {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `toast toast-${kind}`;
  toast.classList.add("visible");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove("visible"), 1800);
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    showToast("URL copied to clipboard", "ok");
    return true;
  } catch (err) {
    showToast(`Copy failed: ${err.message}`, "err");
    return false;
  }
}

const tasksBody = document.getElementById("tasksBody");
const taskCount = document.getElementById("taskCount");
const queueStatus = document.getElementById("queueStatus");
const errorBanner = document.getElementById("errorBanner");
const newTaskForm = document.getElementById("newTaskForm");
const detailPanel = document.getElementById("detailPanel");
const detailMeta = document.getElementById("detailMeta");
const detailTitle = document.getElementById("detailTitle");
const closeDetailBtn = document.getElementById("closeDetail");
const paneSpins = document.getElementById("pane-spins");
const paneShots = document.getElementById("pane-shots");
const paneLog = document.getElementById("pane-log");
const paneCases = document.getElementById("pane-cases");
const paneContext = document.getElementById("pane-context");
const paneJson = document.getElementById("pane-json");
const paneQa = document.getElementById("pane-qa");
const paneErrors = document.getElementById("pane-errors");
const errorsBadge = document.getElementById("errorsBadge");
const tabs = document.querySelectorAll(".tab");

// Buffer of all log entries for the active task (used by Errors tab to filter).
// Reset on openDetail / retry transition.
let activeLogEntries = [];
const shotModal = document.getElementById("shotModal");
const shotModalImg = document.getElementById("shotModalImg");
const shotModalLabel = document.getElementById("shotModalLabel");
const shotModalClose = document.getElementById("shotModalClose");

let tasks = [];
let activeTaskId = null;
let detailStream = null;
let detailTab = "cases";
// Track last-seen status of active task để phát hiện retry (transition completed/failed → queued)
let activeTaskLastStatus = null;

// ----- initial load -----
refreshTasks();
connectGlobalStream();

// ----- form -----
newTaskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();
  const data = new FormData(newTaskForm);
  const gameUrl = String(data.get("gameUrl") || "").trim();
  const spinsPerTest = Number(data.get("spinsPerTest") || 3);
  const autoStartAll = data.get("autoStartAll") === "on";
  try {
    const r = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gameUrl, spinsPerTest, autoStartAll }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${r.status}`);
    }
    newTaskForm.reset();
    newTaskForm.querySelector('[name="spinsPerTest"]').value = 3;
    refreshTasks();
  } catch (err) {
    showError(err.message);
  }
});

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.remove("hidden");
}
function hideError() {
  errorBanner.classList.add("hidden");
}

// ----- task list -----
async function refreshTasks() {
  try {
    const r = await fetch("/api/tasks");
    tasks = await r.json();
    renderTasks();
  } catch (err) {
    console.error("refreshTasks", err);
  }
}

function renderTasks() {
  tasksBody.innerHTML = "";
  taskCount.textContent = `${tasks.length} total`;
  const running = tasks.filter((t) => t.status === "running").length;
  const queued = tasks.filter((t) => t.status === "queued").length;
  queueStatus.textContent = `${running} running, ${queued} queued`;

  if (tasks.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="10" class="empty">No tasks yet. Add a game URL above to start.</td>`;
    tasksBody.appendChild(tr);
    return;
  }
  for (const task of tasks) tasksBody.appendChild(renderRow(task));
}

function renderRow(task) {
  const tr = document.createElement("tr");
  if (task.id === activeTaskId) tr.classList.add("active");
  const stage = task.stage ?? "init";
  const busy = task.status === "queued" || task.status === "running";
  // Phase buttons: collect luôn có thể (re-run); generate cần stage>=context_ready;
  // run cần stage>=catalog_ready. Disable nếu busy.
  const canCollect = !busy;
  const canGenerate = !busy && (stage === "context_ready" || stage === "catalog_ready" || stage === "tests_done");
  const canRun = !busy && (stage === "catalog_ready" || stage === "tests_done");
  const phaseRunning = busy ? (task.nextPhase ?? "all") : null;
  tr.innerHTML = `
    <td><span class="dot ${task.status}"></span></td>
    <td>${escape(task.gameSlug || "-")}</td>
    <td><span class="pill">${escape(task.provider || "?")}</span></td>
    <td class="url-cell">
      <span class="url-text" title="${escape(task.gameUrl)}">${escape(truncateUrl(task.gameUrl, 60))}</span>
      <button class="btn-icon copy-btn" data-copy="${escape(task.gameUrl)}" title="Copy URL">⎘</button>
    </td>
    <td>
      <span class="pill ${task.status}">${task.status}${phaseRunning ? ` · ${phaseRunning}` : ""}</span>
      <span class="pill stage-${stage}" title="Pipeline stage reached">${stageLabel(stage)}</span>
    </td>
    <td>${task.summary ? `${task.summary.spinCount}/${task.spinsPerTest}` : `0/${task.spinsPerTest}`}</td>
    <td>${task.summary && task.summary.rtp != null ? (task.summary.rtp * 100).toFixed(1) + "%" : "—"}</td>
    <td>${formatDuration(task)}</td>
    <td class="muted">${formatRelative(task.finishedAt || task.startedAt || task.createdAt)}</td>
    <td class="action-row">
      ${(() => {
        // Single "next phase" button — chỉ show phase tiếp theo player cần click
        // Full phase buttons (Collect/Generate/Run/Stats/Re-record) đều có trong detail panel
        if (task.status === "queued" || task.status === "running") {
          return `<button class="btn small" data-action="cancel" data-id="${task.id}">${task.status === "running" ? "Stop" : "Cancel"}</button>`;
        }
        if (canCollect && stage === "init") {
          return `<button class="btn small primary phase-btn" data-action="phase" data-phase="collect" data-id="${task.id}" title="Next phase">▶ Collect</button>`;
        }
        if (canGenerate && (stage === "context_ready")) {
          return `<button class="btn small primary phase-btn" data-action="phase" data-phase="generate" data-id="${task.id}" title="Next phase">▶ Generate</button>`;
        }
        if (canRun && (stage === "catalog_ready" || stage === "tests_done")) {
          const label = stage === "tests_done" ? "▶ Re-run" : "▶ Run";
          return `<button class="btn small primary phase-btn" data-action="phase" data-phase="run" data-id="${task.id}" title="Next phase">${label}</button>`;
        }
        return "";
      })()}
      ${task.status !== "queued" && task.status !== "running" ? `<button class="btn small danger" data-action="delete" data-id="${task.id}" data-slug="${escape(task.gameSlug || "")}" title="Xóa task + toàn bộ artifact của game">🗑</button>` : ""}
    </td>
  `;
  tr.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    openDetail(task.id);
  });
  tr.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { action, id } = btn.dataset;
      if (action === "phase") {
        const phase = btn.dataset.phase;
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = "starting…";
        try {
          const r = await fetch(`/api/tasks/${id}/${phase}`, { method: "POST" });
          if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${r.status}`);
          }
          showToast(`Phase ${phase} queued`, "ok");
          // Optimistic clear cho stage tương ứng nếu detail đang mở
          if (activeTaskId === id) {
            paneLog.textContent = "";
            if (phase === "collect") {
              paneCases.innerHTML = `<div class="empty">Collect đang chạy — context bundle sẽ sẵn sau.</div>`;
              paneContext.innerHTML = `<div class="empty">Collect đang chạy…</div>`;
            } else if (phase === "generate") {
              paneCases.innerHTML = `<div class="empty">Generate đang chạy — catalog sẽ sẵn sau.</div>`;
            } else if (phase === "run") {
              paneSpins.innerHTML = `<div class="empty">Tests đang chạy…</div>`;
            }
          }
        } catch (err) {
          showToast(`Phase ${phase} failed: ${err.message}`, "err");
          btn.textContent = oldText;
          btn.disabled = false;
        }
        refreshTasks();
        return;
      }
      if (action === "retry") {
        // Optimistic UI clear — không phụ thuộc SSE timing.
        // Log mới (retry-cleared, sau đó pipeline output) tự append qua SSE.
        if (activeTaskId === id) {
          paneLog.textContent = "";
          paneSpins.innerHTML = `<div class="empty">Waiting for spin events…</div>`;
          paneShots.innerHTML = `<div class="empty">Waiting for screenshots…</div>`;
          paneCases.innerHTML = `<div class="empty">Waiting for catalog…</div>`;
        }
        await fetch(`/api/tasks/${id}/retry`, { method: "POST" });
        refreshTasks();
      }
      if (action === "cancel") {
        const currentTask = tasks.find((t) => t.id === id);
        if (currentTask?.status === "running") {
          if (!confirm("Stop this running task? The browser will close, current Playwright test will be killed.")) return;
        }
        btn.disabled = true;
        btn.textContent = "...";
        try {
          await fetch(`/api/tasks/${id}/cancel`, { method: "POST" });
          showToast(currentTask?.status === "running" ? "Cancellation signal sent" : "Task cancelled", "ok");
        } catch (err) {
          showToast(`Cancel failed: ${err.message}`, "err");
        }
        refreshTasks();
      }
      if (action === "delete") {
        const slug = btn.dataset.slug || "(unknown)";
        if (!confirm(`Xóa task "${slug}" và toàn bộ artifact của game này (rules, options, recordings, specs, generated test, screenshots, logs)?\n\nHành động không thể hoàn tác.`)) return;
        btn.disabled = true;
        btn.textContent = "...";
        try {
          const r = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
          if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${r.status}`);
          }
          showToast("Task deleted", "ok");
          if (activeTaskId === id) closeDetail();
        } catch (err) {
          showToast(`Delete failed: ${err.message}`, "err");
          btn.disabled = false;
          btn.textContent = "🗑 Delete";
        }
        refreshTasks();
      }
    });
  });
  tr.querySelectorAll("button.copy-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyToClipboard(btn.dataset.copy);
    });
  });
  return tr;
}

/** Hiện nút Retry all khi: task không busy VÀ đã từng chạy ít nhất 1 phase
 *  (failed/cancelled luôn show, completed chỉ show nếu stage đã advance hoặc đã chạy thật).
 *  Tránh show cho idle task vừa create (status=completed, stage=init, durationMs=null). */
function shouldShowRetry(task) {
  if (task.status === "queued" || task.status === "running") return false;
  if (task.status === "failed" || task.status === "cancelled") return true; // luôn cần retry sau lỗi
  // completed: chỉ show nếu đã chạy thật (có duration hoặc stage > init)
  if (task.status === "completed") {
    return task.durationMs != null || (task.stage && task.stage !== "init");
  }
  return false;
}

function stageLabel(stage) {
  switch (stage) {
    case "init": return "1/3 init";
    case "context_ready": return "1/3 ✓";
    case "catalog_ready": return "2/3 ✓";
    case "tests_done": return "3/3 ✓";
    default: return stage;
  }
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateUrl(url, len) {
  if (url.length <= len) return url;
  return url.slice(0, len - 10) + "…" + url.slice(-8);
}

function formatDuration(task) {
  const ms = task.durationMs ?? (task.startedAt ? Date.now() - Date.parse(task.startedAt) : 0);
  if (!ms || ms < 0) return "—";
  if (ms < 60_000) return (ms / 1000).toFixed(0) + "s";
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function formatRelative(iso) {
  if (!iso) return "—";
  const diff = Date.now() - Date.parse(iso);
  if (diff < 10_000) return "just now";
  if (diff < 60_000) return Math.floor(diff / 1000) + "s ago";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m ago";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h ago";
  return Math.floor(diff / 86_400_000) + "d ago";
}

// ----- detail panel -----
closeDetailBtn.addEventListener("click", closeDetail);
tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    detailTab = tab.dataset.tab;
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    paneCases.classList.toggle("hidden", detailTab !== "cases");
    paneQa.classList.toggle("hidden", detailTab !== "qa");
    paneContext.classList.toggle("hidden", detailTab !== "context");
    paneJson.classList.toggle("hidden", detailTab !== "json");
    paneErrors.classList.toggle("hidden", detailTab !== "errors");
    paneSpins.classList.toggle("hidden", detailTab !== "spins");
    paneShots.classList.toggle("hidden", detailTab !== "shots");
    paneLog.classList.toggle("hidden", detailTab !== "log");
    if (detailTab === "shots" && activeTaskId) loadShots(activeTaskId);
    if (detailTab === "cases" && activeTaskId) loadCases(activeTaskId);
    if (detailTab === "qa" && activeTaskId) loadQaView(activeTaskId);
    if (detailTab === "context" && activeTaskId) loadContext(activeTaskId);
    if (detailTab === "json" && activeTaskId) loadJson(activeTaskId);
    if (detailTab === "errors") renderErrors(activeLogEntries);
  });
});
shotModalClose.addEventListener("click", () => shotModal.classList.add("hidden"));
shotModal.addEventListener("click", (e) => {
  if (e.target === shotModal) shotModal.classList.add("hidden");
});
// ESC để close modal khi đang mở. Bind cả document và window để chắc chắn
// fire bất kể focus đang ở đâu (image, button, body).
function _closeShotModalOnEsc(e) {
  const isEsc = e.key === "Escape" || e.code === "Escape" || e.keyCode === 27;
  if (!isEsc) return;
  if (shotModal.classList.contains("hidden")) return;
  shotModal.classList.add("hidden");
  e.preventDefault();
}
document.addEventListener("keydown", _closeShotModalOnEsc);
window.addEventListener("keydown", _closeShotModalOnEsc);

async function openDetail(taskId) {
  if (detailStream) {
    detailStream.close();
    detailStream = null;
  }
  activeTaskLastStatus = null;
  activeTaskId = taskId;
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  renderTasks();

  detailTitle.textContent = `${task.gameSlug} — ${task.providerName}`;
  renderDetailMeta(task);

  paneSpins.innerHTML = `<div class="empty">Loading spin events…</div>`;
  paneShots.innerHTML = `<div class="empty">Loading screenshots…</div>`;
  paneCases.innerHTML = `<div class="empty">Loading test cases…</div>`;
  paneQa.innerHTML = `<div class="empty">(switch tab to load)</div>`;
  paneContext.innerHTML = `<div class="empty">(switch tab to load)</div>`;
  paneJson.innerHTML = `<div class="empty">(switch tab to load)</div>`;
  paneErrors.innerHTML = `<div class="empty">Loading errors…</div>`;
  paneLog.textContent = "";
  activeLogEntries = [];
  updateErrorsBadge(0);
  loadCases(taskId);

  const [events, log] = await Promise.all([
    fetch(`/api/tasks/${taskId}/events`).then((r) => r.json()),
    fetch(`/api/tasks/${taskId}/log`).then((r) => r.json()),
  ]);
  renderSpins(events);
  activeLogEntries = log;
  renderLog(log);
  renderErrors(log);
  // Sau khi load fresh data, set activeTaskLastStatus để detect retry transition
  activeTaskLastStatus = task.status;

  detailPanel.classList.remove("hidden");
  // Live updates
  detailStream = new EventSource(`/api/tasks/${taskId}/stream`);
  detailStream.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleStream(msg);
    } catch {}
  };
}

function closeDetail() {
  detailPanel.classList.add("hidden");
  activeTaskId = null;
  if (detailStream) {
    detailStream.close();
    detailStream = null;
  }
  renderTasks();
}

function renderDetailMeta(task) {
  const stage = task.stage ?? "init";
  const busy = task.status === "queued" || task.status === "running";
  const canCollect = !busy;
  const canGenerate = !busy && (stage === "context_ready" || stage === "catalog_ready" || stage === "tests_done");
  const canRun = !busy && (stage === "catalog_ready" || stage === "tests_done");
  const phaseRunning = busy ? (task.nextPhase ?? "all") : null;

  detailMeta.innerHTML = `
    <div class="stage-toolbar">
      <div class="stage-toolbar-left">
        <span class="muted">Pipeline:</span>
        <span class="pill stage-${stage}">${stageLabel(stage)}</span>
        ${phaseRunning ? `<span class="pill running">running ${escape(phaseRunning)}</span>` : ""}
      </div>
      <div class="stage-toolbar-right">
        <button class="btn small primary phase-btn" data-action="detail-phase" data-phase="collect" data-id="${task.id}" ${canCollect ? "" : "disabled"}>1. Collect Context</button>
        <button class="btn small primary phase-btn" data-action="detail-phase" data-phase="generate" data-id="${task.id}" ${canGenerate ? "" : "disabled"}>2. Generate Tests</button>
        <button class="btn small primary phase-btn" data-action="detail-phase" data-phase="run" data-id="${task.id}" ${canRun ? "" : "disabled"} title="Smart: auto uses hybrid (deterministic) when scenarios exist, else vision-driven">3. Run Tests</button>
        ${!busy ? `<button class="btn small ghost phase-btn" data-action="run-stats" data-id="${task.id}" title="Statistical RTP/volatility sim (bypass UI)">📊 Run Stats</button>` : ""}
        ${!busy ? `<button class="btn small ghost phase-btn" data-action="record-pregame" data-id="${task.id}" title="Re-record pre-game click sequence (Collect already auto-captures; use this only when game UI changed)">🎬 Re-record Pre-game</button>` : ""}
        ${!busy ? `<button class="btn small ghost phase-btn" data-action="record-ui-flows" data-id="${task.id}" title="Phase 2.5 — LLM record click sequence cho buy_feature/special_bet cases. Test runs sau đó replay deterministic ($0).">🎬 Record UI Flows</button>` : ""}
        ${!busy ? `<button class="btn small ghost phase-btn" data-action="capture-fs-buy" data-id="${task.id}" title="Phase 2.6 — Click Buy Feature (100x) → capture full FS chain (15+ frames). Unblock free_spins tests với real data. Cost ~$0.30 LLM + 100x bet demo credit.">🎰 Capture FS Chain</button>` : ""}
        ${busy ? `<button class="btn small" data-action="detail-cancel" data-id="${task.id}">${task.status === "running" ? "Stop" : "Cancel"}</button>` : ""}
        ${shouldShowRetry(task) ? `<button class="btn small ghost" data-action="detail-retry" data-id="${task.id}" title="Reset everything and re-run from scratch">↻ Retry all</button>` : ""}
        ${!busy ? `<button class="btn small danger" data-action="detail-delete" data-id="${task.id}" data-slug="${escape(task.gameSlug || "")}" title="Xóa task + toàn bộ artifact của game">🗑 Delete</button>` : ""}
      </div>
    </div>
    <div><span>Status</span><strong><span class="pill ${task.status}">${task.status}</span></strong></div>
    <div class="url-meta"><span>Game URL</span>
      <strong class="url-line">
        <span class="url-text" title="${escape(task.gameUrl)}">${escape(truncateUrl(task.gameUrl, 90))}</span>
        <button class="btn-icon copy-btn" data-copy-detail="${escape(task.gameUrl)}" title="Copy full URL">⎘ Copy</button>
      </strong>
    </div>
    <div><span>Spins target</span><strong>${task.spinsPerTest}</strong></div>
    <div><span>Total bet</span><strong>${task.summary ? task.summary.totalBet.toFixed(4) : "—"}</strong></div>
    <div><span>Total win</span><strong>${task.summary ? task.summary.totalWin.toFixed(4) : "—"}</strong></div>
    <div><span>RTP</span><strong>${task.summary && task.summary.rtp != null ? (task.summary.rtp * 100).toFixed(2) + "%" : "—"}</strong></div>
    <div><span>Duration</span><strong>${formatDuration(task)}</strong></div>
    <div><span>Task ID</span>
      <strong class="url-line" style="font-family:var(--mono);font-size:11px">
        ${task.id.slice(0, 8)}…
        <button class="btn-icon copy-btn" data-copy-detail="${escape(task.id)}" title="Copy full task ID">⎘</button>
      </strong>
    </div>
  `;
  detailMeta.querySelectorAll("button.copy-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyToClipboard(btn.dataset.copyDetail);
    });
  });
  // Bind detail panel phase buttons (separate from row buttons để tránh duplicate event)
  detailMeta.querySelectorAll('button[data-action="detail-phase"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const phase = btn.dataset.phase;
      btn.disabled = true;
      const oldText = btn.textContent;
      btn.textContent = "starting…";
      try {
        const r = await fetch(`/api/tasks/${id}/${phase}`, { method: "POST" });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        showToast(`Phase ${phase} queued`, "ok");
        paneLog.textContent = "";
        if (phase === "collect") paneContext.innerHTML = `<div class="empty">Collect đang chạy…</div>`;
        if (phase === "generate") paneCases.innerHTML = `<div class="empty">Generate đang chạy…</div>`;
        if (phase === "run") paneSpins.innerHTML = `<div class="empty">Tests đang chạy…</div>`;
      } catch (err) {
        showToast(`Phase ${phase} failed: ${err.message}`, "err");
        btn.textContent = oldText;
        btn.disabled = false;
      }
      refreshTasks();
    });
  });
  detailMeta.querySelectorAll('button[data-action="run-stats"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const spinsStr = prompt("Số spins để chạy statistical sim?", "1000");
      if (!spinsStr) return;
      const spins = Number(spinsStr);
      if (!Number.isFinite(spins) || spins < 1) {
        showToast("Spins không hợp lệ", "err");
        return;
      }
      btn.disabled = true;
      btn.textContent = "starting…";
      try {
        const r = await fetch(`/api/tasks/${id}/run-stats`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ spins, concurrency: 1, historyAudit: true }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        showToast(`Stats sim queued (${spins} spins)`, "ok");
      } catch (err) {
        showToast(`Stats failed: ${err.message}`, "err");
        btn.disabled = false;
        btn.textContent = "📊 Run Stats";
      }
      refreshTasks();
      refreshTestRuns();
    });
  });
  detailMeta.querySelectorAll('button[data-action="record-pregame"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (!confirm("Re-record pre-game click sequence?\n\nCollect already auto-captures — use this ONLY when game UI changed and existing recording fails replay. ~$0.05-0.20 LLM cost.")) return;
      btn.disabled = true;
      btn.textContent = "recording…";
      try {
        const r = await fetch(`/api/tasks/${id}/record-pregame`, { method: "POST" });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        showToast(`Pre-game recording started`, "ok");
      } catch (err) {
        showToast(`Record failed: ${err.message}`, "err");
        btn.disabled = false;
        btn.textContent = "🎬 Re-record Pre-game";
      }
      refreshTasks();
    });
  });
  detailMeta.querySelectorAll('button[data-action="record-ui-flows"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      btn.disabled = true;
      btn.textContent = "recording…";
      try {
        const r = await fetch(`/api/tasks/${id}/record-ui-flows`, { method: "POST" });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        showToast(`UI flows recording started — watch Full Log`, "ok");
      } catch (err) {
        showToast(`Record failed: ${err.message}`, "err");
        btn.disabled = false;
        btn.textContent = "🎬 Record UI Flows";
      }
      refreshTasks();
    });
  });
  detailMeta.querySelectorAll('button[data-action="capture-fs-buy"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      btn.disabled = true;
      btn.textContent = "capturing…";
      try {
        const r = await fetch(`/api/tasks/${id}/capture-fs-buy`, { method: "POST" });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        showToast(`FS chain capture started — watch Full Log`, "ok");
      } catch (err) {
        showToast(`Capture failed: ${err.message}`, "err");
        btn.disabled = false;
        btn.textContent = "🎰 Capture FS Chain";
      }
      refreshTasks();
    });
  });
  detailMeta.querySelectorAll('button[data-action="detail-cancel"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (task.status === "running" && !confirm("Stop running phase? Subprocess will be killed.")) return;
      btn.disabled = true;
      btn.textContent = "...";
      await fetch(`/api/tasks/${id}/cancel`, { method: "POST" });
      showToast("Cancellation signal sent", "ok");
      refreshTasks();
    });
  });
  detailMeta.querySelectorAll('button[data-action="detail-delete"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const slug = btn.dataset.slug || "(unknown)";
      if (!confirm(`Xóa task "${slug}" và toàn bộ artifact của game này (rules, options, recordings, specs, generated test, screenshots, logs)?\n\nHành động không thể hoàn tác.`)) return;
      btn.disabled = true;
      btn.textContent = "...";
      try {
        const r = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        showToast("Task deleted", "ok");
        closeDetail();
      } catch (err) {
        showToast(`Delete failed: ${err.message}`, "err");
        btn.disabled = false;
        btn.textContent = "🗑 Delete";
      }
      refreshTasks();
    });
  });
  detailMeta.querySelectorAll('button[data-action="detail-retry"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (!confirm("Retry all? Sẽ clean toàn bộ artifact (rules, options, recordings, specs, tests) và queue lại phase=all từ đầu.")) return;
      btn.disabled = true;
      btn.textContent = "...";
      // Optimistic clear (giống row retry)
      paneLog.textContent = "";
      paneSpins.innerHTML = `<div class="empty">Waiting for spin events…</div>`;
      paneShots.innerHTML = `<div class="empty">Waiting for screenshots…</div>`;
      paneCases.innerHTML = `<div class="empty">Waiting for catalog…</div>`;
      paneContext.innerHTML = `<div class="empty">Waiting for context…</div>`;
      try {
        await fetch(`/api/tasks/${id}/retry`, { method: "POST" });
        showToast("Retry queued", "ok");
      } catch (err) {
        showToast(`Retry failed: ${err.message}`, "err");
      }
      refreshTasks();
    });
  });
}

function renderSpins(events) {
  if (!events || events.length === 0) {
    paneSpins.innerHTML = `<div class="empty">No spins yet.</div>`;
    return;
  }
  const rows = [
    `<div class="spin-header"><div>#</div><div>Bet</div><div>Win</div><div>Net</div><div>Balance before</div><div>Balance after</div><div>Status</div></div>`,
  ];
  for (const e of events) {
    const net = e.netChange ?? 0;
    const netClass = net > 0 ? "win" : "loss";
    rows.push(`<div class="spin-row">
      <div class="spin-num">#${e.spinNumber}</div>
      <div class="money">${fmt(e.betAmount)}</div>
      <div class="money">${fmt(e.winAmount)}</div>
      <div class="money net ${netClass}">${net > 0 ? "+" : ""}${fmt(net)}</div>
      <div class="money">${fmt(e.balanceBefore)}</div>
      <div class="money">${fmt(e.balanceAfter)}</div>
      <div class="tag">${escape(e.status || "—")}</div>
    </div>`);
  }
  paneSpins.innerHTML = `<div class="spin-list">${rows.join("")}</div>`;
}

function renderLog(entries) {
  paneLog.textContent = entries
    .map((e) => `[${e.timestamp.slice(11, 19)}] [${e.stream}] ${e.text}`)
    .join("\n");
  paneLog.scrollTop = paneLog.scrollHeight;
}

function renderCaseFailureBlock(r, taskId, status) {
  if (!r) return "";
  const parts = [];

  // Category banner: title + 1-line summary + suggestion
  if (r.errorCategory && r.errorTitle) {
    const catClass = `cat-${r.errorCategory.replace(/_/g, "-")}`;
    parts.push(`<div class="case-error-banner ${catClass}">
      <div class="case-error-banner-head">
        <span class="case-error-cat-badge">${escape(r.errorTitle)}</span>
        ${r.errorLocation ? `<span class="case-error-loc">${escape(r.errorLocation)}</span>` : ""}
      </div>
      ${r.errorSummary ? `<div class="case-error-summary">${escape(r.errorSummary)}</div>` : ""}
      ${r.errorSuggestion ? `<div class="case-error-suggestion"><strong>How to debug:</strong> ${escape(r.errorSuggestion)}</div>` : ""}
    </div>`);
  }

  if (r.error) {
    parts.push(`<div class="case-error">${escape(r.error)}</div>`);
  } else if (status === "failed") {
    // Failed nhưng chưa có error message (live, chưa parse Playwright JSON)
    parts.push(
      `<div class="case-error case-error-pending">Test failed — full error available after the run completes.</div>`,
    );
  }
  if (r.errorStack) {
    parts.push(`<details class="case-stack">
      <summary>Stack trace</summary>
      <pre>${escape(r.errorStack)}</pre>
    </details>`);
  }
  if (r.attachments && r.attachments.length) {
    const links = r.attachments.map((a) => {
      const url = `/api/tasks/${taskId}/attachment?path=${encodeURIComponent(a.path)}`;
      const name = (a.name || a.path || "").toString();
      const isImg = /\.png$/i.test(a.path || "");
      const isVideo = /\.webm$|\.mp4$/i.test(a.path || "");
      const isTrace = /trace\.zip$/i.test(a.path || "") || name === "trace";
      const icon = isImg ? "🖼" : isVideo ? "🎬" : isTrace ? "🧭" : "📎";
      return `<a class="case-attach" href="${url}" target="_blank" rel="noopener">${icon} ${escape(name)}</a>`;
    });
    parts.push(`<div class="case-attachments">${links.join("")}</div>`);
  }
  return parts.join("");
}

async function loadCases(taskId) {
  try {
    const [catalogRes, taskRes] = await Promise.all([
      fetch(`/api/tasks/${taskId}/test-cases`).then((r) => r.json()),
      fetch(`/api/tasks/${taskId}`).then((r) => r.json()),
    ]);
    const catalog = catalogRes.catalog;
    const caseResults = taskRes.caseResults || {};
    const stats = taskRes.caseStats;

    if (!catalog || !catalog.cases || catalog.cases.length === 0) {
      paneCases.innerHTML = `<div class="empty">No test cases yet (generated after Phase A.5).</div>`;
      return;
    }
    const byCat = new Map();
    for (const c of catalog.cases) {
      if (!byCat.has(c.category)) byCat.set(c.category, []);
      byCat.get(c.category).push(c);
    }
    const catLabels = {
      base_game: "Base Game", bet_variation: "Bet Variation", bet_level: "Bet Level",
      bet_boundary: "Bet Boundary",
      autoplay: "Autoplay", buy_feature: "Buy Feature", special_bet: "Special Bet",
      turbo_spin: "Turbo Spin", free_spins: "Free Spins", respin: "Respin",
      history: "History", options: "Options", max_win_cap: "Max Win Cap",
      ui_consistency: "UI Consistency",
      rules_consistency: "Rules Consistency",
      payout_correctness: "Payout Correctness",
      wild_substitution: "Wild Substitution",
      other: "Other",
    };
    const severityColor = { critical: "#ef4444", major: "#f59e0b", minor: "#9ca3af" };
    const statusBadge = {
      pending:  `<span class="case-status pending">⊚ pending</span>`,
      running:  `<span class="case-status running">▶ running</span>`,
      passed:   `<span class="case-status passed">✓ passed</span>`,
      failed:   `<span class="case-status failed">✘ failed</span>`,
      skipped:  `<span class="case-status skipped">— skipped</span>`,
    };

    const statsLine = stats
      ? `<div class="case-stats">
           <span class="case-stats-item passed">✓ ${stats.passed}</span>
           <span class="case-stats-item failed">✘ ${stats.failed}</span>
           <span class="case-stats-item skipped">— ${stats.skipped}</span>
           <span class="case-stats-item pending">⊚ ${stats.pending}</span>
           <span class="muted"> / ${stats.total} total</span>
         </div>`
      : `<div class="muted case-stats-empty">Status updates when tests run</div>`;

    // Toolbar — consolidated (primary actions moved to detail panel header):
    //   - Generate / Run / Stats / Re-record live in detail toolbar (top)
    //   - This row = reports + utilities only
    const downloadLinks = `<div class="case-downloads">
      <a class="btn-icon" href="/api/tasks/${taskId}/case-report.md" target="_blank" title="View Markdown report">📄 report.md</a>
      <a class="btn-icon" href="/api/tasks/${taskId}/case-report.json" title="Download JSON report" download>⬇ report.json</a>
      <a class="btn-icon" href="/playwright-report/" target="_blank" title="Playwright HTML report — visual diff, trace viewer, attachments">📊 playwright report</a>
      <button class="btn-icon" id="scenariosToggle-${taskId}" title="View scenario details (expected bet/win/balance)">📋 scenarios</button>
      <button class="btn-icon" id="updateBaselines-${taskId}" title="Re-capture snapshot baselines (region pixel + JSON shape). Yêu cầu hybrid spec đã gen.">🔄 update baselines</button>
      <span class="muted" id="hybridStatus-${taskId}"></span>
    </div>
    <div id="scenariosPanel-${taskId}" class="scenarios-panel" style="display:none;margin-top:8px;padding:8px;border:1px solid #ddd;border-radius:4px;background:#fafafa;font-size:12px;"></div>
    <span class="muted hidden" id="statsStatus-${taskId}"></span>
    <div id="statsReport-${taskId}" class="stats-report" style="margin-top:8px;"></div>`;

    // Wire up handlers sau khi DOM render
    setTimeout(() => {
      const status = document.getElementById(`hybridStatus-${taskId}`);
      const scenToggle = document.getElementById(`scenariosToggle-${taskId}`);
      const scenPanel = document.getElementById(`scenariosPanel-${taskId}`);
      const statsStatus = document.getElementById(`statsStatus-${taskId}`);
      const updateBaselinesBtn = document.getElementById(`updateBaselines-${taskId}`);
      if (!status) return;

      // Initial scenario count + load detail vào panel
      let scenariosCache = null;
      const loadScenarios = () =>
        fetch(`/api/tasks/${taskId}/scenarios`).then(r => r.json()).then(j => {
          scenariosCache = j.scenarios || [];
          status.textContent = scenariosCache.length
            ? ` · ${scenariosCache.length} scenarios available`
            : ` · no scenarios (run Collect first)`;
        });
      loadScenarios();

      // Helper: set status với visible styling (red bold cho error, neutral cho info)
      const setStatus = (text, kind = "info") => {
        status.textContent = text;
        status.className = kind === "error"
          ? "error-status"
          : kind === "success"
            ? "success-status"
            : "muted";
        // Inline style fallback nếu chưa có CSS rule
        if (kind === "error") {
          status.style.color = "#ef4444";
          status.style.fontWeight = "bold";
          status.style.fontSize = "12px";
        } else if (kind === "success") {
          status.style.color = "#22c55e";
          status.style.fontWeight = "bold";
          status.style.fontSize = "12px";
        } else {
          status.style.color = "";
          status.style.fontWeight = "";
          status.style.fontSize = "";
        }
      };

      // Scenarios viewer
      scenToggle.onclick = async () => {
        if (scenPanel.style.display !== "none") {
          scenPanel.style.display = "none";
          return;
        }
        if (!scenariosCache) await loadScenarios();
        const arr = scenariosCache || [];
        if (arr.length === 0) {
          scenPanel.innerHTML = `<em class="muted">No scenarios. Run Collect phase, hoặc <code>npm run extract-scenarios -- &lt;slug&gt;</code></em>`;
        } else {
          scenPanel.innerHTML = arr.map((s) => {
            const exp = s.expected || {};
            const fields = Object.entries(exp)
              .filter(([_, v]) => v !== null && v !== undefined)
              .map(([k, v]) => `<code style="background:#fff;padding:1px 4px;border-radius:2px;border:1px solid #ddd;">${escape(k)}=${escape(JSON.stringify(v))}</code>`)
              .join(" ");
            return `<div style="padding:4px 0;border-bottom:1px dashed #ccc;">
              <strong>${escape(s.name)}</strong> <span class="muted">[${escape(s.label || "?")}]</span><br>
              <span style="line-height:1.8;">${fields || '<em class="muted">no expected fields</em>'}</span>
            </div>`;
          }).join("");
        }
        scenPanel.style.display = "block";
      };

      // Stats report panel — auto-fetch latest + render histogram
      const statsReportPanel = document.getElementById(`statsReport-${taskId}`);
      let lastReportPath = null;
      let statsPollHandle = null;

      const renderStatsReport = (report, reportPath) => {
        if (!report || !statsReportPanel) return;
        const totalSpins = report.spinsSuccessful;
        const failed = report.spinsFailed;
        const rtp = report.observedRTP != null ? (report.observedRTP * 100).toFixed(2) + "%" : "—";
        const hf = report.hitFrequency != null ? (report.hitFrequency * 100).toFixed(2) + "%" : "—";
        const maxWin = report.maxWin;
        const maxMul = report.maxWinMultiplier != null ? report.maxWinMultiplier.toFixed(1) + "×" : "—";
        const dur = (report.durationMs / 1000).toFixed(1);
        const rate = (totalSpins / Math.max(1, report.durationMs / 1000)).toFixed(1);

        // Distribution histogram — ASCII bar
        const buckets = report.winDistribution?.buckets || [];
        const maxPct = Math.max(0.01, ...buckets.map(b => b.pctOfSpins));
        const barWidth = 30;
        const rows = buckets.map(b => {
          const label =
            b.min === 0 && b.max === 0 ? "no win"
            : b.max === null || !isFinite(b.max) ? `${b.min}+ ×`
            : `${b.min}-${b.max} ×`;
          const pct = (b.pctOfSpins * 100).toFixed(2);
          const filled = Math.round((b.pctOfSpins / maxPct) * barWidth);
          const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
          return `<tr>
            <td style="padding:2px 8px;color:#6b7280;font-size:11px;text-align:right;">${escape(label)}</td>
            <td style="padding:2px 8px;font-family:monospace;color:#3b82f6;">${bar}</td>
            <td style="padding:2px 8px;text-align:right;font-size:11px;">${pct}% <span class="muted">(${b.count})</span></td>
          </tr>`;
        }).join("");

        const errors = report.errors || [];
        const errorRows = errors.length > 0
          ? `<div style="margin-top:6px;font-size:11px;color:#ef4444;">
              Errors: ${errors.slice(0, 3).map(e => `<code>×${e.count} ${escape((e.message || "").slice(0, 60))}</code>`).join(" ")}
            </div>`
          : "";

        const consistency = report.consistency || null;
        const consistencySummary = consistency
          ? (() => {
              const mismatch = Number(consistency.payoutMismatches || 0);
              const checked = Number(consistency.spinsChecked || 0);
              const inconclusive = Number(consistency.inconclusive || 0);
              const rate = consistency.mismatchRate != null ? (consistency.mismatchRate * 100).toFixed(3) + "%" : "—";
              const color = mismatch > 0 ? "#ef4444" : "#22c55e";
              return `<div style="margin-top:10px;padding:8px;border:1px solid #e5e7eb;border-radius:6px;background:#fff;">
                <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">Payout consistency (rule-engine vs server)</div>
                <div style="display:flex;gap:14px;flex-wrap:wrap;">
                  <div><span class="muted" style="font-size:11px;">Checked</span> <strong>${checked}</strong></div>
                  <div><span class="muted" style="font-size:11px;">Mismatches</span> <strong style="color:${color};">${mismatch}</strong></div>
                  <div><span class="muted" style="font-size:11px;">Mismatch rate</span> <strong>${rate}</strong></div>
                  <div><span class="muted" style="font-size:11px;">Inconclusive</span> <strong>${inconclusive}</strong></div>
                </div>
              </div>`;
            })()
          : `<div style="margin-top:10px;padding:8px;border:1px solid #e5e7eb;border-radius:6px;background:#fff;font-size:11px;color:#6b7280;">Payout consistency: not available (spec missing or check disabled).</div>`;

        const mismatchSamples = consistency?.examples || [];
        const mismatchRows = mismatchSamples.length > 0
          ? `<div style="margin-top:8px;padding:8px;border:1px solid #fee2e2;border-radius:6px;background:#fff7f7;">
              <div style="font-size:11px;color:#991b1b;margin-bottom:6px;">First ${Math.min(10, mismatchSamples.length)} mismatch samples</div>
              <div style="display:grid;gap:4px;">
                ${mismatchSamples.slice(0, 10).map((ex) => `<div style="font-size:11px;color:#7f1d1d;font-family:ui-monospace, SFMono-Regular, Menlo, monospace;">spin#${escape(String(ex.spinIndex))} expected=${escape(Number(ex.expected).toFixed(4))} actual=${escape(Number(ex.actual).toFixed(4))} Δ=${escape(Number(ex.delta).toFixed(4))}</div>`).join("")}
              </div>
            </div>`
          : "";

        const history = report.historyAudit || null;
        const historyBadge = history?.enabled
          ? history.fetched
            ? history.fieldMismatches > 0 || history.missing > 0
              ? `<div style="margin-top:8px;font-size:11px;color:#b45309;">History audit: mismatches=${history.fieldMismatches}, missing=${history.missing}</div>`
              : `<div style="margin-top:8px;font-size:11px;color:#15803d;">History audit: all matched</div>`
            : `<div style="margin-top:8px;font-size:11px;color:#6b7280;">History audit skipped: ${escape(history.reason || "unknown")}</div>`
          : "";
        const historySamples = history?.examples || [];
        const historyMismatchRows = historySamples.length > 0
          ? `<div style="margin-top:8px;padding:8px;border:1px solid #fde68a;border-radius:6px;background:#fffbeb;">
              <div style="font-size:11px;color:#92400e;margin-bottom:6px;">First ${Math.min(10, historySamples.length)} history mismatch samples</div>
              <div style="display:grid;gap:4px;">
                ${historySamples.slice(0, 10).map((ex) => `<div style="font-size:11px;color:#78350f;font-family:ui-monospace, SFMono-Regular, Menlo, monospace;">spin#${escape(String(ex.spinIndex))} field=${escape(String(ex.field))} expected=${escape(Number(ex.expected).toFixed(4))} actual=${escape(Number(ex.actual).toFixed(4))}</div>`).join("")}
              </div>
            </div>`
          : "";

        const downloadUrl = `/api/tasks/${taskId}/attachment?path=${encodeURIComponent(reportPath)}`;

        statsReportPanel.innerHTML = `
          <div style="border:1px solid #ddd;border-radius:6px;padding:10px;background:#fafafa;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <div>
                <strong>Latest stats report</strong>
                <span class="muted" style="font-size:11px;margin-left:8px;">${totalSpins}/${totalSpins + failed} spins · ${dur}s · ${rate} spins/s</span>
              </div>
              <div>
                <button class="btn-icon" id="statsRefresh-${taskId}" title="Re-fetch latest report">🔄 refresh</button>
                <a class="btn-icon" href="${downloadUrl}" download title="Download report JSON">⬇ json</a>
              </div>
            </div>
            <div style="display:flex;gap:16px;margin-bottom:8px;padding:6px 8px;background:#fff;border-radius:4px;border:1px solid #eee;">
              <div><span class="muted" style="font-size:11px;">RTP</span> <strong style="font-size:14px;color:${report.observedRTP > 1.05 || report.observedRTP < 0.85 ? "#f59e0b" : "#22c55e"};">${rtp}</strong></div>
              <div><span class="muted" style="font-size:11px;">Hit freq</span> <strong style="font-size:14px;">${hf}</strong></div>
              <div><span class="muted" style="font-size:11px;">Max win</span> <strong style="font-size:14px;">${maxWin} <span class="muted" style="font-size:11px;">(${maxMul} bet)</span></strong></div>
              <div><span class="muted" style="font-size:11px;">Total bet</span> <strong style="font-size:14px;">${report.totalBet.toFixed(2)}</strong></div>
              <div><span class="muted" style="font-size:11px;">Total win</span> <strong style="font-size:14px;">${report.totalWin.toFixed(2)}</strong></div>
            </div>
            <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">Win distribution (multiplier of bet):</div>
            <table style="width:100%;font-family:system-ui;">${rows}</table>
            ${consistencySummary}
            ${mismatchRows}
            ${historyBadge}
            ${historyMismatchRows}
            ${errorRows}
            <div class="muted" style="font-size:10px;margin-top:6px;">Source: <code>${escape(reportPath || "(unknown)")}</code></div>
          </div>
        `;
        document.getElementById(`statsRefresh-${taskId}`)?.addEventListener("click", () => loadStatsReport(true));
      };

      const loadStatsReport = async (force = false) => {
        try {
          const r = await fetch(`/api/tasks/${taskId}/stats-report`);
          const j = await r.json();
          if (!j.report) {
            if (force || !lastReportPath) {
              statsReportPanel.innerHTML = `<div class="muted" style="font-size:11px;padding:8px;border:1px dashed #ddd;border-radius:4px;">Chưa có stats report. Click <strong>📊 Run Stats</strong> (toolbar trên) để tạo.</div>`;
            }
            return;
          }
          // Skip render nếu cùng report (tránh flash mỗi 3s)
          if (!force && j.path === lastReportPath) return;
          lastReportPath = j.path;
          renderStatsReport(j.report, j.path);
        } catch {}
      };

      // Load lần đầu khi mở tab
      loadStatsReport(true);

      // Helper set status cho stats row (cùng style với hybrid)
      const setStatsStatus = (text, kind = "info") => {
        statsStatus.textContent = text;
        if (kind === "error") {
          statsStatus.style.color = "#ef4444";
          statsStatus.style.fontWeight = "bold";
          statsStatus.style.fontSize = "12px";
        } else if (kind === "success") {
          statsStatus.style.color = "#22c55e";
          statsStatus.style.fontWeight = "bold";
          statsStatus.style.fontSize = "12px";
        } else {
          statsStatus.style.color = "";
          statsStatus.style.fontWeight = "";
          statsStatus.style.fontSize = "";
        }
      };

      // Update baselines — combined region + JSON (prompt user for type)
      if (updateBaselinesBtn) {
        updateBaselinesBtn.onclick = async () => {
          const choice = prompt(
            "Update baselines:\n  1 = region snapshot only (pixel UI)\n  2 = JSON snapshot only (response shape)\n  3 = both (default)\n\nNhập 1, 2 hoặc 3:",
            "3",
          );
          if (choice === null) return;
          const map = { "1": "region", "2": "json", "3": "both" };
          const type = map[choice.trim()] || "both";
          setStatsStatus(` · updating baselines (${type})...`);
          const r = await fetch(`/api/tasks/${taskId}/update-baselines`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type }),
          });
          const j = await r.json();
          if (j.ok) setStatsStatus(` · re-running hybrid with ${type === "both" ? "REGION + JSON" : type.toUpperCase()} update (watch Full Log)`, "success");
          else setStatsStatus(` · failed: ${j.error}`, "error");
        };
      }
    }, 0);

    const html = [
      `<div class="cases-header">
        <div>
          <div class="cases-count"><strong>${catalog.total_cases}</strong> test cases generated</div>
          <div class="muted">${escape(catalog.game_display_name || catalog.game_slug)} · ${new Date(catalog.generated_at).toLocaleString()}</div>
          ${downloadLinks}
        </div>
        ${statsLine}
      </div>`,
    ];
    for (const [cat, list] of byCat) {
      html.push(`<div class="case-section">
        <div class="case-cat-title">${escape(catLabels[cat] || cat)} <span class="muted">(${list.length})</span></div>`);
      for (const c of list) {
        const r = caseResults[c.id];
        const status = r?.status || "pending";
        const durText = r?.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : "";
        const canRun = status !== "running";
        html.push(`<div class="case-row status-${status}" data-id="${escape(c.id)}">
          <div class="case-row-head">
            <div class="case-sev" style="background:${severityColor[c.severity] || "#666"}" title="${escape(c.severity)}"></div>
            <div class="case-id">${escape(c.id)}</div>
            <div class="case-name">${escape(c.name)}</div>
            ${statusBadge[status] || ""}
            <div class="case-spins muted">${c.spin_count} spin${c.spin_count !== 1 ? "s" : ""}${durText ? ` · ${durText}` : ""}</div>
            <button class="btn small case-run-btn" data-case-id="${escape(c.id)}" ${canRun ? "" : "disabled"} title="Re-run only this test case">▶ Run</button>
          </div>
          <div class="case-desc muted">${escape(c.description)}</div>
          <div class="case-setup"><strong>Setup:</strong> ${escape(c.setup_instructions)}</div>
          ${renderCaseFailureBlock(r, taskId, status)}
          ${c.expected_bet != null ? `<div class="muted">Expected bet: $${c.expected_bet}</div>` : ""}
          ${c.custom_assertions && c.custom_assertions.length > 0
            ? `<details class="case-asserts"><summary>${c.custom_assertions.length} custom assertions</summary>${c.custom_assertions.map((a) => `<div class="assert-row"><code>${escape(a.id)}</code>: ${escape(a.description)}</div>`).join("")}</details>`
            : ""}
          <details class="case-shots" data-case-id="${escape(c.id)}">
            <summary>Screenshots</summary>
            <div class="case-shots-grid"><span class="muted">Click to load…</span></div>
          </details>
        </div>`);
      }
      html.push(`</div>`);
    }
    if (catalog.coverage_notes && catalog.coverage_notes.length) {
      html.push(
        `<div class="case-coverage"><strong>Coverage notes:</strong><ul>${catalog.coverage_notes.map((n) => `<li>${escape(n)}</li>`).join("")}</ul></div>`,
      );
    }
    paneCases.innerHTML = html.join("");

    // Lazy-load per-case screenshots khi user mở details
    paneCases.querySelectorAll(".case-shots").forEach((det) => {
      det.addEventListener("toggle", async () => {
        if (!det.open) return;
        const caseId = det.dataset.caseId;
        const grid = det.querySelector(".case-shots-grid");
        if (!grid || grid.dataset.loaded === "1") return;
        try {
          const r = await fetch(`/api/tasks/${taskId}/cases/${encodeURIComponent(caseId)}/screenshots`);
          const { files } = await r.json();
          if (!files || files.length === 0) {
            grid.innerHTML = `<div class="muted empty-shots">No screenshots for this case yet.</div>`;
          } else {
            grid.innerHTML = files
              .map((f) => {
                const label = f.replace(/^\d+-/, "").replace(/\.png$/, "");
                const url = `/api/tasks/${taskId}/screenshots/${encodeURIComponent(caseId)}/${encodeURIComponent(f)}`;
                return `<div class="shot case-shot" data-url="${url}" data-label="${escape(f)}">
                  <img loading="lazy" src="${url}" alt="${escape(label)}" />
                  <div class="shot-label" title="${escape(f)}">${escape(label)}</div>
                </div>`;
              })
              .join("");
            grid.querySelectorAll(".case-shot").forEach((el) => {
              el.addEventListener("click", () => {
                shotModalImg.src = el.dataset.url;
                shotModalLabel.textContent = el.dataset.label;
                shotModal.classList.remove("hidden");
              });
            });
          }
          grid.dataset.loaded = "1";
        } catch (err) {
          grid.innerHTML = `<div class="empty">Failed to load: ${escape(err.message)}</div>`;
        }
      });
    });

    // Wire up per-case Run buttons
    paneCases.querySelectorAll(".case-run-btn").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const caseId = btn.dataset.caseId;
        if (!caseId) return;
        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = "starting…";
        try {
          const r = await fetch(`/api/tasks/${taskId}/cases/${encodeURIComponent(caseId)}/run`, {
            method: "POST",
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            alert(`Không chạy được case "${caseId}": ${j.error || r.statusText}`);
            btn.disabled = false;
            btn.textContent = oldText;
            return;
          }
          // Invalidate screenshot cache cho case này — sẽ fetch lại khi user mở
          const det = paneCases.querySelector(`.case-shots[data-case-id="${caseId}"] .case-shots-grid`);
          if (det) {
            det.dataset.loaded = "";
            det.innerHTML = `<span class="muted">Click to load…</span>`;
          }
          // SSE sẽ cập nhật status — fallback re-render sau 1s
          setTimeout(() => loadCases(taskId), 800);
        } catch (err) {
          alert(`Lỗi: ${err.message}`);
          btn.disabled = false;
          btn.textContent = oldText;
        }
      });
    });
  } catch (err) {
    paneCases.innerHTML = `<div class="empty">Failed to load test cases: ${escape(err.message)}</div>`;
  }
}

async function loadQaView(taskId) {
  try {
    paneQa.innerHTML = `<div class="empty">Loading QA view…</div>`;
    const [catalogRes, snapshotsRes] = await Promise.all([
      fetch(`/api/tasks/${taskId}/test-cases`).then((r) => r.json()),
      fetch(`/api/tasks/${taskId}/json-snapshots`).then((r) => r.json()),
    ]);
    const catalog = catalogRes.catalog;
    if (!catalog || !catalog.cases || catalog.cases.length === 0) {
      paneQa.innerHTML = `<div class="empty">No test cases yet (generate Phase A.5 first).</div>`;
      return;
    }
    const spec = snapshotsRes?.snapshots?.game_spec?.content || null;
    const invariants = Array.isArray(spec?.invariants) ? spec.invariants : [];
    const invMap = new Map();
    for (const inv of invariants) invMap.set(inv.id, inv);

    const catLabels = {
      base_game: "Base Game", bet_variation: "Bet Variation", bet_level: "Bet Level",
      bet_boundary: "Bet Boundary",
      autoplay: "Autoplay", buy_feature: "Buy Feature", special_bet: "Special Bet",
      turbo_spin: "Turbo Spin", free_spins: "Free Spins", respin: "Respin",
      history: "History", options: "Options", max_win_cap: "Max Win Cap",
      ui_consistency: "UI Consistency",
      rules_consistency: "Rules Consistency",
      payout_correctness: "Payout Correctness",
      wild_substitution: "Wild Substitution",
      other: "Other",
    };
    const sevColor = { critical: "#ef4444", major: "#f59e0b", minor: "#9ca3af" };

    const byCat = new Map();
    for (const c of catalog.cases) {
      if (!byCat.has(c.category)) byCat.set(c.category, []);
      byCat.get(c.category).push(c);
    }

    const renderSteps = (c) => {
      const steps = [];
      const setup = (c.setup_instructions || "").trim();
      if (setup) {
        // Format mới: "Step 1: ... Step 2: ... Step N: ..."
        const stepRegex = /Step\s*\d+\s*:\s*([^]*?)(?=Step\s*\d+\s*:|$)/gi;
        let m;
        while ((m = stepRegex.exec(setup)) !== null) {
          const body = (m[1] || "").trim().replace(/[.\s]+$/, "");
          if (body) steps.push(body);
        }
        // Fallback nếu không match format Step N: (catalog cũ)
        if (steps.length === 0) {
          const sentences = setup
            .split(/(?<=[.!?])\s+(?=[A-Z])/)
            .map((s) => s.trim())
            .filter(Boolean);
          for (const s of sentences) steps.push(s);
        }
      } else {
        steps.push("(no pre-spin setup — start from default state)");
      }
      const n = c.spin_count || 0;
      if (n > 0) steps.push(`Run ${n} spin${n > 1 ? "s" : ""} and capture each spin response.`);
      return `<ol class="qa-steps">${steps.map((s) => `<li>${escape(s)}</li>`).join("")}</ol>`;
    };

    const renderInputs = (c) => {
      const rows = [];
      if (c.expected_bet != null) rows.push(["expected_bet", String(c.expected_bet)]);
      if (c.expected_config && Object.keys(c.expected_config).length) {
        for (const [k, v] of Object.entries(c.expected_config)) rows.push([`config.${k}`, String(v)]);
      }
      if (c.spin_count != null) rows.push(["spin_count", String(c.spin_count)]);
      if (c.expected_feature) rows.push(["expected_feature", String(c.expected_feature)]);
      if (rows.length === 0) return `<div class="qa-empty-input">(no specific inputs — defaults from current UI state)</div>`;
      return `<table class="qa-input-table"><tbody>${rows
        .map(([k, v]) => `<tr><th>${escape(k)}</th><td><code>${escape(v)}</code></td></tr>`)
        .join("")}</tbody></table>`;
    };

    const renderExpects = (c) => {
      const items = [];
      const ids = Array.isArray(c.invariant_ids) ? c.invariant_ids : [];
      if (ids.length === 0 && invariants.length > 0) {
        const defaults = invariants.filter((i) => i.severity === "critical" || i.severity === "high" || i.severity === "major");
        for (const inv of defaults) {
          items.push({
            kind: "invariant",
            label: inv.id,
            sev: inv.severity || "major",
            desc: inv.description || "",
            check: inv.check || "",
          });
        }
      } else {
        for (const id of ids) {
          const inv = invMap.get(id);
          items.push({
            kind: "invariant",
            label: id,
            sev: inv?.severity || "major",
            desc: inv?.description || "(invariant ref)",
            check: inv?.check || "",
          });
        }
      }
      for (const a of c.custom_assertions || []) {
        items.push({
          kind: "custom",
          label: a.id,
          sev: "custom",
          desc: a.description || "",
          check: a.check_code || "",
        });
      }
      if (items.length === 0) return `<div class="qa-empty-input">(no expectations — observational case)</div>`;
      return `<ul class="qa-expects">${items
        .map(
          (it) =>
            `<li class="qa-expect qa-expect-${it.kind}">
              <div class="qa-expect-head">
                <span class="qa-expect-kind">${it.kind === "custom" ? "✓" : "🔒"}</span>
                <code class="qa-expect-id">${escape(it.label)}</code>
                <span class="qa-expect-sev sev-${it.sev}">${escape(it.sev)}</span>
              </div>
              ${it.desc ? `<div class="qa-expect-desc">${escape(it.desc)}</div>` : ""}
              ${it.check ? `<details class="qa-expect-check"><summary>check</summary><pre><code>${escape(it.check)}</code></pre></details>` : ""}
            </li>`,
        )
        .join("")}</ul>`;
    };

    const html = [
      `<div class="qa-header">
        <div>
          <strong>${catalog.total_cases}</strong> test cases
          <span class="muted"> · ${escape(catalog.game_display_name || catalog.game_slug)} · ${new Date(catalog.generated_at).toLocaleString()}</span>
        </div>
        <div class="qa-actions">
          <a class="btn-icon" href="/api/tasks/${taskId}/test-cases.md" target="_blank" title="View Markdown in browser">📄 view .md</a>
          <a class="btn-icon" href="/api/tasks/${taskId}/test-cases.md?download=1" title="Download Markdown" download>⬇ .md</a>
          <a class="btn-icon" href="/api/tasks/${taskId}/test-cases.csv?download=1" title="Download CSV (Excel/Sheets-ready)" download>📊 .csv</a>
        </div>
        <div class="qa-legend">
          <span class="qa-legend-item">🔒 invariant (from spec)</span>
          <span class="qa-legend-item">✓ custom assertion</span>
        </div>
      </div>`,
    ];

    for (const [cat, list] of byCat) {
      html.push(`<div class="qa-section">
        <h3 class="qa-section-title">${escape(catLabels[cat] || cat)} <span class="muted">(${list.length})</span></h3>`);
      for (const c of list) {
        html.push(`<article class="qa-card">
          <header class="qa-card-head">
            <span class="qa-card-id">${escape(c.id)}</span>
            <span class="qa-card-sev" style="background:${sevColor[c.severity] || "#6b7280"}">${escape(c.severity || "minor")}</span>
            <h4 class="qa-card-name">${escape(c.name || c.id)}</h4>
          </header>
          ${c.description ? `<p class="qa-card-desc">${escape(c.description)}</p>` : ""}
          <div class="qa-grid">
            <section class="qa-block">
              <div class="qa-block-title">Step</div>
              ${renderSteps(c)}
            </section>
            <section class="qa-block">
              <div class="qa-block-title">Input</div>
              ${renderInputs(c)}
            </section>
            <section class="qa-block">
              <div class="qa-block-title">Expect</div>
              ${renderExpects(c)}
            </section>
          </div>
        </article>`);
      }
      html.push(`</div>`);
    }
    paneQa.innerHTML = html.join("");
  } catch (err) {
    paneQa.innerHTML = `<div class="empty">Failed to load QA view: ${escape(err.message)}</div>`;
  }
}

async function loadShots(taskId) {
  try {
    const r = await fetch(`/api/tasks/${taskId}/screenshots`);
    const { files = [], byCase = {} } = await r.json();
    const totalCases = Object.keys(byCase).length;
    if (files.length === 0 && totalCases === 0) {
      paneShots.innerHTML = `<div class="empty">No screenshots yet.</div>`;
      return;
    }

    const renderTile = (caseId, file) => {
      const label = file.replace(/^\d+-/, "").replace(/\.png$/, "");
      const path = caseId
        ? `${encodeURIComponent(caseId)}/${encodeURIComponent(file)}`
        : encodeURIComponent(file);
      return `<div class="shot" data-url="/api/tasks/${taskId}/screenshots/${path}" data-label="${escape(file)}">
        <img loading="lazy" src="/api/tasks/${taskId}/screenshots/${path}" alt="${escape(label)}" />
        <div class="shot-label" title="${escape(file)}">${escape(label)}</div>
      </div>`;
    };

    const sections = [];
    if (files.length) {
      sections.push(`<div class="shots-section">
        <div class="shots-section-title">Pre-game / global <span class="muted">(${files.length})</span></div>
        <div class="shots-grid">${files.map((f) => renderTile(null, f)).join("")}</div>
      </div>`);
    }
    for (const [caseId, list] of Object.entries(byCase)) {
      sections.push(`<div class="shots-section">
        <div class="shots-section-title">${escape(caseId)} <span class="muted">(${list.length})</span></div>
        <div class="shots-grid">${list.map((f) => renderTile(caseId, f)).join("")}</div>
      </div>`);
    }
    paneShots.innerHTML = sections.join("");

    paneShots.querySelectorAll(".shot").forEach((el) => {
      el.addEventListener("click", () => {
        shotModalImg.src = el.dataset.url;
        shotModalLabel.textContent = el.dataset.label;
        shotModal.classList.remove("hidden");
      });
    });
  } catch (err) {
    paneShots.innerHTML = `<div class="empty">Failed to load screenshots: ${escape(err.message)}</div>`;
  }
}

function fmt(v) {
  if (v == null) return "—";
  return Number(v).toFixed(4);
}

// ----- global stream -----
function connectGlobalStream() {
  const es = new EventSource("/api/stream");
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleGlobalStream(msg);
    } catch {}
  };
  es.onerror = () => {
    setTimeout(() => connectGlobalStream(), 2_000);
    es.close();
  };
}

function handleGlobalStream(msg) {
  if (msg.type === "task_created" || msg.type === "task_updated") {
    // merge into tasks list
    const idx = tasks.findIndex((t) => t.id === msg.task.id);
    if (idx >= 0) tasks[idx] = msg.task;
    else tasks.unshift(msg.task);
    renderTasks();
    if (activeTaskId === msg.task.id) renderDetailMeta(msg.task);
  } else if (msg.type === "task_deleted") {
    tasks = tasks.filter((t) => t.id !== msg.taskId);
    if (activeTaskId === msg.taskId) closeDetail();
    renderTasks();
  }
}

function handleStream(msg) {
  if (msg.type === "spin" && msg.taskId === activeTaskId) {
    fetch(`/api/tasks/${activeTaskId}/events`).then((r) => r.json()).then(renderSpins);
  } else if (msg.type === "log" && msg.taskId === activeTaskId) {
    const line = `[${msg.entry.timestamp.slice(11, 19)}] [${msg.entry.stream}] ${msg.entry.text}`;
    paneLog.textContent += (paneLog.textContent ? "\n" : "") + line;
    paneLog.scrollTop = paneLog.scrollHeight;
    activeLogEntries.push(msg.entry);
    // Increment badge nếu entry này là error/warn — không re-render full pane mỗi tick.
    const sev = classifyLogSeverity(msg.entry);
    if (sev) {
      const cur = Number(errorsBadge.textContent || "0") + 1;
      updateErrorsBadge(cur);
      // Nếu user đang mở tab Errors, append entry mới vào DOM thay vì re-render.
      if (detailTab === "errors") appendErrorEntry(msg.entry, sev);
    }
  } else if (msg.type === "task_updated" && msg.task.id === activeTaskId) {
    const newStatus = msg.task.status;
    // Retry detection từ SSE (vd retry trigger từ tab khác): clear panes.
    // Log mới sẽ tự append qua các log SSE event tiếp theo.
    if (
      newStatus === "queued" &&
      activeTaskLastStatus &&
      activeTaskLastStatus !== "queued"
    ) {
      paneLog.textContent = "";
      paneSpins.innerHTML = `<div class="empty">Waiting for spin events…</div>`;
      paneShots.innerHTML = `<div class="empty">Waiting for screenshots…</div>`;
      paneCases.innerHTML = `<div class="empty">Waiting for catalog…</div>`;
      paneContext.innerHTML = `<div class="empty">Waiting for context…</div>`;
      paneJson.innerHTML = `<div class="empty">Waiting for JSON snapshots…</div>`;
      paneErrors.innerHTML = `<div class="empty">Waiting for errors…</div>`;
      activeLogEntries = [];
      updateErrorsBadge(0);
    }
    activeTaskLastStatus = newStatus;
    renderDetailMeta(msg.task);
    // Nếu tab Cases đang mở, reload cases
    if (detailTab === "cases") loadCases(activeTaskId);
    if (detailTab === "context") loadContext(activeTaskId);
    if (detailTab === "json") loadJson(activeTaskId);
    if (detailTab === "errors") renderErrors(activeLogEntries);
  } else if (msg.type === "case_result" && msg.taskId === activeTaskId) {
    // Reload cases để update badge
    if (detailTab === "cases") loadCases(activeTaskId);
  }
}

// ----- Context tab: hiển thị inputs (rules, config, options, samples) AI đã dùng -----
async function loadContext(taskId) {
  paneContext.innerHTML = `<div class="empty">Loading context bundle…</div>`;
  try {
    const r = await fetch(`/api/tasks/${taskId}/catalog-context`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { context, spec, structured_config } = await r.json();
    if (!context) {
      paneContext.innerHTML = `<div class="empty">No context bundle yet (generated after Phase A.5).</div>`;
      return;
    }
    paneContext.innerHTML = renderContextHtml({ context, spec, structured_config });

    // Toggle behavior cho details — không cần extra wiring vì <details> native.
    // Bind copy buttons cho code blocks.
    paneContext.querySelectorAll(".copy-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.target;
        const el = paneContext.querySelector(`#${targetId}`);
        if (el) copyToClipboard(el.textContent ?? "");
      });
    });
  } catch (err) {
    paneContext.innerHTML = `<div class="empty">Failed to load context: ${escape(err.message)}</div>`;
  }
}

function renderContextHtml({ context, spec, structured_config }) {
  const meta = context.catalog_meta ?? {};
  const inputs = context.inputs ?? {};
  const sections = [];

  // Header
  sections.push(`
    <div class="ctx-header">
      <div><strong>Generated:</strong> ${escape(context.generated_at ?? "?")}</div>
      <div><strong>Game:</strong> ${escape(context.game_slug ?? "?")} — ${escape(context.game_url_redacted ?? "")}</div>
      <div><strong>Inputs used:</strong> ${(meta.inputs_used ?? []).map(s => `<span class="badge">${escape(s)}</span>`).join(" ")}</div>
      <div class="ctx-stats">
        ${badge("rules chars", meta.rules_chars)}
        ${badge("paytable symbols", meta.paytable_symbols_count)}
        ${badge("bet sizes", meta.bet_sizes_count)}
        ${badge("config features", meta.features_count)}
        ${badge("spin samples", meta.sample_spin_count)}
        ${badge("plan categories", (meta.plan_categories ?? []).length)}
        ${meta.elapsed_ms != null ? badge("elapsed", `${(meta.elapsed_ms / 1000).toFixed(1)}s`) : ""}
      </div>
    </div>
  `);

  // 1. Rules markdown
  sections.push(collapsibleBlock({
    title: `Rules markdown (${(inputs.rules_markdown ?? "").length} chars, source=${escape(inputs.rules_source ?? "?")})`,
    bodyHtml: inputs.rules_markdown
      ? `<pre class="ctx-pre" id="ctx-rules">${escape(inputs.rules_markdown)}</pre>
         <button class="btn small copy-btn" data-target="ctx-rules">Copy</button>`
      : `<div class="empty">(no rules markdown)</div>`,
    open: true,
  }));

  // 2. Paytable in-session capture
  sections.push(collapsibleBlock({
    title: inputs.paytable_markdown
      ? `Paytable (in-session capture, ${inputs.paytable_markdown.length} chars)`
      : `Paytable (NOT captured — fall back to play-screen-derived rules)`,
    bodyHtml: inputs.paytable_markdown
      ? `<pre class="ctx-pre" id="ctx-paytable">${escape(inputs.paytable_markdown)}</pre>
         <button class="btn small copy-btn" data-target="ctx-paytable">Copy</button>`
      : `<div class="empty muted">Set <code>OPTIONS_SKIP_PAYTABLE=0</code> (default) to enable, or check options run for failure logs.</div>`,
  }));

  // 3. Structured config (parsed)
  if (structured_config) {
    const parts = [];
    if (structured_config.bet_table) {
      parts.push(`<h4>Bet table</h4>`);
      if (structured_config.bet_table.sizes) {
        parts.push(`<div><strong>Sizes (${structured_config.bet_table.sizes.length}):</strong> ${structured_config.bet_table.sizes.slice(0, 50).map(n => `<span class="chip">${n}</span>`).join("")}${structured_config.bet_table.sizes.length > 50 ? " …" : ""}</div>`);
      }
      if (structured_config.bet_table.levels) {
        parts.push(`<div><strong>Levels:</strong> ${structured_config.bet_table.levels.map(n => `<span class="chip">${n}</span>`).join("")}</div>`);
      }
    }
    if (structured_config.paytable && structured_config.paytable.length) {
      parts.push(`<h4>Paytable from config (${structured_config.paytable.length} symbols)</h4>`);
      parts.push(`<table class="ctx-table"><thead><tr><th>Symbol</th><th>Multipliers</th></tr></thead><tbody>`);
      for (const p of structured_config.paytable.slice(0, 50)) {
        const mults = p.multipliers ? Object.entries(p.multipliers).map(([k,v]) => `${k}=${escape(String(v))}`).join(", ") : escape(p.raw ?? "—");
        parts.push(`<tr><td><strong>${escape(p.symbol)}</strong></td><td><code>${mults}</code></td></tr>`);
      }
      parts.push(`</tbody></table>`);
    }
    if (structured_config.features && structured_config.features.length) {
      parts.push(`<h4>Features detected (${structured_config.features.length})</h4>`);
      for (const f of structured_config.features) {
        parts.push(`<details class="feature-block"><summary><code>${escape(f.name)}</code></summary><pre class="ctx-pre">${escape(JSON.stringify(f.config, null, 2))}</pre></details>`);
      }
    }
    if (structured_config.caps && Object.keys(structured_config.caps).length) {
      parts.push(`<h4>Caps</h4>`);
      for (const [k, v] of Object.entries(structured_config.caps)) {
        parts.push(`<div><span class="chip">${escape(k)}</span> <code>${escape(String(v))}</code></div>`);
      }
    }
    if (structured_config.notes && structured_config.notes.length) {
      parts.push(`<h4>Parser notes</h4><ul>${structured_config.notes.map(n => `<li>${escape(n)}</li>`).join("")}</ul>`);
    }
    sections.push(collapsibleBlock({
      title: `Structured config (parsed from API response)`,
      bodyHtml: parts.length ? parts.join("") : `<div class="empty">(parser found nothing)</div>`,
      open: true,
    }));
  }

  // 4. Raw config
  if (inputs.config_response) {
    const json = JSON.stringify(inputs.config_response, null, 2);
    sections.push(collapsibleBlock({
      title: `Raw config response (${json.length} chars JSON)`,
      bodyHtml: `<pre class="ctx-pre" id="ctx-config">${escape(json)}</pre>
                 <button class="btn small copy-btn" data-target="ctx-config">Copy</button>`,
    }));
  }

  // 5. Options catalog
  if (inputs.options_json) {
    const optsObj = (() => { try { return JSON.parse(inputs.options_json); } catch { return null; } })();
    let optsHtml = `<pre class="ctx-pre" id="ctx-options">${escape(inputs.options_json)}</pre>`;
    if (optsObj && Array.isArray(optsObj.options)) {
      optsHtml = `<table class="ctx-table"><thead><tr><th>Name</th><th>Category</th><th>Type</th><th>Current</th><th>Possible values</th></tr></thead><tbody>`;
      for (const o of optsObj.options) {
        optsHtml += `<tr><td><strong>${escape(o.name)}</strong></td><td><span class="badge">${escape(o.category ?? "?")}</span></td><td>${escape(o.type ?? "?")}</td><td>${escape(o.current_value ?? "—")}</td><td><code>${escape(Array.isArray(o.possible_values) ? o.possible_values.join(", ") : (o.possible_values ?? "—"))}</code></td></tr>`;
      }
      optsHtml += `</tbody></table>`;
    }
    sections.push(collapsibleBlock({
      title: `Options catalog (${optsObj?.optionsCount ?? "?"} UI controls)`,
      bodyHtml: optsHtml,
    }));
  }

  // 6. GameSpec
  if (spec) {
    const json = JSON.stringify(spec, null, 2);
    sections.push(collapsibleBlock({
      title: `GameSpec (${spec.invariants?.length ?? 0} invariants, ${spec.symbols?.length ?? 0} symbols, ${spec.features?.length ?? 0} features)`,
      bodyHtml: `<pre class="ctx-pre" id="ctx-spec">${escape(json)}</pre>
                 <button class="btn small copy-btn" data-target="ctx-spec">Copy</button>`,
    }));
  }

  // 7. Spin samples
  if (Array.isArray(inputs.sample_spin_responses) && inputs.sample_spin_responses.length) {
    const json = JSON.stringify(inputs.sample_spin_responses, null, 2);
    sections.push(collapsibleBlock({
      title: `Spin samples (${inputs.sample_spin_responses.length} normalized responses)`,
      bodyHtml: `<pre class="ctx-pre" id="ctx-spins">${escape(json)}</pre>
                 <button class="btn small copy-btn" data-target="ctx-spins">Copy</button>`,
    }));
  }

  // 8. Network hints
  if (inputs.network_hints) {
    sections.push(collapsibleBlock({
      title: `Network hints (spin endpoint detection)`,
      bodyHtml: `<pre class="ctx-pre" id="ctx-hints">${escape(JSON.stringify(inputs.network_hints, null, 2))}</pre>
                 <button class="btn small copy-btn" data-target="ctx-hints">Copy</button>`,
    }));
  }

  return sections.join("\n");
}

function collapsibleBlock({ title, bodyHtml, open = false }) {
  return `<details class="ctx-section" ${open ? "open" : ""}>
    <summary><strong>${escape(title)}</strong></summary>
    <div class="ctx-body">${bodyHtml}</div>
  </details>`;
}

function badge(label, value) {
  if (value == null || value === "") return "";
  return `<span class="badge"><span class="muted">${escape(label)}:</span> <strong>${escape(String(value))}</strong></span>`;
}

// ----- JSON tab: hiển thị tất cả structured artifact thuần JSON -----
const JSON_BLOCK_ORDER = [
  ["play_screen",     "Play Screen (vision + api)"],
  ["api_snapshot",    "API Snapshot (canonical)"],
  ["options_catalog", "Options Catalog"],
  ["paytable",        "Paytable (in-session capture)"],
  ["game_spec",       "GameSpec"],
  ["catalog_context", "Catalog Context (AI input bundle)"],
  ["network_hints",   "Network Hints"],
  ["summary",         "Recorder Summary"],
];

async function loadJson(taskId) {
  paneJson.innerHTML = `<div class="empty">Loading JSON snapshots…</div>`;
  try {
    const r = await fetch(`/api/tasks/${taskId}/json-snapshots`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { game_slug, options_run, snapshots } = await r.json();
    paneJson.innerHTML = renderJsonHtml({ game_slug, options_run, snapshots });

    // Bind copy buttons
    paneJson.querySelectorAll(".copy-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.target;
        const el = paneJson.querySelector(`#${targetId}`);
        if (el) copyToClipboard(el.textContent ?? "");
      });
    });
    // Bind download buttons
    paneJson.querySelectorAll(".dl-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.dataset.target;
        const filename = btn.dataset.filename || `${targetId}.json`;
        const el = paneJson.querySelector(`#${targetId}`);
        if (!el) return;
        const blob = new Blob([el.textContent ?? ""], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
      });
    });
  } catch (err) {
    paneJson.innerHTML = `<div class="empty">Failed to load JSON: ${escape(err.message)}</div>`;
  }
}

function renderJsonHtml({ game_slug, options_run, snapshots }) {
  const parts = [];
  parts.push(`
    <div class="ctx-header">
      <div><strong>Slug:</strong> ${escape(game_slug ?? "?")}</div>
      ${options_run ? `<div><strong>Latest options run:</strong> <code>${escape(options_run)}</code></div>` : ""}
      <div class="muted" style="font-size:12px">Mỗi block là một file JSON thuần — copy hoặc tải về dùng cho debug / regression test.</div>
    </div>
  `);

  let any = false;
  for (const [key, title] of JSON_BLOCK_ORDER) {
    const entry = snapshots[key];
    if (!entry) continue;
    if (entry.missing) {
      parts.push(`<details class="ctx-section"><summary><strong>${escape(title)}</strong> <span class="muted">(missing)</span></summary>
        <div class="ctx-body"><div class="empty">File chưa tồn tại: <code>${escape(entry.path)}</code></div></div>
      </details>`);
      continue;
    }
    any = true;
    const json = JSON.stringify(entry.content, null, 2);
    const id = `json-${key}`;
    const filename = entry.path.split("/").pop() || `${key}.json`;
    parts.push(`
      <details class="ctx-section" ${key === "play_screen" || key === "api_snapshot" ? "open" : ""}>
        <summary>
          <strong>${escape(title)}</strong>
          <span class="muted" style="font-size:12px"> — ${escape(entry.path)} (${json.length.toLocaleString()} chars)</span>
        </summary>
        <div class="ctx-body">
          <div style="margin-bottom:6px;display:flex;gap:6px">
            <button class="btn small copy-btn" data-target="${id}">Copy</button>
            <button class="btn small dl-btn" data-target="${id}" data-filename="${escape(filename)}">Download</button>
          </div>
          <pre class="ctx-pre" id="${id}">${escape(json)}</pre>
        </div>
      </details>
    `);
  }

  if (!any) {
    parts.push(`<div class="empty">Chưa có JSON snapshot nào — chạy phase Collect trước.</div>`);
  }
  return parts.join("\n");
}

// ----- Errors tab: filter log entries → error/warn với severity badge + nhóm theo phase -----

const NPM_NOISE = /^npm warn Unknown env config|^npm warn config|deprecated/;

const ERROR_PATTERNS = [
  /\bFatal\b/,
  /^\s*Error:/,
  /\b(?:exit|exited)\s+(?:with\s+)?code?\s*[1-9]/i,
  /\bunhandled(Rejection|Exception)/i,
  /\bPageError\b|pageerror/i,
  /\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|\bRangeError\b/,
  /✗|❌/,
  /Thi[ếe]u\s.+(?:dừng|stop)/i,            // "Thiếu CLAUDE_CODE_OAUTH_TOKEN, dừng"
  /Không tìm thấy.+dừng/i,
  /Không\s+derive được.+dừng/i,
  /process\.exit\(/,
  /\bAI error:/,                            // [extract-options] AI error: ...
  /\b(?:thất bại|failed)\s*$/,              // câu kết "extract-options thất bại"
];

const WARN_PATTERNS = [
  /\bwarn\b/i,
  /\bwarning\b/i,
  /⚠/,
  /\bfailed:/,                              // "transcribe failed: ..."
  /\b(?:could not|cannot|can'?t)\b/i,
  /\b(?:fall back|fallback|skip)/i,
  /\bstuck\b/i,
  /không\s+(?:capture|derive|tìm|nhận)/i,    // "không capture được"
  /\b(?:n\/a|N\/A)\b/,
  /\(missing\)/i,
  /retry/i,
  /\btimeout\b/i,
  /AI báo error/i,
  /không\s+đổi/i,                            // "màn hình không đổi"
  /không\s+ready/i,
];

// Explicit WARN markers — line có những marker này được DOWNGRADE từ stderr→error
// thành warn. Lý do: Node's console.warn ghi vào stderr (giống console.error),
// nên một dòng "[xxx] ⚠ ..." đến với stream=stderr nhưng intent là warn.
const EXPLICIT_WARN_MARKERS = [
  /⚠/,
  /^\s*\[[\w\-/.]+\]\s*\(/,           // pattern "[xxx] (note)" — info-style
  /\bwarn(?:ing)?\b/i,
  /^\s*npm\s+warn\b/i,
];

function classifyLogSeverity(entry) {
  const text = entry.text || "";
  if (NPM_NOISE.test(text)) return null;

  // Pattern matching trước stream check — explicit ERROR/WARN markers thắng.
  for (const re of ERROR_PATTERNS) if (re.test(text)) return "error";
  if (EXPLICIT_WARN_MARKERS.some((re) => re.test(text))) return "warn";
  for (const re of WARN_PATTERNS) if (re.test(text)) return "warn";

  // Fallback theo stream: stderr không có pattern match → assume error.
  if (entry.stream === "stderr") return "error";
  return null;
}

// Detect phase tag từ prefix `[xxx]` ngay sau timestamp/stream.
const PHASE_RE = /^\s*\[([\w\-/.]+)\]/;
function detectPhase(text) {
  const m = text && text.match(PHASE_RE);
  return m ? m[1] : "general";
}

function updateErrorsBadge(n) {
  errorsBadge.textContent = String(n);
  errorsBadge.classList.toggle("hidden", n === 0);
  errorsBadge.classList.toggle("badge-error", n > 0);
}

/**
 * Detect + render snapshot mismatch visualization inline trong error row.
 * 2 pattern:
 *   - Region snapshot: parse baseline/actual/diff PNG paths → render 3 ảnh side-by-side
 *   - JSON snapshot: parse [changed]/[added]/[removed] diff lines → colorize
 */
function renderSnapshotDiff(text, taskId) {
  if (!taskId) return "";
  // Region snapshot mismatch
  if (text.startsWith("Region snapshot mismatch:")) {
    const baseline = (text.match(/baseline:\s*(\S+)/) || [])[1];
    const actual = (text.match(/actual:\s*(\S+)/) || [])[1];
    const diff = (text.match(/diff:\s*(\S+\.png)/) || [])[1];
    if (!baseline && !actual) return "";
    const attUrl = (p) => `/api/tasks/${taskId}/attachment?path=${encodeURIComponent(p)}`;
    const cells = [];
    if (baseline) cells.push({ label: "baseline (expected)", url: attUrl(baseline), border: "#9ca3af" });
    if (actual) cells.push({ label: "actual (got)", url: attUrl(actual), border: "#f59e0b" });
    if (diff) cells.push({ label: "diff (red = mismatch)", url: attUrl(diff), border: "#ef4444" });
    return `<div class="snapshot-viz" style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;">
      ${cells.map((c) => `
        <div style="text-align:center;">
          <div style="font-size:11px;color:#6b7280;margin-bottom:2px;">${escape(c.label)}</div>
          <a href="${c.url}" target="_blank">
            <img src="${c.url}" style="max-width:200px;max-height:200px;border:2px solid ${c.border};border-radius:4px;background:#fff;" loading="lazy" />
          </a>
        </div>`).join("")}
    </div>`;
  }
  // JSON snapshot mismatch
  if (text.startsWith("JSON snapshot mismatch:")) {
    const diffLines = [];
    const re = /^\s*\[(changed|added|removed|type_changed)\]\s*(.+)$/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      diffLines.push({ kind: m[1], detail: m[2] });
    }
    if (diffLines.length === 0) return "";
    const colorMap = {
      added: "#22c55e",       // green
      removed: "#ef4444",     // red
      changed: "#f59e0b",     // amber
      type_changed: "#a855f7", // purple
    };
    return `<div class="snapshot-viz" style="margin-top:6px;background:#1f2937;color:#e5e7eb;padding:8px;border-radius:4px;font-family:monospace;font-size:12px;line-height:1.5;">
      ${diffLines.map((d) => `
        <div style="border-left:3px solid ${colorMap[d.kind]};padding-left:8px;margin-bottom:2px;">
          <span style="color:${colorMap[d.kind]};font-weight:bold;">[${d.kind}]</span>
          <span style="color:#e5e7eb;">${escape(d.detail)}</span>
        </div>`).join("")}
    </div>`;
  }
  return "";
}

function renderErrors(entries) {
  const matches = [];
  let errorCount = 0;
  let warnCount = 0;
  for (const e of entries || []) {
    const sev = classifyLogSeverity(e);
    if (!sev) continue;
    matches.push({ entry: e, sev });
    if (sev === "error") errorCount++;
    else warnCount++;
  }
  updateErrorsBadge(matches.length);

  if (matches.length === 0) {
    paneErrors.innerHTML = `<div class="empty err-empty">✓ Không có lỗi/warning nào trong log của task này.</div>`;
    return;
  }

  // Group by phase
  const byPhase = new Map();
  for (const m of matches) {
    const phase = detectPhase(m.entry.text);
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase).push(m);
  }

  const parts = [];
  parts.push(`
    <div class="err-header">
      <div class="err-summary">
        <span class="err-count err-count-error">${errorCount} error${errorCount === 1 ? "" : "s"}</span>
        <span class="err-count err-count-warn">${warnCount} warning${warnCount === 1 ? "" : "s"}</span>
        <span class="muted" style="font-size:12px">across ${byPhase.size} phase${byPhase.size === 1 ? "" : "s"}</span>
      </div>
      <div class="err-filter">
        <label><input type="checkbox" id="errFilterError" checked /> Errors</label>
        <label><input type="checkbox" id="errFilterWarn" checked /> Warnings</label>
        <button class="btn small" id="errCopyAll">Copy all</button>
      </div>
    </div>
  `);

  parts.push(`<div class="err-list">`);
  for (const [phase, ms] of byPhase) {
    parts.push(`<details class="err-phase" open>
      <summary><strong>${escape(phase)}</strong> <span class="muted">${ms.length}</span></summary>
      <div class="err-rows">`);
    for (const { entry, sev } of ms) {
      const ts = (entry.timestamp || "").slice(11, 19);
      const text = entry.text || "";
      const snapshotViz = renderSnapshotDiff(text, activeTaskId);
      parts.push(`<div class="err-row err-row-${sev}" data-sev="${sev}">
        <span class="err-time">${escape(ts)}</span>
        <span class="err-sev err-sev-${sev}">${sev === "error" ? "ERROR" : "WARN"}</span>
        <span class="err-text">${escape(text)}</span>
        ${snapshotViz}
      </div>`);
    }
    parts.push(`</div></details>`);
  }
  parts.push(`</div>`);

  paneErrors.innerHTML = parts.join("");

  // Wire filter checkboxes
  const fe = paneErrors.querySelector("#errFilterError");
  const fw = paneErrors.querySelector("#errFilterWarn");
  const applyFilter = () => {
    const showErr = fe.checked;
    const showWarn = fw.checked;
    paneErrors.querySelectorAll(".err-row").forEach((row) => {
      const sev = row.dataset.sev;
      const visible = (sev === "error" && showErr) || (sev === "warn" && showWarn);
      row.classList.toggle("hidden", !visible);
    });
  };
  fe.addEventListener("change", applyFilter);
  fw.addEventListener("change", applyFilter);

  paneErrors.querySelector("#errCopyAll").addEventListener("click", () => {
    const lines = matches.map(({ entry, sev }) => {
      const ts = (entry.timestamp || "").slice(11, 19);
      return `[${ts}] [${sev.toUpperCase()}] ${entry.text}`;
    });
    copyToClipboard(lines.join("\n"));
  });
}

// Streaming append — gọi mỗi log entry SSE mới khi tab Errors đang mở.
// Tránh re-render full DOM. Đồng thời update count summary (đơn giản: re-render chỉ
// khi cần — phase grouping không hỗ trợ append in-place).
function appendErrorEntry(entry, sev) {
  // Cứ re-render full để đảm bảo grouping + count consistent. Cost thấp vì
  // số entries error/warn thường < 50.
  renderErrors(activeLogEntries);
}

// Refresh relative timestamps every 10s
setInterval(renderTasks, 10_000);

// =============================================================================
// Test Runs (DB) — read-only history backed by Postgres via /api/test-runs/*
// =============================================================================

const testRunsBody = document.getElementById("testRunsBody");
const testRunsStatus = document.getElementById("testRunsStatus");
const testRunsToggle = document.getElementById("testRunsToggle");
const testRunsContent = document.getElementById("testRunsContent");
const testRunsCaret = document.getElementById("testRunsCaret");
const testRunsCount = document.getElementById("testRunsCount");

// Collapsible section — persist state in localStorage. Default: collapsed
// (bảng dài, ít người cần xem mỗi lần mở dashboard).
function setTestRunsCollapsed(collapsed) {
  if (collapsed) {
    testRunsContent.classList.add("hidden");
    testRunsCaret.textContent = "▶";
  } else {
    testRunsContent.classList.remove("hidden");
    testRunsCaret.textContent = "▼";
  }
  try { localStorage.setItem("testRunsCollapsed", collapsed ? "1" : "0"); } catch {}
}
testRunsToggle?.addEventListener("click", () => {
  const isCollapsed = testRunsContent.classList.contains("hidden");
  setTestRunsCollapsed(!isCollapsed);
});
// Apply persisted state on load (default collapsed)
setTestRunsCollapsed(localStorage.getItem("testRunsCollapsed") !== "0");
const testRunDetail = document.getElementById("testRunDetail");
const testRunDetailTitle = document.getElementById("testRunDetailTitle");
const testRunMeta = document.getElementById("testRunMeta");
const testRunDetailClose = document.getElementById("testRunDetailClose");
const testRunSummaryBtn = document.getElementById("testRunSummaryBtn");
const testRunAnalyzerBtn = document.getElementById("testRunAnalyzerBtn");
const runpaneSpins = document.getElementById("runpane-spins");
const runpaneErrors = document.getElementById("runpane-errors");
const runpaneStats = document.getElementById("runpane-stats");
const runpaneSummary = document.getElementById("runpane-summary");
const runpaneAnalyzer = document.getElementById("runpane-analyzer");
const runTabs = document.querySelectorAll("[data-runtab]");

let activeRunId = null;
let activeRunTab = "spins";

function fmtPct(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v * 100).toFixed(digits) + "%";
}
function fmtNum(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return "—";
  return Number(v).toFixed(digits);
}
function fmtAgo(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

async function refreshTestRuns() {
  try {
    const r = await fetch("/api/test-runs");
    const body = await r.json();
    if (!body.enabled) {
      testRunsStatus.textContent = "DB disabled (set DATABASE_URL)";
      if (testRunsCount) testRunsCount.textContent = "(DB disabled)";
      testRunsBody.innerHTML = `<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">
        DATABASE_URL not set. Run <code>npm run db:up && npm run db:migrate</code> then restart server.
      </td></tr>`;
      return;
    }
    const runs = body.runs ?? [];
    testRunsStatus.textContent = `${runs.length} run(s)`;
    if (testRunsCount) testRunsCount.textContent = runs.length > 0 ? `(${runs.length})` : "(empty)";
    if (runs.length === 0) {
      testRunsBody.innerHTML = `<tr><td colspan="9" class="muted" style="text-align:center;padding:24px">
        No test runs yet. Run <code>npm run stats -- &lt;slug&gt; --spins 1000</code> to populate.
      </td></tr>`;
      return;
    }
    testRunsBody.innerHTML = runs
      .map((r) => {
        const sr = r.statReport;
        const errCount = r._count?.validationErrors ?? 0;
        const errCell = errCount > 0
          ? `<span style="color:var(--err)">${errCount}</span>`
          : `<span class="muted">0</span>`;
        return `
        <tr data-runid="${r.id}" class="run-row" style="cursor:pointer">
          <td><strong>${escHtml(r.gameCode)}</strong></td>
          <td><span class="pill ${escHtml(r.status)}">${escHtml(r.status)}</span></td>
          <td>${r.completedSpins ?? 0}/${r.totalSpins ?? 0}</td>
          <td>${sr ? fmtPct(sr.rtp) : "—"}</td>
          <td>${sr ? fmtPct(sr.hitRate) : "—"}</td>
          <td>${sr ? `${fmtNum(sr.volatility)}${sr.volatilityBand ? ` <span class="muted">[${sr.volatilityBand}]</span>` : ""}` : "—"}</td>
          <td>${errCell}</td>
          <td class="muted">${fmtAgo(r.createdAt)}</td>
          <td style="white-space:nowrap">
            <button class="btn small ghost run-open" data-runid="${r.id}">View</button>
            <button class="btn small danger run-delete" data-runid="${r.id}" data-game="${escHtml(r.gameCode)}" title="Delete this run + spins + errors + stat report">🗑</button>
          </td>
        </tr>`;
      })
      .join("");
  } catch (err) {
    testRunsStatus.textContent = `Error: ${err.message}`;
  }
}

testRunsBody.addEventListener("click", async (e) => {
  // Per-row delete (handle first — must take precedence over row-click=view)
  const delBtn = e.target.closest("button.run-delete");
  if (delBtn) {
    e.stopPropagation();
    const runId = delBtn.dataset.runid;
    const game = delBtn.dataset.game || "(unknown)";
    if (!confirm(`Xóa TestRun ${runId.slice(0, 8)}… (${game})?\n\nCascade: spin_results + validation_errors + stat_report sẽ bị xóa.`)) return;
    delBtn.disabled = true;
    try {
      const r = await fetch(`/api/test-runs/${runId}`, { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      showToast("TestRun deleted", "ok");
      // If detail panel is open on this run, close it
      if (activeRunId === runId) {
        testRunDetail.classList.add("hidden");
        activeRunId = null;
      }
      refreshTestRuns();
    } catch (err) {
      showToast(`Delete failed: ${err.message}`, "err");
      delBtn.disabled = false;
    }
    return;
  }
  // Per-row view
  const tr = e.target.closest("tr.run-row");
  if (!tr) return;
  const runId = tr.dataset.runid;
  if (runId) openTestRun(runId);
});

// Section-level "Clear all"
const testRunsClearAllBtn = document.getElementById("testRunsClearAll");
if (testRunsClearAllBtn) {
  testRunsClearAllBtn.addEventListener("click", async () => {
    const filterSlug = prompt(
      "Xóa stats history:\n\n• Để trống → xóa TẤT CẢ\n• Nhập slug → chỉ xóa stats của slug đó\n\nSẽ xóa:\n  - test_runs + cascade (spin_results, validation_errors, stat_reports)\n  - fixtures/statistical/*.json filesystem reports\n\nSlug (rỗng = all):",
      "",
    );
    if (filterSlug === null) return; // user cancelled
    const slug = filterSlug.trim();
    const scope = slug ? `slug "${slug}"` : "TẤT CẢ runs";
    if (!confirm(`Xác nhận xóa ${scope}?\n\nKhông thể hoàn tác.`)) return;
    testRunsClearAllBtn.disabled = true;
    testRunsClearAllBtn.textContent = "Deleting…";
    try {
      const qs = slug ? `?gameCode=${encodeURIComponent(slug)}` : "?all=1";
      const r = await fetch(`/api/test-runs${qs}`, { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      const body = await r.json();
      showToast(`Deleted ${body.dbDeleted ?? 0} DB run(s) + ${body.filesDeleted ?? 0} report file(s)`, "ok");
      testRunDetail.classList.add("hidden");
      activeRunId = null;
      refreshTestRuns();
    } catch (err) {
      showToast(`Clear failed: ${err.message}`, "err");
    } finally {
      testRunsClearAllBtn.disabled = false;
      testRunsClearAllBtn.textContent = "🗑 Reset stats";
    }
  });
}

testRunDetailClose.addEventListener("click", () => {
  testRunDetail.classList.add("hidden");
  activeRunId = null;
});

runTabs.forEach((t) => {
  t.addEventListener("click", () => {
    runTabs.forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    activeRunTab = t.dataset.runtab;
    [runpaneSpins, runpaneErrors, runpaneStats, runpaneSummary, runpaneAnalyzer].forEach((p) =>
      p.classList.add("hidden"),
    );
    document.getElementById(`runpane-${activeRunTab}`).classList.remove("hidden");
    if (activeRunId) loadRunTab(activeRunId, activeRunTab);
  });
});

async function openTestRun(runId) {
  activeRunId = runId;
  testRunDetail.classList.remove("hidden");
  testRunDetailTitle.textContent = `Test Run ${runId.slice(0, 8)}…`;
  testRunMeta.innerHTML = `<div class="muted">Loading…</div>`;
  testRunDetail.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const r = await fetch(`/api/test-runs/${runId}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const run = await r.json();
    renderRunMeta(run);
    loadRunTab(runId, activeRunTab);
  } catch (err) {
    testRunMeta.innerHTML = `<div style="color:var(--err)">Failed to load: ${escHtml(err.message)}</div>`;
  }
}

function renderRunMeta(run) {
  const sr = run.statReport;
  const cells = [
    ["Game", escHtml(run.gameCode)],
    ["Status", `<span class="pill ${escHtml(run.status)}">${escHtml(run.status)}</span>`],
    ["Spins", `${run.completedSpins ?? 0} / ${run.totalSpins ?? 0}`],
    ["RTP", sr ? fmtPct(sr.rtp) + (sr.rtpConfidence95 != null ? ` <span class="muted">±${fmtPct(sr.rtpConfidence95)}</span>` : "") : "—"],
    ["Hit rate", sr ? fmtPct(sr.hitRate) : "—"],
    ["Volatility", sr ? `${fmtNum(sr.volatility)} ${sr.volatilityBand ? `[${sr.volatilityBand}]` : ""}` : "—"],
    ["Avg win", sr?.averageWin != null ? fmtNum(sr.averageWin) : "—"],
    ["Max win", sr?.maxWin != null ? fmtNum(sr.maxWin) : "—"],
    ["Started", run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"],
    ["Ended", run.endedAt ? new Date(run.endedAt).toLocaleString() : "—"],
  ];
  testRunMeta.innerHTML = cells.map(([k, v]) => `<div><strong>${v}</strong>${escHtml(k)}</div>`).join("");
}

async function loadRunTab(runId, tab) {
  const pane = document.getElementById(`runpane-${tab}`);
  pane.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    if (tab === "spins") {
      const rows = await fetch(`/api/test-runs/${runId}/spins?limit=200`).then((r) => r.json());
      if (rows.length === 0) {
        pane.innerHTML = `<div class="muted">No spin results recorded.</div>`;
        return;
      }
      pane.innerHTML =
        `<div class="spin-header"><span>#</span><span>Bet</span><span>Win</span><span>Bal Before</span><span>Bal After</span><span>Symbols</span><span>Flags</span></div>` +
        `<div class="spin-list">` +
        rows
          .map(
            (s) => `
          <div class="spin-row">
            <span class="spin-num">${s.roundIndex}</span>
            <span class="money">${fmtNum(s.totalBet)}</span>
            <span class="money net ${s.totalWin > 0 ? "win" : "loss"}">${fmtNum(s.totalWin)}</span>
            <span class="money">${s.balanceBefore != null ? fmtNum(s.balanceBefore) : "—"}</span>
            <span class="money">${fmtNum(s.balanceAfter)}</span>
            <span style="font-family:var(--mono);font-size:11px">${escHtml((s.symbols ?? "").slice(0, 24))}</span>
            <span class="tag">${s.isFreeSpin ? "FS " : ""}${s.hasBonus ? "BONUS" : ""}</span>
          </div>`,
          )
          .join("") +
        `</div>`;
      return;
    }
    if (tab === "errors") {
      const rows = await fetch(`/api/test-runs/${runId}/errors`).then((r) => r.json());
      if (rows.length === 0) {
        pane.innerHTML = `<div style="color:var(--ok)">✓ No validation errors.</div>`;
        return;
      }
      const byType = {};
      for (const e of rows) (byType[e.errorType] ??= []).push(e);
      pane.innerHTML = Object.entries(byType)
        .map(
          ([type, errs]) => `
        <div style="margin-bottom:16px">
          <h3 style="margin:0 0 8px;font-size:14px">${escHtml(type)} <span class="muted">(${errs.length})</span></h3>
          ${errs
            .slice(0, 30)
            .map(
              (e) => `
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin-bottom:6px;font-size:13px">
              <div><strong style="color:${e.severity === "error" ? "var(--err)" : e.severity === "warn" ? "var(--warn)" : "var(--muted)"}">[${escHtml(e.severity)}]</strong> ${escHtml(e.message)}</div>
              ${e.expectedValue || e.actualValue ? `<div class="muted" style="font-family:var(--mono);font-size:11px;margin-top:4px">expected: ${escHtml(e.expectedValue ?? "—")}  •  actual: ${escHtml(e.actualValue ?? "—")}</div>` : ""}
            </div>`,
            )
            .join("")}
          ${errs.length > 30 ? `<div class="muted">(${errs.length - 30} more truncated)</div>` : ""}
        </div>`,
        )
        .join("");
      return;
    }
    if (tab === "stats") {
      const run = await fetch(`/api/test-runs/${runId}`).then((r) => r.json());
      const sr = run.statReport;
      if (!sr) {
        pane.innerHTML = `<div class="muted">No stat report attached.</div>`;
        return;
      }
      let metrics = {};
      try { metrics = JSON.parse(sr.metricsJson || "{}"); } catch {}
      const cons = metrics.consistency;
      const consBlock = cons
        ? `<h3 style="margin-top:16px;font-size:14px">Payout consistency vs paytable ${cons.payoutMismatches > 0 ? '<span style="color:var(--err)">— ❌ SERVER BUG</span>' : '<span style="color:var(--ok)">— ✓ OK</span>'}</h3>
           <div class="detail-meta" style="grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));padding:0">
             <div><strong>${cons.spinsChecked}</strong>Spins checked</div>
             <div><strong style="${cons.payoutMismatches > 0 ? "color:var(--err)" : ""}">${cons.payoutMismatches}</strong>Mismatches</div>
             <div><strong>${cons.inconclusive}</strong>Inconclusive</div>
             <div><strong>${cons.mismatchRate != null ? fmtPct(cons.mismatchRate, 3) : "—"}</strong>Mismatch rate</div>
           </div>
           ${cons.examples && cons.examples.length > 0 ? `
           <div style="margin-top:8px"><strong>Sample mismatches (first ${Math.min(5, cons.examples.length)}):</strong></div>
           <table style="width:100%;font-size:12px;font-family:var(--mono)">
             <tr class="muted"><th align="left">spin#</th><th align="right">expected</th><th align="right">actual</th><th align="right">Δ</th><th align="left">reels</th></tr>
             ${cons.examples.slice(0, 5).map((ex) => `
               <tr><td>${ex.spinIndex}</td><td align="right">${fmtNum(ex.expected, 4)}</td><td align="right" style="color:var(--err)">${fmtNum(ex.actual, 4)}</td><td align="right">${fmtNum(ex.delta, 4)}</td><td>${escHtml((ex.reels || "").slice(0, 20))}</td></tr>
             `).join("")}
           </table>
           <div class="muted" style="margin-top:6px">Full list → tab <strong>Validation Errors</strong> (filtered by PAYOUT_MISMATCH).</div>
           ` : ""}`
        : "";
      pane.innerHTML = `
        <div class="detail-meta" style="grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));padding:0">
          <div><strong>${fmtNum(sr.totalBet)}</strong>Total bet</div>
          <div><strong>${fmtNum(sr.totalWin)}</strong>Total win</div>
          <div><strong>${fmtPct(sr.rtp)}</strong>RTP</div>
          <div><strong>${fmtPct(sr.hitRate)}</strong>Hit rate</div>
          <div><strong>${fmtNum(sr.averageWin)}</strong>Avg winning</div>
          <div><strong>${fmtNum(sr.maxWin)}</strong>Max win</div>
          <div><strong>${fmtNum(sr.volatility)} ${sr.volatilityBand ? `[${sr.volatilityBand}]` : ""}</strong>Volatility</div>
          <div><strong>±${fmtPct(sr.rtpConfidence95)}</strong>RTP CI (95%)</div>
        </div>
        ${consBlock}
        ${
          metrics.featureFrequency
            ? `<h3 style="margin-top:16px;font-size:14px">Feature frequency</h3>
               <table style="width:100%;font-size:13px">
                 ${Object.entries(metrics.featureFrequency)
                   .map(([k, v]) => `<tr><td class="muted">${escHtml(k)}</td><td>${fmtPct(v, 3)}</td></tr>`)
                   .join("")}
               </table>`
            : ""
        }
        ${
          metrics.symbolDistribution && Object.keys(metrics.symbolDistribution).length
            ? `<h3 style="margin-top:16px;font-size:14px">Symbol distribution (top 12)</h3>
               <table style="width:100%;font-size:13px">
                 ${Object.entries(metrics.symbolDistribution)
                   .slice(0, 12)
                   .map(([k, v]) => `<tr><td class="muted" style="font-family:var(--mono)">${escHtml(k)}</td><td>${v}</td></tr>`)
                   .join("")}
               </table>`
            : ""
        }
        ${
          metrics.winDistribution
            ? `<h3 style="margin-top:16px;font-size:14px">Win distribution (× bet)</h3>
               <table style="width:100%;font-size:13px">
                 <tr class="muted"><th style="text-align:left">Range</th><th style="text-align:right">Count</th><th style="text-align:right">%</th></tr>
                 ${metrics.winDistribution.buckets
                   .map(
                     (b) =>
                       `<tr><td>${b.min === 0 && b.max === 0 ? "= 0 (no win)" : `${fmtNum(b.min)} – ${b.max === null || !Number.isFinite(b.max) ? "∞" : fmtNum(b.max)}`}</td><td style="text-align:right">${b.count}</td><td style="text-align:right">${fmtPct(b.pctOfSpins)}</td></tr>`,
                   )
                   .join("")}
               </table>`
            : ""
        }
      `;
      return;
    }
    if (tab === "summary") {
      const run = await fetch(`/api/test-runs/${runId}`).then((r) => r.json());
      const md = run.summaryMd;
      if (md) {
        pane.innerHTML = `<pre style="white-space:pre-wrap;margin:0;font-family:var(--font);font-size:13px">${escHtml(md)}</pre>`;
      } else {
        pane.innerHTML = `<div class="muted">No bug summary yet. Click <strong>Generate Bug Summary</strong> above.</div>`;
      }
      return;
    }
    if (tab === "analyzer") {
      const run = await fetch(`/api/test-runs/${runId}`).then((r) => r.json());
      const slug = run.gameCode;
      try {
        const a = await fetch(`/api/analyzer/${encodeURIComponent(slug)}`).then((r) => r.json());
        if (a.error) {
          pane.innerHTML = `<div class="muted">${escHtml(a.error)} — run <code>npm run analyze:game -- ${escHtml(slug)}</code></div>`;
          return;
        }
        pane.innerHTML = `<pre style="margin:0;font-family:var(--mono);font-size:11px;white-space:pre-wrap">${escHtml(JSON.stringify(a, null, 2))}</pre>`;
      } catch (err) {
        pane.innerHTML = `<div style="color:var(--err)">Failed: ${escHtml(err.message)}</div>`;
      }
      return;
    }
  } catch (err) {
    pane.innerHTML = `<div style="color:var(--err)">Error: ${escHtml(err.message)}</div>`;
  }
}

testRunSummaryBtn.addEventListener("click", async () => {
  if (!activeRunId) return;
  testRunSummaryBtn.disabled = true;
  testRunSummaryBtn.textContent = "Generating…";
  try {
    const r = await fetch(`/api/test-runs/${activeRunId}/summary`, { method: "POST" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = await r.json();
    showToast(`Bug summary generated (${s.source}, ${s.groupCounts?.length ?? 0} groups)`, "ok");
    activeRunTab = "summary";
    runTabs.forEach((x) => x.classList.toggle("active", x.dataset.runtab === "summary"));
    [runpaneSpins, runpaneErrors, runpaneStats, runpaneSummary, runpaneAnalyzer].forEach((p) =>
      p.classList.add("hidden"),
    );
    runpaneSummary.classList.remove("hidden");
    runpaneSummary.innerHTML = `<pre style="white-space:pre-wrap;margin:0;font-family:var(--font);font-size:13px">${escHtml(s.markdown)}</pre>`;
  } catch (err) {
    showToast(`Failed: ${err.message}`, "err");
  } finally {
    testRunSummaryBtn.disabled = false;
    testRunSummaryBtn.textContent = "Generate Bug Summary";
  }
});

testRunAnalyzerBtn.addEventListener("click", async () => {
  if (!activeRunId) return;
  activeRunTab = "analyzer";
  runTabs.forEach((x) => x.classList.toggle("active", x.dataset.runtab === "analyzer"));
  [runpaneSpins, runpaneErrors, runpaneStats, runpaneSummary, runpaneAnalyzer].forEach((p) =>
    p.classList.add("hidden"),
  );
  runpaneAnalyzer.classList.remove("hidden");
  loadRunTab(activeRunId, "analyzer");
});

// Initial load + periodic refresh
refreshTestRuns();
setInterval(refreshTestRuns, 15_000);
