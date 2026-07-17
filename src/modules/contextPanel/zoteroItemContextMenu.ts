import { t } from "../../utils/i18n";
import type { ContextSelectionActionResult } from "./contextSelectionActions";
import type { ZoteroToolkit } from "zotero-plugin-toolkit";

type AddItemsAsDefaultContext = (
  items: Zotero.Item[],
) => Promise<ContextSelectionActionResult>;
type AfterItemsAsDefaultContextAdded = (
  result: ContextSelectionActionResult,
  items: Zotero.Item[],
) => Promise<void> | void;
type PrepareItemsAsDefaultContextTarget = () =>
  | Promise<boolean | void>
  | boolean
  | void;

type ContextSurfaceKind = "embedded" | "standalone";

type ContextSurfaceActionTarget = {
  surfaceKind: ContextSurfaceKind;
  addItemsAsDefaultContext: AddItemsAsDefaultContext;
  afterItemsAsDefaultContextAdded?: AfterItemsAsDefaultContextAdded;
  prepareItemsAsDefaultContextTarget?: PrepareItemsAsDefaultContextTarget;
};

type OpenStandaloneChat = (options?: {
  initialItem?: Zotero.Item | null;
}) => void;

type RegisterMenuDeps = {
  ztoolkit: Pick<ZoteroToolkit, "Menu">;
  getSelectedItems: () => Zotero.Item[];
  openStandaloneChat: OpenStandaloneChat;
  captureWebSnapshot?: (attachment: Zotero.Item) => Promise<Zotero.Item>;
  notify?: (title: string, message: string) => void;
};

type DispatchDeps = {
  openStandaloneChat: OpenStandaloneChat;
};

const MENU_ID = "llmforzotero-add-items-as-context";
const MENU_SEPARATOR_BEFORE_ID = "llmforzotero-add-items-as-context-before";
const MENU_SEPARATOR_AFTER_ID = "llmforzotero-add-items-as-context-after";
const WEB_SNAPSHOT_MENU_ID = "llmforzotero-capture-web-snapshot";
const activeContextSurfaceTargets = new Map<
  Element,
  ContextSurfaceActionTarget
>();
const pendingStandaloneContextItems: Zotero.Item[][] = [];

function getConnectedContextSurfaceTarget(
  surfaceKind?: ContextSurfaceKind,
): ContextSurfaceActionTarget | null {
  for (const [body, target] of Array.from(
    activeContextSurfaceTargets.entries(),
  ).reverse()) {
    if (!(body as Element).isConnected) {
      activeContextSurfaceTargets.delete(body);
      continue;
    }
    if (!surfaceKind || target.surfaceKind === surfaceKind) return target;
  }
  return null;
}

export function registerContextSurfaceActionTarget(
  body: Element,
  target: ContextSurfaceActionTarget,
): () => void {
  activeContextSurfaceTargets.set(body, target);
  if (target.surfaceKind === "standalone") {
    void drainPendingStandaloneContextItems(target);
  }
  return () => {
    if (activeContextSurfaceTargets.get(body) === target) {
      activeContextSurfaceTargets.delete(body);
    }
  };
}

export async function dispatchZoteroItemsAsContext(
  items: Zotero.Item[],
  deps: DispatchDeps,
): Promise<{ dispatched: boolean; openedStandalone: boolean }> {
  const selectedItems = items.filter(Boolean);
  if (!selectedItems.length) {
    return { dispatched: false, openedStandalone: false };
  }
  const standaloneTarget = getConnectedContextSurfaceTarget("standalone");
  if (standaloneTarget) {
    deps.openStandaloneChat({ initialItem: null });
    const preparedTarget =
      await prepareStandaloneContextTarget(standaloneTarget);
    if (!preparedTarget) {
      return { dispatched: false, openedStandalone: true };
    }
    const result = await preparedTarget.addItemsAsDefaultContext(selectedItems);
    await preparedTarget.afterItemsAsDefaultContextAdded?.(
      result,
      selectedItems,
    );
    return { dispatched: true, openedStandalone: true };
  }
  pendingStandaloneContextItems.push(selectedItems);
  deps.openStandaloneChat({ initialItem: null });
  return { dispatched: false, openedStandalone: true };
}

export function registerZoteroItemContextMenu(deps: RegisterMenuDeps): void {
  deps.ztoolkit.Menu?.register?.("item", {
    tag: "menuseparator",
    id: MENU_SEPARATOR_BEFORE_ID,
  });
  deps.ztoolkit.Menu?.register?.("item", {
    tag: "menuitem",
    id: MENU_ID,
    label: t("Add Items as Context to LLM-for-Zotero"),
    commandListener: () => {
      const items = deps.getSelectedItems();
      void dispatchZoteroItemsAsContext(items, {
        openStandaloneChat: deps.openStandaloneChat,
      });
    },
  });
  deps.ztoolkit.Menu?.register?.("item", {
    tag: "menuitem",
    id: WEB_SNAPSHOT_MENU_ID,
    label: t("Capture Web Snapshot and Add to LLM-for-Zotero"),
    isHidden: () => !getSelectedCapturableWebAttachment(deps.getSelectedItems()),
    commandListener: () => {
      const attachment = getSelectedCapturableWebAttachment(
        deps.getSelectedItems(),
      );
      if (!attachment) return;
      const capture = deps.captureWebSnapshot || captureWebSnapshot;
      const notify = deps.notify || showNotification;
      notify(
        t("Capturing web snapshot"),
        t("Saving a local copy for Zotero and LLM-for-Zotero…"),
      );
      void capture(attachment)
        .then((snapshot) => {
          notify(
            t("Web snapshot saved"),
            t("The local copy has been added to a new LLM-for-Zotero chat."),
          );
          return dispatchZoteroItemsAsContext([snapshot], {
            openStandaloneChat: deps.openStandaloneChat,
          });
        })
        .catch((error) => {
          Zotero.logError(error);
          notify(
            t("Web snapshot could not be saved"),
            error instanceof Error ? error.message : String(error),
          );
        });
    },
  });
  deps.ztoolkit.Menu?.register?.("item", {
    tag: "menuseparator",
    id: MENU_SEPARATOR_AFTER_ID,
  });
}

type AttachmentImportApi = {
  LINK_MODE_LINKED_URL?: number;
  importFromURL?: (options: {
    libraryID?: number;
    parentItemID?: number;
    url: string;
    title?: string;
    contentType?: string;
    referrer?: string;
  }) => Promise<Zotero.Item>;
};

function getLinkedWebURL(item: Zotero.Item | null | undefined): string {
  if (!item?.isAttachment?.()) return "";
  const linkedURLMode =
    (typeof Zotero === "undefined"
      ? undefined
      : (Zotero as unknown as { Attachments?: AttachmentImportApi })
          .Attachments?.LINK_MODE_LINKED_URL) ?? 3;
  if ((item as unknown as { attachmentLinkMode?: unknown }).attachmentLinkMode !== linkedURLMode) {
    return "";
  }
  const attachmentPath = (item as unknown as { attachmentPath?: unknown })
    .attachmentPath;
  const url =
    typeof attachmentPath === "string" && /^https?:\/\//i.test(attachmentPath)
      ? attachmentPath
      : item.getField?.("url");
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : "";
}

export function getSelectedCapturableWebAttachment(
  items: Zotero.Item[],
): Zotero.Item | null {
  if (items.length !== 1) return null;
  return getLinkedWebURL(items[0]) ? items[0] : null;
}

export async function captureWebSnapshot(
  attachment: Zotero.Item,
): Promise<Zotero.Item> {
  const url = getLinkedWebURL(attachment);
  if (!url) {
    throw new Error("Select one linked web attachment to capture a snapshot.");
  }
  const attachments = (
    Zotero as unknown as { Attachments?: AttachmentImportApi }
  ).Attachments;
  if (!attachments?.importFromURL) {
    throw new Error("This Zotero version cannot capture web snapshots.");
  }
  const parentItemID = attachment.parentID || undefined;
  const parentTitle = parentItemID
    ? Zotero.Items.get(parentItemID)?.getField?.("title")
    : "";
  const attachmentTitle = attachment.getField?.("title") || "Web page";
  return attachments.importFromURL({
    libraryID: parentItemID ? undefined : attachment.libraryID,
    parentItemID,
    url,
    title: `Snapshot — ${parentTitle || attachmentTitle}`,
    contentType: "text/html",
    referrer: url,
  });
}

function showNotification(title: string, message: string): void {
  try {
    const progressWindow = new (
      Zotero as unknown as {
        ProgressWindow: new () => {
          changeHeadline: (text: string) => void;
          addDescription: (text: string) => void;
          show: () => void;
          close: () => void;
        };
      }
    ).ProgressWindow();
    progressWindow.changeHeadline(title);
    progressWindow.addDescription(message);
    progressWindow.show();
    setTimeout(() => progressWindow.close(), 4500);
  } catch (error) {
    ztoolkit.log("LLM: web snapshot notification failed", error);
  }
}

async function drainPendingStandaloneContextItems(
  fallbackTarget: ContextSurfaceActionTarget,
): Promise<void> {
  while (pendingStandaloneContextItems.length) {
    const items = pendingStandaloneContextItems.shift();
    if (items?.length) {
      const target =
        getConnectedContextSurfaceTarget("standalone") || fallbackTarget;
      const preparedTarget = await prepareStandaloneContextTarget(target);
      if (!preparedTarget) continue;
      const result = await preparedTarget.addItemsAsDefaultContext(items);
      await preparedTarget.afterItemsAsDefaultContextAdded?.(result, items);
    }
  }
}

async function prepareStandaloneContextTarget(
  target: ContextSurfaceActionTarget,
): Promise<ContextSurfaceActionTarget | null> {
  if (target.surfaceKind !== "standalone") return target;
  const prepared = await target.prepareItemsAsDefaultContextTarget?.();
  if (prepared === false) return null;
  return getConnectedContextSurfaceTarget("standalone") || target;
}

export async function drainPendingStandaloneContextItemsForTests(
  addItemsAsDefaultContext: AddItemsAsDefaultContext,
): Promise<void> {
  await drainPendingStandaloneContextItems({
    surfaceKind: "standalone",
    addItemsAsDefaultContext,
  });
}

export function clearContextSurfaceActionTargetsForTests(): void {
  activeContextSurfaceTargets.clear();
  pendingStandaloneContextItems.length = 0;
}
