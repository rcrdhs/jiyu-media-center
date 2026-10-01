import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.jiyu.mediacenter',
  appName: 'Jiyu',
  webDir: 'dist',
  // Do NOT globally patch fetch/XHR — that rewrites response.url to https://localhost/
  // and breaks hls.js relative playlist/segment resolution (TVJ / IPTV live).
  // Catalog sync still calls CapacitorHttp.get/post explicitly via src/lib/nativeHttp.ts.
  plugins: {
    CapacitorHttp: {
      enabled: false,
    },
  },
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
}

export default config
