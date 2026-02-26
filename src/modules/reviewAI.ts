import {
  detectAwesomeGPTAsync,
  getEffectiveReviewAPISettings,
  getReviewSettings,
} from "./reviewConfig";
import {
  LiteratureReviewDraft,
  ReviewRecordRow,
  ReviewSettings,
} from "./reviewTypes";

const MAX_SOURCE_CONTENT_CHARS = 100_000;
const MAX_FOLDER_SUMMARY_SOURCE_CHARS = 140_000;
const MAX_NOTE_TEXT_CHARS = 4_000;
const MAX_PDF_TEXT_CHARS = 20_000;
const MAX_PDF_ANNOTATION_TEXT_CHARS = 12_000;
const MAX_PDF_ANNOTATION_COUNT = 80;
const GPT_PLUGIN_TIMEOUT_FLOOR_SECONDS = 600;
const EMBEDDING_MAX_CHUNKS = 12;
const EMBEDDING_CHUNK_CHARS = 1200;
const EMBEDDING_TOP_K = 4;

export interface ReviewExtractionProgress {
  progress: number;
  stage: string;
}

export const DEFAULT_REVIEW_PROMPT_TEMPLATE = [
  "请根据以下文献信息生成结构化提炼结果。",
  "要求：",
  "1. 仅返回 JSON 对象，不要代码块。",
  "2. 使用中文输出（title/authors/journal/publicationDate 可保留原文）。",
  "3. 字段必须包含：title, authors, journal, publicationDate, abstract, researchBackground, literatureReview, researchMethods, researchConclusions, keyFindings, classificationTags",
  "4. keyFindings 和 classificationTags 必须是字符串数组。",
  "5. 若信息不足，请明确写出“信息不足”而不是编造。",
  "",
  "文献信息如下：",
  "{{sourceContent}}",
].join("\n");

export const DEFAULT_FOLDER_SUMMARY_PROMPT_TEMPLATE = [
  "请基于同一文件夹下的多篇文献提炼记录，生成一份中文综合综述。",
  "要求：",
  "1. 输出结构清晰、便于阅读，可使用分标题。",
  "2. 至少包含：主题概述、研究脉络、方法比较、主要结论、分歧与局限、未来方向。",
  "3. 严格基于提供的记录信息，不要编造文献细节。",
  "4. 如果信息不足，请明确指出不足之处。",
  "",
  "文件夹名称：{{folderName}}",
  "",
  "记录内容如下：",
  "{{recordsContent}}",
].join("\n");

interface ReviewItemSource {
  title: string;
  authors: string;
  journal: string;
  date: string;
  abstractText: string;
  zoteroTags: string[];
  content: string;
  pdfText: string;
  pdfAttachmentLabel: string;
  pdfAnnotationText: string;
  importPDFAnnotationsAsField: boolean;
}

interface ReviewExtractionOptions {
  onProgress?: (update: ReviewExtractionProgress) => void;
}

interface FolderReviewSummaryOptions {
  onProgress?: (update: ReviewExtractionProgress) => void;
}

export interface FolderReviewSummaryResult {
  text: string;
  provider: string;
  model: string;
  folderName: string;
  recordCount: number;
}

type ReviewProgressReporter = (progress: number, stage: string) => void;

class ReviewUserError extends Error {
  userMessage: string;

  constructor(message: string, userMessage?: string) {
    super(message);
    this.name = "ReviewUserError";
    this.userMessage = userMessage || message;
  }
}

export async function extractLiteratureReview(
  item: Zotero.Item,
  options: ReviewExtractionOptions = {},
) {
  const report = createProgressReporter(options.onProgress);
  report(2, "准备提炼");
  report(8, "读取文献信息");

  const settings = getReviewSettings();
  const source = await buildItemSource(item, settings, report);
  const effectiveSettings = getEffectiveReviewAPISettings(settings);
  const hasConfiguredAPI = Boolean(
    String(effectiveSettings.secretKey || "").trim() &&
      String(effectiveSettings.model || "").trim(),
  );
  report(35, "整理提炼输入");

  if (source.content.length > MAX_SOURCE_CONTENT_CHARS) {
    throw new ReviewUserError("文献内容过长", "单个文献内容超过 100,000 字符，暂不支持提炼");
  }

  if (settings.modelConfigMode === "awesomegpt") {
    report(42, "检查 GPT 插件");
    return await extractByCompatibleGPTPlugin(
      item,
      source,
      getCompatibleGPTTimeoutSeconds(settings.timeoutSeconds),
      settings.customPromptTemplate,
      report,
    );
  }

  if (!hasConfiguredAPI) {
    report(42, "检查 AI 配置");
    // UX fallback: if user has a compatible GPT plugin available, use it directly
    // even when they forgot to switch/save the mode in settings.
    report(46, "尝试兼容 GPT 插件");
    const fallbackDetection = await detectAwesomeGPTAsync();
    if (fallbackDetection.installed && fallbackDetection.callable) {
      return await extractByCompatibleGPTPlugin(
        item,
        source,
        getCompatibleGPTTimeoutSeconds(settings.timeoutSeconds),
        settings.customPromptTemplate,
        report,
      );
    }
    throw new ReviewUserError(
      "AI config missing",
      "请检查AI模型配置：API Key 和模型不能为空",
    );
  }

  try {
    report(50, "检查 AI 配置");
    let sourceContent = source.content;
    if (effectiveSettings.provider === "openai") {
      sourceContent = await enrichSourceContentWithConfiguredEmbeddings(
        source,
        effectiveSettings,
        report,
      );
    }
    report(
      58,
      effectiveSettings.provider === "gemini" ? "准备 Gemini 请求" : "准备 AI 请求",
    );
    report(
      66,
      effectiveSettings.provider === "gemini" ? "等待 Gemini 响应" : "等待 AI 响应",
    );
    const rawText =
      effectiveSettings.provider === "gemini"
        ? await callGemini(effectiveSettings, sourceContent)
        : await callOpenAICompatible(effectiveSettings, sourceContent);
    report(88, "解析 AI 返回内容");

    const draft = normalizeDraft(item, rawText, {
      provider:
        effectiveSettings.apiConfigMode === "zoterogpt"
          ? "zoterogpt-config"
          : effectiveSettings.provider,
      model: effectiveSettings.model,
      source,
    });
    report(96, "整理提炼结果");
    return draft;
  } catch (e: any) {
    const message = e?.message ? String(e.message) : "unknown";
    if (e instanceof ReviewUserError) throw e;
    throw new ReviewUserError(message, humanizeAIError(message));
  }
}

export function getDefaultReviewPromptTemplate() {
  return DEFAULT_REVIEW_PROMPT_TEMPLATE;
}

export function getDefaultFolderSummaryPromptTemplate() {
  return DEFAULT_FOLDER_SUMMARY_PROMPT_TEMPLATE;
}

export async function synthesizeFolderReview(
  folderName: string,
  rows: ReviewRecordRow[],
  options: FolderReviewSummaryOptions = {},
): Promise<FolderReviewSummaryResult> {
  const report = createProgressReporter(options.onProgress);
  const normalizedFolderName = String(folderName || "").trim() || "未命名文件夹";
  const validRows = (rows || []).filter(Boolean);
  if (!validRows.length) {
    throw new ReviewUserError("No records in folder", "该文件夹下暂无可用于合并综述的记录");
  }

  report(5, "整理文件夹记录");
  const recordsContent = buildFolderSummarySourceContent(normalizedFolderName, validRows, report);
  const settings = getReviewSettings();
  const effectiveSettings = getEffectiveReviewAPISettings(settings);
  const hasConfiguredAPI = Boolean(
    String(effectiveSettings.secretKey || "").trim() &&
      String(effectiveSettings.model || "").trim(),
  );
  const prompt = buildFolderSummaryPrompt(
    normalizedFolderName,
    recordsContent,
    settings.customFolderSummaryPromptTemplate,
  );

  if (settings.modelConfigMode === "awesomegpt") {
    report(30, "检查 GPT 插件");
    const result = await summarizeByCompatibleGPTPlugin(
      normalizedFolderName,
      prompt,
      recordsContent,
      getCompatibleGPTTimeoutSeconds(settings.timeoutSeconds),
      report,
    );
    result.recordCount = validRows.length;
    return result;
  }

  if (!hasConfiguredAPI) {
    report(30, "检查 AI 配置");
    report(36, "尝试兼容 GPT 插件");
    const fallbackDetection = await detectAwesomeGPTAsync();
    if (fallbackDetection.installed && fallbackDetection.callable) {
      const result = await summarizeByCompatibleGPTPlugin(
        normalizedFolderName,
        prompt,
        recordsContent,
        getCompatibleGPTTimeoutSeconds(settings.timeoutSeconds),
        report,
      );
      result.recordCount = validRows.length;
      return result;
    }
    throw new ReviewUserError(
      "AI config missing",
      "请检查AI模型配置：API Key 和模型不能为空",
    );
  }

  try {
    report(40, "检查 AI 配置");
    report(
      56,
      effectiveSettings.provider === "gemini" ? "准备 Gemini 综述请求" : "准备综述请求",
    );
    report(
      68,
      effectiveSettings.provider === "gemini" ? "等待 Gemini 综述结果" : "等待综述结果",
    );
    const text =
      effectiveSettings.provider === "gemini"
        ? await callGeminiFreeform(effectiveSettings, prompt)
        : await callOpenAICompatibleFreeform(effectiveSettings, prompt);
    report(92, "整理综述结果");
    return {
      text: String(text || "").trim(),
      provider:
        effectiveSettings.apiConfigMode === "zoterogpt"
          ? "zoterogpt-config"
          : effectiveSettings.provider,
      model: effectiveSettings.model,
      folderName: normalizedFolderName,
      recordCount: validRows.length,
    };
  } catch (e: any) {
    const message = e?.message ? String(e.message) : "unknown";
    if (e instanceof ReviewUserError) throw e;
    throw new ReviewUserError(message, humanizeAIError(message));
  }
}

function createProgressReporter(
  onProgress?: (update: ReviewExtractionProgress) => void,
): ReviewProgressReporter {
  let lastProgress = -1;
  let lastStage = "";
  return (progress, stage) => {
    if (!onProgress) return;
    const nextProgress = clampProgress(progress);
    const nextStage = String(stage || "").trim() || "处理中";
    if (nextProgress === lastProgress && nextStage === lastStage) return;
    lastProgress = nextProgress;
    lastStage = nextStage;
    onProgress({ progress: nextProgress, stage: nextStage });
  };
}

export function getReviewErrorMessage(error: unknown) {
  if (error instanceof ReviewUserError) return error.userMessage;
  if (error instanceof Error) return error.message;
  return "提炼失败，请重试";
}

function clampProgress(progress: number) {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.floor(progress)));
}

async function buildItemSource(
  item: Zotero.Item,
  settings: ReviewSettings,
  report?: ReviewProgressReporter,
): Promise<ReviewItemSource> {
  report?.(10, "读取元数据");
  const title = safeField(item, "title") || item.getDisplayTitle() || "";
  const journal = safeField(item, "publicationTitle");
  const date = safeField(item, "date");
  const abstractText = safeField(item, "abstractNote");
  const authors = joinCreators(item);
  const zoteroTags = getItemTags(item);
  report?.(16, "读取笔记");
  const noteText = getNoteText(item);
  const shouldReadPDFAnnotations =
    Boolean(settings.usePDFAnnotationsAsContext) ||
    Boolean(settings.importPDFAnnotationsAsField);
  const pdfAnnotationSource = shouldReadPDFAnnotations
    ? await getPDFAnnotationSource(item, settings, report)
    : { text: "", label: "" };
  const pdfSource = settings.usePDFAsInputSource
    ? await getPDFTextSource(item, settings, report)
    : { text: "", label: "" };
  report?.(30, "整理文献内容");

  const content = [
    `标题: ${title}`,
    `作者: ${authors}`,
    `期刊: ${journal}`,
    `时间: ${date}`,
    `标签: ${zoteroTags.join(", ")}`,
    "",
    "摘要:",
    abstractText || "（无摘要）",
    noteText ? "\n补充笔记:\n" + noteText : "",
    settings.usePDFAnnotationsAsContext && pdfAnnotationSource.text
      ? `\nPDF批注与批注下笔记（${pdfAnnotationSource.label || "附件"}）：\n${pdfAnnotationSource.text}`
      : "",
    pdfSource.text
      ? `\nPDF原文（${pdfSource.label || "附件"}）：\n${pdfSource.text}`
      : "",
  ]
    .filter((v) => v != null && String(v).length > 0)
    .join("\n");

  return {
    title,
    authors,
    journal,
    date,
    abstractText,
    zoteroTags,
    content,
    pdfText: pdfSource.text,
    pdfAttachmentLabel: pdfSource.label,
    pdfAnnotationText: pdfAnnotationSource.text,
    importPDFAnnotationsAsField: Boolean(settings.importPDFAnnotationsAsField),
  };
}

async function extractByCompatibleGPTPlugin(
  item: Zotero.Item,
  source: ReviewItemSource,
  timeoutSeconds: number,
  customPromptTemplate: string,
  report?: ReviewProgressReporter,
) {
  report?.(48, "检查 GPT 插件状态");
  const detection = await detectAwesomeGPTAsync();
  if (!detection.installed) {
    throw new ReviewUserError(
      "Awesome GPT not found",
      "未检测到可兼容的 GPT 插件（如 Zotero GPT / Awesome GPT），请切换为本插件 API 配置",
    );
  }
  if (detection.installed && !detection.callable) {
    throw new ReviewUserError(
      "Awesome GPT not callable",
      detection.obstacle ||
        "检测到 GPT 插件已安装，但未找到可调用接口，请在设置中切换为本插件 API 配置",
    );
  }
  report?.(56, "准备 GPT 插件提炼请求");
  const bridgeSourceContent = await enrichSourceContentWithPDFEmbeddings(
    source,
    timeoutSeconds,
    report,
  );
  report?.(74, "等待 GPT 插件响应");
  const awesomeResult = await tryCallAwesomeGPT(
    item,
    bridgeSourceContent,
    timeoutSeconds,
    buildPrompt(bridgeSourceContent, customPromptTemplate),
  );
  if (!awesomeResult) {
    throw new ReviewUserError(
      "Awesome GPT bridge unavailable",
      "已检测到 GPT 插件，但当前未找到可调用接口，请在设置中切换为本插件 API 配置",
    );
  }
  report?.(88, "解析 GPT 插件返回内容");
  const draft = normalizeDraft(item, awesomeResult.text, {
    provider: "awesomegpt",
    model: awesomeResult.model || "awesomegpt",
    source,
  });
  report?.(96, "整理提炼结果");
  return draft;
}

async function summarizeByCompatibleGPTPlugin(
  folderName: string,
  prompt: string,
  recordsContent: string,
  timeoutSeconds: number,
  report?: ReviewProgressReporter,
): Promise<FolderReviewSummaryResult> {
  report?.(44, "检查 GPT 插件状态");
  const detection = await detectAwesomeGPTAsync();
  if (!detection.installed) {
    throw new ReviewUserError(
      "Awesome GPT not found",
      "未检测到可兼容的 GPT 插件（如 Zotero GPT / Awesome GPT），请切换为本插件 API 配置",
    );
  }
  if (!detection.callable) {
    throw new ReviewUserError(
      "Awesome GPT not callable",
      detection.obstacle ||
        "检测到 GPT 插件已安装，但未找到可调用接口，请在设置中切换为本插件 API 配置",
    );
  }
  report?.(58, "发送合并综述请求");
  const awesomeResult = await tryCallAwesomeGPT(
    null,
    recordsContent,
    timeoutSeconds,
    prompt,
  );
  if (!awesomeResult) {
    throw new ReviewUserError(
      "Awesome GPT bridge unavailable",
      "已检测到 GPT 插件，但当前未找到可调用接口，请在设置中切换为本插件 API 配置",
    );
  }
  report?.(92, "整理综述结果");
  return {
    text: String(awesomeResult.text || "").trim(),
    provider: "awesomegpt",
    model: awesomeResult.model || "awesomegpt",
    folderName,
    recordCount: 0, // caller will overwrite if needed; kept for shape consistency
  };
}

async function callOpenAICompatibleFreeform(
  settings: ReviewSettings,
  prompt: string,
) {
  const endpoint = buildOpenAIChatEndpoint(settings.api);
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.secretKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: settings.temperature,
        messages: [
          {
            role: "system",
            content:
              "你是一名科研助理。请根据用户提供的内容生成清晰、准确、可读的中文综述。",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    },
    settings.timeoutSeconds,
  );

  const data: any = await response.json();
  if (!response.ok) {
    throw new Error((data?.error?.message as string) || `HTTP ${response.status}`);
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("AI 返回内容为空");
  }
  return String(content);
}

async function callGeminiFreeform(
  settings: ReviewSettings,
  prompt: string,
) {
  const endpoint = buildGeminiEndpoint(settings.api, settings.model, settings.secretKey);
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: settings.temperature,
        },
      }),
    },
    settings.timeoutSeconds,
  );

  const data: any = await response.json();
  if (!response.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${response.status}`;
    throw new Error(String(msg));
  }
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p: any) => p?.text || "").join("\n")
    : "";
  if (!text) {
    throw new Error("Gemini 返回内容为空");
  }
  return String(text);
}

async function callOpenAICompatible(
  settings: ReviewSettings,
  sourceContent: string,
) {
  const endpoint = buildOpenAIChatEndpoint(settings.api);
  const prompt = buildPrompt(sourceContent, settings.customPromptTemplate);
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.secretKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: settings.temperature,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "你是一名科研助理。你必须返回严格 JSON，不要输出 Markdown 代码块。",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  }, settings.timeoutSeconds);

  const data: any = await response.json();
  if (!response.ok) {
    throw new Error(
      (data?.error?.message as string) || `HTTP ${response.status}`,
    );
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("AI 返回内容为空");
  }
  return String(content);
}

async function callGemini(
  settings: ReviewSettings,
  sourceContent: string,
) {
  const endpoint = buildGeminiEndpoint(settings.api, settings.model, settings.secretKey);
  const prompt = buildPrompt(sourceContent, settings.customPromptTemplate);
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: settings.temperature,
        responseMimeType: "application/json",
      },
    }),
  }, settings.timeoutSeconds);

  const data: any = await response.json();
  if (!response.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${response.status}`;
    throw new Error(String(msg));
  }

  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p: any) => p?.text || "").join("\n")
    : "";
  if (!text) {
    throw new Error("Gemini 返回内容为空");
  }
  return String(text);
}

async function tryCallAwesomeGPT(
  item: Zotero.Item | null,
  sourceContent: string,
  timeoutSeconds: number,
  prompt: string,
) {
  const requestPayload = {
    item,
    prompt,
    sourceContent,
  };
  const mainWin = (Zotero.getMainWindows?.()[0] as any) || null;
  const bridgeCalls: Array<() => Promise<any>> = [
    async () => {
      const fn = (Zotero as any)?.AwesomeGPT?.extractLiteratureReview;
      if (typeof fn !== "function") return null;
      return fn(requestPayload);
    },
    async () => {
      const fn = (Zotero as any)?.AwesomeGPT?.extract;
      if (typeof fn !== "function") return null;
      return fn(requestPayload);
    },
    async () => {
      const fn = (Zotero as any)?.GPT?.extract;
      if (typeof fn !== "function") return null;
      return fn(requestPayload);
    },
    async () => {
      const fn = (globalThis as any)?.AwesomeGPT?.extract;
      if (typeof fn !== "function") return null;
      return fn(requestPayload);
    },
    async () => {
      const meet = (mainWin as any)?.Meet;
      const fn = meet?.OpenAI?.getGPTResponse;
      if (typeof fn !== "function") return null;
      const text = await fn.call(meet.OpenAI, requestPayload.prompt);
      return {
        text,
        model:
          ((Zotero as any)?.Prefs?.get?.("extensions.zotero.zoterogpt.model") as
            | string
            | undefined) || "zotero-gpt",
      };
    },
  ];

  let lastError: unknown = null;
  for (const call of bridgeCalls) {
    try {
      const result = await withPromiseTimeout(
        call(),
        timeoutSeconds * 1000,
        new ReviewUserError(
          "GPT plugin bridge timeout",
          `GPT 插件响应超时（>${timeoutSeconds}秒），请重试`,
        ),
      );
      if (!result) continue;
      if (typeof result === "string") return { text: result };
      if (typeof result?.text === "string") return { text: result.text, model: result.model };
      if (typeof result?.content === "string") return { text: result.content, model: result.model };
    } catch (e) {
      lastError = e;
      // Try next candidate
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

function getCompatibleGPTTimeoutSeconds(timeoutSeconds: number) {
  const normalized = Math.max(1, Math.floor(Number(timeoutSeconds) || 0));
  return Math.max(GPT_PLUGIN_TIMEOUT_FLOOR_SECONDS, normalized);
}

async function enrichSourceContentWithPDFEmbeddings(
  source: ReviewItemSource,
  timeoutSeconds: number,
  report?: ReviewProgressReporter,
) {
  if (!source.pdfText) {
    return source.content;
  }

  report?.(60, "分析 PDF 重点片段");
  const embeddingContext = await tryBuildPDFEmbeddingContext(source, timeoutSeconds, report);
  if (!embeddingContext) {
    report?.(68, "未获得 PDF 语义片段，继续提炼");
    return source.content;
  }

  const section = [
    "",
    "PDF语义检索片段（Embedding 相关段落）:",
    embeddingContext,
  ].join("\n");

  report?.(70, "合并 PDF 语义片段");
  return appendCappedSection(source.content, section, MAX_SOURCE_CONTENT_CHARS);
}

async function enrichSourceContentWithConfiguredEmbeddings(
  source: ReviewItemSource,
  settings: ReviewSettings,
  report?: ReviewProgressReporter,
) {
  if (!source.pdfText) {
    return source.content;
  }
  if (settings.provider !== "openai") {
    return source.content;
  }
  if (!settings.secretKey || !settings.embeddingModel) {
    return source.content;
  }

  report?.(60, "分析 PDF 重点片段");
  const embeddingContext = await tryBuildPDFEmbeddingContextViaAPI(
    source,
    settings,
    report,
  );
  if (!embeddingContext) {
    report?.(68, "未获得 PDF 语义片段，继续提炼");
    return source.content;
  }

  const section = [
    "",
    "PDF语义检索片段（Embedding 相关段落）:",
    embeddingContext,
  ].join("\n");

  report?.(70, "合并 PDF 语义片段");
  return appendCappedSection(source.content, section, MAX_SOURCE_CONTENT_CHARS);
}

async function tryBuildPDFEmbeddingContextViaAPI(
  source: ReviewItemSource,
  settings: ReviewSettings,
  report?: ReviewProgressReporter,
) {
  try {
    const chunks = chunkTextForEmbedding(source.pdfText);
    if (chunks.length < 2) {
      return "";
    }
    report?.(62, "计算 PDF 分块向量");

    const query = buildPDFEmbeddingQuery(source);
    const embedTimeoutSeconds = Math.max(
      20,
      Math.min(120, Math.floor(Number(settings.timeoutSeconds) || 0)),
    );

    const docVectorsRaw = await fetchOpenAIEmbeddingsInBatches(
      settings,
      chunks,
      embedTimeoutSeconds,
    );
    report?.(65, "计算检索查询向量");
    const [queryVectorRaw] = await fetchOpenAIEmbeddings(
      settings,
      [query],
      embedTimeoutSeconds,
    );

    const queryVector = toNumericVector(queryVectorRaw);
    if (!queryVector.length) {
      return "";
    }

    const ranked = chunks
      .map((text, index) => {
        const vector = toNumericVector(docVectorsRaw[index]);
        if (!vector.length) return null;
        return {
          index,
          text,
          score: cosineSimilarity(queryVector, vector),
        };
      })
      .filter(Boolean) as Array<{ index: number; text: string; score: number }>;

    if (!ranked.length) {
      return "";
    }
    report?.(67, "筛选相关 PDF 片段");

    const selected = ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, EMBEDDING_TOP_K)
      .sort((a, b) => a.index - b.index);

    return selected
      .map((chunk, i) => `[片段${i + 1}] ${truncateText(chunk.text, 1200)}`)
      .join("\n\n");
  } catch (e) {
    ztoolkit.log("Configured embedding enhancement skipped", e);
    return "";
  }
}

async function fetchOpenAIEmbeddingsInBatches(
  settings: ReviewSettings,
  inputs: string[],
  timeoutSeconds: number,
) {
  const batchSize = Math.max(
    1,
    Math.min(100, Math.floor(Number(settings.embeddingBatchNum) || 1)),
  );
  const vectors: number[][] = [];
  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    const next = await fetchOpenAIEmbeddings(settings, batch, timeoutSeconds);
    vectors.push(...next);
  }
  return vectors;
}

async function fetchOpenAIEmbeddings(
  settings: ReviewSettings,
  inputs: string[],
  timeoutSeconds: number,
) {
  if (!inputs.length) return [] as number[][];

  const endpoint = buildOpenAIEmbeddingsEndpoint(settings.api);
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.secretKey}`,
      },
      body: JSON.stringify({
        model: settings.embeddingModel,
        input: inputs,
      }),
    },
    Math.max(10, Math.min(settings.timeoutSeconds, timeoutSeconds)),
  );

  const data: any = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `HTTP ${response.status}`;
    throw new Error(String(message));
  }

  const rows = Array.isArray(data?.data) ? [...data.data] : [];
  rows.sort(
    (a: any, b: any) => Number(a?.index ?? 0) - Number(b?.index ?? 0),
  );
  return rows.map((row: any) => toNumericVector(row?.embedding));
}

async function tryBuildPDFEmbeddingContext(
  source: ReviewItemSource,
  timeoutSeconds: number,
  report?: ReviewProgressReporter,
) {
  try {
    const mainWin = (Zotero.getMainWindows?.()[0] as any) || null;
    const openAI = (mainWin as any)?.Meet?.OpenAI;
    const embedDocuments = openAI?.embedDocuments;
    const embedQuery = openAI?.embedQuery;
    if (typeof embedDocuments !== "function" || typeof embedQuery !== "function") {
      return "";
    }

    const chunks = chunkTextForEmbedding(source.pdfText);
    if (chunks.length < 2) {
      return "";
    }
    report?.(62, "计算 PDF 分块向量");

    const query = buildPDFEmbeddingQuery(source);

    const embedTimeoutSeconds = Math.max(20, Math.min(45, timeoutSeconds));
    const docVectorsRaw = await withPromiseTimeout(
      Promise.resolve(embedDocuments.call(openAI, chunks)),
      embedTimeoutSeconds * 1000,
      new Error("PDF embedding documents timeout"),
    );
    report?.(65, "计算检索查询向量");
    const queryVectorRaw = await withPromiseTimeout(
      Promise.resolve(embedQuery.call(openAI, query)),
      embedTimeoutSeconds * 1000,
      new Error("PDF embedding query timeout"),
    );

    const queryVector = toNumericVector(queryVectorRaw);
    if (!queryVector.length) {
      return "";
    }

    const ranked = chunks
      .map((text, index) => {
        const vector = toNumericVector((docVectorsRaw as any)?.[index]);
        if (!vector.length) return null;
        return {
          index,
          text,
          score: cosineSimilarity(queryVector, vector),
        };
      })
      .filter(Boolean) as Array<{ index: number; text: string; score: number }>;

    if (!ranked.length) {
      return "";
    }
    report?.(67, "筛选相关 PDF 片段");

    const selected = ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, EMBEDDING_TOP_K)
      .sort((a, b) => a.index - b.index);

    return selected
      .map((chunk, i) => `[片段${i + 1}] ${truncateText(chunk.text, 1200)}`)
      .join("\n\n");
  } catch (e) {
    ztoolkit.log("PDF embedding enhancement skipped", e);
    return "";
  }
}

function buildPDFEmbeddingQuery(source: ReviewItemSource) {
  return [
    `请提取文献《${source.title || "未命名文献"}》中与研究背景、研究方法、研究结论、关键发现相关的段落。`,
    source.authors ? `作者：${source.authors}` : "",
    source.abstractText ? `摘要线索：${truncateText(source.abstractText, 600)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function chunkTextForEmbedding(text: string) {
  const normalized = normalizeAttachmentText(text);
  if (!normalized) return [] as string[];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const next = current.trim();
    if (next) chunks.push(next);
    current = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > EMBEDDING_CHUNK_CHARS * 1.5) {
      if (current) flush();
      for (let i = 0; i < paragraph.length; i += EMBEDDING_CHUNK_CHARS) {
        chunks.push(paragraph.slice(i, i + EMBEDDING_CHUNK_CHARS).trim());
        if (chunks.length >= EMBEDDING_MAX_CHUNKS) return chunks.filter(Boolean);
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > EMBEDDING_CHUNK_CHARS && current) {
      flush();
      current = paragraph;
    } else {
      current = candidate;
    }

    if (chunks.length >= EMBEDDING_MAX_CHUNKS) break;
  }
  if (current && chunks.length < EMBEDDING_MAX_CHUNKS) {
    flush();
  }

  return chunks.filter(Boolean).slice(0, EMBEDDING_MAX_CHUNKS);
}

function toNumericVector(value: unknown) {
  if (!Array.isArray(value)) return [] as number[];
  return value
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
}

function cosineSimilarity(a: number[], b: number[]) {
  const size = Math.min(a.length, b.length);
  if (!size) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < size; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (!normA || !normB) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function appendCappedSection(base: string, section: string, maxChars: number) {
  if (!section) return base;
  if (base.length + section.length <= maxChars) {
    return `${base}${section}`;
  }
  const allowed = Math.max(0, maxChars - base.length - 32);
  if (!allowed) return base;
  return `${base}${section.slice(0, allowed)}\n[Embedding片段已截断]`;
}

function normalizeDraft(
  item: Zotero.Item,
  rawText: string,
  context: {
    provider: string;
    model: string;
    source: ReviewItemSource;
  },
): LiteratureReviewDraft {
  const cleaned = stripCodeFence(rawText).trim();
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = {};
  }

  const keyFindings = coerceArray(
    parsed.keyFindings || parsed.key_findings || parsed.findings || [],
  );
  const classificationTags = coerceArray(
    parsed.classificationTags || parsed.classification_tags || context.source.zoteroTags,
  );

  const draft: LiteratureReviewDraft = {
    zoteroItemID: Number(item.id),
    title: pickString(parsed.title, context.source.title),
    authors: pickString(parsed.authors, context.source.authors),
    journal: pickString(parsed.journal, context.source.journal),
    publicationDate: pickString(
      parsed.publicationDate || parsed.publication_date,
      context.source.date,
    ),
    abstractText: pickString(parsed.abstract || parsed.abstractText, context.source.abstractText),
    pdfAnnotationNotesText: context.source.importPDFAnnotationsAsField
      ? String(context.source.pdfAnnotationText || "")
      : "",
    researchBackground: pickString(
      parsed.researchBackground || parsed.background,
      summarizeAbstract(context.source.abstractText, "研究背景信息不足，建议人工补充。"),
    ),
    literatureReview: pickString(
      parsed.literatureReview || parsed.review,
      "AI 未返回文献综述内容，请重试或手动补充。",
    ),
    researchMethods: pickString(
      parsed.researchMethods || parsed.methods,
      "AI 未识别研究方法，请结合原文确认。",
    ),
    researchConclusions: pickString(
      parsed.researchConclusions || parsed.conclusions,
      "AI 未识别研究结论，请结合原文确认。",
    ),
    keyFindings: keyFindings.length
      ? keyFindings
      : ["AI 未返回关键发现列表，请结合原文补充。"],
    classificationTags: classificationTags.length ? classificationTags : context.source.zoteroTags,
    aiProvider: context.provider,
    aiModel: context.model,
    rawAIResponse: cleaned,
  };

  return draft;
}

function buildPrompt(sourceContent: string, customPromptTemplate = "") {
  const template = String(customPromptTemplate || "").trim();
  if (!template) {
    return DEFAULT_REVIEW_PROMPT_TEMPLATE.replace(/\{\{sourceContent\}\}/g, sourceContent);
  }

  if (/\{\{source(Content|_content)\}\}/.test(template)) {
    return template
      .replace(/\{\{sourceContent\}\}/g, sourceContent)
      .replace(/\{\{source_content\}\}/g, sourceContent);
  }

  return [template, "", "文献信息如下：", sourceContent].join("\n");
}

function buildFolderSummaryPrompt(
  folderName: string,
  recordsContent: string,
  customPromptTemplate = "",
) {
  const template = String(customPromptTemplate || "").trim();
  if (!template) {
    return DEFAULT_FOLDER_SUMMARY_PROMPT_TEMPLATE
      .replace(/\{\{folderName\}\}/g, folderName)
      .replace(/\{\{recordsContent\}\}/g, recordsContent);
  }

  const hasFolderPlaceholder = /\{\{folderName\}\}/.test(template);
  const hasRecordsPlaceholder = /\{\{recordsContent\}\}/.test(template);
  let prompt = template
    .replace(/\{\{folderName\}\}/g, folderName)
    .replace(/\{\{recordsContent\}\}/g, recordsContent);

  if (!hasFolderPlaceholder || !hasRecordsPlaceholder) {
    prompt = [
      prompt,
      "",
      hasFolderPlaceholder ? "" : `文件夹名称：${folderName}`,
      hasRecordsPlaceholder ? "" : `记录内容如下：\n${recordsContent}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return prompt;
}

function buildFolderSummarySourceContent(
  folderName: string,
  rows: ReviewRecordRow[],
  report?: ReviewProgressReporter,
) {
  report?.(12, "整理记录内容");
  const parts: string[] = [];
  const sortedRows = [...rows].sort((a, b) => {
    const av = String(a.publicationDate || "");
    const bv = String(b.publicationDate || "");
    if (av < bv) return -1;
    if (av > bv) return 1;
    return (a.id || 0) - (b.id || 0);
  });

  for (let i = 0; i < sortedRows.length; i += 1) {
    const row = sortedRows[i];
    if (parts.join("\n\n").length > MAX_FOLDER_SUMMARY_SOURCE_CHARS) break;
    const pdfAnnotationSummaryText = truncateTextWithNotice(
      String(row.pdfAnnotationNotesText || ""),
      1400,
      "PDF批注与批注下笔记已截断",
    );
    const block = [
      `【记录${i + 1}】`,
      `标题: ${row.title || "(无标题)"}`,
      `作者: ${row.authors || ""}`,
      `期刊: ${row.journal || ""}`,
      `发表时间: ${row.publicationDate || ""}`,
      `分类标签: ${(row.classificationTags || []).join(", ")}`,
      ...(pdfAnnotationSummaryText
        ? ["PDF批注与批注下笔记:", pdfAnnotationSummaryText]
        : []),
      "研究背景:",
      truncateText(String(row.researchBackground || ""), 1200),
      "文献综述:",
      truncateText(String(row.literatureReview || ""), 1600),
      "研究方法:",
      truncateText(String(row.researchMethods || ""), 1000),
      "研究结论:",
      truncateText(String(row.researchConclusions || ""), 1200),
      "关键发现:",
      (row.keyFindings || []).slice(0, 10).map((v, idx) => `${idx + 1}. ${v}`).join("\n"),
    ]
      .map((v) => String(v ?? "").trimEnd())
      .filter((v) => v.length > 0)
      .join("\n");
    parts.push(block);
  }

  let content = [
    `文件夹：${folderName}`,
    `记录数量：${rows.length}`,
    "",
    parts.join("\n\n"),
  ].join("\n");

  if (content.length > MAX_FOLDER_SUMMARY_SOURCE_CHARS) {
    content = `${content.slice(0, MAX_FOLDER_SUMMARY_SOURCE_CHARS)}\n\n[记录内容已截断以控制输入长度]`;
  }
  report?.(24, "完成记录内容整理");
  return content;
}

function buildOpenAIChatEndpoint(api: string) {
  const base = (api || "https://api.openai.com").trim().replace(/\/$/, "");
  if (base.endsWith("/v1/chat/completions")) return base;
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function buildOpenAIEmbeddingsEndpoint(api: string) {
  const base = (api || "https://api.openai.com").trim().replace(/\/$/, "");
  if (base.endsWith("/v1/embeddings")) return base;
  if (base.endsWith("/embeddings")) return base;
  if (base.endsWith("/v1")) return `${base}/embeddings`;
  return `${base}/v1/embeddings`;
}

function buildGeminiEndpoint(apiBaseURL: string, model: string, apiKey: string) {
  const trimmed = (apiBaseURL || "").trim();
  if (trimmed) {
    if (trimmed.includes(":generateContent")) {
      return trimmed.includes("?") ? trimmed : `${trimmed}?key=${encodeURIComponent(apiKey)}`;
    }
    const base = trimmed.replace(/\/$/, "");
    return `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  }
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutSeconds: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new ReviewUserError("AI request timeout", `AI 请求超时（>${timeoutSeconds}秒），请重试`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function stripCodeFence(text: string) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

function pickString(input: unknown, fallback = "") {
  const value = String(input ?? "").trim();
  return value || String(fallback || "");
}

function coerceArray(input: unknown) {
  if (Array.isArray(input)) {
    return input.map((v) => String(v).trim()).filter(Boolean).slice(0, 20);
  }
  if (typeof input === "string") {
    return input
      .split(/[\n;,，；]/)
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  return [];
}

function humanizeAIError(message: string) {
  const msg = message.toLowerCase();
  if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("api key")) {
    return "请检查AI模型配置：API Key 无效或未授权";
  }
  if (msg.includes("429") || msg.includes("rate")) {
    return "AI 服务限流，请稍后重试";
  }
  if (msg.includes("network") || msg.includes("fetch")) {
    return "网络异常，请检查网络连接";
  }
  return "提炼失败，请重试（可检查模型配置和网络）";
}

function safeField(item: Zotero.Item, field: string) {
  try {
    return String(item.getField(field as any) || "").trim();
  } catch {
    return "";
  }
}

function joinCreators(item: Zotero.Item) {
  try {
    const creators = item.getCreators() || [];
    return creators
      .map((creator: any) => {
        if (creator.name) return String(creator.name);
        return [creator.lastName, creator.firstName].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join(", ");
  } catch {
    return String((item as any).firstCreator || "");
  }
}

function getItemTags(item: Zotero.Item) {
  try {
    const tags = (item.getTags() || []) as any[];
    return tags.map((t) => String(t?.tag || "").trim()).filter(Boolean);
  } catch {
    return [] as string[];
  }
}

function getNoteText(item: Zotero.Item) {
  try {
    const noteIDs = (item.getNotes?.() || []).slice(0, 3) as number[];
    const notes = noteIDs
      .map((id) => (Zotero.Items as any).get(id))
      .filter(Boolean)
      .map((note: any) => htmlNoteToPlainText(String(note.getNote?.() || "")))
      .filter(Boolean);
    return notes.join("\n").slice(0, MAX_NOTE_TEXT_CHARS);
  } catch {
    return "";
  }
}

async function getPDFAnnotationSource(
  item: Zotero.Item,
  settings: ReviewSettings,
  report?: ReviewProgressReporter,
): Promise<{ text: string; label: string }> {
  try {
    const attachments = await getCandidateAttachments(item);
    for (const attachment of attachments) {
      if (!isPDFAttachmentItem(attachment)) continue;

      report?.(24, "读取 PDF 批注内容");
      const annotations = getAttachmentAnnotations(attachment);
      if (!annotations.length) continue;

      const lines: string[] = [];
      let included = 0;
      for (const annotation of annotations) {
        if (included >= MAX_PDF_ANNOTATION_COUNT) break;
        const block = buildAnnotationBlock(annotation, included + 1);
        if (!block) continue;
        lines.push(block);
        included += 1;
      }
      if (!lines.length) continue;

      const joined = lines.join("\n\n");
      const truncationEnabled = Boolean(settings.enablePDFInputTruncation);
      const annotationMaxChars = Math.max(
        1,
        Number(settings.pdfAnnotationTextMaxChars) || MAX_PDF_ANNOTATION_TEXT_CHARS,
      );
      return {
        text: truncationEnabled
          ? truncateTextWithNotice(
              joined,
              annotationMaxChars,
              `PDF批注内容已截断，超过 ${annotationMaxChars} 字符`,
            )
          : joined,
        label: buildAttachmentLabel(attachment),
      };
    }
  } catch (e) {
    ztoolkit.log("Failed to read PDF annotations", e);
  }

  return { text: "", label: "" };
}

async function getPDFTextSource(
  item: Zotero.Item,
  settings: ReviewSettings,
  report?: ReviewProgressReporter,
) {
  const attachments = await getCandidateAttachments(item);
  for (const attachment of attachments) {
    if (!isPDFAttachmentItem(attachment)) continue;

    let text = await readAttachmentText(attachment);
    if (!text) {
      report?.(25, "建立 PDF 全文索引");
      await tryIndexAttachmentText(attachment);
      text = await readAttachmentText(attachment);
    }
    const normalized = normalizeAttachmentText(text);
    if (!normalized) continue;

    report?.(28, "提取 PDF 文本");
    const truncationEnabled = Boolean(settings.enablePDFInputTruncation);
    const pdfTextMaxChars = Math.max(
      1,
      Number(settings.pdfTextMaxChars) || MAX_PDF_TEXT_CHARS,
    );
    return {
      text: truncationEnabled ? truncateText(normalized, pdfTextMaxChars) : normalized,
      label: buildAttachmentLabel(attachment),
    };
  }

  return { text: "", label: "" };
}

function isPDFAttachmentItem(attachment: Zotero.Item) {
  const mimeType = String((attachment as any)?.attachmentContentType || "").toLowerCase();
  return (
    (typeof (attachment as any)?.isPDFAttachment === "function" &&
      Boolean((attachment as any).isPDFAttachment())) ||
    mimeType.includes("pdf")
  );
}

function getAttachmentAnnotations(attachment: Zotero.Item): any[] {
  try {
    const raw = (attachment as any)?.getAnnotations?.();
    const normalized = Array.isArray(raw) ? raw : [];
    return normalized
      .map((entry) => {
        if (!entry) return null;
        if (typeof entry === "number") {
          return (Zotero.Items as any)?.get?.(entry) || null;
        }
        return entry;
      })
      .filter(Boolean)
      .sort(compareAnnotations);
  } catch {
    return [];
  }
}

function compareAnnotations(a: any, b: any) {
  const pageA = getAnnotationPageNumber(a);
  const pageB = getAnnotationPageNumber(b);
  if (pageA !== pageB) return pageA - pageB;
  const sortA = String(a?.annotationSortIndex || "");
  const sortB = String(b?.annotationSortIndex || "");
  if (sortA < sortB) return -1;
  if (sortA > sortB) return 1;
  return Number(a?.id || 0) - Number(b?.id || 0);
}

function buildAnnotationBlock(annotation: any, index: number) {
  const text = normalizeAnnotationField(annotation?.annotationText);
  const comment = normalizeAnnotationField(annotation?.annotationComment);
  const childNotes = getAnnotationChildNoteText(annotation);
  if (!text && !comment && !childNotes) {
    return "";
  }

  const pageLabel = getAnnotationPageLabel(annotation);
  const typeLabel = mapAnnotationTypeLabel(annotation?.annotationType);
  const lines = [`${index}. [${pageLabel}]${typeLabel ? `[${typeLabel}]` : ""}`];
  if (text) lines.push(`摘录: ${text}`);
  if (comment) lines.push(`批注: ${comment}`);
  if (childNotes) lines.push(`批注下笔记: ${childNotes}`);
  return lines.join("\n");
}

function normalizeAnnotationField(value: unknown) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getAnnotationChildNoteText(annotation: any) {
  try {
    const noteIDs = (annotation?.getNotes?.() || []) as number[];
    const texts = noteIDs
      .map((id) => (Zotero.Items as any)?.get?.(id))
      .filter(Boolean)
      .map((note: any) => htmlNoteToPlainText(String(note?.getNote?.() || "")))
      .filter(Boolean)
      .slice(0, 5);
    return texts.join(" | ");
  } catch {
    return "";
  }
}

function htmlNoteToPlainText(html: string) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function getAnnotationPageLabel(annotation: any) {
  const label = String(annotation?.annotationPageLabel || "").trim();
  if (label) return `第${label}页`;
  const pageNum = getAnnotationPageNumber(annotation);
  if (Number.isFinite(pageNum) && pageNum > 0) return `第${pageNum}页`;
  return "页码未知";
}

function getAnnotationPageNumber(annotation: any) {
  try {
    const pageLabel = String(annotation?.annotationPageLabel || "").trim();
    const numFromLabel = Number(pageLabel);
    if (Number.isFinite(numFromLabel) && numFromLabel > 0) return numFromLabel;
  } catch {
    // ignore
  }
  try {
    const pos = JSON.parse(String(annotation?.annotationPosition || "{}"));
    const pageIndex = Number(pos?.pageIndex);
    if (Number.isFinite(pageIndex) && pageIndex >= 0) return pageIndex + 1;
  } catch {
    // ignore
  }
  return Number.MAX_SAFE_INTEGER;
}

function mapAnnotationTypeLabel(type: unknown) {
  const value = String(type || "").toLowerCase();
  switch (value) {
    case "highlight":
      return "高亮";
    case "underline":
      return "下划线";
    case "note":
      return "便签";
    case "image":
      return "图片区域";
    case "ink":
      return "手写";
    case "text":
      return "文本";
    default:
      return value ? value : "";
  }
}

async function getCandidateAttachments(item: Zotero.Item): Promise<Zotero.Item[]> {
  const result: Zotero.Item[] = [];
  const seen = new Set<number>();
  const push = (attachment: Zotero.Item | false | null | undefined) => {
    if (!attachment) return;
    const id = Number(attachment.id || 0);
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push(attachment);
  };

  try {
    if ((item as any)?.isAttachment?.()) {
      push(item);
      return result;
    }
  } catch {
    // ignore
  }

  try {
    push(await item.getBestAttachment());
  } catch {
    // ignore
  }

  try {
    const bestAttachments = await item.getBestAttachments();
    for (const attachment of bestAttachments || []) {
      push(attachment);
    }
  } catch {
    // ignore
  }

  try {
    const attachmentIDs = (item.getAttachments?.() || []) as number[];
    for (const attachmentID of attachmentIDs) {
      push((Zotero.Items as any)?.get?.(attachmentID) as Zotero.Item | undefined);
    }
  } catch {
    // ignore
  }

  return result;
}

async function readAttachmentText(attachment: Zotero.Item) {
  try {
    return String((await (attachment as any).attachmentText) || "");
  } catch {
    return "";
  }
}

async function tryIndexAttachmentText(attachment: Zotero.Item) {
  try {
    const fullText = (Zotero as any).FullText || (Zotero as any).Fulltext;
    if (!fullText?.indexItems) return;
    await fullText.indexItems([Number(attachment.id)], {
      complete: false,
      ignoreErrors: true,
    });
  } catch {
    // ignore
  }
}

function normalizeAttachmentText(text: string) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildAttachmentLabel(attachment: Zotero.Item) {
  const title =
    safeField(attachment, "title") ||
    (typeof (attachment as any)?.getDisplayTitle === "function"
      ? String((attachment as any).getDisplayTitle() || "")
      : "");
  return title || `附件 ${String(attachment.id || "")}`.trim();
}

function truncateText(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[PDF原文已截断，超过 ${max} 字符]`;
}

function truncateTextWithNotice(text: string, max: number, notice: string) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[${notice}]`;
}

function summarizeAbstract(abstractText: string, fallback: string) {
  const text = String(abstractText || "").trim();
  if (!text) return fallback;
  return text.slice(0, 300);
}

async function withPromiseTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
