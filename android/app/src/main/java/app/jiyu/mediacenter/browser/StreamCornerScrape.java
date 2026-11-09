package app.jiyu.mediacenter.browser;

/**
 * StreamCorner's first document is an SPA shell. Watch cards show up only after
 * its script paints root-relative {@code /stream/} and {@code /nba/} links —
 * the same hrefs {@code parseStreamCornerCatalogHtml} reads. Desktop waits for
 * those links; a shell snapshot has a title and a {@code #root} and nothing else.
 */
public final class StreamCornerScrape {
  private StreamCornerScrape() {}

  public static boolean htmlHasWatchLinks(String html) {
    if (html == null || html.length() < 40) return false;
    return html.contains("href=\"/stream/")
      || html.contains("href='/stream/")
      || html.contains("href=\"/nba/")
      || html.contains("href='/nba/");
  }
}
