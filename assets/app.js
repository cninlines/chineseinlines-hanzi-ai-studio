/* ============================================================
   app.js — 主应用逻辑（SaaS 版）
   路由：工作台 / 字源解析 / 字际系联 / 多场景创编 / 生成历史 /
        Prompt 模板库 / 性能评测 / 设置
   固定板块（字源、系联、模板、评测）全部走本地数据，不调用 API。
   创编板块调用大模型，每次生成自动写入历史记录（含完整 Prompt）。
   ============================================================ */
(function () {
  "use strict";

  const $   = (id) => document.getElementById(id);
  const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  /* ==================== 全局状态 ==================== */
  const S = {
    route: "etym",
    mode: "story",
    chars: ["我"],
    hsk: 3,
    lang: "English",
    region: "东南亚",
    modules: new Set(["story", "quiz", "courseware"]),
    busy: false,
    result: null,
    controller: null,
    histSel: null
  };

  /* ==================== 字形时期定义 ==================== */
  const PERIODS = [
    { key: "oracle",   name: "甲骨文", era: "商 · 前1250–前1046", fallback: "ob",
      src: "etymology-svg", note: "刻于龟甲兽骨，笔画瘦硬方折" },
    { key: "bronze",   name: "金文",   era: "西周–春秋",
      src: "etymology-svg", note: "铸于青铜器，线条浑厚圆润" },
    { key: "seal",     name: "小篆",   era: "秦 · 前221–前206",
      src: "etymology-svg", note: "书同文，线条匀整、形体定型" },
    { key: "clerical", name: "隶书",   era: "汉 · 前206–220",
      src: "etymology-svg", note: "隶变，象形性消失，笔画方折" },
    { key: "regular",  name: "楷书",   era: "魏晋至今",
      src: "system", note: "今通行字形，由系统字体渲染" }
  ];

  // 后起字学术说明（这些字本就无早期字形，属学术事实而非数据缺失）
  const LATE_CHAR_NOTE = "该期为后起字，此时期尚无该字形。此类字多由初文加注形符分化而来。";

  // 时期 → 汉典字源脚本代码（jiaguwen 甲骨文 / jinwen 金文 / xiaozhuan 小篆 / lishu 隶书）
  const HAN_SCRIPT = { oracle: "jiaguwen", bronze: "jinwen", seal: "xiaozhuan", clerical: "lishu" };

  /* ==================== 声符字族索引（由 CHARLIB 构建） ==================== */
  let PHON_FAM = {};
  let RAD_INDEX = {};

  /* ==================== 字形懒加载 ==================== */
  const glyphCache = new Map();
  function glyphPath(ch, period) {
    if (typeof period === "string" && period.startsWith("ob:")) {
      return "ob/u" + period.slice(3) + ".svg";
    }
    const d = (window.GLYPH_INDEX || {})[ch];
    if (!d) return null;
    return d[period] || (period === "oracle" ? d.ob : null) || null;
  }
  async function loadGlyph(ch, period) {
    const p = glyphPath(ch, period);
    if (!p) return null;
    if (glyphCache.has(p)) return glyphCache.get(p);
    try {
      const r = await fetch("assets/glyphs/" + p);
      if (!r.ok) return null;
      const t = await r.text();
      glyphCache.set(p, t);
      return t;
    } catch (e) { return null; }
  }
  /** 返回某字可用的全部时期 key */
  function availablePeriods(ch) {
    const d = (window.GLYPH_INDEX || {})[ch] || {};
    const out = {};
    PERIODS.forEach(p => {
      if (p.key === "regular") { out.regular = "system"; return; }
      if (d[p.key]) out[p.key] = p.key;
      else if (p.fallback && d[p.fallback]) out[p.key] = p.fallback;
    });
    return out;
  }

  /* ==================== 历史记录存储 ==================== */
  const HIST_KEY = "lines_studio_history";
  const HIST_MAX = 60;

  function histLoad() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function histSave(list) {
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(list));
    } catch (e) {
      toast("历史记录保存失败：本地存储空间不足", "err");
    }
    refreshHistBadge();
  }
  function histAdd(rec) {
    const list = histLoad();
    list.unshift(rec);
    histSave(list.slice(0, HIST_MAX));
    refreshHistBadge();
    renderHistoryView();
  }
  function histClear() {
    localStorage.removeItem(HIST_KEY);
    S.histSel = null;
    refreshHistBadge();
    renderHistoryView();
    renderHistDrawer();
    toast("历史记录已清空", "ok");
  }
  function refreshHistBadge() {
    const n = histLoad().length;
    const b = $("histBadge"), nc = $("navHistCount");
    if (b) { b.textContent = n; b.style.display = n ? "grid" : "none"; }
    if (nc) nc.textContent = n;
    const hn = $("histCountNote");
    if (hn) hn.textContent = n + " 条";
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function fmtAgo(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return "刚刚";
    if (s < 3600) return Math.floor(s / 60) + " 分钟前";
    if (s < 86400) return Math.floor(s / 3600) + " 小时前";
    return Math.floor(s / 86400) + " 天前";
  }

  /* ==================== 路由 ==================== */
  const ROUTES = {
    etym:     { title: "字源解析",   sub: "繁体溯源 · 古文字形 · 字际系联" },
    lineage:  { title: "字源解析",   sub: "繁体溯源 · 古文字形 · 字际系联" }, // 旧路由兼容：重定向至 etym
    game:     { title: "字源游戏",   sub: "古字猜谜 · 部件拼字 · 声符字族" },
    author:   { title: "多场景创编", sub: "文化故事 / 动画脚本" },
    history:  { title: "生成历史",   sub: "API 调用记录与提示词回溯" },
    tpl:      { title: "Prompt 模板库", sub: "标准化多语种提示词" },
    perf:     { title: "性能评测",   sub: "响应速率与适配达标率" },
    settings: { title: "模型与设置", sub: "接口配置与数据来源" }
  };

  function go(route, opt) {
    if (route === "lineage" || route === "dash") route = "etym"; // 系联已并入字源解析；总览已移除
    if (!ROUTES[route]) route = "etym";
    S.route = route;
    qsa(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.route === route));
    qsa(".view").forEach(el => el.classList.toggle("active", el.id === "view-" + route));
    const r = ROUTES[route];
    $("crumbMain").textContent = r.title;
    $("crumbSub").textContent  = r.sub;
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (opt && opt.mode) setMode(opt.mode);
    if (route === "etym") renderEtym();   // 内含：繁体溯源 → 古文字形 → 本义 → 字际系联
    if (route === "game") renderGame();
    if (route === "history") renderHistoryView();
    if (route === "tpl") renderTpl();
    if (route === "perf") renderPerf();
    if (route === "settings") renderAssets();
  }

  /* ==================== 初始化 ==================== */
  function init() {
    API.loadCfg();
    bindNav();
    bindCharInput();
    bindParams();
    bindTabs();
    bindSettings();
    bindHistory();
    syncConnUI();
    updateHskChip();
    $("charInput").value = "我";
    refreshHistBadge();

    const st = window.GLYPH_STATS || {};
    const total = (window.GLYPH_INDEX ? Object.keys(window.GLYPH_INDEX).length : 0);
    $("footGlyphCount").textContent = total || "—";
    const libCount = Object.keys(window.CHARLIB || {}).length;
    $("footDictCount").textContent  = libCount || Object.keys(ETYMO_DICT).length;

    // 构建声符字族索引：声符字符 -> 同声符字列表
    PHON_FAM = {};
    RAD_INDEX = {};
    const _cl = window.CHARLIB || {};
    for (const k in _cl) {
      const p = _cl[k].pho; if (p) { (PHON_FAM[p] = PHON_FAM[p] || []).push(k); }
      const r = _cl[k].rad; if (r) { (RAD_INDEX[r] = RAD_INDEX[r] || []).push(k); }
    }

    go("etym");
    loadDemo();
  }

  /* ==================== 绑定：导航 ==================== */
  function bindNav() {
    qsa(".nav-item").forEach(el => {
      el.onclick = () => go(el.dataset.route);
    });
    qsa(".quick-card[data-go]:not([data-gt])").forEach(el => {
      el.onclick = () => go(el.dataset.go, { mode: el.dataset.mode });
    });
    const qd = $("qcDemo"); if (qd) qd.onclick = () => loadDemo();
  }

  /* ==================== 绑定：全局字输入 ==================== */
  function bindCharInput() {
    const inp = $("charInput");
    inp.addEventListener("input", () => {
      const arr = Array.from(inp.value.replace(/[^\u4e00-\u9fff\u3400-\u4dbf]/g, "")).slice(0, 4);
      S.chars = arr.length ? arr : ["我"];
      $("charCount").textContent = S.chars.length + "/4";
      onCharChange();
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { inp.blur(); }
    });
  }
  let charTimer = null;
  function onCharChange() {
    clearTimeout(charTimer);
    charTimer = setTimeout(() => {
      const dc = $("dashChar"); if (dc) dc.textContent = S.chars.join("");
      if (S.route === "etym" || S.route === "lineage") renderEtym();
    }, 220);
  }

  /* ==================== 绑定：参数 ==================== */
  function bindParams() {
    qsa("#modeSwitch .mode-card").forEach(el => {
      el.onclick = () => setMode(el.dataset.mode);
    });
    $("hskRange").oninput = (e) => {
      S.hsk = +e.target.value;
      updateHskChip();
    };
    $("langSel").onchange = (e) => { S.lang = e.target.value; };
    $("regionSel").onchange = (e) => { S.region = e.target.value; };
    qsa("#moduleOpts .opt").forEach(el => {
      el.onclick = () => {
        const m = el.dataset.mod;
        if (S.modules.has(m)) S.modules.delete(m); else S.modules.add(m);
        el.classList.toggle("on", S.modules.has(m));
      };
    });
    $("btnGen").onclick = () => generate();
  }

  function setMode(m) {
    S.mode = m;
    qsa("#modeSwitch .mode-card").forEach(el => el.classList.toggle("active", el.dataset.mode === m));
    $("regionField").style.display = (m === "script") ? "" : "none";
  }

  function updateHskChip() {
    const m = HSK_MATRIX[S.hsk] || HSK_MATRIX[3];
    $("hskBadge").textContent = S.hsk + " 级";
    $("hskDesc").innerHTML = `
      <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px">
        <span>词汇量 <b class="mono">${m.vocab}</b></span>
        <span>篇幅 <b class="mono">${m.words}</b> 字</span>
      </div>
      <div style="margin-top:4px">${esc(m.sentence)}</div>
      <div style="color:var(--ink-3)">${esc(m.grammar)} · ${esc(m.tone)}</div>`;
  }

  /* ==================== 绑定：结果 Tab ==================== */
  function bindTabs() {
    qsa("#tabs .tab").forEach(el => {
      el.onclick = () => activateTab(el.dataset.tab);
    });
  }
  function activateTab(name) {
    qsa("#tabs .tab").forEach(el => el.classList.toggle("active", el.dataset.tab === name));
    qsa(".tab-pane").forEach(el => el.classList.toggle("active", el.id === "pane-" + name));
  }

  /* ==================== 绑定：设置 ==================== */
  function bindSettings() {
    qsa("#providerGrid .provider").forEach(el => {
      el.onclick = () => {
        qsa("#providerGrid .provider").forEach(x => x.classList.remove("active"));
        el.classList.add("active");
        const p = API.PROVIDERS[el.dataset.pv];
        if (p && el.dataset.pv !== "custom") {
          $("cfgUrl").value = p.url;
          $("cfgModel").value = p.model;
        }
      };
    });
    $("cfgTemp").oninput = (e) => { $("tempVal").textContent = (+e.target.value / 100).toFixed(2); };
    $("btnSaveCfg").onclick = () => {
      API.CFG.url = $("cfgUrl").value.trim();
      API.CFG.key = $("cfgKey").value.trim();
      API.CFG.model = $("cfgModel").value.trim();
      API.CFG.temp = +$("cfgTemp").value / 100;
      API.CFG.strict = $("cfgStrict").value;
      API.saveCfg();
      syncConnUI();
      toast("配置已保存到本地", "ok");
    };
    $("btnTestConn").onclick = async () => {
      API.CFG.url = $("cfgUrl").value.trim();
      API.CFG.key = $("cfgKey").value.trim();
      API.CFG.model = $("cfgModel").value.trim();
      const r = await API.testConnection();
      toast(r.msg, r.ok ? "ok" : "err");
      syncConnUI();
    };
    $("btnConfig").onclick = () => go("settings");
    $("btnExport").onclick = exportJSON;
  }

  function syncConnUI() {
    const on = API.hasKey();
    const p = $("statusPill"), t = $("statusText");
    p.classList.toggle("on", on);
    t.textContent = on ? (API.CFG.model || "已配置") : "未配置模型";
    const cfg = API.CFG;
    $("cfgUrl").value = cfg.url || "";
    $("cfgKey").value = cfg.key || "";
    $("cfgModel").value = cfg.model || "";
    $("cfgStrict").value = cfg.strict || "json_object";
    $("tempVal").textContent = (cfg.temp != null ? cfg.temp : 0.75).toFixed(2);
    $("cfgTemp").value = Math.round((cfg.temp != null ? cfg.temp : 0.75) * 100);
  }

  /* ==================== 绑定：历史 ==================== */
  function bindHistory() {
    $("btnHist").onclick = () => { renderHistDrawer(); $("histDrawer").classList.add("open"); $("drawerMask").classList.add("show"); };
    $("btnCloseHist").onclick = closeHist;
    $("drawerMask").onclick = closeHist;
    $("btnClearHist").onclick = histClear;
    $("btnClearHist2").onclick = histClear;
    $("btnExportHist").onclick = exportHist;
    $("btnExportHist2").onclick = exportHist;
  }
  function closeHist() {
    $("histDrawer").classList.remove("open");
    $("drawerMask").classList.remove("show");
  }


  /* ==================== 视图：字源解析 ==================== */
  function renderEtym() {
    const ch = S.chars[0];
    const box = $("etymBody");
    const e = localEtymology(ch);
    const inLib = !ETYMO_DICT[ch] && !!(window.CHARLIB && window.CHARLIB[ch]);
    const srcTag = ETYMO_DICT[ch]
      ? '<span class="src-tag local">本地语料</span>'
      : (inLib ? '<span class="src-tag local">本地字库 · 结构推导</span>'
               : '<span class="src-tag local">未收录</span>');

    box.innerHTML = `
      <div class="sec-nav" id="secNav">
        <span class="sn-lbl">本页章节</span>
        <button class="sn-chip" data-sec="sec-origin">① 正体溯源</button>
        <button class="sn-chip" data-sec="sec-glyph">② 字形演变</button>
        <button class="sn-chip" data-sec="sec-stroke">③ 笔顺演示</button>
        <button class="sn-chip" data-sec="sec-meaning">④ 本义与六书</button>
        <button class="sn-chip" data-sec="sec-lineage">⑤ 字际系联</button>
      </div>

      <div class="sect" id="sec-origin">
        <div class="sect-hd">
          <h3>正体溯源 <span class="sh-note">Back to the Original Form</span></h3>
          <div class="sh-right"><span class="src-tag local">解析起点 · 本地固定</span></div>
        </div>
        <div class="sect-bd">
          <div class="trad-card">
            <div class="trad-line">
              <span class="big-glyph" style="font-size:40px">${esc(ch)}</span>
              <span class="trad-arrow">→</span>
              <span class="big-glyph" style="font-size:40px">${esc(e.traditional || ch)}</span>
            </div>
            <p class="text-sm text-muted" style="margin-top:12px">${
              e.traditional
                ? `「${esc(ch)}」是「${esc(e.traditional)}」的简化字。本页以下所有字形、笔顺、说文段与系联网络，一律先回归正体「${esc(e.traditional)}」再展开考据。`
                : `「${esc(ch)}」传承字形即为正体，未见简化关系。以下直接由其古文字形入手考据。`
            }</p>
          </div>
          <p class="gt-note">溯源规则：凡该字存在繁体正体，先追溯正体，再查《说文解字》、结构字库与甲金篆字形；无繁体者径由古文字形入手。</p>
        </div>
      </div>

      <div class="sect" id="sec-glyph">
        <div class="sect-hd">
          <h3>字形演变 <span class="sh-note">Glyph Evolution · 5 体${e.traditional ? " · 按正体 " + esc(e.traditional) : ""}</span></h3>
          <div class="sh-right"><span class="src-tag local">本地固定 · 不消耗 Token</span></div>
        </div>
        <div class="sect-bd">
          <div class="glyph-tl" id="glyphTL">${PERIODS.map(p => `
            <div class="gt-cell" data-p="${p.key}">
              <div class="gt-stage">${p.name}</div>
              <div class="gt-era">${p.era}</div>
              <div class="gt-box" id="gt-${p.key}"><span style="color:#C4BDB1">…</span></div>
              <div class="gt-src" id="gts-${p.key}"></div>
            </div>`).join("")}
          </div>
          <p class="gt-note">字形按 Unicode 码位索引懒加载，仅在查看该字时请求。缺字处按学术事实标注，不以今字冒充古字形。</p>
        </div>
      </div>

      <div class="sect" id="sec-stroke">
        <div class="sect-hd">
          <h3>笔顺演示 <span class="sh-note">Stroke Order</span></h3>
          <div class="sh-right"><span class="src-tag ai">hanzi-writer · CDN</span></div>
        </div>
        <div class="sect-bd">
          <div class="stroke-wrap">
            <div id="strokeCanvas" class="stroke-canvas"></div>
            <div class="stroke-side">
              <p class="text-sm text-muted" id="strokeMeta" style="margin:0 0 10px">—</p>
              <div class="stroke-ctrl">
                <button class="btn btn-sm" id="strokePlay">▶ 播放笔顺</button>
                <button class="btn btn-sm btn-ghost" id="strokeAnim">↻ 依次描画</button>
                <button class="btn btn-sm btn-ghost" id="strokeQuiz">✎ 描红练习</button>
              </div>
              <p class="gt-note" style="margin-top:10px">笔顺数据源自 hanzi-writer-data（CC BY-SA 4.0）。繁体溯源时演示正体笔顺。</p>
            </div>
          </div>
        </div>
      </div>

      <div class="sect" id="sec-meaning">
        <div class="sect-hd"><h3>本义与六书</h3><div class="sh-right">${srcTag}</div></div>
        <div class="sect-bd">
          <div class="etymo-card">
            <div class="etymo-top">
              <div class="big-glyph">${esc(ch)}</div>
              <div class="etymo-info">
                <h3 class="font-serif-cn">${esc(ch)} <span class="text-sm text-muted" style="font-weight:400">${esc(e.radical || "")}部 · ${esc(e.liushu || "")}</span></h3>
                <div class="pinyin-line">${esc(e.pinyin || "")}</div>
                <div class="badges">
                  <span class="badge badge-liu">${esc(e.liushu || "—")}</span>
                  ${e.struct ? `<span class="badge" style="background:#EDE7DA;color:#6B5B43">${esc(e.struct)}</span>` : ""}
                  <span class="badge badge-ben">本义 · ${esc((e.original_meaning || "").slice(0, 14))}${((e.original_meaning || "").length > 14) ? "…" : ""}</span>
                  <span class="badge badge-hsk">HSK ${e.hsk || 1} 级</span>
                </div>
              </div>
            </div>
          </div>
          <div class="grid-2 mt-12">
            <div class="card acc-cin"><h4>${e.isLib ? "英文释义" : "本义"}</h4><p>${esc(e.original_meaning || "—")}</p></div>
            <div class="card acc-ind"><h4>引申义链</h4>${(e.extended_meanings || []).length
              ? `<ul style="padding-left:16px">${e.extended_meanings.map(m => `<li>${esc(m)}</li>`).join("")}</ul>`
              : `<p class="text-muted">—</p>`}</div>
          </div>
          ${e.ids && Array.isArray(e.ids.seq) ? `
          <div class="sec-title mt-16">IDS 字形描述序列 <span class="st-note">Ideographic Description Sequence</span></div>
          <div class="ids-seq">${e.ids.seq.map(t => IDS_OP[t]
            ? `<span class="ids-op" title="${esc(IDS_OP[t])}">${esc(t)} ${esc(IDS_OP[t])}</span>`
            : `<span class="ids-frag font-serif-cn">${esc(t)}</span>`).join("")}</div>
          <p class="ids-note">${esc(e.ids.note || "")}</p>` : ""}
          <div class="sec-title mt-16">构件拆分 <span class="st-note">Component Decomposition</span></div>
          <div class="grid-2">${(e.components || []).map(c => `
            <div class="card acc-cin"><h4>${esc(c.part)} · <span class="text-muted" style="font-weight:400">${esc(c.role)}</span></h4>
            <p>${esc(c.gloss)}</p></div>`).join("") || `<p class="text-sm text-muted">暂无构件数据</p>`}</div>
          ${e.shuowen ? `
          <div class="sec-title mt-16">《说文解字》 <span class="st-note">Shuōwén Jiězì · ${esc(e.shuowen.sixBooks || "")}</span></div>
          <div class="card acc-cin"><p class="font-serif-cn" style="line-height:1.95;font-size:15px">${esc(e.shuowen.shuowen || e.shuowen.summary || "")}</p></div>` : ""}
          <div class="sec-title mt-16">字书佐证 <span class="st-note">Philological Evidence</span></div>
          <div class="card acc-gold"><p class="font-serif-cn">${esc(e.citation || "—")}</p></div>
          ${e.cultural && ((e.cultural.allusions || []).length || (e.cultural.words || []).length) ? `
          <div class="sec-title mt-16">文化典故 <span class="st-note">Cultural Allusions</span></div>
          ${(e.cultural.allusions || []).slice(0, 4).map(a => `<div class="card acc-gold" style="margin-bottom:8px"><p class="font-serif-cn" style="line-height:1.7">${esc(a)}</p></div>`).join("")}
          <div class="grid-2" style="margin-top:10px">${(e.cultural.words || []).slice(0, 6).map(w => `<div class="card acc-ind"><p>${esc(w)}</p></div>`).join("")}</div>` : ""}
        </div>
      </div>`;

    loadGlyphTimeline(ch, e.traditional || null);
    initStroke(ch, e.traditional || null);
    renderLineage(ch, e.traditional || null);   // 回归正体之后再展开系联
    bindSecNav();
  }

  // 章节快速跳转：页面较长时便于在「溯源 → 字形 → 笔顺 → 本义 → 系联」之间移动
  function bindSecNav() {
    qsa("#secNav .sn-chip").forEach(btn => {
      btn.onclick = () => {
        const t = $(btn.dataset.sec);
        if (!t) return;
        const y = t.getBoundingClientRect().top + window.pageYOffset - 72;
        window.scrollTo({ top: y, behavior: "smooth" });
      };
    });
  }

  // 黑块检测：填充型字形若渲染后近全黑(>75%)，判定为异常字形，隐藏并提示，避免出现"一大片黑色"
  async function guardBlob(box, src) {
    const svg = box.querySelector("svg");
    if (!svg) return;
    if (svg.getAttribute("stroke") && svg.getAttribute("stroke") !== "none") return; // 描边型(如甲骨骨架)永不黑块
    try {
      const clone = svg.cloneNode(true);
      clone.setAttribute("fill", "#000");
      clone.setAttribute("fill-rule", "evenodd");
      const data = new XMLSerializer().serializeToString(clone);
      const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(data);
      const img = new Image();
      await new Promise(res => { img.onload = res; img.onerror = res; img.src = url; });
      if (!img.width) return;
      const c = document.createElement("canvas"); c.width = 64; c.height = 64;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, 64, 64);
      const px = ctx.getImageData(0, 0, 64, 64).data;
      let dark = 0, total = 0;
      for (let i = 0; i < px.length; i += 4) {
        total++;
        if (px[i + 3] > 30 && px[i] < 90 && px[i + 1] < 90 && px[i + 2] < 90) dark++;
      }
      if (dark / total > 0.75) {
        box.innerHTML = `<div class="gt-miss">该期字形暂缺</div>`;
        src.textContent = "（字形异常·已隐藏）";
      }
    } catch (e) { /* 检测失败则保持原样 */ }
  }

  // 本地 SVG 兜底：走 ob 干净描边 / etymology-svg，并做黑块检测
  async function tryLocalGlyph(box, src, ch, p, cp) {
    const av = availablePeriods(ch);
    const actual = av[p.key];
    if (!actual) {
      box.innerHTML = `<div class="gt-miss">该期无此字形</div>`;
      src.textContent = "—";
      return;
    }
    let svg = null, used = actual;
    if (p.key === "oracle" && window.OB_SET && window.OB_SET.indexOf("u" + cp) >= 0) {
      svg = await loadGlyph(ch, "ob:" + cp);
      if (svg) used = "ob";
    }
    if (!svg) svg = await loadGlyph(ch, actual);
    if (svg) {
      box.innerHTML = svg;
      if (used === "ob") {
        src.textContent = "甲骨描边骨架 · CC-BY 4.0";
      } else {
        src.textContent = (actual === "ob" ? "CC-BY 4.0 骨架" : "etymology-svg") +
                          (actual !== p.key ? " · 补录" : "");
      }
      await guardBlob(box, src);
    } else {
      box.innerHTML = `<div class="gt-miss">加载失败</div>`;
      src.textContent = "—";
    }
  }

  async function loadGlyphTimeline(ch, trad) {
    // 古文字（甲金篆）字形属于繁体正体：凡有繁体，先按正体取字形
    const g = trad || ch;
    const cp = g.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    const hanIdx = window.HAN_INDEX || {};
    const hanEntry = hanIdx[g] || hanIdx[ch] || {};
    for (const p of PERIODS) {
      const box = $("gt-" + p.key), src = $("gts-" + p.key);
      if (!box) continue;
      if (p.key === "regular") {
        box.innerHTML = `<span class="gt-fallback">${esc(ch)}</span>${
          trad ? `<span class="gt-trad-mark" title="繁体正体">${esc(trad)}</span>` : ""}`;
        src.textContent = trad ? "简化字 → 正体对照" : "霞鹜文楷 LXGW WenKai";
        continue;
      }
      // 优先使用汉典字源 SVG（<img> + no-referrer 绕过防盗链，最省资源）
      const hscript = HAN_SCRIPT[p.key];
      const hanUrl = hscript ? (hanEntry[hscript] || null) : null;
      if (hanUrl) {
        const img = document.createElement("img");
        img.className = "han-glyph";
        img.alt = p.name + " · 汉典";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";   // 关键：汉典防盗链检查 Referer，设为 no-referrer 绕过
        src.textContent = "汉典字源 · zdic.net";
        img.onload  = () => { src.textContent = "汉典字源 · zdic.net"; };
        img.onerror = () => { tryLocalGlyph(box, src, g, p, cp); };
        box.innerHTML = "";
        box.appendChild(img);
        img.src = hanUrl;
        continue;
      }
      await tryLocalGlyph(box, src, g, p, cp);
    }
  }

  /* ==================== 视图：字源游戏 ==================== */
  const GAME_TABS = [
    { key: "glyph", name: "古字猜谜", note: "看甲骨金文猜今字" },
    { key: "build", name: "部件拼字", note: "按结构拼出目标字" },
    { key: "series", name: "声符字族", note: "辨识同声符字族" }
  ];
  const GAME = { tab: "glyph", score: 0, round: 0, answer: null, picked: [], state: {} };

  const rnd = (a) => a[Math.floor(Math.random() * a.length)];
  const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

  // 题库：有早期字形且结构字库收录的字
  let QUIZ_POOL = null;
  function buildQuizPool() {
    if (QUIZ_POOL) return QUIZ_POOL;
    const HI = window.HAN_INDEX || {}, CL = window.CHARLIB || {}, GC = window.GLYPH_CHARS || {};
    QUIZ_POOL = Object.keys(HI).filter(c => {
      const e = HI[c];
      const hasAncient = !!(e.jiaguwen || e.jinwen || e.xiaozhuan);
      const hasLocal = GC[c] && (GC[c].includes("oracle") || GC[c].includes("bronze") || GC[c].includes("seal"));
      return (hasAncient || hasLocal) && CL[c] && /^[\u4e00-\u9fa5]$/.test(c);
    });
    return QUIZ_POOL;
  }

  function renderGame() {
    const body = $("gameBody");
    if (!body) return;
    body.innerHTML = `
      <div class="sect">
        <div class="sect-hd">
          <h3>字源游戏 <span class="sh-note">Local · 不消耗 Token</span></h3>
          <div class="sh-right">
            <span class="badge badge-ben">回合 ${GAME.round}</span>
            <span class="badge badge-liu">答对 ${GAME.score}</span>
            <button class="btn btn-sm" id="gameReset" style="margin-left:6px">重置</button>
          </div>
        </div>
        <div class="sect-bd">
          <div class="game-tabs">${GAME_TABS.map(t => `
            <button class="g-tab${GAME.tab === t.key ? " active" : ""}" data-gt="${t.key}">${t.name}
              <span class="g-tab-note">${t.note}</span></button>`).join("")}
          </div>
          <div id="gameStage"></div>
        </div>
      </div>`;
    qsa(".g-tab", body).forEach(btn => btn.onclick = () => { GAME.tab = btn.dataset.gt; GAME.state = {}; renderGame(); });
    const rs = $("gameReset"); if (rs) rs.onclick = () => { GAME.score = 0; GAME.round = 0; GAME.state = {}; renderGame(); };
    if (GAME.tab === "glyph") newGlyphRound();
    if (GAME.tab === "build") newBuildRound();
    if (GAME.tab === "series") newSeriesRound();
  }

  function gameCard(inner, footNote) {
    return `<div class="game-card">${inner}</div>${footNote ? `<p class="gt-note">${footNote}</p>` : ""}`;
  }

  /* ---- 游戏一：古字猜谜 ---- */
  function newGlyphRound() {
    const stage = $("gameStage"); if (!stage) return;
    const pool = buildQuizPool();
    if (!pool.length) { stage.innerHTML = gameCard("<p class='text-muted'>字形题库不可用。</p>"); return; }
    const target = rnd(pool);
    const HI = window.HAN_INDEX || {}, GC = window.GLYPH_CHARS || {}, CL = window.CHARLIB || {};
    const e = HI[target] || {};
    const periods = (GC[target] || []);
    let url = null, pname = "";
    if (e.jiaguwen) { url = e.jiaguwen; pname = "甲骨文"; }
    else if (e.jinwen) { url = e.jinwen; pname = "金文"; }
    else if (e.xiaozhuan) { url = e.xiaozhuan; pname = "小篆"; }
    const localPeriod = url ? null : (periods.includes("oracle") ? "oracle" : (periods.includes("bronze") ? "bronze" : "seal"));
    if (!url && !localPeriod) { setTimeout(newGlyphRound, 0); return; }

    // 干扰项：优先同部首，其次随机
    let opts = [target];
    const sameRad = (RAD_INDEX[(CL[target] || {}).rad] || []).filter(c => c !== target && /^[\u4e00-\u9fa5]$/.test(c));
    while (opts.length < 4 && sameRad.length) { const c = rnd(sameRad); if (!opts.includes(c)) opts.push(c); }
    while (opts.length < 4) { const c = rnd(pool); if (!opts.includes(c)) opts.push(c); }
    opts = shuffle(opts);
    GAME.round++;
    GAME.answer = target; GAME.state = { kind: "glyph", url, pname, localPeriod, opts };

    const fig = url
      ? `<img class="quiz-fig" src="${url}" alt="古文字形" referrerpolicy="no-referrer" loading="lazy">`
      : `<span class="quiz-fig-fallback">${esc(target)}<span class="q-note">暂用今字字形</span></span>`;
    stage.innerHTML = gameCard(`
      <div class="game-fig-box">
        ${fig}
        <div class="game-fig-meta"><b>${esc(pname || "古文字形")}</b> · 请选出对应的今字</div>
      </div>
      <div class="sec-title mt-16">候选字形</div>
      <div class="game-opts">${opts.map(c => `<button class="opt-btn font-serif-cn" data-opt="${esc(c)}">${esc(c)}</button>`).join("")}</div>
      <div class="game-fb" id="gameFb"></div>`,
      "字形取自汉典字源（zdic.net）与本地开源字形库，均为离线缓存。" );
    qsa(".opt-btn", stage).forEach(b => b.onclick = () => judgeGlyph(b.dataset.opt));
  }

  function judgeGlyph(pick) {
    const fb = $("gameFb"); if (!fb) return;
    const ok = pick === GAME.answer;
    if (ok) GAME.score++;
    const t = GAME.answer, SW = window.SHUOWEN || {}, CL = window.CHARLIB || {};
    const sw = (SW[t] && SW[t].shuowen) ? SW[t].shuowen.slice(0, 60) : "";
    fb.className = "game-fb " + (ok ? "ok" : "no");
    fb.innerHTML = `${ok ? "✓ 答对" : "✗ 正确答案：<b class='font-serif-cn'>" + esc(t) + "</b>"}
      <div class="fb-detail">拼音 ${esc((CL[t] || {}).py || "—")} · 部首 ${esc((CL[t] || {}).rad || "—")} · 六书 ${esc((CL[t] || {}).liu || "—")}
      ${sw ? `<br>《说文》：${esc(sw)}…` : ""}</div>
      <button class="btn btn-sm" id="nextRound" style="margin-top:8px">下一题 →</button>`;
    qsa(".opt-btn", $("gameStage")).forEach(b => { b.disabled = true; if (b.dataset.opt === GAME.answer) b.classList.add("correct"); else if (b.dataset.opt === pick) b.classList.add("wrong"); });
    const nx = $("nextRound"); if (nx) nx.onclick = () => { if (GAME.tab === "glyph") newGlyphRound(); };
  }

  /* ---- 游戏二：部件拼字 ---- */
  function newBuildRound() {
    const stage = $("gameStage"); if (!stage) return;
    const CL = window.CHARLIB || {};
    const pool = Object.keys(CL).filter(c => /^[\u4e00-\u9fa5]$/.test(c) &&
      (CL[c].comp || []).length >= 2 && (CL[c].comp || []).length <= 4 && CL[c].st);
    if (!pool.length) { stage.innerHTML = gameCard("<p class='text-muted'>构件题库不可用。</p>"); return; }
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      const c = rnd(pool);
      const parts = (CL[c].comp || []).map(x => x[0]);
      if (new Set(parts).size === parts.length && parts.every(p => /^[\u4e00-\u9fa5]$/.test(p))) target = c;
    }
    if (!target) { setTimeout(newBuildRound, 0); return; }
    const lib = CL[target];
    const parts = (lib.comp || []).map(x => x[0]);
    // 干扰构件
    const all = Object.keys(window.COMP_INDEX || {}).filter(p => /^[\u4e00-\u9fa5]$/.test(p) && !parts.includes(p));
    const distract = [];
    while (distract.length < 3 && all.length) { const p = rnd(all); if (!distract.includes(p)) distract.push(p); }
    GAME.round++; GAME.answer = target; GAME.picked = [];
    GAME.state = { kind: "build", parts, distract, tiles: shuffle(parts.concat(distract)) };

    stage.innerHTML = gameCard(`
      <div class="game-prompt">
        <div class="gp-label">目标字读音与释义</div>
        <div class="gp-py">${esc(lib.py || "—")} · ${esc(lib.rad || "")}部</div>
        <div class="gp-gloss">${esc(lib.gl || "（无英文释义）")}</div>
        <span class="badge badge-liu">结构：${esc(lib.st || "—")}</span>
        <span class="badge badge-ben">需选出 ${parts.length} 个构件</span>
      </div>
      <div class="sec-title mt-16">构件候选（点击选入）</div>
      <div class="game-opts">${GAME.state.tiles.map((p, i) => `<button class="opt-btn tile-btn font-serif-cn" data-idx="${i}">${esc(p)}</button>`).join("")}</div>
      <div class="mt-12"><span class="text-sm text-muted">已选：</span><span id="pickRow" class="pick-row"></span></div>
      <div class="mt-12"><button class="btn btn-sm" id="buildCheck">✓ 校验</button></div>
      <div class="game-fb" id="gameFb"></div>`,
      "构件数据来自 makemeahanzi 开源字库（CC BY-SA 4.0）。");
    qsa(".tile-btn", stage).forEach(b => b.onclick = () => toggleTile(Number(b.dataset.idx)));
    const ck = $("buildCheck"); if (ck) ck.onclick = judgeBuild;
  }

  function toggleTile(i) {
    const st = GAME.state; if (!st || st.kind !== "build") return;
    const v = st.tiles[i];
    const at = GAME.picked.indexOf(i);
    if (at >= 0) GAME.picked.splice(at, 1); else GAME.picked.push(i);
    qsa(".tile-btn", $("gameStage")).forEach(b => b.classList.toggle("sel", GAME.picked.includes(Number(b.dataset.idx))));
    const sel = GAME.picked.map(k => st.tiles[k]);
    const row = $("pickRow");
    if (row) row.innerHTML = sel.length ? sel.map(p => `<span class="pick-chip font-serif-cn">${esc(p)}</span>`).join("") : `<span class="text-muted text-sm">尚未选择</span>`;
  }

  function judgeBuild() {
    const fb = $("gameFb"); if (!fb) return;
    const st = GAME.state;
    const sel = GAME.picked.map(k => st.tiles[k]);
    const ok = sel.length === st.parts.length && st.parts.every(p => sel.includes(p));
    if (ok) GAME.score++;
    fb.className = "game-fb " + (ok ? "ok" : "no");
    fb.innerHTML = `${ok ? "✓ 拼合正确" : "✗ 不正确"}
      <div class="fb-detail">正确答案：<b class="font-serif-cn">${esc(GAME.answer)}</b> ＝ ${st.parts.map(p => esc(p)).join(" ＋ ")}</div>
      <button class="btn btn-sm" id="nextRound" style="margin-top:8px">下一题 →</button>`;
    const nx = $("nextRound"); if (nx) nx.onclick = () => { if (GAME.tab === "build") newBuildRound(); };
  }

  /* ---- 游戏三：声符字族 ---- */
  function newSeriesRound() {
    const stage = $("gameStage"); if (!stage) return;
    const fams = Object.keys(PHON_FAM).filter(p =>
      /^[\u4e00-\u9fa5]$/.test(p) && PHON_FAM[p].length >= 4 &&
      PHON_FAM[p].every(c => /^[\u4e00-\u9fa5]$/.test(c)));
    if (!fams.length) { stage.innerHTML = gameCard("<p class='text-muted'>声符题库不可用。</p>"); return; }
    const pho = rnd(fams), members = PHON_FAM[pho];
    const answer = rnd(members);
    // 干扰项：其他声符字族成员
    const others = [];
    for (let i = 0; i < 40 && others.length < 3; i++) {
      const m = rnd(PHON_FAM[rnd(fams.filter(f => f !== pho))]);
      const c = rnd(m);
      if (c !== answer && !members.includes(c) && !others.includes(c)) others.push(c);
    }
    const opts = shuffle([answer].concat(others));
    GAME.round++; GAME.answer = answer;
    GAME.state = { kind: "series", opts, pho, members };

    stage.innerHTML = gameCard(`
      <div class="game-prompt">
        <div class="gp-label">下列哪个字属于以「<b class="font-serif-cn">${esc(pho)}</b>」为声符的字族？</div>
        <div class="gp-py">同族共 ${members.length} 字</div>
      </div>
      <div class="sec-title mt-16">候选字</div>
      <div class="game-opts">${opts.map(c => `<button class="opt-btn font-serif-cn" data-opt="${esc(c)}">${esc(c)}</button>`).join("")}</div>
      <div class="game-fb" id="gameFb"></div>`,
      "声符索引由 makemeahanzi 结构字库推导，反映形声系统的孳乳关系。");
    qsa(".opt-btn", stage).forEach(b => b.onclick = () => judgeSeries(b.dataset.opt));
  }

  function judgeSeries(pick) {
    const fb = $("gameFb"); if (!fb) return;
    const ok = pick === GAME.answer;
    if (ok) GAME.score++;
    const st = GAME.state, CL = window.CHARLIB || {};
    fb.className = "game-fb " + (ok ? "ok" : "no");
    fb.innerHTML = `${ok ? "✓ 答对" : "✗ 不正确"}
      <div class="fb-detail">声符「${esc(st.pho)}」字族成员：${st.members.slice(0, 12).map(c => `<span class="pick-chip font-serif-cn">${esc(c)}</span>`).join(" ")}
      ${((CL[GAME.answer] || {}).py) ? `<br>「${esc(GAME.answer)}」读音 ${esc(CL[GAME.answer].py)}` : ""}</div>
      <button class="btn btn-sm" id="nextRound" style="margin-top:8px">下一题 →</button>`;
    qsa(".opt-btn", $("gameStage")).forEach(b => { b.disabled = true; if (b.dataset.opt === GAME.answer) b.classList.add("correct"); else if (b.dataset.opt === pick) b.classList.add("wrong"); });
    const nx = $("nextRound"); if (nx) nx.onclick = () => { if (GAME.tab === "series") newSeriesRound(); };
  }

  /* ==================== 笔顺演示（hanzi-writer · CDN 懒加载） ==================== */
  let STROKE = null;
  async function initStroke(ch, trad) {
    const wrap = $("strokeCanvas"), meta = $("strokeMeta");
    if (!wrap) return;
    wrap.innerHTML = ""; STROKE = null;
    const HW = window.HanziWriter;
    if (!HW) {
      wrap.innerHTML = `<span class="stroke-offline">笔顺库未加载<br><span class="stroke-offline-sub">联网后自动启用</span></span>`;
      if (meta) meta.textContent = "离线环境或 CDN 不可达时暂不可用（不影响其余功能）。";
      return;
    }
    const cands = Array.from(new Set([trad, ch].filter(Boolean)));
    let target = null;
    for (const c of cands) {
      try { await HW.loadCharacterData(c); target = c; break; } catch (_) { /* 换候选 */ }
    }
    if (!target) {
      wrap.innerHTML = `<span class="stroke-offline">该字暂无笔顺数据</span>`;
      if (meta) meta.textContent = "—";
      return;
    }
    try {
      STROKE = HW.create(wrap, target, {
        width: 170, height: 170, padding: 12,
        showOutline: true, showCharacter: true,
        strokeColor: "#2F2A25", outlineColor: "#DFD7C9", radicalColor: "#C23B2A",
        strokeAnimationSpeed: 1, delayBetweenStrokes: 280
      });
    } catch (_) {
      wrap.innerHTML = `<span class="stroke-offline">笔顺初始化失败</span>`;
      return;
    }
    if (meta) {
      meta.textContent = target !== ch
        ? `演示字形：${target}（「${ch}」的繁体正体笔顺）`
        : `演示字形：${target}`;
    }
    const play = $("strokePlay"), loop = $("strokeAnim"), quiz = $("strokeQuiz");
    if (play) play.onclick = () => STROKE && STROKE.animateCharacter();
    if (loop) loop.onclick = () => STROKE && STROKE.loopCharacterAnimation();
    if (quiz) quiz.onclick = () => STROKE && STROKE.quiz({ onComplete: () => { if (meta) meta.textContent = "描红完成，书写正确。"; } });
  }

  /* ==================== 视图：字际系联 ==================== */
  function renderLineage(ch, trad) {
    ch = ch || S.chars[0];
    const box = $("lineageBody");
    if (!box) return;
    // 溯源优先：系联以繁体正体为枢纽展开，正体无关联时再回退到今字
    const root = trad || (window.SIMPTRAD || {})[ch] || ch;
    let rels = localRelations(root);
    let hub = root;
    if ((!rels || !rels.length) && root !== ch) { rels = localRelations(ch); hub = ch; }
    const n = (rels || []).length;
    box.innerHTML = `
      <div class="sect" id="sec-lineage">
        <div class="sect-hd">
          <h3>字际系联 <span class="sh-note">Relation Network</span></h3>
          <div class="sh-right"><span class="src-tag local">本地固定 · 不消耗 Token</span></div>
        </div>
        <div class="sect-bd">
          <p class="gt-note" style="margin:0 0 12px">系联枢纽：<b class="font-serif-cn">${esc(hub)}</b>${
            hub !== ch ? `（「${esc(ch)}」的正体）` : ""
          } · 共 ${n} 组关系。同源、构件孳乳与形声孳乳均按正体字族推导。</p>
          <div id="lineageGraph"></div>
          <div class="sec-title mt-16">随堂巩固 <span class="st-note">Practice</span></div>
          <div class="quick-grid">
            <div class="quick-card" data-go="game" data-gt="glyph">
              <div class="qc-ico">甲</div>
              <div class="qc-t">古字猜谜</div>
              <div class="qc-d">看甲金篆字形猜今字，7161 字题库</div>
            </div>
            <div class="quick-card" data-go="game" data-gt="build">
              <div class="qc-ico">拼</div>
              <div class="qc-t">部件拼字</div>
              <div class="qc-d">用构件拼出目标字，8619 字题库</div>
            </div>
            <div class="quick-card" data-go="game" data-gt="series">
              <div class="qc-ico">族</div>
              <div class="qc-t">声符字族</div>
              <div class="qc-d">同声符字族归类，636 族</div>
            </div>
          </div>
        </div>
      </div>`;
    renderGraph(rels, hub, "lineageGraph");
    qsa(".quick-card[data-go='game']", box).forEach(el => {
      el.onclick = () => { GAME.tab = el.dataset.gt || GAME.tab; GAME.state = {}; go("game"); };
    });
  }

  /* ==================== 本地兜底数据构造 ==================== */
  function localEtymology(c) {
    // 繁体优先：若该字有繁体正体，先追溯繁体，用正体查《说文》/结构/字形
    const trad = (window.SIMPTRAD || {})[c] || null;
    const root = trad || c;
    const SW = window.SHUOWEN || {}, CU = window.CULTURAL || {}, CL = window.CHARLIB || {};
    const d = ETYMO_DICT[root] || ETYMO_DICT[c];
    if (d) {
      return {
        char: c, root, traditional: trad,
        pinyin: d.py, radical: (d.comp[0] || ["—"])[0],
        strokes: 0, hsk: 1, liushu: d.liu,
        original_meaning: d.ben, extended_meanings: [],
        components: d.comp.map(([part, gloss]) => ({ part, role: "构件", gloss })),
        ids: IDS_MAP[root] || IDS_MAP[c] || null,
        citation: "据《说文解字》及甲金文字形推定。",
        shuowen: SW[root] || SW[c] || null,
        cultural: CU[root] || CU[c] || null
      };
    }
    const lib = CL[root] || CL[c];
    if (lib) {
      return {
        char: c, root, traditional: trad,
        pinyin: lib.py || "—", radical: lib.rad || "—", strokes: 0, hsk: 1,
        liushu: lib.liu || "待考", struct: lib.st || "",
        original_meaning: lib.gl ? ("（英文释义）" + lib.gl) : "本地字库暂未收录权威本义考据，以下为结构拆解。",
        extended_meanings: [],
        components: (lib.comp || []).map(([part, role]) => ({
          part, role, gloss: role === "声符" ? "表音构件" : (role === "义符" ? "表义构件" : "基础构件")
        })),
        ids: lib.ids ? { seq: lib.ids, note: "结构：" + (lib.st || "—") } : null,
        citation: lib.gl ? "据 makemeahanzi 开源字库结构拆解与形声/会意判定推导，非《说文》权威考据。" : "—",
        isLib: true,
        shuowen: SW[root] || SW[c] || null,
        cultural: CU[root] || CU[c] || null
      };
    }
    return {
      char: c, root, traditional: trad,
      pinyin: "—", radical: "—", strokes: 0, hsk: 1, liushu: "待考", struct: "",
      original_meaning: "本地字库暂未收录该字（可能为生僻字或扩展区字符）。",
      extended_meanings: [], components: [], ids: null, citation: "—",
      shuowen: SW[root] || SW[c] || null,
      cultural: CU[root] || CU[c] || null
    };
  }

  function localRelations(c) {
    if (c === "我") {
      return DEMO_CORPUS["我"].relations.map((r) => ({
        ...r,
        expansion_order: ["或", "義", "鹅"].includes(r.target) ? 1 : 2,
        shared_feature: r.explanation.slice(0, 18)
      }));
    }
    const d = ETYMO_DICT[c];
    if (!d) {
      const lib = (window.CHARLIB || {})[c];
      if (lib) {
        const rels = (lib.comp || []).map(([part, role]) => ({
          target: part,
          type: role === "声符" ? "phonetic_derivation" : "component_derivation",
          relation_label: role === "声符" ? "形声孳乳" : (role === "义符" ? "构件表义" : "构件孳乳"),
          expansion_order: 1,
          explanation: `「${c}」由构件「${part}」参与构形（${role}）。`,
          evidence: "据构件拆解推导", shared_feature: part
        }));
        const pho = lib.pho;
        if (pho && PHON_FAM[pho]) {
          PHON_FAM[pho].filter(x => x !== c).slice(0, 10).forEach(t => {
            rels.push({
              target: t, type: "phonetic_series", relation_label: "同声符字族",
              expansion_order: 2,
              explanation: `「${t}」与「${c}」共享声符「${pho}」，同属形声字族。`,
              evidence: "据开源字库声符索引推导", shared_feature: pho
            });
          });
        }
        // 同部首：同属某部
        const rad = lib.rad;
        if (rad && RAD_INDEX[rad]) {
          RAD_INDEX[rad].filter(x => x !== c).slice(0, 10).forEach(t => {
            rels.push({
              target: t, type: "same_radical", relation_label: "同部首",
              expansion_order: 3,
              explanation: `「${t}」与「${c}」同属「${rad}」部。`,
              evidence: "据部首索引推导", shared_feature: rad
            });
          });
        }
        // 同构件：当前字作为构件参与他字构形（COMP_INDEX 反查）
        const compIdx = window.COMP_INDEX || {};
        if (compIdx[c]) {
          compIdx[c].filter(x => x !== c).slice(0, 10).forEach(t => {
            rels.push({
              target: t, type: "contains_component", relation_label: "构件包含",
              expansion_order: 3,
              explanation: `「${t}」以「${c}」为构件。`,
              evidence: "据同构件索引推导", shared_feature: c
            });
          });
        }
        return rels;
      }
      return [];
    }
    return d.comp.map(([part, gloss]) => ({
      target: part, type: "component_derivation", relation_label: "构件孳乳",
      expansion_order: 1,
      explanation: `「${c}」由构件「${part}」参与构形：${gloss}`,
      evidence: "据本地构件索引推断", shared_feature: part
    }));
  }

  function localStory(c) {
    const d = DEMO_CORPUS[c];
    if (d && d.story) return d.story;
    const e = ETYMO_DICT[c];
    return {
      title: `${c} 的故事`,
      body: e ? [
        `很久以前，人们看到${e.ben.replace(/[；;].*$/, "")}的样子，就把这个样子画了下来。`,
        `慢慢地，这幅画变成了今天的「${c}」字。`,
        `每当写下「${c}」，我们其实都在画很久以前的那幅图画。`
      ] : ["本地语料库暂未收录该字的故事，配置模型接口后可获取 AI 创编的完整文化故事。"]
    };
  }

  function normalizeRelations(data) {
    if (!data) return null;
    const list = Array.isArray(data) ? data : data.relations;
    if (!Array.isArray(list) || !list.length) return null;
    return list.map(r => ({
      target: r.target,
      type: r.type || "component_derivation",
      relation_label: r.relation_label || REL_LABEL[r.type]?.full || "字际关联",
      expansion_order: r.expansion_order || 1,
      explanation: r.explanation || "—",
      evidence: r.evidence || "—",
      shared_feature: r.shared_feature || ""
    }));
  }

  /* ==================== 渲染：系联图谱 ==================== */
  function renderGraph(rels, core, hostId) {
    const host = $(hostId || "lineageGraph");
    if (!rels || !rels.length) {
      host.innerHTML = `<div class="empty"><div class="empty-glyphs">联</div>
        <p>本地语料库暂未收录「${esc(core)}」的系联关系。<br>配置模型接口后，系统将自动推导其同源字族与构件孳乳网络。</p></div>`;
      return;
    }
    const W = 760, H = 400, CX = W / 2, CY = H / 2;
    const R1 = 118, R2 = 190;

    const order1 = rels.filter(r => (r.expansion_order || 1) === 1);
    const order2 = rels.filter(r => (r.expansion_order || 1) >= 2);

    const pos = new Map();
    const place = (list, r, offset) => {
      list.forEach((n, i) => {
        const a = (i / Math.max(list.length, 1)) * Math.PI * 2 - Math.PI / 2 + offset;
        pos.set(n.target, { x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r, node: n });
      });
    };
    place(order1, R1, 0);
    place(order2, R2, Math.PI / Math.max(order2.length + 1, 2) * .5);

    const colorOf = (t) => ({
      chronological_cognate: "var(--graph-node-cognate)",
      component_derivation:  "var(--graph-node-component)",
      phonetic_derivation:   "var(--graph-node-phonetic)",
      semantic_extension:    "var(--green-sage)",
      loan_graph:            "var(--cinnabar)"
    }[t] || "var(--graph-link-default)");

    let links = "", nodes = "";
    pos.forEach((p, k) => {
      const col = colorOf(p.node.type);
      links += `<line x1="${CX}" y1="${CY}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}"
                  stroke="${col}" stroke-width="1.6" opacity=".55" />`;
      nodes += `
        <g class="graph-node" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">
          <circle r="27" fill="#fff" stroke="${col}" stroke-width="2" />
          <text text-anchor="middle" dy="9" font-size="24" fill="var(--ink-black)">${esc(k)}</text>
          <text text-anchor="middle" dy="42" font-size="10.5" fill="var(--ink-3)" font-family="var(--sans)">${esc(p.node.relation_label || "")}</text>
        </g>`;
    });

    nodes += `
      <g class="graph-node" transform="translate(${CX},${CY})">
        <circle r="36" fill="var(--graph-node-core)" />
        <circle r="36" fill="none" stroke="var(--cinnabar)" stroke-width="1" opacity=".35">
          <animate attributeName="r" values="36;44;36" dur="3.2s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values=".35;0;.35" dur="3.2s" repeatCount="indefinite"/>
        </circle>
        <text text-anchor="middle" dy="12" font-size="34" fill="#fff">${esc(core)}</text>
        <text text-anchor="middle" dy="56" font-size="10.5" fill="var(--ink-3)" font-family="var(--sans)">核心字</text>
      </g>`;

    const listHTML = rels.map(r => {
      const L = REL_LABEL[r.type] || { full: r.relation_label || "关联", abbr: "REL", cls: "t-core" };
      return `
      <div class="rel-item" style="border-left-color:${colorOf(r.type)}">
        <div class="rel-tchar font-serif-cn">${esc(r.target)}</div>
        <div class="rel-body">
          <span class="tag-dual ${L.cls}">${esc(L.full)}<span class="td-abbr">${esc(L.abbr)}</span></span>
          <span class="tag-dual" style="background:var(--bg-warm);color:var(--ink-3);border-color:var(--border-light)">${r.expansion_order >= 2 ? "二级孳乳" : "直接孳乳"}<span class="td-abbr">L${r.expansion_order || 1}</span></span>
          <p class="mt-8">${esc(r.explanation)}</p>
          ${r.shared_feature ? `<p class="rel-evid">共享：${esc(r.shared_feature)}</p>` : ""}
          <p class="rel-evid">${esc(r.evidence)}</p>
        </div>
      </div>`;
    }).join("");

    host.innerHTML = `
      <div class="sec-title">字际系联网络 <span class="st-note">Cross-character Relation Network · ${rels.length} 个关联字</span></div>
      <div class="graph-wrap">
        <div class="graph-legend">
          <span class="lg-item"><span class="lg-line" style="border-top:2px solid var(--graph-node-cognate)"></span>历时同源</span>
          <span class="lg-item"><span class="lg-line" style="border-top:2px solid var(--graph-node-component)"></span>构件孳乳</span>
          <span class="lg-item"><span class="lg-line" style="border-top:2px solid var(--graph-node-phonetic)"></span>形声孳乳</span>
          <span class="lg-item"><span class="lg-line" style="border-top:2px solid var(--green-sage)"></span>意义引申</span>
          <span class="lg-item"><span class="lg-line" style="border-top:2px solid var(--cinnabar)"></span>通假假借</span>
        </div>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
          <g>${links}</g>
          <g>${nodes}</g>
        </svg>
      </div>
      <div class="rel-list">${listHTML}</div>`;
  }

  /* ==================== 视图：Prompt 模板库 ==================== */
  function renderTpl() {
    const items = [
      { k: "etymology",  n: "字源解析",   sig: "(char)",                          d: "梳理本义、六书、构件与字书佐证" },
      { k: "relation",   n: "字际系联",   sig: "(char, etyBrief)",                d: "推导历时同源与构件孳乳字族" },
      { k: "story",      n: "分级故事",   sig: "(chars, hsk, lang, relBrief)",    d: "按 HSK 大纲生成双语文化故事" },
      { k: "script",     n: "动画分镜",   sig: "(chars, hsk, lang, relBrief)",    d: "输出可落地的剪辑脚本" },
      { k: "role",       n: "角色设定",   sig: "(chars, region, historicalBg)",   d: "角色形象 + 跨文化适配与红线审查" },
      { k: "quiz",       n: "分级习题",   sig: "(chars, hsk, storyBrief)",        d: "配套课后习题" },
      { k: "courseware", n: "教学课件",   sig: "(chars, hsk, storyBrief)",        d: "成套教学课件幻灯片" },
      { k: "audio",      n: "发音资源",   sig: "(chars, targetLang)",             d: "多语种发音教学提示" }
    ];

    $("tplBody").innerHTML = `
      <div class="sect">
        <div class="sect-hd">
          <h3>标准化模板 <span class="sh-note">8 类 · 120+ 多语种变体</span></h3>
          <div class="sh-right"><span class="src-tag local">本地固定 · 不消耗 Token</span></div>
        </div>
        <div class="sect-bd">
          <div class="tbl-wrap" style="max-height:none">
            <table class="tbl">
              <thead><tr><th>模板</th><th>签名</th><th>用途</th><th style="width:92px">操作</th></tr></thead>
              <tbody>
                ${items.map(it => `<tr>
                  <td><b>${esc(it.n)}</b><br><span class="mono text-muted" style="font-size:10.5px">TPL-${esc(it.k.toUpperCase().slice(0, 3))}</span></td>
                  <td class="mono" style="font-size:11px">${esc(it.sig)}</td>
                  <td>${esc(it.d)}</td>
                  <td><button class="btn btn-sm" data-tpl="${it.k}">查看</button></td>
                </tr>`).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="sect" id="tplDetail" style="display:none">
        <div class="sect-hd"><h3 id="tplDetailName"></h3>
          <div class="sh-right"><button class="btn btn-sm" id="tplCopy">复制提示词</button></div>
        </div>
        <div class="sect-bd"><div class="prompt-box" id="tplDetailBox"></div></div>
      </div>`;

    qsa("#tplBody [data-tpl]").forEach(btn => {
      btn.onclick = () => {
        const k = btn.dataset.tpl;
        const it = items.find(x => x.k === k);
        let tpl;
        try {
          tpl = k === "etymology" ? PROMPTS.etymology(S.chars[0])
              : k === "relation"  ? PROMPTS.relation(S.chars[0], "本义摘要")
              : k === "story"     ? PROMPTS.story(S.chars, S.hsk, S.lang, "系联摘要")
              : k === "script"    ? PROMPTS.script(S.chars, S.hsk, S.lang, "系联摘要")
              : k === "role"      ? PROMPTS.role(S.chars, S.region, "商代晚期")
              : k === "quiz"      ? PROMPTS.quiz(S.chars, S.hsk, "故事摘要")
              : k === "courseware"? PROMPTS.courseware(S.chars, S.hsk, "故事摘要")
              : PROMPTS.audio(S.chars, S.lang);
        } catch (e) { tpl = null; }

        const text = tpl && tpl.messages
          ? tpl.messages.map(m => `【${m.role}】\n${m.content}`).join("\n\n")
          : "（该模板需要更多上下文参数）";

        $("tplDetail").style.display = "";
        $("tplDetailName").textContent = it.n + " · " + it.sig;
        $("tplDetailBox").textContent = text;
        $("tplCopy").onclick = () => { copyText(text); };
        $("tplDetail").scrollIntoView({ behavior: "smooth", block: "nearest" });
      };
    });
  }

  /* ==================== 视图：性能评测 ==================== */
  function renderPerf() {
    const m = API.METRICS;
    const live = m.calls > 0;
    const avgTTFT = live ? (m.sumTTFT / m.calls) : null;

    $("perfBody").innerHTML = `
      <div class="sect">
        <div class="sect-hd"><h3>本次会话实测 <span class="sh-note">Live Session</span></h3></div>
        <div class="sect-bd">
          <div class="stat-grid" style="margin-bottom:0">
            <div class="stat-card"><div class="stat-lbl">API 调用次数</div>
              <div class="stat-val">${m.calls}</div><div class="stat-sub">本次会话累计</div></div>
            <div class="stat-card sc-blue"><div class="stat-lbl">平均首字延迟</div>
              <div class="stat-val">${live ? (avgTTFT / 1000).toFixed(2) : "—"}<small>${live ? "s" : ""}</small></div>
              <div class="stat-sub">SLA ≤ 2 s</div></div>
            <div class="stat-card sc-green"><div class="stat-lbl">峰值首字延迟</div>
              <div class="stat-val">${live ? (m.maxTTFT / 1000).toFixed(2) : "—"}<small>${live ? "s" : ""}</small></div>
              <div class="stat-sub">SLA ≤ 2 s</div></div>
            <div class="stat-card sc-gold"><div class="stat-lbl">Token 消耗</div>
              <div class="stat-val">${m.tokens || "—"}</div><div class="stat-sub">据服务端 usage 回传</div></div>
          </div>
          ${live ? `<div class="tbl-wrap mt-12" style="max-height:none"><table class="tbl">
            <thead><tr><th>步骤</th><th>首字延迟</th><th>总耗时</th><th>Tokens</th><th>JSON 解析</th></tr></thead>
            <tbody>${m.rows.map(r => `<tr>
              <td>${esc(r.label)}</td>
              <td class="mono">${(r.ttft / 1000).toFixed(2)} s</td>
              <td class="mono">${(r.total / 1000).toFixed(2)} s</td>
              <td class="mono">${r.tokens || "—"}</td>
              <td>${r.parsed ? `<span style="color:var(--green-sage)">成功</span>` : `<span style="color:var(--cinnabar)">降级</span>`}</td>
            </tr>`).join("")}</tbody></table></div>`
          : `<p class="text-sm text-muted mt-12">尚未调用模型接口。在「多场景创编」中配置密钥并生成后，此处将显示实测数据。</p>`}
        </div>
      </div>

      <div class="sect">
        <div class="sect-hd"><h3>基准指标 <span class="sh-note">Benchmark</span></h3>
          <div class="sh-right"><span class="src-tag local">本地固定 · 不消耗 Token</span></div></div>
        <div class="sect-bd">
          <div class="tbl-wrap" style="max-height:none">
            <table class="tbl">
              <thead><tr><th>指标</th><th>基线</th><th>峰值</th><th>SLA</th><th>结论</th></tr></thead>
              <tbody>${PERF_BENCHMARK.rows.map(r => `<tr>
                <td>${esc(r.metric)}</td>
                <td class="mono">${esc(r.baseline)}</td>
                <td class="mono">${esc(r.peak)}</td>
                <td class="mono">${esc(r.sla)}</td>
                <td><span class="src-tag local">${esc(r.status)}</span></td>
              </tr>`).join("")}</tbody>
            </table>
          </div>
          <div class="card acc-gold mt-12"><p class="font-serif-cn">${esc(PERF_BENCHMARK.story_fit.desc)}</p></div>
        </div>
      </div>`;
  }

  /* ==================== 视图：设置 — 资源来源 ==================== */
  function renderAssets() {
    const st = window.GLYPH_STATS || {};
    const names = { ob: "甲骨文（补录）", oracle: "甲骨文", bronze: "金文", seal: "小篆", clerical: "隶书" };
    $("assetBody").innerHTML = `
      <div class="tbl-wrap" style="max-height:none">
        <table class="tbl">
          <thead><tr><th>时期</th><th>字形数</th><th>来源</th><th>许可</th></tr></thead>
          <tbody>
            ${Object.keys(names).map(k => `<tr>
              <td>${esc(names[k])}</td>
              <td class="mono">${st[k] || 0}</td>
              <td>${k === "ob" ? "oracle-bone-jgw-1203（GitHub）" : "etymology-svg（GitHub）"}</td>
              <td>${k === "ob"
                ? `<span class="src-tag local">CC-BY 4.0 · 可商用</span>`
                : `<span class="src-tag ai">未声明许可</span>`}</td>
            </tr>`).join("")}
            <tr><td>楷书</td><td class="mono">—</td><td>系统字体渲染</td><td><span class="src-tag local">—</span></td></tr>
          </tbody>
        </table>
      </div>
      <div class="alert alert-warn mt-12" style="display:block">
        <b>许可提示：</b><code class="mono">etymology-svg</code> 仓库未附带 LICENSE 文件，法律上视为「保留所有权利」。
        当前仅用于原型演示。正式商用前请替换为已授权字形库（如 CC-BY 4.0 的
        <code class="mono">oracle-bone-jgw-1203</code>），或自行采购字库授权。
        字形加载逻辑集中在 <code class="mono">app.js · loadGlyph()</code>，替换数据源只需改动该函数与
        <code class="mono">assets/glyphs/</code> 目录。
      </div>`;
  }

  /* ==================== 生成主流程 ==================== */
  async function generate() {
    if (S.busy) return;
    if (!S.chars.length) { toast("请先输入目标汉字", "err"); return; }

    S.busy = true;
    setBusyUI(true);
    S.controller = new AbortController();
    API.resetMetrics();

    const chars = S.chars.slice();
    const useAI = API.hasKey();
    const promptLog = [];   // 记录每一步的完整提示词

    try {
      let ety, rels;

      if (useAI) {
        const t1 = PROMPTS.etymology(chars[0]);
        promptLog.push({ label: "TPL-01 字源解析", messages: t1.messages });
        const r1 = await runStep("TPL-01 字源解析", () => callAI(t1, null));
        ety = r1.data || localEtymology(chars[0]);
        API.pushMetric("字源解析", r1.raw, !!r1.data);
        promptLog[promptLog.length - 1].latency = r1.raw;

        const brief = `「${ety.char}」本义：${ety.original_meaning}；构件：${(ety.components || []).map(c => c.part).join("/")}`;
        const t2 = PROMPTS.relation(chars[0], brief);
        promptLog.push({ label: "TPL-02 字际系联", messages: t2.messages });
        const r2 = await runStep("TPL-02 字际系联", () => callAI(t2, null));
        rels = normalizeRelations(r2.data) || localRelations(chars[0]);
        API.pushMetric("字际系联", r2.raw, !!r2.data);
        promptLog[promptLog.length - 1].latency = r2.raw;
      } else {
        ety  = localEtymology(chars[0]);
        rels = localRelations(chars[0]);
      }

      const relBrief = rels.slice(0, 4)
        .map(r => `${chars[0]}→${r.target}（${r.relation_label || REL_LABEL[r.type]?.full || "关联"}）`)
        .join("；") || `${chars[0]} 及其孳乳字族`;

      S.result = { char: chars[0], chars, hsk: S.hsk, lang: S.lang, region: S.region, mode: S.mode, etymology: ety, relations: rels, demo: !useAI };

      if (S.mode === "story") {
        await branchStory(chars, relBrief, useAI, promptLog);
        activateTab("story");
      } else {
        await branchScript(chars, relBrief, useAI, promptLog);
        activateTab("script");
      }

      if (S.modules.has("quiz") || S.modules.has("courseware")) {
        await branchTeach(chars, useAI, promptLog);
      }

      $("btnExport").disabled = false;
      $("rhTitle").textContent = `${chars.join("、")} · ${useAI ? "智能创编结果" : "内置演示样例"}`;
      const tag = $("rhSrcTag");
      tag.textContent = useAI ? "AI 实时生成" : "内置演示数据";
      tag.className = "src-tag " + (useAI ? "ai" : "local");

      if (useAI) {
        histAdd({
          id: "r" + Date.now(),
          ts: Date.now(),
          mode: S.mode,
          chars: chars.slice(),
          hsk: S.hsk,
          lang: S.lang,
          region: S.region,
          modules: Array.from(S.modules),
          model: API.CFG.model || "—",
          prompts: promptLog,
          result: S.result,
          metrics: {
            calls: API.METRICS.calls,
            avgTTFT: API.METRICS.calls ? API.METRICS.sumTTFT / API.METRICS.calls : 0,
            maxTTFT: API.METRICS.maxTTFT,
            total: API.METRICS.sumTotal,
            tokens: API.METRICS.tokens
          }
        });
        toast("创编完成，已存入生成历史", "ok");
      } else {
        toast("已载入内置演示数据（配置密钥可调用真实模型）", "");
      }

    } catch (err) {
      console.error(err);
      toast("生成中断：" + (err.message || err), "err");
    } finally {
      S.busy = false;
      setBusyUI(false);
      S.controller = null;
    }
  }

  async function runStep(label, fn) {
    try { return await fn(); }
    catch (e) {
      if (e.message === "NO_KEY") throw e;
      toast(`${label} 调用失败，已局部降级`, "err");
      return { data: null, raw: { ttft: 0, total: 0, usage: null } };
    }
  }

  async function callAI(tpl, onDelta) {
    const r = await API.chatStream(tpl.messages, { onDelta, signal: S.controller?.signal });
    return { data: API.extractJSON(r.text), raw: r };
  }

  async function branchStory(chars, relBrief, useAI, log) {
    let story, biling;
    if (useAI) {
      const t = PROMPTS.story(chars, S.hsk, S.lang, relBrief);
      log.push({ label: "TPL-03 分级故事", messages: t.messages });
      const r = await runStep("TPL-03 分级故事", () => callAI(t, null));
      story = r.data || localStory(chars[0]);
      API.pushMetric("文化故事创编", r.raw, !!r.data);
      log[log.length - 1].latency = r.raw;
      biling = story.bilingual || null;
    } else {
      story  = localStory(chars[0]);
      biling = DEMO_CORPUS["我"].bilingual;
    }
    S.result.story = story; S.result.bilingual = biling;
    renderStory(story, biling);
  }

  async function branchScript(chars, relBrief, useAI, log) {
    let script, role;
    if (useAI) {
      const ts = PROMPTS.script(chars, S.hsk, S.lang, relBrief);
      log.push({ label: "TPL-04 动画分镜", messages: ts.messages });
      const rs = await runStep("TPL-04 动画分镜", () => callAI(ts, null));
      script = rs.data || DEMO_CORPUS["我"].script;
      API.pushMetric("动画脚本创编", rs.raw, !!rs.data);
      log[log.length - 1].latency = rs.raw;

      const tr = PROMPTS.role(chars, S.region, script.historical_background || relBrief);
      log.push({ label: "TPL-05 角色设定", messages: tr.messages });
      const rr = await runStep("TPL-05 角色设定", () => callAI(tr, null));
      role = rr.data || DEMO_CORPUS["我"].role.regions[S.region] || DEMO_CORPUS["我"].role.regions["东南亚"];
      API.pushMetric("角色与跨文化适配", rr.raw, !!rr.data);
      log[log.length - 1].latency = rr.raw;
    } else {
      script = DEMO_CORPUS["我"].script;
      role   = DEMO_CORPUS["我"].role.regions[S.region] || DEMO_CORPUS["我"].role.regions["东南亚"];
    }
    S.result.script = script; S.result.role = role;
    renderScript(script);
    renderRole(role);
  }

  async function branchTeach(chars, useAI, log) {
    const storyBrief = (S.result.story && S.result.story.title) || DEMO_CORPUS["我"].story.title;
    let quiz = null, courseware = null;
    if (useAI) {
      if (S.modules.has("quiz")) {
        const t = PROMPTS.quiz(chars, S.hsk, storyBrief);
        log.push({ label: "TPL-06 分级习题", messages: t.messages });
        const rq = await runStep("TPL-06 分级习题", () => callAI(t, null));
        quiz = rq.data && rq.data.quiz || null;
        API.pushMetric("课后习题生成", rq.raw, !!rq.data);
        log[log.length - 1].latency = rq.raw;
      }
      if (S.modules.has("courseware")) {
        const t = PROMPTS.courseware(chars, S.hsk, storyBrief);
        log.push({ label: "TPL-07 教学课件", messages: t.messages });
        const rc = await runStep("TPL-07 教学课件", () => callAI(t, null));
        courseware = rc.data && rc.data.slides || null;
        API.pushMetric("教学课件生成", rc.raw, !!rc.data);
        log[log.length - 1].latency = rc.raw;
      }
    } else {
      quiz = DEMO_CORPUS["我"].quiz;
      courseware = DEMO_CORPUS["我"].courseware;
    }
    S.result.quiz = quiz; S.result.courseware = courseware;
    renderTeach(quiz, courseware, !useAI);
  }

  /* ==================== 渲染：文化故事 ==================== */
  function renderStory(story, biling) {
    const body = (story.body || []).map(p => `<p>${esc(p)}</p>`).join("")
      || `<p class="text-muted">暂无故事内容</p>`;

    let biHTML = "";
    if (biling && biling.rows && biling.rows.length) {
      biHTML = `
        <div class="sec-title mt-16">双语叙事底层素材 <span class="st-note">${esc(biling.target_language)} · ${biling.rows.length} 句对照</span></div>
        <div style="border:1px solid var(--line);border-radius:var(--radius-sm);overflow:hidden">
          <div class="bi-head"><div>中文原文</div><div>${esc(biling.target_language)}</div></div>
          ${biling.rows.map(r => `
            <div class="bi-row">
              <div class="bi-zh font-serif-cn">${esc(r.zh)}</div>
              <div class="bi-tr">${esc(r.tr)}</div>
            </div>`).join("")}
        </div>`;
    }

    const notes = story.vocabulary_notes || [];
    const apps  = story.target_char_appearances || [];

    $("pane-story").innerHTML = `
      <div class="story-title font-serif-cn">${esc(story.title || "—")}</div>
      <div class="story-sub">HSK ${story.level || S.hsk} 级 · 约 ${story.word_count || "—"} 字${story.title_target ? ` · ${esc(story.title_target)}` : ""}</div>
      <div class="story-body font-serif-cn">${body}</div>

      ${apps.length ? `
      <div class="sec-title mt-16">目标汉字意象落点 <span class="st-note">Imagery Anchors</span></div>
      <div class="grid-3">
        ${apps.map(a => `<div class="card acc-cin">
          <h4 class="font-display-cn" style="font-size:22px;color:var(--cinnabar)">${esc(a.char)}</h4>
          <p>${esc(a.imagery)}</p>
        </div>`).join("")}
      </div>` : ""}

      ${biHTML}

      ${notes.length ? `
      <div class="sec-title mt-16">超纲词汇注释 <span class="st-note">${notes.length} 条</span></div>
      <div class="tbl-wrap" style="max-height:none"><table class="tbl">
        <thead><tr><th>词语</th><th>释义</th><th>等级</th></tr></thead>
        <tbody>${notes.map(n => `<tr><td class="font-serif-cn">${esc(n.word)}</td><td>${esc(n.meaning)}</td><td>${esc(n.level || "超纲")}</td></tr>`).join("")}</tbody>
      </table></div>` : ""}`;
  }

  /* ==================== 渲染：动画脚本 ==================== */
  function renderScript(sc) {
    if (!sc) { $("pane-script").innerHTML = emptyState("暂无脚本", "切换至「动画脚本创编」模式后生成。"); return; }

    const rows = (sc.shots || []).map(s => `
      <tr>
        <td class="shot-no">${s.no}</td>
        <td>${s.dur}s</td>
        <td>${esc(s.size)}</td>
        <td>${esc(s.cam)}</td>
        <td class="shot-vis">${esc(s.visual)}</td>
        <td class="shot-nar font-serif-cn">${esc(s.nar)}${s.nar_target ? `<br><span class="text-muted" style="font-size:11.5px">${esc(s.nar_target)}</span>` : ""}</td>
        <td>${esc(s.sfx || "")}</td>
        <td>${esc(s.trans || "")}</td>
        <td class="text-muted">${esc(s.source_material_ref || "")}</td>
      </tr>`).join("");

    $("pane-script").innerHTML = `
      <div class="story-title font-serif-cn">${esc(sc.title || "—")}</div>
      <div class="story-sub">${esc(sc.total_duration || "")} · ${esc(sc.film_ratio || "")} · ${esc(sc.art_style || "")}</div>

      <div class="grid-3 mb-12">
        ${(sc.palette || []).map(c => `
          <div class="stat-cell" style="display:flex;align-items:center;gap:9px">
            <span style="width:22px;height:22px;border-radius:5px;background:${esc(c.split(" ")[0])};border:1px solid var(--border-light);flex:none"></span>
            <span class="font-mono" style="font-size:12px">${esc(c)}</span>
          </div>`).join("")}
      </div>

      <div class="sec-title">历史背景考据 <span class="st-note">Historical Grounding</span></div>
      <div class="card acc-gold mb-12"><p class="font-serif-cn">${esc(sc.historical_background || "—")}</p></div>

      <div class="sec-title">分镜剪辑脚本 <span class="st-note">${(sc.shots || []).length} 个镜头 · 可直接对接剪辑工位</span></div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>镜号</th><th>时长</th><th>景别</th><th>运镜</th><th>画面内容</th><th>旁白 / 对白</th><th>音效</th><th>转场</th><th>字形依据</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  /* ==================== 渲染：角色设定 ==================== */
  function renderRole(roleData) {
    if (!roleData) { $("pane-role").innerHTML = emptyState("暂无角色设定", "切换至「动画脚本创编」模式后生成。"); return; }

    const chars = roleData.characters || [];
    const review = roleData.cultural_review || {};

    $("pane-role").innerHTML = `
      <div class="story-title font-serif-cn">${esc(roleData.region || S.region)} · 角色形象方案</div>
      <div class="story-sub">${esc(roleData.design_brief || "")}</div>

      <div class="grid-2">
        ${chars.map(c => `
          <div class="card acc-cin">
            <div style="display:flex;align-items:baseline;gap:8px">
              <h4 class="font-serif-cn" style="font-size:17px">${esc(c.name)}</h4>
              <span class="mono text-muted" style="font-size:11px">${esc(c.name_latin || "")}</span>
            </div>
            <p class="text-sm text-muted" style="margin-top:2px">${esc(c.role || "")}</p>
            <p class="mt-8">${esc(c.appearance || "")}</p>
            ${c.costume ? `<p class="rel-evid">服饰：${esc(c.costume)}</p>` : ""}
            ${c.rationale ? `<p class="rel-evid">依据：${esc(c.rationale)}</p>` : ""}
            ${c.image_prompt ? `
              <div class="sec-title mt-12" style="margin-bottom:6px">AI 绘图提示词 <span class="st-note">Image Prompt</span></div>
              <div class="prompt-box light">${esc(c.image_prompt)}</div>
              <button class="btn btn-sm mt-8 copy-btn" data-copy="${esc(c.image_prompt)}">复制提示词</button>` : ""}
          </div>`).join("")}
      </div>

      ${Object.keys(review).length ? `
      <div class="sec-title mt-16">跨文化适宜性审查 <span class="st-note">Cross-cultural Review</span></div>
      <div class="tbl-wrap" style="max-height:none"><table class="tbl">
        <thead><tr><th>审查维度</th><th>结论</th></tr></thead>
        <tbody>${Object.entries(review).map(([k, v]) => `<tr>
          <td>${esc(k)}</td><td>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</td>
        </tr>`).join("")}</tbody></table></div>` : ""}`;

    qsa("#pane-role .copy-btn").forEach(b => {
      b.onclick = () => copyText(b.dataset.copy);
    });
  }

  /* ==================== 渲染：习题 / 课件 ==================== */
  function renderTeach(quiz, courseware, isDemo) {
    let h = isDemo ? `<div class="mb-12"><span class="demo-tag">内置演示语料</span></div>` : "";

    if (quiz && quiz.length) {
      h += `
        <div class="sec-title">课后习题 <span class="st-note">${quiz.length} 题</span></div>
        <div class="tbl-wrap" style="max-height:none"><table class="tbl">
          <thead><tr><th style="width:38px">#</th><th>题型</th><th>题目</th><th>参考答案</th></tr></thead>
          <tbody>${quiz.map((q, i) => `<tr>
            <td class="mono">${i + 1}</td>
            <td>${esc(q.type || "—")}</td>
            <td>${esc(q.question || "")}${q.options ? `<br><span class="text-muted" style="font-size:11.5px">${esc((q.options || []).join(" / "))}</span>` : ""}</td>
            <td>${esc(q.answer || "")}</td>
          </tr>`).join("")}</tbody></table></div>`;
    }

    if (courseware && courseware.length) {
      h += `
        <div class="sec-title mt-16">教学课件 <span class="st-note">${courseware.length} 页</span></div>
        <div class="grid-2">
          ${courseware.map(s => `
            <div class="card acc-ind">
              <h4>P${s.no || "—"} · ${esc(s.title || "")}</h4>
              <p>${esc(s.content || "")}</p>
              ${s.teacher_note ? `<p class="rel-evid">教学提示：${esc(s.teacher_note)}</p>` : ""}
            </div>`).join("")}
        </div>`;
    }

    if (!quiz && !courseware) h += emptyState("暂无教学配套", "生成后在此查看习题与课件。");
    $("pane-teach").innerHTML = h;
  }

  /* ==================== 内置演示 ==================== */
  function loadDemo() {
    S.chars = ["我"];
    $("charInput").value = "我";
    $("charCount").textContent = "1/4";
    const dc = $("dashChar"); if (dc) dc.textContent = "我";
    S.result = {
      char: "我", chars: ["我"], hsk: 3, lang: "English", mode: S.mode,
      etymology: DEMO_CORPUS["我"].etymology,
      relations: localRelations("我"),
      story: DEMO_CORPUS["我"].story,
      bilingual: DEMO_CORPUS["我"].bilingual,
      script: DEMO_CORPUS["我"].script,
      role: DEMO_CORPUS["我"].role.regions["东南亚"],
      quiz: DEMO_CORPUS["我"].quiz,
      courseware: DEMO_CORPUS["我"].courseware,
      demo: true
    };
    renderStory(S.result.story, S.result.bilingual);
    renderScript(S.result.script);
    renderRole(S.result.role);
    renderTeach(S.result.quiz, S.result.courseware, true);
    $("btnExport").disabled = false;
    $("rhTitle").textContent = "我 · 内置演示样例";
    const tag = $("rhSrcTag");
    tag.textContent = "内置演示数据";
    tag.className = "src-tag local";
    if (S.route === "etym" || S.route === "lineage") renderEtym();
    toast("已载入「我」字族内置演示样例", "ok");
  }

  /* ==================== 历史：列表 / 详情 ==================== */
  function histItemHTML(h) {
    const modeName = h.mode === "story" ? "文化故事" : "动画脚本";
    const prev = (h.result && h.result.story && h.result.story.title)
      || (h.result && h.result.script && h.result.script.title) || "—";
    return `
      <div class="hist-item" data-hid="${esc(h.id)}">
        <div class="hi-top">
          <span class="hi-chars">${esc((h.chars || []).join(""))}</span>
          <span class="src-tag ai">${esc(modeName)}</span>
          <span class="hi-time">${esc(fmtAgo(h.ts))}</span>
        </div>
        <div class="hi-meta">
          <span class="hi-chip">HSK ${esc(h.hsk)}</span>
          <span class="hi-chip">${esc(h.lang)}</span>
          ${h.mode === "script" ? `<span class="hi-chip">${esc(h.region || "")}</span>` : ""}
          <span class="hi-chip">${esc(h.model || "")}</span>
        </div>
        <div class="hi-prev">${esc(prev)}</div>
        <div class="hi-foot">
          <span>${esc(h.prompts ? h.prompts.length : 0)} 步提示词</span>
          <span>${esc(h.metrics && h.metrics.calls ? (h.metrics.avgTTFT / 1000).toFixed(2) + " s 均延迟" : "—")}</span>
          <span>${esc(h.metrics && h.metrics.tokens ? h.metrics.tokens + " tokens" : "")}</span>
        </div>
      </div>`;
  }

  function bindHistItems(root) {
    qsa(".hist-item", root).forEach(el => {
      el.onclick = () => showHistDetail(el.dataset.hid);
    });
  }

  function renderHistoryView() {
    const list = histLoad();
    const host = $("histList");
    if (!host) return;
    refreshHistBadge();
    if (!list.length) {
      host.innerHTML = `<div class="empty"><div class="empty-glyphs">⟲</div>
        <p>暂无记录。仅当配置模型接口并成功调用后，才会写入历史。</p></div>`;
      return;
    }
    host.innerHTML = `<div id="histListWrap">${list.map(histItemHTML).join("")}</div>`;
    bindHistItems(host);
    if (S.histSel) showHistDetail(S.histSel);
  }

  function renderHistDrawer() {
    const list = histLoad();
    const host = $("histDrawerBody");
    refreshHistBadge();
    host.innerHTML = list.length
      ? list.map(histItemHTML).join("")
      : `<div class="empty"><div class="empty-glyphs">⟲</div><p>暂无生成记录</p></div>`;
    bindHistItems(host);
  }

  function showHistDetail(id) {
    S.histSel = id;
    const h = histLoad().find(x => x.id === id);
    if (!h) return;
    qsa(".hist-item").forEach(el => el.classList.toggle("sel", el.dataset.hid === id));

    const steps = (h.prompts || []).map((p, i) => `
      <div class="sect" style="margin-bottom:9px">
        <div class="sect-hd">
          <h3 style="font-size:12.5px">${esc(p.label)}</h3>
          <div class="sh-right">
            ${p.latency ? `<span class="sh-note">TTFT ${(p.latency.ttft / 1000).toFixed(2)}s · 总计 ${(p.latency.total / 1000).toFixed(2)}s</span>` : ""}
            <button class="btn btn-sm" data-copy-p="${i}">复制</button>
          </div>
        </div>
        <div class="sect-bd"><div class="prompt-box" id="pb-${i}">${esc((p.messages || []).map(m => `【${m.role}】\n${m.content}`).join("\n\n"))}</div></div>
      </div>`).join("");

    const detail = `
      <div class="sect">
        <div class="sect-hd"><h3>运行概览</h3>
          <div class="sh-right">
            <button class="btn btn-sm" id="hdReplay">回填到结果区</button>
            <button class="btn btn-sm" id="hdCopyAll">复制全部提示词</button>
          </div>
        </div>
        <div class="sect-bd">
          <div class="hist-detail">
            <div class="hd-row"><span class="hk">时间</span><span class="hv mono">${esc(fmtTime(h.ts))}</span></div>
            <div class="hd-row"><span class="hk">目标字</span><span class="hv font-serif-cn" style="font-size:16px">${esc((h.chars || []).join(""))}</span></div>
            <div class="hd-row"><span class="hk">模式</span><span class="hv">${h.mode === "story" ? "文化故事创编" : "动画脚本创编"}</span></div>
            <div class="hd-row"><span class="hk">参数</span><span class="hv">HSK ${esc(h.hsk)} · ${esc(h.lang)}${h.mode === "script" ? ` · ${esc(h.region || "")}` : ""}</span></div>
            <div class="hd-row"><span class="hk">模型</span><span class="hv mono">${esc(h.model || "—")}</span></div>
            <div class="hd-row"><span class="hk">性能</span><span class="hv mono">${esc(h.metrics ? `${h.metrics.calls} 次调用 · 均 ${(h.metrics.avgTTFT / 1000).toFixed(2)}s · 峰 ${(h.metrics.maxTTFT / 1000).toFixed(2)}s · ${h.metrics.tokens || 0} tokens` : "—")}</span></div>
          </div>
        </div>
      </div>
      <div class="sec-title mt-12">调用明细与完整提示词 <span class="st-note">${(h.prompts || []).length} 步</span></div>
      ${steps || `<p class="text-muted">无提示词记录</p>`}`;

    if ($("histDrawer").classList.contains("open")) {
      $("histDrawerBody").innerHTML = `<button class="btn btn-sm btn-ghost mb-12" id="hdBack">← 返回列表</button>` + detail;
      $("hdBack").onclick = renderHistDrawer;
    } else {
      const host = $("histList");
      host.innerHTML = `<button class="btn btn-sm btn-ghost mb-12" id="hdBack">← 返回列表</button>` + detail;
      $("hdBack").onclick = renderHistoryView;
    }

    qsa("[data-copy-p]").forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        copyText($("pb-" + b.dataset.copyP).textContent);
      };
    });
    const copyAll = $("hdCopyAll");
    if (copyAll) copyAll.onclick = () => copyText(
      (h.prompts || []).map(p => `===== ${p.label} =====\n` +
        (p.messages || []).map(m => `【${m.role}】\n${m.content}`).join("\n\n")).join("\n\n")
    );
    const replay = $("hdReplay");
    if (replay) replay.onclick = () => { replayResult(h); };
  }

  function replayResult(h) {
    const r = h.result || {};
    S.chars = h.chars || ["我"];
    S.hsk = h.hsk || 3;
    S.lang = h.lang || "English";
    S.region = h.region || "东南亚";
    $("charInput").value = S.chars.join("");
    $("hskRange").value = S.hsk;
    $("langSel").value = S.lang;
    $("regionSel").value = S.region;
    updateHskChip();
    S.result = r;
    setMode(h.mode);
    renderStory(r.story || {}, r.bilingual);
    renderScript(r.script);
    renderRole(r.role);
    renderTeach(r.quiz, r.courseware, false);
    activateTab(h.mode === "script" ? "script" : "story");
    $("rhTitle").textContent = `${S.chars.join("、")} · 历史回放`;
    const tag = $("rhSrcTag");
    tag.textContent = "历史回放";
    tag.className = "src-tag ai";
    go("author");
    toast("已回填该次生成结果", "ok");
  }

  /* ==================== 工具 ==================== */
  function setBusyUI(b) {
    const btn = $("btnGen");
    btn.disabled = b;
    btn.textContent = b ? "创编中…" : "开始创编";
    $("genSub").textContent = b ? "正在调用模型，请稍候" : "将依次调用标准化 Prompt 模板";
  }

  function emptyState(t, d) {
    return `<div class="empty"><div class="empty-glyphs">◌</div><h4>${esc(t)}</h4><p>${esc(d)}</p></div>`;
  }

  function copyText(t) {
    navigator.clipboard.writeText(t).then(
      () => toast("已复制到剪贴板", "ok"),
      () => toast("复制失败，请手动选择", "err")
    );
  }

  function toast(msg, kind) {
    const host = $("toastHost");
    const el = document.createElement("div");
    el.className = "toast" + (kind ? " toast-" + kind : "");
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.classList.add("show"), 10);
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, 2800);
  }

  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function exportJSON() {
    if (!S.result) return;
    download(`LINES-${S.chars.join("")}-${Date.now()}.json`, JSON.stringify(S.result, null, 2));
    toast("已导出 JSON", "ok");
  }

  function exportHist() {
    const list = histLoad();
    if (!list.length) { toast("暂无历史记录", "err"); return; }
    download(`LINES-history-${Date.now()}.json`, JSON.stringify(list, null, 2));
    toast("已导出历史记录", "ok");
  }

  /* ==================== 启动 ==================== */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
