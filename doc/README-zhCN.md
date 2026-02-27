# Zotero-Exitem

[![zotero target version](https://img.shields.io/badge/Zotero-7%20%7C%208-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero-Exitem 是一款用于 Zotero 的 AI 文献信息提炼、综述管理、合并综述与导出插件。

[English](../README.md) | [简体中文](README-zhCN.md) | [Français](README-frFR.md)

## 预装条件

- Zotero 7 或 Zotero 8
- 已安装并完成 `zotero-gpt` 配置：
  - 项目地址：https://github.com/MuiseDestiny/zotero-gpt
  - 中文配置说明：https://zotero-chinese.com/user-guide/plugins/zotero-gpt
- 若要使用 PDF 相关处理能力，`zotero-gpt` 中必须同时配置：
  - 主模型（聊天/补全模型）
  - Embedding 模型

## 安装方法

1. 下载本项目发布或构建产物中的 `.xpi` 文件。
2. 打开 Zotero：`工具` -> `插件` -> 右上角齿轮 -> `Install Plugin From File...`
3. 选择 `zotero-exitem.xpi` 并安装。
4. 重启 Zotero。

## 当前功能

- 在 Zotero 条目右键菜单触发 `AI提炼文献内容`
- 单篇提炼：
  - 提炼后弹出可编辑结果窗口再保存
  - 支持直接选择目标文件夹或在窗口内新建文件夹
- 批量提炼：
  - 单次最多 5 篇
  - 成功结果自动保存到目标文件夹，并打开文献综述管理界面
- 提炼输入组成可配置：
  - 元数据、摘要、笔记
  - 可选 PDF 全文
  - 可选 PDF 批注与批注下笔记
  - 可选将 PDF 批注文本导入独立字段
- Prompt 系统：
  - 支持自定义提炼 Prompt
  - 支持自定义合并综述 Prompt（`合并综述`）
  - 首选项支持一键应用 Prompt 并刷新文献记录视图列
- 内置保护与限制：
  - 单篇输入长度上限为 100,000 字符
  - 支持配置 PDF 正文/批注截断阈值
- 文献综述管理界面：
  - 工具栏按钮入口，优先以标签页打开（失败时回退弹窗）
  - 双视图：`文献记录` 与 `合并综述`
  - 固定视图切换控件和记录详情预览面板
  - `文献记录` 视图列可根据提炼 Prompt 字段动态解析
- 文件夹与记录管理：
  - 新建/删除/合并文件夹
  - 记录加入/移出文件夹（支持同一记录归属多个文件夹）
  - 搜索、排序、分页、多选与批量删除
  - 从文献记录定位回 Zotero 原条目
- 合并综述与导出：
  - 按文件夹执行“合并综述”，并提供进度反馈
  - 合并综述记录保留来源追踪：`sourceRecordIDs`、`sourceZoteroItemIDs`
  - 支持原始 AI 响应查看与编辑
  - 按当前视图与筛选范围导出 CSV
- 存储：
  - Zotero 数据目录独立 JSON 文件：`exitem-review-store.json`
  - 本地事件日志（提炼、综述、导出等）

## 接口路径

- 当前 AI 调用链路为桥接已安装的 `zotero-gpt` 运行时与配置。
