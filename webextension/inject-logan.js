(async () => {
  if (!location.hash.includes("logan-extension")) return;
  console.log("[logan-ext] content script: requesting payload");

  const payload = await browser.runtime.sendMessage({
    type: "logan-fetch-payload",
  });
  console.log("[logan-ext] content script: payload =", payload);
  if (!payload) return;

  // Blob may have come across as a content-script-realm Blob; reconstruct
  // a page-realm Blob so logan's `instanceof Blob` check succeeds and
  // expando `.name` assignment is allowed.
  let blob = payload.blob;
  if (!(blob instanceof Blob) && payload.bytes) {
    blob = new Blob([payload.bytes], { type: "text/plain" });
  }

  history.replaceState(null, "", location.pathname + location.search);

  const send = () => {
    console.log("[logan-ext] content script: posting message, blob size =", blob && blob.size);
    window.postMessage(
      {
        type: "logan-extension-load",
        blob,
        name: payload.name,
      },
      location.origin
    );
  };

  if (document.readyState === "complete") {
    send();
  } else {
    window.addEventListener("load", send, { once: true });
  }
})();
