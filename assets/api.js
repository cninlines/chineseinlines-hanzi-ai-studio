/* ============================================================
   api.js — OpenAI 兼容协议调用引擎
   ------------------------------------------------------------
   · SSE 流式解析　· TTFT / 总耗时 / Token 统计
   · JSON 鲁棒提取　· 失败自动降级到内置演示语料
   ============================================================ */

const CONFIG_KEY = "lines_studio_cfg";

const PROVIDERS = {
  deepseek: { name: "DeepSeek",   url: "https://api.deepseek.com/v1",                     model: "deepseek-chat" },
  qwen:     { name: "通义千问",   url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  moonshot: { name: "Kimi",       url: "https://api.moonshot.cn/v1",                      model: "moonshot-v1-8k" },
  openai:   { name: "OpenAI",     url: "https://api.openai.com/v1",                       model: "gpt-4o-mini" },
  glm:      { name: "智谱 GLM",   url: "https://open.bigmodel.cn/api/paas/v4",            model: "glm-4-flash" },
  custom:   { name: "自定义",     url: "",                                                model: "" }
};

const CFG = {
  provider: "deepseek",
  url: "https://api.deepseek.com/v1",
  key: "",
  model: "deepseek-chat",
  temp: 0.75,
  strict: "json_object"
};

function loadCfg() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) Object.assign(CFG, JSON.parse(raw));
  } catch (e) { /* 忽略损坏配置 */ }
  return CFG;
}
function saveCfg() {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(CFG)); } catch (e) {}
}
function hasKey() { return !!CFG.key && !!CFG.url; }

/* ---------------- SSE 流式对话 ---------------- */
/**
 * @param {Array}  messages  [{role, content}]
 * @param {Object} opts      { temperature, jsonMode, onDelta, signal }
 * @returns {Promise<{text, ttft, total, usage}>}
 */
async function chatStream(messages, opts = {}) {
  const {
    temperature = CFG.temp,
    jsonMode = CFG.strict === "json_object",
    onDelta = null,
    signal = null
  } = opts;

  if (!hasKey()) throw new Error("NO_KEY");

  const url = CFG.url.replace(/\/+$/, "") + "/chat/completions";
  const body = {
    model: CFG.model,
    messages,
    stream: true,
    temperature: Number(temperature)
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const t0 = performance.now();
  let ttft = null;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + CFG.key
    },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch (e) {}
    throw new Error(`HTTP ${res.status}${detail ? " · " + detail : ""}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "", full = "", usage = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop();                       // 保留可能未完结的行

    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") continue;

      try {
        const j = JSON.parse(payload);
        if (j.usage) usage = j.usage;
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) {
          if (ttft === null) ttft = performance.now() - t0;
          full += delta;
          if (onDelta) onDelta(delta, full);
        }
      } catch (e) { /* 跳过畸形分片 */ }
    }
  }

  return {
    text: full,
    ttft: ttft === null ? performance.now() - t0 : ttft,
    total: performance.now() - t0,
    usage
  };
}

/* ---------------- JSON 鲁棒提取 ---------------- */
function extractJSON(raw) {
  if (!raw) return null;

  let s = raw.trim();

  // 去 markdown 围栏
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  // 直接尝试
  try { return JSON.parse(s); } catch (e) {}

  // 截取首个 { 或 [ 到最后一个配对符
  const startObj = s.indexOf("{"), startArr = s.indexOf("[");
  let start = -1, openCh = "", closeCh = "";
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) { start = startObj; openCh = "{"; closeCh = "}"; }
  else if (startArr >= 0) { start = startArr; openCh = "["; closeCh = "]"; }
  if (start < 0) return null;

  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) end = s.length - 1;
  const slice = s.slice(start, end + 1);

  try { return JSON.parse(slice); } catch (e) {}

  // 容错：去尾随逗号、换行未转义
  try {
    const repaired = slice
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, " ");
    return JSON.parse(repaired);
  } catch (e2) {
    return null;
  }
}

/* ---------------- 连通性自检 ---------------- */
async function testConnection() {
  if (!hasKey()) return { ok: false, msg: "未填写 Base URL 或 API Key" };
  const t0 = performance.now();
  try {
    const r = await chatStream(
      [{ role: "user", content: "回复一个字：通" }],
      { jsonMode: false, temperature: 0.1 }
    );
    return { ok: true, msg: `连通正常 · ${Math.round(r.total)} ms · 模型 ${CFG.model}` };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

/* ---------------- 延迟指标累计 ---------------- */
const METRICS = { calls: 0, sumTTFT: 0, sumTotal: 0, maxTTFT: 0, tokens: 0, rows: [] };

function pushMetric(name, r, ok) {
  METRICS.calls++;
  METRICS.sumTTFT  += r.ttft;
  METRICS.sumTotal += r.total;
  METRICS.maxTTFT   = Math.max(METRICS.maxTTFT, r.ttft);
  METRICS.tokens   += (r.usage?.total_tokens || 0);
  METRICS.rows.push({
    step: name, ttft: Math.round(r.ttft), total: Math.round(r.total),
    tokens: r.usage?.total_tokens || 0, ok: ok !== false
  });
}
function resetMetrics() {
  METRICS.calls = 0; METRICS.sumTTFT = 0; METRICS.sumTotal = 0;
  METRICS.maxTTFT = 0; METRICS.tokens = 0; METRICS.rows = [];
}

window.API = {
  CFG, PROVIDERS, loadCfg, saveCfg, hasKey,
  chatStream, extractJSON, testConnection,
  METRICS, pushMetric, resetMetrics
};
