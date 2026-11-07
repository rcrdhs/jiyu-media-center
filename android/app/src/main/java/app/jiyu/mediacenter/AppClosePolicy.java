package app.jiyu.mediacenter;

/**
 * When a close actually cancels the catalog update and removes its notification.
 *
 * <p>Home that enters PiP, Home while PiP is already up, expanding PiP, and an
 * edge stash are not closes. Dragging the PiP window closed, Back→exit, and
 * swiping the task out of Recents are. A running catalog sync does not keep
 * the task alive.
 */
public final class AppClosePolicy {
  private AppClosePolicy() {}

  public static boolean cancelsCatalogSync(
    boolean configChange,
    boolean pipDismiss,
    boolean leavingApp,
    boolean taskRemoved
  ) {
    if (configChange) return false;
    return pipDismiss || leavingApp || taskRemoved;
  }

  /** True when this close should finish and remove the task from Recents. */
  public static boolean finishAndRemoveTask(
    boolean pipDismiss,
    boolean leavingApp,
    boolean configChange,
    boolean alreadyFinishing
  ) {
    if (configChange || alreadyFinishing) return false;
    return pipDismiss || leavingApp;
  }
}
