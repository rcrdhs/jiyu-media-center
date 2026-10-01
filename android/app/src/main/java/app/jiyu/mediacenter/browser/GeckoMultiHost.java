package app.jiyu.mediacenter.browser;

import android.content.Context;
import android.graphics.Color;
import android.media.AudioManager;
import android.media.AudioPlaybackConfiguration;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import org.json.JSONObject;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.MediaSession;
import org.mozilla.geckoview.WebExtension;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * One GeckoSession per multiview tile. The selected session stays audible;
 * the others get {@link MediaSession#muteAudio(boolean)} and keep decoding.
 */
final class GeckoMultiHost {
  private static final class Tile {
    String url;
    String loadedUrl;
    float x;
    float y;
    float w;
    float h;
    boolean primary;
    GeckoView view;
    GeckoSession session;
    MediaSession media;
    boolean audioReady;
    boolean kickArmed;
    final CopyOnWriteArrayList<WebExtension.Port> ports = new CopyOnWriteArrayList<>();
  }

  private final Handler main = new Handler(Looper.getMainLooper());
  private final Map<String, Tile> tiles = new LinkedHashMap<>();
  private boolean active;
  private boolean shellReady;
  private boolean shellLoadPending;
  private int shellAttempts;
  private float density = 1f;

  boolean isActive() {
    return active;
  }

  void show(
    GeckoOverlayController gecko,
    String id,
    String url,
    float x,
    float y,
    float w,
    float h,
    boolean primary,
    float density
  ) {
    if (gecko == null || id == null || url == null) return;
    active = true;
    this.density = density > 0 ? density : 1f;
    Tile tile = tiles.get(id);
    if (tile == null) {
      tile = new Tile();
      tiles.put(id, tile);
    }
    tile.url = url;
    tile.x = x;
    tile.y = y;
    tile.w = w;
    tile.h = h;
    // One stream always plays out loud. Mute starts only once a second tile exists.
    if (tiles.size() == 1) tile.primary = true;
    else tile.primary = primary;
    if (tile.primary) {
      for (Map.Entry<String, Tile> e : tiles.entrySet()) {
        e.getValue().primary = id.equals(e.getKey());
      }
    }
    ensurePrimary();
    parkSingleStream(gecko);
    ensureTile(gecko, tile);
    placeTile(tile);
    loadTileIfNeeded(tile);
    scheduleKick(tile);
    // Mute only after a second stream is on screen. Selecting one stream stays audible.
    if (tiles.size() >= 2) {
      pushTileAudio();
      ensureHeartbeat();
      ensureFocusWatch(gecko);
    }
  }

  void setBounds(
    GeckoOverlayController gecko,
    String id,
    float x,
    float y,
    float w,
    float h,
    float density
  ) {
    Tile tile = tiles.get(id);
    if (tile == null || gecko == null) return;
    this.density = density > 0 ? density : this.density;
    tile.x = x;
    tile.y = y;
    tile.w = w;
    tile.h = h;
    placeTile(tile);
  }

  void setAudio(GeckoOverlayController gecko, String id, boolean muted) {
    Tile tile = tiles.get(id);
    if (tile == null) return;
    if (tiles.size() < 2) {
      tile.primary = true;
      applyMute();
      return;
    }
    if (!muted) {
      for (Map.Entry<String, Tile> e : tiles.entrySet()) {
        e.getValue().primary = id.equals(e.getKey());
      }
    } else if (tile.primary) {
      tile.primary = false;
    }
    ensurePrimary();
    applyMute();
  }

  void spotlight(GeckoOverlayController gecko, String id) {
    if (!tiles.containsKey(id)) return;
    for (Map.Entry<String, Tile> e : tiles.entrySet()) {
      e.getValue().primary = id.equals(e.getKey());
    }
    applyMute();
  }

  void nudge(GeckoOverlayController gecko, String id) {
    Tile tile = tiles.get(id);
    if (tile == null || tile.media == null) return;
    try {
      tile.media.muteAudio(wantsMute(tile));
    } catch (Throwable ignored) {}
  }

  void hide(GeckoOverlayController gecko, String id) {
    if (id == null) return;
    Tile removed = tiles.remove(id);
    releaseTile(removed);
    if (tiles.isEmpty()) {
      hideAll(gecko);
      return;
    }
    boolean anyPrimary = false;
    for (Tile tile : tiles.values()) {
      if (tile.primary) anyPrimary = true;
    }
    if (!anyPrimary) tiles.values().iterator().next().primary = true;
    applyMute();
  }

  void hideAll(GeckoOverlayController gecko) {
    endWithoutBlank(gecko);
    if (gecko == null) return;
    try {
      gecko.stopAndBlank();
    } catch (Throwable ignored) {}
    gecko.setVisibility(View.GONE);
  }

  /** Drop tile sessions without blanking the single-stream view. The next load replaces it. */
  void endWithoutBlank(GeckoOverlayController gecko) {
    active = false;
    overlayParked = false;
    shellReady = false;
    shellLoadPending = false;
    shellAttempts = 0;
    loadedSignature = "";
    releaseAllTiles();
    stopFocusWatch(gecko);
    if (gecko != null) gecko.setPageStopListener(null);
  }

  private boolean overlayParked;

  /** The single-stream view must not keep playing under the tile sessions. */
  private void parkSingleStream(GeckoOverlayController gecko) {
    if (gecko == null || overlayParked) return;
    overlayParked = true;
    gecko.setVisibility(View.GONE);
    try {
      gecko.stopAndBlank();
    } catch (Throwable ignored) {}
  }

  private void ensureTile(GeckoOverlayController gecko, Tile tile) {
    if (gecko == null || gecko.getView() == null) return;
    if (!(gecko.getView().getParent() instanceof FrameLayout)) return;
    FrameLayout parent = (FrameLayout) gecko.getView().getParent();
    if (tile.session == null || tile.view == null) {
      final Tile bound = tile;
      tile.session = gecko.openTileSession(mediaDelegate(tile), () -> wantsMute(bound));
      tile.view = new GeckoView(parent.getContext());
      tile.view.setBackgroundColor(Color.BLACK);
      tile.view.setSession(tile.session);
      FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(1, 1);
      lp.gravity = android.view.Gravity.NO_GRAVITY;
      tile.view.setLayoutParams(lp);
      parent.addView(tile.view);
      gecko.bindTileAudio(
        tile.session,
        tile.ports,
        () -> wantsMute(bound),
        () -> bound.audioReady = true,
        message -> main.post(() -> onTilePortMessage(bound, message))
      );
      // Do not wait on the extension. The play button is page UI; holding the
      // navigation made both tiles sit on a blank surface.
      tile.audioReady = true;
    }
    tile.view.setVisibility(View.VISIBLE);
    try {
      tile.session.setActive(true);
    } catch (Throwable ignored) {}
  }

  private void scheduleKick(Tile tile) {
    if (tile == null || tile.kickArmed) return;
    tile.kickArmed = true;
    int[] delays = { 400, 1000, 1800, 3200, 5200 };
    for (int delay : delays) {
      main.postDelayed(() -> postKick(tile), delay);
    }
    // Content-script kicks give up at 8s. Then aim a trusted tap at the real button.
    main.postDelayed(() -> queryPlayButtonAndTap(tile), 8600);
  }

  /** Mute a passive session first, then ask the content script to click Play once. */
  private void postKick(Tile tile) {
    if (!active || tile == null || tile.session == null) return;
    boolean muted = wantsMute(tile);
    if (muted && tile.media != null) {
      try {
        tile.media.muteAudio(true);
      } catch (Throwable ignored) {}
    }
    for (WebExtension.Port port : tile.ports) {
      GeckoOverlayController.postTileAudio(port, muted);
      GeckoOverlayController.postTileKick(port, muted);
    }
  }

  private int rectSeq;
  private final Map<Integer, RectWait> rectWaits = new java.util.HashMap<>();

  private static final class RectWait {
    Tile tile;
    int expect;
    int got;
    boolean tapped;
    boolean have;
    boolean fromTop;
    float cx;
    float cy;
    float dpr;
    float vw;
    float vh;
  }

  /** After the play-button clicks miss, measure it and tap that point. */
  private void queryPlayButtonAndTap(Tile tile) {
    if (!active || tile == null || tile.session == null || tile.view == null) return;
    if (tile.ports.isEmpty() || skipPlayTap(tile.url)) return;
    if (wantsMute(tile) && tile.media != null) {
      try {
        tile.media.muteAudio(true);
      } catch (Throwable ignored) {}
    }
    int id = ++rectSeq;
    RectWait wait = new RectWait();
    wait.tile = tile;
    wait.expect = tile.ports.size();
    rectWaits.put(id, wait);
    for (WebExtension.Port port : tile.ports) {
      GeckoOverlayController.postQueryPlayButtonRect(port, id, 20);
    }
    main.postDelayed(() -> finishPlayTap(id), 700);
  }

  @SuppressWarnings("unchecked")
  private void onTilePortMessage(Tile tile, Object message) {
    if (tile == null || message == null) return;
    int id = -1;
    String action = "";
    boolean found = false;
    String frame = "";
    float cx = 0f;
    float cy = 0f;
    float dpr = 0f;
    float vw = 0f;
    float vh = 0f;
    try {
      if (message instanceof JSONObject) {
        JSONObject o = (JSONObject) message;
        action = o.optString("action");
        id = o.optInt("id", -1);
        found = o.optBoolean("found");
        frame = o.optString("frame");
        cx = (float) o.optDouble("cx");
        cy = (float) o.optDouble("cy");
        dpr = (float) o.optDouble("dpr");
        vw = (float) o.optDouble("vw");
        vh = (float) o.optDouble("vh");
      } else if (message instanceof Map) {
        Map<String, Object> map = (Map<String, Object>) message;
        Object actionObj = map.get("action");
        action = actionObj == null ? "" : String.valueOf(actionObj);
        Object idObj = map.get("id");
        id = idObj instanceof Number ? ((Number) idObj).intValue() : -1;
        Object foundObj = map.get("found");
        found = Boolean.TRUE.equals(foundObj) || "true".equals(String.valueOf(foundObj));
        Object frameObj = map.get("frame");
        frame = frameObj == null ? "" : String.valueOf(frameObj);
        cx = num(map.get("cx"));
        cy = num(map.get("cy"));
        dpr = num(map.get("dpr"));
        vw = num(map.get("vw"));
        vh = num(map.get("vh"));
      } else {
        return;
      }
    } catch (Throwable ignored) {
      return;
    }
    if (!"playButtonRect".equals(action)) return;
    RectWait wait = rectWaits.get(id);
    if (wait == null || wait.tile != tile || wait.tapped) return;
    wait.got++;
    boolean top = "top".equals(frame);
    if (found && cx > 0 && cy > 0 && (!wait.have || (top && !wait.fromTop))) {
      wait.have = true;
      wait.fromTop = top;
      wait.cx = cx;
      wait.cy = cy;
      wait.dpr = dpr;
      wait.vw = vw;
      wait.vh = vh;
    }
    if (wait.got >= wait.expect) finishPlayTap(id);
  }

  private void finishPlayTap(int id) {
    RectWait wait = rectWaits.remove(id);
    if (wait == null || wait.tapped || !wait.have) return;
    Tile tile = wait.tile;
    if (!active || tile == null || tile.view == null || tile.session == null || geckoRef == null) {
      return;
    }
    if (skipPlayTap(tile.url)) return;
    wait.tapped = true;
    float dpr = wait.dpr > 0 ? wait.dpr : (density > 0 ? density : 1f);
    int viewW = tile.view.getWidth();
    int viewH = tile.view.getHeight();
    if (wait.vw < 1f || wait.vh < 1f) return;
    // CSS coordinates normalized by the CSS viewport width/height is reliable regardless of zoom.
    float normX = wait.cx / wait.vw;
    float normY = wait.cy / wait.vh;
    if (wantsMute(tile) && tile.media != null) {
      try {
        tile.media.muteAudio(true);
      } catch (Throwable ignored) {}
    }
    geckoRef.tapAt(tile.view, tile.session, normX, normY);
  }

  private static float num(Object value) {
    return value instanceof Number ? ((Number) value).floatValue() : 0f;
  }

  private static boolean skipPlayTap(String url) {
    if (url == null) return false;
    String u = url.toLowerCase();
    return u.contains("challenges.cloudflare.com")
      || u.contains("cdn-cgi/challenge")
      || u.contains("__cf_chl")
      || u.contains("cf_chl_")
      || u.contains("cinetaro.to");
  }

  private AudioManager.AudioPlaybackCallback playbackCallback;

  /**
   * GV 140 has no MediaSession.notifySystemAudioFocusChange. When Android reports
   * a new playback client, mute every passive session immediately.
   */
  private void ensureFocusWatch(GeckoOverlayController gecko) {
    if (playbackCallback != null || gecko == null || gecko.getView() == null) return;
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    AudioManager am = audioManager(gecko);
    if (am == null) return;
    playbackCallback =
      new AudioManager.AudioPlaybackCallback() {
        @Override
        public void onPlaybackConfigChanged(java.util.List<AudioPlaybackConfiguration> configs) {
          main.post(
            () -> {
              if (!active || tiles.size() < 2) return;
              for (Tile watched : tiles.values()) {
                if (watched.media == null || !wantsMute(watched)) continue;
                try {
                  watched.media.muteAudio(true);
                } catch (Throwable ignored) {}
              }
            }
          );
        }
      };
    try {
      am.registerAudioPlaybackCallback(playbackCallback, main);
    } catch (Throwable t) {
      playbackCallback = null;
    }
  }

  private void stopFocusWatch(GeckoOverlayController gecko) {
    if (playbackCallback == null) return;
    AudioManager.AudioPlaybackCallback cb = playbackCallback;
    playbackCallback = null;
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    AudioManager am = audioManager(gecko);
    if (am == null) return;
    try {
      am.unregisterAudioPlaybackCallback(cb);
    } catch (Throwable ignored) {}
  }

  private static AudioManager audioManager(GeckoOverlayController gecko) {
    if (gecko == null || gecko.getView() == null) return null;
    Context ctx = gecko.getView().getContext();
    if (ctx == null) return null;
    return (AudioManager) ctx.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
  }

  private void loadTileIfNeeded(Tile tile) {
    if (tile == null || !tile.audioReady || tile.session == null) return;
    if (tile.url != null && !tile.url.equals(tile.loadedUrl)) {
      tile.loadedUrl = tile.url;
      loadTile(tile.session, tile.url);
    }
  }

  private MediaSession.Delegate mediaDelegate(Tile tile) {
    return new MediaSession.Delegate() {
      @Override
      public void onActivated(GeckoSession session, MediaSession mediaSession) {
        holdSession(tile, mediaSession);
      }

      @Override
      public void onPlay(GeckoSession session, MediaSession mediaSession) {
        holdSession(tile, mediaSession);
      }

      @Override
      public void onPause(GeckoSession session, MediaSession mediaSession) {
        tile.media = mediaSession;
        if (wantsMute(tile)) {
          try {
            mediaSession.muteAudio(true);
          } catch (Throwable ignored) {}
          return;
        }
        main.post(() -> {
          if (!active || wantsMute(tile) || tile.media == null) return;
          for (Tile other : tiles.values()) {
            if (other == tile || other.media == null || !wantsMute(other)) continue;
            try {
              other.media.muteAudio(true);
            } catch (Throwable ignored) {}
          }
          try {
            tile.media.play();
          } catch (Throwable ignored) {}
        });
      }
    };
  }

  /** Mute before this session can take audio focus. Never play() a silent tile. */
  private void holdSession(Tile tile, MediaSession mediaSession) {
    tile.media = mediaSession;
    try {
      mediaSession.muteAudio(wantsMute(tile));
    } catch (Throwable ignored) {}
  }

  private boolean heartbeatOn;

  /** Keep running until both players exist. A short timer ends before the second stream starts. */
  private void ensureHeartbeat() {
    if (heartbeatOn) return;
    heartbeatOn = true;
    main.post(this::beat);
  }

  private void beat() {
    if (!active || tiles.size() < 2) {
      heartbeatOn = false;
      return;
    }
    applyMute();
    main.postDelayed(this::beat, 700);
  }

  /** The stream that was opened first stays audible until another tile is chosen. */
  private void ensurePrimary() {
    for (Tile tile : tiles.values()) {
      if (tile.primary) return;
    }
    if (tiles.isEmpty()) return;
    tiles.values().iterator().next().primary = true;
  }

  private boolean wantsMute(Tile tile) {
    if (tile == null || tiles.size() < 2) return false;
    ensurePrimary();
    return !tile.primary;
  }

  private void pushTileAudio() {
    if (tiles.size() < 2) return;
    ensurePrimary();
    for (Tile tile : tiles.values()) {
      if (!wantsMute(tile)) continue;
      for (WebExtension.Port port : tile.ports) {
        GeckoOverlayController.postTileAudio(port, true);
      }
    }
    for (Tile tile : tiles.values()) {
      if (wantsMute(tile)) continue;
      for (WebExtension.Port port : tile.ports) {
        GeckoOverlayController.postTileAudio(port, false);
      }
    }
  }

  private void loadTile(GeckoSession session, String url) {
    if (session == null || url == null || url.isEmpty()) return;
    if (isStreamRefererOnlyUrl(url)) {
      android.util.Log.w("JiyuMulti", "blocked stream-referer tile " + url);
      return;
    }
    try {
      GeckoSession.Loader loader = new GeckoSession.Loader().uri(url);
      if (stripReferer(url)) {
        java.util.HashMap<String, String> headers = new java.util.HashMap<>();
        headers.put("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
        headers.put("Accept-Language", "en-US,en;q=0.9");
        loader.additionalHeaders(headers);
      }
      session.load(loader);
    } catch (Throwable t) {
      try {
        session.loadUri(url);
      } catch (Throwable ignored) {}
    }
  }

  private static boolean isStreamRefererOnlyUrl(String url) {
    try {
      String host = new java.net.URI(url).getHost();
      if (host == null) return false;
      host = host.replaceFirst("^www\\.", "").toLowerCase();
      if (host.equals("atlantic.st") || host.endsWith(".atlantic.st")) return true;
      if (host.equals("movy.sx") || host.endsWith(".movy.sx")) return true;
      return false;
    } catch (Throwable t) {
      return false;
    }
  }

  private static boolean stripReferer(String url) {
    try {
      String host = new java.net.URI(url).getHost();
      if (host == null) return false;
      host = host.replaceFirst("^www\\.", "").toLowerCase();
      return host.equals("embed.st")
        || host.endsWith(".embed.st")
        || host.equals("embedhd.st")
        || host.endsWith(".embedhd.st");
    } catch (Throwable t) {
      return false;
    }
  }

  private void placeTile(Tile tile) {
    if (tile.view == null || tile.w < 1 || tile.h < 1) return;
    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
      Math.max(1, Math.round(tile.w * density)),
      Math.max(1, Math.round(tile.h * density))
    );
    lp.gravity = android.view.Gravity.NO_GRAVITY;
    lp.leftMargin = Math.round(tile.x * density);
    lp.topMargin = Math.round(tile.y * density);
    tile.view.setLayoutParams(lp);
    tile.view.setVisibility(View.VISIBLE);
  }

  /** Mute every passive session first, then unmute the selected one. No play(). */
  private void applyMute() {
    if (!active) return;
    ensurePrimary();
    pushTileAudio();
    MediaSession selected = null;
    for (Tile tile : tiles.values()) {
      if (tile.media == null) continue;
      if (!wantsMute(tile)) {
        selected = tile.media;
        continue;
      }
      try {
        tile.media.muteAudio(true);
      } catch (Throwable ignored) {}
    }
    if (selected != null) {
      try {
        selected.muteAudio(false);
      } catch (Throwable ignored) {}
    }
  }

  private void releaseAllTiles() {
    for (Tile tile : tiles.values()) releaseTile(tile);
    tiles.clear();
  }

  private void releaseTile(Tile tile) {
    if (tile == null) return;
    tile.media = null;
    tile.ports.clear();
    tile.audioReady = false;
    if (tile.view != null) {
      tile.view.setVisibility(View.GONE);
      try {
        tile.view.releaseSession();
      } catch (Throwable ignored) {}
      ViewGroup parent = tile.view.getParent() instanceof ViewGroup
        ? (ViewGroup) tile.view.getParent()
        : null;
      if (parent != null) parent.removeView(tile.view);
      tile.view = null;
    }
    if (tile.session != null) {
      try {
        tile.session.setActive(false);
      } catch (Throwable ignored) {}
      try {
        tile.session.close();
      } catch (Throwable ignored) {}
      tile.session = null;
    }
  }

  private String loadedSignature = "";
  private GeckoOverlayController geckoRef;
  private final Runnable reloadShell = () -> {
    if (!active || geckoRef == null) return;
    loadShellDocument(geckoRef);
  };

  private void scheduleShell(GeckoOverlayController gecko) {
    geckoRef = gecko;
    main.removeCallbacks(reloadShell);
    main.postDelayed(reloadShell, 160);
  }

  /**
   * Replace the open player with a document that already contains one iframe per tile.
   * Editing the live page reports success and still leaves the first stream stretched
   * across both tiles, so the second URL is never added.
   */
  private void loadShellDocument(GeckoOverlayController gecko) {
    String signature = layoutSignature();
    if (signature.isEmpty()) {
      placeSurface(gecko);
      gecko.setVisibility(View.VISIBLE);
      return;
    }
    if (signature.equals(loadedSignature)) {
      placeSurface(gecko);
      gecko.setVisibility(View.VISIBLE);
      return;
    }
    String html = buildShellHtml();
    if (html == null) return;
    loadedSignature = signature;
    shellReady = true;
    shellLoadPending = false;
    shellAttempts = 0;
    gecko.setPageStopListener(null);
    gecko.resume();
    gecko.loadHtml(html);
    placeSurface(gecko);
    gecko.setVisibility(View.VISIBLE);
    scheduleAudioPasses();
    main.postDelayed(() -> {
      if (!active || geckoRef == null || !shellReady) return;
      for (String id : tiles.keySet()) nudge(geckoRef, id);
    }, 1400);
  }

  private int audioGen;

  /** Re-apply mute after late player iframes appear. Does not reload the page. */
  private void scheduleAudioPasses() {
    audioGen += 1;
    final int gen = audioGen;
    for (int delay : new int[] {0, 700, 1600, 3200, 6000}) {
      main.postDelayed(() -> {
        if (gen != audioGen || !active || geckoRef == null || !shellReady) return;
        applyAudio(geckoRef);
      }, delay);
    }
  }

  private String layoutSignature() {
    float spanW = 0;
    float spanH = 0;
    float minX = Float.MAX_VALUE;
    float minY = Float.MAX_VALUE;
    float maxR = -Float.MAX_VALUE;
    float maxB = -Float.MAX_VALUE;
    for (Tile tile : tiles.values()) {
      if (tile.w < 1 || tile.h < 1 || tile.url == null) continue;
      minX = Math.min(minX, tile.x);
      minY = Math.min(minY, tile.y);
      maxR = Math.max(maxR, tile.x + tile.w);
      maxB = Math.max(maxB, tile.y + tile.h);
    }
    spanW = maxR - minX;
    spanH = maxB - minY;
    if (spanW < 1 || spanH < 1) return "";
    StringBuilder sb = new StringBuilder();
    for (Map.Entry<String, Tile> e : tiles.entrySet()) {
      Tile tile = e.getValue();
      if (tile.w < 1 || tile.h < 1 || tile.url == null) continue;
      int left = Math.round((tile.x - minX) * 100f / spanW);
      int top = Math.round((tile.y - minY) * 100f / spanH);
      int width = Math.round(tile.w * 100f / spanW);
      int height = Math.round(tile.h * 100f / spanH);
      sb.append(e.getKey()).append('|').append(tile.url).append('|')
        .append(left).append(',').append(top).append(',').append(width).append(',').append(height)
        .append(';');
    }
    return sb.toString();
  }

  private String buildShellHtml() {
    float minX = Float.MAX_VALUE;
    float minY = Float.MAX_VALUE;
    float maxR = -Float.MAX_VALUE;
    float maxB = -Float.MAX_VALUE;
    int count = 0;
    for (Tile tile : tiles.values()) {
      if (tile.w < 1 || tile.h < 1 || tile.url == null) continue;
      count++;
      minX = Math.min(minX, tile.x);
      minY = Math.min(minY, tile.y);
      maxR = Math.max(maxR, tile.x + tile.w);
      maxB = Math.max(maxB, tile.y + tile.h);
    }
    float spanW = maxR - minX;
    float spanH = maxB - minY;
    if (count == 0 || spanW < 1 || spanH < 1) return null;
    StringBuilder body = new StringBuilder();
    for (Map.Entry<String, Tile> e : tiles.entrySet()) {
      Tile tile = e.getValue();
      if (tile.w < 1 || tile.h < 1 || tile.url == null) continue;
      float left = (tile.x - minX) * 100f / spanW;
      float top = (tile.y - minY) * 100f / spanH;
      float width = tile.w * 100f / spanW;
      float height = tile.h * 100f / spanH;
      body.append("<iframe class=\"jiyu-tile\" name=\"")
        .append(esc(e.getKey()))
        .append(tile.primary ? "|active\" data-tile=\"" : "|passive\" data-tile=\"")
        .append(esc(e.getKey()))
        .append(tile.primary ? "\" data-active=\"1" : "")
        .append("\" referrerpolicy=\"no-referrer\" allow=\"autoplay; fullscreen; encrypted-media; picture-in-picture\" allowfullscreen src=\"")
        .append(esc(tile.url))
        .append("\" style=\"position:absolute;border:0;background:black;left:")
        .append(left)
        .append("%;top:")
        .append(top)
        .append("%;width:")
        .append(width)
        .append("%;height:")
        .append(height)
        .append("%\"></iframe>");
    }
    return "<!DOCTYPE html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
      + "<style>html,body{margin:0;padding:0;background:black;overflow:hidden;width:100%;height:100%}"
      + "iframe{position:absolute;border:0;background:black}</style></head><body>"
      + body
      + "<script>(function(){"
      + "function known(id){var nodes=document.querySelectorAll('iframe.jiyu-tile');"
      + "for(var i=0;i<nodes.length;i++){if(nodes[i].getAttribute('data-tile')===id)return true;}return false;}"
      + "function read(){var nodes=document.querySelectorAll('iframe.jiyu-tile');"
      + "for(var i=0;i<nodes.length;i++){if(nodes[i].getAttribute('data-active')==='1')return nodes[i].getAttribute('data-tile');}"
      + "return nodes[0]?nodes[0].getAttribute('data-tile'):'';}"
      + "window.__jiyuActive=read();"
      + "function fan(){var nodes=document.querySelectorAll('iframe.jiyu-tile');"
      + "for(var i=0;i<nodes.length;i++){var id=nodes[i].getAttribute('data-tile');"
      + "var muted=id!==window.__jiyuActive;var name=id+(muted?'|passive':'|active');"
      + "try{nodes[i].name=name;}catch(e){}nodes[i].setAttribute('name',name);"
      + "try{nodes[i].contentWindow.postMessage({__jiyuAudio:1,muted:muted},'*');}catch(e){}}}"
      + "window.addEventListener('message',function(ev){var d=ev.data;"
      + "if(!d||typeof d.__jiyuSetActive!=='string'||!known(d.__jiyuSetActive))return;"
      + "window.__jiyuActive=d.__jiyuSetActive;"
      + "var nodes=document.querySelectorAll('iframe.jiyu-tile');"
      + "for(var i=0;i<nodes.length;i++){if(nodes[i].getAttribute('data-tile')===window.__jiyuActive)nodes[i].setAttribute('data-active','1');"
      + "else nodes[i].removeAttribute('data-active');}"
      + "fan();});"
      + "setInterval(fan,300);fan();"
      + "})();</script></body></html>";
  }

  private static String esc(String value) {
    if (value == null) return "";
    return value
      .replace("&", "&amp;")
      .replace("\"", "&quot;")
      .replace("<", "&lt;")
      .replace(">", "&gt;");
  }

  private void ensureShell(GeckoOverlayController gecko) {
    if (shellReady || shellLoadPending) return;
    shellLoadPending = true;
    String current = gecko.getCurrentUrl();
    // about:blank never gets the bridge, so it stays a white empty page.
    // Inject into the stream that is already open (https, bridge attached).
    if (current != null && (current.startsWith("https://") || current.startsWith("http://"))) {
      injectShell(gecko);
      return;
    }
    gecko.setPageStopListener(() -> {
      if (!active) return;
      injectShell(gecko);
    });
    gecko.loadUrl("https://embed.st/");
  }

  private void injectShell(GeckoOverlayController gecko) {
    shellAttempts += 1;
    gecko.evaluateJavascript(INSTALL_SHELL_JS, result -> {
      if (!active) return;
      String r = result == null ? "" : result;
      if (!r.contains("installed") && !r.contains("ready")) {
        if (shellAttempts < 8) {
          main.postDelayed(() -> {
            if (active && !shellReady) injectShell(gecko);
          }, 250);
          return;
        }
        // Script never confirmed. Load the two-iframe document directly.
        String html = buildShellHtml();
        if (html != null) {
          shellReady = true;
          gecko.loadHtml(html);
        }
        return;
      }
      shellLoadPending = false;
      shellReady = true;
      gecko.setPageStopListener(null);
      placeSurface(gecko);
      placeFrames(gecko);
      main.postDelayed(() -> {
        if (active && shellReady) placeFrames(gecko);
      }, 400);
    });
  }

  private void placeSurface(GeckoOverlayController gecko) {
    if (gecko == null || gecko.getView() == null || tiles.isEmpty()) return;
    float minX = Float.MAX_VALUE;
    float minY = Float.MAX_VALUE;
    float maxR = -Float.MAX_VALUE;
    float maxB = -Float.MAX_VALUE;
    for (Tile tile : tiles.values()) {
      if (tile.w < 1 || tile.h < 1) continue;
      minX = Math.min(minX, tile.x);
      minY = Math.min(minY, tile.y);
      maxR = Math.max(maxR, tile.x + tile.w);
      maxB = Math.max(maxB, tile.y + tile.h);
    }
    if (maxR <= minX || maxB <= minY) return;
    FrameLayout.LayoutParams lp = gecko.getLayoutParams();
    if (lp == null) lp = new FrameLayout.LayoutParams(0, 0);
    lp.leftMargin = Math.round(minX * density);
    lp.topMargin = Math.round(minY * density);
    lp.width = Math.max(1, Math.round((maxR - minX) * density));
    lp.height = Math.max(1, Math.round((maxB - minY) * density));
    lp.gravity = android.view.Gravity.NO_GRAVITY;
    gecko.setLayoutParams(lp);
    gecko.setVisibility(View.VISIBLE);
    originX = minX;
    originY = minY;
  }

  private void placeFrames(GeckoOverlayController gecko) {
    if (!shellReady) return;
    for (Map.Entry<String, Tile> e : tiles.entrySet()) {
      Tile tile = e.getValue();
      gecko.evaluateJavascript(
        upsertScript(
          e.getKey(),
          tile.url,
          tile.x - originX,
          tile.y - originY,
          tile.w,
          tile.h
        ),
        null
      );
    }
    main.postDelayed(() -> {
      if (!active || !shellReady) return;
      applyAudio(gecko);
      for (String id : tiles.keySet()) nudge(gecko, id);
    }, 700);
  }

  private float originX;
  private float originY;

  private void layout(GeckoOverlayController gecko) {
    placeSurface(gecko);
    placeFrames(gecko);
  }

  private void applyAudio(GeckoOverlayController gecko) {
    String audible = null;
    for (Map.Entry<String, Tile> e : tiles.entrySet()) {
      if (e.getValue().primary) {
        audible = e.getKey();
        break;
      }
    }
    if (audible == null && !tiles.isEmpty()) audible = tiles.keySet().iterator().next();
    if (audible == null) return;
    gecko.evaluateJavascript(audioScript(audible), null);
  }

  private static String upsertScript(String id, String url, float x, float y, float w, float h) {
    return "(function(){try{"
      + TOP_FRAME_JS
      + "if(!topFrame)return 'skip';"
      + "try{if(!document.body&&document.documentElement){"
      + "document.documentElement.appendChild(document.createElement('body'));}}catch(e){}"
      + "if(!document.body)return 'nobody';"
      + "var id=" + jsString(id) + ",url=" + jsString(url) + ";"
      + "var f=null,all=document.querySelectorAll('iframe.jiyu-tile');"
      + "for(var i=0;i<all.length;i++){if(all[i].getAttribute('data-tile')===id)f=all[i];}"
      + "if(!f){f=document.createElement('iframe');f.className='jiyu-tile';"
      + "f.setAttribute('data-tile',id);f.name=id;"
      + "f.setAttribute('referrerpolicy','no-referrer');"
      + "f.setAttribute('allow','autoplay; fullscreen; encrypted-media; picture-in-picture');"
      + "f.setAttribute('allowfullscreen','');"
      + "f.style.position='absolute';f.style.border='0';f.style.background='#000';"
      + "document.body.appendChild(f);}"
      + "f.removeAttribute('sandbox');"
      + "if(f.getAttribute('data-url')!==url){f.setAttribute('data-url',url);f.src=url;}"
      + "f.style.left=" + x + "+'px';f.style.top=" + y + "+'px';"
      + "f.style.width=" + w + "+'px';f.style.height=" + h + "+'px';"
      + "return 'placed';}catch(e){return 'error';}})()";
  }

  private static String removeScript(String id) {
    return "(function(){try{"
      + TOP_FRAME_JS
      + "if(!topFrame)return 'skip';"
      + "var id=" + jsString(id) + ";"
      + "var all=document.querySelectorAll('iframe.jiyu-tile');"
      + "for(var i=0;i<all.length;i++){if(all[i].getAttribute('data-tile')===id)all[i].remove();}"
      + "return 'removed';}catch(e){return 'error';}})()";
  }

  private static final String TILE_NAME_JS =
    "function jiyuTile(){var w=window;for(var i=0;i<8;i++){"
      + "var n='';try{n=(w.wrappedJSObject&&w.wrappedJSObject.name)||w.name||'';}catch(e){try{n=w.name||'';}catch(e2){}}"
      + "n=String(n||'');if(n){var bar=n.indexOf('|');return bar<0?n:n.slice(0,bar);}"
      + "if(!w.parent||w.parent===w)break;try{w=w.parent;}catch(e){break;}}return '';}";

  private static final String PAGE_GUARD_JS =
    "(function(){if(window.__jiyuGuard2){if(window.__jiyuRefreshRole)window.__jiyuRefreshRole();return;}"
      + "window.__jiyuGuard2=1;var origPlay=HTMLMediaElement.prototype.play;"
      + "var md=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'muted');"
      + "var vd=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'volume');"
      + "function passive(){var n=String(window.name||'');"
      + "if(n.indexOf('|active')!==-1)return false;if(n.indexOf('|passive')!==-1)return true;"
      + "if(window.__jiyuRole==='active')return false;if(window.__jiyuRole==='passive')return true;"
      + "try{return window.parent!==window;}catch(e){return true;}}"
      + "function each(fn){function walk(root){if(!root||!root.querySelectorAll)return;"
      + "var nodes=[];try{nodes=root.querySelectorAll('video,audio');}catch(e){}"
      + "for(var i=0;i<nodes.length;i++)fn(nodes[i]);"
      + "var all=[];try{all=root.querySelectorAll('*');}catch(e){}"
      + "for(var j=0;j<all.length;j++){if(all[j].shadowRoot)walk(all[j].shadowRoot);}}"
      + "try{walk(document);}catch(e){}}"
      + "function apply(){var prev=!!window.__jiyuHold2;var hold=passive();window.__jiyuHold2=hold;"
      + "if(hold||prev){each(function(m){try{m.muted=!!hold;if(hold)m.volume=0;}catch(e){}});}"
      + "try{for(var i=0;i<window.frames.length;i++){window.frames[i].postMessage({__jiyuAudio:1,muted:hold},'*');}}catch(e){}}"
      + "window.__jiyuRefreshRole=apply;"
      + "try{if(md&&md.get&&md.set){Object.defineProperty(HTMLMediaElement.prototype,'muted',{configurable:true,"
      + "get:function(){return window.__jiyuHold2?true:md.get.call(this);},"
      + "set:function(v){md.set.call(this,window.__jiyuHold2?true:!!v);}});}"
      + "if(vd&&vd.get&&vd.set){Object.defineProperty(HTMLMediaElement.prototype,'volume',{configurable:true,"
      + "get:function(){return window.__jiyuHold2?0:vd.get.call(this);},"
      + "set:function(v){vd.set.call(this,window.__jiyuHold2?0:+v);}});}"
      + "HTMLMediaElement.prototype.play=function(){if(window.__jiyuHold2){try{if(md&&md.set)md.set.call(this,true);}catch(e){}"
      + "try{if(vd&&vd.set)vd.set.call(this,0);}catch(e){}}return origPlay.apply(this,arguments);};}catch(e){}"
      + "window.addEventListener('message',function(ev){var d=ev.data;if(!d||d.__jiyuAudio!==1||typeof d.muted!=='boolean')return;"
      + "window.__jiyuRole=d.muted?'passive':'active';apply();});"
      + "setInterval(apply,200);apply();})();";

  private static String audioScript(String activeId) {
    return "(function(){try{"
      + "var msg={__jiyuSetActive:" + jsString(activeId) + "};"
      + "try{window.top.postMessage(msg,'*');}catch(e){}"
      + "try{if(window.parent&&window.parent!==window)window.parent.postMessage(msg,'*');}catch(e){}"
      + "if(!document.getElementById('jiyu-audio-guard-2')){var s=document.createElement('script');"
      + "s.id='jiyu-audio-guard-2';s.textContent=" + jsString(PAGE_GUARD_JS) + ";"
      + "try{(document.documentElement||document.head||document.body).appendChild(s);}catch(e){}}"
      + "else{try{if(window.wrappedJSObject&&window.wrappedJSObject.__jiyuRefreshRole)window.wrappedJSObject.__jiyuRefreshRole();}catch(e){}}"
      + "function nm(){try{return String((window.wrappedJSObject&&window.wrappedJSObject.name)||window.name||'');}catch(e){return '';}}"
      + "function role(){var n=nm();if(n.indexOf('|active')!==-1)return 'active';"
      + "if(n.indexOf('|passive')!==-1)return 'passive';"
      + "if(window.__jiyuRole==='active'||window.__jiyuRole==='passive')return window.__jiyuRole;"
      + "var framed=false;try{framed=window.parent!==window;}catch(e){framed=true;}return framed?'passive':'active';}"
      + "function muteNow(){var n=nm();if(n.indexOf('|passive')===-1&&window.__jiyuRole!=='passive')return;"
      + "function walk(root){if(!root||!root.querySelectorAll)return;"
      + "var nodes=[];try{nodes=root.querySelectorAll('video,audio');}catch(e){}"
      + "for(var i=0;i<nodes.length;i++){try{nodes[i].muted=true;nodes[i].volume=0;}catch(e){}}"
      + "var all=[];try{all=root.querySelectorAll('*');}catch(e){}"
      + "for(var j=0;j<all.length;j++){if(all[j].shadowRoot)walk(all[j].shadowRoot);}}"
      + "try{walk(document);}catch(e){}"
      + "try{for(var k=0;k<window.frames.length;k++){window.frames[k].postMessage({__jiyuAudio:1,muted:true},'*');}}catch(e){}}"
      + "if(!window.__jiyuCsBound){window.__jiyuCsBound=1;window.addEventListener('message',function(ev){"
      + "var d=ev.data;if(!d||d.__jiyuAudio!==1||typeof d.muted!=='boolean')return;"
      + "window.__jiyuRole=d.muted?'passive':'active';if(d.muted)muteNow();});"
      + "window.__jiyuCsTimer=setInterval(muteNow,200);}"
      + "muteNow();return nm()||role();}catch(e){return 'error';}})()";
  }

  private static String nudgeScript(String id, boolean forceMute) {
    return "(function(){try{"
      + TILE_NAME_JS
      + "if(jiyuTile()!==" + jsString(id) + ")return 'skip';"
      + "var fm=" + forceMute + ";"
      + "if(fm)return 'passive';"
      + "var vids=[].slice.call(document.querySelectorAll('video'));"
      + "for(var i=0;i<vids.length;i++){try{vids[i].playsInline=true;}catch(e){}}"
      + "for(var j=0;j<vids.length;j++){if(!vids[j].paused&&!vids[j].ended)return 'already';}"
      + "for(var k=0;k<vids.length;k++){try{if(vids[k].paused){var p=vids[k].play();"
      + "if(p&&p.catch)p.catch(function(){});}}catch(e){}}"
      + "if(vids.length)return 'play';"
      + "var s=['.ytp-large-play-button','.vjs-big-play-button','.jw-icon-display',"
      + "'.plyr__control--overlaid','button[aria-label*=\"Play\" i]','button[class*=\"play\" i]'];"
      + "for(var n=0;n<s.length;n++){var el=document.querySelector(s[n]);"
      + "if(el){try{el.click();return 'ui';}catch(e){}}}"
      + "return 'noop';}catch(e){return 'error';}})()";
  }

  private static String jsString(String value) {
    try {
      return JSONObject.quote(value == null ? "" : value);
    } catch (Throwable t) {
      return "\"\"";
    }
  }

  private static final String TOP_FRAME_JS =
    "var topFrame=false;"
      + "try{if(window.frameElement==null)topFrame=true;}catch(e){}"
      + "try{if(window.parent===window)topFrame=true;}catch(e){}"
      + "try{if(window.top===window)topFrame=true;}catch(e){}";

  private static final String INSTALL_SHELL_JS =
    "(function(){try{"
      + TOP_FRAME_JS
      + "if(!topFrame)return 'child';"
      + "try{var style=document.getElementById('jiyu-multi-style');"
      + "if(!style){style=document.createElement('style');style.id='jiyu-multi-style';"
      + "style.textContent='html,body{margin:0;padding:0;background:#000!important;overflow:hidden;width:100%;height:100%}"
      + "iframe.jiyu-tile{position:absolute;border:0;background:#000}';"
      + "(document.head||document.documentElement).appendChild(style);}}catch(e){}"
      + "try{if(!document.body&&document.documentElement){"
      + "document.documentElement.appendChild(document.createElement('body'));}}catch(e){}"
      + "try{if(document.body){document.body.innerHTML='';"
      + "document.body.style.cssText='margin:0;background:#000;overflow:hidden';}}catch(e){}"
      + "try{document.documentElement.style.background='#000';}catch(e){}"
      + "try{var meta=document.querySelector('meta[name=viewport]');"
      + "if(!meta){meta=document.createElement('meta');meta.name='viewport';"
      + "(document.head||document.documentElement).appendChild(meta);}"
      + "meta.setAttribute('content','width=device-width,initial-scale=1,maximum-scale=1');}catch(e){}"
      + "try{if(!window.__jiyuKeepShell&&document.body){window.__jiyuKeepShell=1;"
      + "new MutationObserver(function(){try{var b=document.body;if(!b)return;"
      + "for(var i=b.children.length-1;i>=0;i--){var n=b.children[i];"
      + "if(!n||n.tagName!=='IFRAME'||!n.getAttribute('data-tile'))n.remove();}"
      + "}catch(e){}}).observe(document.body,{childList:true});}}catch(e){}"
      + "try{window.__jiyuMultiShell=1;}catch(e){}"
      + "return 'installed';"
      + "}catch(e){return 'installed';}})()";
}
