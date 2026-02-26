# Zotero-Exitem

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero-Exitem est un plugin Zotero pour l'extraction IA de références, la gestion de revues, la synthèse de dossiers et l'export.

[English](../README.md) | [简体中文](README-zhCN.md) | [Français](README-frFR.md)

## Fonctions

- Extraction IA depuis le menu contextuel Zotero (`AI提炼文献内容`)
- Extraction d'un document avec édition avant sauvegarde
- Extraction par lot (jusqu'à 5 documents) avec sauvegarde automatique
- Champs structurés : contexte, revue, méthodes, conclusions, résultats clés, tags
- Sources d'entrée optionnelles : métadonnées, résumé, notes, texte PDF
- Annotations PDF + notes d'annotation (optionnel) :
  - comme contexte pour l'IA
  - comme champ indépendant du document
- Sélection automatique de la configuration API :
  - utiliser la configuration `zotero-gpt` si disponible
  - sinon utiliser la configuration locale Exitem
- Mode pont vers plugin GPT compatible (`zotero-gpt` / chemin compatible Awesome GPT)
- Support OpenAI-compatible et Gemini en mode configuration locale Exitem
- Prompt d'extraction personnalisé et prompt de synthèse de dossier personnalisé
- Onglet Zotero de gestion des revues :
  - dossiers, recherche, tri, pagination
  - classement multi-dossiers pour une même fiche
  - ajout / retrait d'un dossier
  - affichage et édition de la sortie brute
- Synthèse de dossier (`合并综述`) pour les fiches d'un même dossier
- Export CSV (compatible Excel)
- Stockage dans un fichier JSON indépendant dans le répertoire de données Zotero (`exitem-review-store.json`)
