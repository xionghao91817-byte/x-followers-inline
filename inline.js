(() => {
  "use strict";
  const counts = new Map();
  const handlePattern = /^[a-zA-Z0-9_]{1,15}$/;
  let timer;

  function formatCount(count) {
    if (count < 10000) return count.toLocaleString("zh-CN");
    return `${(count / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}万`;
  }

  function remember(handle, count) {
    if (typeof handle !== "string" || !handlePattern.test(handle) ||
        !Number.isSafeInteger(count) || count < 0) return;
    const key = handle.toLowerCase();
    counts.delete(key);
    counts.set(key, { count, at: Date.now() });
    if (counts.size > 5000) counts.delete(counts.keys().next().value);
  }

  function collect(payload) {
    const stack = [payload];
    const seen = new WeakSet();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      // X has used both legacy.screen_name and core.screen_name for user identity.
      const handle = node.core?.screen_name ?? node.legacy?.screen_name ?? node.screen_name ?? node.username;
      const count = node.relationship_counts?.followers ?? node.legacy?.followers_count ?? node.followers_count ?? node.public_metrics?.followers_count;
      remember(handle, count);
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") stack.push(value);
      }
    }
    schedule();
  }

  function isUserDataUrl(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin &&
        (url.pathname.startsWith("/i/api/graphql/") || url.pathname.startsWith("/i/api/2/")) &&
        !/\/[^/]*(?:DM|DirectMessage|Inbox)[^/]*(?:\/|$)/i.test(url.pathname);
    } catch { return false; }
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const result = originalFetch.apply(this, args);
    if (isUserDataUrl(args[0] instanceof Request ? args[0].url : args[0])) {
      result.then(response => {
        if (response.ok && response.headers.get("content-type")?.includes("json")) {
          response.clone().json().then(collect).catch(() => {});
        }
      }).catch(() => {});
    }
    return result;
  };

  const requestUrls = new WeakMap();
  const listening = new WeakSet();
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    const result = originalOpen.apply(this, args);
    requestUrls.set(this, args[1]);
    if (!listening.has(this)) {
      listening.add(this);
      this.addEventListener("load", () => {
        if (this.status < 200 || this.status >= 300 || !isUserDataUrl(requestUrls.get(this))) return;
        try {
          if (this.responseType === "json") collect(this.response);
          else if (!this.responseType || this.responseType === "text") collect(JSON.parse(this.responseText));
        } catch { /* A non-JSON response must not affect X's request. */ }
      });
    }
    return result;
  };

  function render() {
    for (const header of document.querySelectorAll('[data-testid="User-Name"]')) {
      const links = [...header.querySelectorAll('a[href]')].filter(link =>
        link.closest('[data-testid="User-Name"]') === header);
      const anchor = links.find(link => /^@[a-zA-Z0-9_]{1,15}$/.test(link.textContent.trim()));
      if (!anchor) continue;
      const handle = anchor.textContent.trim().slice(1);
      let path;
      try { path = new URL(anchor.href, location.href).pathname; } catch { continue; }
      if (path.toLowerCase() !== `/${handle.toLowerCase()}`) continue;
      anchor.parentElement.classList.add("xfi-id-row");
      let badge = [...header.querySelectorAll(".xfi-count")].find(item =>
        item.closest('[data-testid="User-Name"]') === header);
      if (!badge || badge.previousElementSibling !== anchor) {
        badge?.remove();
        badge = document.createElement("span");
        badge.className = "xfi-count";
        anchor.after(badge);
      }
      const item = counts.get(handle.toLowerCase());
      // shortcut: only observed page data is available; add a lookup only after live X testing confirms missing coverage.
      const fresh = item && Date.now() - item.at < 30 * 60 * 1000;
      const text = fresh ? `· ${formatCount(item.count)}粉丝` : "· 粉丝待获取";
      const title = fresh
        ? `@${handle}：${item.count.toLocaleString("zh-CN")} 位粉丝；网页数据获取于 ${new Date(item.at).toLocaleTimeString("zh-CN")}，非实时刷新。`
        : "当前网页尚未返回粉丝数。悬停用户名后，若 X 加载了含粉丝数的用户数据，将自动补上。";
      if (badge.textContent !== text) badge.textContent = text;
      if (badge.title !== title) badge.title = title;
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; render(); }, 100);
  }

  new MutationObserver(schedule).observe(document, {
    childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href"]
  });
  // Handle X's bootstrapped data as well as subsequent requests.
  function readInitialData() {
    if (window.__INITIAL_STATE__) collect(window.__INITIAL_STATE__);
    schedule();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", readInitialData, { once: true });
  else readInitialData();
  setInterval(schedule, 60000);
})();
