import { config } from "../../package.json";
import {
  getReviewErrorMessage,
  parseReviewPromptFieldKeys,
  synthesizeFolderReview,
} from "./reviewAI";
import type {
  ReviewExtractionProgress,
  ReviewPromptFieldKey,
} from "./reviewAI";
import { getReviewSettings } from "./reviewConfig";
import {
  assignReviewRecordsFolder,
  countReviewRecords,
  createFolderSummaryRecord,
  createReviewFolder,
  deleteReviewFolder,
  deleteReviewRecords,
  exportReviewRecordsAsCSV,
  getReviewRecordByID,
  listReviewFolders,
  listReviewRecords,
  mergeReviewFolders,
  removeReviewRecordsFromFolder,
  trackReviewEvent,
  updateReviewRecordRawResponse,
} from "./reviewStore";
import { ReviewFolderRow, ReviewRecordRow } from "./reviewTypes";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const REVIEW_MANAGER_ROOT_ID = `${config.addonRef}-review-manager-root`;
const REVIEW_TAB_TYPE = `${config.addonRef}-review-manager-tab`;
const MANAGER_PAGE_SIZE = 100;
const REVIEW_DIALOG_DEFAULT_WIDTH = 1200;
const REVIEW_DIALOG_DEFAULT_HEIGHT = 860;
const DEFAULT_TABLE_MIN_WIDTH = 960;
const COMPACT_TABLE_MIN_WIDTH = 560;
const TABLE_TRUNCATE_BASE_WIDTH = 280;
const TABLE_TRUNCATE_MIN_FACTOR = 1.05;
const TABLE_TRUNCATE_MAX_FACTOR = 3.6;
const TABLE_TRUNCATE_MIN_SENTENCE_LENGTH = 26;
const TABLE_TRUNCATE_BOUNDARY_WINDOW = 28;

interface ManagerState {
  viewMode: ReviewRecordRow["recordType"];
  literaturePromptFieldKeys: ReviewPromptFieldKey[];
  search: string;
  sortKey: "updatedAt" | "title" | "publicationDate" | "journal";
  sortDir: "asc" | "desc";
  page: number;
  pageSize: number;
  totalRows: number;
  folderFilterID: number | null;
  moveTargetFolderID: number | null;
  selectedFolderIDs: Set<number>;
  selectedRecordIDs: Set<number>;
  selectionAnchorRecordID: number | null;
  folders: ReviewFolderRow[];
  rows: ReviewRecordRow[];
}

interface ManagerRefs {
  root: HTMLDivElement;
  statusText: HTMLDivElement;
  folderList: HTMLDivElement;
  viewLiteratureBtn: HTMLButtonElement;
  viewSummaryBtn: HTMLButtonElement;
  searchInput: HTMLInputElement;
  sortKeyBtn: HTMLButtonElement;
  sortDirBtn: HTMLButtonElement;
  filterStatusText: HTMLSpanElement;
  pagePrevBtn: HTMLButtonElement;
  pageNextBtn: HTMLButtonElement;
  pageInfoText: HTMLSpanElement;
  table: HTMLTableElement;
  tableHeadRow: HTMLTableRowElement;
  tableBody: HTMLTableSectionElement;
  preview: HTMLTextAreaElement;
  selectionText: HTMLSpanElement;
}

interface ManagerContext {
  mode: "tab" | "dialog";
  helper: any;
  state: ManagerState;
  tabID?: string;
  refs?: ManagerRefs;
}

interface TableColumnSpec {
  key: string;
  label: string;
  align?: "left" | "center" | "right";
  maxWidth?: number;
  renderCell: (
    ctx: ManagerContext,
    row: ReviewRecordRow,
    rowIndex: number,
  ) => string | Node;
}

let managerContext: ManagerContext | null = null;

export async function openReviewManagerWindow(preferredWin?: Window) {
  if (managerContext && isManagerContextAlive(managerContext)) {
    focusManagerContext(managerContext);
    await refreshManagerData(managerContext);
    renderManager(managerContext);
    return;
  }

  const ctx: ManagerContext = {
    mode: "tab",
    helper: null,
    state: {
      viewMode: "literature",
      literaturePromptFieldKeys: [],
      search: "",
      sortKey: "updatedAt",
      sortDir: "desc",
      page: 1,
      pageSize: MANAGER_PAGE_SIZE,
      totalRows: 0,
      folderFilterID: null,
      moveTargetFolderID: null,
      selectedFolderIDs: new Set<number>(),
      selectedRecordIDs: new Set<number>(),
      selectionAnchorRecordID: null,
      folders: [],
      rows: [],
    },
  };
  managerContext = ctx;

  const win = getTargetMainWindow(preferredWin);
  const openedInTab = win ? await openReviewManagerInTab(ctx, win) : false;
  if (!openedInTab) {
    openReviewManagerInDialog(ctx);
  }

  void trackReviewEvent("table_view_click", {
    timestamp: new Date().toISOString(),
  }).catch((e) => ztoolkit.log(e));
  void trackReviewEvent("plugin_open", {
    timestamp: new Date().toISOString(),
    source: "review-manager",
  }).catch((e) => ztoolkit.log(e));
}

export async function refreshReviewManagerIfOpen() {
  const ctx = managerContext;
  if (!ctx || !isManagerContextAlive(ctx)) return false;
  await refreshAndRender(ctx);
  return true;
}

export function closeReviewManagerWindow() {
  const ctx = managerContext;
  managerContext = null;
  if (!ctx) return;

  try {
    if (ctx.mode === "tab" && ctx.tabID) {
      const tabs = getTabsAPI(ctx.helper?.window);
      tabs?.close(ctx.tabID);
      return;
    }
    ctx.helper?.window?.close?.();
  } catch {
    // ignore
  }
}

function isManagerContextAlive(ctx: ManagerContext) {
  if (ctx.mode === "tab") {
    if (!ctx.tabID) return false;
    const tabs = getTabsAPI(ctx.helper?.window);
    if (!tabs) return false;
    try {
      tabs._getTab(ctx.tabID);
      return true;
    } catch {
      return false;
    }
  }
  return Boolean(ctx.helper?.window && !ctx.helper.window.closed);
}

function focusManagerContext(ctx: ManagerContext) {
  if (ctx.mode === "tab" && ctx.tabID) {
    const win = ctx.helper?.window as any;
    try {
      win?.focus?.();
      win?.Zotero_Tabs?.select?.(ctx.tabID);
      return;
    } catch (e) {
      ztoolkit.log("Failed to select review tab", e);
    }
  }
  try {
    ctx.helper?.window?.focus?.();
  } catch {
    // ignore
  }
}

function getTargetMainWindow(preferredWin?: Window) {
  const preferred = preferredWin as any;
  if (preferred?.document && preferred?.Zotero_Tabs) {
    return preferred as Window;
  }
  return (Zotero.getMainWindows?.()[0] as unknown as Window) || null;
}

function getTabsAPI(win: any) {
  return (win as any)?.Zotero_Tabs || (globalThis as any)?.Zotero_Tabs || null;
}

async function openReviewManagerInTab(ctx: ManagerContext, win: Window) {
  const tabs = getTabsAPI(win);
  if (!tabs?.add) {
    return false;
  }

  try {
    const { id, container } = tabs.add({
      type: REVIEW_TAB_TYPE,
      title: "文献综述",
      select: true,
      onClose: () => {
        if (managerContext === ctx) {
          managerContext = null;
        }
      },
    });

    ctx.mode = "tab";
    ctx.tabID = id;
    ctx.helper = { window: win };

    prepareTabContainer(win.document, container as unknown as Element);
    mountManagerUI(ctx);
    await refreshAndRender(ctx);
    return true;
  } catch (e) {
    ztoolkit.log("Failed to open review manager in tab", e);
    return false;
  }
}

function prepareTabContainer(doc: Document, container: Element) {
  const host = container as HTMLElement;
  if (host?.style) {
    host.style.width = "100%";
    host.style.maxWidth = "100%";
    host.style.height = "100%";
    host.style.maxHeight = "100%";
    host.style.overflow = "hidden";
    host.style.minWidth = "0";
    host.style.minHeight = "0";
    host.style.boxSizing = "border-box";
  }
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
  const root = createHTMLElement(doc, "div");
  root.id = REVIEW_MANAGER_ROOT_ID;
  Object.assign(root.style, {
    width: "100%",
    maxWidth: "100%",
    height: "100%",
    maxHeight: "100%",
    minWidth: "0",
    minHeight: "0",
    overflow: "hidden",
    boxSizing: "border-box",
  });
  container.appendChild(root);
}

function openReviewManagerInDialog(ctx: ManagerContext) {
  ctx.mode = "dialog";
  const dialogData: Record<string, any> = {
    loadCallback: () => {
      const mount = () => {
        if (!ctx.helper?.window) {
          setTimeout(mount, 0);
          return;
        }
        try {
          setupReviewManagerDialogWindow(ctx.helper.window as Window);
          mountManagerUI(ctx);
          void refreshAndRender(ctx);
        } catch (e) {
          ztoolkit.log("Failed to mount review manager dialog", e);
        }
      };
      mount();
    },
    unloadCallback: () => {
      if (addon?.data?.dialogs) {
        delete addon.data.dialogs.reviewManager;
      }
      if (managerContext === ctx) {
        managerContext = null;
      }
    },
  };

  const helper = new ztoolkit.Dialog(1, 1)
    .addCell(0, 0, {
      tag: "div",
      namespace: "html",
      id: REVIEW_MANAGER_ROOT_ID,
      styles: {
        width: `${REVIEW_DIALOG_DEFAULT_WIDTH - 48}px`,
        minWidth: `${REVIEW_DIALOG_DEFAULT_WIDTH - 48}px`,
        maxWidth: `${REVIEW_DIALOG_DEFAULT_WIDTH - 48}px`,
        height: `${REVIEW_DIALOG_DEFAULT_HEIGHT - 120}px`,
        minHeight: `${REVIEW_DIALOG_DEFAULT_HEIGHT - 120}px`,
        maxHeight: `${REVIEW_DIALOG_DEFAULT_HEIGHT - 120}px`,
        overflow: "hidden",
        boxSizing: "border-box",
      },
    })
    .addButton("关闭", "close")
    .setDialogData(dialogData)
    .open("文献综述");
  ctx.helper = helper;

  addon.data.dialogs = addon.data.dialogs || {};
  addon.data.dialogs.reviewManager = helper;

  if (dialogData.unloadLock?.promise) {
    void dialogData.unloadLock.promise.catch(() => undefined);
  }
}

function setupReviewManagerDialogWindow(win: Window) {
  try {
    const root = win.document.documentElement;
    root?.setAttribute("width", String(REVIEW_DIALOG_DEFAULT_WIDTH));
    root?.setAttribute("height", String(REVIEW_DIALOG_DEFAULT_HEIGHT));
    root?.setAttribute("minwidth", String(REVIEW_DIALOG_DEFAULT_WIDTH));
    root?.setAttribute("minheight", String(REVIEW_DIALOG_DEFAULT_HEIGHT));
    root?.setAttribute("maxwidth", String(REVIEW_DIALOG_DEFAULT_WIDTH));
    root?.setAttribute("maxheight", String(REVIEW_DIALOG_DEFAULT_HEIGHT));
    root?.setAttribute("resizable", "false");
    root?.setAttribute("sizetocontent", "false");
    const body = win.document.body as HTMLElement | null;
    if (body?.style) {
      body.style.width = "100%";
      body.style.maxWidth = "100%";
      body.style.minWidth = "0";
      body.style.height = "100%";
      body.style.maxHeight = "100%";
      body.style.overflow = "hidden";
      body.style.boxSizing = "border-box";
      body.style.margin = "0";
    }
    win.resizeTo(REVIEW_DIALOG_DEFAULT_WIDTH, REVIEW_DIALOG_DEFAULT_HEIGHT);
  } catch {
    // ignore
  }
}

async function refreshAndRender(ctx: ManagerContext) {
  await refreshManagerData(ctx);
  renderManager(ctx);
}

async function refreshManagerData(ctx: ManagerContext) {
  const { state } = ctx;
  const settings = getReviewSettings();
  state.literaturePromptFieldKeys = parseReviewPromptFieldKeys(
    settings.customPromptTemplate,
  );
  state.folders = await listReviewFolders();
  state.totalRows = await countReviewRecords({
    recordType: state.viewMode,
    search: state.search,
    folderID: state.folderFilterID,
  });
  const totalPages = getTotalPages(state.totalRows, state.pageSize);
  state.page = Math.min(Math.max(1, state.page), totalPages);
  state.rows = await listReviewRecords({
    recordType: state.viewMode,
    search: state.search,
    folderID: state.folderFilterID,
    sortKey: state.sortKey,
    sortDir: state.sortDir,
    limit: state.pageSize,
    offset: (state.page - 1) * state.pageSize,
  });

  const validRecordIDs = new Set(state.rows.map((row) => row.id));
  if (
    state.selectionAnchorRecordID != null &&
    !validRecordIDs.has(state.selectionAnchorRecordID)
  ) {
    state.selectionAnchorRecordID = null;
  }

  const validFolderIDs = new Set(state.folders.map((folder) => folder.id));
  state.selectedFolderIDs = new Set(
    Array.from(state.selectedFolderIDs).filter((id) => validFolderIDs.has(id)),
  );
  if (
    state.moveTargetFolderID != null &&
    !validFolderIDs.has(state.moveTargetFolderID)
  ) {
    state.moveTargetFolderID = null;
  }

  if (
    state.folderFilterID != null &&
    !state.folders.some((folder) => folder.id === state.folderFilterID)
  ) {
    state.folderFilterID = null;
  }
}

function mountManagerUI(ctx: ManagerContext) {
  const win = ctx.helper.window as Window;
  const doc = win.document;
  const root = doc.getElementById(
    REVIEW_MANAGER_ROOT_ID,
  ) as HTMLDivElement | null;
  if (!root) {
    throw new Error("review manager root not found");
  }

  root.innerHTML = "";
  if (ctx.mode === "dialog") {
    const contentWidth = Math.max(760, REVIEW_DIALOG_DEFAULT_WIDTH - 48);
    const contentHeight = Math.max(560, REVIEW_DIALOG_DEFAULT_HEIGHT - 120);
    root.style.width = `${contentWidth}px`;
    root.style.minWidth = `${contentWidth}px`;
    root.style.maxWidth = `${contentWidth}px`;
    root.style.height = `${contentHeight}px`;
    root.style.minHeight = `${contentHeight}px`;
    root.style.maxHeight = `${contentHeight}px`;
    root.style.overflow = "hidden";
  } else {
    root.style.width = "100%";
    root.style.maxWidth = "100%";
    root.style.height = "100%";
    root.style.maxHeight = "100%";
    root.style.minWidth = "";
    root.style.minHeight = "";
    root.style.maxWidth = "100%";
    root.style.maxHeight = "100%";
    root.style.overflow = "hidden";
  }
  root.style.boxSizing = "border-box";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "10px";
  root.style.padding = "12px";
  root.style.overflow = "hidden";
  root.style.fontFamily =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  root.style.background = "#f8fafc";

  const titleRow = createEl(doc, "div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      padding: "8px 10px",
      border: "1px solid #e2e8f0",
      borderRadius: "8px",
      background: "#ffffff",
    },
  });

  const titleText = createEl(doc, "div", {
    text: "文献综述管理",
    style: {
      fontSize: "14px",
      fontWeight: "600",
      color: "#1f2937",
    },
  });

  const statusText = createEl(doc, "div", {
    text: "加载中...",
    style: {
      fontSize: "12px",
      color: "#475569",
      background: "#f1f5f9",
      border: "1px solid #e2e8f0",
      borderRadius: "999px",
      padding: "2px 10px",
      whiteSpace: "nowrap",
    },
  });
  titleRow.append(titleText, statusText);

  const toolbar = createEl(doc, "div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: "8px",
      alignItems: "center",
      border: "1px solid #e2e8f0",
      borderRadius: "8px",
      background: "#ffffff",
      padding: "8px",
    },
  });

  const searchInput = createEl(doc, "input", {
    attrs: {
      type: "search",
      placeholder: "搜索标题/作者/期刊/标签/提炼内容...",
    },
    style: {
      flex: "1 1 320px",
      minWidth: "240px",
      height: "28px",
      border: "1px solid #cbd5e1",
      borderRadius: "6px",
      padding: "0 10px",
      fontSize: "12px",
      boxSizing: "border-box",
      background: "#f8fafc",
    },
  }) as HTMLInputElement;

  const viewLiteratureBtn = createButton(doc, "文献记录");
  const viewSummaryBtn = createButton(doc, "合并综述");
  const sortKeyBtn = createButton(doc, "排序：更新时间");
  const sortDirBtn = createButton(doc, "降序");
  const filterStatusText = createEl(doc, "span", {
    text: "筛选：全部文件夹",
    style: {
      fontSize: "12px",
      color: "#334155",
      whiteSpace: "nowrap",
      background: "#eef2ff",
      border: "1px solid #dbeafe",
      borderRadius: "999px",
      padding: "2px 10px",
    },
  }) as HTMLSpanElement;
  const pagePrevBtn = createButton(doc, "上一页");
  const pageNextBtn = createButton(doc, "下一页");
  const pageInfoText = createEl(doc, "span", {
    text: "第 1/1 页",
    style: {
      fontSize: "12px",
      color: "#334155",
      whiteSpace: "nowrap",
      background: "#f1f5f9",
      border: "1px solid #e2e8f0",
      borderRadius: "999px",
      padding: "2px 10px",
    },
  }) as HTMLSpanElement;

  toolbar.append(
    searchInput,
    sortKeyBtn,
    sortDirBtn,
    filterStatusText,
    pagePrevBtn,
    pageNextBtn,
    pageInfoText,
  );

  const actionBar = createEl(doc, "div", {
    style: {
      display: "flex",
      gap: "8px",
      flexWrap: "wrap",
      alignItems: "center",
      border: "1px solid #e2e8f0",
      borderRadius: "8px",
      background: "#ffffff",
      padding: "8px",
    },
  });

  const btnRefresh = createButton(doc, "刷新");
  const btnCreateFolder = createButton(doc, "新建文件夹");
  const btnDeleteFolder = createButton(doc, "删除文件夹");
  const btnMergeFolder = createButton(doc, "合并文件夹");
  const btnFolderSummary = createButton(doc, "合并综述");
  const btnMoveSelected = createButton(doc, "加入文件夹");
  const btnRemoveSelected = createButton(doc, "移出文件夹");
  const btnDeleteSelected = createButton(doc, "删除记录");
  const btnSelectAll = createButton(doc, "全选");
  const btnClearSelection = createButton(doc, "清空选择");
  const btnOpenItem = createButton(doc, "定位条目");
  const btnPreviewRaw = createButton(doc, "查看原始记录");
  const btnExport = createButton(doc, "导出表格");
  const actionDividerA = createEl(doc, "span", {
    style: {
      width: "1px",
      height: "20px",
      background: "#e2e8f0",
      margin: "0 2px",
    },
  });
  const actionDividerB = createEl(doc, "span", {
    style: {
      width: "1px",
      height: "20px",
      background: "#e2e8f0",
      margin: "0 2px",
    },
  });
  const selectionText = createEl(doc, "span", {
    text: "未选择",
    style: {
      fontSize: "12px",
      color: "#334155",
      background: "#f1f5f9",
      border: "1px solid #e2e8f0",
      borderRadius: "999px",
      padding: "2px 10px",
    },
  });

  actionBar.append(
    btnRefresh,
    btnCreateFolder,
    btnDeleteFolder,
    btnMergeFolder,
    btnFolderSummary,
    actionDividerA,
    btnMoveSelected,
    btnRemoveSelected,
    btnDeleteSelected,
    btnSelectAll,
    btnClearSelection,
    actionDividerB,
    btnOpenItem,
    btnPreviewRaw,
    btnExport,
    selectionText,
  );

  const content = createEl(doc, "div", {
    style: {
      display: "grid",
      gridTemplateColumns: "240px minmax(0, 1fr)",
      gap: "8px",
      flex: "1",
      width: "100%",
      maxWidth: "100%",
      minWidth: "0",
      minHeight: "0",
      overflow: "hidden",
    },
  });

  const leftPane = createEl(doc, "div", {
    style: {
      border: "1px solid #dbe3ef",
      borderRadius: "8px",
      padding: "10px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      minHeight: "0",
      background: "#ffffff",
      boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
    },
  });
  leftPane.append(
    createEl(doc, "div", {
      text: "分类文件夹",
      style: { fontSize: "12px", fontWeight: "600", color: "#111827" },
    }),
  );

  const folderList = createEl(doc, "div", {
    attrs: {},
    style: {
      width: "100%",
      flex: "1",
      minHeight: "0",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      overflow: "auto",
      paddingRight: "2px",
    },
  }) as HTMLDivElement;
  leftPane.append(folderList);

  const rightPane = createEl(doc, "div", {
    style: {
      display: "grid",
      gridTemplateRows: "minmax(0, 1fr) 180px",
      gap: "8px",
      width: "100%",
      minWidth: "0",
      maxWidth: "100%",
      minHeight: "0",
      overflow: "hidden",
    },
  });

  const tableWrap = createEl(doc, "div", {
    style: {
      border: "1px solid #dbe3ef",
      borderRadius: "8px",
      overflow: "hidden",
      background: "#fff",
      width: "100%",
      minWidth: "0",
      maxWidth: "100%",
      minHeight: "0",
      display: "grid",
      gridTemplateRows: "auto minmax(0, 1fr)",
      boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
    },
  });

  const tableToolbar = createEl(doc, "div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr auto 1fr",
      alignItems: "center",
      gap: "8px",
      padding: "10px",
      borderBottom: "1px solid #e2e8f0",
      background: "#f8fafc",
    },
  });
  const viewSwitchWrap = createEl(doc, "div", {
    style: {
      display: "inline-flex",
      border: "1px solid #cbd5e1",
      borderRadius: "6px",
      overflow: "hidden",
      background: "#fff",
    },
  });
  viewLiteratureBtn.style.border = "none";
  viewLiteratureBtn.style.borderRight = "1px solid #d1d5db";
  viewLiteratureBtn.style.borderRadius = "0";
  viewLiteratureBtn.dataset.segmented = "1";
  viewSummaryBtn.style.border = "none";
  viewSummaryBtn.style.borderRadius = "0";
  viewSummaryBtn.dataset.segmented = "1";
  viewSwitchWrap.append(viewLiteratureBtn, viewSummaryBtn);
  const toolbarLeftSpacer = createEl(doc, "div", {
    style: {
      minWidth: "0",
    },
  });
  const switchControlCenter = createEl(doc, "div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: "0",
    },
  });
  switchControlCenter.append(viewSwitchWrap);
  const toolbarRightSpacer = createEl(doc, "div", {
    style: {
      minWidth: "0",
    },
  });
  tableToolbar.append(
    toolbarLeftSpacer,
    switchControlCenter,
    toolbarRightSpacer,
  );

  const tableScrollWrap = createEl(doc, "div", {
    style: {
      overflowX: "scroll",
      overflowY: "auto",
      width: "100%",
      minWidth: "0",
      maxWidth: "100%",
      minHeight: "0",
      height: "100%",
      maxHeight: "100%",
      scrollbarGutter: "stable both-edges",
      overscrollBehavior: "contain",
    },
  });

  const table = createEl(doc, "table", {
    style: {
      width: "100%",
      maxWidth: "100%",
      borderCollapse: "collapse",
      fontSize: "12px",
      tableLayout: "fixed",
    },
  }) as HTMLTableElement;

  const thead = createEl(doc, "thead") as HTMLTableSectionElement;
  const headRow = createEl(doc, "tr") as HTMLTableRowElement;
  thead.appendChild(headRow);

  const tableBody = createEl(doc, "tbody") as HTMLTableSectionElement;
  table.append(thead, tableBody);
  tableScrollWrap.appendChild(table);
  tableWrap.append(tableToolbar, tableScrollWrap);

  const previewWrap = createEl(doc, "div", {
    style: {
      border: "1px solid #dbe3ef",
      borderRadius: "8px",
      padding: "10px",
      display: "grid",
      gridTemplateRows: "auto 1fr",
      gap: "6px",
      minWidth: "0",
      minHeight: "0",
      background: "#fff",
      boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
      position: "sticky",
      bottom: "0",
      zIndex: "2",
      overflow: "hidden",
    },
  });
  previewWrap.append(
    createEl(doc, "div", {
      text: "内容预览",
      style: { fontSize: "12px", fontWeight: "600" },
    }),
  );
  const preview = createEl(doc, "textarea", {
    attrs: { readonly: "readonly" },
    style: {
      width: "100%",
      height: "100%",
      minHeight: "130px",
      resize: "vertical",
      fontSize: "13px",
      lineHeight: "1.6",
      boxSizing: "border-box",
      border: "1px solid #e2e8f0",
      borderRadius: "6px",
      padding: "10px",
      background: "#f8fafc",
      color: "#1e293b",
    },
  }) as HTMLTextAreaElement;
  previewWrap.append(preview);

  rightPane.append(tableWrap, previewWrap);
  content.append(leftPane, rightPane);

  root.append(titleRow, toolbar, actionBar, content);

  ctx.refs = {
    root,
    statusText,
    folderList,
    viewLiteratureBtn,
    viewSummaryBtn,
    searchInput,
    sortKeyBtn,
    sortDirBtn,
    filterStatusText,
    pagePrevBtn,
    pageNextBtn,
    pageInfoText,
    table,
    tableHeadRow: headRow,
    tableBody,
    preview,
    selectionText,
  };

  searchInput.addEventListener("input", () => {
    ctx.state.search = searchInput.value.trim();
    ctx.state.page = 1;
    void refreshAndRender(ctx);
  });
  searchInput.addEventListener("focus", () => {
    searchInput.style.borderColor = "#93c5fd";
    searchInput.style.background = "#ffffff";
  });
  searchInput.addEventListener("blur", () => {
    searchInput.style.borderColor = "#cbd5e1";
    searchInput.style.background = "#f8fafc";
  });
  viewLiteratureBtn.addEventListener("click", () => {
    switchManagerView(ctx, "literature");
  });
  viewSummaryBtn.addEventListener("click", () => {
    switchManagerView(ctx, "folderSummary");
  });

  sortKeyBtn.addEventListener("click", () => {
    ctx.state.sortKey = cycleSortKey(ctx.state.sortKey);
    ctx.state.page = 1;
    void refreshAndRender(ctx);
  });

  sortDirBtn.addEventListener("click", () => {
    ctx.state.sortDir = ctx.state.sortDir === "desc" ? "asc" : "desc";
    ctx.state.page = 1;
    void refreshAndRender(ctx);
  });

  pagePrevBtn.addEventListener("click", () => {
    if (ctx.state.page <= 1) return;
    ctx.state.page -= 1;
    void refreshAndRender(ctx);
  });

  pageNextBtn.addEventListener("click", () => {
    const totalPages = getTotalPages(ctx.state.totalRows, ctx.state.pageSize);
    if (ctx.state.page >= totalPages) return;
    ctx.state.page += 1;
    void refreshAndRender(ctx);
  });

  btnRefresh.addEventListener("click", () => {
    void refreshAndRender(ctx);
  });

  btnCreateFolder.addEventListener("click", async () => {
    const name = win.prompt("请输入新文件夹名称", "");
    if (!name) return;
    try {
      const folder = await createReviewFolder(name);
      ctx.state.selectedFolderIDs = new Set([folder.id]);
      ctx.state.moveTargetFolderID = folder.id;
      await trackReviewEvent("folder_create", {
        timestamp: new Date().toISOString(),
        folder_name: folder.name,
      });
      await refreshAndRender(ctx);
    } catch (e: any) {
      win.alert(`创建文件夹失败：${e?.message || e}`);
    }
  });

  btnDeleteFolder.addEventListener("click", async () => {
    const ids = Array.from(ctx.state.selectedFolderIDs);
    if (!ids.length) {
      win.alert("请先在左侧选中文件夹");
      return;
    }
    if (
      !win.confirm(
        `确认删除所选 ${ids.length} 个文件夹？无其他分类的记录将自动归入“未分类”。`,
      )
    ) {
      return;
    }
    try {
      const locked = ids
        .map((id) => ctx.state.folders.find((f) => f.id === id))
        .filter((f): f is ReviewFolderRow => Boolean(f))
        .filter((f) => isProtectedFolderName(f.name));
      if (locked.length) {
        win.alert(
          `系统文件夹不可删除：${locked.map((f) => f.name).join("、")}`,
        );
        return;
      }
      for (const id of ids) {
        const folder = ctx.state.folders.find((f) => f.id === id);
        await deleteReviewFolder(id);
        await trackReviewEvent("folder_delete", {
          timestamp: new Date().toISOString(),
          folder_name: folder?.name || String(id),
        });
      }
      ctx.state.selectedFolderIDs.clear();
      await refreshAndRender(ctx);
    } catch (e: any) {
      win.alert(`删除文件夹失败：${e?.message || e}`);
    }
  });

  btnMergeFolder.addEventListener("click", async () => {
    const ids = Array.from(ctx.state.selectedFolderIDs);
    if (ids.length < 2) {
      win.alert("请在左侧至少选择两个文件夹进行合并");
      return;
    }
    const locked = ids
      .map((id) => ctx.state.folders.find((f) => f.id === id))
      .filter((f): f is ReviewFolderRow => Boolean(f))
      .filter((f) => isProtectedFolderName(f.name));
    if (locked.length) {
      win.alert(`系统文件夹不可合并：${locked.map((f) => f.name).join("、")}`);
      return;
    }
    const newName = win.prompt("合并后的新文件夹名称", "");
    if (!newName) return;
    try {
      const newFolder = await mergeReviewFolders(ids, newName);
      await trackReviewEvent("folder_merge", {
        timestamp: new Date().toISOString(),
        folder_count: ids.length,
        new_folder_name: newFolder.name,
      });
      ctx.state.selectedFolderIDs = new Set([newFolder.id]);
      ctx.state.moveTargetFolderID = newFolder.id;
      await refreshAndRender(ctx);
    } catch (e: any) {
      win.alert(`合并文件夹失败：${e?.message || e}`);
    }
  });

  btnFolderSummary.addEventListener("click", async () => {
    const targetFolder = resolveFolderForSummary(ctx);
    if (!targetFolder) {
      win.alert("请先在左侧点击一个文件夹，再执行“合并综述”");
      return;
    }
    let progress: any = null;
    try {
      const allRows = await listReviewRecords({
        folderID: targetFolder.id,
        recordType: "literature",
        sortKey: "updatedAt",
        sortDir: "desc",
      });
      if (!allRows.length) {
        win.alert(`文件夹“${targetFolder.name}”下暂无记录`);
        return;
      }

      progress = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
        closeOnClick: true,
        closeTime: -1,
      })
        .createLine({
          text: `正在合并综述：${targetFolder.name}`,
          type: "default",
          progress: 0,
        })
        .show();

      const onProgress = (update: ReviewExtractionProgress) => {
        try {
          progress.changeLine({
            text: `合并综述（${Math.max(0, Math.min(96, update.progress))}%）: ${targetFolder.name} · ${update.stage}`,
            progress: Math.max(0, Math.min(96, update.progress)),
          });
        } catch {
          // ignore
        }
      };

      const result = await synthesizeFolderReview(targetFolder.name, allRows, {
        onProgress,
      });
      const savedSummary = await createFolderSummaryRecord({
        folderID: targetFolder.id,
        folderName: targetFolder.name,
        summaryText: result.text,
        sourceRows: allRows.map((row) => ({
          id: row.id,
          zoteroItemID: row.zoteroItemID,
        })),
        aiProvider: result.provider,
        aiModel: result.model,
      });
      progress.changeLine({
        text: `合并综述完成：${targetFolder.name}`,
        type: "success",
        progress: 100,
      });
      progress.startCloseTimer(1500);
      await trackReviewEvent("folder_summary_success", {
        timestamp: new Date().toISOString(),
        folder_name: targetFolder.name,
        record_count: allRows.length,
        summary_record_id: savedSummary.id,
        model_type: `${result.provider}:${result.model}`,
      }).catch((e) => ztoolkit.log(e));
      await refreshAndRender(ctx);
      await openFolderSummaryDialog(
        targetFolder.name,
        result.text,
        allRows.length,
      );
    } catch (e) {
      const message = getReviewErrorMessage(e);
      try {
        progress?.changeLine({
          text: `合并综述失败：${message}`,
          type: "error",
          progress: 100,
        });
        progress?.startCloseTimer?.(4000);
      } catch {
        // ignore
      }
      await trackReviewEvent("folder_summary_fail", {
        timestamp: new Date().toISOString(),
        folder_name: targetFolder.name,
        fail_reason: message,
      }).catch((err) => ztoolkit.log(err));
      win.alert(`合并综述失败：${message}`);
    }
  });

  btnMoveSelected.addEventListener("click", async () => {
    const recordIDs = Array.from(ctx.state.selectedRecordIDs);
    if (!recordIDs.length) {
      win.alert("请先在表格中勾选记录");
      return;
    }
    const targetFolderID = resolveMoveTargetFolderID(ctx);
    if (!targetFolderID) {
      win.alert("请先在左侧点击一个目标文件夹（不能是“我的记录”）");
      return;
    }
    try {
      ctx.state.moveTargetFolderID = targetFolderID;
      const targetFolderName =
        ctx.state.folders.find((folder) => folder.id === targetFolderID)
          ?.name || "目标文件夹";
      const hiddenByFilter =
        ctx.state.folderFilterID != null &&
        ctx.state.folderFilterID !== targetFolderID;
      await assignReviewRecordsFolder(recordIDs, targetFolderID);
      await refreshAndRender(ctx);
      showManagerToast(
        hiddenByFilter
          ? `已将 ${recordIDs.length} 条记录加入“${targetFolderName}”。当前筛选条件下它们可能暂时不可见。`
          : `已将 ${recordIDs.length} 条记录加入“${targetFolderName}”`,
      );
    } catch (e: any) {
      win.alert(`加入文件夹失败：${e?.message || e}`);
    }
  });

  btnRemoveSelected.addEventListener("click", async () => {
    const recordIDs = Array.from(ctx.state.selectedRecordIDs);
    if (!recordIDs.length) {
      win.alert("请先在表格中勾选记录");
      return;
    }
    const sourceFolder = resolveFolderForRecordRemoval(ctx);
    if (!sourceFolder) {
      win.alert("请先在左侧点击一个要移出的文件夹（不能是“我的记录”）");
      return;
    }
    if (isProtectedFolderName(sourceFolder.name)) {
      win.alert("“未分类”为系统目录，不能直接移出。请先加入其它文件夹。");
      return;
    }

    const effectiveRows = ctx.state.rows.filter(
      (row) =>
        ctx.state.selectedRecordIDs.has(row.id) &&
        Array.isArray(row.folderIDs) &&
        row.folderIDs.includes(sourceFolder.id),
    );
    if (!effectiveRows.length) {
      win.alert(`所选记录不在“${sourceFolder.name}”中`);
      return;
    }

    try {
      await removeReviewRecordsFromFolder(
        effectiveRows.map((row) => row.id),
        sourceFolder.id,
      );
      await refreshAndRender(ctx);
      const hiddenByFilter = ctx.state.folderFilterID === sourceFolder.id;
      showManagerToast(
        hiddenByFilter
          ? `已将 ${effectiveRows.length} 条记录从“${sourceFolder.name}”移出。当前筛选条件下它们可能暂时不可见。`
          : `已将 ${effectiveRows.length} 条记录从“${sourceFolder.name}”移出`,
      );
    } catch (e: any) {
      win.alert(`移出文件夹失败：${e?.message || e}`);
    }
  });

  btnDeleteSelected.addEventListener("click", async () => {
    const recordIDs = Array.from(ctx.state.selectedRecordIDs);
    if (!recordIDs.length) {
      win.alert("请先在表格中勾选记录");
      return;
    }
    if (
      !win.confirm(
        `确认彻底删除所选 ${recordIDs.length} 条记录？该操作不可恢复。`,
      )
    ) {
      return;
    }
    try {
      const deletedCount = await deleteReviewRecords(recordIDs);
      await trackReviewEvent("record_delete", {
        timestamp: new Date().toISOString(),
        record_count: deletedCount,
        view_mode: ctx.state.viewMode,
      }).catch((e) => ztoolkit.log(e));
      ctx.state.selectedRecordIDs.clear();
      ctx.state.selectionAnchorRecordID = null;
      await refreshAndRender(ctx);
      showManagerToast(`已删除 ${deletedCount} 条记录`);
    } catch (e: any) {
      win.alert(`删除记录失败：${e?.message || e}`);
    }
  });

  btnSelectAll.addEventListener("click", () => {
    ctx.state.selectedRecordIDs = new Set(ctx.state.rows.map((row) => row.id));
    ctx.state.selectionAnchorRecordID = ctx.state.rows[0]?.id ?? null;
    renderManager(ctx);
  });

  btnClearSelection.addEventListener("click", () => {
    ctx.state.selectedRecordIDs.clear();
    ctx.state.selectionAnchorRecordID = null;
    renderManager(ctx);
  });

  btnOpenItem.addEventListener("click", () => {
    const row = getPrimarySelectedRow(ctx);
    if (!row) {
      win.alert("请先选择一条记录");
      return;
    }
    if (row.recordType === "folderSummary") {
      win.alert("当前记录为合并综述，不对应单个 Zotero 条目");
      return;
    }
    focusZoteroItem(row.zoteroItemID);
  });

  btnPreviewRaw.addEventListener("click", async () => {
    const row = getPrimarySelectedRow(ctx);
    if (!row) {
      win.alert("请先选择一条记录");
      return;
    }
    const detail = await getReviewRecordByID(row.id);
    if (!detail) {
      win.alert("记录不存在，可能已被删除");
      return;
    }
    const raw = detail.rawAIResponse?.trim();
    if (!raw) {
      win.alert("该记录没有原始结果");
      return;
    }
    await openRawRecordEditorDialog(ctx, detail);
  });

  btnExport.addEventListener("click", async () => {
    try {
      const csv = await exportReviewRecordsAsCSV({
        folderID: ctx.state.folderFilterID,
        recordType: ctx.state.viewMode,
        search: ctx.state.search,
        sortKey: ctx.state.sortKey,
        sortDir: ctx.state.sortDir,
      });
      const path = await new ztoolkit.FilePicker(
        "导出表格",
        "save",
        [["CSV 文件 (*.csv)", "*.csv"]],
        `literature-review-${Date.now()}.csv`,
      ).open();
      if (!path) return;
      const normalizedPath = String(path).endsWith(".csv")
        ? String(path)
        : `${path}.csv`;
      await writeTextFile(normalizedPath, csv);
      await trackReviewEvent("excel_export", {
        timestamp: new Date().toISOString(),
        record_count: ctx.state.rows.length,
      });
      win.alert(`已导出：${normalizedPath}`);
    } catch (e: any) {
      win.alert(`导出失败：${e?.message || e}`);
    }
  });
}

function renderManager(ctx: ManagerContext) {
  const refs = ctx.refs;
  if (!refs) return;
  const { state } = ctx;
  const columns = getCurrentTableColumns(ctx);

  refs.searchInput.value = state.search;
  syncViewButtonState(refs.viewLiteratureBtn, state.viewMode === "literature");
  syncViewButtonState(refs.viewSummaryBtn, state.viewMode === "folderSummary");
  refs.sortKeyBtn.textContent = `排序：${getSortKeyLabel(state.sortKey)}`;
  refs.sortDirBtn.textContent = state.sortDir === "desc" ? "降序" : "升序";
  refs.filterStatusText.textContent = `视图：${getViewModeLabel(state.viewMode)} · 筛选：${
    state.folderFilterID == null
      ? "全部文件夹"
      : state.folders.find((f) => f.id === state.folderFilterID)?.name ||
        "已选文件夹"
  } · 目标：${
    state.moveTargetFolderID == null
      ? "未设置"
      : state.folders.find((f) => f.id === state.moveTargetFolderID)?.name ||
        "已选文件夹"
  }`;
  const totalPages = getTotalPages(state.totalRows, state.pageSize);
  refs.pageInfoText.textContent = `第 ${Math.min(state.page, totalPages)}/${totalPages} 页 · 共 ${state.totalRows} 条`;
  refs.pagePrevBtn.disabled = state.page <= 1;
  refs.pageNextBtn.disabled = state.page >= totalPages;
  refs.pagePrevBtn.style.opacity = refs.pagePrevBtn.disabled ? "0.5" : "1";
  refs.pageNextBtn.style.opacity = refs.pageNextBtn.disabled ? "0.5" : "1";
  refs.pagePrevBtn.style.cursor = refs.pagePrevBtn.disabled
    ? "default"
    : "pointer";
  refs.pageNextBtn.style.cursor = refs.pageNextBtn.disabled
    ? "default"
    : "pointer";

  renderFolderButtons(ctx);

  refs.statusText.textContent = `${getViewModeLabel(state.viewMode)} · ${state.folders.length} 个文件夹 · 当前页 ${state.rows.length} 条 / 共 ${state.totalRows} 条`;
  refs.selectionText.textContent = state.selectedRecordIDs.size
    ? `已选 ${state.selectedRecordIDs.size} 条`
    : "未选择";

  syncTableSizing(ctx, columns);
  renderTableHeader(ctx, columns);
  renderTableBody(ctx, columns);
  renderPreview(ctx);
}

function renderFolderButtons(ctx: ManagerContext) {
  const refs = ctx.refs;
  if (!refs) return;
  const { state } = ctx;
  const doc = refs.folderList.ownerDocument!;
  refs.folderList.innerHTML = "";

  const hint = createEl(doc, "div", {
    text: "单击筛选；Ctrl/Cmd 可多选文件夹用于删除/合并",
    style: {
      fontSize: "11px",
      color: "#64748b",
      lineHeight: "1.4",
      marginBottom: "2px",
    },
  });
  refs.folderList.appendChild(hint);

  const allBtn = createFolderButton(doc, {
    label: "我的记录",
    active: state.folderFilterID == null,
    selected: false,
    locked: true,
    isMoveTarget: false,
    onClick: (ev) => {
      handleFolderButtonClick(ctx, null, "我的记录", ev);
    },
  });
  refs.folderList.appendChild(allBtn);

  for (const folder of state.folders) {
    const isReserved = folder.name === "未分类";
    const btn = createFolderButton(doc, {
      label: folder.name,
      active: state.folderFilterID === folder.id,
      selected: state.selectedFolderIDs.has(folder.id),
      locked: isReserved,
      isMoveTarget: state.moveTargetFolderID === folder.id,
      onClick: (ev) => {
        handleFolderButtonClick(ctx, folder.id, folder.name, ev);
      },
    });
    refs.folderList.appendChild(btn);
  }
}

function handleFolderButtonClick(
  ctx: ManagerContext,
  folderID: number | null,
  _folderName: string,
  ev: MouseEvent,
) {
  const isAdditive = Boolean(ev.ctrlKey || ev.metaKey);
  const isVirtualAll = folderID == null;

  if (!isAdditive) {
    ctx.state.folderFilterID = folderID;
    ctx.state.page = 1;
    if (isVirtualAll) {
      ctx.state.moveTargetFolderID = null;
      ctx.state.selectedFolderIDs.clear();
    } else {
      ctx.state.moveTargetFolderID = folderID;
      ctx.state.selectedFolderIDs = new Set([folderID]);
    }
    void refreshAndRender(ctx);
    return;
  }

  if (isVirtualAll) {
    ctx.state.folderFilterID = null;
    renderManager(ctx);
    return;
  }

  if (ctx.state.selectedFolderIDs.has(folderID)) {
    ctx.state.selectedFolderIDs.delete(folderID);
  } else {
    ctx.state.selectedFolderIDs.add(folderID);
  }

  if (ctx.state.selectedFolderIDs.size === 1) {
    ctx.state.moveTargetFolderID =
      Array.from(ctx.state.selectedFolderIDs)[0] || null;
  }
  renderManager(ctx);
}

function createFolderButton(
  doc: Document,
  options: {
    label: string;
    active: boolean;
    selected: boolean;
    locked: boolean;
    isMoveTarget: boolean;
    onClick: (ev: MouseEvent) => void;
  },
) {
  const btn = createHTMLElement(doc, "button");
  btn.type = "button";
  btn.style.width = "100%";
  btn.style.textAlign = "left";
  btn.style.padding = "7px 9px";
  btn.style.borderRadius = "6px";
  btn.style.border = options.active ? "1px solid #3b82f6" : "1px solid #dbe3ef";
  btn.style.background = options.active
    ? "#eff6ff"
    : options.selected
      ? "#f1f5f9"
      : "#fff";
  btn.style.color = "#111827";
  btn.style.cursor = "pointer";
  btn.style.fontSize = "12px";
  btn.style.fontWeight = options.active ? "600" : "500";
  btn.style.display = "flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "space-between";
  btn.style.gap = "6px";
  btn.style.transition = "background-color 120ms ease, border-color 120ms ease";

  const label = createHTMLElement(doc, "span");
  label.textContent = options.label;
  btn.appendChild(label);

  const badges: string[] = [];
  if (options.locked) badges.push("固定");
  if (options.isMoveTarget) badges.push("目标");
  if (options.selected) badges.push("已选");
  if (badges.length) {
    const badge = createHTMLElement(doc, "span");
    badge.textContent = badges.join(" · ");
    badge.style.fontSize = "10px";
    badge.style.color = options.active ? "#1d4ed8" : "#475569";
    badge.style.background = options.active ? "#dbeafe" : "#f1f5f9";
    badge.style.border = "1px solid #dbeafe";
    badge.style.borderRadius = "999px";
    badge.style.padding = "1px 6px";
    btn.appendChild(badge);
  }

  btn.addEventListener("click", options.onClick);
  return btn;
}

function renderTableHeader(ctx: ManagerContext, columns: TableColumnSpec[]) {
  const refs = ctx.refs;
  if (!refs) return;
  const doc = refs.tableHeadRow.ownerDocument!;
  refs.tableHeadRow.innerHTML = "";
  columns.forEach((column, idx) => {
    const width = getTableColumnWidth(column);
    const th = createEl(doc, "th", {
      text: column.label,
      style: {
        position: "sticky",
        top: "0",
        zIndex: "1",
        background: "#f3f4f6",
        borderBottom: "1px solid #e2e8f0",
        textAlign: column.align || (idx === 0 ? "center" : "left"),
        padding: "6px 8px",
        whiteSpace: "nowrap",
        color: "#334155",
        fontWeight: "600",
        boxSizing: "border-box",
      },
    });
    th.style.width = `${width}px`;
    th.style.minWidth = `${width}px`;
    th.style.maxWidth = `${width}px`;
    refs.tableHeadRow.appendChild(th);
  });
}

function syncTableSizing(ctx: ManagerContext, columns: TableColumnSpec[]) {
  const refs = ctx.refs;
  if (!refs) return;
  const preferredWidth = getPreferredTableWidth(columns);
  if (ctx.state.viewMode === "literature") {
    const width = Math.max(DEFAULT_TABLE_MIN_WIDTH, preferredWidth);
    refs.table.style.width = `${width}px`;
    refs.table.style.minWidth = `${width}px`;
    refs.table.style.maxWidth = "none";
    refs.table.style.tableLayout = "fixed";
    return;
  }
  const width = Math.max(COMPACT_TABLE_MIN_WIDTH, preferredWidth);
  refs.table.style.width = `${width}px`;
  refs.table.style.minWidth = `${width}px`;
  refs.table.style.maxWidth = "none";
  refs.table.style.tableLayout = "fixed";
}

function getPreferredTableWidth(columns: TableColumnSpec[]) {
  return columns.reduce(
    (total, column) => total + getTableColumnWidth(column),
    0,
  );
}

function getTableColumnWidth(column: TableColumnSpec) {
  const fallback = column.key === "__select__" ? 64 : 220;
  const width = Number(column.maxWidth);
  if (!Number.isFinite(width) || width <= 0) {
    return fallback;
  }
  if (column.key === "__select__") {
    return Math.max(56, Math.floor(width));
  }
  return Math.max(96, Math.floor(width));
}

function getCurrentTableColumns(ctx: ManagerContext): TableColumnSpec[] {
  if (ctx.state.viewMode === "folderSummary") {
    return getFolderSummaryTableColumns();
  }
  return getLiteratureTableColumns(ctx.state.literaturePromptFieldKeys);
}

function getLiteratureTableColumns(
  promptFieldKeys: ReviewPromptFieldKey[],
): TableColumnSpec[] {
  const fields = normalizeLiteraturePromptFieldKeys(promptFieldKeys);
  const orderedFields: ReviewPromptFieldKey[] = fields.length
    ? fields
    : ["title", "authors", "journal", "publicationDate", "classificationTags"];
  if (!orderedFields.includes("title")) {
    orderedFields.unshift("title");
  }

  const contentColumns = orderedFields
    .map((key) => buildLiteratureFieldColumn(key))
    .filter((col): col is TableColumnSpec => Boolean(col));

  contentColumns.push({
    key: "folder",
    label: "文件夹",
    maxWidth: 220,
    renderCell: (_ctx, row) => getRecordFolderLabel(row),
  });
  contentColumns.push({
    key: "updatedAt",
    label: "更新时间",
    maxWidth: 160,
    renderCell: (_ctx, row) => formatTime(row.updatedAt),
  });

  return [buildSelectionColumn(), ...contentColumns];
}

function getFolderSummaryTableColumns(): TableColumnSpec[] {
  return [
    buildSelectionColumn(),
    {
      key: "title",
      label: "标题",
      maxWidth: 420,
      renderCell: (_ctx, row) =>
        truncateAdaptive(row.title, 60, 420) || "(无标题)",
    },
    {
      key: "sourceRecordCount",
      label: "来源数",
      align: "center",
      maxWidth: 80,
      renderCell: (_ctx, row) => String((row.sourceRecordIDs || []).length),
    },
    {
      key: "folder",
      label: "文件夹",
      maxWidth: 220,
      renderCell: (_ctx, row) => getRecordFolderLabel(row),
    },
    {
      key: "updatedAt",
      label: "更新时间",
      maxWidth: 160,
      renderCell: (_ctx, row) => formatTime(row.updatedAt),
    },
  ];
}

function normalizeLiteraturePromptFieldKeys(
  promptFieldKeys: ReviewPromptFieldKey[],
) {
  const supported: ReviewPromptFieldKey[] = [
    "title",
    "authors",
    "journal",
    "publicationDate",
    "abstract",
    "researchBackground",
    "literatureReview",
    "researchMethods",
    "researchConclusions",
    "keyFindings",
    "classificationTags",
    "pdfAnnotationNotesText",
  ];
  const allowed = new Set(supported);
  const keys = (promptFieldKeys || []).filter((key) => allowed.has(key));
  return Array.from(new Set(keys));
}

function buildSelectionColumn(): TableColumnSpec {
  return {
    key: "__select__",
    label: "选中",
    align: "center",
    maxWidth: 64,
    renderCell: (ctx, row, rowIndex) => {
      const checkbox = createHTMLElement(
        ctx.refs!.tableBody.ownerDocument!,
        "input",
      );
      checkbox.type = "checkbox";
      checkbox.checked = ctx.state.selectedRecordIDs.has(row.id);
      checkbox.addEventListener("click", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        applyRecordSelectionByEvent(
          ctx,
          row.id,
          rowIndex,
          ev as MouseEvent,
          "checkbox",
        );
        renderManager(ctx);
      });
      return checkbox;
    },
  };
}

function buildLiteratureFieldColumn(
  fieldKey: ReviewPromptFieldKey,
): TableColumnSpec | null {
  switch (fieldKey) {
    case "title":
      return {
        key: "title",
        label: "标题",
        maxWidth: 420,
        renderCell: (ctx, row) => createRecordTitleCell(ctx, row),
      };
    case "authors":
      return {
        key: "authors",
        label: "作者",
        maxWidth: 220,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.authors, 48, 220),
      };
    case "journal":
      return {
        key: "journal",
        label: "期刊",
        maxWidth: 220,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.journal, 40, 220),
      };
    case "publicationDate":
      return {
        key: "publicationDate",
        label: "时间",
        maxWidth: 120,
        renderCell: (_ctx, row) => row.publicationDate || "",
      };
    case "abstract":
      return {
        key: "abstract",
        label: "摘要",
        maxWidth: 420,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.abstractText, 120, 420),
      };
    case "researchBackground":
      return {
        key: "researchBackground",
        label: "研究背景",
        maxWidth: 420,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.researchBackground, 120, 420),
      };
    case "literatureReview":
      return {
        key: "literatureReview",
        label: "文献综述",
        maxWidth: 420,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.literatureReview, 120, 420),
      };
    case "researchMethods":
      return {
        key: "researchMethods",
        label: "研究方法",
        maxWidth: 360,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.researchMethods, 110, 360),
      };
    case "researchConclusions":
      return {
        key: "researchConclusions",
        label: "研究结论",
        maxWidth: 360,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(ctx, row.researchConclusions, 110, 360),
      };
    case "keyFindings":
      return {
        key: "keyFindings",
        label: "关键发现",
        maxWidth: 360,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(
            ctx,
            (row.keyFindings || []).join("；"),
            110,
            360,
          ),
      };
    case "classificationTags":
      return {
        key: "classificationTags",
        label: "标签",
        maxWidth: 260,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(
            ctx,
            row.classificationTags.join(", "),
            72,
            260,
          ),
      };
    case "pdfAnnotationNotesText":
      return {
        key: "pdfAnnotationNotesText",
        label: "PDF批注",
        maxWidth: 360,
        renderCell: (ctx, row) =>
          formatLiteratureCellText(
            ctx,
            String(row.pdfAnnotationNotesText || ""),
            110,
            360,
          ),
      };
    default:
      return null;
  }
}

function formatLiteratureCellText(
  _ctx: ManagerContext,
  text: string,
  limit: number,
  maxWidth: number,
) {
  return truncateAdaptive(text, limit, maxWidth);
}

function createRecordTitleCell(ctx: ManagerContext, row: ReviewRecordRow) {
  const doc = ctx.refs!.tableBody.ownerDocument!;
  const titleText = truncateAdaptive(row.title, 60, 420) || "(无标题)";
  if (row.recordType === "folderSummary") {
    return titleText;
  }
  const titleLink = createHTMLElement(doc, "a");
  titleLink.href = "#";
  titleLink.textContent = titleText;
  titleLink.title = row.title;
  titleLink.style.color = "#1d4ed8";
  titleLink.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    focusZoteroItem(row.zoteroItemID);
  });
  return titleLink;
}

function renderTableBody(ctx: ManagerContext, columns: TableColumnSpec[]) {
  const refs = ctx.refs;
  if (!refs) return;
  const { state } = ctx;
  const doc = refs.tableBody.ownerDocument!;

  refs.tableBody.innerHTML = "";

  if (!state.rows.length) {
    const tr = createHTMLElement(doc, "tr");
    const td = createHTMLElement(doc, "td");
    td.colSpan = Math.max(1, columns.length);
    td.textContent =
      state.viewMode === "folderSummary"
        ? "暂无合并综述记录。请先在左侧选择文件夹并执行“合并综述”。"
        : "暂无文献记录。请先右键条目执行 AI 提炼并保存结果。";
    td.style.padding = "12px";
    td.style.color = "#6b7280";
    tr.appendChild(td);
    refs.tableBody.appendChild(tr);
    return;
  }

  state.rows.forEach((row, rowIndex) => {
    const tr = createHTMLElement(doc, "tr");
    tr.style.borderBottom = "1px solid #f1f5f9";
    const baseBackground = state.selectedRecordIDs.has(row.id)
      ? "#e8f1ff"
      : rowIndex % 2 === 0
        ? "#ffffff"
        : "#f8fafc";
    tr.style.background = baseBackground;
    tr.style.borderLeft = state.selectedRecordIDs.has(row.id)
      ? "2px solid #3b82f6"
      : "2px solid transparent";
    tr.style.transition = "background-color 120ms ease";

    columns.forEach((column) => {
      const applyLiteratureTextMode =
        ctx.state.viewMode === "literature" && column.key !== "__select__";
      const width = getTableColumnWidth(column);
      appendCell(tr, column.renderCell(ctx, row, rowIndex), {
        align: column.align || "left",
        width,
        maxWidth: column.maxWidth,
        nowrap: applyLiteratureTextMode ? true : undefined,
      });
    });

    tr.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      const tag = String(target?.tagName || "").toLowerCase();
      if (["input", "a", "button", "select", "textarea"].includes(tag)) return;
      applyRecordSelectionByEvent(
        ctx,
        row.id,
        rowIndex,
        ev as MouseEvent,
        "row",
      );
      renderManager(ctx);
    });

    tr.addEventListener("mouseenter", () => {
      if (!ctx.state.selectedRecordIDs.has(row.id)) {
        tr.style.background = "#eef4ff";
      }
    });

    tr.addEventListener("mouseleave", () => {
      const selected = ctx.state.selectedRecordIDs.has(row.id);
      tr.style.background = selected
        ? "#e8f1ff"
        : rowIndex % 2 === 0
          ? "#ffffff"
          : "#f8fafc";
      tr.style.borderLeft = selected
        ? "2px solid #3b82f6"
        : "2px solid transparent";
    });

    refs.tableBody.appendChild(tr);
  });
}

function renderPreview(ctx: ManagerContext) {
  const refs = ctx.refs;
  if (!refs) return;
  const row = getPrimarySelectedRow(ctx);
  if (!row) {
    refs.preview.value = "请从表格中选择一条记录查看详细内容。";
    return;
  }

  refs.preview.value = [
    `类型: ${getRecordTypeLabel(row.recordType)}`,
    `标题: ${row.title}`,
    `作者: ${row.authors}`,
    `期刊: ${row.journal}`,
    `发布时间: ${row.publicationDate}`,
    `文件夹: ${getRecordFolderLabel(row)}`,
    `标签: ${row.classificationTags.join(", ")}`,
    "",
    "摘要:",
    row.abstractText || "",
    "",
    "研究背景:",
    row.researchBackground || "",
    "",
    "文献综述:",
    row.literatureReview || "",
    "",
    "研究方法:",
    row.researchMethods || "",
    "",
    "研究结论:",
    row.researchConclusions || "",
    "",
    "关键发现:",
    ...(row.keyFindings.length
      ? row.keyFindings.map((v, i) => `${i + 1}. ${v}`)
      : ["（无）"]),
    "",
    "来源文献记录ID:",
    (row.sourceRecordIDs || []).length
      ? row.sourceRecordIDs.join(", ")
      : "（无）",
    "来源文献条目ID:",
    (row.sourceZoteroItemIDs || []).length
      ? row.sourceZoteroItemIDs.join(", ")
      : "（无）",
    "",
    "PDF批注与笔记:",
    String(row.pdfAnnotationNotesText || "").trim() || "（无）",
  ].join("\n");
}

function getPrimarySelectedRow(ctx: ManagerContext) {
  for (const row of ctx.state.rows) {
    if (ctx.state.selectedRecordIDs.has(row.id)) {
      return row;
    }
  }
  return null;
}

function resolveMoveTargetFolderID(ctx: ManagerContext) {
  if (
    ctx.state.moveTargetFolderID &&
    Number.isFinite(ctx.state.moveTargetFolderID)
  ) {
    return ctx.state.moveTargetFolderID;
  }
  const fromLeftSelection = Array.from(ctx.state.selectedFolderIDs).filter(
    Boolean,
  );
  if (fromLeftSelection.length === 1) {
    return fromLeftSelection[0];
  }
  return null;
}

function resolveFolderForSummary(ctx: ManagerContext): ReviewFolderRow | null {
  if (ctx.state.folderFilterID != null) {
    return (
      ctx.state.folders.find((f) => f.id === ctx.state.folderFilterID) || null
    );
  }
  const selected = Array.from(ctx.state.selectedFolderIDs);
  if (selected.length === 1) {
    return ctx.state.folders.find((f) => f.id === selected[0]) || null;
  }
  return null;
}

function resolveFolderForRecordRemoval(
  ctx: ManagerContext,
): ReviewFolderRow | null {
  if (ctx.state.folderFilterID != null) {
    return (
      ctx.state.folders.find((f) => f.id === ctx.state.folderFilterID) || null
    );
  }
  const selected = Array.from(ctx.state.selectedFolderIDs);
  if (selected.length === 1) {
    return ctx.state.folders.find((f) => f.id === selected[0]) || null;
  }
  return null;
}

function cycleSortKey(
  current: ManagerState["sortKey"],
): ManagerState["sortKey"] {
  const order: ManagerState["sortKey"][] = [
    "updatedAt",
    "publicationDate",
    "title",
    "journal",
  ];
  const index = order.indexOf(current);
  if (index < 0) return order[0];
  return order[(index + 1) % order.length];
}

function getTotalPages(totalRows: number, pageSize: number) {
  const safeSize = Math.max(1, Math.floor(pageSize || 1));
  const safeTotal = Math.max(0, Math.floor(totalRows || 0));
  return Math.max(1, Math.ceil(safeTotal / safeSize));
}

function switchManagerView(
  ctx: ManagerContext,
  nextViewMode: ManagerState["viewMode"],
) {
  if (ctx.state.viewMode === nextViewMode) return;
  ctx.state.viewMode = nextViewMode;
  ctx.state.page = 1;
  ctx.state.selectedRecordIDs.clear();
  ctx.state.selectionAnchorRecordID = null;
  void refreshAndRender(ctx);
}

function syncViewButtonState(btn: HTMLButtonElement, active: boolean) {
  btn.dataset.active = active ? "1" : "0";
  btn.style.background = active ? "#eff6ff" : "#fff";
  btn.style.color = active ? "#1d4ed8" : "#111827";
  btn.style.fontWeight = active ? "600" : "400";
}

function getViewModeLabel(viewMode: ManagerState["viewMode"]) {
  return viewMode === "folderSummary" ? "合并综述" : "文献记录";
}

function getSortKeyLabel(sortKey: ManagerState["sortKey"]) {
  switch (sortKey) {
    case "title":
      return "标题";
    case "publicationDate":
      return "发表时间";
    case "journal":
      return "期刊";
    case "updatedAt":
    default:
      return "更新时间";
  }
}

function getRecordTypeLabel(recordType: ReviewRecordRow["recordType"]) {
  return recordType === "folderSummary" ? "合并综述" : "文献记录";
}

function isProtectedFolderName(name: string) {
  return String(name || "").trim() === "未分类";
}

function getRecordFolderLabel(
  row: Pick<ReviewRecordRow, "folderNames" | "folderName">,
) {
  if (Array.isArray(row.folderNames) && row.folderNames.length) {
    return row.folderNames.join("、");
  }
  return row.folderName || "未分类";
}

async function openRawRecordEditorDialog(
  ctx: ManagerContext,
  row: ReviewRecordRow,
) {
  const prettyRaw = tryPrettyJSON(row.rawAIResponse || "");
  const dialogData: Record<string, any> = {
    rawText: prettyRaw,
    loadCallback: () => {
      try {
        helper?.window?.document?.documentElement?.setAttribute("width", "900");
        helper?.window?.document?.documentElement?.setAttribute(
          "height",
          "700",
        );
      } catch {
        // ignore
      }
    },
  };

  const dialog = new ztoolkit.Dialog(4, 2)
    .addCell(0, 0, {
      tag: "h2",
      properties: { innerHTML: "原始记录（可编辑）" },
      styles: { margin: "0", fontSize: "16px" },
    })
    .addCell(
      0,
      1,
      {
        tag: "div",
        namespace: "html",
        properties: {
          innerHTML: `${truncate(row.title, 28)} · ${getRecordFolderLabel(row)}`,
        },
        styles: {
          fontSize: "12px",
          color: "#475569",
          textAlign: "right",
          paddingTop: "4px",
        },
      },
      false,
    )
    .addCell(1, 0, {
      tag: "label",
      namespace: "html",
      properties: { innerHTML: "内容" },
      styles: { fontSize: "12px", paddingTop: "6px", verticalAlign: "top" },
    })
    .addCell(
      1,
      1,
      {
        tag: "textarea",
        namespace: "html",
        attributes: {
          rows: "26",
          "data-bind": "rawText",
          "data-prop": "value",
        },
        styles: {
          width: "100%",
          minWidth: "760px",
          boxSizing: "border-box",
          fontSize: "12px",
          lineHeight: "1.45",
          resize: "vertical",
          padding: "8px",
        },
      },
      false,
    );

  const helper = dialog
    .addButton("保存", "save")
    .addButton("取消", "cancel")
    .setDialogData(dialogData)
    .open(`原始记录 - ${truncate(row.title, 24)}`);

  if (!dialogData.unloadLock?.promise) return;
  await dialogData.unloadLock.promise;
  if (dialogData._lastButtonId !== "save") return;

  const nextRaw = String(dialogData.rawText || "");
  await updateReviewRecordRawResponse(row.id, nextRaw);
  await refreshAndRender(ctx);
  showManagerToast("原始记录已保存");
}

async function openFolderSummaryDialog(
  folderName: string,
  summaryText: string,
  recordCount: number,
) {
  const dialogData: Record<string, any> = {
    summaryText: String(summaryText || "").trim(),
    loadCallback: () => {
      try {
        helper?.window?.document?.documentElement?.setAttribute("width", "920");
        helper?.window?.document?.documentElement?.setAttribute(
          "height",
          "760",
        );
      } catch {
        // ignore
      }
    },
  };

  const dialog = new ztoolkit.Dialog(4, 2)
    .addCell(0, 0, {
      tag: "h2",
      properties: { innerHTML: "文件夹合并综述结果" },
      styles: { margin: "0", fontSize: "16px" },
    })
    .addCell(
      0,
      1,
      {
        tag: "div",
        namespace: "html",
        properties: { innerHTML: `${folderName} · ${recordCount} 条记录` },
        styles: {
          fontSize: "12px",
          color: "#475569",
          textAlign: "right",
          paddingTop: "4px",
        },
      },
      false,
    )
    .addCell(1, 0, {
      tag: "label",
      namespace: "html",
      properties: { innerHTML: "综述内容" },
      styles: { fontSize: "12px", paddingTop: "6px", verticalAlign: "top" },
    })
    .addCell(
      1,
      1,
      {
        tag: "textarea",
        namespace: "html",
        attributes: {
          rows: "28",
          "data-bind": "summaryText",
          "data-prop": "value",
        },
        styles: {
          width: "100%",
          minWidth: "780px",
          boxSizing: "border-box",
          fontSize: "12px",
          lineHeight: "1.5",
          resize: "vertical",
          padding: "8px",
        },
      },
      false,
    );

  const helper = dialog
    .addButton("关闭", "close")
    .setDialogData(dialogData)
    .open(`合并综述 - ${truncate(folderName, 24)}`);

  if (dialogData.unloadLock?.promise) {
    await dialogData.unloadLock.promise.catch(() => undefined);
  }
}

function tryPrettyJSON(text: string) {
  const raw = String(text || "");
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function applyRecordSelectionByEvent(
  ctx: ManagerContext,
  rowID: number,
  rowIndex: number,
  ev: MouseEvent,
  source: "row" | "checkbox",
) {
  const state = ctx.state;
  const isRange = Boolean(ev.shiftKey);
  const isAdditive = Boolean(ev.ctrlKey || ev.metaKey);

  if (isRange) {
    const anchorID = state.selectionAnchorRecordID ?? rowID;
    const anchorIndex = state.rows.findIndex((row) => row.id === anchorID);
    const start = Math.min(anchorIndex >= 0 ? anchorIndex : rowIndex, rowIndex);
    const end = Math.max(anchorIndex >= 0 ? anchorIndex : rowIndex, rowIndex);
    const rangeIDs = state.rows.slice(start, end + 1).map((row) => row.id);
    if (isAdditive) {
      for (const id of rangeIDs) state.selectedRecordIDs.add(id);
    } else {
      state.selectedRecordIDs = new Set(rangeIDs);
    }
    state.selectionAnchorRecordID = rowID;
    return;
  }

  if (source === "checkbox" || isAdditive) {
    if (state.selectedRecordIDs.has(rowID)) {
      state.selectedRecordIDs.delete(rowID);
    } else {
      state.selectedRecordIDs.add(rowID);
    }
    state.selectionAnchorRecordID = rowID;
    return;
  }

  state.selectedRecordIDs = new Set([rowID]);
  state.selectionAnchorRecordID = rowID;
}

function appendCell(
  tr: HTMLTableRowElement,
  content: string | Node,
  options: {
    align?: string;
    width?: number;
    maxWidth?: number;
    nowrap?: boolean;
  },
) {
  const td = createHTMLElement(tr.ownerDocument!, "td");
  td.style.padding = "6px 8px";
  td.style.verticalAlign = "top";
  td.style.textAlign = options.align || "left";
  const maxWidth = Math.max(56, Number(options.maxWidth) || 280);
  const fixedWidth = Math.max(
    56,
    Math.floor(Number(options.width) || maxWidth),
  );
  td.style.width = `${fixedWidth}px`;
  td.style.minWidth = `${fixedWidth}px`;
  td.style.boxSizing = "border-box";
  td.style.maxWidth = `${fixedWidth}px`;
  td.style.overflow = "hidden";
  td.style.textOverflow = "ellipsis";
  td.style.whiteSpace = options.nowrap === false ? "normal" : "nowrap";
  if (options.nowrap === false) {
    td.style.textOverflow = "clip";
  }
  if (typeof content === "string") {
    td.textContent = content;
  } else {
    td.appendChild(content);
  }
  tr.appendChild(td);
}

function createButton(doc: Document, label: string) {
  const btn = createHTMLElement(doc, "button");
  btn.type = "button";
  btn.textContent = label;
  btn.dataset.active = "0";
  btn.style.height = "28px";
  btn.style.padding = "0 10px";
  btn.style.border = "1px solid #cbd5e1";
  btn.style.borderRadius = "6px";
  btn.style.background = "#fff";
  btn.style.cursor = "pointer";
  btn.style.fontSize = "12px";
  btn.style.color = "#0f172a";
  btn.style.transition =
    "background-color 120ms ease, border-color 120ms ease, color 120ms ease";
  btn.addEventListener("mouseenter", () => {
    if (
      btn.disabled ||
      btn.dataset.segmented === "1" ||
      btn.dataset.active === "1"
    ) {
      return;
    }
    btn.style.background = "#f8fafc";
    btn.style.borderColor = "#94a3b8";
  });
  btn.addEventListener("mouseleave", () => {
    if (
      btn.disabled ||
      btn.dataset.segmented === "1" ||
      btn.dataset.active === "1"
    ) {
      return;
    }
    btn.style.background = "#fff";
    btn.style.borderColor = "#cbd5e1";
  });
  btn.addEventListener("focus", () => {
    if (btn.dataset.segmented === "1" || btn.dataset.active === "1") return;
    btn.style.borderColor = "#93c5fd";
  });
  btn.addEventListener("blur", () => {
    if (btn.dataset.segmented === "1" || btn.dataset.active === "1") return;
    btn.style.borderColor = "#cbd5e1";
  });
  return btn;
}

function createEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  options: {
    text?: string;
    attrs?: Record<string, string>;
    style?: Partial<CSSStyleDeclaration>;
  } = {},
) {
  const el = createHTMLElement(doc, tag);
  if (options.text != null) el.textContent = options.text;
  if (options.attrs) {
    for (const [k, v] of Object.entries(options.attrs)) {
      el.setAttribute(k, v);
    }
  }
  if (options.style) {
    Object.assign(el.style, options.style);
  }
  return el;
}

function createHTMLElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
) {
  return doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
}

function truncate(text: string, limit: number) {
  const input = String(text || "");
  return input.length > limit ? `${input.slice(0, limit - 1)}…` : input;
}

function truncateAdaptive(text: string, baseLimit: number, maxWidth: number) {
  const input = String(text || "");
  if (!input) return "";

  const normalizedBase = Math.max(8, Math.floor(Number(baseLimit) || 8));
  const normalizedWidth = Math.max(120, Math.floor(Number(maxWidth) || 120));

  const widthFactor = clampNumber(
    normalizedWidth / TABLE_TRUNCATE_BASE_WIDTH,
    0.75,
    1.9,
  );

  let cjkCount = 0;
  let latinCount = 0;
  let whitespaceCount = 0;
  for (const ch of input) {
    if (isCJKCharacter(ch)) {
      cjkCount += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      whitespaceCount += 1;
      continue;
    }
    if (/[A-Za-z0-9]/.test(ch)) {
      latinCount += 1;
    }
  }

  const totalLength = Math.max(1, input.length);
  const cjkRatio = cjkCount / totalLength;
  const latinRatio = latinCount / totalLength;
  const whitespaceRatio = whitespaceCount / totalLength;
  const scriptFactor = cjkRatio >= 0.55 ? 0.96 : latinRatio >= 0.55 ? 1.16 : 1;
  const spacingFactor = whitespaceRatio >= 0.16 ? 1.12 : 1;
  const longTokenFactor = /\S{28,}/.test(input) ? 0.95 : 1;

  const adaptiveLimit = Math.round(
    normalizedBase *
      widthFactor *
      scriptFactor *
      spacingFactor *
      longTokenFactor,
  );
  const minLimit = Math.max(
    TABLE_TRUNCATE_MIN_SENTENCE_LENGTH,
    Math.floor(normalizedBase * TABLE_TRUNCATE_MIN_FACTOR),
  );
  const maxLimit = Math.max(
    minLimit + 8,
    Math.floor(normalizedBase * TABLE_TRUNCATE_MAX_FACTOR),
  );
  const rawLimit = clampNumber(adaptiveLimit, minLimit, maxLimit);
  const finalLimit = expandToSentenceBoundary(
    input,
    rawLimit,
    TABLE_TRUNCATE_BOUNDARY_WINDOW,
  );
  return truncate(input, finalLimit);
}

function expandToSentenceBoundary(
  text: string,
  limit: number,
  windowSize: number,
) {
  const input = String(text || "");
  if (input.length <= limit) return input.length;

  const start = Math.max(0, limit - 2);
  const end = Math.min(input.length - 1, limit + Math.max(0, windowSize));
  let secondaryBoundary = -1;
  for (let i = start; i <= end; i++) {
    const ch = input[i];
    if (/[。！？.!?]/.test(ch)) {
      return i + 1;
    }
    if (secondaryBoundary < 0 && /[；;，,]/.test(ch)) {
      secondaryBoundary = i + 1;
    }
  }
  if (secondaryBoundary > 0) return secondaryBoundary;
  return limit;
}

function isCJKCharacter(ch: string) {
  const code = ch.codePointAt(0) || 0;
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2ceaf)
  );
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(iso: string) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes(),
    ).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

function focusZoteroItem(itemID: number) {
  const wins = Zotero.getMainWindows?.() || [];
  const win = wins[0] as any;
  if (!win) {
    ztoolkit.getGlobal("alert")("无法定位条目：未找到 Zotero 主窗口");
    return;
  }
  try {
    win.focus();
    if (win.ZoteroPane?.selectItem) {
      void win.ZoteroPane.selectItem(itemID);
    }
  } catch (e) {
    ztoolkit.log("focusZoteroItem failed", e);
  }
}

function showManagerToast(
  text: string,
  type: "success" | "default" = "success",
) {
  new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({
      text,
      type,
      progress: 100,
    })
    .show();
}

async function writeTextFile(path: string, content: string) {
  const zFile = (Zotero as any).File;
  if (zFile?.putContentsAsync) {
    await zFile.putContentsAsync(path, content);
    return;
  }
  const ioUtils = (globalThis as any).IOUtils;
  if (ioUtils?.writeUTF8) {
    await ioUtils.writeUTF8(path, content);
    return;
  }
  throw new Error("当前环境不支持文件写入 API");
}
