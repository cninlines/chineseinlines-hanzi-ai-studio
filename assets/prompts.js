/* ============================================================
   prompts.js — 120+ 标准化多语种 Prompt 模板构造器
   ------------------------------------------------------------
   七类核心模板，覆盖「故事 / 脚本」双创编模式全链路。
   每个模板均带：角色人设 / 任务约束 / JSON Schema / 质量红线。
   ============================================================ */

const BASE_SYSTEM = `你是一条面向国际中文教育的专业生成流水线中的一环，兼具三重身份：
① 汉字字源学家（精通甲骨文、金文、小篆字形，《说文解字》学统，及汉字字际系联理论）
② 面向第二语言学习者的分级读物作家（熟稔《国际中文教育中文水平等级标准》HSK 1—6 级词汇与语法大纲）
③ 动画片编剧与角色设计师（熟悉跨文化视觉传达与文化适宜性审查）

【最高原则】
1. 字源考据优先于文学创作。凡非学界定论之说，必须在 evidence 字段中注明「一说」或标注存疑。
2. 虚构叙事与字源事实严格分离：故事是文学演绎，不得篡改学界公认的字源结论。
3. 输出结果必须是**合法 JSON**，不得包含 markdown 代码围栏、注释、省略号或任何解释性文字。
4. 所有面向学习者的中文文本，必须严格控制在目标 HSK 等级的词汇与语法范围内。`;

/* ---------- 通用 JSON 约束尾巴 ---------- */
const JSON_TAIL = `\n【输出铁律】
- 仅输出一个合法 JSON 对象/数组，禁止 \`\`\` 代码围栏、禁止行尾注释、禁止省略 (…) 占位。
- 所有字符串内的双引号必须转义；字符串内不得出现未转义的换行，长文本请用 \\n 或分段数组。
- 若某项无可靠依据，填 null，禁止编造。`;

/* ============================================================
   模板 01 — 字源解析
   ============================================================ */
function buildEtymologyPrompt(char) {
  const user = `请对汉字「${char}」进行专业级字源解析。

要求：
1. 本义须依据甲骨文/金文初形推定；若《说文》之说与小篆字形不合，应据甲金文纠正并说明。
2. 六书归类须具体（象形/指事/会意/形声/转注/假借），若为兼类请写 full 形式（如"会意兼形声"）。
3. 构件拆分需给出每个部件的形符/声符角色及其在构字中的实际功能。
4. 给出 IDS（Ideographic Description Sequence）字形描述序列，用标准运算符 ⿰⿱⿴⿵⿸⿹⿻ 等表示。

输出 JSON：
{
  "char": "${char}",
  "pinyin": "带声调拼音",
  "radical": "部首",
  "strokes": 整数,
  "hsk": 整数1-6,
  "liushu": "六书归类",
  "original_meaning": "本义，须简明且注明推断依据",
  "extended_meanings": ["引申义1", "引申义2"],
  "components": [{"part": "部件字形", "role": "形符/声符/记号/核心构件", "gloss": "该部件在构字中的功能"}],
  "ids": {"seq": ["运算符或部件", "..."], "note": "结构说明"},
  "evolution": [
    {"stage": "甲骨文", "desc": "形体特征描述", "glyph": "尽可能给出该阶段的字符形态"},
    {"stage": "金文",   "desc": "...", "glyph": "..."},
    {"stage": "小篆",   "desc": "...", "glyph": "..."},
    {"stage": "隶书",   "desc": "...", "glyph": "..."},
    {"stage": "楷书",   "desc": "...", "glyph": "${char}"}
  ],
  "citation": "引用《说文解字》或其他字书原文并注明出处；若需辨正请一并说明"
}${JSON_TAIL}`;

  return {
    tag: "TPL-01 字源解析",
    messages: [{ role: "system", content: BASE_SYSTEM }, { role: "user", content: user }]
  };
}

/* ============================================================
   模板 02 — 字际系联网络
   ============================================================ */
function buildRelationPrompt(char, etyBrief) {
  const user = `已知汉字「${char}」的字源背景：${etyBrief}

请构建其**字际系联网络**（cross-character relation network）。系联须围绕同一祖型或共享核心构件展开，覆盖下列五类关系：
- chronological_cognate 历时同源：由同一字在不同时代分化而生的今字/古字关系（如「或」→「國」「域」）
- component_derivation 构件孳乳：共享核心构件且语义同源孳生（如「我」→「義」）
- phonetic_derivation 形声孳乳：以该字为声符的形声字群（如「我」→「鹅/峨/娥」）
- semantic_extension 意义引申：同一字承载的引申义在后代分化为独立字
- loan_graph 通假假借：因音近借用而形成的字际关系

要求：
1. 输出 5—7 条关系，其中必须至少包含 1 条「历时同源」与 1 条「构件孳乳」。
2. 每条须给出字书佐证（优先《说文解字》，可用段玉裁《说文解字注》、《甲骨文字诂林》等）。
3. 系联链可以是多层级的（如 我 → 義 → 儀），请在 expansion_order 中标明层级。
4. 严禁为凑数量而罗列仅有现代字形偶然相似的汉字。

输出 JSON：
{
  "core_char": "${char}",
  "relations": [
    {
      "target": "关联汉字",
      "type": "chronological_cognate|component_derivation|phonetic_derivation|semantic_extension|loan_graph",
      "relation_label": "中文关系名",
      "expansion_order": 整数（1为直接孳乳，2为二级孳乳）,
      "explanation": "系联逻辑说明，须点明共享什么（字形/构件/语源义）",
      "evidence": "字书原文出处",
      "shared_feature": "共享的具体构件或语源义"
    }
  ]
}${JSON_TAIL}`;

  return {
    tag: "TPL-02 字际系联",
    messages: [{ role: "system", content: BASE_SYSTEM }, { role: "user", content: user }]
  };
}

/* ============================================================
   模板 03 — HSK 分级文化故事 + 双语对照
   ============================================================ */
function buildStoryPrompt(chars, hskLevel, targetLang, relationBrief) {
  const M = HSK_MATRIX[hskLevel];
  const user = `请创作一篇将字源学知识自然融入叙事的汉字文化故事。

【目标汉字组】${chars.join("、")}
【汉字系联背景】${relationBrief}

【学习者画像】
- HSK ${hskLevel} 级：掌握约 ${M.vocab} 个词
- 句式上限：${M.sentence}
- 语法范围：${M.grammar}
- 成语/典故：${M.idioms}
- 语体基调：${M.tone}
- 篇幅控制：中文正文 ${M.words} 字

【叙事要求】
1. 故事须让这组汉字的**字源意象**自然重现于情节中：不是讲解汉字，而是让学习者先看见画面、后理解字形。
2. 关键目标汉字在第 1 次出现时，应在其紧邻上下文中给出足以推知字源的意象描写（如"他手里握着长柄带齿的兵器"之于「我」）。
3. 情节需有明确的人物、动机与转折；结尾宜回扣到现代书写者的处境，形成"古今呼应"。
4. 分段输出，每段 1—3 句。

【双语输出要求】
- 目标语种：${targetLang}
- 逐句对照，句数为 6—9 句，覆盖故事主干
- 译文须为自然地道的${targetLang}教学语言，禁止逐字硬译；允许适度增益以保证可读性

输出 JSON：
{
  "title": "故事标题（中文）",
  "title_target": "故事标题（${targetLang}）",
  "level": ${hskLevel},
  "word_count": 整数（中文正文实际字数）,
  "body": ["中文段落1", "中文段落2", "..."],
  "bilingual": {
    "target_language": "${targetLang}",
    "rows": [{"zh": "中文单句", "tr": "${targetLang}译文"}]
  },
  "vocabulary_notes": [{"word": "超纲词", "meaning": "释义", "level": "所属HSK等级或超纲"}],
  "target_char_appearances": [{"char": "目标汉字", "imagery": "该字在故事中依托的画面"}]
}${JSON_TAIL}`;

  return {
    tag: "TPL-03 分级文化故事",
    messages: [{ role: "system", content: BASE_SYSTEM }, { role: "user", content: user }]
  };
}

/* ============================================================
   模板 04 — 动画分镜脚本（可落地剪辑脚本 + 双语叙事底层素材）
   ============================================================ */
function buildScriptPrompt(chars, hskLevel, targetLang, relationBrief) {
  const M = HSK_MATRIX[hskLevel];
  const user = `请为「${chars.join("、")}」这组汉字创作一部字源情境动画的**可落地剪辑分镜脚本**。

【系联背景】${relationBrief}
【叙述受众】HSK ${hskLevel} 级学习者（旁白用中文，控制在 ${M.sentence} 的句式范围内）
【目标语种】${targetLang}（提供旁白译文字幕）

【创作要求】
1. 每个分镜必须完成一次**字源意象的视觉转译**：道具、动作或构图要使观众能自行看出字形来源。
2. 分镜须覆盖完整的字族谱系：先呈现核心字本义，再依次过渡到各孳乳字的产生逻辑。
3. 时长控制在 90—180 秒，分镜 8—12 个。
4. 历史考据：服饰、器物、建筑、兵器须指定大致年代与地域，并给出考古依据。禁止出现朝代错位的道具（如汉代人用商代兵器）。
5. 给出 film_ratio 与 art_style 建议。

输出 JSON：
{
  "title": "动画短片标题",
  "film_ratio": "16:9 / 9:16 等",
  "art_style": "美术风格建议（须具体可执行）",
  "total_duration": "总时长，如 '150 秒'",
  "historical_background": "历史时期、地域、主要服饰形制与建材；列明考古依据来源",
  "palette": ["#主色1", "#主色2", "#主色3", "#主色4"],
  "shots": [
    {
      "no": 整数,
      "dur": 秒数,
      "size": "远景/全景/中景/近景/特写",
      "cam": "镜头运动",
      "visual": "画面内容描述，须含角色动作与关键器物细节",
      "nar": "${targetLang}之外的中文旁白",
      "nar_target": "旁白译文（${targetLang}）",
      "sfx": "音效/配乐提示",
      "trans": "转场方式",
      "source_material_ref": "该分镜对应的字源依据（对应哪个字的哪个构件）"
    }
  ]
}${JSON_TAIL}`;

  return {
    tag: "TPL-04 动画分镜脚本",
    messages: [{ role: "system", content: BASE_SYSTEM }, { role: "user", content: user }]
  };
}

/* ============================================================
   模板 05 — 角色形象设计 + 跨文化地域适配
   ============================================================ */
function buildRolePrompt(chars, region, historicalBg) {
  const R = REGION_PROFILE[region] || REGION_PROFILE["东南亚"];
  const redlines = R.redlines.map((r, i) => `  ${i + 1}. ${r}`).join("\n");

  const user = `请为本片设计主要角色的视觉形象，并完成面向**${region}**教学受众的跨文化适配。

【涉及汉字】${chars.join("、")}
【历史背景】${historicalBg}

【该地域视觉基调】
- 美学取向：${R.aesthetics}
- 服饰参考：${R.costume}

【跨文化红线（必须逐条规避，并在 cross_cultural_notes 中说明如何规避）】
${redlines}

【设计要求】
1. 角色姓名需中性、易读、易于${region}学习者发音，并给出拉丁转写。
2. costume 须精确到具体国别/族群来源，禁止「泛${region}风」混搭。
3. 色彩需给出可直接使用的 HEX 值，且与 historical 背景材质相符。
4. 必须产出可直接投喂给 AI 图像生成模型（Midjourney / Stable Diffusion）的中英文 prompt。

输出 JSON：
{
  "region": "${region}",
  "set_dressing": "场景陈设建议",
  "characters": [
    {
      "name": "角色名（含拉丁转写）",
      "identity": "身份与年龄",
      "personality": "性格关键词",
      "costume": "服饰描述：须明确国别来源、形制名称、材质与穿着层级",
      "accessories": ["配饰1", "配饰2"],
      "palette": ["#HEX 色名", "..."],
      "image_gen_prompt_en": "英文 AI 绘图 prompt，含镜头/光线/风格/画质标签",
      "image_gen_prompt_zh": "中文 AI 绘图 prompt",
      "negative_prompt": "负面提示词（须含规避刻板印象的项）",
      "cross_cultural_notes": ["规避说明1（对应哪条红线）", "规避说明2"]
    }
  ]
}${JSON_TAIL}`;

  return {
    tag: "TPL-05 角色形象设计",
    messages: [{ role: "system", content: BASE_SYSTEM }, { role: "user", content: user }]
  };
}

/* ============================================================
   模板 06 — 分级课后习题
   ============================================================ */
function buildQuizPrompt(chars, hskLevel, storyBrief) {
  const M = HSK_MATRIX[hskLevel];
  const user = `请围绕下述汉字组与故事，设计一套分级课后习题。

【目标汉字】${chars.join("、")}
【故事梗概】${storyBrief}
【难度】HSK ${hskLevel} 级（题干用语不得超过该级词汇量 ${M.vocab} 词范围；语法点限于 ${M.grammar}）

【题型要求】
- 共 5 题，须覆盖至少 4 种题型，从下列中选择：选择题 / 填空题 / 排序题 / 连线题 / 判断题 / 思考表达题
- 至少 1 题考查**字源本义**（而非现代义）
- 至少 1 题考查**字际系联逻辑**（为何这些字可以一起记）
- 至少 1 题为开放式产出题
- 每题 4 个选项（客观题），并给出解析

输出 JSON：
{
  "level": ${hskLevel},
  "quiz": [
    {
      "no": 整数,
      "type": "题型",
      "stem": "题干",
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "answer": "A",
      "analysis": "解析，须回扣字源或系联逻辑"
    }
  ]
}${JSON_TAIL}`;

  return {
    tag: "TPL-06 分级习题",
    messages: [{ role: "system", content: BASE_SYSTEM }, { role: "user", content: user }]
  };
}

/* ============================================================
   模板 07 — 成套教学课件
   ============================================================ */
function buildCoursewarePrompt(chars, hskLevel, storyBrief) {
  const user = `请设计一份可直接用于国际中文课堂的成套教学课件（45 分钟标准课时）。

【目标汉字】${chars.join("、")}
【配套故事】${storyBrief}
【学习者】HSK ${hskLevel} 级

【结构要求】
- 6—8 页，线性推进：导入 → 追溯本义 → 拆解构件 → 系联扩展 → 故事输入 → 巩固产出
- 每页须标明：页码、标题、教师讲授内容、视觉素材建议、课堂活动、时长
- 总时长合计 45 分钟

【教学理念】
必须体现「字际系联」教学法的核心优势：以一条语义/构件主线串联一组字，将孤立记忆转化为网络记忆，直接回应学习者"记忆难、书写难、字脉关联弱、文化理解浅"四大痛点。

输出 JSON：
{
  "duration_total": "45 分钟",
  "teaching_aims": ["知识目标", "能力目标", "文化目标"],
  "key_difficulty": "教学重点难点",
  "slides": [
    {
      "slide": 整数,
      "title": "页面标题",
      "content": "教师讲授要点",
      "visual": "视觉素材建议（具体到动画/图表形式）",
      "activity": "课堂活动设计",
      "duration": "如 '5 min'"
    }
  ]
}${JSON_TAIL}`;

  return {
    tag: "TPL-07 教学课件",
    messages: [{ role: "system", content: BASE_SYSTEM }, { role: "user", content: user }]
  };
}

/* ============================================================
   模板 08 — 发音资源（多语种发音对照）
   ============================================================ */
function buildAudioPrompt(chars, targetLang) {
  const user = `请提供目标汉字的普通话读音及面向${targetLang}母语者的发音教学资源。

【目标汉字】${chars.join("、")}

输出 JSON：
{
  "items": [
    {
      "char": "汉字",
      "pinyin": "带调拼音",
      "ipa": "国际音标，含调值如 [wo˨˩˦]",
      "tone": "声调说明",
      "tone_sandhi": "变调规则（如有）",
      "learner_difficulty": "面向${targetLang}母语者的发音难点",
      "teaching_tip": "具体可操作的正音方法"
    }
  ]
}${JSON_TAIL}`;

  return {
    tag: "TPL-08 发音资源",
    messages: [{ role: "system", content: BASE_SYSTEM }, { role: "user", content: user }]
  };
}

/* 暴露到全局 */
window.PROMPTS = {
  etymology:  buildEtymologyPrompt,
  relation:   buildRelationPrompt,
  story:      buildStoryPrompt,
  script:     buildScriptPrompt,
  role:       buildRolePrompt,
  quiz:       buildQuizPrompt,
  courseware: buildCoursewarePrompt,
  audio:      buildAudioPrompt
};
