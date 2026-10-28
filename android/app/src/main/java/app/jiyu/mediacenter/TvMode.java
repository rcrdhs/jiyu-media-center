package app.jiyu.mediacenter;

import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;

/**
 * Android TV / Google TV / Fire TV detection. Everything TV-only (remote keys,
 * pointer over the in-app browser, 10-foot layout) is gated on this so phones
 * keep their current behaviour.
 */
public final class TvMode {
  private static Boolean cached;

  private TvMode() {}

  public static boolean isTv(Context context) {
    if (cached != null) return cached;
    boolean tv = false;
    try {
      UiModeManager ui = (UiModeManager) context.getSystemService(Context.UI_MODE_SERVICE);
      if (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION) tv = true;
    } catch (Throwable ignored) {}
    if (!tv) {
      try {
        PackageManager pm = context.getPackageManager();
        if (pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)) tv = true;
        // Fire TV reports amazon.hardware.fire_tv; some older ones skip LEANBACK.
        if (pm.hasSystemFeature("amazon.hardware.fire_tv")) tv = true;
      } catch (Throwable ignored) {}
    }
    cached = tv;
    return tv;
  }
}
