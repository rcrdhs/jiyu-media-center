package app.jiyu.mediacenter.browser;

import android.content.Context;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.annotation.Nullable;

import org.json.JSONObject;
import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoSessionSettings;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.WebExtension;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * GeckoView-backed in-app browser surface (Electron WebContentsView stand-in).
 * Capacitor's main UI stays on Android System WebView — only this overlay uses Gecko.
 */
final class GeckoOverlayController {
  interface NavListener {
    void onNav(String url, String title, boolean canGoBack, boolean canGoForward, boolean loading);
  }

  interface EvalCallback {
    void onResult(@Nullable String jsonOrNull);
  }

  private static final String DESKTOP_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
  private static final String BRIDGE_ID = "jiyu-bridge@jiyu.app";
  private static final String BRIDGE_RESOURCE = "resource://android/assets/jiyu-gecko-bridge/";

  private static GeckoRuntime sRuntime;
  private static WebExtension sBridgeExtension;

  private final Context appContext;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final AtomicLong evalSeq = new AtomicLong(1);
  private final Map<Long, EvalCallback> pendingEval = new HashMap<>();

  private GeckoView view;
  private GeckoSession session;
  private FrameLayout.LayoutParams layoutParams;
  private NavListener navListener;
  private final java.util.concurrent.CopyOnWriteArrayList<WebExtension.Port> bridgePorts =
    new java.util.concurrent.CopyOnWriteArrayList<>();
  private final Map<Long, Integer> pendingEvalExpect = new HashMap<>();
  private final Map<Long, String> pendingEvalBest = new HashMap<>();
  private final java.util.ArrayList<PendingEval> bridgeQueue = new java.util.ArrayList<>();
  private String currentUrl = "";
  /** URL we already sent the start taps for. Buffering must not tap again. */
  private String playTapUrl = "";
  private String currentTitle = "";
  private boolean canGoBack;
  private boolean canGoForward;
  private boolean loading;
  @Nullable private Runnable pageStopListener;

  private static final class PendingEval {
    final long id;
    final String code;
    @Nullable final EvalCallback callback;

    PendingEval(long id, String code, @Nullable EvalCallback callback) {
      this.id = id;
      this.code = code;
      this.callback = callback;
    }
  }

  GeckoOverlayController(Context context) {
    this.appContext = context.getApplicationContext();
  }

  void setNavListener(NavListener listener) {
    this.navListener = listener;
  }

  void setPageStopListener(@Nullable Runnable listener) {
    this.pageStopListener = listener;
  }

  GeckoView getView() {
    return view;
  }

  FrameLayout.LayoutParams getLayoutParams() {
    return layoutParams;
  }

  String getCurrentUrl() {
    return currentUrl;
  }

  String getCurrentTitle() {
    return currentTitle;
  }

  boolean canGoBack() {
    return canGoBack;
  }

  boolean canGoForward() {
    return canGoForward;
  }

  boolean isLoading() {
    return loading;
  }

  int getVisibility() {
    return view == null ? View.GONE : view.getVisibility();
  }

  void setVisibility(int visibility) {
    if (view != null) view.setVisibility(visibility);
  }

  int getWidth() {
    return view == null ? 0 : view.getWidth();
  }

  int getHeight() {
    return view == null ? 0 : view.getHeight();
  }

  boolean dispatchTouchEvent(MotionEvent event) {
    if (view == null || session == null || event == null) return false;
    boolean handled = false;
    try {
      session.getPanZoomController().onTouchEvent(event);
      handled = true;
    } catch (Throwable ignored) {}
    try {
      // Also hit the view — some players only see View touch delivery.
      if (view.dispatchTouchEvent(MotionEvent.obtain(event))) handled = true;
    } catch (Throwable ignored) {}
    return handled;
  }

  /** Normalized 0–1 point inside this GeckoView. One DOWN/UP pair, trusted by the page. */
  void tapAt(float normX, float normY) {
    tapAt(view, session, normX, normY, 1);
  }

  /**
   * Same tap, aimed at a multiview tile. The tile has its own session, so the
   * overlay view would miss the play button.
   */
  void tapAt(GeckoView target, GeckoSession targetSession, float normX, float normY) {
    tapAt(target, targetSession, normX, normY, 1);
  }

  /**
   * These embeds ignore a single tap. The second tap is the same point, 0.8s later.
   */
  /** A newly chosen title may be tapped again. Player redirects must not re-arm taps. */
  void noteUserNavigation() {
    playTapsSent = false;
    playTapUrl = "";
  }

  void tapTwice(float normX, float normY) {
    playTapsSent = true;
    playTapUrl = currentUrl == null ? "" : currentUrl;
    dispatchTap(view, session, normX, normY);
    main.postDelayed(() -> {
      if (view == null || view.getVisibility() != View.VISIBLE) return;
      dispatchTap(view, session, normX, normY);
    }, 800);
  }

  private void tapAt(
    GeckoView target,
    GeckoSession targetSession,
    float normX,
    float normY,
    int times
  ) {
    dispatchTap(target, targetSession, normX, normY);
    if (times < 2 || target == null) return;
    main.postDelayed(() -> dispatchTap(target, targetSession, normX, normY), 800);
  }

  private void dispatchTap(GeckoView target, GeckoSession targetSession, float normX, float normY) {
    if (target == null || targetSession == null) return;
    int w = target.getWidth();
    int h = target.getHeight();
    if (w < 8 || h < 8) return;
    float nx = Math.max(0f, Math.min(1f, normX));
    float ny = Math.max(0f, Math.min(1f, normY));
    float x = Math.max(1f, Math.min(w - 1f, w * nx));
    float y = Math.max(1f, Math.min(h - 1f, h * ny));
    // PanZoom uses getRawX()-getX() as the view's screen origin. A plain
    // obtain() leaves that at 0, so the hit slides to the top-left of the page.
    int[] origin = new int[2];
    target.getLocationOnScreen(origin);
    long now = android.os.SystemClock.uptimeMillis();
    MotionEvent down = obtainViewTap(x, y, origin[0], origin[1], now, now);
    MotionEvent up = obtainViewTap(x, y, origin[0], origin[1], now, now + 18);
    try {
      // GeckoView.onTouchEvent already forwards this to PanZoom. A second direct
      // PanZoom call is another click, and that extra click pauses a stream the
      // first click just started.
      MotionEvent viewDown = MotionEvent.obtain(down);
      target.dispatchTouchEvent(viewDown);
      viewDown.recycle();
      MotionEvent viewUp = MotionEvent.obtain(up);
      target.dispatchTouchEvent(viewUp);
      viewUp.recycle();
    } catch (Throwable ignored) {
    } finally {
      down.recycle();
      up.recycle();
    }
  }

  private static MotionEvent obtainViewTap(
    float viewX,
    float viewY,
    int screenX,
    int screenY,
    long downTime,
    long eventTime
  ) {
    MotionEvent event =
      MotionEvent.obtain(
        downTime,
        eventTime,
        eventTime == downTime ? MotionEvent.ACTION_DOWN : MotionEvent.ACTION_UP,
        viewX + screenX,
        viewY + screenY,
        0
      );
    event.offsetLocation(-screenX, -screenY);
    event.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
    return event;
  }

  void setLayoutParams(FrameLayout.LayoutParams lp) {
    layoutParams = lp;
    if (view != null) view.setLayoutParams(lp);
  }

  void ensureAttached(FrameLayout parent) {
    if (view != null) return;

    ensureRuntime(appContext);
    openFreshSession();

    view = new GeckoView(parent.getContext());
    view.setSession(session);
    view.setBackgroundColor(Color.BLACK);
    layoutParams =
      new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      );
    view.setLayoutParams(layoutParams);
    view.setVisibility(View.GONE);
    parent.addView(view);

    installBridge(session);
  }

  /** Build delegates + open a new GeckoSession (view may already exist). */
  private void openFreshSession() {
    ensureRuntime(appContext);

    GeckoSessionSettings sessionSettings =
      new GeckoSessionSettings.Builder()
        .userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_DESKTOP)
        .userAgentOverride(DESKTOP_UA)
        .allowJavascript(true)
        .suspendMediaWhenInactive(false)
        .build();

    session = new GeckoSession(sessionSettings);
    // Without this, Clappr/JW stay in "Idle" — Gecko blocks audible autoplay by default.
    session.setPermissionDelegate(
      new GeckoSession.PermissionDelegate() {
        @Override
        public GeckoResult<Integer> onContentPermissionRequest(
          GeckoSession s,
          ContentPermission perm
        ) {
          if (perm == null) {
            return GeckoResult.fromValue(ContentPermission.VALUE_DENY);
          }
          int p = perm.permission;
          if (p == PERMISSION_AUTOPLAY_AUDIBLE
            || p == PERMISSION_AUTOPLAY_INAUDIBLE
            || p == PERMISSION_MEDIA_KEY_SYSTEM_ACCESS) {
            return GeckoResult.fromValue(ContentPermission.VALUE_ALLOW);
          }
          // Don't prompt for geo/notifications inside the overlay.
          return GeckoResult.fromValue(ContentPermission.VALUE_DENY);
        }
      }
    );
    // Workaround for Bug 1758212
    session.setContentDelegate(
      new GeckoSession.ContentDelegate() {
        @Override
        public void onTitleChange(GeckoSession s, String title) {
          currentTitle = title != null ? title : "";
          emitNav();
        }
      }
    );
    session.setProgressDelegate(
      new GeckoSession.ProgressDelegate() {
        @Override
        public void onPageStart(GeckoSession s, String url) {
          loading = true;
          if (url != null && !url.isEmpty()) currentUrl = url;
          emitNav();
        }

        @Override
        public void onPageStop(GeckoSession s, boolean success) {
          loading = false;
          emitNav();
          if (pageStopListener != null) {
            Runnable listener = pageStopListener;
            main.post(listener);
          }
          if (playTapAfterLoad) {
            playTapAfterLoad = false;
            Runnable pending = playTapAfterLoadDone;
            playTapAfterLoadDone = null;
            main.post(() -> tapPlayButton(pending));
          }
        }
      }
    );
    session.setNavigationDelegate(
      new GeckoSession.NavigationDelegate() {
        @Override
        public GeckoResult<AllowOrDeny> onLoadRequest(
          GeckoSession s,
          GeckoSession.NavigationDelegate.LoadRequest request
        ) {
          if (request != null && isStreamRefererOnlyUrl(request.uri)) {
            android.util.Log.w("JiyuGecko", "denied stream-referer nav " + request.uri);
            return GeckoResult.fromValue(AllowOrDeny.DENY);
          }
          return GeckoResult.fromValue(AllowOrDeny.ALLOW);
        }

        @Override
        public void onLocationChange(
          GeckoSession s,
          String url,
          java.util.List<GeckoSession.PermissionDelegate.ContentPermission> perms,
          Boolean hasUserGesture
        ) {
          if (url != null && !url.isEmpty()) {
            currentUrl = url;
            emitNav();
          }
        }

        @Override
        public void onCanGoBack(GeckoSession s, boolean value) {
          canGoBack = value;
          main.post(GeckoOverlayController.this::emitNav);
        }

        @Override
        public void onCanGoForward(GeckoSession s, boolean value) {
          canGoForward = value;
          main.post(GeckoOverlayController.this::emitNav);
        }
      }
    );
    session.setHistoryDelegate(
      new GeckoSession.HistoryDelegate() {
        @Override
        public void onHistoryStateChange(
          GeckoSession s,
          GeckoSession.HistoryDelegate.HistoryList history
        ) {
          if (history == null) return;
          int index = history.getCurrentIndex();
          int count = history.size();
          canGoBack = index > 0;
          canGoForward = count > 0 && index < count - 1;
          main.post(GeckoOverlayController.this::emitNav);
        }
      }
    );

    session.open(sRuntime);
  }

  /**
   * A second session on the same runtime, for one multiview tile.
   * Does not replace the single-stream session attached to the overlay view.
   */
  GeckoSession openTileSession(
    org.mozilla.geckoview.MediaSession.Delegate mediaDelegate,
    java.util.function.BooleanSupplier blockAudible
  ) {
    ensureRuntime(appContext);
    boolean silentAtOpen = false;
    try {
      silentAtOpen = blockAudible != null && blockAudible.getAsBoolean();
    } catch (Throwable ignored) {}
    // A fresh context id on every tile disables the HTTP cache, so the player
    // JS is downloaded from scratch and the play button shows up very late.
    // The audible tile stays in the default context (same cache as the stream
    // just watched). The silent tile uses one stable context so a stored
    // autoplay deny cannot stick to the audible origin.
    GeckoSessionSettings.Builder settings =
      new GeckoSessionSettings.Builder()
        .userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_DESKTOP)
        .userAgentOverride(DESKTOP_UA)
        .allowJavascript(true)
        .suspendMediaWhenInactive(false);
    if (silentAtOpen) settings.contextId("jiyu-silent");
    GeckoSessionSettings sessionSettings = settings.build();
    GeckoSession tile = new GeckoSession(sessionSettings);
    tile.setPermissionDelegate(
      new GeckoSession.PermissionDelegate() {
        @Override
        public GeckoResult<Integer> onContentPermissionRequest(
          GeckoSession s,
          ContentPermission perm
        ) {
          if (perm == null) return GeckoResult.fromValue(ContentPermission.VALUE_DENY);
          int p = perm.permission;
          if (p == PERMISSION_AUTOPLAY_INAUDIBLE || p == PERMISSION_MEDIA_KEY_SYSTEM_ACCESS) {
            return GeckoResult.fromValue(ContentPermission.VALUE_ALLOW);
          }
          if (p == PERMISSION_AUTOPLAY_AUDIBLE) {
            boolean block = false;
            try {
              block = blockAudible != null && blockAudible.getAsBoolean();
            } catch (Throwable ignored) {}
            // A silent tile may paint, but it must not open an audible stream.
            return GeckoResult.fromValue(
              block ? ContentPermission.VALUE_DENY : ContentPermission.VALUE_ALLOW
            );
          }
          return GeckoResult.fromValue(ContentPermission.VALUE_DENY);
        }
      }
    );
    if (mediaDelegate != null) tile.setMediaSessionDelegate(mediaDelegate);
    tile.open(sRuntime);
    try {
      tile.setActive(true);
    } catch (Throwable ignored) {}
    return tile;
  }

  private static synchronized void ensureRuntime(Context appContext) {
    if (sRuntime != null) return;
    // GV 140 has no Builder.*Pref — ship autoplay prefs via config file so
    // PermissionDelegate actually receives AUTOPLAY_* requests (else Clappr stays Idle).
    String configPath = null;
    try {
      java.io.File cfg = new java.io.File(appContext.getFilesDir(), "jiyu-geckoview-config.yaml");
      String body =
        "prefs:\n"
          + "  media.geckoview.autoplay.request: true\n"
          + "  media.autoplay.default: 0\n";
      java.nio.file.Files.write(
        cfg.toPath(),
        body.getBytes(java.nio.charset.StandardCharsets.UTF_8)
      );
      configPath = cfg.getAbsolutePath();
    } catch (Throwable ignored) {}
    GeckoRuntimeSettings.Builder builder =
      new GeckoRuntimeSettings.Builder()
        .javaScriptEnabled(true)
        .consoleOutput(false);
    if (configPath != null) {
      builder.configFilePath(configPath);
    }
    sRuntime = GeckoRuntime.create(appContext, builder.build());
  }

  private void installBridge(GeckoSession target) {
    if (sRuntime == null) return;
    GeckoResult<WebExtension> result =
      sBridgeExtension != null
        ? GeckoResult.fromValue(sBridgeExtension)
        : sRuntime.getWebExtensionController().ensureBuiltIn(BRIDGE_RESOURCE, BRIDGE_ID);

    result.accept(
      extension -> {
        if (extension == null) return;
        sBridgeExtension = extension;
        try {
          target
            .getWebExtensionController()
            .setMessageDelegate(
              extension,
              new WebExtension.MessageDelegate() {
                @Override
                public void onConnect(WebExtension.Port port) {
                  bridgePorts.add(port);
                  port.setDelegate(
                    new WebExtension.PortDelegate() {
                      @Override
                      public void onPortMessage(Object message, WebExtension.Port port) {
                        if (isPlayButtonRect(message)) {
                          main.post(() -> onPlayButtonRect(message));
                          return;
                        }
                        handleBridgeMessage(message);
                      }

                      @Override
                      public void onDisconnect(WebExtension.Port port) {
                        bridgePorts.remove(port);
                      }
                    }
                  );
                  flushBridgeQueue();
                }
              },
              "jiyu"
            );
        } catch (Throwable ignored) {}
      },
      e -> {}
    );
  }

  /**
   * Tell every frame of this tile whether it is the silent one.
   * The delegate is attached before the embed loads, so document_start can mute
   * the player before it requests audio focus.
   */
  void bindTileAudio(
    GeckoSession target,
    java.util.List<WebExtension.Port> ports,
    java.util.function.BooleanSupplier muted,
    Runnable ready,
    java.util.function.Consumer<Object> onMessage
  ) {
    if (sRuntime == null || target == null) {
      if (ready != null) ready.run();
      return;
    }
    GeckoResult<WebExtension> result =
      sBridgeExtension != null
        ? GeckoResult.fromValue(sBridgeExtension)
        : sRuntime.getWebExtensionController().ensureBuiltIn(BRIDGE_RESOURCE, BRIDGE_ID);
    result.accept(
      extension -> {
        if (extension == null) {
          if (ready != null) ready.run();
          return;
        }
        sBridgeExtension = extension;
        try {
          target
            .getWebExtensionController()
            .setMessageDelegate(
              extension,
              new WebExtension.MessageDelegate() {
                @Override
                public void onConnect(WebExtension.Port port) {
                  ports.add(port);
                  port.setDelegate(
                    new WebExtension.PortDelegate() {
                      @Override
                      public void onPortMessage(Object message, WebExtension.Port port) {
                        if (isTileAudioQuery(message)) {
                          postTileAudio(port, muted.getAsBoolean());
                          return;
                        }
                        if (onMessage != null) onMessage.accept(message);
                      }

                      @Override
                      public void onDisconnect(WebExtension.Port port) {
                        ports.remove(port);
                      }
                    }
                  );
                  final boolean silent = muted.getAsBoolean();
                  main.post(() -> postTileAudio(port, silent));
                }
              },
              "jiyu"
            );
        } catch (Throwable ignored) {}
        if (ready != null) ready.run();
      },
      e -> {
        if (ready != null) ready.run();
      }
    );
  }

  private static boolean isTileAudioQuery(Object message) {
    try {
      if (message instanceof JSONObject) {
        return "tileAudioQuery".equals(((JSONObject) message).optString("action"));
      }
      if (message instanceof Map) {
        return "tileAudioQuery".equals(String.valueOf(((Map<?, ?>) message).get("action")));
      }
    } catch (Throwable ignored) {}
    return false;
  }

  static void postTileAudio(WebExtension.Port port, boolean muted) {
    if (port == null) return;
    try {
      JSONObject msg = new JSONObject();
      msg.put("action", "tileAudio");
      msg.put("muted", muted);
      port.postMessage(msg);
    } catch (Throwable ignored) {}
  }

  /**
   * Keep measuring until the paused play control is on screen, then tap it.
   * A missing button is not a skip — the player often mounts after the document loads.
   * A playing video reports no rect, so this does not pause a live stream.
   */
  void tapPlayButton(@Nullable Runnable done) {
    if (loading) {
      playTapAfterLoad = true;
      playTapAfterLoadDone = done;
      return;
    }
    if (playTapsSent || (currentUrl != null && currentUrl.equals(playTapUrl))) {
      if (done != null) done.run();
      return;
    }
    if (playTap != null && !playTap.done && playTap.doneCb != null && playTap.doneCb != done) {
      playTap.done = true;
      Runnable previous = playTap.doneCb;
      playTap = null;
      previous.run();
    }
    beginPlayButtonWatch(done, 0);
  }

  private static final int PLAY_LOOK_INTERVAL_MS = 400;
  /** About 20s of looking after the caller asks. The button is often late. */
  private static final int PLAY_LOOK_MAX = 50;

  private void beginPlayButtonWatch(@Nullable Runnable done, int attempt) {
    if (view == null || session == null || view.getVisibility() != View.VISIBLE || attempt >= PLAY_LOOK_MAX) {
      if (done != null) done.run();
      return;
    }
    if (bridgePorts.isEmpty()) {
      if (attempt >= 3) {
        tapTwice(0.5f, 0.5f);
        if (done != null) done.run();
        return;
      }
      main.postDelayed(() -> beginPlayButtonWatch(done, attempt + 1), PLAY_LOOK_INTERVAL_MS);
      return;
    }
    int id = ++playTapSeq;
    PlayTap tap = new PlayTap();
    tap.id = id;
    tap.expect = bridgePorts.size();
    tap.attempt = attempt;
    tap.doneCb = done;
    playTap = tap;
    for (WebExtension.Port port : bridgePorts) {
      postQueryPlayButtonRect(port, id, tap.attempt);
    }
    main.postDelayed(() -> finishPlayButtonTap(id), 700);
  }

  private int playTapSeq;
  @Nullable private PlayTap playTap;
  private boolean playTapsSent;
  private boolean playTapAfterLoad;
  @Nullable private Runnable playTapAfterLoadDone;

  private static final class PlayTap {
    int id;
    int expect;
    int got;
    int attempt;
    boolean done;
    boolean have;
    boolean playing;
    boolean fromTop;
    float cx;
    float cy;
    float vw;
    float vh;
    float area;
    @Nullable Runnable doneCb;
  }

  private static boolean isPlayButtonRect(Object message) {
    try {
      if (message instanceof JSONObject) {
        return "playButtonRect".equals(((JSONObject) message).optString("action"));
      }
      if (message instanceof Map) {
        return "playButtonRect".equals(String.valueOf(((Map<?, ?>) message).get("action")));
      }
    } catch (Throwable ignored) {}
    return false;
  }

  @SuppressWarnings("unchecked")
  private void onPlayButtonRect(Object message) {
    PlayTap tap = playTap;
    int id = -1;
    boolean found = false;
    String frame = "";
    float cx = 0f;
    float cy = 0f;
    float vw = 0f;
    float vh = 0f;
    float width = 0f;
    float height = 0f;
    boolean playing = false;
    try {
      if (message instanceof JSONObject) {
        JSONObject o = (JSONObject) message;
        id = o.optInt("id", -1);
        found = o.optBoolean("found");
        playing = o.optBoolean("playing");
        frame = o.optString("frame");
        cx = (float) o.optDouble("cx");
        cy = (float) o.optDouble("cy");
        vw = (float) o.optDouble("vw");
        vh = (float) o.optDouble("vh");
        width = (float) o.optDouble("w");
        height = (float) o.optDouble("h");
      } else if (message instanceof Map) {
        Map<String, Object> map = (Map<String, Object>) message;
        Object idObj = map.get("id");
        id = idObj instanceof Number ? ((Number) idObj).intValue() : -1;
        Object foundObj = map.get("found");
        found = Boolean.TRUE.equals(foundObj) || "true".equals(String.valueOf(foundObj));
        Object playingObj = map.get("playing");
        playing = Boolean.TRUE.equals(playingObj) || "true".equals(String.valueOf(playingObj));
        Object frameObj = map.get("frame");
        frame = frameObj == null ? "" : String.valueOf(frameObj);
        cx = map.get("cx") instanceof Number ? ((Number) map.get("cx")).floatValue() : 0f;
        cy = map.get("cy") instanceof Number ? ((Number) map.get("cy")).floatValue() : 0f;
        vw = map.get("vw") instanceof Number ? ((Number) map.get("vw")).floatValue() : 0f;
        vh = map.get("vh") instanceof Number ? ((Number) map.get("vh")).floatValue() : 0f;
        width = map.get("w") instanceof Number ? ((Number) map.get("w")).floatValue() : 0f;
        height = map.get("h") instanceof Number ? ((Number) map.get("h")).floatValue() : 0f;
      } else {
        return;
      }
    } catch (Throwable ignored) {
      return;
    }
    if (tap == null || id != tap.id) return;
    if (playing) tap.playing = true;
    tap.got++;
    boolean top = "top".equals(frame);
    float area = Math.max(0f, width) * Math.max(0f, height);
    boolean better =
      found
        && vw > 1f
        && vh > 1f
        && (!tap.have || (top && !tap.fromTop) || (top == tap.fromTop && area > tap.area));
    if (better) {
      tap.have = true;
      tap.fromTop = top;
      tap.cx = cx;
      tap.cy = cy;
      tap.vw = vw;
      tap.vh = vh;
      tap.area = area;
    }
    if (tap.got >= tap.expect) finishPlayButtonTap(id);
  }

  private void finishPlayButtonTap(int id) {
    PlayTap tap = playTap;
    if (tap == null || tap.done || tap.id != id) return;
    tap.done = true;
    playTap = null;
    Runnable done = tap.doneCb;
    if (tap.playing) {
      playTapUrl = currentUrl == null ? "" : currentUrl;
      if (done != null) done.run();
      return;
    }
    if (!tap.have || tap.vw < 1f || tap.vh < 1f || view == null) {
      if (view != null && tap.attempt >= 3) {
        tapTwice(0.5f, 0.5f);
        if (done != null) done.run();
        return;
      }
      if (tap.attempt + 1 >= PLAY_LOOK_MAX || view == null) {
        if (done != null) done.run();
        return;
      }
      main.postDelayed(() -> beginPlayButtonWatch(done, tap.attempt + 1), PLAY_LOOK_INTERVAL_MS);
      return;
    }
    tapTwice(tap.cx / tap.vw, tap.cy / tap.vh);
    if (done != null) done.run();
  }

  /** Ask this frame for the play control's CSS-pixel box. There is no executeScript on GV 140. */
  static void postQueryPlayButtonRect(WebExtension.Port port, int id, int attempt) {
    if (port == null) return;
    try {
      JSONObject msg = new JSONObject();
      msg.put("action", "queryPlayButtonRect");
      msg.put("id", id);
      msg.put("attempt", attempt);
      port.postMessage(msg);
    } catch (Throwable ignored) {}
  }

  /** Ask this frame to click the embed play control once. There is no executeScript on GV 140. */
  static void postTileKick(WebExtension.Port port, boolean muted) {
    if (port == null) return;
    try {
      JSONObject msg = new JSONObject();
      msg.put("action", "tileKick");
      msg.put("muted", muted);
      port.postMessage(msg);
    } catch (Throwable ignored) {}
  }

  @SuppressWarnings("unchecked")
  private void handleBridgeMessage(Object message) {
    if (isTileAudioQuery(message)) return;
    try {
      long id = -1;
      Object result = null;
      Object error = null;
      if (message instanceof JSONObject) {
        JSONObject o = (JSONObject) message;
        id = o.optLong("id", -1);
        result = o.isNull("result") ? null : o.get("result");
        error = o.isNull("error") ? null : o.opt("error");
      } else if (message instanceof Map) {
        Map<String, Object> map = (Map<String, Object>) message;
        Object idObj = map.get("id");
        id = idObj instanceof Number ? ((Number) idObj).longValue() : -1;
        result = map.get("result");
        error = map.get("error");
      } else {
        return;
      }
      if (error != null && !"null".equals(String.valueOf(error))) {
        // Keep waiting for other frames unless this was the only reply.
        finishEvalIfReady(id, null, false);
        return;
      }
      final String json = toJsResult(result);
      finishEvalIfReady(id, json, true);
    } catch (Throwable ignored) {}
  }

  /** Prefer play/unmute outcomes from any frame over no-video / idle. */
  private static int evalRank(@Nullable String json) {
    if (json == null || "null".equals(json)) return 0;
    String s = json.toLowerCase();
    if (s.contains("already-playing") || s.contains("play-with-sound") || s.contains("\"play\"")) {
      return 5;
    }
    if (s.contains("already-muted") || s.contains("play-kept-muted") || s.contains("unmute")) {
      return 4;
    }
    if (s.contains("play-ui") || s.contains("play-called") || s.contains("\"already\"")) {
      return 3;
    }
    if (s.contains("playing")) return 4;
    if (s.contains("installed") || s.contains("\"ready\"") || s.contains("placed")) return 6;
    if (s.contains("\"child\"") || s.contains("\"skip\"")) return 0;
    if (s.contains("no-video") || s.contains("idle") || s.contains("noop")) return 1;
    return 2;
  }

  private void finishEvalIfReady(long id, @Nullable String json, boolean haveResult) {
    EvalCallback cb = null;
    String best = null;
    synchronized (pendingEval) {
      if (!pendingEval.containsKey(id) && !pendingEvalExpect.containsKey(id)) return;
      if (haveResult) {
        String prev = pendingEvalBest.get(id);
        if (prev == null || evalRank(json) >= evalRank(prev)) {
          pendingEvalBest.put(id, json);
        }
      }
      Integer left = pendingEvalExpect.get(id);
      if (left == null) {
        // Fire-and-forget or already completed.
        return;
      }
      left = left - 1;
      if (left > 0) {
        pendingEvalExpect.put(id, left);
        return;
      }
      pendingEvalExpect.remove(id);
      best = pendingEvalBest.remove(id);
      cb = pendingEval.remove(id);
    }
    if (cb != null) {
      final String out = best;
      final EvalCallback done = cb;
      main.post(() -> done.onResult(out));
    }
  }

  void evaluateJavascript(String script, @Nullable EvalCallback callback) {
    if (session == null || script == null || script.isEmpty()) {
      if (callback != null) callback.onResult(null);
      return;
    }
    long id = evalSeq.getAndIncrement();
    if (callback != null) {
      synchronized (pendingEval) {
        pendingEval.put(id, callback);
      }
      main.postDelayed(
        () -> {
          EvalCallback stuck;
          String best;
          synchronized (pendingEval) {
            stuck = pendingEval.remove(id);
            pendingEvalExpect.remove(id);
            best = pendingEvalBest.remove(id);
          }
          if (stuck != null) stuck.onResult(best);
        },
        6000
      );
    }
    if (!bridgePorts.isEmpty()) {
      postEval(id, script, callback);
      return;
    }
    synchronized (bridgeQueue) {
      bridgeQueue.add(new PendingEval(id, script, callback));
      if (bridgeQueue.size() > 40) {
        PendingEval dropped = bridgeQueue.remove(0);
        if (dropped.callback != null) {
          synchronized (pendingEval) {
            pendingEval.remove(dropped.id);
          }
          main.post(() -> dropped.callback.onResult(null));
        }
      }
    }
  }

  private void postEval(long id, String script, @Nullable EvalCallback callback) {
    try {
      JSONObject msg = new JSONObject();
      msg.put("action", "eval");
      msg.put("id", id);
      msg.put("code", script);
      int ports = 0;
      for (WebExtension.Port port : bridgePorts) {
        try {
          port.postMessage(msg);
          ports++;
        } catch (Throwable ignored) {}
      }
      if (callback == null) {
        synchronized (pendingEval) {
          pendingEval.remove(id);
          pendingEvalExpect.remove(id);
          pendingEvalBest.remove(id);
        }
        return;
      }
      if (ports <= 0) {
        synchronized (pendingEval) {
          pendingEval.remove(id);
        }
        main.post(() -> callback.onResult(null));
        return;
      }
      synchronized (pendingEval) {
        pendingEvalExpect.put(id, ports);
      }
    } catch (Throwable t) {
      if (callback != null) {
        synchronized (pendingEval) {
          pendingEval.remove(id);
          pendingEvalExpect.remove(id);
        }
        main.post(() -> callback.onResult(null));
      }
    }
  }

  private void flushBridgeQueue() {
    java.util.ArrayList<PendingEval> batch;
    synchronized (bridgeQueue) {
      if (bridgeQueue.isEmpty()) return;
      batch = new java.util.ArrayList<>(bridgeQueue);
      bridgeQueue.clear();
    }
    for (PendingEval item : batch) {
      postEval(item.id, item.code, item.callback);
    }
  }

  private static String toJsResult(Object result) {
    if (result == null) return "null";
    if (result instanceof Boolean || result instanceof Number) return String.valueOf(result);
    if (result instanceof String) {
      try {
        return JSONObject.quote((String) result);
      } catch (Throwable t) {
        return "\"" + String.valueOf(result).replace("\"", "\\\"") + "\"";
      }
    }
    try {
      return String.valueOf(result);
    } catch (Throwable t) {
      return "null";
    }
  }

  void loadUrl(String url) {
    loadUrl(url, false);
  }

  /** Movy / Atlantic origins are HLS Referers only — never open as documents. */
  private static boolean isStreamRefererOnlyUrl(String url) {
    if (url == null || url.isEmpty()) return false;
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

  void loadUrl(String url, boolean stripReferer) {
    if (session == null || url == null || url.isEmpty()) return;
    if (isStreamRefererOnlyUrl(url)) {
      android.util.Log.w("JiyuGecko", "blocked stream-referer page " + url);
      return;
    }
    loading = true;
    currentUrl = url;
    emitNav();
    try {
      GeckoSession.Loader loader = new GeckoSession.Loader().uri(url);
      if (stripReferer) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
        headers.put("Accept-Language", "en-US,en;q=0.9");
        loader.additionalHeaders(headers);
      }
      session.load(loader);
    } catch (Throwable t) {
      session.loadUri(url);
    }
  }

  /** Replace the document with HTML. Used for the multiview shell (two iframes, no sandbox). */
  void loadHtml(String html) {
    ensureSession();
    if (session == null || html == null || html.isEmpty()) return;
    try {
      session.setActive(true);
    } catch (Throwable ignored) {}
    loading = true;
    currentUrl = "multiview";
    emitNav();
    try {
      // The String overload builds data:text/html,<html> without encoding.
      // background:#000 then becomes a URL fragment, so the iframes never load
      // and both tiles paint the default white page.
      session.load(
        new GeckoSession.Loader()
          .data(html.getBytes(java.nio.charset.StandardCharsets.UTF_8), "text/html")
      );
    } catch (Throwable t) {
      loadUrl("data:text/html;charset=utf-8," + android.net.Uri.encode(html));
    }
  }

  void goBack() {
    if (session == null) return;
    try {
      session.goBack();
    } catch (Throwable ignored) {}
  }

  void goForward() {
    if (session == null) return;
    try {
      session.goForward();
    } catch (Throwable ignored) {}
  }

  void reload() {
    if (session != null) session.reload();
  }

  void pause() {
    if (session != null) {
      try {
        session.setActive(false);
      } catch (Throwable ignored) {}
    }
  }

  void resume() {
    if (session != null) {
      try {
        session.setActive(true);
      } catch (Throwable ignored) {}
    }
  }

  void blank() {
    // about:blank is white. A black document matches the player stage if a load is still settling.
    loadUrl("data:text/html,<html><body style='background:%23000'></body></html>");
    currentUrl = "";
    currentTitle = "";
  }

  /**
   * Stop playback without closing the session. Replacing the session on hide
   * left GeckoView with no attached session, so the next stream stayed white.
   */
  void stopAndBlank() {
    evaluateJavascript(
      "(function(){try{"
        + "function kill(root){try{(root||document).querySelectorAll('video,audio').forEach(function(m){"
        + "try{m.pause();m.muted=true;m.volume=0;}catch(e){}});}catch(e){}}"
        + "kill(document);"
        + "return 'stopped';}catch(e){return 'error'}})()",
      null
    );
    try {
      if (session != null) session.setActive(true);
    } catch (Throwable ignored) {}
    blank();
  }

  /** Reattach a session if a previous hard-reset detached it. */
  void ensureSession() {
    if (view == null) return;
    if (session != null) return;
    try {
      openFreshSession();
      view.setSession(session);
      installBridge(session);
    } catch (Throwable ignored) {}
  }

  /** Mute/unmute media in-page (multi-view spotlight). */
  void setPageMuted(boolean muted) {
    double level = muted ? 0 : 1;
    String script =
      "(function(){try{window.__jiyuVolLevel=" + level + ";"
        + "var nodes=document.querySelectorAll('video,audio');"
        + "for(var i=0;i<nodes.length;i++){nodes[i].muted=" + muted + ";nodes[i].volume=" + level + ";"
        + "if(!" + muted + "){try{nodes[i].play();}catch(e){}}}"
        + "return " + muted + "?'muted':'unmuted';}catch(e){return 'error'}})()";
    evaluateJavascript(script, null);
  }

  /**
   * Hard-stop all media — used when Multiview takes over so Gecko cannot keep
   * playing audio under Chromium tiles. Closing the session is required because
   * suspendMediaWhenInactive is false (needed for autoplay) and cross-origin
   * iframe media ignores top-document pause scripts.
   */
  void killMediaAndBlank() {
    evaluateJavascript(
      "(function(){try{"
        + "function kill(root){try{(root||document).querySelectorAll('video,audio').forEach(function(m){"
        + "try{m.pause();m.muted=true;m.volume=0;"
        + "m.removeAttribute('src');m.src='';m.srcObject=null;m.load();}catch(e){}});}catch(e){}}"
        + "kill(document);"
        + "try{for(var i=0;i<window.frames.length;i++){try{kill(window.frames[i].document);}catch(e){}}}catch(e){}"
        + "return 'killed';}catch(e){return 'error'}})()",
      null
    );
    try {
      if (session != null) session.setActive(false);
    } catch (Throwable ignored) {}

    GeckoSession old = session;
    try {
      if (view != null) view.releaseSession();
    } catch (Throwable ignored) {}
    try {
      if (old != null) old.close();
    } catch (Throwable ignored) {}
    session = null;
    bridgePorts.clear();
    currentUrl = "";
    currentTitle = "";
    canGoBack = false;
    canGoForward = false;
    loading = false;

    if (view == null) return;
    try {
      openFreshSession();
      view.setSession(session);
      installBridge(session);
      try {
        session.setActive(false);
      } catch (Throwable ignored) {}
      blank();
    } catch (Throwable t) {
      try {
        blank();
      } catch (Throwable ignored) {}
    }
  }

  void destroy() {
    try {
      if (session != null) {
        session.setActive(false);
        session.close();
      }
    } catch (Throwable ignored) {}
    session = null;
    bridgePorts.clear();
    if (view != null) {
      try {
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        view.releaseSession();
      } catch (Throwable ignored) {}
    }
    view = null;
    synchronized (pendingEval) {
      pendingEval.clear();
      pendingEvalExpect.clear();
      pendingEvalBest.clear();
    }
    synchronized (bridgeQueue) {
      bridgeQueue.clear();
    }
  }

  private void emitNav() {
    if (navListener == null) return;
    navListener.onNav(currentUrl, currentTitle, canGoBack, canGoForward, loading);
  }
}
