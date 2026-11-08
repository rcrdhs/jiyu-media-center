package app.jiyu.mediacenter.browser;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The Android scrape used to return StreamCorner's SPA shell (a normal 200
 * with #root and no watch hrefs). Desktop waits until /stream or /nba links
 * exist. These strings are the two documents observed on 2026-11-08.
 */
public class StreamCornerScrapeTest {
  /** Homepage before the schedule script paints. Longer than the 40-char floor. */
  private static final String SPA_SHELL =
    "<!doctype html><html><head><title>StreamCorner</title></head>"
      + "<body><div id=\"root\"></div>"
      + "<script type=\"module\" src=\"/assets/app.js\"></script></body></html>";

  private static final String RENDERED_CARD =
    "<html><body><div class=\"min-w-0 h-full\">"
      + "<a href=\"/stream/admin/abc123\"><h3>FC Cologne vs. Bayer Leverkusen</h3>"
      + "<p>Bundesliga</p><span>LIVE</span></a></div></body></html>";

  @Test
  public void shellHasNoWatchLinks() {
    assertFalse(StreamCornerScrape.htmlHasWatchLinks(null));
    assertFalse(StreamCornerScrape.htmlHasWatchLinks(""));
    assertFalse(StreamCornerScrape.htmlHasWatchLinks("<html><body>short</body></html>"));
    assertFalse(StreamCornerScrape.htmlHasWatchLinks(SPA_SHELL));
    // Absolute hrefs are not what the catalog parser reads.
    assertFalse(StreamCornerScrape.htmlHasWatchLinks(
      SPA_SHELL.replace("</body>", "<a href=\"https://streamcorner.fun/stream/admin/x\">x</a></body>")
    ));
  }

  @Test
  public void renderedCardsCountAsReady() {
    assertTrue(StreamCornerScrape.htmlHasWatchLinks(RENDERED_CARD));
    assertTrue(StreamCornerScrape.htmlHasWatchLinks(
      "<html><body><a href='/nba/live/game-1'>NBA</a><span>padding-to-clear-the-length-floor</span></body></html>"
    ));
    assertTrue(StreamCornerScrape.htmlHasWatchLinks(
      "<html><body><a href=\"/nba/vod/replay-9\">Replay</a><span>padding-to-clear-the-length-floor</span></body></html>"
    ));
  }
}
