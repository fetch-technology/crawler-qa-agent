// Shared auth widget — renders a top-right chip with the logged-in QA user,
// a logout button, and (for admins) a user-management panel. Included by both
// the overview dashboard (index.html) and the per-game detail page
// (manual-verify.html). Self-contained IIFE; no external deps, no globals
// beyond window.__qaAuthUser (read-only convenience for host pages).
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  async function getJson(url, opts) {
    const r = await fetch(url, opts);
    const body = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, body };
  }

  function toLogin() {
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
  }

  async function logout() {
    try { await fetch("/api/qa/auth/logout", { method: "POST" }); } catch (_) {}
    location.href = "/login";
  }

  // ---- Admin user management modal ----
  function closeModal() {
    const m = document.getElementById("qaAuthModal");
    if (m) m.remove();
  }

  async function refreshUserList(listEl) {
    const { ok, body } = await getJson("/api/qa/auth/users");
    if (!ok) { listEl.innerHTML = `<div style="color:#e8807f">${esc(body.error || "lỗi tải users")}</div>`; return; }
    const me = window.__qaAuthUser;
    listEl.innerHTML = (body.users || []).map((u) => `
      <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #232a35;font-size:13px;">
        <span style="flex:1;">
          <strong>${esc(u.username)}</strong>
          <span style="color:#8b939c;">${esc(u.displayName)}</span>
          <span style="color:${u.role === "admin" ? "#d9b35c" : "#6d7785"};font-size:11px;">[${esc(u.role)}]</span>
          ${u.disabled ? '<span style="color:#e8807f;font-size:11px;">(disabled)</span>' : ""}
        </span>
        <button data-act="pw" data-id="${esc(u.id)}" data-name="${esc(u.username)}" style="font-size:11px;">Đổi mật khẩu</button>
        ${me && me.id === u.id ? "" : `<button data-act="dis" data-id="${esc(u.id)}" data-dis="${u.disabled ? "0" : "1"}" style="font-size:11px;">${u.disabled ? "Bật lại" : "Vô hiệu"}</button>`}
      </div>`).join("") || '<div style="color:#8b939c">chưa có user</div>';

    listEl.querySelectorAll("button[data-act]").forEach((b) => {
      b.addEventListener("click", async () => {
        const act = b.getAttribute("data-act");
        const id = b.getAttribute("data-id");
        if (act === "pw") {
          const pw = prompt(`Mật khẩu mới cho "${b.getAttribute("data-name")}" (≥6 ký tự):`);
          if (!pw) return;
          const r = await getJson("/api/qa/auth/users/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: id, password: pw }) });
          if (!r.ok) alert(r.body.error || "lỗi"); else refreshUserList(listEl);
        } else if (act === "dis") {
          const disabled = b.getAttribute("data-dis") === "1";
          const r = await getJson("/api/qa/auth/users/disable", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: id, disabled }) });
          if (!r.ok) alert(r.body.error || "lỗi"); else refreshUserList(listEl);
        }
      });
    });
  }

  function openAdminModal() {
    closeModal();
    const wrap = document.createElement("div");
    wrap.id = "qaAuthModal";
    wrap.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding-top:60px;";
    wrap.innerHTML = `
      <div style="width:520px;max-width:92vw;background:#11151c;border:1px solid #232a35;border-radius:10px;padding:20px;color:#e6eaf0;font-family:-apple-system,sans-serif;">
        <div style="display:flex;align-items:center;margin-bottom:12px;">
          <h3 style="margin:0;font-size:15px;flex:1;">Quản lý QA users</h3>
          <button id="qaAuthClose" style="font-size:12px;">Đóng</button>
        </div>
        <div id="qaAuthList" style="max-height:46vh;overflow:auto;margin-bottom:14px;"></div>
        <div style="border-top:1px solid #2a3140;padding-top:12px;">
          <div style="color:#8b939c;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Thêm user mới</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            <input id="qaNewUser" placeholder="username" style="flex:1;min-width:110px;padding:6px 8px;background:#0b0e13;color:#e6eaf0;border:1px solid #2a3140;border-radius:5px;" />
            <input id="qaNewPass" placeholder="password" type="text" style="flex:1;min-width:110px;padding:6px 8px;background:#0b0e13;color:#e6eaf0;border:1px solid #2a3140;border-radius:5px;" />
            <select id="qaNewRole" style="padding:6px 8px;background:#0b0e13;color:#e6eaf0;border:1px solid #2a3140;border-radius:5px;">
              <option value="qa">qa</option>
              <option value="admin">admin</option>
            </select>
            <button id="qaNewBtn" style="font-size:13px;padding:6px 12px;">Tạo</button>
          </div>
          <div id="qaNewErr" style="color:#e8807f;font-size:12px;margin-top:6px;min-height:14px;"></div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener("click", (e) => { if (e.target === wrap) closeModal(); });
    document.getElementById("qaAuthClose").addEventListener("click", closeModal);
    const listEl = document.getElementById("qaAuthList");
    refreshUserList(listEl);
    document.getElementById("qaNewBtn").addEventListener("click", async () => {
      const username = document.getElementById("qaNewUser").value.trim();
      const password = document.getElementById("qaNewPass").value;
      const role = document.getElementById("qaNewRole").value;
      const errEl = document.getElementById("qaNewErr");
      errEl.textContent = "";
      const r = await getJson("/api/qa/auth/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, role }) });
      if (!r.ok) { errEl.textContent = r.body.error || "lỗi"; return; }
      document.getElementById("qaNewUser").value = "";
      document.getElementById("qaNewPass").value = "";
      refreshUserList(listEl);
    });
  }

  function renderChip(user) {
    window.__qaAuthUser = user;
    let chip = document.getElementById("qaAuthChip");
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "qaAuthChip";
      chip.style.cssText = "position:fixed;top:8px;right:10px;z-index:9999;display:flex;align-items:center;gap:8px;background:#11151c;border:1px solid #232a35;border-radius:20px;padding:5px 12px;font-size:12px;color:#e6eaf0;font-family:-apple-system,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,0.3);";
      document.body.appendChild(chip);
    }
    const isAdmin = user.role === "admin";
    chip.innerHTML = `
      <span title="${esc(user.username)}">👤 ${esc(user.displayName)}${isAdmin ? ' <span style="color:#d9b35c;">admin</span>' : ""}</span>
      ${isAdmin ? '<button id="qaUsersBtn" style="font-size:11px;cursor:pointer;">Users</button>' : ""}
      <button id="qaLogoutBtn" style="font-size:11px;cursor:pointer;">Log out</button>`;
    const ub = document.getElementById("qaUsersBtn");
    if (ub) ub.addEventListener("click", openAdminModal);
    document.getElementById("qaLogoutBtn").addEventListener("click", logout);
  }

  async function init() {
    try {
      const { ok, status, body } = await getJson("/api/qa/auth/me");
      if (status === 401 || !ok || !body.user) { toLogin(); return; }
      renderChip(body.user);
    } catch (_) { /* network error — leave page as-is */ }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
