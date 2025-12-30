// MP Tracker app logic (external file to avoid CSP blocking inline scripts)
(() => {
  // Fallback only (real "build" is derived from Last-Modified of app.js when possible)
  const BUILD_ID = "local";

  // ======================
  // 配置（你在这里填写）
  // ======================
  // Supabase：不想用可先留 CONST_ 开头，App 会自动退回 localStorage
  const SUPABASE_URL = "https://ipyqmwwcaqywdntoxgue.supabase.co";
  const SUPABASE_KEY = "sb_publishable_HsfJ4VLrw-tSlEr86p2tmQ_BOW9B-j1";
  // 多设备同步：默认每台设备一个随机 ID（方便你发给别人用，不会写进同一份数据里）
  // 想让“手机+电脑”共享同一份数据：用同一个 user（例如：?user=ruijia_main）
  const USER_ID_STORAGE_KEY = "mp_tracker_device_id";
  const urlUser = new URLSearchParams(location.search).get("user");
  let USER_ID = urlUser || localStorage.getItem(USER_ID_STORAGE_KEY);
  if (!USER_ID) {
    USER_ID = "user_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
    localStorage.setItem(USER_ID_STORAGE_KEY, USER_ID);
  }

  // AI：Netlify 拖拽部署建议用 /api/*（配合 _redirects 或 netlify.toml 代理）
  const API_URL = "/api/chat/completions";
  // 不要把 AI key 放前端：请在 Netlify 后台设置环境变量 AI_BUILDERS_API_KEY
  const API_KEY = ""; // (unused)
  // 模型名称：你报错说 gpt-4o-mini 不支持，就在这里改
  // 先用你之前提过的：supermind-agent-v1（如果还不行，把后端支持的模型名填到这里）
  const AI_MODEL = "supermind-agent-v1";

  const LOCAL_KEY = "mp_tracker_records_v1";

  // ======================
  // Utils
  // ======================
  const pad2 = (n) => String(n).padStart(2, "0");
  const formatMMSS = (totalSeconds) => {
    const mm = Math.floor(totalSeconds / 60);
    const ss = totalSeconds % 60;
    return `${pad2(mm)}:${pad2(ss)}`;
  };
  const escapeHtml = (str) =>
    String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  const escapeCsvCell = (value) => {
    const s = String(value ?? "");
    const needsQuotes = /[",\n\r]/.test(s);
    const escaped = s.replace(/"/g, '""');
    return needsQuotes ? `"${escaped}"` : escaped;
  };
  const downloadText = (filename, text) => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  function loadLocalLogs() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function saveLocalLogs(rows) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(rows));
  }

  // ======================
  // DOM
  // ======================
  const elTaskNameInput = document.getElementById("taskNameInput");
  const elTimerText = document.getElementById("timerText");
  const elStartStopBtn = document.getElementById("startStopBtn");
  const elStatusText = document.getElementById("statusText");
  const elHistoryList = document.getElementById("historyList");
  const elHistoryCount = document.getElementById("historyCount");
  const elEmptyState = document.getElementById("emptyState");
  const elExportCsvBtn = document.getElementById("exportCsvBtn");
  const elClearAllBtn = document.getElementById("clearAllBtn");
  const elBuildBadge = document.getElementById("buildBadge");

  const elModalOverlay = document.getElementById("modalOverlay");
  const elCloseModalBtn = document.getElementById("closeModalBtn");
  const elModalTaskName = document.getElementById("modalTaskName");
  const elMasteryRow = document.getElementById("masteryRow");
  const elPleasureRow = document.getElementById("pleasureRow");
  const elMasteryHint = document.getElementById("masteryHint");
  const elPleasureHint = document.getElementById("pleasureHint");
  const elDurationText = document.getElementById("durationText");
  const elSubmitBtn = document.getElementById("submitBtn");
  const elSkipAiBtn = document.getElementById("skipAiBtn");
  const elModalStatus = document.getElementById("modalStatus");

  async function refreshBuildBadge() {
    if (!elBuildBadge) return;
    elBuildBadge.textContent = "Build: …";
    try {
      const res = await fetch("./app.js", { method: "HEAD", cache: "no-store" });
      const lm = res.headers.get("last-modified");
      if (lm) {
        const d = new Date(lm);
        const text = isNaN(d.getTime()) ? lm : d.toISOString().replace("T", " ").slice(0, 19);
        elBuildBadge.textContent = `Build: ${text}`;
        return;
      }
    } catch {}
    elBuildBadge.textContent = `Build: ${BUILD_ID}`;
  }

  // Visual proof JS is running
  if (elStatusText) elStatusText.textContent = `JS 已加载`;
  refreshBuildBadge();

  window.addEventListener("error", (e) => {
    try {
      elStatusText.textContent = `脚本错误：${e?.message || "未知错误"}`;
    } catch {}
  });

  // ======================
  // Supabase init (optional)
  // ======================
  const SUPABASE_SDK_OK = !!(window.supabase && typeof window.supabase.createClient === "function");
  const HAS_SUPABASE =
    SUPABASE_SDK_OK &&
    SUPABASE_URL &&
    SUPABASE_KEY &&
    !SUPABASE_URL.includes("CONST_") &&
    !SUPABASE_KEY.includes("CONST_");

  const supabase = HAS_SUPABASE ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

  // ======================
  // Auth UI (Google via Supabase)
  // ======================
  const elLoginBtn = document.getElementById("loginBtn");
  const elLogoutBtn = document.getElementById("logoutBtn");
  const elUserLabel = document.getElementById("userLabel");

  // Active identity used for data isolation
  // - if logged in: Supabase auth user id
  // - else: guest device id (local only; NOT used for Supabase when RLS is on)
  let ACTIVE_USER_ID = USER_ID;
  let IS_AUTHED = false;

  function shortId(id) {
    return String(id || "").slice(0, 8);
  }

  function setAuthUI(session) {
    if (session?.user) {
      ACTIVE_USER_ID = session.user.id;
      IS_AUTHED = true;
      if (elUserLabel) {
        elUserLabel.textContent = session.user.email ? `已登录：${session.user.email}` : `已登录`;
        elUserLabel.classList.remove("hidden");
      }
      if (elLoginBtn) elLoginBtn.classList.add("hidden");
      if (elLogoutBtn) elLogoutBtn.classList.remove("hidden");
    } else {
      ACTIVE_USER_ID = USER_ID;
      IS_AUTHED = false;
      if (elUserLabel) {
        elUserLabel.textContent = "游客";
        elUserLabel.classList.remove("hidden");
      }
      if (elLoginBtn) elLoginBtn.classList.remove("hidden");
      if (elLogoutBtn) elLogoutBtn.classList.add("hidden");
    }
    // refresh badge/status (no id shown)
    refreshBuildBadge();
    if (elStatusText) elStatusText.textContent = session?.user ? "已登录" : "游客模式";
  }

  async function fetchLogs() {
    if (!HAS_SUPABASE || !IS_AUTHED) return loadLocalLogs();
    const { data, error } = await supabase
      .from("logs")
      .select("*")
      .eq("user_id", ACTIVE_USER_ID)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function insertLog(row) {
    if (!HAS_SUPABASE || !IS_AUTHED) {
      const rows = loadLocalLogs();
      // ensure stable id for local editing
      const localId = row.id || `local_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      rows.unshift({ ...row, id: localId, created_at: row.created_at || new Date().toISOString() });
      saveLocalLogs(rows);
      return;
    }
    const { error } = await supabase.from("logs").insert(row);
    if (error) throw error;
  }

  // ======================
  // UI state
  // ======================
  let isRunning = false;
  let startedAtMs = 0;
  let timerInterval = null;
  let elapsedSeconds = 0;
  let pendingDurationSeconds = 0;
  let modalMastery = null;
  let modalPleasure = null;
  const optimistic = [];
  // cache last rendered records by id for editing
  const recordById = new Map();

  // ======================
  // Inline editing (no extra edit button/modal)
  // ======================
  let inlineEditor = null; // { inputEl, originalEl }
  let ratingPopover = null; // DOM element
  let shownRlsHint = false;

  function maybeShowRlsHint(err) {
    if (shownRlsHint) return;
    if (!HAS_SUPABASE || !IS_AUTHED) return;
    const msg = String(err?.message || "");
    // Common Supabase/PostgREST RLS permission errors
    const looksLikeRls =
      /permission denied|new row violates|violates row-level security|RLS|42501|PGRST|not allowed/i.test(msg);
    if (!looksLikeRls && msg) return;
    shownRlsHint = true;
    alert(
      "云端保存被拒绝：很可能是 Supabase `logs` 表开启了 RLS，但缺少 UPDATE policy。\n\n" +
        "请在 Supabase 给 public.logs 添加 UPDATE policy（authenticated）：\n" +
        "USING (user_id = auth.uid()::text)  WITH CHECK (user_id = auth.uid()::text)\n\n" +
        "配置好后刷新页面再试。"
    );
  }

  function cleanupInlineEditor() {
    if (!inlineEditor) return;
    try {
      inlineEditor.inputEl?.remove?.();
      inlineEditor.originalEl?.classList?.remove?.("hidden");
    } finally {
      inlineEditor = null;
    }
  }

  function hideRatingPopover() {
    if (!ratingPopover) return;
    ratingPopover.remove();
    ratingPopover = null;
  }

  async function updateLogById(id, patch) {
    if (!id) return;
    if (!HAS_SUPABASE || !IS_AUTHED) {
      const rows = loadLocalLogs();
      const idx = rows.findIndex((r) => r?.id === id);
      if (idx === -1) throw new Error("本地未找到该记录");
      rows[idx] = { ...rows[idx], ...patch };
      saveLocalLogs(rows);
      return;
    }
    const { error } = await supabase.from("logs").update(patch).eq("id", id).eq("user_id", ACTIVE_USER_ID);
    if (error) throw error;
  }

  function startInlineTextEdit({ el, id, field, initialValue, placeholder }) {
    cleanupInlineEditor();
    hideRatingPopover();

    const parent = el.parentElement;
    if (!parent) return;

    const input = document.createElement("input");
    input.type = "text";
    input.value = initialValue || "";
    input.placeholder = placeholder || "";
    input.className =
      "w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20";

    el.classList.add("hidden");
    parent.insertBefore(input, el);
    input.focus();
    input.select();

    inlineEditor = { inputEl: input, originalEl: el };

    const cancel = () => cleanupInlineEditor();
    const commit = async () => {
      const next = (input.value || "").trim();
      const prev = (initialValue || "").trim();
      if (next === prev) {
        cleanupInlineEditor();
        return;
      }
      input.disabled = true;
      try {
        await updateLogById(id, { [field]: next });
        cleanupInlineEditor();
        renderHistory();
      } catch (err) {
        input.disabled = false;
        input.classList.add("border-rose-400/60");
        setTimeout(() => input.classList.remove("border-rose-400/60"), 1200);
        maybeShowRlsHint(err);
        console.error(err);
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") cancel();
    });
    input.addEventListener("blur", commit);
  }

  function showRatingPicker({ x, y, id, field, current }) {
    cleanupInlineEditor();
    hideRatingPopover();

    const isMastery = field === "mastery";
    const pop = document.createElement("div");
    pop.className =
      "fixed z-[60] rounded-full border border-slate-800 bg-slate-950/95 backdrop-blur p-2 shadow-[0_20px_80px_rgba(0,0,0,0.55)]";
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 220, x - 90))}px`;
    pop.style.top = `${Math.max(8, Math.min(window.innerHeight - 80, y + 10))}px`;

    const row = document.createElement("div");
    row.className = "flex items-center gap-2";

    for (let i = 1; i <= 5; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = String(i);
      const selected = Number(current) === i;
      const selectedClass = isMastery
        ? "border-emerald-400/60 bg-emerald-400/20 text-emerald-200 shadow-neon"
        : "border-cyan-400/60 bg-cyan-400/20 text-cyan-200 shadow-neonCyan";
      b.className = selected
        ? `w-11 h-11 rounded-full border ${selectedClass} text-base font-semibold active:scale-[0.99] transition`
        : "w-11 h-11 rounded-full border border-slate-800 bg-slate-900/40 text-base font-semibold text-slate-200 hover:bg-slate-900/70 active:scale-[0.99] transition";
      b.addEventListener("click", async () => {
        try {
          await updateLogById(id, { [field]: i });
          hideRatingPopover();
          renderHistory();
        } catch (err) {
          console.error(err);
          maybeShowRlsHint(err);
          hideRatingPopover();
        }
      });
      row.appendChild(b);
    }

    pop.appendChild(row);
    document.body.appendChild(pop);
    ratingPopover = pop;

    setTimeout(() => {
      const onDown = (e) => {
        if (!ratingPopover) return;
        if (ratingPopover.contains(e.target)) return;
        hideRatingPopover();
        window.removeEventListener("pointerdown", onDown, true);
      };
      window.addEventListener("pointerdown", onDown, true);
    }, 0);
  }

  function setModalStatus(text, kind = "info") {
    if (!text) {
      elModalStatus.textContent = "";
      elModalStatus.className = "text-xs text-slate-400 min-h-[1.25rem]";
      return;
    }
    const color = kind === "error" ? "text-rose-300" : kind === "success" ? "text-emerald-300" : "text-slate-300";
    elModalStatus.textContent = text;
    elModalStatus.className = `text-xs ${color} min-h-[1.25rem]`;
  }

  function openModal() {
    elModalTaskName.value = (elTaskNameInput.value || "").trim();
    elDurationText.textContent = formatMMSS(pendingDurationSeconds);
    modalMastery = null;
    modalPleasure = null;
    updateRatingUI();
    setModalStatus("");
    elModalOverlay.classList.remove("hidden");
    document.body.classList.add("no-scroll");
    setTimeout(() => elModalTaskName.focus(), 50);
  }

  function closeModal() {
    elModalOverlay.classList.add("hidden");
    document.body.classList.remove("no-scroll");
  }

  function buildRatingRows() {
    elMasteryRow.innerHTML = "";
    elPleasureRow.innerHTML = "";
    for (let i = 1; i <= 5; i++) {
      const mBtn = document.createElement("button");
      mBtn.type = "button";
      mBtn.textContent = String(i);
      mBtn.className =
        "rounded-xl border border-slate-800 bg-slate-900/40 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-900/70 active:scale-[0.99] transition";
      mBtn.addEventListener("click", () => {
        modalMastery = i;
        updateRatingUI();
      });
      elMasteryRow.appendChild(mBtn);

      const pBtn = document.createElement("button");
      pBtn.type = "button";
      pBtn.textContent = String(i);
      pBtn.className =
        "rounded-xl border border-slate-800 bg-slate-900/40 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-900/70 active:scale-[0.99] transition";
      pBtn.addEventListener("click", () => {
        modalPleasure = i;
        updateRatingUI();
      });
      elPleasureRow.appendChild(pBtn);
    }
  }

  function updateRatingUI() {
    [...elMasteryRow.children].forEach((btn, idx) => {
      const v = idx + 1;
      const selected = modalMastery === v;
      btn.className = selected
        ? "rounded-xl border border-emerald-400/50 bg-emerald-500/15 py-3 text-sm font-semibold text-emerald-200 shadow-neon active:scale-[0.99] transition"
        : "rounded-xl border border-slate-800 bg-slate-900/40 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-900/70 active:scale-[0.99] transition";
    });
    elMasteryHint.textContent = modalMastery ? `已选 ${modalMastery}/5` : "未选择";
    elMasteryHint.className = modalMastery ? "text-xs text-emerald-300" : "text-xs text-slate-500";

    [...elPleasureRow.children].forEach((btn, idx) => {
      const v = idx + 1;
      const selected = modalPleasure === v;
      btn.className = selected
        ? "rounded-xl border border-cyan-400/50 bg-cyan-400/15 py-3 text-sm font-semibold text-cyan-200 shadow-neonCyan active:scale-[0.99] transition"
        : "rounded-xl border border-slate-800 bg-slate-900/40 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-900/70 active:scale-[0.99] transition";
    });
    elPleasureHint.textContent = modalPleasure ? `已选 ${modalPleasure}/5` : "未选择";
    elPleasureHint.className = modalPleasure ? "text-xs text-cyan-300" : "text-xs text-slate-500";
  }

  function validateModal() {
    if (!modalMastery || !modalPleasure) {
      setModalStatus("请先选择胜任感与愉悦感（1-5）。", "error");
      return false;
    }
    return true;
  }

  function startTimer() {
    if (isRunning) return;
    isRunning = true;
    startedAtMs = Date.now();
    elapsedSeconds = 0;
    elTimerText.textContent = "00:00";
    elStatusText.textContent = "进行中…";
    elStartStopBtn.textContent = "Stop";
    elStartStopBtn.className =
      "relative z-10 w-full select-none rounded-2xl py-5 text-2xl font-semibold bg-rose-500 text-rose-950 shadow-neonRed active:scale-[0.99] transition";
    timerInterval = setInterval(() => {
      elapsedSeconds = Math.floor((Date.now() - startedAtMs) / 1000);
      elTimerText.textContent = formatMMSS(elapsedSeconds);
    }, 250);
  }

  function stopTimer() {
    if (!isRunning) return;
    isRunning = false;
    clearInterval(timerInterval);
    timerInterval = null;
    elapsedSeconds = Math.floor((Date.now() - startedAtMs) / 1000);
    pendingDurationSeconds = elapsedSeconds;
    elTimerText.textContent = formatMMSS(elapsedSeconds);
    elStatusText.textContent = "已停止";
    elStartStopBtn.textContent = "Start";
    elStartStopBtn.className =
      "relative z-10 w-full select-none rounded-2xl py-5 text-2xl font-semibold bg-emerald-500 text-emerald-950 shadow-neon active:scale-[0.99] transition";
  }

  function renderList(records) {
    elHistoryCount.textContent = `${records.length} 条`;
    elHistoryList.innerHTML = "";
    elEmptyState.classList.toggle("hidden", records.length > 0);
    recordById.clear();

    for (const r of records) {
      if (r?.id && !r?._optimistic) recordById.set(r.id, r);
      const created = new Date(r.created_at || Date.now());
      const timeStr = isNaN(created.getTime())
        ? String(r.created_at || "")
        : created.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

      const taskName = (r.task || "").trim() || "（未命名）";
      const category = (r.category || "").trim() || "Uncategorized";
      const insight = (r.insight || "").trim() || "";
      const mastery = r.mastery ?? "";
      const pleasure = r.pleasure ?? "";
      const dur = r.duration || "";

      const card = document.createElement("div");
      card.className = "rounded-2xl border border-slate-800 bg-slate-900/30 p-4";
      if (r?.id && !r?._optimistic) card.dataset.logId = r.id;
      card.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-xs text-slate-400">${escapeHtml(timeStr)}</span>
              <span class="text-xs text-slate-500">·</span>
              <span class="text-xs text-slate-400 tabular-nums">${escapeHtml(dur || "—")}</span>
            </div>
            <button
              type="button"
              class="mt-1 text-left w-full text-base font-semibold text-slate-100 break-words hover:text-slate-50 active:scale-[0.995] transition"
              data-edit="task"
              ${r?.id && !r?._optimistic ? "" : "disabled"}
              title="点此编辑任务名"
            >${escapeHtml(taskName)}</button>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-full border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-400/15 active:scale-[0.99] transition"
            data-edit="category"
            ${r?.id && !r?._optimistic ? "" : "disabled"}
            title="点此编辑分类"
          >${escapeHtml(category)}</button>
        </div>
        <div class="mt-3 flex items-center gap-2 text-xs flex-wrap">
          <button
            type="button"
            class="rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-2 py-1 text-emerald-200 hover:bg-emerald-400/15 active:scale-[0.99] transition"
            data-edit="mastery"
            ${r?.id && !r?._optimistic ? "" : "disabled"}
            title="点此修改 Mastery"
          >M ${escapeHtml(String(mastery))}/5</button>
          <button
            type="button"
            class="rounded-lg border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 text-cyan-200 hover:bg-cyan-400/15 active:scale-[0.99] transition"
            data-edit="pleasure"
            ${r?.id && !r?._optimistic ? "" : "disabled"}
            title="点此修改 Pleasure"
          >P ${escapeHtml(String(pleasure))}/5</button>
        </div>
        ${
          insight
            ? `<div class="mt-3 text-sm text-slate-200 leading-snug"><span class="text-slate-400">洞察：</span>${escapeHtml(insight)}</div>`
            : ""
        }
      `;
      elHistoryList.appendChild(card);
    }
  }

  async function renderHistory() {
    elHistoryCount.textContent = "同步中…";
    try {
      const remote = await fetchLogs();
      renderList([...optimistic, ...remote]);
    } catch (e) {
      elHistoryCount.textContent = "同步失败";
      console.error(e);
    }
  }

  async function analyzeWithAI({ taskName, mastery, pleasure }) {
    const systemPrompt = `You are a supportive CBT coach.
1. Analyze the user's task based on Mastery (1-5) and Pleasure (1-5).
2. Auto-categorize the task into one tag (e.g., Work, Health, Hobby, Chores).
3. Provide a VERY SHORT, 1-sentence insight or encouragement.
Return JSON only in the format: { "category": "String", "insight": "String" }.`;

    const payload = {
      model: AI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ task: taskName || "", mastery, pleasure }) },
      ],
      temperature: 0.4,
      max_tokens: 100,
      response_format: { type: "json_object" },
    };

    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API 请求失败（${res.status}）：${text || res.statusText}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") throw new Error("AI 返回内容为空或格式不正确");

    let parsed = null;
    try { parsed = JSON.parse(content.trim()); } catch {}
    if (!parsed) {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch {}
      }
    }
    if (!parsed || typeof parsed !== "object") throw new Error("无法解析 AI JSON");
    const category = String(parsed.category ?? "").trim();
    const insight = String(parsed.insight ?? "").trim();
    if (!category || !insight) throw new Error("AI JSON 缺少 category 或 insight");
    return { category, insight };
  }

  function makeOptimisticRecord({ task, mastery, pleasure, durationSeconds, useAI }) {
    return {
      id: `temp_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      created_at: new Date().toISOString(),
      task,
      mastery,
      pleasure,
      duration: formatMMSS(durationSeconds),
      category: useAI ? "…" : "Uncategorized",
      // 仅在 AI 分析时显示占位，纯保存不显示“Analyzing…”
      insight: useAI ? "Analyzing…" : "",
      _optimistic: true,
    };
  }

  async function saveAndAnalyze({ useAI }) {
    if (!validateModal()) return;

    const task = (elModalTaskName.value || "").trim();
    const mastery = modalMastery;
    const pleasure = modalPleasure;
    const durationSeconds = pendingDurationSeconds;

    const temp = makeOptimisticRecord({ task, mastery, pleasure, durationSeconds, useAI });
    optimistic.unshift(temp);
    renderHistory();

    elSubmitBtn.disabled = true;
    elSkipAiBtn.disabled = true;
    setModalStatus(useAI ? "已开始分析（后台进行）…" : "正在保存…", "info");
    setTimeout(closeModal, 150);

    try {
      let category = "Uncategorized";
      let insight = "";

      if (useAI) {
        // 走 Netlify Function 代理：密钥在服务器端（AI_BUILDERS_API_KEY），前端无需/不应持有 API_KEY
        try {
          const ai = await analyzeWithAI({ taskName: task || "（未命名任务）", mastery, pleasure });
          category = ai.category;
          insight = ai.insight;
        } catch (e) {
          // AI 失败也继续保存（MVP：先跑通数据闭环）
          category = "AI_Error";
          insight = `AI失败：${e?.message || "未知错误"}`;
        }
      } else {
        // 仅保存：不展示“洞察”，避免干扰
        category = "Uncategorized";
        insight = "";
      }

      await insertLog({
        task,
        mastery,
        pleasure,
        duration: formatMMSS(durationSeconds),
        category,
        insight,
        user_id: ACTIVE_USER_ID,
        created_at: new Date().toISOString(),
      });

      const idx = optimistic.findIndex((r) => r.id === temp.id);
      if (idx !== -1) optimistic.splice(idx, 1);
      await renderHistory();
    } catch (e) {
      const idx = optimistic.findIndex((r) => r.id === temp.id);
      if (idx !== -1) {
        optimistic[idx] = { ...optimistic[idx], category: "Error", insight: `分析/保存失败：${e?.message || "未知错误"}` };
      }
      renderHistory();
    } finally {
      elSubmitBtn.disabled = false;
      elSkipAiBtn.disabled = false;
    }
  }

  async function exportCSV() {
    try {
      const rows = await fetchLogs();
      const header = ["created_at", "task", "duration", "mastery", "pleasure", "category", "insight", "user_id"];
      const lines = [header.join(",")];
      for (const r of rows) {
        lines.push([
          r.created_at,
          r.task ?? "",
          r.duration ?? "",
          r.mastery ?? "",
          r.pleasure ?? "",
          r.category ?? "",
          r.insight ?? "",
          r.user_id ?? USER_ID,
        ].map(escapeCsvCell).join(","));
      }
      downloadText(`mp-tracker-${new Date().toISOString().slice(0, 10)}.csv`, lines.join("\n"));
    } catch (e) {
      alert(`导出失败：${e?.message || "未知错误"}`);
    }
  }

  async function clearAll() {
    const ok = confirm("确定要清空该用户的所有历史吗？此操作不可撤销。");
    if (!ok) return;
    try {
      if (!HAS_SUPABASE || !IS_AUTHED) {
        saveLocalLogs([]);
      } else {
        const { error } = await supabase.from("logs").delete().eq("user_id", ACTIVE_USER_ID);
        if (error) throw error;
      }
      optimistic.length = 0;
      await renderHistory();
    } catch (e) {
      alert(`清空失败：${e?.message || "未知错误"}`);
    }
  }

  // ======================
  // Events
  // ======================
  function onStartStop() {
    if (!isRunning) return startTimer();
    stopTimer();
    openModal();
  }
  // 避免移动端重复触发（click + touchend + pointerup），导致“Start 立刻 Stop”
  let lastStartStopAt = 0;
  function onStartStopDedup(e) {
    const now = Date.now();
    if (now - lastStartStopAt < 350) return;
    lastStartStopAt = now;
    onStartStop(e);
  }
  // 只监听 pointerup（现代浏览器通用）；不再同时监听 click/touchend
  elStartStopBtn.addEventListener("pointerup", onStartStopDedup);

  elCloseModalBtn.addEventListener("click", closeModal);
  elModalOverlay.addEventListener("click", (e) => {
    if (e.target === elModalOverlay) closeModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !elModalOverlay.classList.contains("hidden")) closeModal();
  });

  elSubmitBtn.addEventListener("click", () => saveAndAnalyze({ useAI: true }));
  elSkipAiBtn.addEventListener("click", () => saveAndAnalyze({ useAI: false }));
  elExportCsvBtn.addEventListener("click", exportCSV);
  elClearAllBtn.addEventListener("click", clearAll);

  // Inline edit delegation (task/category/mastery/pleasure)
  elHistoryList.addEventListener("click", (e) => {
    const el = e.target?.closest?.("[data-edit]");
    if (!el) return;
    const field = el.dataset.edit;
    const card = el.closest("[data-log-id]");
    const id = card?.dataset?.logId;
    if (!id) return;
    const record = recordById.get(id);
    if (!record) return;

    if (field === "task") {
      startInlineTextEdit({
        el,
        id,
        field: "task",
        initialValue: record.task || "",
        placeholder: "任务名称…",
      });
      return;
    }
    if (field === "category") {
      startInlineTextEdit({
        el,
        id,
        field: "category",
        initialValue: record.category || "",
        placeholder: "分类…",
      });
      return;
    }
    if (field === "mastery") {
      showRatingPicker({
        x: e.clientX,
        y: e.clientY,
        id,
        field: "mastery",
        current: record.mastery,
      });
      return;
    }
    if (field === "pleasure") {
      showRatingPicker({
        x: e.clientX,
        y: e.clientY,
        id,
        field: "pleasure",
        current: record.pleasure,
      });
      return;
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      cleanupInlineEditor();
      hideRatingPopover();
    }
  });

  // Auth events
  if (elLoginBtn) {
    elLoginBtn.addEventListener("click", async () => {
      if (!HAS_SUPABASE) {
        alert("未配置 Supabase，无法使用 Google 登录。");
        return;
      }
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin + window.location.pathname },
      });
      if (error) alert(`登录失败：${error.message}`);
    });
  }
  if (elLogoutBtn) {
    elLogoutBtn.addEventListener("click", async () => {
      if (!HAS_SUPABASE) return;
      const { error } = await supabase.auth.signOut();
      if (error) alert(`退出失败：${error.message}`);
    });
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && isRunning && elModalOverlay.classList.contains("hidden")) {
      e.preventDefault();
      stopTimer();
      openModal();
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !elModalOverlay.classList.contains("hidden")) {
      e.preventDefault();
      saveAndAnalyze({ useAI: true });
    }
  });

  // Init
  buildRatingRows();
  (async () => {
    if (HAS_SUPABASE) {
      try {
        const { data } = await supabase.auth.getSession();
        setAuthUI(data?.session || null);
      } catch {
        setAuthUI(null);
      }
      supabase.auth.onAuthStateChange((_event, session) => {
        setAuthUI(session);
        renderHistory();
      });
    } else {
      setAuthUI(null);
    }
    renderHistory();
  })();
})();


