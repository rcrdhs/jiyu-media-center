package app.jiyu.mediacenter;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/**
 * Deterministic lifecycle traces for PiP dismiss vs expand, stash, and catalog close.
 * These run on the JVM. They do not drive a device.
 */
public class PipCloseDeciderTest {
  private final PipCloseDecider decider = new PipCloseDecider();
  private final List<PipCloseDecider.Action> actions = new ArrayList<>();

  @Test
  public void dismiss_modeFalseThenStop_removesTaskAndCancelsCatalog() {
    mode(true);
    mode(false);
    stop(false, false, false);
    assertEquals(List.of(PipCloseDecider.Action.DISMISS), actions);
    assertTrue(decider.isDismissCommitted());
    assertTrue(AppClosePolicy.cancelsCatalogSync(false, true, false, false));
    assertTrue(AppClosePolicy.finishAndRemoveTask(true, false, false, false));
    stop(false, false, false);
    assertEquals(1, actions.size());
  }

  @Test
  public void dismiss_stopWhilePinnedThenModeFalse_cancelsCatalog() {
    mode(true);
    stop(false, false, true);
    assertTrue(actions.isEmpty());
    mode(false);
    assertEquals(List.of(PipCloseDecider.Action.DISMISS), actions);
    assertTrue(AppClosePolicy.cancelsCatalogSync(false, true, false, false));
  }

  @Test
  public void dismiss_stillHappensWhenCatalogSyncIsRunning() {
    mode(true);
    mode(false);
    stop(false, false, false);
    assertEquals(List.of(PipCloseDecider.Action.DISMISS), actions);
    assertTrue(AppClosePolicy.finishAndRemoveTask(true, false, false, false));
  }

  @Test
  public void expand_modeFalseThenResume_doesNotCloseOrCancel() {
    mode(true);
    mode(false);
    resume(false);
    stop(false, false, false);
    assertTrue(actions.isEmpty());
    assertFalse(decider.isDismissCommitted());
    assertFalse(AppClosePolicy.cancelsCatalogSync(false, false, false, false));
  }

  @Test
  public void expand_resumeWhileFlagStillTrueThenModeFalse_doesNotClose() {
    mode(true);
    resume(true);
    mode(false);
    assertTrue(actions.isEmpty());
    stop(false, false, false);
    assertTrue(actions.isEmpty());
  }

  @Test
  public void stash_staysInPip_playbackSessionNotClosed() {
    mode(true);
    pause(true);
    start(true);
    assertTrue(actions.isEmpty());
    assertFalse(decider.isDismissCommitted());
    assertFalse(AppClosePolicy.cancelsCatalogSync(false, false, false, false));
  }

  @Test
  public void screenOffThenOnWhilePinned_doesNotDismiss() {
    mode(true);
    stop(false, false, true);
    start(true);
    resume(true);
    pause(true);
    assertTrue(actions.isEmpty());
  }

  @Test
  public void screenOffThenDismiss_stillCloses() {
    mode(true);
    stop(false, false, true);
    mode(false);
    assertEquals(List.of(PipCloseDecider.Action.DISMISS), actions);
  }

  @Test
  public void screenOnClearsStop_thenDismissUsesLaterStop() {
    mode(true);
    stop(false, false, true);
    start(true);
    resume(true);
    pause(true);
    mode(false);
    assertTrue(actions.isEmpty());
    stop(false, false, false);
    assertEquals(List.of(PipCloseDecider.Action.DISMISS), actions);
  }

  @Test
  public void homeWhileAlreadyInPip_isNotAClose() {
    mode(true);
    pause(true);
    assertFalse(AppClosePolicy.cancelsCatalogSync(false, false, false, false));
    assertFalse(AppClosePolicy.finishAndRemoveTask(false, false, false, false));
  }

  @Test
  public void leavingAppWithoutPip_cancelsCatalogEvenIfSyncWasRunning() {
    assertTrue(AppClosePolicy.cancelsCatalogSync(false, false, true, false));
    assertTrue(AppClosePolicy.finishAndRemoveTask(false, true, false, false));
  }

  @Test
  public void recentsRemoval_cancelsCatalogAndDoesNotNeedAnotherFinish() {
    assertTrue(AppClosePolicy.cancelsCatalogSync(false, false, false, true));
    assertFalse(AppClosePolicy.finishAndRemoveTask(false, false, false, true));
  }

  @Test
  public void configChange_doesNotCancelOrFinish() {
    mode(true);
    mode(false);
    stop(true, false, false);
    assertTrue(actions.isEmpty());
    assertFalse(AppClosePolicy.cancelsCatalogSync(true, true, true, true));
    assertFalse(AppClosePolicy.finishAndRemoveTask(true, true, true, false));
  }

  @Test
  public void repeatedModeFalse_dismissesOnce() {
    mode(true);
    mode(false);
    mode(false);
    stop(false, false, false);
    mode(false);
    assertEquals(List.of(PipCloseDecider.Action.DISMISS), actions);
  }

  @Test
  public void reenterPipBeforeStop_cancelsTheExitWatch() {
    mode(true);
    mode(false);
    mode(true);
    stop(false, false, true);
    assertTrue(actions.isEmpty());
  }

  @Test
  public void spuriousModeFalseWithoutEverEntering_isIgnored() {
    mode(false);
    stop(false, false, false);
    assertTrue(actions.isEmpty());
  }

  @Test
  public void catalogNotificationDropsWhenAppClosesMidSync_andDoesNotResume() {
    CatalogSyncGate gate = new CatalogSyncGate();
    gate.onSyncStart();
    assertTrue(gate.notificationVisible());
    gate.onAppClosed();
    assertFalse(gate.notificationVisible());
    assertFalse(gate.allowSyncStart());
    assertFalse(gate.resumePendingJobOnNextOpen());
    gate.onSyncStart();
    assertFalse(gate.notificationVisible());
  }

  @Test
  public void catalogNotificationDropsWhenSyncEndsWhileAppStaysOpen() {
    CatalogSyncGate gate = new CatalogSyncGate();
    gate.onSyncStart();
    gate.onSyncEnd();
    assertFalse(gate.notificationVisible());
    assertTrue(gate.allowSyncStart());
    assertTrue(gate.resumePendingJobOnNextOpen());
  }

  @Test
  public void homeIntoPipDoesNotClearARunningCatalogNotification() {
    CatalogSyncGate gate = new CatalogSyncGate();
    gate.onSyncStart();
    assertTrue(gate.notificationVisible());
    assertFalse(AppClosePolicy.cancelsCatalogSync(false, false, false, false));
  }

  @Test
  public void nextLaunchAfterClose_maySyncAgain() {
    CatalogSyncGate gate = new CatalogSyncGate();
    gate.onSyncStart();
    gate.onAppClosed();
    gate.onActivityCreated();
    assertTrue(gate.allowSyncStart());
    gate.onSyncStart();
    assertTrue(gate.notificationVisible());
  }

  private void mode(boolean inPip) {
    record(decider.onPictureInPictureModeChanged(inPip));
  }

  private void start(boolean inPip) {
    record(decider.onStart(inPip));
  }

  private void resume(boolean inPip) {
    record(decider.onResume(inPip));
  }

  private void pause(boolean inPip) {
    record(decider.onPause(inPip));
  }

  private void stop(boolean changingConfigurations, boolean finishing, boolean inPip) {
    record(decider.onStop(changingConfigurations, finishing, inPip));
  }

  private void record(PipCloseDecider.Action action) {
    if (action != PipCloseDecider.Action.NONE) actions.add(action);
  }
}
