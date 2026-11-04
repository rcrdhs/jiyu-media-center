package app.jiyu.mediacenter;

import android.util.Log;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.WebView;

/**
 * Side WebViews (scrape / multi-view tiles / Bilibili sign-in) share the app's
 * WebView renderer. When Android kills it, every WebViewClient is asked; one that
 * returns false makes Chromium abort the whole app. Drop the dead view and report
 * handled - MainActivity rebuilds the activity (and these plugins) for the main view.
 */
public final class RendererGone {
  private RendererGone() {}

  public static boolean release(WebView view, String who) {
    Log.w("Jiyu", "WebView renderer gone (" + who + "); dropping the view");
    try {
      if (view != null) {
        ViewParent parent = view.getParent();
        if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(view);
        view.destroy();
      }
    } catch (Throwable ignored) {}
    return true;
  }
}
