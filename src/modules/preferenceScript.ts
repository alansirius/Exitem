import { config } from "../../package.json";
import {
  getDefaultFolderSummaryPromptTemplate,
  getDefaultReviewPromptTemplate,
} from "./reviewAI";
import {
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
  const detectionStatus = getEl<HTMLElement>(doc, id("awesome-status"));
  const detectionDetail = getEl<HTMLElement>(doc, id("awesome-detail"));
  const refreshBtn = getEl<HTMLButtonElement>(doc, id("refresh-detection-btn"));
  const saveBtn = getEl<HTMLButtonElement>(doc, id("save-btn"));
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
  renderZoteroGPTBridgeStatus(detectionStatus, detectionDetail);
  syncPDFTruncationConfigState(
    enablePDFInputTruncationInput,
    pdfTruncationConfig,
  );

  refreshBtn.onclick = () => {
    renderZoteroGPTBridgeStatus(detectionStatus, detectionDetail);
  };

  enablePDFInputTruncationInput.onchange = () => {
    syncPDFTruncationConfigState(
      enablePDFInputTruncationInput,
      pdfTruncationConfig,
    );
  };

  saveBtn.onclick = () => {
    try {
      saveReviewSettings({
        modelConfigMode: "custom",
        apiConfigMode: "zoterogpt",
        provider: "openai",
        timeoutSeconds: 600,
        dailyLimit: settings.dailyLimit,
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
      win.alert("AI模型配置已保存");
    } catch (e: any) {
      win.alert(`保存失败：${e?.message || e}`);
    }
  };
}

function renderZoteroGPTBridgeStatus(
  statusEl: HTMLElement,
  detailEl: HTMLElement,
) {
  const snapshot = getZoteroGPTPrefsSnapshot();
  if (snapshot) {
    statusEl.textContent = "已连接 Zotero GPT 配置";
    statusEl.style.color = "#047857";
    detailEl.textContent = "桥接可用";
    return;
  }

  statusEl.textContent = "未检测到 Zotero GPT 配置";
  statusEl.style.color = "#b45309";
  detailEl.textContent = "桥接不可用，请先在 Zotero GPT 插件完成配置。";
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
