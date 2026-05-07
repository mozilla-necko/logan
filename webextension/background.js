const LOGAN_URL = "https://mozilla-necko.github.io/logan/";

// Logan-tab id -> { blob, name }
const pendingPayloads = new Map();

browser.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.startsWith("https://profiler.firefox.com/")) {
    notifyOnTab(tab.id, "Open a profiler.firefox.com tab first.");
    return;
  }

  let logs;
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () =>
        typeof window.extractGeckoLogs === "function"
          ? window.extractGeckoLogs()
          : null,
    });
    logs = results && results[0] && results[0].result;
  } catch (e) {
    notifyOnTab(tab.id, "Failed to run extractGeckoLogs: " + e.message);
    return;
  }

  if (!logs) {
    notifyOnTab(
      tab.id,
      "extractGeckoLogs returned no logs. Make sure the profile was captured with the 'Logging' feature."
    );
    return;
  }

  const blob = new Blob([logs], { type: "text/plain" });

  const newTab = await browser.tabs.create({
    url: `${LOGAN_URL}#logan-extension`,
  });
  pendingPayloads.set(newTab.id, {
    blob,
    name: `profiler-${tab.id}-${Date.now()}.log`,
  });
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !sender.tab) return;
  if (msg.type === "logan-fetch-payload") {
    const payload = pendingPayloads.get(sender.tab.id) || null;
    pendingPayloads.delete(sender.tab.id);
    return Promise.resolve(payload);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  pendingPayloads.delete(tabId);
});

function notifyOnTab(tabId, message) {
  browser.scripting
    .executeScript({
      target: { tabId },
      func: (m) => alert(m),
      args: [message],
    })
    .catch(() => {});
}
