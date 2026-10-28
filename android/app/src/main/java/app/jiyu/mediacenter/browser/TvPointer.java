package app.jiyu.mediacenter.browser;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;

import org.mozilla.geckoview.GeckoView;

import app.jiyu.mediacenter.TvMode;

/**
 * TV remote pointer over the native browser surfaces (Gecko single stream,
 * Multiview Gecko tiles). The Capacitor WebView cannot draw a focus ring on
 * top of these native views, and the embed pages need real taps to start a
 * stream, so on TV we draw our own ring + cursor in the overlay host.
 *
 * Modes: OFF (nothing drawn), FOCUS (ring around the surface; keys still go to
 * the web UI), CURSOR (D-pad moves a cursor, OK taps, Back returns to FOCUS).
 *
 * Only ever active on TV; phones never construct the views.
 */
public final class TvPointer {
  public static final int OFF = 0;
  public static final int FOCUS = 1;
  public static final int CURSOR = 2;

  public interface Listener {
    void onModeChanged(String mode);
  }

  private static TvPointer instance;

  public static synchronized TvPointer get() {
    if (instance == null) instance = new TvPointer();
    return instance;
  }

  /** TV only: native overlay surfaces must never take D-pad focus from the web UI. */
  public static void prepareOverlayView(@Nullable View view) {
    if (view == null) return;
    try {
      if (!TvMode.isTv(view.getContext())) return;
      view.setFocusable(false);
      view.setFocusableInTouchMode(false);
      if (view instanceof ViewGroup) {
        ((ViewGroup) view).setDescendantFocusability(ViewGroup.FOCUS_BLOCK_DESCENDANTS);
      }
    } catch (Throwable ignored) {}
  }

  @Nullable private FrameLayout host;
  @Nullable private View ring;
  @Nullable private View cursor;
  @Nullable private TextView hint;
  @Nullable private Listener listener;
  private int mode = OFF;
  /** Surface rect in host pixels. */
  private int bx;
  private int by;
  private int bw;
  private int bh;
  private float cx;
  private float cy;

  private TvPointer() {}

  void attach(FrameLayout host, Listener listener) {
    this.listener = listener;
    if (this.host == host && ring != null) return;
    detachViews();
    this.host = host;
  }

  public boolean isCursor() {
    return mode == CURSOR && host != null;
  }

  public int getMode() {
    return mode;
  }

  /** Bounds are CSS px relative to the Capacitor WebView (same space as setBounds). */
  void setMode(int next, float x, float y, float width, float height, float density, boolean notify) {
    if (host == null) return;
    if (width > 0 && height > 0) {
      bx = Math.round(x * density);
      by = Math.round(y * density);
      bw = Math.max(8, Math.round(width * density));
      bh = Math.max(8, Math.round(height * density));
    }
    boolean entering = next == CURSOR && mode != CURSOR;
    mode = next;
    if (mode == OFF || bw <= 0 || bh <= 0) {
      hideViews();
    } else {
      ensureViews();
      if (entering) {
        cx = bx + bw * 0.5f;
        cy = by + bh * 0.42f;
      }
      clampCursor();
      layoutViews();
    }
    if (notify) notifyMode();
  }

  void off() {
    if (mode == OFF) return;
    mode = OFF;
    hideViews();
    notifyMode();
  }

  /**
   * Called from MainActivity.dispatchKeyEvent while in CURSOR mode.
   * Returns true when the key was consumed.
   */
  public boolean handleKey(KeyEvent event) {
    if (!isCursor()) return false;
    int code = event.getKeyCode();
    boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
    switch (code) {
      case KeyEvent.KEYCODE_DPAD_LEFT:
      case KeyEvent.KEYCODE_DPAD_RIGHT:
      case KeyEvent.KEYCODE_DPAD_UP:
      case KeyEvent.KEYCODE_DPAD_DOWN: {
        if (!down) return true;
        float step = dp(10 + Math.min(event.getRepeatCount(), 24) * 3);
        if (code == KeyEvent.KEYCODE_DPAD_LEFT) cx -= step;
        if (code == KeyEvent.KEYCODE_DPAD_RIGHT) cx += step;
        if (code == KeyEvent.KEYCODE_DPAD_UP) cy -= step;
        if (code == KeyEvent.KEYCODE_DPAD_DOWN) cy += step;
        clampCursor();
        layoutViews();
        return true;
      }
      case KeyEvent.KEYCODE_DPAD_CENTER:
      case KeyEvent.KEYCODE_ENTER:
      case KeyEvent.KEYCODE_NUMPAD_ENTER:
      case KeyEvent.KEYCODE_BUTTON_A:
        if (down && event.getRepeatCount() == 0) tapAtCursor();
        return true;
      case KeyEvent.KEYCODE_BACK:
      case KeyEvent.KEYCODE_ESCAPE:
      case KeyEvent.KEYCODE_BUTTON_B:
        if (!down) {
          mode = FOCUS;
          layoutViews();
          notifyMode();
        }
        return true;
      default:
        return false;
    }
  }

  private void notifyMode() {
    Listener l = listener;
    if (l == null) return;
    try {
      l.onModeChanged(mode == CURSOR ? "cursor" : mode == FOCUS ? "focus" : "off");
    } catch (Throwable ignored) {}
  }

  private void clampCursor() {
    if (bw <= 0 || bh <= 0) return;
    cx = Math.max(bx + 2, Math.min(bx + bw - 2, cx));
    cy = Math.max(by + 2, Math.min(by + bh - 2, cy));
  }

  private float dp(float v) {
    if (host == null) return v;
    return TypedValue.applyDimension(
      TypedValue.COMPLEX_UNIT_DIP, v, host.getResources().getDisplayMetrics());
  }

  private void ensureViews() {
    FrameLayout h = host;
    if (h == null) return;
    Context ctx = h.getContext();
    if (ring == null) {
      ring = new View(ctx);
      GradientDrawable d = new GradientDrawable();
      d.setColor(Color.TRANSPARENT);
      d.setStroke(Math.round(dp(4)), Color.parseColor("#F0B429"));
      d.setCornerRadius(dp(6));
      ring.setBackground(d);
      prepareInert(ring);
      h.addView(ring, new FrameLayout.LayoutParams(1, 1));
    }
    if (cursor == null) {
      cursor = new View(ctx);
      GradientDrawable d = new GradientDrawable();
      d.setShape(GradientDrawable.OVAL);
      d.setColor(Color.argb(235, 255, 255, 255));
      d.setStroke(Math.round(dp(3)), Color.parseColor("#F0B429"));
      cursor.setBackground(d);
      cursor.setElevation(dp(8));
      prepareInert(cursor);
      int s = Math.round(dp(22));
      h.addView(cursor, new FrameLayout.LayoutParams(s, s));
    }
    if (hint == null) {
      hint = new TextView(ctx);
      hint.setTextColor(Color.WHITE);
      hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
      hint.setGravity(Gravity.CENTER);
      int p = Math.round(dp(10));
      hint.setPadding(p + p / 2, p / 2, p + p / 2, p / 2);
      GradientDrawable d = new GradientDrawable();
      d.setColor(Color.argb(210, 8, 10, 13));
      d.setCornerRadius(dp(18));
      hint.setBackground(d);
      prepareInert(hint);
      h.addView(hint, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }
  }

  private static void prepareInert(View v) {
    v.setClickable(false);
    v.setFocusable(false);
    v.setFocusableInTouchMode(false);
    v.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
  }

  private void layoutViews() {
    if (ring == null || cursor == null || hint == null || host == null) return;
    if (mode == OFF) {
      hideViews();
      return;
    }
    FrameLayout.LayoutParams rl = (FrameLayout.LayoutParams) ring.getLayoutParams();
    rl.leftMargin = bx;
    rl.topMargin = by;
    rl.width = bw;
    rl.height = bh;
    ring.setLayoutParams(rl);
    ring.setVisibility(View.VISIBLE);

    FrameLayout.LayoutParams cl = (FrameLayout.LayoutParams) cursor.getLayoutParams();
    cl.leftMargin = Math.round(cx - cl.width / 2f);
    cl.topMargin = Math.round(cy - cl.height / 2f);
    cursor.setLayoutParams(cl);
    cursor.setVisibility(mode == CURSOR ? View.VISIBLE : View.GONE);

    hint.setText(mode == CURSOR
      ? "Arrows move  ·  OK clicks  ·  Back leaves pointer"
      : "OK: use pointer on this stream");
    FrameLayout.LayoutParams hl = (FrameLayout.LayoutParams) hint.getLayoutParams();
    hint.measure(
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
      View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
    int hw = hint.getMeasuredWidth();
    int hh = hint.getMeasuredHeight();
    hl.leftMargin = Math.max(0, bx + (bw - hw) / 2);
    hl.topMargin = Math.max(0, by + bh - hh - Math.round(dp(14)));
    hint.setLayoutParams(hl);
    hint.setVisibility(View.VISIBLE);

    // Gecko tiles are added later than our views; keep the pointer on top.
    ring.bringToFront();
    hint.bringToFront();
    cursor.bringToFront();
  }

  private void hideViews() {
    if (ring != null) ring.setVisibility(View.GONE);
    if (cursor != null) cursor.setVisibility(View.GONE);
    if (hint != null) hint.setVisibility(View.GONE);
  }

  private void detachViews() {
    for (View v : new View[] { ring, cursor, hint }) {
      if (v == null) continue;
      try {
        ViewGroup p = (ViewGroup) v.getParent();
        if (p != null) p.removeView(v);
      } catch (Throwable ignored) {}
    }
    ring = null;
    cursor = null;
    hint = null;
  }

  /** One trusted DOWN/UP pair on whichever browser surface is under the cursor. */
  private void tapAtCursor() {
    FrameLayout h = host;
    if (h == null) return;
    int[] hostOrigin = new int[2];
    h.getLocationOnScreen(hostOrigin);
    float sx = hostOrigin[0] + cx;
    float sy = hostOrigin[1] + cy;
    View target = null;
    int[] origin = new int[2];
    for (int i = h.getChildCount() - 1; i >= 0; i--) {
      View child = h.getChildAt(i);
      if (child == ring || child == cursor || child == hint) continue;
      if (child.getVisibility() != View.VISIBLE) continue;
      if (!(child instanceof GeckoView) && !(child instanceof WebView)) continue;
      if (child.getWidth() < 8 || child.getHeight() < 8) continue;
      child.getLocationOnScreen(origin);
      if (sx >= origin[0] && sx < origin[0] + child.getWidth()
        && sy >= origin[1] && sy < origin[1] + child.getHeight()) {
        target = child;
        break;
      }
    }
    if (target == null) return;
    float vx = sx - origin[0];
    float vy = sy - origin[1];
    long now = SystemClock.uptimeMillis();
    MotionEvent down = obtainTap(vx, vy, origin[0], origin[1], now, now, MotionEvent.ACTION_DOWN);
    MotionEvent up = obtainTap(vx, vy, origin[0], origin[1], now, now + 24, MotionEvent.ACTION_UP);
    try {
      target.dispatchTouchEvent(down);
      target.dispatchTouchEvent(up);
    } catch (Throwable ignored) {
    } finally {
      down.recycle();
      up.recycle();
    }
    // Brief pulse so the click is visible from the couch.
    final View c = cursor;
    if (c != null) {
      c.animate().cancel();
      c.setScaleX(0.7f);
      c.setScaleY(0.7f);
      c.animate().scaleX(1f).scaleY(1f).setDuration(160).start();
    }
  }

  /** Same raw/offset trick as GeckoOverlayController.obtainViewTap (PanZoom needs screen origin). */
  private static MotionEvent obtainTap(
    float viewX, float viewY, int screenX, int screenY, long downTime, long eventTime, int action
  ) {
    MotionEvent event = MotionEvent.obtain(downTime, eventTime, action, viewX + screenX, viewY + screenY, 0);
    event.offsetLocation(-screenX, -screenY);
    event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
    return event;
  }
}
