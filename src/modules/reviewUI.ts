import { config } from "../../package.json";
import { extractLiteratureReview, getReviewErrorMessage } from "./reviewAI";
import type { ReviewExtractionProgress } from "./reviewAI";
import { getReviewSettings } from "./reviewConfig";
import {
  closeReviewManagerWindow,
  openReviewManagerWindow,
} from "./reviewManager";
import {
  createReviewFolder,
  ensureDefaultReviewFolder,
  getReviewRecordByItemID,
  getTodayAIExtractionCount,
  initReviewStore,
  listReviewFolders,
  trackReviewEvent,
  upsertReviewRecord,
} from "./reviewStore";
import { LiteratureReviewDraft, ReviewFolderRow } from "./reviewTypes";

const reviewContextMenuID = `${config.addonRef}-itemmenu-ai-extract-review`;
const boundItemMenuPopups = new WeakSet<EventTarget>();

export async function initializeReviewFeature() {
  await initReviewStore();
  registerReviewContextMenu();
}

export function registerReviewContextMenu(
  win?: _ZoteroTypes.MainWindow | Window,
) {
  if (win) {
    ensureReviewContextMenuInWindow(win);
    return;
  }

  const wins = (Zotero.getMainWindows?.() ||
    []) as Array<_ZoteroTypes.MainWindow>;
  let insertedAny = false;
  for (const mainWin of wins) {
    insertedAny = ensureReviewContextMenuInWindow(mainWin) || insertedAny;
  }

  if (insertedAny) return;

  const registered = ztoolkit.Menu.register(
    "item",
    buildReviewContextMenuOptions(),
  );
  if (registered === false) {
    ztoolkit.log(
      "Review context menu registration skipped: item popup not found",
    );
  }
}

export function registerReviewToolbarButton(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  const id = `${config.addonRef}-review-manager-button`;
  if (doc.getElementById(id)) return;

  const target = findToolbarContainer(doc);
  if (!target) {
    ztoolkit.log("Review toolbar container not found; skipping toolbar button");
    return;
  }

  let button: HTMLElement | XULElement;
  const isXUL =
    target.namespaceURI && !String(target.namespaceURI).includes("xhtml");
  if (isXUL && (doc as any).createXULElement) {
    button = (doc as any).createXULElement("toolbarbutton");
    button.setAttribute("id", id);
    button.setAttribute("label", "文献综述");
    button.setAttribute(
      "image",
      `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
    );
    button.setAttribute("tooltiptext", "打开文献综述管理");
    button.setAttribute("class", "zotero-tb-button");
    button.addEventListener("command", () => {
      void openReviewManagerWindow(win);
    });
  } else {
    const htmlButton = doc.createElement("button");
    htmlButton.id = id;
    htmlButton.type = "button";
    htmlButton.textContent = "文献综述";
    Object.assign(htmlButton.style, {
      marginLeft: "6px",
      padding: "4px 10px",
      border: "1px solid #cbd5e1",
      borderRadius: "4px",
      background: "#ffffff",
      cursor: "pointer",
      fontSize: "12px",
    });
    htmlButton.addEventListener("click", () => {
      void openReviewManagerWindow(win);
    });
    button = htmlButton;
  }

  target.appendChild(button);
}

export function unregisterReviewToolbarButton(win: Window) {
  try {
    win.document
      ?.getElementById(`${config.addonRef}-review-manager-button`)
      ?.remove();
  } catch {
    // ignore
  }
}

export function cleanupReviewFeatureUI() {
  try {
    if (addon?.data?.dialogs?.reviewResult) {
      addon.data.dialogs.reviewResult.window?.close();
      delete addon.data.dialogs.reviewResult;
    }
  } catch {
    // ignore
  }
  closeReviewManagerWindow();
}

export async function handleExtractFromSelection() {
  const items = getSelectedRegularItems();
  if (!items.length) {
    showToast("请先选中至少一篇文献条目", "warning");
    return;
  }
  if (items.length > 5) {
    showToast("单次提炼文献数量不超过5篇，请减少选择数量", "warning");
    return;
  }

  await initReviewStore();
  const settings = getReviewSettings();
  const todayCount = await getTodayAIExtractionCount().catch((e) => {
    ztoolkit.log(e);
    return 0;
  });
  if (todayCount >= settings.dailyLimit) {
    showAlert(
      `今日 AI 提炼调用已达到上限（${settings.dailyLimit} 次）。请明天再试或在设置中调整上限。`,
    );
    return;
  }
  if (todayCount + items.length > settings.dailyLimit) {
    showAlert(
      `当前选择 ${items.length} 篇会超过今日上限（已使用 ${todayCount}/${settings.dailyLimit}）。请减少选择数量。`,
    );
    return;
  }
  await trackReviewEvent("ai_extraction_click", {
    timestamp: new Date().toISOString(),
    article_count: items.length,
  }).catch((e) => ztoolkit.log(e));

  const progress = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: "正在提炼文献内容...",
      type: "default",
      progress: 0,
    })
    .show();

  if (items.length === 1) {
    const item = items[0];
    try {
      progress.changeLine({
        text: `正在提炼: ${truncate(item.getDisplayTitle(), 40)}`,
        progress: 0,
      });
      const onProgress = createSingleExtractionProgressUpdater(progress, item);
      const draft = await extractLiteratureReview(item, { onProgress });
      progress.changeLine({
        text: "提炼完成，正在打开结果编辑窗口...",
        progress: 98,
      });
      await trackReviewEvent("ai_extraction_success", {
        timestamp: new Date().toISOString(),
        article_id: item.id,
        model_type: `${draft.aiProvider}:${draft.aiModel}`,
      }).catch((e) => ztoolkit.log(e));
      progress.changeLine({ text: "提炼成功", type: "success", progress: 100 });
      progress.startCloseTimer(1500);
      await openReviewResultDialog(draft);
    } catch (e) {
      const message = getReviewErrorMessage(e);
      await trackReviewEvent("ai_extraction_fail", {
        timestamp: new Date().toISOString(),
        article_id: item.id,
        fail_reason: message,
      }).catch((err) => ztoolkit.log(err));
      progress.changeLine({
        text: `提炼失败: ${message}`,
        type: "error",
        progress: 100,
      });
      progress.startCloseTimer(5000);
      showAlert(message);
    }
    return;
  }

  const results: Array<{
    itemID: number;
    title: string;
    ok: boolean;
    error?: string;
  }> = [];
  const batchTargetFolder = await resolveBatchSaveFolder();
  let completed = 0;

  progress.changeLine({
    text: `批量提炼将保存到：${batchTargetFolder.name}`,
    progress: 0,
  });

  for (const item of items) {
    completed += 1;
    const rangeStart = Math.floor(((completed - 1) / items.length) * 100);
    const progressValue = rangeStart;
    progress.changeLine({
      text: `(${completed}/${items.length}) 正在提炼: ${truncate(item.getDisplayTitle(), 34)}`,
      progress: progressValue,
    });

    try {
      const onProgress = createBatchExtractionProgressUpdater(progress, {
        item,
        index: completed,
        total: items.length,
      });
      const draft = await extractLiteratureReview(item, { onProgress });
      await upsertReviewRecord(draft, { folderID: batchTargetFolder.id });
      await trackReviewEvent("ai_extraction_success", {
        timestamp: new Date().toISOString(),
        article_id: item.id,
        model_type: `${draft.aiProvider}:${draft.aiModel}`,
      }).catch((e) => ztoolkit.log(e));
      results.push({ itemID: Number(item.id), title: draft.title, ok: true });
    } catch (e) {
      const msg = getReviewErrorMessage(e);
      await trackReviewEvent("ai_extraction_fail", {
        timestamp: new Date().toISOString(),
        article_id: item.id,
        fail_reason: msg,
      }).catch((err) => ztoolkit.log(err));
      results.push({
        itemID: Number(item.id),
        title: item.getDisplayTitle(),
        ok: false,
        error: msg,
      });
    }
  }

  const successCount = results.filter((r) => r.ok).length;
  const failCount = results.length - successCount;
  progress.changeLine({
    text: `批量提炼完成：成功 ${successCount}，失败 ${failCount}`,
    type: failCount ? "default" : "success",
    progress: 100,
  });
  progress.startCloseTimer(4000);

  showAlert(
    [
      `批量提炼完成：成功 ${successCount} 篇，失败 ${failCount} 篇。`,
      successCount ? `成功结果已保存到文件夹：${batchTargetFolder.name}` : "",
      failCount
        ? "失败明细：\n" +
          results
            .filter((r) => !r.ok)
            .map((r) => `- ${truncate(r.title, 40)}: ${r.error}`)
            .join("\n")
        : "结果已保存，已为你打开文献综述页面。",
    ].join("\n\n"),
  );

  if (successCount > 0) {
    await openReviewManagerWindow();
  }
}

async function openReviewResultDialog(draft: LiteratureReviewDraft) {
  await initReviewStore();
  const folders = await listReviewFolders().catch(
    () => [] as ReviewFolderRow[],
  );
  const existingRecord = await getReviewRecordByItemID(
    draft.zoteroItemID,
  ).catch(() => null);
  const defaultFolderID =
    existingRecord?.folderID ??
    folders.find((folder) => folder.name === "未分类")?.id ??
    folders[0]?.id ??
    null;

  const dialogData: Record<string, any> = {
    title: draft.title,
    authors: draft.authors,
    journal: draft.journal,
    publicationDate: draft.publicationDate,
    abstractText: draft.abstractText,
    researchBackground: draft.researchBackground,
    literatureReview: draft.literatureReview,
    researchMethods: draft.researchMethods,
    researchConclusions: draft.researchConclusions,
    keyFindingsText: draft.keyFindings.join("\n"),
    classificationTagsText: draft.classificationTags.join(", "),
    folderID: defaultFolderID == null ? "" : String(defaultFolderID),
    loadCallback: () => {
      try {
        const win = helper.window as Window | undefined;
        win?.document?.documentElement?.setAttribute("width", "880");
      } catch {
        // ignore
      }
    },
    unloadCallback: () => {
      if (addon?.data?.dialogs) {
        delete addon.data.dialogs.reviewResult;
      }
    },
  };

  let row = 0;
  const dialog = new ztoolkit.Dialog(40, 2)
    .addCell(row++, 0, {
      tag: "h2",
      properties: { innerHTML: "提炼结果" },
      styles: { margin: "0", fontSize: "16px" },
    })
    .addCell(
      row - 1,
      1,
      {
        tag: "button",
        namespace: "html",
        attributes: { type: "button" },
        listeners: [
          {
            type: "click",
            listener: () => focusZoteroItem(draft.zoteroItemID),
          },
        ],
        children: [
          {
            tag: "span",
            properties: { innerHTML: "定位原条目" },
          },
        ],
      },
      false,
    );

  row = addInputRow(dialog, row, "标题", "title", "text", true);
  row = addInputRow(dialog, row, "作者", "authors");
  row = addInputRow(dialog, row, "期刊", "journal");
  row = addInputRow(dialog, row, "发布时间", "publicationDate");
  row = addTextareaRow(dialog, row, "摘要", "abstractText", 4);
  row = addTextareaRow(dialog, row, "研究背景", "researchBackground", 4);
  row = addTextareaRow(dialog, row, "文献综述", "literatureReview", 5);
  row = addTextareaRow(dialog, row, "研究方法", "researchMethods", 4);
  row = addTextareaRow(dialog, row, "研究结论", "researchConclusions", 4);
  row = addTextareaRow(
    dialog,
    row,
    "关键发现（每行一条）",
    "keyFindingsText",
    5,
  );
  row = addTextareaRow(
    dialog,
    row,
    "分类标签（逗号或换行分隔）",
    "classificationTagsText",
    3,
  );
  row = addSelectRow(
    dialog,
    row,
    "保存到文件夹",
    "folderID",
    folders.map((folder) => ({
      value: String(folder.id),
      label: folder.name,
    })),
  );

  const helper = dialog
    .addButton("新建文件夹", "new-folder", {
      noClose: true,
      callback: () => {
        void createFolderFromReviewDialog(helper, dialogData);
      },
    })
    .addButton("保存", "save")
    .addButton("文献综述页", "open-manager", {
      noClose: true,
      callback: () => {
        void openReviewManagerWindow();
      },
    })
    .addButton("取消", "cancel")
    .setDialogData(dialogData)
    .open(`提炼结果 - ${truncate(draft.title, 24)}`);

  addon.data.dialogs = addon.data.dialogs || {};
  addon.data.dialogs.reviewResult = helper;

  if (!dialogData.unloadLock?.promise) {
    return;
  }

  await dialogData.unloadLock.promise;
  if (dialogData._lastButtonId !== "save") {
    return;
  }

  const savedDraft: LiteratureReviewDraft = {
    ...draft,
    title: String(dialogData.title || "").trim(),
    authors: String(dialogData.authors || "").trim(),
    journal: String(dialogData.journal || "").trim(),
    publicationDate: String(dialogData.publicationDate || "").trim(),
    abstractText: String(dialogData.abstractText || "").trim(),
    researchBackground: String(dialogData.researchBackground || "").trim(),
    literatureReview: String(dialogData.literatureReview || "").trim(),
    researchMethods: String(dialogData.researchMethods || "").trim(),
    researchConclusions: String(dialogData.researchConclusions || "").trim(),
    keyFindings: splitLinesOrComma(dialogData.keyFindingsText),
    classificationTags: splitLinesOrComma(dialogData.classificationTagsText),
  };
  const selectedFolderID = parseOptionalPositiveInt(dialogData.folderID);
  const savedRow = await upsertReviewRecord(savedDraft, {
    folderID: selectedFolderID,
  });
  rememberLastSaveFolderID(selectedFolderID ?? savedRow.folderID);
  const folderLabel = selectedFolderID
    ? folders.find((folder) => folder.id === selectedFolderID)?.name ||
      savedRow.folderName
    : savedRow.folderNames?.join("、") || savedRow.folderName;
  showToast(`已保存到文献综述页（${folderLabel || "未分类"}）`, "success");
}

function addInputRow(
  dialog: any,
  row: number,
  label: string,
  bindKey: string,
  type = "text",
  strong = false,
) {
  dialog.addCell(row, 0, {
    tag: "label",
    namespace: "html",
    properties: { innerHTML: label },
    styles: {
      fontWeight: strong ? "600" : "400",
      paddingTop: "6px",
      fontSize: "12px",
    },
  });
  dialog.addCell(
    row,
    1,
    {
      tag: "input",
      namespace: "html",
      attributes: {
        type,
        "data-bind": bindKey,
        "data-prop": "value",
      },
      styles: {
        width: "100%",
        boxSizing: "border-box",
        fontSize: "12px",
        padding: "4px 6px",
      },
    },
    false,
  );
  return row + 1;
}

function addTextareaRow(
  dialog: any,
  row: number,
  label: string,
  bindKey: string,
  rows = 4,
) {
  dialog.addCell(row, 0, {
    tag: "label",
    namespace: "html",
    properties: { innerHTML: label },
    styles: {
      paddingTop: "6px",
      fontSize: "12px",
      verticalAlign: "top",
    },
  });
  dialog.addCell(
    row,
    1,
    {
      tag: "textarea",
      namespace: "html",
      attributes: {
        rows: String(rows),
        "data-bind": bindKey,
        "data-prop": "value",
      },
      styles: {
        width: "100%",
        boxSizing: "border-box",
        resize: "vertical",
        fontSize: "12px",
        lineHeight: "1.4",
        padding: "6px",
      },
    },
    false,
  );
  return row + 1;
}

function addSelectRow(
  dialog: any,
  row: number,
  label: string,
  bindKey: string,
  options: Array<{ value: string; label: string }>,
) {
  dialog.addCell(row, 0, {
    tag: "label",
    namespace: "html",
    properties: { innerHTML: label },
    styles: {
      paddingTop: "6px",
      fontSize: "12px",
    },
  });
  dialog.addCell(
    row,
    1,
    {
      tag: "select",
      namespace: "html",
      attributes: {
        "data-bind": bindKey,
        "data-prop": "value",
      },
      children: options.map((opt) => ({
        tag: "option",
        namespace: "html",
        attributes: { value: opt.value },
        properties: { innerHTML: opt.label },
      })),
      styles: {
        width: "100%",
        boxSizing: "border-box",
        fontSize: "12px",
        padding: "4px 6px",
      },
    },
    false,
  );
  return row + 1;
}

async function createFolderFromReviewDialog(
  helper: any,
  dialogData: Record<string, any>,
) {
  const win = helper?.window as Window | undefined;
  if (!win) return;

  const name = win.prompt("请输入新文件夹名称", "");
  if (!name) return;

  try {
    const folder = await createReviewFolder(name);
    const folders = await listReviewFolders();
    dialogData.folderID = String(folder.id);
    syncDialogFolderSelectOptions(win.document, folders, String(folder.id));
    showToast(`已选择文件夹：${folder.name}`, "success");
  } catch (e: any) {
    win.alert(`创建文件夹失败：${e?.message || e}`);
  }
}

function syncDialogFolderSelectOptions(
  doc: Document,
  folders: ReviewFolderRow[],
  selectedValue: string,
) {
  const select = doc.querySelector(
    'select[data-bind="folderID"]',
  ) as HTMLSelectElement | null;
  if (!select) return;

  select.innerHTML = "";
  for (const folder of folders) {
    const opt = doc.createElement("option");
    opt.value = String(folder.id);
    opt.textContent = folder.name;
    if (opt.value === selectedValue) {
      opt.selected = true;
    }
    select.appendChild(opt);
  }
  select.value = selectedValue;
}

function getSelectedRegularItems() {
  const pane = (ztoolkit.getGlobal("ZoteroPane") ||
    (Zotero.getMainWindows?.()[0] as any)?.ZoteroPane) as any;
  const items = (pane?.getSelectedItems?.() || []) as Zotero.Item[];
  return items.filter((item) => {
    try {
      return item.isRegularItem();
    } catch {
      return Boolean(item?.id);
    }
  });
}

function findToolbarContainer(doc: Document) {
  const ids = [
    "zotero-toolbar",
    "zotero-items-toolbar",
    "zotero-collections-toolbar",
    "zotero-tb-sync",
  ];

  for (const id of ids) {
    const el = doc.getElementById(id);
    if (!el) continue;
    if (id === "zotero-tb-sync") {
      return el.parentElement || null;
    }
    return el;
  }

  return doc.querySelector("toolbar") || doc.querySelector("header") || null;
}

function focusZoteroItem(itemID: number) {
  const wins = Zotero.getMainWindows?.() || [];
  const win = wins[0] as any;
  if (!win) {
    showAlert("未找到 Zotero 主窗口，无法定位条目");
    return;
  }
  try {
    win.focus();
    if (win.ZoteroPane?.selectItem) {
      void win.ZoteroPane.selectItem(itemID);
    }
  } catch (e) {
    ztoolkit.log("focus item failed", e);
  }
}

function splitLinesOrComma(value: unknown) {
  return String(value || "")
    .split(/[\n,，;；]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseOptionalPositiveInt(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const int = Math.floor(n);
  return int > 0 ? int : null;
}

async function resolveBatchSaveFolder() {
  await initReviewStore();
  const folders = await listReviewFolders().catch(
    () => [] as ReviewFolderRow[],
  );
  const preferredID = getRememberedLastSaveFolderID();
  const matched = preferredID
    ? folders.find((folder) => folder.id === preferredID) || null
    : null;
  if (matched) return matched;
  const fallback =
    folders.find((folder) => folder.name === "未分类") ||
    (await ensureDefaultReviewFolder());
  return fallback;
}

function getRememberedLastSaveFolderID() {
  try {
    const value = Zotero.Prefs.get(
      `${config.prefsPrefix}.lastSaveFolderID`,
      true,
    );
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

function rememberLastSaveFolderID(folderID: number | null) {
  try {
    if (folderID && Number.isFinite(folderID) && folderID > 0) {
      Zotero.Prefs.set(
        `${config.prefsPrefix}.lastSaveFolderID`,
        Math.floor(folderID),
        true,
      );
      return;
    }
    Zotero.Prefs.clear(`${config.prefsPrefix}.lastSaveFolderID`, true);
  } catch {
    // ignore
  }
}

function showToast(
  text: string,
  type: "success" | "warning" | "error" | "default" = "default",
) {
  new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({
      text,
      type: type === "warning" ? "default" : type,
      progress: 100,
    })
    .show();
}

function showAlert(text: string) {
  const alertFn = ztoolkit.getGlobal("alert");
  if (typeof alertFn === "function") {
    alertFn(text);
    return;
  }
  try {
    (Zotero.getMainWindows?.()[0] as any)?.alert(text);
  } catch {
    ztoolkit.log(text);
  }
}

function truncate(text: string, max = 40) {
  const str = String(text || "");
  return str.length > max ? `${str.slice(0, max)}...` : str;
}

function buildReviewContextMenuOptions() {
  return {
    tag: "menuitem" as const,
    id: reviewContextMenuID,
    label: "AI提炼文献内容",
    commandListener: () => {
      void handleExtractFromSelection();
    },
    icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
  };
}

function ensureReviewContextMenuInWindow(win: Window) {
  try {
    const popup = win.document?.querySelector?.(
      "#zotero-itemmenu",
    ) as XUL.MenuPopup | null;
    if (!popup) return false;
    bindReviewItemMenuPopup(popup);
    if (popup.querySelector(`#${reviewContextMenuID}`)) {
      return true;
    }
    const registered = ztoolkit.Menu.register(
      popup,
      buildReviewContextMenuOptions(),
    );
    return registered !== false;
  } catch (e) {
    ztoolkit.log("ensure review context menu failed", e);
    return false;
  }
}

function bindReviewItemMenuPopup(popup: XUL.MenuPopup) {
  if (boundItemMenuPopups.has(popup)) return;
  const onPopupShowing = () => {
    try {
      if (!popup.isConnected) return;
      if (!popup.querySelector(`#${reviewContextMenuID}`)) {
        ztoolkit.Menu.register(popup, buildReviewContextMenuOptions());
      }
    } catch (e) {
      ztoolkit.log("repair review context menu failed", e);
    }
  };
  popup.addEventListener("popupshowing", onPopupShowing);
  boundItemMenuPopups.add(popup);
}

function createSingleExtractionProgressUpdater(
  progressWindow: any,
  item: Zotero.Item,
) {
  const title = truncate(item.getDisplayTitle(), 30);
  let lastProgress = -1;
  let lastStage = "";
  return (update: ReviewExtractionProgress) => {
    const nextProgress = Math.max(0, Math.min(96, Math.floor(update.progress)));
    const nextStage = String(update.stage || "").trim() || "处理中";
    if (nextProgress === lastProgress && nextStage === lastStage) return;
    lastProgress = nextProgress;
    lastStage = nextStage;
    try {
      progressWindow.changeLine({
        text: `正在提炼（${nextProgress}%）: ${title} · ${nextStage}`,
        progress: nextProgress,
      });
    } catch {
      // ignore if progress window closed
    }
  };
}

function createBatchExtractionProgressUpdater(
  progressWindow: any,
  options: { item: Zotero.Item; index: number; total: number },
) {
  const title = truncate(options.item.getDisplayTitle(), 24);
  let lastGlobalProgress = -1;
  let lastStage = "";
  return (update: ReviewExtractionProgress) => {
    const itemProgress = Math.max(
      0,
      Math.min(100, Math.floor(update.progress)),
    );
    const ratioStart = (options.index - 1) / options.total;
    const ratioCurrent =
      (options.index - 1 + itemProgress / 100) / options.total;
    const globalProgress = Math.max(
      0,
      Math.min(
        99,
        Math.floor(ratioStart * 100 + (ratioCurrent - ratioStart) * 100),
      ),
    );
    const nextStage = String(update.stage || "").trim() || "处理中";
    if (globalProgress === lastGlobalProgress && nextStage === lastStage)
      return;
    lastGlobalProgress = globalProgress;
    lastStage = nextStage;
    try {
      progressWindow.changeLine({
        text: `(${options.index}/${options.total}) ${title} · ${nextStage}`,
        progress: globalProgress,
      });
    } catch {
      // ignore if progress window closed
    }
  };
}
