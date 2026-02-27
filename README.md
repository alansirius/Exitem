# Zotero-Exitem

[![zotero target version](https://img.shields.io/badge/Zotero-7%20%7C%208-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero-Exitem is a Zotero plugin for AI-assisted literature extraction, review management, synthesis, and export.

[English](README.md) | [简体中文](doc/README-zhCN.md) | [Français](doc/README-frFR.md)

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
- Built-in safeguards and limits:
  - single-item source length cap: 100,000 chars
  - optional PDF text / annotation truncation thresholds
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
