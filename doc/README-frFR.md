# Zotero-Exitem

[![zotero target version](https://img.shields.io/badge/Zotero-7%20%7C%208-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero-Exitem est un plugin Zotero pour l'extraction IA de références, la gestion de revues, la synthèse de dossiers et l'export.

[English](../README.md) | [简体中文](README-zhCN.md) | [Français](README-frFR.md)

## Prérequis

- Zotero 7 ou Zotero 8
- Plugin `zotero-gpt` installé et configuré :
  - Projet : https://github.com/MuiseDestiny/zotero-gpt
  - Guide de configuration (chinois) : https://zotero-chinese.com/user-guide/plugins/zotero-gpt
- Pour le traitement PDF, `zotero-gpt` doit configurer :
  - un modèle principal (chat/complétion)
  - un modèle d'embedding

## Installation

1. Téléchargez le fichier `.xpi` depuis la release ou la sortie de build.
2. Dans Zotero : `Outils` -> `Plugins` -> icône engrenage -> `Install Plugin From File...`
3. Sélectionnez `zotero-exitem.xpi`.
4. Redémarrez Zotero.

## Fonctionnalités actuelles

- Déclenchement de l'extraction depuis le menu contextuel Zotero : `AI提炼文献内容`
- Extraction unitaire :
  - ouvre une fenêtre de résultat modifiable avant sauvegarde
  - permet de choisir le dossier cible ou d'en créer un directement
- Extraction par lot :
  - jusqu'à 5 documents par exécution
  - sauvegarde automatique des succès dans un dossier puis ouverture du gestionnaire
- Composition des entrées d'extraction (configurable) :
  - métadonnées de l'item, résumé, notes
  - texte PDF complet (optionnel)
  - annotations PDF et notes d'annotation (optionnel)
  - import optionnel du texte d'annotation PDF dans un champ dédié
- Système de prompts :
  - prompt d'extraction personnalisable
  - prompt de synthèse de dossier (`合并综述`) personnalisable
  - action de préférences pour appliquer le prompt et rafraîchir les colonnes
- Garde-fous et limites :
  - plafond de longueur par source unitaire : 100 000 caractères
  - seuils de troncature PDF/annotations configurables
- Interface du gestionnaire de revue :
  - entrée via bouton de barre d'outils, ouverture en onglet en priorité (fenêtre en secours)
  - double vue : `文献记录` et `合并综述`
  - contrôles de bascule fixes et panneau d'aperçu détaillé
  - colonnes littérature dynamiques selon les champs du prompt
- Gestion des dossiers et des fiches :
  - créer/supprimer/fusionner des dossiers
  - ajouter/retirer des fiches d'un dossier (multi-appartenance supportée)
  - recherche, tri, pagination, multi-sélection et suppression en lot
  - navigation vers l'item Zotero d'origine depuis une fiche littérature
- Synthèse et export :
  - synthèse par dossier (`合并综述`) avec retour de progression
  - enregistrement persistant avec traçage des sources (`sourceRecordIDs`, `sourceZoteroItemIDs`)
  - visualisation/édition de la réponse IA brute
  - export CSV selon la vue et les filtres courants
- Stockage :
  - fichier JSON indépendant dans le répertoire de données Zotero : `exitem-review-store.json`
  - journal local des événements (extraction, synthèse, export, etc.)

## Chemin d'appel IA

- Les appels IA passent par le pont runtime/configuration du plugin `zotero-gpt` installé.
