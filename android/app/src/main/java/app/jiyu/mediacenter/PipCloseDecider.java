package app.jiyu.mediacenter;

/**
 * Decides whether leaving system picture-in-picture is a real dismiss.
 *
 * <p>Phone evidence (Xperia XQ-BC72, Android 13, Jiyu 0.3.96): dragging the PiP
 * window onto the bottom-center close target fully left PiP. MainActivity was
 * then STOPPED, finishing=false, still in Recents, not in PiP. WebView audio
 * for a live HLS stream stopped on its own a few seconds later. The missing
 * piece is removing the task. Gecko was not on that trace.
 *
 * <p>Callback order is not stable from API 28 through 36, so this does not
 * finish on {@code onPictureInPictureModeChanged(false)} by itself:
 *
 * <ul>
 *   <li>Expand, mode callback then resume (AOSP): mode false, then onResume
 *       while not in PiP. Not a dismiss.
 *   <li>Expand, resume while the flag is still true, then mode false: the
 *       resume is remembered only until the next onPause that is still in PiP
 *       (screen on). Mode false with that resume still set is an expand.
 *   <li>Dismiss, mode false then onStop (AOSP, matches the Xperia end state):
 *       onStop while not in PiP, and we never resumed. Dismiss.
 *   <li>Dismiss, onStop while still in PiP, then mode false (some OEMs): the
 *       stop is remembered. Mode false without a later onStart/onResume
 *       dismisses. Screen-off uses the same stop, but the next onStart while
 *       still in PiP clears it, so the window is not closed.
 *   <li>Edge stash: the activity stays in PiP. No mode-false and no onStop.
 *       Not a dismiss. Playback is left running.
 *   <li>Repeated mode callbacks: dismiss is committed once.
 *   <li>Configuration change: onStop reports changingConfigurations and is
 *       ignored.
 * </ul>
 *
 * <p>A catalog sync does not change the decision. Closing removes the task
 * and cancels the sync; Home that enters or stays in PiP does not.
 */
public final class PipCloseDecider {
  public enum Action {
    NONE,
    DISMISS
  }

  private boolean enteredPip;
  private boolean leaveWatch;
  private boolean stopWhileInside;
  private boolean sawResume;
  /** onResume while still pinned, not yet followed by onPause-in-PiP. */
  private boolean resumeWhilePinned;
  private boolean dismissCommitted;

  public Action onPictureInPictureModeChanged(boolean inPip) {
    if (dismissCommitted) return Action.NONE;
    if (inPip) {
      enteredPip = true;
      leaveWatch = false;
      stopWhileInside = false;
      sawResume = false;
      resumeWhilePinned = false;
      return Action.NONE;
    }
    if (!enteredPip) return Action.NONE;
    if (sawResume || resumeWhilePinned) {
      clearExit();
      return Action.NONE;
    }
    leaveWatch = true;
    if (stopWhileInside) return commit();
    return Action.NONE;
  }

  public Action onStart(boolean inPip) {
    if (dismissCommitted) return Action.NONE;
    if (inPip) stopWhileInside = false;
    return Action.NONE;
  }

  public Action onResume(boolean inPip) {
    if (dismissCommitted) return Action.NONE;
    if (inPip && enteredPip) {
      resumeWhilePinned = true;
      stopWhileInside = false;
      return Action.NONE;
    }
    if (enteredPip || leaveWatch) {
      sawResume = true;
      leaveWatch = false;
      stopWhileInside = false;
      resumeWhilePinned = false;
      enteredPip = false;
    }
    return Action.NONE;
  }

  public Action onPause(boolean inPip) {
    if (dismissCommitted) return Action.NONE;
    if (inPip) {
      sawResume = false;
      resumeWhilePinned = false;
    }
    return Action.NONE;
  }

  /**
   * @param changingConfigurations activity is going away for a config change
   * @param finishing activity is already finishing
   * @param inPip {@code Activity.isInPictureInPictureMode()} at the start of onStop
   */
  public Action onStop(boolean changingConfigurations, boolean finishing, boolean inPip) {
    if (dismissCommitted || finishing || changingConfigurations) return Action.NONE;
    if (!enteredPip && !leaveWatch) return Action.NONE;
    if (sawResume && !leaveWatch) return Action.NONE;
    if (leaveWatch) return commit();
    if (inPip) {
      stopWhileInside = true;
      return Action.NONE;
    }
    if (enteredPip && !resumeWhilePinned) return commit();
    return Action.NONE;
  }

  public boolean isDismissCommitted() {
    return dismissCommitted;
  }

  private Action commit() {
    if (dismissCommitted) return Action.NONE;
    dismissCommitted = true;
    clearExit();
    return Action.DISMISS;
  }

  private void clearExit() {
    enteredPip = false;
    leaveWatch = false;
    stopWhileInside = false;
    sawResume = false;
    resumeWhilePinned = false;
  }
}
