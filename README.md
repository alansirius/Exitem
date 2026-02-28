# Zotero-Exitem

[![zotero target version](https://img.shields.io/badge/Zotero-7%20%7C%208-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero-Exitem is a Zotero plugin for AI-assisted literature extraction, review management, synthesis, and export.

[English](README.md) | [简体中文](doc/README-zhCN.md) | [Français](doc/README-frFR.md)

## Preview

![Plugin Preview](./doc/images/preview-icon.png)

## Prerequisites

- Zotero 7 or Zotero 8
- Installed and configured `zotero-gpt` plugin:
  - Project: https://github.com/MuiseDestiny/zotero-gpt
  - Setup guide (Chinese): https://zotero-chinese.com/user-guide/plugins/zotero-gpt
- For PDF-related processing, `zotero-gpt` must have both:
  - a main chat/completion model
  - an embedding model

## Installation

1. Download the `.xpi` package from this project release/build output.
2. In Zotero: `Tools` -> `Plugins` -> gear icon -> `Install Plugin From File...`
3. Select `zotero-exitem.xpi`.
4. Restart Zotero.

## Tutorial (Step by Step)

In a typical literature-review workflow, you can first run single-item extraction to generate an initial summary, read the paper with that summary, add highlights/annotations, and then run single-item extraction again. Highlighted text and annotation notes are automatically synced into AI extraction fields and used as synthesis sources, helping avoid missing key information in PDFs.

A full flow is: `Preferences setup` -> `Single/Batch extraction` -> `Review Manager` -> `Folder synthesis` -> `Edit and export`.

### 1. Check GPT connection and extraction input strategy first

- Go to `Settings -> Zotero-Exitem`.
- Confirm the GPT compatibility check shows connected.
- Configure extraction inputs based on your workflow: include PDF full text, include PDF annotations/annotation notes, and import annotation text into a dedicated field.
- Exitem prioritizes user-provided signals: PDF highlights and annotation notes are stored as key inputs and reused as synthesis sources.

![Preferences: connection check and extraction input controls](./doc/images/首先项-连接状态检查与传入参数控制界面.png)

### 2. Configure extraction prompt and folder-synthesis prompt

- Edit custom prompts in preferences (for both extraction and folder synthesis).
- After changing extraction prompt fields, click `Apply Prompt and Refresh Literature View` to sync table columns with your field definitions (beta feature).

![Preferences: custom prompts and refresh columns](./doc/images/首选项-自定义prompt与刷新列字段功能.png)

### 3. Single-item extraction

- In the Zotero main view, select one item and click `AI提炼文献内容` from the right-click menu.
- The plugin runs extraction through your configured `zotero-gpt` models.

![Single-item extraction entry](./doc/images/单条文献提取操作.png)

- After extraction, an editable result dialog opens before saving.
- You can save directly to an existing folder or create a new folder first.

![Single-item extraction result dialog (editable before save)](./doc/images/单条文献提取结果弹窗.png)

### 4. Batch extraction (up to 5 items per run)

- Multi-select items in Zotero, then click `AI提炼文献内容`.
- It is recommended to confirm selected items have usable metadata/PDFs before running.

![Batch extraction entry](./doc/images/批量文献提取操作.png)

### 5. Open Review Manager

- Click the Exitem icon in Zotero's top toolbar to open Review Manager.

![Open Review Manager](./doc/images/打开文献综述管理页面.png)

### 6. Review Manager basics

- Left panel: folders. Center: record list. Bottom: content preview.
- Top toolbar supports refresh, folder operations, record operations, locate item, view raw record, and export.

![Review Manager overview](./doc/images/文献综述管理界面展示.png)

### 7. Switch between "Literature Records" and "Folder Synthesis"

- Use the view toggle to switch between extracted records and synthesized records.

![Switch views: records/synthesis](./doc/images/切换视图.png)

### 8. Add records into a target folder

- Select records in `文献记录`.
- Select a folder on the left, then click `加入文件夹` for batch assignment.

![Add literature records to folder](./doc/images/将文献记录加入到文件夹.png)

### 9. Run folder synthesis

- Select a folder and click `合并综述`.
- By default, the plugin synthesizes all single-item records under that folder into one synthesis record.

![Run folder synthesis](./doc/images/合并综述操作.png)

### 10. View and edit raw records (both record types)

- Select a target record and click `查看原始记录`.
- You can copy and manually revise content before saving for reuse/export.

![Open raw-record editor from manager](./doc/images/查看原始记录并编辑.png)

![Raw-record editor](./doc/images/原始记录编辑界面.png)

### 11. Export results

- Click `导出表格` in Review Manager to export CSV under the current view/filter scope.

## Current Features

- Trigger extraction from Zotero item context menu: `AI提炼文献内容`
- Single-item extraction:
  - opens an editable result dialog before saving
  - supports selecting target folder or creating a new folder directly
- Batch extraction:
  - supports up to 5 items per run
  - auto-saves successful results to a folder and opens Review Manager
- Extraction input composition (configurable):
  - item metadata, abstract, notes
  - optional PDF full text
  - optional PDF annotations and annotation notes
  - optional import of PDF annotation text into an independent record field
- Prompt system:
  - custom literature extraction prompt
  - custom folder-synthesis prompt (`合并综述`)
  - preferences action to apply prompt and refresh literature-view columns
- Review Manager UI:
  - entry from toolbar button, with tab-first opening (dialog fallback)
  - dual view: `文献记录` and `合并综述`
  - fixed view switch controls and record detail preview panel
  - dynamic literature table columns parsed from extraction prompt field keys
- Folder and record management:
  - create/delete/merge folders
  - add/remove record-folder membership (supports multi-folder membership)
  - search, sort, pagination, multi-select, and bulk delete
  - jump to original Zotero item from literature records
- Synthesis and export:
  - folder-level synthesis (`合并综述`) with progress feedback
  - persisted summary records with source tracing (`sourceRecordIDs`, `sourceZoteroItemIDs`)
  - raw AI response viewer/editor
  - CSV export for current view/filter scope
- Storage:
  - independent JSON storage file in Zotero data directory: `exitem-review-store.json`
  - local event logging (for actions such as extraction, synthesis, export)

## Runtime Path

- AI calls are bridged through installed `zotero-gpt` runtime/configuration.
