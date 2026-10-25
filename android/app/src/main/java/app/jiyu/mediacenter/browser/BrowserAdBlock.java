package app.jiyu.mediacenter.browser;

/**
 * Shared ad / hijack URL checks for Gecko overlays.
 * Keep roughly aligned with electron/main.cjs {@code isAdHijackUrl} /
 * {@code shouldBlockBrowserNavigation}.
 */
final class BrowserAdBlock {
  private BrowserAdBlock() {}

  /** Shared list (electron/ad-block-list.json, copied by scripts/sync-ad-block-list.cjs). */
  static final String LIST_ASSET = "jiyu-gecko-bridge/ad-block-list.json";
  private static volatile java.util.Set<String> sListHosts = java.util.Collections.emptySet();
  private static volatile java.util.List<java.util.regex.Pattern> sListPatterns =
    java.util.Collections.emptyList();
  private static volatile boolean sListLoaded = false;

  static synchronized void init(android.content.Context context) {
    if (sListLoaded || context == null) return;
    sListLoaded = true;
    try (java.io.InputStream in = context.getAssets().open(LIST_ASSET)) {
      java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
      byte[] buf = new byte[4096];
      int n;
      while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
      org.json.JSONObject json =
        new org.json.JSONObject(new String(out.toByteArray(), java.nio.charset.StandardCharsets.UTF_8));
      java.util.Set<String> hosts = new java.util.HashSet<>();
      org.json.JSONArray h = json.optJSONArray("hosts");
      if (h != null) {
        for (int i = 0; i < h.length(); i++) {
          String v = h.optString(i, "").trim().toLowerCase();
          if (!v.isEmpty()) hosts.add(v);
        }
      }
      java.util.List<java.util.regex.Pattern> patterns = new java.util.ArrayList<>();
      org.json.JSONArray p = json.optJSONArray("urlPatterns");
      if (p != null) {
        for (int i = 0; i < p.length(); i++) {
          try {
            patterns.add(java.util.regex.Pattern.compile(p.optString(i, ""), java.util.regex.Pattern.CASE_INSENSITIVE));
          } catch (Throwable ignored) {}
        }
      }
      sListHosts = hosts;
      sListPatterns = patterns;
      android.util.Log.i("JiyuGecko", "adblock shared list " + hosts.size() + " hosts " + patterns.size() + " patterns");
    } catch (Throwable t) {
      android.util.Log.w("JiyuGecko", "adblock shared list load failed: " + t);
    }
  }

  /** Host suffix or URL pattern match against the shared list. */
  static boolean isListedAdUrl(String url) {
    if (url == null || url.isEmpty()) return false;
    String host = hostOf(url);
    if (!host.isEmpty()) {
      java.util.Set<String> hosts = sListHosts;
      String h = host;
      while (!h.isEmpty()) {
        if (hosts.contains(h)) return true;
        int dot = h.indexOf('.');
        if (dot < 0) break;
        h = h.substring(dot + 1);
      }
    }
    for (java.util.regex.Pattern p : sListPatterns) {
      if (p.matcher(url).find()) return true;
    }
    return false;
  }

  /**
   * Schemes a stream page may never open: intent:, market:, app deep links, etc.
   * (Gecko would otherwise hand them to Android and launch the store / another app.)
   */
  static boolean isExternalAppScheme(String url) {
    if (url == null || url.isEmpty()) return false;
    int colon = url.indexOf(':');
    if (colon <= 0) return false;
    String scheme = url.substring(0, colon).toLowerCase();
    switch (scheme) {
      case "http":
      case "https":
      case "about":
      case "data":
      case "blob":
      case "javascript":
      case "moz-extension":
      case "resource":
      case "chrome":
      case "file":
        return false;
      default:
        return true;
    }
  }

  static boolean shouldBlockNavigation(String url) {
    return isBlockedDownloadUrl(url)
      || isAdHijackUrl(url)
      || isDeadPlaceholderUrl(url)
      || isStreamRefererOnlyUrl(url);
  }

  static boolean isStreamRefererOnlyUrl(String url) {
    String host = hostOf(url);
    if (host.isEmpty()) return false;
    return host.equals("atlantic.st")
      || host.endsWith(".atlantic.st")
      || host.equals("movy.sx")
      || host.endsWith(".movy.sx");
  }

  static boolean isBlockedDownloadUrl(String url) {
    if (url == null || url.isEmpty()) return false;
    String raw = url;
    if (raw.matches("(?i).*(utm_source=PRIMEROLL|OperaSetup|opera/stable/windows).*")) return true;
    if (raw.matches("(?i).*(net\\.geo\\.opera\\.com|download\\.opera\\.com|get\\.opera\\.com).*")) {
      return true;
    }
    return raw.matches("(?i).*\\.(exe|msi|dmg|pkg|bat|cmd|ps1|apk)(\\?|#|$).*");
  }

  static boolean isDeadPlaceholderUrl(String url) {
    if (url == null || url.isEmpty()) return false;
    if (url.matches("(?i).*/undefined(?:/|\\?|#|$).*")) return true;
    if (url.matches("(?i).*[?&](?:tmdb|id|tv|movie)=undefined\\b.*")) return true;
    if (url.matches("(?i)^chrome-error:|chromewebdata.*")) return true;
    String host = hostOf(url);
    if (host.isEmpty()) return false;
    if (host.matches("(?i)(^|\\.)example\\.(com|net|org)$")) return true;
    if (host.matches("(?i)(^|\\.)invalid$")) return true;
    if (host.matches("(?i)(^|\\.)nextgencloudfabric\\.com$")) return true;
    return host.equals("0.0.0.0");
  }

  static boolean isAdHijackUrl(String url) {
    if (url == null || url.isEmpty()) return false;
    if (isListedAdUrl(url)) return true;
    String raw = url;
    if (raw.matches(
      "(?i).*(PWNgames|utm_source=PWN|OperaSetup|opera_gx|get/opera|promo\\.worldofwarships|"
        + "worldofwarships\\.com/glow|utm_source=PRIMEROLL|download.*(browser|player)|"
        + "install.*(browser|player)|pt[=:][\"']?tabup|\"pt\"\\s*:\\s*\"tabup\"|"
        + "effectivecpmnetwork|gunacarduus).*")) {
      return true;
    }
    String host = hostOf(raw);
    if (host.isEmpty()) return false;
    if (host.matches(
      "(?i)(^|\\.)(drimzzzz\\.info|wpnxiswpuyrfn\\.icu|therocketlanguages\\.com|opera\\.com|"
        + "geo\\.opera\\.com|download\\.opera\\.com|get\\.opera\\.com|worldofwarships\\.com|"
        + "wargaming\\.net|wgcdn\\.co|adaround\\.net|popads\\.net|propellerads\\.com|"
        + "exoclick\\.com|trafficjunky\\.net|juicyads\\.com|tsyndicate\\.com|adsterra\\.com|"
        + "doubleclick\\.net|googlesyndication\\.com|googleadservices\\.com|"
        + "adservice\\.google\\.com|taboola\\.com|outbrain\\.com|adultfriendfinder\\.com|"
        + "stripchat\\.com|chaturbate\\.com|pornhub\\.com|xvideos\\.com|xnxx\\.com|"
        + "xhamster\\.com|livejasmin\\.com|maleinsider\\.org|soulk\\.com|soulk\\.net|"
        + "effectivecpmnetwork\\.com|hgcloud\\.to)$")) {
      return true;
    }
    // Rotating adware TLDs used by sports-embed "tabup" popups.
    if (host.endsWith(".cyou") || host.endsWith(".icu") || host.endsWith(".cfd")) {
      if (raw.matches("(?i).*(ck9=|tabup|psid=|adsystem|clickid).*")) return true;
    }
    return false;
  }

  /** True when the page should stay locked as a player surface (block top-level hijacks). */
  static boolean isPlayerEmbedHost(String url) {
    String host = hostOf(url);
    if (host.isEmpty()) return false;
    if (host.equals("embed.st") || host.endsWith(".embed.st")) return true;
    if (host.equals("embedhd.st") || host.endsWith(".embedhd.st")) return true;
    if (host.equals("embedindia.st") || host.endsWith(".embedindia.st")) return true;
    if (host.equals("streamed.pk") || host.endsWith(".streamed.pk")) return true;
    if (host.equals("ppv.st") || host.endsWith(".ppv.st")) return true;
    if (host.equals("ppvservices.st") || host.endsWith(".ppvservices.st")) return true;
    if (host.equals("rivestream.ru") || host.endsWith(".rivestream.ru")) return true;
    if (host.equals("fstream365.com") || host.endsWith(".fstream365.com")) return true;
    if (host.equals("vsembed.ru") || host.endsWith(".vsembed.ru")) return true;
    if (host.equals("soccerfull.net") || host.endsWith(".soccerfull.net")) return true;
    if (host.contains("livextv")) return true;
    if (host.equals("playmate.to") || host.endsWith(".playmate.to")) return true;
    if (host.equals("playmogo.com") || host.endsWith(".playmogo.com")) return true;
    if (host.equals("hanerix.com") || host.endsWith(".hanerix.com")) return true;
    try {
      String path = new java.net.URI(url).getPath();
      if (path != null && path.matches("(?i)^/[de]/[a-z0-9]{6,}.*")) return true;
    } catch (Throwable ignored) {}
    return false;
  }

  static boolean isAllowedPlayerNav(String fromUrl, String toUrl) {
    if (!isPlayerEmbedHost(fromUrl)) return true;
    if (toUrl == null || toUrl.isEmpty()) return false;
    if (toUrl.matches("(?i)^(about:blank|about:srcdoc).*")) return true;
    if (isPlayerEmbedHost(toUrl)) return true;
    // Same-site hops (source switchers) stay allowed.
    String fromHost = hostOf(fromUrl);
    String toHost = hostOf(toUrl);
    if (!fromHost.isEmpty() && fromHost.equals(toHost)) return true;
    return false;
  }

  private static String hostOf(String url) {
    if (url == null || url.isEmpty()) return "";
    try {
      String host = new java.net.URI(url).getHost();
      if (host == null) return "";
      return host.replaceFirst("^www\\.", "").toLowerCase();
    } catch (Throwable t) {
      return "";
    }
  }
}
