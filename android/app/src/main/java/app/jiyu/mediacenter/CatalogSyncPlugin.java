package app.jiyu.mediacenter;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Foreground-service pin for a catalog sync that is running in the page.
 * The service does not crawl sources. Closing Jiyu cancels that work and
 * removes the "Updating the catalog" notification.
 */
@CapacitorPlugin(name = "CatalogSync")
public class CatalogSyncPlugin extends Plugin {
  private static final int NOTIFICATION_REQUEST = 4101;
  static final int SYNC_NOTIFICATION_ID = 41;
  private static final String PREFS = "jiyu.catalog";
  private static final String KEY_CANCEL_ON_OPEN = "cancel-on-open";

  /** True while the page holds a live sync session. */
  private static volatile boolean syncHoldActive = false;
  private static final CatalogSyncGate gate = new CatalogSyncGate();

  public static boolean isSyncHoldActive() {
    return syncHoldActive && gate.notificationVisible();
  }

  /**
   * PiP dismiss, Back→exit, or Recents removal. Stops the notification now
   * and tells the next launch not to resume the interrupted job.
   */
  public static void markAppClosed(Context context) {
    gate.onAppClosed();
    syncHoldActive = false;
    if (context != null) {
      try {
        context
          .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
          .edit()
          .putBoolean(KEY_CANCEL_ON_OPEN, true)
          .commit();
      } catch (Throwable ignored) {}
    }
    stopSyncService(context);
  }

  @Override
  public void load() {
    gate.onActivityCreated();
    syncHoldActive = false;
    stopSyncService(getContext());
  }

  @PluginMethod
  public void setActive(PluginCall call) {
    boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
    Context context = getContext();
    if (!active) {
      gate.onSyncEnd();
      syncHoldActive = false;
      stopSyncService(context);
      call.resolve();
      return;
    }
    if (!gate.allowSyncStart()) {
      syncHoldActive = false;
      stopSyncService(context);
      call.resolve();
      return;
    }
    gate.onSyncStart();
    syncHoldActive = true;
    Activity activity = getActivity();
    if (activity == null) {
      call.reject("Activity unavailable");
      return;
    }
    activity.runOnUiThread(() -> {
      try {
        if (!gate.allowSyncStart() || !syncHoldActive) {
          stopSyncService(activity);
          call.resolve();
          return;
        }
        askNotificationPermission(activity);
        Intent intent = new Intent(activity, CatalogSyncService.class);
        intent.putExtra(CatalogSyncService.EXTRA_OWNED, true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          activity.startForegroundService(intent);
        } else {
          activity.startService(intent);
        }
        call.resolve();
      } catch (Exception err) {
        call.reject(err.getMessage() == null ? "Catalog sync service failed" : err.getMessage());
      }
    });
  }

  /** Next page load reads this once. True means the previous close cancelled the job. */
  @PluginMethod
  public void consumeCloseCancel(PluginCall call) {
    boolean cancel = false;
    Context context = getContext();
    if (context != null) {
      try {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        cancel = prefs.getBoolean(KEY_CANCEL_ON_OPEN, false);
        if (cancel) prefs.edit().remove(KEY_CANCEL_ON_OPEN).commit();
      } catch (Throwable ignored) {}
    }
    JSObject out = new JSObject();
    out.put("cancel", cancel);
    call.resolve(out);
  }

  @Override
  protected void handleOnDestroy() {
    Activity activity = getActivity();
    boolean configChange = activity != null && activity.isChangingConfigurations();
    if (!configChange) markAppClosed(getContext());
    super.handleOnDestroy();
  }

  private static void stopSyncService(Context context) {
    if (context == null) return;
    Context app = context.getApplicationContext();
    try {
      app.stopService(new Intent(app, CatalogSyncService.class));
    } catch (Throwable ignored) {}
    try {
      NotificationManager manager = app.getSystemService(NotificationManager.class);
      if (manager != null) manager.cancel(SYNC_NOTIFICATION_ID);
    } catch (Throwable ignored) {}
  }

  private void askNotificationPermission(Activity activity) {
    if (Build.VERSION.SDK_INT < 33) return;
    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS)
      == PackageManager.PERMISSION_GRANTED) {
      return;
    }
    ActivityCompat.requestPermissions(
      activity,
      new String[] { Manifest.permission.POST_NOTIFICATIONS },
      NOTIFICATION_REQUEST
    );
  }
}
