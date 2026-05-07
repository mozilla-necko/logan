# Send Profiler Logs to Logan

A Firefox WebExtension that, when clicked on a `profiler.firefox.com` tab,
calls `window.extractGeckoLogs()`, opens [logan](https://mozilla-necko.github.io/logan/),
and feeds the extracted MOZ_LOG entries straight into it.

## Install (temporary)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this directory.
3. Open a profile on `profiler.firefox.com` (captured with the **Logging**
   profiler feature so it contains `Log` markers).
4. Click the toolbar button. A new tab opens on the configured logan URL and
   the logs are loaded automatically.

## Configuration

The logan URL is set at the top of `background.js` (`LOGAN_URL`). If you change
it, also update `manifest.json` — both the `host_permissions` entry and the
`content_scripts.matches` pattern must cover the new host.

## How it works

- `background.js` runs `window.extractGeckoLogs()` in the profiler tab's main
  world via `chrome.scripting.executeScript({ world: "MAIN" })`, then opens
  logan with a `#logan-extension` hash and stashes the log text in memory
  keyed by the new tab's id.
- `inject-logan.js` runs as a content script on the logan page. It pulls the
  payload via `runtime.sendMessage` and re-broadcasts it via `window.postMessage`.
- `logan-ui.js` listens for `logan-extension-load` messages on the same origin
  and feeds the text to `logan.consumeFiles` as a synthetic file.
