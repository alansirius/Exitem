# Zotero-Exitem

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero-Exitem 是一款用于 Zotero 的 AI 文献信息提炼、综述管理、合并综述与导出插件。

[English](../README.md) | [简体中文](README-zhCN.md) | [Français](README-frFR.md)

## 功能说明

- 在 Zotero 条目右键菜单中执行 `AI提炼文献内容`
- 单篇提炼支持编辑后保存
- 批量提炼（最多 5 篇）支持自动保存
- 提炼结果结构化字段：研究背景、文献综述、研究方法、研究结论、关键发现、分类标签
- 可选提炼输入源：元数据、摘要、笔记、PDF 全文
- 可选 PDF 批注与批注下笔记：
  - 作为 AI 提炼上下文
  - 作为独立字段导入文献记录
- 接口配置来源：仅使用 `zotero-gpt` 配置（`api` / `secretKey` / `model` / `temperature` / `embeddingBatchNum`）
- 首选项仅显示 Zotero GPT 桥接状态（不再提供 Exitem 独立接口参数表单）
- OpenAI 兼容接口调用遵循 `zotero-gpt` 配置，`embeddingModel` 固定为 `text-embedding-ada-002`
- 支持自定义提炼 Prompt 与合并综述 Prompt
- Zotero 内置“文献综述”标签页管理：
  - 文件夹按钮、搜索、排序、分页
  - 同一记录可归入多个文件夹
  - 加入文件夹 / 移出文件夹
  - 查看并编辑原始记录
- 支持同一文件夹下记录“合并综述”
- 支持 CSV 导出（Excel 可直接打开）
- 数据存储为 Zotero 数据目录下独立 JSON 文件（`exitem-review-store.json`）
