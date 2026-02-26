import { config } from "../../package.json";
import { getReviewErrorMessage, synthesizeFolderReview } from "./reviewAI";
import type { ReviewExtractionProgress } from "./reviewAI";
import {
  assignReviewRecordsFolder,
  countReviewRecords,
  createReviewFolder,
  deleteReviewFolder,
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

interface ManagerState {
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
  searchInput: HTMLInputElement;
  sortKeyBtn: HTMLButtonElement;
  sortDirBtn: HTMLButtonElement;
  filterStatusText: HTMLSpanElement;
  pagePrevBtn: HTMLButtonElement;
  pageNextBtn: HTMLButtonElement;
  pageInfoText: HTMLSpanElement;
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
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
  const root = createHTMLElement(doc, "div");
  root.id = REVIEW_MANAGER_ROOT_ID;
  Object.assign(root.style, {
    width: "100%",
    height: "100%",
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
        width: "1200px",
        height: "760px",
        minWidth: "960px",
        minHeight: "640px",
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

async function refreshAndRender(ctx: ManagerContext) {
  await refreshManagerData(ctx);
  renderManager(ctx);
}

async function refreshManagerData(ctx: ManagerContext) {
  const { state } = ctx;
  state.folders = await listReviewFolders();
  state.totalRows = await countReviewRecords({
    search: state.search,
    folderID: state.folderFilterID,
  });
  const totalPages = getTotalPages(state.totalRows, state.pageSize);
  state.page = Math.min(Math.max(1, state.page), totalPages);
  state.rows = await listReviewRecords({
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
  const root = doc.getElementById(REVIEW_MANAGER_ROOT_ID) as HTMLDivElement | null;
  if (!root) {
    throw new Error("review manager root not found");
  }

  root.innerHTML = "";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "8px";
  root.style.padding = "10px";
  root.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

  const titleRow = createEl(doc, "div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
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
      color: "#4b5563",
    },
  });
  titleRow.append(titleText, statusText);

  const toolbar = createEl(doc, "div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: "8px",
      alignItems: "center",
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
      border: "1px solid #d1d5db",
      borderRadius: "4px",
      padding: "0 8px",
      fontSize: "12px",
      boxSizing: "border-box",
    },
  }) as HTMLInputElement;

  const sortKeyBtn = createButton(doc, "排序：更新时间");
  const sortDirBtn = createButton(doc, "降序");
  const filterStatusText = createEl(doc, "span", {
    text: "筛选：全部文件夹",
    style: {
      fontSize: "12px",
      color: "#4b5563",
      whiteSpace: "nowrap",
    },
  }) as HTMLSpanElement;
  const pagePrevBtn = createButton(doc, "上一页");
  const pageNextBtn = createButton(doc, "下一页");
  const pageInfoText = createEl(doc, "span", {
    text: "第 1/1 页",
    style: {
      fontSize: "12px",
      color: "#4b5563",
      whiteSpace: "nowrap",
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
    },
  });

  const btnRefresh = createButton(doc, "刷新");
  const btnCreateFolder = createButton(doc, "新建文件夹");
  const btnDeleteFolder = createButton(doc, "删除文件夹");
  const btnMergeFolder = createButton(doc, "合并文件夹");
  const btnFolderSummary = createButton(doc, "合并综述");
  const btnMoveSelected = createButton(doc, "加入文件夹");
  const btnRemoveSelected = createButton(doc, "移出文件夹");
  const btnSelectAll = createButton(doc, "全选");
  const btnClearSelection = createButton(doc, "清空选择");
  const btnOpenItem = createButton(doc, "定位条目");
  const btnPreviewRaw = createButton(doc, "查看原始记录");
  const btnExport = createButton(doc, "导出表格");
  const selectionText = createEl(doc, "span", {
    text: "未选择",
    style: { fontSize: "12px", color: "#4b5563" },
  });

  actionBar.append(
    btnRefresh,
    btnCreateFolder,
    btnDeleteFolder,
    btnMergeFolder,
    btnFolderSummary,
    btnMoveSelected,
    btnRemoveSelected,
    btnSelectAll,
    btnClearSelection,
    btnOpenItem,
    btnPreviewRaw,
    btnExport,
    selectionText,
  );

  const content = createEl(doc, "div", {
    style: {
      display: "grid",
      gridTemplateColumns: "240px 1fr",
      gap: "8px",
      flex: "1",
      minHeight: "0",
    },
  });

  const leftPane = createEl(doc, "div", {
    style: {
      border: "1px solid #d1d5db",
      borderRadius: "6px",
      padding: "8px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      minHeight: "0",
      background: "#f9fafb",
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
      gridTemplateRows: "1fr 180px",
      gap: "8px",
      minHeight: "0",
    },
  });

  const tableWrap = createEl(doc, "div", {
    style: {
      border: "1px solid #d1d5db",
      borderRadius: "6px",
      overflow: "auto",
      background: "#fff",
      minHeight: "0",
    },
  });

  const table = createEl(doc, "table", {
    style: {
      width: "100%",
      borderCollapse: "collapse",
      fontSize: "12px",
    },
  }) as HTMLTableElement;

  const thead = createEl(doc, "thead") as HTMLTableSectionElement;
  const headRow = createEl(doc, "tr") as HTMLTableRowElement;
  [
    "选中",
    "标题",
    "作者",
    "期刊",
    "时间",
    "文件夹",
    "标签",
    "更新时间",
  ].forEach((text, idx) => {
    const th = createEl(doc, "th", {
      text,
      style: {
        position: "sticky",
        top: "0",
        zIndex: "1",
        background: "#f3f4f6",
        borderBottom: "1px solid #e5e7eb",
        textAlign: idx === 0 ? "center" : "left",
        padding: "6px 8px",
        whiteSpace: "nowrap",
      },
    });
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const tableBody = createEl(doc, "tbody") as HTMLTableSectionElement;
  table.append(thead, tableBody);
  tableWrap.appendChild(table);

  const previewWrap = createEl(doc, "div", {
    style: {
      border: "1px solid #d1d5db",
      borderRadius: "6px",
      padding: "8px",
      display: "grid",
      gridTemplateRows: "auto 1fr",
      gap: "6px",
      minHeight: "0",
      background: "#fff",
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
      fontSize: "12px",
      lineHeight: "1.45",
      boxSizing: "border-box",
      border: "1px solid #e5e7eb",
      borderRadius: "4px",
      padding: "8px",
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
    searchInput,
    sortKeyBtn,
    sortDirBtn,
    filterStatusText,
    pagePrevBtn,
    pageNextBtn,
    pageInfoText,
    tableBody,
    preview,
    selectionText,
  };

  searchInput.addEventListener("input", () => {
    ctx.state.search = searchInput.value.trim();
    ctx.state.page = 1;
    void refreshAndRender(ctx);
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
        win.alert(`系统文件夹不可删除：${locked.map((f) => f.name).join("、")}`);
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
        model_type: `${result.provider}:${result.model}`,
      }).catch((e) => ztoolkit.log(e));
      await openFolderSummaryDialog(targetFolder.name, result.text, allRows.length);
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
        ctx.state.folders.find((folder) => folder.id === targetFolderID)?.name ||
        "目标文件夹";
      const hiddenByFilter =
        ctx.state.folderFilterID != null && ctx.state.folderFilterID !== targetFolderID;
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
      const normalizedPath = String(path).endsWith(".csv") ? String(path) : `${path}.csv`;
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

  refs.searchInput.value = state.search;
  refs.sortKeyBtn.textContent = `排序：${getSortKeyLabel(state.sortKey)}`;
  refs.sortDirBtn.textContent = state.sortDir === "desc" ? "降序" : "升序";
  refs.filterStatusText.textContent = `筛选：${
    state.folderFilterID == null
      ? "全部文件夹"
      : (state.folders.find((f) => f.id === state.folderFilterID)?.name || "已选文件夹")
  } · 目标：${
    state.moveTargetFolderID == null
      ? "未设置"
      : (state.folders.find((f) => f.id === state.moveTargetFolderID)?.name || "已选文件夹")
  }`;
  const totalPages = getTotalPages(state.totalRows, state.pageSize);
  refs.pageInfoText.textContent = `第 ${Math.min(state.page, totalPages)}/${totalPages} 页 · 共 ${state.totalRows} 条`;
  refs.pagePrevBtn.disabled = state.page <= 1;
  refs.pageNextBtn.disabled = state.page >= totalPages;
  refs.pagePrevBtn.style.opacity = refs.pagePrevBtn.disabled ? "0.5" : "1";
  refs.pageNextBtn.style.opacity = refs.pageNextBtn.disabled ? "0.5" : "1";
  refs.pagePrevBtn.style.cursor = refs.pagePrevBtn.disabled ? "default" : "pointer";
  refs.pageNextBtn.style.cursor = refs.pageNextBtn.disabled ? "default" : "pointer";

  renderFolderButtons(ctx);

  refs.statusText.textContent = `${state.folders.length} 个文件夹 · 当前页 ${state.rows.length} 条 / 共 ${state.totalRows} 条`;
  refs.selectionText.textContent = state.selectedRecordIDs.size
    ? `已选 ${state.selectedRecordIDs.size} 条`
    : "未选择";

  renderTableBody(ctx);
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
    ctx.state.moveTargetFolderID = Array.from(ctx.state.selectedFolderIDs)[0] || null;
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
  btn.style.padding = "6px 8px";
  btn.style.borderRadius = "6px";
  btn.style.border = options.active ? "1px solid #3b82f6" : "1px solid #d1d5db";
  btn.style.background = options.active ? "#eff6ff" : options.selected ? "#f8fafc" : "#fff";
  btn.style.color = "#111827";
  btn.style.cursor = "pointer";
  btn.style.fontSize = "12px";
  btn.style.display = "flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "space-between";
  btn.style.gap = "6px";

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
    badge.style.color = options.active ? "#1d4ed8" : "#64748b";
    btn.appendChild(badge);
  }

  btn.addEventListener("click", options.onClick);
  return btn;
}

function renderTableBody(ctx: ManagerContext) {
  const refs = ctx.refs;
  if (!refs) return;
  const { state } = ctx;
  const doc = refs.tableBody.ownerDocument!;

  refs.tableBody.innerHTML = "";

  if (!state.rows.length) {
    const tr = createHTMLElement(doc, "tr");
    const td = createHTMLElement(doc, "td");
    td.colSpan = 8;
    td.textContent = "暂无数据。请先右键条目执行 AI 提炼并保存结果。";
    td.style.padding = "12px";
    td.style.color = "#6b7280";
    tr.appendChild(td);
    refs.tableBody.appendChild(tr);
    return;
  }

  state.rows.forEach((row, rowIndex) => {
    const tr = createHTMLElement(doc, "tr");
    tr.style.borderBottom = "1px solid #f1f5f9";
    tr.style.background = state.selectedRecordIDs.has(row.id) ? "#eff6ff" : "#fff";

    const checkbox = createHTMLElement(doc, "input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedRecordIDs.has(row.id);
    checkbox.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      applyRecordSelectionByEvent(ctx, row.id, rowIndex, ev as MouseEvent, "checkbox");
      renderManager(ctx);
    });

    appendCell(tr, checkbox, { align: "center" });

    const titleLink = createHTMLElement(doc, "a");
    titleLink.href = "#";
    titleLink.textContent = truncate(row.title, 60) || "(无标题)";
    titleLink.title = row.title;
    titleLink.style.color = "#1d4ed8";
    titleLink.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      focusZoteroItem(row.zoteroItemID);
    });
    appendCell(tr, titleLink);

    appendCell(tr, truncate(row.authors, 40));
    appendCell(tr, truncate(row.journal, 28));
    appendCell(tr, row.publicationDate || "");
    appendCell(tr, getRecordFolderLabel(row));
    appendCell(tr, truncate(row.classificationTags.join(", "), 32));
    appendCell(tr, formatTime(row.updatedAt));

    tr.addEventListener("click", (ev) => {
      const target = ev.target as HTMLElement;
      const tag = String(target?.tagName || "").toLowerCase();
      if (["input", "a", "button", "select", "textarea"].includes(tag)) return;
      applyRecordSelectionByEvent(ctx, row.id, rowIndex, ev as MouseEvent, "row");
      renderManager(ctx);
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
    ...(row.keyFindings.length ? row.keyFindings.map((v, i) => `${i + 1}. ${v}`) : ["（无）"]),
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
  if (ctx.state.moveTargetFolderID && Number.isFinite(ctx.state.moveTargetFolderID)) {
    return ctx.state.moveTargetFolderID;
  }
  const fromLeftSelection = Array.from(ctx.state.selectedFolderIDs).filter(Boolean);
  if (fromLeftSelection.length === 1) {
    return fromLeftSelection[0];
  }
  return null;
}

function resolveFolderForSummary(ctx: ManagerContext): ReviewFolderRow | null {
  if (ctx.state.folderFilterID != null) {
    return ctx.state.folders.find((f) => f.id === ctx.state.folderFilterID) || null;
  }
  const selected = Array.from(ctx.state.selectedFolderIDs);
  if (selected.length === 1) {
    return ctx.state.folders.find((f) => f.id === selected[0]) || null;
  }
  return null;
}

function resolveFolderForRecordRemoval(ctx: ManagerContext): ReviewFolderRow | null {
  if (ctx.state.folderFilterID != null) {
    return ctx.state.folders.find((f) => f.id === ctx.state.folderFilterID) || null;
  }
  const selected = Array.from(ctx.state.selectedFolderIDs);
  if (selected.length === 1) {
    return ctx.state.folders.find((f) => f.id === selected[0]) || null;
  }
  return null;
}

function cycleSortKey(current: ManagerState["sortKey"]): ManagerState["sortKey"] {
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

function isProtectedFolderName(name: string) {
  return String(name || "").trim() === "未分类";
}

function getRecordFolderLabel(row: Pick<ReviewRecordRow, "folderNames" | "folderName">) {
  if (Array.isArray(row.folderNames) && row.folderNames.length) {
    return row.folderNames.join("、");
  }
  return row.folderName || "未分类";
}

async function openRawRecordEditorDialog(ctx: ManagerContext, row: ReviewRecordRow) {
  let helper: any;
  const prettyRaw = tryPrettyJSON(row.rawAIResponse || "");
  const dialogData: Record<string, any> = {
    rawText: prettyRaw,
    loadCallback: () => {
      try {
        helper?.window?.document?.documentElement?.setAttribute("width", "900");
        helper?.window?.document?.documentElement?.setAttribute("height", "700");
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

  helper = dialog
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
  let helper: any;
  const dialogData: Record<string, any> = {
    summaryText: String(summaryText || "").trim(),
    loadCallback: () => {
      try {
        helper?.window?.document?.documentElement?.setAttribute("width", "920");
        helper?.window?.document?.documentElement?.setAttribute("height", "760");
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

  helper = dialog
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
  options: { align?: string } = {},
) {
  const td = createHTMLElement(tr.ownerDocument!, "td");
  td.style.padding = "6px 8px";
  td.style.verticalAlign = "top";
  td.style.textAlign = options.align || "left";
  td.style.maxWidth = "280px";
  td.style.overflow = "hidden";
  td.style.textOverflow = "ellipsis";
  td.style.whiteSpace = "nowrap";
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
  btn.style.height = "28px";
  btn.style.padding = "0 10px";
  btn.style.border = "1px solid #d1d5db";
  btn.style.borderRadius = "4px";
  btn.style.background = "#fff";
  btn.style.cursor = "pointer";
  btn.style.fontSize = "12px";
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

function showManagerToast(text: string, type: "success" | "default" = "success") {
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
