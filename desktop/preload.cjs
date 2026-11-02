const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codioDesktop", {
  isDesktop: true,
  systemVolume: {
    getStatus: () => ipcRenderer.invoke("codio:system-volume-get"),
    setVolume: (value) => ipcRenderer.invoke("codio:system-volume-set", value),
    subscribe: (listener) => {
      if (typeof listener !== "function") return () => {};
      const handler = (_event, status) => listener(status);
      ipcRenderer.on("codio:system-volume-changed", handler);
      return () => ipcRenderer.removeListener("codio:system-volume-changed", handler);
    },
  },
  localMusic: {
    import: (mode = "files") => ipcRenderer.invoke("codio:local-import", mode),
    library: () => ipcRenderer.invoke("codio:local-library"),
  },
  qqMusic: {
    getStatus: (options) => ipcRenderer.invoke("codio:qq-status", { recover: options?.recover !== false }),
    login: (options) => ipcRenderer.invoke("codio:qq-login", { forceAuthorization: options?.forceAuthorization === true }),
    logout: () => ipcRenderer.invoke("codio:qq-logout"),
    search: (query, page = 1) => ipcRenderer.invoke("codio:qq-search", query, page),
    metadata: (trackId) => ipcRenderer.invoke("codio:qq-metadata", trackId),
    lyrics: (track) => ipcRenderer.invoke("codio:qq-lyrics", track),
    library: (options) => ipcRenderer.invoke("codio:qq-library", options?.force === true),
    play: (track) => ipcRenderer.invoke("codio:qq-play", track),
    cover: (url) => ipcRenderer.invoke("codio:qq-cover", url),
  },
  ai: {
    getStatus: () => ipcRenderer.invoke("codio:ai-status"),
    saveKey: (key) => ipcRenderer.invoke("codio:ai-save-key", key),
    clearKey: () => ipcRenderer.invoke("codio:ai-clear-key"),
    step: (request) => ipcRenderer.invoke("codio:ai-step", request),
  },
  onboarding: {
    get: () => ipcRenderer.invoke("codio:onboarding-get"),
    save: (value) => ipcRenderer.invoke("codio:onboarding-save", value),
  },
  analysis: {
    get: (trackId, version = 3) => ipcRenderer.invoke("codio:analysis-get", trackId, version),
    save: (trackId, analysis) => ipcRenderer.invoke("codio:analysis-save", trackId, analysis),
  },
});
