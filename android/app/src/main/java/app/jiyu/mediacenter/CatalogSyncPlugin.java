package app.jiyu.mediacenter;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Start or stop the catalog-sync foreground service from the web layer. */
@CapacitorPlugin(name = "CatalogSync")
public class CatalogSyncPlugin extends Plugin {
  private static final int NOTIFICATION_REQUEST = 4101;
  private static final int SYNC_NOTIFICATION_ID = 41;
  /** True while JS holds the sync session (foreground service up). */
  private static volatile boolean syncHoldActive = false;

  public static boolean isSyncHoldActive() {
    return syncHoldActive;
  }

  @Override
  public void load() {
    // Cold start: drop any orphaned "Updating the catalog" pin from a killed sync.
    syncHoldActive = false;
    Activity activity = getActivity();
    if (activity != null) {
      activity.runOnUiThread(() -> {
        try {
          activity.stopService(new Intent(activity, CatalogSyncService.class));
        } catch (Throwable ignored) {}
        try {
          NotificationManager manager = activity.getSystemService(NotificationManager.class);
          if (manager != null) manager.cancel(SYNC_NOTIFICATION_ID);
        } catch (Throwable ignored) {}
      });
    }
  }

  @PluginMethod
  public void setActive(PluginCall call) {
    boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
    syncHoldActive = active;
    Activity activity = getActivity();
    if (activity == null) {
      call.reject("Activity unavailable");
      return;
    }
    activity.runOnUiThread(() -> {
      try {
        if (active) {
          askNotificationPermission(activity);
          Intent intent = new Intent(activity, CatalogSyncService.class);
          intent.putExtra(CatalogSyncService.EXTRA_OWNED, true);
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.startForegroundService(intent);
          } else {
            activity.startService(intent);
          }
        } else {
          activity.stopService(new Intent(activity, CatalogSyncService.class));
          NotificationManager manager = activity.getSystemService(NotificationManager.class);
          if (manager != null) manager.cancel(SYNC_NOTIFICATION_ID);
        }
        call.resolve();
      } catch (Exception err) {
        call.reject(err.getMessage() == null ? "Catalog sync service failed" : err.getMessage());
      }
    });
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
