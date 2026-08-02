/**
 * Soften common automation fingerprints in the Cloudflare unlock window.
 * Loaded with contextIsolation:false so patches apply to the page world.
 * Does not invent a fake WebGL renderer — mismatched GPU strings look worse.
 */
;(() => {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
    })
  } catch {
    /* ignore */
  }

  try {
    if (!navigator.plugins || navigator.plugins.length === 0) {
      const fake = {
        0: { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        1: {
          name: 'Chrome PDF Viewer',
          filename: 'internal-pdf-viewer',
          description: 'Portable Document Format',
        },
        2: {
          name: 'Chromium PDF Viewer',
          filename: 'internal-pdf-viewer',
          description: 'Portable Document Format',
        },
        length: 3,
        item(i) {
          return this[i] || null
        },
        namedItem(name) {
          for (let i = 0; i < this.length; i++) if (this[i].name === name) return this[i]
          return null
        },
        refresh() {},
      }
      Object.defineProperty(Navigator.prototype, 'plugins', {
        get: () => fake,
        configurable: true,
      })
      Object.defineProperty(Navigator.prototype, 'mimeTypes', {
        get: () => ({
          length: 2,
          item: () => null,
          namedItem: () => null,
        }),
        configurable: true,
      })
    }
  } catch {
    /* ignore */
  }

  try {
    if (!window.chrome) window.chrome = {}
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        connect: () => ({}),
        sendMessage: () => {},
        id: undefined,
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const langs = ['en-US', 'en']
    Object.defineProperty(Navigator.prototype, 'languages', {
      get: () => langs,
      configurable: true,
    })
    Object.defineProperty(Navigator.prototype, 'language', {
      get: () => 'en-US',
      configurable: true,
    })
  } catch {
    /* ignore */
  }
})()
