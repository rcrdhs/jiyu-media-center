package app.jiyu.mediacenter;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps the process in the foreground while a catalog sync is running,
 * so leaving Jiyu does not freeze the update.
 *
 * Must not use START_STICKY — a system restart after sync ends would leave
 * "Updating the catalog" pinned forever with no JS session holding it.
 */
public class CatalogSyncService extends Service {
  static final String CHANNEL_ID = "jiyu.catalog.sync";
  static final String EXTRA_OWNED = "jiyu.catalog.sync.owned";
  private static final int NOTIFICATION_ID = 41;

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    // Sticky / null-intent restarts are not a live JS sync — tear down immediately.
    if (intent == null || !intent.getBooleanExtra(EXTRA_OWNED, false)) {
      clearNotification();
      stopSelf();
      return START_NOT_STICKY;
    }
    if (!CatalogSyncPlugin.isSyncHoldActive()) {
      clearNotification();
      stopSelf();
      return START_NOT_STICKY;
    }
    Notification notification = buildNotification();
    if (Build.VERSION.SDK_INT >= 34) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    } else {
      startForeground(NOTIFICATION_ID, notification);
    }
    return START_NOT_STICKY;
  }

  @Override
  public void onDestroy() {
    clearNotification();
    super.onDestroy();
  }

  private void clearNotification() {
    try {
      stopForeground(STOP_FOREGROUND_REMOVE);
    } catch (Throwable ignored) {}
    try {
      NotificationManager manager = getSystemService(NotificationManager.class);
      if (manager != null) manager.cancel(NOTIFICATION_ID);
    } catch (Throwable ignored) {}
  }

  private Notification buildNotification() {
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
      NotificationChannel channel = new NotificationChannel(
        CHANNEL_ID,
        "Catalog sync",
        NotificationManager.IMPORTANCE_LOW
      );
      channel.setDescription("Shown while Jiyu updates the catalog");
      channel.setShowBadge(false);
      manager.createNotificationChannel(channel);
    }
    Intent open = new Intent(this, MainActivity.class);
    open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    PendingIntent pending = PendingIntent.getActivity(
      this,
      0,
      open,
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
    );
    Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Jiyu")
      .setContentText("Updating the catalog")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentIntent(pending)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_PROGRESS);
    return builder.build();
  }
}
