package app.jiyu.mediacenter;

/**
 * Whether the "Updating the catalog" notification is allowed to show.
 *
 * <p>The foreground service does not crawl the catalog. The page does. The
 * notification may show only while that work is running and the app is still
 * open. Closing the app (PiP dismiss, explicit exit, Recents removal) drops
 * the notification even if a sync had been started. The next launch must not
 * treat that interrupted job as still running.
 */
public final class CatalogSyncGate {
  private boolean running;
  private boolean closed;

  public void onSyncStart() {
    if (closed) return;
    running = true;
  }

  public void onSyncEnd() {
    running = false;
  }

  /** PiP dismiss, explicit exit, or the task being removed. */
  public void onAppClosed() {
    running = false;
    closed = true;
  }

  /** A new activity (next launch or a config recreate) may sync again. */
  public void onActivityCreated() {
    closed = false;
    running = false;
  }

  public boolean notificationVisible() {
    return running && !closed;
  }

  public boolean allowSyncStart() {
    return !closed;
  }

  public boolean resumePendingJobOnNextOpen() {
    return !closed;
  }
}
