// ==UserScript==
// @name         Supjav popup blocker
// @namespace    local.supjav-popup-blocker
// @version      1.0.0
// @description  Block Supjav popups and auto-load the real player iframe.
// @match        *://supjav.com/*
// @match        *://*.supjav.com/*
// @match        *://lk1.supremejav.com/*
// @match        *://*.supremejav.com/*
// @match        *://emturbovid.com/*
// @match        *://*.emturbovid.com/*
// @match        *://turbovidhls.com/*
// @match        *://*.turbovidhls.com/*
// @match        *://*.mnaspm.com/*
// @match        *://*.mayzaent.com/*
// @match        *://*.marzaent.com/*
// @match        *://*.saentcore.com/*
// @match        *://*.fh-dxy.com/*
// @match        *://*.eix304.com/*
// @match        *://*.snaptrckr.fun/*
// @match        *://*.trackwilltrk.com/*
// @match        *://*.magsrv.com/*
// @match        *://*.tapioni.com/*
// @match        *://*.storagexhd.com/*
// @match        *://*.javhdhello.com/*
// @match        *://*/*
// @include      about:blank
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  "use strict";

  const blockedDomains = [
    "djsalcbhew47.lol",
    "mnaspm.com",
    "mayzaent.com",
    "marzaent.com",
    "saentcore.com",
    "fh-dxy.com",
    "eix304.com",
    "snaptrckr.fun",
    "trackwilltrk.com",
    "magsrv.com",
    "tapioni.com",
    "storagexhd.com",
    "javhdhello.com",
    "javhd-trk.com",
    "nettrck.store",
    "b7510.com",
    "llvpn.com",
    "adexchangerapid.com",
    "inadsexchange.com",
    "usrpubtrk.com",
    "positivelong.com",
    "mulchimbiber.com",
    "conermoocher.com",
    "prmtracking.com",
    "wwpvpbktgoets.space",
    "tsyndicate.com",
    "stripchat.com",
    "barbulasnippet.qpon"
  ];

  const allowedDomains = [
    "supjav.com",
    "supremejav.com",
    "emturbovid.com",
    "turbovidhls.com",
    "turboviplay.com"
  ];

  const playerDomains = [
    "fc2stream.tv",
    "streamtape.com",
    "streamtape.to",
    "streamtape.site",
    "voe.sx",
    "voeunblock.com",
    "voeunbl0ck.com"
  ];

  const ignoredDomains = [
    "cloudflare.com"
  ];

  const popupGuardKey = "supjavPopupGuardUntil";
  const popupGuardMs = 8000;
  const exportStateMessage = "supjav-export-state";
  const exportStateRequest = "supjav-export-request";
  const exportStates = new Map();

  const adSelectors = [
    ".movv-ad",
    ".play-ad",
    "#lcb",
    "[class*='root--26nWL']",
    "[class*='bottomRight--']",
    "script[src]",
    "iframe[src]",
    "a[href]"
  ];

  const hostMatches = (host, domain) => host === domain || host.endsWith("." + domain);

  const ignoredContext = () =>
    ignoredDomains.some((domain) => hostMatches(location.hostname.replace(/^www\./, ""), domain));

  const cloudflareChallengeContext = () => {
    const title = document.title || "";
    if (/just a moment|checking your browser/i.test(title)) return true;

    const text = [
      document.body && document.body.innerText,
      document.documentElement && document.documentElement.textContent
    ].filter(Boolean).join(" ").slice(0, 3000);

    return /\bCloudflare\b/i.test(text) &&
      /(?:verify you are human|verifying you are human|security verification|checking your browser|performance and security by)/i.test(text);
  };

  const maybeSupjavChallengeBoot = () =>
    hostMatches(location.hostname.replace(/^www\./, ""), "supjav.com") &&
    topLevel() &&
    document.readyState === "loading" &&
    !document.body;

  const hostOf = (url) => {
    try {
      return new URL(url, location.href).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };

  const allowed = (url) => {
    const host = hostOf(url);
    return allowedDomains.some((domain) => hostMatches(host, domain));
  };

  const relevantHost = (host) =>
    [...allowedDomains, ...blockedDomains, ...playerDomains].some((domain) => hostMatches(host, domain));

  const supjavContext = () => {
    const text = [location.href, document.referrer].filter(Boolean).join(" ");
    try {
      return /(?:^|[/?#&@])(?:www\.)?supjav\.com\b/i.test(text) ||
        /(?:^|[/?#&@])(?:www\.)?supjav\.com\b/i.test(decodeURIComponent(text));
    } catch {
      return /(?:^|[/?#&@])(?:www\.)?supjav\.com\b/i.test(text);
    }
  };

  const relevantContext = () =>
    relevantHost(location.hostname.replace(/^www\./, "")) ||
    relevantHost(hostOf(document.referrer)) ||
    supjavContext();

  const topLevel = () => {
    try {
      return window.top === window.self;
    } catch {
      return false;
    }
  };

  const noopAction = (url) => /^(?:javascript:|about:blank(?:[#?].*)?$|#)/i.test(String(url).trim());
  const fileAction = (url) => /^(?:blob:|data:|filesystem:)/i.test(String(url).trim());

  const blocked = (url) => {
    if (fileAction(url)) return true;
    const host = hostOf(url);
    return blockedDomains.some((domain) => hostMatches(host, domain));
  };

  const allowedPopup = (url) => hostMatches(hostOf(url), "supjav.com");
  const popupTarget = (target) => !target || !/^_(?:self|top|parent)$/i.test(String(target));
  const blankPopupAction = (url) => !url || /^about:blank(?:[#?].*)?$/i.test(String(url).trim());
  const makeFakeWindow = () => ({
    closed: false,
    close() { this.closed = true; },
    focus() {},
    blur() {},
    postMessage() {},
    location: {
      href: "about:blank",
      assign() {},
      replace() {}
    }
  });

  const blockedDirectPopup = (url, target) =>
    popupTarget(target) &&
    relevantContext() &&
    (blankPopupAction(url) || !allowedPopup(url) || blockedNavigation(url));

  const installDirectOpenGuard = () => {
    const pageWindow = typeof unsafeWindow === "object" && unsafeWindow ? unsafeWindow : window;

    const wrapOpen = (nativeOpen) => {
      if (!nativeOpen || nativeOpen.__supjavWrappedOpen) return nativeOpen;
      const wrapped = function (url, target, ...args) {
        if (blockedDirectPopup(url, target)) {
          armPopupGuard();
          return makeFakeWindow();
        }
        return nativeOpen.call(this, url, target, ...args);
      };
      wrapped.__supjavWrappedOpen = true;
      return wrapped;
    };

    const patchOpen = (target) => {
      try {
        const wrapped = wrapOpen(target.open);
        if (!wrapped || wrapped === target.open) return;
        Object.defineProperty(target, "open", {
          configurable: false,
          writable: false,
          value: wrapped
        });
      } catch {
        // Cross-world objects may reject property replacement.
      }
    };

    patchOpen(pageWindow);
    if (pageWindow.Window && pageWindow.Window.prototype) patchOpen(pageWindow.Window.prototype);
  };

  const armPopupGuard = () => {
    try {
      if (typeof GM_setValue === "function") GM_setValue(popupGuardKey, Date.now() + popupGuardMs);
    } catch {
      // Storage may be unavailable in some frames.
    }
  };

  const popupGuardActive = () => {
    try {
      return Number(typeof GM_getValue === "function" ? GM_getValue(popupGuardKey, 0) : 0) > Date.now();
    } catch {
      return false;
    }
  };

  const installPopupGuard = () => {
    armPopupGuard();
    for (const type of ["pointerdown", "mousedown", "click", "touchstart", "keydown"]) {
      document.addEventListener(type, armPopupGuard, true);
    }
  };

  const blockedNavigation = (url) => {
    if (!url) return relevantContext();
    if (noopAction(url)) return false;
    if (blocked(url)) return true;
    if (/[?&]asgtbndr=1(?:&|$)/.test(String(url))) return true;
    return relevantContext() && !allowed(url);
  };

  const closeBlockedPopup = () => {
    if (!blocked(location.href) && !(topLevel() && (relevantContext() || popupGuardActive()) && !allowedPopup(location.href))) return false;
    try {
      window.close();
    } catch {
      // Some browsers reject closing tabs that were not script-opened.
    }
    if (!window.closed) location.replace("about:blank#supjav-blocked");
    return true;
  };

  const injectBlankTabPatch = () => {
    const source = `(${blankTabPatch.toString()})();`;
    const script = document.createElement("script");
    script.textContent = source;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
  };

  const injectPagePatch = () => {
    const source = `(${pagePatch.toString()})(${JSON.stringify(blockedDomains)}, ${JSON.stringify(allowedDomains)}, ${JSON.stringify(playerDomains)});`;
    const script = document.createElement("script");
    script.textContent = source;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
  };

  function blankTabPatch() {
    if (window.__supjavBlankTabBlocker) return;
    window.__supjavBlankTabBlocker = true;

    const hostMatches = (host, domain) => host === domain || host.endsWith("." + domain);
    const hostOf = (url) => {
      try {
        return new URL(url, location.href).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    };
    const allowedPopup = (url) => hostMatches(hostOf(url), "supjav.com");
    const blankAction = (url) => !url || /^about:blank(?:[#?].*)?$/i.test(String(url).trim());
    const fileAction = (url) => /^(?:blob:|data:|filesystem:)/i.test(String(url).trim());
    const popupTarget = (target) => !target || !/^_(?:self|top|parent)$/i.test(String(target));
    const explicitPopupTarget = (target) => !!target && popupTarget(target);
    const blockedPopup = (url, target) => popupTarget(target) && (blankAction(url) || !allowedPopup(url));
    const blockedTargetPopup = (url, target) =>
      explicitPopupTarget(target) && (blankAction(url) || !allowedPopup(url));
    const fakeWindow = {
      closed: false,
      close() { this.closed = true; },
      focus() {},
      blur() {},
      postMessage() {},
      location: {
        href: "about:blank",
        assign() {},
        replace() {}
      }
    };

    const wrapOpen = (nativeOpen) => function (url, target, ...args) {
      if (blockedPopup(url, target)) return fakeWindow;
      return nativeOpen.call(this, url, target, ...args);
    };

    const patchOpen = (win) => {
      try {
        const nativeOpen = win.open;
        if (!nativeOpen || nativeOpen.__supjavWrappedOpen) return;
        const wrapped = wrapOpen(nativeOpen);
        wrapped.__supjavWrappedOpen = true;
        Object.defineProperty(win, "open", {
          configurable: false,
          writable: false,
          value: wrapped
        });
      } catch {
        // Cross-origin window proxies may reject open patching.
      }
    };

    [window, self, globalThis, parent, top].forEach(patchOpen);

    try {
      const nativePrototypeOpen = Window.prototype.open;
      if (nativePrototypeOpen && !nativePrototypeOpen.__supjavWrappedOpen) {
        const wrapped = wrapOpen(nativePrototypeOpen);
        wrapped.__supjavWrappedOpen = true;
        Object.defineProperty(Window.prototype, "open", {
          configurable: false,
          writable: false,
          value: wrapped
        });
      }
    } catch {
      // Some frames do not expose Window.prototype.open.
    }

    const linkUrl = (link) => link.getAttribute("href") || link.href || "";
    const blockedDownloadLink = (link) =>
      (link.hasAttribute("download") || fileAction(linkUrl(link))) && !allowedPopup(linkUrl(link));
    const blockedLink = (link, target) =>
      blockedDownloadLink(link) || blockedTargetPopup(linkUrl(link), target);
    const neutralizeLink = (link) => {
      if (!link || !blockedLink(link, link.target)) return;
      link.removeAttribute("download");
      link.removeAttribute("target");
      link.setAttribute("href", "javascript:void 0");
      link.dataset.supjavPopupBlocked = "1";
    };
    const neutralizeNode = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (node.matches && node.matches("a[href],area[href]")) neutralizeLink(node);
      if (node.querySelectorAll) node.querySelectorAll("a[href],area[href]").forEach(neutralizeLink);
    };

    const nativeClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (blockedLink(this, this.target)) return;
      return nativeClick.call(this);
    };

    try {
      const nativeSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        const result = nativeSetAttribute.call(this, name, value);
        if (/^(?:href|target|download)$/i.test(name)) neutralizeNode(this);
        return result;
      };
    } catch {
      // Attribute patching is best-effort.
    }

    neutralizeNode(document.documentElement);
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) neutralizeNode(node);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });

    for (const type of ["pointerdown", "mousedown", "mouseup", "click", "auxclick", "touchstart"]) {
      document.addEventListener(type, (event) => {
        const link = event.target.closest && event.target.closest("a[href]");
        if (!link) return;
        const popupLike = explicitPopupTarget(link.target) || event.type === "auxclick";
        if (!blockedDownloadLink(link) && (!popupLike || !blockedPopup(linkUrl(link), "_blank"))) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    }

    document.addEventListener("submit", (event) => {
      const form = event.target;
      const url = form.getAttribute("action") || form.action || location.href;
      if (!blockedTargetPopup(url, form.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  function pagePatch(blockedDomains, allowedDomains, playerDomains) {
    if (window.__supjavPopupBlocker) return;
    window.__supjavPopupBlocker = true;
    window.__supjavPopupBlockerVersion = "1.0.0";

    const hostMatches = (host, domain) => host === domain || host.endsWith("." + domain);
    const hostOf = (url) => {
      try {
        return new URL(url, location.href).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    };
    const relevantHost = (host) =>
      [...allowedDomains, ...blockedDomains, ...playerDomains].some((domain) => hostMatches(host, domain));
    const supjavContext = () => {
      const text = [location.href, document.referrer].filter(Boolean).join(" ");
      try {
        return /(?:^|[/?#&@])(?:www\.)?supjav\.com\b/i.test(text) ||
          /(?:^|[/?#&@])(?:www\.)?supjav\.com\b/i.test(decodeURIComponent(text));
      } catch {
        return /(?:^|[/?#&@])(?:www\.)?supjav\.com\b/i.test(text);
      }
    };
    const relevantContext = () =>
      relevantHost(location.hostname.replace(/^www\./, "")) ||
      relevantHost(hostOf(document.referrer)) ||
      supjavContext();
    const allowed = (url) => {
      const host = hostOf(url);
      return allowedDomains.some((domain) => hostMatches(host, domain));
    };
    const noopAction = (url) => /^(?:javascript:|about:blank(?:[#?].*)?$|#)/i.test(String(url).trim());
    const fileAction = (url) => /^(?:blob:|data:|filesystem:)/i.test(String(url).trim());
    const blocked = (url) => {
      if (fileAction(url)) return true;
      const host = hostOf(url);
      return blockedDomains.some((domain) => hostMatches(host, domain));
    };
    const allowedPopup = (url) => hostMatches(hostOf(url), "supjav.com");
    const blankPopupAction = (url) => !url || /^about:blank(?:[#?].*)?$/i.test(String(url).trim());
    const popupTarget = (target) => !target || !/^_(?:self|top|parent)$/i.test(String(target));
    const blockedNavigation = (url, blockUnknown = false) => {
      if (!url) return relevantContext();
      if (noopAction(url)) return false;
      if (blocked(url)) return true;
      if (/[?&]asgtbndr=1(?:&|$)/.test(String(url))) return true;
      return blockUnknown && relevantContext() && !allowed(url);
    };
    const blockedPopup = (url, target) =>
      (popupTarget(target) && relevantContext() && !allowedPopup(url)) ||
      (blankPopupAction(url) && popupTarget(target) && relevantContext()) ||
      blockedNavigation(url, popupTarget(target));
    const explicitPopupTarget = (target) => !!target && popupTarget(target);
    const blockedTargetNavigation = (url, target) =>
      (explicitPopupTarget(target) && relevantContext() && !allowedPopup(url)) ||
      (blankPopupAction(url) && explicitPopupTarget(target) && relevantContext()) ||
      blockedNavigation(url, explicitPopupTarget(target));
    const formUrl = (form) => form.getAttribute("action") || form.action || location.href;
    const disabledDownloadControl = (target) => {
      const control = target.closest && target.closest("a,button,[role='button'],[onclick]");
      if (!control) return null;

      const label = [
        control.innerText,
        control.textContent,
        control.getAttribute("aria-label"),
        control.title
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

      return /\bdownload\s*:?\s*(?:rg|suby)\b/i.test(label) ? control : null;
    };
    const blockedResourceNode = (node) =>
      node && node.nodeType === 1 &&
      /^(?:SCRIPT|IFRAME)$/i.test(node.tagName) &&
      blocked(node.getAttribute("src") || node.src || "");

    let lastPlaybackNudge = 0;
    const fakeWindow = {
      closed: false,
      close() { this.closed = true; },
      focus() {},
      blur() {},
      postMessage() {},
      location: {
        href: "about:blank",
        assign() {},
        replace() {}
      }
    };

    const exportMessageType = "supjav-export-state";
    const exportRequestType = "supjav-export-request";
    const exportStreamState = {
      href: location.href,
      referrer: document.referrer,
      host: location.hostname.replace(/^www\./, ""),
      title: document.title || "",
      streams: [],
      currentTime: 0,
      duration: 0,
      width: 0,
      height: 0,
      quality: "",
      paused: true,
      videoSrc: "",
      lastUpdate: Date.now()
    };
    const absoluteUrl = (value) => {
      try {
        if (value && typeof value === "object" && "url" in value) value = value.url;
        return new URL(String(value || ""), location.href).href;
      } catch {
        return "";
      }
    };
    const m3u8Url = (url) => /\.m3u8(?:[?#].*)?$/i.test(String(url || ""));
    const mediaUrl = (url) => {
      const text = String(url || "");
      return m3u8Url(text) ||
        /\/get_video\?[^"'<>\\\s]*\bstream=1\b/i.test(text) ||
        /\.mp4(?:[?#].*)?$/i.test(text);
    };
    const streamHeadersFor = (url) => {
      const host = hostOf(url);
      const headers = [];
      let referer = "";

      if (hostMatches(host, "turboviplay.com") || hostMatches(host, "turbosplayer.com")) {
        headers.push("Origin: https://turbovidhls.com");
      } else if (hostMatches(host, "fc2stream.tv")) {
        referer = location.href;
        if (document.cookie) headers.push(`Cookie: ${document.cookie}`);
      } else if (hostMatches(host, "streamtape.com") || hostMatches(host, "streamtape.to") || hostMatches(host, "streamtape.site") || hostMatches(host, "tapecontent.net")) {
        referer = location.href;
      } else if (hostMatches(host, "voe.sx") || hostMatches(host, "voeunblock.com") || hostMatches(host, "voeunbl0ck.com")) {
        referer = location.href;
      } else if (hostMatches(location.hostname.replace(/^www\./, ""), "turbovidhls.com")) {
        headers.push("Origin: https://turbovidhls.com");
      }

      return { referer, headers };
    };
    const preferredStreamUrl = () => {
      const streams = exportStreamState.streams.map((item) => item.url);
      return streams.find((url) => hostMatches(hostOf(url), "turboviplay.com")) ||
        streams.find((url) => hostMatches(hostOf(url), "turbosplayer.com")) ||
        streams.find((url) => hostMatches(hostOf(url), "streamtape.com")) ||
        streams.find((url) => hostMatches(hostOf(url), "tapecontent.net")) ||
        streams[streams.length - 1] ||
        exportStreamState.videoSrc ||
        "";
    };
    const recordStreamUrl = (value, source = "network") => {
      const url = absoluteUrl(value);
      if (!url || !mediaUrl(url)) return;

      const existing = exportStreamState.streams.find((item) => item.url === url);
      if (existing) {
        existing.source = source || existing.source;
        existing.seenAt = Date.now();
      } else {
        exportStreamState.streams.push({ url, source, seenAt: Date.now() });
      }

      exportStreamState.lastUpdate = Date.now();
    };
    const recordResolution = (width, height, quality = "") => {
      width = Number(width) || 0;
      height = Number(height) || 0;
      if (width > 0 && height > 0) {
        exportStreamState.width = Math.round(width);
        exportStreamState.height = Math.round(height);
      }
      if (quality) exportStreamState.quality = String(quality);
    };
    const scanScriptsForStreams = () => {
      const pattern = /https?:\/\/[^"'<>\s\\]+?\.m3u8(?:\?[^"'<>\s\\]*)?/gi;
      document.querySelectorAll("script").forEach((script) => {
        const text = script.textContent || "";
        for (const match of text.matchAll(pattern)) recordStreamUrl(match[0], "script");
      });
    };
    const readPlayerState = () => {
      exportStreamState.href = location.href;
      exportStreamState.referrer = document.referrer;
      exportStreamState.title = document.title || "";
      exportStreamState.lastUpdate = Date.now();

      try {
        if (typeof window.urlPlay === "string") recordStreamUrl(window.urlPlay, "urlPlay");
      } catch {
        // Player globals vary by host.
      }

      try {
        const streamtapeSrc = directStreamtapeSrc();
        if (streamtapeSrc) {
          exportStreamState.videoSrc = streamtapeSrc;
          recordStreamUrl(streamtapeSrc, "streamtape");
        }
      } catch {
        // Streamtape markup is not present on most players.
      }

      try {
        if (window.jwplayer) {
          const player = window.jwplayer();
          if (player && typeof player.getPosition === "function") {
            const position = Number(player.getPosition());
            if (Number.isFinite(position)) exportStreamState.currentTime = Math.max(0, position);
          }
          if (player && typeof player.getDuration === "function") {
            const duration = Number(player.getDuration());
            if (Number.isFinite(duration)) exportStreamState.duration = Math.max(0, duration);
          }
          if (player && typeof player.getState === "function") {
            exportStreamState.paused = !/playing|buffering/i.test(String(player.getState()));
          }
          if (player && typeof player.getVisualQuality === "function") {
            const visual = player.getVisualQuality() || {};
            const level = visual.level || visual.currentQuality || {};
            recordResolution(level.width, level.height, level.label || visual.label || "");
          }
          if (player && typeof player.getPlaylist === "function") {
            const playlist = player.getPlaylist() || [];
            playlist.forEach((item) => {
              recordStreamUrl(item && item.file, "jwplayer");
              (item && item.sources || []).forEach((source) => recordStreamUrl(source && source.file, "jwplayer"));
            });
          }
        }
      } catch {
        // JW Player can throw while it is booting.
      }

      const video = document.querySelector("video");
      if (video) {
        const currentTime = Number(video.currentTime);
        const duration = Number(video.duration);
        if (Number.isFinite(currentTime)) exportStreamState.currentTime = Math.max(0, currentTime);
        if (Number.isFinite(duration)) exportStreamState.duration = Math.max(0, duration);
        recordResolution(video.videoWidth, video.videoHeight);
        exportStreamState.paused = !!video.paused;
        exportStreamState.videoSrc = video.currentSrc || video.src || exportStreamState.videoSrc || "";
        recordStreamUrl(exportStreamState.videoSrc, "video");
      }
    };
    function exportSnapshot() {
      readPlayerState();
      const url = preferredStreamUrl();
      const headerInfo = streamHeadersFor(url);
      return {
        type: exportMessageType,
        version: window.__supjavPopupBlockerVersion,
        href: exportStreamState.href,
        referrer: exportStreamState.referrer,
        host: exportStreamState.host,
        title: exportStreamState.title,
        streamUrl: url,
        streams: exportStreamState.streams.slice(-8),
        currentTime: exportStreamState.currentTime,
        duration: exportStreamState.duration,
        width: exportStreamState.width,
        height: exportStreamState.height,
        quality: exportStreamState.quality,
        paused: exportStreamState.paused,
        videoSrc: exportStreamState.videoSrc,
        userAgent: navigator.userAgent,
        referer: headerInfo.referer,
        headers: headerInfo.headers,
        timestamp: Date.now()
      };
    }
    function broadcastExportState() {
      const message = exportSnapshot();
      try {
        parent.postMessage(message, "*");
      } catch {
        // Cross-origin parents still generally allow postMessage, but keep this best-effort.
      }
      try {
        if (top !== parent) top.postMessage(message, "*");
      } catch {
        // Ignore inaccessible top windows.
      }
    }

    try {
      const nativeFetch = window.fetch;
      if (nativeFetch && !nativeFetch.__supjavExportWrapped) {
        const wrappedFetch = function (input, init) {
          recordStreamUrl(input, "fetch");
          return nativeFetch.call(this, input, init).then((response) => {
            recordStreamUrl(response && response.url, "fetch");
            return response;
          });
        };
        wrappedFetch.__supjavExportWrapped = true;
        window.fetch = wrappedFetch;
      }
    } catch {
      // Some frames lock fetch.
    }

    try {
      const nativeXhrOpen = XMLHttpRequest.prototype.open;
      if (nativeXhrOpen && !nativeXhrOpen.__supjavExportWrapped) {
        XMLHttpRequest.prototype.open = function (method, url, ...args) {
          recordStreamUrl(url, "xhr");
          return nativeXhrOpen.call(this, method, url, ...args);
        };
        XMLHttpRequest.prototype.open.__supjavExportWrapped = true;
      }
    } catch {
      // XHR may not be writable in every frame.
    }

    window.addEventListener("message", (event) => {
      if (!event.data || event.data.type !== exportRequestType) return;
      broadcastExportState();
    });

    document.addEventListener("DOMContentLoaded", () => {
      scanScriptsForStreams();
      broadcastExportState();
    });
    for (const type of ["loadedmetadata", "durationchange", "timeupdate", "seeking", "seeked", "play", "pause"]) {
      document.addEventListener(type, (event) => {
        if (event.target && event.target.tagName === "VIDEO") broadcastExportState();
      }, true);
    }
    setInterval(() => {
      scanScriptsForStreams();
      broadcastExportState();
    }, 1000);

    const nudgePlayback = () => {
      const now = Date.now();
      if (now - lastPlaybackNudge < 700) return;
      lastPlaybackNudge = now;

      const attempt = () => {
        try {
          if (window.jwplayer) window.jwplayer().play(true);
        } catch {
          // Not every player exposes JW Player.
        }

        const video = document.querySelector("video");
        if (video && video.paused) video.play().catch(() => {});

        const playButton = [...document.querySelectorAll([
          "button",
          "[role='button']",
          ".jw-icon-playback",
          ".jw-display-icon-container",
          ".jw-display-icon",
          ".vjs-big-play-button",
          ".vjs-play-control",
          ".plyr__control--overlaid",
          ".plyr__control--play"
        ].join(","))]
          .find((el) => /play|播放/i.test([
            el.getAttribute("aria-label"),
            el.title,
            el.textContent,
            el.className
          ].filter(Boolean).join(" ")));

        if (playButton && (!video || video.paused)) playButton.click();
      };

      attempt();
      setTimeout(attempt, 80);
      setTimeout(attempt, 250);
    };

    const playerArea = (target) =>
      target && target.closest &&
      target.closest("video,.jwplayer,.jw-media,.jw-preview,.jw-display,.jw-overlays,.jw-controls,.vjs-tech,.video-js,.plyr,.plyr__video-wrapper");
    const playerControl = (target) =>
      target && target.closest &&
      target.closest([
        "a[href]",
        "input",
        "select",
        "textarea",
        "button",
        "[role='button']",
        "[role='slider']",
        "[aria-valuemin]",
        "[aria-valuemax]",
        ".jw-controlbar",
        ".jw-icon",
        ".jw-slider",
        ".jw-knob",
        ".jw-display-icon-container",
        ".jw-display-icon",
        ".vjs-control-bar",
        ".vjs-control",
        ".vjs-big-play-button",
        ".plyr__controls",
        ".plyr__control"
      ].join(","));
    const playbackControl = (target) => {
      const control = playerControl(target);
      if (!control) return null;

      const label = [
        control.getAttribute("aria-label"),
        control.title,
        control.textContent,
        control.className
      ].filter(Boolean).join(" ");

      if (/(?:^|\b)(?:play|pause|resume|replay)(?:\b|$)|播放|暂停/i.test(label)) return control;
      if (control.matches && control.matches([
        ".jw-icon-playback",
        ".jw-display-icon-container",
        ".jw-display-icon",
        ".vjs-big-play-button",
        ".vjs-play-control",
        ".plyr__control--overlaid",
        ".plyr__control--play"
      ].join(","))) return control;

      return null;
    };
    const removePlayerAds = () => {
      document.querySelectorAll([
        "#dontfoid",
        ".play-overlay",
        ".ima-ad-container",
        "iframe[title='Advertisement']",
        "iframe[src*='imasdk.googleapis.com']"
      ].join(",")).forEach((el) => el.remove());
    };
    const directStreamtapeSrc = () => {
      if (!hostMatches(location.hostname.replace(/^www\./, ""), "streamtape.com")) return "";

      const link = [
        document.querySelector("#botlink"),
        document.querySelector("#robotlink"),
        document.querySelector("#ideoolink")
      ].map((el) => el && el.textContent && el.textContent.trim())
        .find((text) => text && /streamtape\.[a-z]+\/get_video\b/i.test(text));

      if (!link) return "";

      try {
        const url = new URL(link, location.href);
        url.searchParams.set("stream", "1");
        return url.href;
      } catch {
        return "";
      }
    };
    const prepareVideoSource = (video) => {
      removePlayerAds();
      if (!video || video.currentSrc || video.src) return;

      const src = directStreamtapeSrc();
      if (src) video.src = src;
    };
    const maintainPlayerSurface = () => {
      removePlayerAds();
      const layer = document.getElementById("supjav-playback-click-layer");
      if (layer) layer.remove();
    };

    const nativeOpen = window.open;
    const wrappedOpen = function (url, target, ...args) {
      if (blockedPopup(url, target)) {
        nudgePlayback();
        return fakeWindow;
      }
      return nativeOpen.call(this, url, target, ...args);
    };

    try {
      Object.defineProperty(window, "open", {
        configurable: false,
        writable: false,
        value: wrappedOpen
      });
    } catch {
      window.open = wrappedOpen;
    }

    const nativeClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (disabledDownloadControl(this)) return;
      if (blockedTargetNavigation(this.getAttribute("href") || this.href, this.target)) {
        nudgePlayback();
        return;
      }
      return nativeClick.call(this);
    };

    try {
      const nativeAssign = Location.prototype.assign;
      const nativeReplace = Location.prototype.replace;
      Location.prototype.assign = function (url) {
        if (blockedNavigation(url)) {
          nudgePlayback();
          return;
        }
        return nativeAssign.call(this, url);
      };
      Location.prototype.replace = function (url) {
        if (blockedNavigation(url)) {
          nudgePlayback();
          return;
        }
        return nativeReplace.call(this, url);
      };
    } catch {
      // Some browsers lock Location methods.
    }

    try {
      const nativeSubmit = HTMLFormElement.prototype.submit;
      const nativeRequestSubmit = HTMLFormElement.prototype.requestSubmit;
      HTMLFormElement.prototype.submit = function () {
        if (blockedTargetNavigation(formUrl(this), this.target)) {
          nudgePlayback();
          return;
        }
        return nativeSubmit.call(this);
      };
      if (nativeRequestSubmit) {
        HTMLFormElement.prototype.requestSubmit = function (...args) {
          if (blockedTargetNavigation(formUrl(this), this.target)) {
            nudgePlayback();
            return;
          }
          return nativeRequestSubmit.call(this, ...args);
        };
      }
    } catch {
      // Older browsers may not expose form submission methods on the prototype.
    }

    try {
      const nativeSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        if (/^src$/i.test(name) && /^(?:SCRIPT|IFRAME)$/i.test(this.tagName) && blocked(value)) return;
        return nativeSetAttribute.call(this, name, value);
      };

      for (const prototype of [HTMLScriptElement.prototype, HTMLIFrameElement.prototype]) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "src");
        if (!descriptor || !descriptor.set || descriptor.set.__supjavWrappedSrc) continue;
        const wrappedSet = function (value) {
          if (blocked(value)) return;
          return descriptor.set.call(this, value);
        };
        wrappedSet.__supjavWrappedSrc = true;
        Object.defineProperty(prototype, "src", {
          ...descriptor,
          set: wrappedSet
        });
      }

      const nativeAppendChild = Node.prototype.appendChild;
      const nativeInsertBefore = Node.prototype.insertBefore;
      Node.prototype.appendChild = function (node) {
        if (blockedResourceNode(node)) return node;
        return nativeAppendChild.call(this, node);
      };
      Node.prototype.insertBefore = function (node, child) {
        if (blockedResourceNode(node)) return node;
        return nativeInsertBefore.call(this, node, child);
      };
    } catch {
      // DOM insertion hooks are best-effort.
    }

    for (const type of ["pointerdown", "mousedown", "mouseup", "click", "auxclick", "touchstart"]) {
      document.addEventListener(type, (event) => {
        if (disabledDownloadControl(event.target)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }

        const link = event.target.closest && event.target.closest("a[href]");
        if (!link) return;
        const popupLikeTarget = explicitPopupTarget(link.target) || event.type === "auxclick" ? "_blank" : link.target;
        if (!blockedTargetNavigation(link.getAttribute("href") || link.href, popupLikeTarget)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        nudgePlayback();
      }, true);
    }

    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart"]) {
      document.addEventListener(type, (event) => {
        if (!playerArea(event.target) || playerControl(event.target)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    }

    document.addEventListener("click", (event) => {
      if (playerArea(event.target) && !playerControl(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      const playButton = playbackControl(event.target);
      if (!playButton) return;
      const video = document.querySelector("video");
      const shouldStartPlayback = !video || video.paused || video.ended;
      if (!shouldStartPlayback) return;
      setTimeout(() => {
        const latestVideo = document.querySelector("video");
        if (!latestVideo || latestVideo.paused || latestVideo.ended) nudgePlayback();
      }, 0);
    }, true);

    document.addEventListener("submit", (event) => {
      if (!blockedTargetNavigation(formUrl(event.target), event.target.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      nudgePlayback();
    }, true);

    maintainPlayerSurface();
    setInterval(maintainPlayerSurface, 500);
    new MutationObserver(maintainPlayerSurface)
      .observe(document.documentElement, { childList: true, subtree: true });
  }

  const addStyle = () => {
    const style = document.createElement("style");
    style.textContent = `
      .movv-ad,
      .play-ad,
      #lcb,
      [class*="root--26nWL"],
      [class*="bottomRight--"] {
        display: none !important;
        pointer-events: none !important;
      }
    `;
    document.documentElement.appendChild(style);
  };

  const cleanNode = (node) => {
    if (!node || node.nodeType !== 1) return;

    const nodes = node.matches && node.matches(adSelectors.join(","))
      ? [node]
      : [];

    if (node.querySelectorAll) {
      nodes.push(...node.querySelectorAll(adSelectors.join(",")));
    }

    for (const el of nodes) {
      const url = el.src || el.href;
      if (url && blocked(url)) {
        el.remove();
      } else if (el.matches(".movv-ad,.play-ad,#lcb,[class*='root--26nWL'],[class*='bottomRight--']")) {
        el.remove();
      }
    }
  };

  const playerSrc = (link, bg) =>
    `https://lk1.supremejav.com/supjav.php?l=${encodeURIComponent(link)}&bg=${encodeURIComponent(bg || "")}`;

  const playerAllow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
  const playerIframeHtml = (src) =>
    `<iframe id="video" src="${src}" width="100%" height="550" frameborder="0" allow="${playerAllow}" allowfullscreen></iframe>`;

  const lockPlayerIframe = (iframe) => {
    if (!iframe) return;
    iframe.setAttribute("allow", playerAllow);
    iframe.removeAttribute("sandbox");
    iframe.setAttribute("allowfullscreen", "");
  };

  const restoreLazyImages = (root = document) => {
    if (!hostMatches(location.hostname.replace(/^www\./, ""), "supjav.com")) return;

    const nodes = root.matches && root.matches("img")
      ? [root]
      : [];

    if (root.querySelectorAll) {
      nodes.push(...root.querySelectorAll("img[data-src],img[data-original],img[data-lazy-src]"));
    }

    for (const img of nodes) {
      const src = img.getAttribute("data-src") ||
        img.getAttribute("data-original") ||
        img.getAttribute("data-lazy-src");

      if (!src || img.src === src) continue;
      if ((img.currentSrc || img.src || "").startsWith("data:image/") || img.naturalWidth <= 1) {
        img.src = src;
      }
    }
  };

  const formatClock = (seconds, withFraction = false) => {
    seconds = Math.max(0, Number(seconds) || 0);
    const whole = Math.floor(seconds);
    const hh = String(Math.floor(whole / 3600)).padStart(2, "0");
    const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
    const ss = String(whole % 60).padStart(2, "0");
    if (!withFraction) return `${hh}:${mm}:${ss}`;
    const fraction = Math.round((seconds - whole) * 100);
    return `${hh}:${mm}:${ss}.${String(fraction).padStart(2, "0")}`;
  };

  const quoteCmdArg = (value) => `"${String(value || "").replace(/"/g, "'")}"`;

  const latestExportState = () =>
    [...exportStates.values()]
      .filter((state) => state && (state.streamUrl || state.videoSrc))
      .sort((a, b) => (b.receivedAt || 0) - (a.receivedAt || 0))[0] || null;

  const installExportStateReceiver = () => {
    if (window.__supjavExportReceiverInstalled) return;
    window.__supjavExportReceiverInstalled = true;

    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.type !== exportStateMessage) return;
      if (!data.href) return;

      const key = `${data.href}|${data.streamUrl || data.videoSrc || ""}`;
      exportStates.set(key, {
        ...data,
        receivedAt: Date.now()
      });
    });
  };

  const requestExportState = () => {
    document.querySelectorAll("iframe").forEach((iframe) => {
      try {
        iframe.contentWindow.postMessage({ type: exportStateRequest }, "*");
      } catch {
        // Cross-origin iframe requests are best-effort.
      }
    });
  };

  const copyText = async (text) => {
    try {
      if (typeof GM_setClipboard === "function") {
        GM_setClipboard(text, "text");
        return true;
      }
    } catch {
      // Fall through to the browser clipboard API.
    }

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  const showExportPanel = (text, copied) => {
    document.getElementById("supjav-export-panel")?.remove();

    const panel = document.createElement("div");
    panel.id = "supjav-export-panel";
    panel.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "width:min(720px,calc(100vw - 32px))",
      "background:#111",
      "color:#eee",
      "border:1px solid #444",
      "box-shadow:0 8px 24px rgba(0,0,0,.35)",
      "padding:10px",
      "font:12px/1.4 Consolas,monospace"
    ].join(";");

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px";

    const status = document.createElement("span");
    status.textContent = copied ? "已复制导出内容" : "复制失败，手动复制下面内容";

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.style.cssText = "cursor:pointer";
    close.addEventListener("click", () => panel.remove());

    const area = document.createElement("textarea");
    area.value = text;
    area.readOnly = true;
    area.style.cssText = [
      "box-sizing:border-box",
      "width:100%",
      "height:220px",
      "background:#050505",
      "color:#eee",
      "border:1px solid #333",
      "padding:8px",
      "font:12px/1.4 Consolas,monospace",
      "resize:vertical"
    ].join(";");
    area.addEventListener("focus", () => area.select());

    header.append(status, close);
    panel.append(header, area);
    document.documentElement.appendChild(panel);
    area.focus();
  };

  const buildExportText = (state) => {
    const streamUrl = state.streamUrl || state.videoSrc || "";
    const server = (document.querySelector(".btn-server.active") || document.querySelector(".btn-server"))?.textContent?.trim() || "";
    const title = document.querySelector("h1")?.textContent?.trim() || document.title || "";
    const current = Number(state.currentTime) || 0;
    const duration = Number(state.duration) || 0;
    const width = Number(state.width) || 0;
    const height = Number(state.height) || 0;
    const resolution = width > 0 && height > 0 ? `${width}x${height}` : (state.quality || "unknown");
    const userAgent = state.userAgent || navigator.userAgent;
    const headers = Array.isArray(state.headers) ? state.headers.filter(Boolean) : [];
    const referer = state.referer || "";
    const headerValue = (name) => {
      const prefix = `${name.toLowerCase()}:`;
      const line = headers.find((item) => String(item).toLowerCase().startsWith(prefix));
      return line ? line.slice(line.indexOf(":") + 1).trim() : "";
    };
    const headerArg = headers.length ? ` /headers=${quoteCmdArg(headers.join("\\r\\n"))}` : "";
    const refererArg = referer ? ` /referer=${quoteCmdArg(referer)}` : "";
    const seekArg = ` /seek=${formatClock(current, true)}`;
    const potPlayer = `${quoteCmdArg("C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe")} ${quoteCmdArg(streamUrl)} /user_agent=${quoteCmdArg(userAgent)}${refererArg}${headerArg}${seekArg} /new`;
    const origin = headerValue("Origin");
    const proxyParts = [
      "node",
      quoteCmdArg("scripts\\supjav-potplayer-proxy.js"),
      "--url",
      quoteCmdArg(streamUrl),
      "--seek",
      quoteCmdArg(current.toFixed(2)),
      "--user-agent",
      quoteCmdArg(userAgent)
    ];
    if (origin) proxyParts.push("--origin", quoteCmdArg(origin));
    if (referer) proxyParts.push("--referer", quoteCmdArg(referer));
    const localProxy = proxyParts.join(" ");
    const streamList = (state.streams || [])
      .map((item, index) => `${index + 1}. ${item.url}`)
      .join("\n");

    return [
      "Supjav Export",
      `Title: ${title}`,
      `Page: ${location.href}`,
      `Server: ${server}`,
      `Player: ${state.href || ""}`,
      `Start: ${formatClock(current, true)} (${current.toFixed(2)}s)`,
      duration ? `Duration: ${formatClock(duration, true)} (${duration.toFixed(2)}s)` : "Duration: unknown",
      `Resolution: ${resolution}`,
      "",
      "Stream URL:",
      streamUrl || "(not captured yet)",
      "",
      "Headers:",
      referer ? `Referer: ${referer}` : "Referer: ",
      ...headers,
      "",
      "PotPlayer:",
      potPlayer,
      "",
      "PotPlayer local proxy:",
      localProxy,
      "Close the proxy console after PotPlayer is closed.",
      "",
      "Captured streams:",
      streamList || "(none)"
    ].join("\n");
  };

  const exportCurrentLink = async (button) => {
    requestExportState();
    await new Promise((resolve) => setTimeout(resolve, 350));

    const state = latestExportState();
    if (!state || !(state.streamUrl || state.videoSrc)) {
      showExportPanel("还没有抓到播放流。先播放视频几秒，或者切换一次播放源后再导出。", false);
      return;
    }

    const text = buildExportText(state);
    const copied = await copyText(text);
    showExportPanel(text, copied);

    if (button) {
      const original = button.textContent;
      button.textContent = copied ? "已复制" : "已生成";
      setTimeout(() => {
        button.textContent = original || "导出链接";
      }, 1200);
    }
  };

  const installExportButton = () => {
    if (!hostMatches(location.hostname.replace(/^www\./, ""), "supjav.com")) return;
    if (document.getElementById("supjav-export-link")) return;

    const serverButton = document.querySelector(".btn-server[data-link]");
    if (!serverButton || !serverButton.parentNode) return;

    const button = document.createElement("button");
    button.id = "supjav-export-link";
    button.type = "button";
    button.textContent = "导出链接";
    button.style.cssText = [
      "margin-left:8px",
      "padding:2px 8px",
      "cursor:pointer",
      "border:1px solid #777",
      "background:#222",
      "color:#fff",
      "font:12px/1.6 Arial,sans-serif"
    ].join(";");
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await exportCurrentLink(button);
    });

    serverButton.parentNode.insertBefore(button, serverButton.parentNode.lastChild?.nextSibling || null);
  };

  const installSupjavPlayer = () => {
    if (!hostMatches(location.hostname.replace(/^www\./, ""), "supjav.com")) return;

    const mount = () => {
      const box = document.querySelector("#dz_video");
      const btn = document.querySelector(".btn-server.active[data-link], .btn-server[data-link]");
      if (!box || !btn || box.dataset.userscriptPlayer === "1") return;

      box.dataset.userscriptPlayer = "1";
      box.innerHTML = playerIframeHtml(playerSrc(btn.getAttribute("data-link"), box.getAttribute("bg")));
    };

    document.addEventListener("click", (event) => {
      const btn = event.target.closest && event.target.closest(".btn-server[data-link]");
      if (!btn) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      exportStates.clear();
      document.querySelectorAll(".btn-server").forEach((el) => el.classList.toggle("active", el === btn));

      const box = document.querySelector("#dz_video");
      const iframe = document.querySelector("#video");
      const src = playerSrc(btn.getAttribute("data-link"), box && box.getAttribute("bg"));
      if (iframe) {
        lockPlayerIframe(iframe);
        iframe.src = src;
      }
      else if (box) {
        box.dataset.userscriptPlayer = "1";
        box.innerHTML = playerIframeHtml(src);
      }
    }, true);

    mount();
    setTimeout(mount, 500);
    setTimeout(mount, 1500);
  };

  const start = () => {
    if (ignoredContext()) return;
    const relevant = relevantContext();
    if (relevant) {
      installPopupGuard();
      installDirectOpenGuard();
    }
    injectBlankTabPatch();
    if (closeBlockedPopup()) return;
    if (!relevant) return;
    injectPagePatch();
    addStyle();
    cleanNode(document.documentElement);
    restoreLazyImages(document.documentElement);
    installExportStateReceiver();
    installSupjavPlayer();
    installExportButton();

    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          cleanNode(node);
          restoreLazyImages(node);
        }
      }
      restoreLazyImages(document.documentElement);
      installSupjavPlayer();
      installExportButton();
    }).observe(document.documentElement, { childList: true, subtree: true });
  };

  const waitForDocument = () => {
    if (!document.documentElement) {
      setTimeout(waitForDocument, 10);
      return;
    }
    if (ignoredContext()) return;
    if (maybeSupjavChallengeBoot()) {
      setTimeout(waitForDocument, 100);
      return;
    }
    if (cloudflareChallengeContext()) {
      setTimeout(waitForDocument, 250);
      return;
    }
    start();
  };

  waitForDocument();
})();
