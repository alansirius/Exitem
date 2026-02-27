import { registerPrefsScripts } from "./modules/preferenceScript";
import { trackReviewEvent } from "./modules/reviewStore";
import {
  cleanupReviewFeatureUI,
  initializeReviewFeature,
  registerReviewContextMenu,
  registerReviewToolbarButton,
  unregisterReviewToolbarButton,
} from "./modules/reviewUI";
import { getString, initLocale } from "./utils/locale";

let prefsRegistered = false;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  registerPreferencePane();
  await initializeReviewFeature();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  try {
    win.MozXULElement.insertFTLIfNeeded(
      `${addon.data.config.addonRef}-mainWindow.ftl`,
    );
  } catch (e) {
    ztoolkit.log("insertFTLIfNeeded failed", e);
  }

  registerReviewToolbarButton(win);
  registerReviewContextMenu(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterReviewToolbarButton(win);
}

function onShutdown(): void {
  cleanupReviewFeatureUI();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  ztoolkit.log("notify", event, type, ids, extraData);
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  if (type === "load") {
    void trackReviewEvent("plugin_open", {
      timestamp: new Date().toISOString(),
      source: "preferences",
    }).catch((e) => ztoolkit.log(e));
    await registerPrefsScripts(data.window);
  }
}

function onShortcuts(_type: string) {
  // Reserved for future keyboard shortcuts
}

function onDialogEvents(_type: string) {
  // Dialog events are handled inside dedicated modules
}

function registerPreferencePane() {
  if (prefsRegistered) return;
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
  prefsRegistered = true;
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
