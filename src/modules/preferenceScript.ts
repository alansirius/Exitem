import { config } from "../../package.json";
import {
  getDefaultFolderSummaryPromptTemplate,
  getDefaultReviewPromptTemplate,
} from "./reviewAI";
import {
  detectAwesomeGPT,
  detectAwesomeGPTAsync,
  getZoteroGPTPrefsSnapshot,
  getReviewSettings,
  saveReviewSettings,
} from "./reviewConfig";

export async function registerPrefsScripts(_window: Window) {
  addon.data.prefs = { window: _window };
  initPrefsUI(_window);
}

function initPrefsUI(win: Window) {
  const doc = win.document;
  const settings = getReviewSettings();
  const detection = detectAwesomeGPT();

  const modeSelect = getEl<HTMLSelectElement>(doc, id("model-mode"));
  const providerSelect = getEl<HTMLSelectElement>(doc, id("provider"));
  const apiInput = getEl<HTMLInputElement>(doc, id("api"));
  const secretKeyInput = getEl<HTMLInputElement>(doc, id("secret-key"));
  const modelInput = getEl<HTMLInputElement>(doc, id("model"));
  const temperatureInput = getEl<HTMLInputElement>(doc, id("temperature"));
  const embeddingModelInput = getEl<HTMLInputElement>(
    doc,
    id("embedding-model"),
  );
  const embeddingBatchNumInput = getEl<HTMLInputElement>(
    doc,
    id("embedding-batch-num"),
  );
  const timeoutInput = getEl<HTMLInputElement>(doc, id("timeout"));
  const dailyLimitInput = getEl<HTMLInputElement>(doc, id("daily-limit"));
  const usePDFAsInputSourceInput = getEl<HTMLInputElement>(
    doc,
    id("use-pdf-as-input-source"),
  );
  const usePDFAnnotationsAsContextInput = getEl<HTMLInputElement>(
    doc,
    id("use-pdf-annotations-as-context"),
  );
  const importPDFAnnotationsAsFieldInput = getEl<HTMLInputElement>(
    doc,
    id("import-pdf-annotations-as-field"),
  );
  const enablePDFInputTruncationInput = getEl<HTMLInputElement>(
    doc,
    id("enable-pdf-input-truncation"),
  );
  const pdfTextMaxCharsInput = getEl<HTMLInputElement>(
    doc,
    id("pdf-text-max-chars"),
  );
  const pdfAnnotationTextMaxCharsInput = getEl<HTMLInputElement>(
    doc,
    id("pdf-annotation-text-max-chars"),
  );
  const pdfTruncationConfig = getEl<HTMLElement>(
    doc,
    id("pdf-truncation-config"),
  );
  const customPromptInput = getEl<HTMLTextAreaElement>(
    doc,
    id("custom-prompt"),
  );
  const defaultPromptView = getEl<HTMLTextAreaElement>(
    doc,
    id("default-prompt"),
  );
  const customFolderSummaryPromptInput = getEl<HTMLTextAreaElement>(
    doc,
    id("custom-folder-summary-prompt"),
  );
  const defaultFolderSummaryPromptView = getEl<HTMLTextAreaElement>(
    doc,
    id("default-folder-summary-prompt"),
  );
  const apiConfigModeHint = getEl<HTMLElement>(doc, id("api-config-mode-hint"));
  const detectionStatus = getEl<HTMLElement>(doc, id("awesome-status"));
  const detectionDetail = getEl<HTMLElement>(doc, id("awesome-detail"));
  const saveBtn = getEl<HTMLButtonElement>(doc, id("save-btn"));
  const refreshBtn = getEl<HTMLButtonElement>(doc, id("refresh-detection-btn"));
  const secretKeyToggleBtn = getEl<HTMLButtonElement>(
    doc,
    id("toggle-secret-key-btn"),
  );
  const customFieldset = getEl<HTMLElement>(doc, id("custom-config-fieldset"));
  const apiParamFields = getEl<HTMLElement>(doc, id("api-param-fields"));

  modeSelect.value = settings.modelConfigMode;
  providerSelect.value = settings.provider;
  apiInput.value = settings.api;
  secretKeyInput.value = settings.secretKey;
  modelInput.value = settings.model;
  temperatureInput.value = String(settings.temperature);
  embeddingModelInput.value = settings.embeddingModel;
  embeddingBatchNumInput.value = String(settings.embeddingBatchNum);
  timeoutInput.value = String(settings.timeoutSeconds);
  dailyLimitInput.value = String(settings.dailyLimit);
  usePDFAsInputSourceInput.checked = Boolean(settings.usePDFAsInputSource);
  usePDFAnnotationsAsContextInput.checked = Boolean(
    settings.usePDFAnnotationsAsContext,
  );
  importPDFAnnotationsAsFieldInput.checked = Boolean(
    settings.importPDFAnnotationsAsField,
  );
  enablePDFInputTruncationInput.checked = Boolean(
    settings.enablePDFInputTruncation,
  );
  pdfTextMaxCharsInput.value = String(settings.pdfTextMaxChars);
  pdfAnnotationTextMaxCharsInput.value = String(
    settings.pdfAnnotationTextMaxChars,
  );
  customPromptInput.value = settings.customPromptTemplate;
  defaultPromptView.value = getDefaultReviewPromptTemplate();
  customFolderSummaryPromptInput.value =
    settings.customFolderSummaryPromptTemplate;
  defaultFolderSummaryPromptView.value =
    getDefaultFolderSummaryPromptTemplate();
  syncPDFTruncationConfigState(
    enablePDFInputTruncationInput,
    pdfTruncationConfig,
  );

  renderAwesomeStatus(detectionStatus, detectionDetail, detection);
  void refreshAwesomeDetectionStatus(detectionStatus, detectionDetail);
  syncConfigSectionState(
    modeSelect,
    customFieldset,
    apiParamFields,
    apiConfigModeHint,
  );

  modeSelect.onchange = () => {
    syncConfigSectionState(
      modeSelect,
      customFieldset,
      apiParamFields,
      apiConfigModeHint,
    );
  };

  secretKeyToggleBtn.onclick = () => {
    secretKeyInput.type =
      secretKeyInput.type === "password" ? "text" : "password";
    secretKeyToggleBtn.textContent =
      secretKeyInput.type === "password" ? "显示" : "隐藏";
  };

  refreshBtn.onclick = () => {
    void refreshAwesomeDetectionStatus(detectionStatus, detectionDetail);
    syncConfigSectionState(
      modeSelect,
      customFieldset,
      apiParamFields,
      apiConfigModeHint,
    );
  };

  enablePDFInputTruncationInput.onchange = () => {
    syncPDFTruncationConfigState(
      enablePDFInputTruncationInput,
      pdfTruncationConfig,
    );
  };

  saveBtn.onclick = () => {
    try {
      const next = saveReviewSettings({
        modelConfigMode:
          modeSelect.value === "awesomegpt" ? "awesomegpt" : "custom",
        apiConfigMode: getZoteroGPTPrefsSnapshot() ? "zoterogpt" : "custom",
        provider: providerSelect.value === "gemini" ? "gemini" : "openai",
        api: apiInput.value.trim(),
        secretKey: secretKeyInput.value.trim(),
        model: modelInput.value.trim(),
        temperature: clampNumber(
          Number(temperatureInput.value),
          settings.temperature,
          0,
          2,
        ),
        embeddingModel: embeddingModelInput.value.trim(),
        embeddingBatchNum: Math.max(
          1,
          Math.floor(
            Number(embeddingBatchNumInput.value) ||
              settings.embeddingBatchNum ||
              10,
          ),
        ),
        timeoutSeconds: 600,
        dailyLimit: Math.max(1, Number(dailyLimitInput.value) || 100),
        usePDFAsInputSource: usePDFAsInputSourceInput.checked,
        usePDFAnnotationsAsContext: usePDFAnnotationsAsContextInput.checked,
        importPDFAnnotationsAsField: importPDFAnnotationsAsFieldInput.checked,
        enablePDFInputTruncation: enablePDFInputTruncationInput.checked,
        pdfTextMaxChars: Math.max(
          1,
          Math.floor(
            Number(pdfTextMaxCharsInput.value) ||
              settings.pdfTextMaxChars ||
              20_000,
          ),
        ),
        pdfAnnotationTextMaxChars: Math.max(
          1,
          Math.floor(
            Number(pdfAnnotationTextMaxCharsInput.value) ||
              settings.pdfAnnotationTextMaxChars ||
              12_000,
          ),
        ),
        customPromptTemplate: customPromptInput.value.trim(),
        customFolderSummaryPromptTemplate:
          customFolderSummaryPromptInput.value.trim(),
      });
      syncConfigSectionState(
        modeSelect,
        customFieldset,
        apiParamFields,
        apiConfigModeHint,
      );
      win.alert("AI模型配置已保存");
    } catch (e: any) {
      win.alert(`保存失败：${e?.message || e}`);
    }
  };
}

function renderAwesomeStatus(
  statusEl: HTMLElement,
  detailEl: HTMLElement,
  detection: ReturnType<typeof detectAwesomeGPT>,
) {
  const pluginName = detection.addonName || "GPT 插件";
  if (detection.callable) {
    statusEl.textContent = `已连接 ${pluginName}`;
    statusEl.style.color = "#047857";
    detailEl.textContent = `${pluginName} 可直接使用`;
    return;
  }

  if (detection.installed) {
    statusEl.textContent = `已检测到 ${pluginName}（暂不可直连）`;
    statusEl.style.color = "#b45309";
    detailEl.textContent =
      detection.obstacle || "已检测到插件，但当前无法直接调用。";
    return;
  }

  statusEl.textContent = "未检测到兼容 GPT 插件";
  statusEl.style.color = "#6b7280";
  detailEl.textContent = "未检测到兼容插件，可直接使用本插件 API 配置。";
}

function toggleCustomFields(container: HTMLElement, enabled: boolean) {
  container.style.opacity = enabled ? "1" : "0.55";
  const inputs = container.querySelectorAll("input, select, textarea");
  inputs.forEach((el: Element) => {
    (
      el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    ).disabled = !enabled;
  });
}

function syncConfigSectionState(
  modelModeSelect: HTMLSelectElement,
  customFieldset: HTMLElement,
  apiParamFields: HTMLElement,
  hintEl: HTMLElement,
) {
  const usingExitemAPI = modelModeSelect.value === "custom";
  const hasZoteroGPTConfig = Boolean(getZoteroGPTPrefsSnapshot());
  toggleCustomFields(customFieldset, usingExitemAPI);
  // 接口来源自动判断：有 Zotero GPT 配置则优先跟随，否则使用 Exitem 本地配置。
  toggleCustomFields(apiParamFields, usingExitemAPI);
  renderAPIConfigModeHint(hintEl, usingExitemAPI, hasZoteroGPTConfig);
}

function renderAPIConfigModeHint(
  hintEl: HTMLElement,
  usingExitemAPI: boolean,
  hasZoteroGPTConfig: boolean,
) {
  if (!usingExitemAPI) {
    hintEl.textContent =
      "当前使用兼容 GPT 插件直接提炼，本区接口参数暂不生效。";
    return;
  }

  if (!hasZoteroGPTConfig) {
    hintEl.textContent =
      "未检测到可用的 Zotero GPT 配置，当前自动使用 Exitem 本地配置。字段命名与 Zotero GPT 保持一致（api / secretKey / model / temperature / embeddingModel / embeddingBatchNum）。";
    return;
  }

  const snapshot = getZoteroGPTPrefsSnapshot();
  if (!snapshot) {
    hintEl.textContent =
      "当前自动优先使用 Zotero GPT 配置；未读取到配置时会回退到 Exitem 本地配置。";
    return;
  }

  const maskedKey = snapshot.secretKey
    ? `${snapshot.secretKey.slice(0, 4)}...${snapshot.secretKey.slice(-4)}`
    : "未设置";
  hintEl.textContent = `当前自动使用 Zotero GPT 配置（未检测到时回退 Exitem 本地配置）：api=${snapshot.api}，model=${snapshot.model}，embeddingModel=${snapshot.embeddingModel}，embeddingBatchNum=${snapshot.embeddingBatchNum}，secretKey=${maskedKey}`;
}

function clampNumber(
  value: number,
  fallback: number,
  min: number,
  max: number,
) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function syncPDFTruncationConfigState(
  enabledInput: HTMLInputElement,
  configEl: HTMLElement,
) {
  toggleCustomFields(configEl, enabledInput.checked);
}

function id(suffix: string) {
  return `zotero-prefpane-${config.addonRef}-${suffix}`;
}

function getEl<T extends Element>(doc: Document, selector: string) {
  const el = doc.getElementById(selector);
  if (!el) {
    throw new Error(`Preference element not found: ${selector}`);
  }
  return el as T;
}

async function refreshAwesomeDetectionStatus(
  statusEl: HTMLElement,
  detailEl: HTMLElement,
) {
  statusEl.textContent = "正在检查兼容 GPT 插件...";
  statusEl.style.color = "#1d4ed8";
  detailEl.textContent = "正在检查插件状态，请稍候。";
  try {
    const next = await detectAwesomeGPTAsync();
    renderAwesomeStatus(statusEl, detailEl, next);
  } catch (e: any) {
    statusEl.textContent = "检测失败";
    statusEl.style.color = "#b91c1c";
    detailEl.textContent = `无法完成插件检测：${String(e?.message || e)}`;
  }
}
