# Zotero-Exitem

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero-Exitem is a Zotero plugin for AI-assisted literature extraction, review management, synthesis, and export.

[English](README.md) | [简体中文](doc/README-zhCN.md) | [Français](doc/README-frFR.md)

## Functions

- Right-click Zotero items to run `AI提炼文献内容`
- Single-item extraction with editable result before save
- Batch extraction (up to 5 items) with automatic save
- Structured extraction fields: background, review, methods, conclusions, key findings, tags
- Optional input sources: metadata, abstract, notes, PDF full text
- Optional PDF annotations + annotation notes:
  - as AI extraction context
  - as an independent record field
- API configuration source: `zotero-gpt` only (`api` / `secretKey` / `model` / `temperature` / `embeddingBatchNum`)
- Preferences display Zotero GPT bridge status only (no independent Exitem API form)
- OpenAI-compatible API calling follows `zotero-gpt` settings, with fixed `embeddingModel = text-embedding-ada-002`
- Custom extraction prompt and custom folder-summary prompt
- Review manager tab in Zotero:
  - folder buttons, search, sort, pagination
  - multi-folder classification for the same record
  - add/remove record-folder membership
  - raw record viewing/editing
- Folder-level synthesis (`合并综述`) for records in the same folder
- CSV export (Excel-compatible)
- Independent JSON storage file in Zotero data directory (`exitem-review-store.json`)
