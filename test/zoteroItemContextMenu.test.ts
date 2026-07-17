import { assert } from "chai";
import { afterEach, describe, it } from "mocha";
import {
  clearContextSurfaceActionTargetsForTests,
  dispatchZoteroItemsAsContext,
  drainPendingStandaloneContextItemsForTests,
  registerContextSurfaceActionTarget,
  registerZoteroItemContextMenu,
} from "../src/modules/contextPanel/zoteroItemContextMenu";

function makeItem(id: number): Zotero.Item {
  return {
    id,
    libraryID: 1,
    isRegularItem: () => true,
    isAttachment: () => false,
    getField: () => `Item ${id}`,
  } as unknown as Zotero.Item;
}

function makeLinkedWebAttachment(id: number): Zotero.Item {
  return {
    id,
    libraryID: 1,
    parentID: 10,
    attachmentLinkMode: 3,
    attachmentPath: "https://example.com/article",
    isRegularItem: () => false,
    isAttachment: () => true,
    getField: (field: string) =>
      field === "title" ? "Example article" : "https://example.com/article",
  } as unknown as Zotero.Item;
}

describe("Zotero item context menu dispatch", function () {
  afterEach(function () {
    clearContextSurfaceActionTargetsForTests();
  });

  it("registers the Zotero item-tree command between separators", function () {
    const registrations: Array<{
      menu: string;
      options: { id?: string; label?: string; tag?: string };
    }> = [];
    const toolkit = {
      Menu: {
        register: (menu: string, options: any) => {
          registrations.push({ menu, options });
        },
      },
    };

    registerZoteroItemContextMenu({
      ztoolkit: toolkit as any,
      getSelectedItems: () => [],
      openStandaloneChat: () => undefined,
    });

    assert.lengthOf(registrations, 4);
    assert.deepEqual(
      registrations.map((registration) => registration.menu),
      ["item", "item", "item", "item"],
    );
    assert.equal(registrations[0].options.tag, "menuseparator");
    assert.equal(registrations[1].options.tag, "menuitem");
    assert.equal(
      registrations[1].options.label,
      "Add Items as Context to LLM-for-Zotero",
    );
    assert.equal(
      registrations[2].options.label,
      "Capture Web Snapshot and Add to LLM-for-Zotero",
    );
    assert.equal(registrations[3].options.tag, "menuseparator");
  });

  it("captures one selected linked web attachment and adds the local snapshot as context", async function () {
    const attachment = makeLinkedWebAttachment(9);
    const snapshot = makeItem(11);
    const registrations: Array<{ options: any }> = [];
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];
    const notifications: Array<{ title: string; message: string }> = [];
    let captured: Zotero.Item | null = null;

    registerZoteroItemContextMenu({
      ztoolkit: {
        Menu: {
          register: (_menu: string, options: any) => registrations.push({ options }),
        },
      } as any,
      getSelectedItems: () => [attachment],
      openStandaloneChat: (options) => opened.push(options || {}),
      captureWebSnapshot: async (item) => {
        captured = item;
        return snapshot;
      },
      notify: (title, message) => notifications.push({ title, message }),
    });

    const captureCommand = registrations.find(
      ({ options }) => options.label === "Capture Web Snapshot and Add to LLM-for-Zotero",
    )?.options;
    assert.isFalse(captureCommand.isHidden());
    captureCommand.commandListener();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(captured, attachment);
    assert.lengthOf(opened, 1);
    assert.deepEqual(notifications.map((entry) => entry.title), [
      "Capturing web snapshot",
      "Web snapshot saved",
    ]);
  });

  it("opens standalone instead of dispatching to a mounted embedded chat surface", async function () {
    const item = makeItem(1);
    const body = { isConnected: true } as Element;
    const received: Zotero.Item[][] = [];
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "embedded",
      addItemsAsDefaultContext: async (items) => {
        received.push(items);
        return { changed: true };
      },
    });

    const result = await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    assert.isFalse(result.dispatched);
    assert.isTrue(result.openedStandalone);
    assert.lengthOf(opened, 1);
    assert.isNull(opened[0].initialItem || null);
    assert.deepEqual(received, []);

    const standaloneReceived: Zotero.Item[][] = [];
    await drainPendingStandaloneContextItemsForTests(async (items) => {
      standaloneReceived.push(items);
      return { changed: true };
    });
    assert.deepEqual(standaloneReceived, [[item]]);
  });

  it("focuses an existing standalone surface and dispatches there", async function () {
    const item = makeItem(3);
    const body = { isConnected: true } as Element;
    const received: Zotero.Item[][] = [];
    const completed: Array<{ changed: boolean; itemIds: number[] }> = [];
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "standalone",
      addItemsAsDefaultContext: async (items) => {
        received.push(items);
        return { changed: true };
      },
      afterItemsAsDefaultContextAdded: async (result, items) => {
        completed.push({
          changed: result.changed,
          itemIds: items.map((receivedItem) => receivedItem.id),
        });
      },
    });

    const result = await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    assert.isTrue(result.dispatched);
    assert.isTrue(result.openedStandalone);
    assert.lengthOf(opened, 1);
    assert.isNull(opened[0].initialItem || null);
    assert.deepEqual(received, [[item]]);
    assert.deepEqual(completed, [{ changed: true, itemIds: [3] }]);
  });

  it("prepares a fresh standalone context target before adding right-click context", async function () {
    const item = makeItem(5);
    const body = { isConnected: true } as Element;
    const oldReceived: Zotero.Item[][] = [];
    const freshReceived: Zotero.Item[][] = [];
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];
    let prepareCalls = 0;
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "standalone",
      prepareItemsAsDefaultContextTarget: async () => {
        prepareCalls += 1;
        registerContextSurfaceActionTarget(body, {
          surfaceKind: "standalone",
          addItemsAsDefaultContext: async (items) => {
            freshReceived.push(items);
            return { changed: true };
          },
        });
      },
      addItemsAsDefaultContext: async (items) => {
        oldReceived.push(items);
        return { changed: true };
      },
    });

    const result = await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    assert.isTrue(result.dispatched);
    assert.isTrue(result.openedStandalone);
    assert.lengthOf(opened, 1);
    assert.equal(prepareCalls, 1);
    assert.deepEqual(oldReceived, []);
    assert.deepEqual(freshReceived, [[item]]);
  });

  it("does not add right-click context to the old standalone chat when fresh target preparation fails", async function () {
    const item = makeItem(7);
    const body = { isConnected: true } as Element;
    const oldReceived: Zotero.Item[][] = [];
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];
    let prepareCalls = 0;
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "standalone",
      prepareItemsAsDefaultContextTarget: async () => {
        prepareCalls += 1;
        return false;
      },
      addItemsAsDefaultContext: async (items) => {
        oldReceived.push(items);
        return { changed: true };
      },
    });

    const result = await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    assert.isFalse(result.dispatched);
    assert.isTrue(result.openedStandalone);
    assert.lengthOf(opened, 1);
    assert.equal(prepareCalls, 1);
    assert.deepEqual(oldReceived, []);
  });

  it("opens standalone and applies queued context when no chat surface is mounted", async function () {
    const item = makeItem(2);
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];

    const result = await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    assert.isFalse(result.dispatched);
    assert.isTrue(result.openedStandalone);
    assert.lengthOf(opened, 1);
    assert.isNull(opened[0].initialItem || null);

    const received: Zotero.Item[][] = [];
    await drainPendingStandaloneContextItemsForTests(async (items) => {
      received.push(items);
      return { changed: true };
    });

    assert.deepEqual(received, [[item]]);
  });

  it("notifies a newly mounted standalone surface after applying queued context", async function () {
    const item = makeItem(4);
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];

    await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    const body = { isConnected: true } as Element;
    const received: Zotero.Item[][] = [];
    const completed: Array<{ changed: boolean; itemIds: number[] }> = [];
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "standalone",
      addItemsAsDefaultContext: async (items) => {
        received.push(items);
        return { changed: true };
      },
      afterItemsAsDefaultContextAdded: async (result, items) => {
        completed.push({
          changed: result.changed,
          itemIds: items.map((receivedItem) => receivedItem.id),
        });
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.lengthOf(opened, 1);
    assert.deepEqual(received, [[item]]);
    assert.deepEqual(completed, [{ changed: true, itemIds: [4] }]);
  });

  it("prepares the fresh standalone target before draining queued context", async function () {
    const item = makeItem(6);
    const opened: Array<{ initialItem?: Zotero.Item | null }> = [];

    await dispatchZoteroItemsAsContext([item], {
      openStandaloneChat: (options) => {
        opened.push(options || {});
      },
    });

    const body = { isConnected: true } as Element;
    const oldReceived: Zotero.Item[][] = [];
    const freshReceived: Zotero.Item[][] = [];
    let prepareCalls = 0;
    registerContextSurfaceActionTarget(body, {
      surfaceKind: "standalone",
      prepareItemsAsDefaultContextTarget: async () => {
        prepareCalls += 1;
        registerContextSurfaceActionTarget(body, {
          surfaceKind: "standalone",
          addItemsAsDefaultContext: async (items) => {
            freshReceived.push(items);
            return { changed: true };
          },
        });
      },
      addItemsAsDefaultContext: async (items) => {
        oldReceived.push(items);
        return { changed: true };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.lengthOf(opened, 1);
    assert.equal(prepareCalls, 1);
    assert.deepEqual(oldReceived, []);
    assert.deepEqual(freshReceived, [[item]]);
  });
});
