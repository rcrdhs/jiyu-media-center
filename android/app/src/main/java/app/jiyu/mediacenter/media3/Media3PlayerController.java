package app.jiyu.mediacenter.media3;

import android.content.Context;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.annotation.Nullable;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import java.util.HashMap;
import java.util.Map;

/**
 * Hardware Media3 surface for direct HLS/DASH/progressive URLs.
 * GeckoView resolves embeds; this class renders the sniffed media URL.
 */
final class Media3PlayerController {
  interface Listener {
    void onState(String state, @Nullable String detail);
  }

  private final Context appContext;
  private final Handler main = new Handler(Looper.getMainLooper());
  private PlayerView view;
  private FrameLayout.LayoutParams layoutParams;
  private ExoPlayer player;
  private Listener listener;
  private String currentUrl = "";
  private boolean playing;

  Media3PlayerController(Context context) {
    this.appContext = context.getApplicationContext();
  }

  void setListener(@Nullable Listener listener) {
    this.listener = listener;
  }

  PlayerView getView() {
    return view;
  }

  FrameLayout.LayoutParams getLayoutParams() {
    return layoutParams;
  }

  void ensureAttached(FrameLayout parent) {
    if (view != null) return;
    view = new PlayerView(parent.getContext());
    view.setBackgroundColor(Color.BLACK);
    view.setUseController(false);
    view.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
    layoutParams =
      new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      );
    view.setLayoutParams(layoutParams);
    view.setVisibility(View.GONE);
    parent.addView(view);
  }

  void setLayoutParams(FrameLayout.LayoutParams lp) {
    layoutParams = lp;
    if (view != null) view.setLayoutParams(lp);
  }

  void setVisibility(int visibility) {
    if (view != null) view.setVisibility(visibility);
  }

  int getVisibility() {
    return view == null ? View.GONE : view.getVisibility();
  }

  void play(String url, @Nullable Map<String, String> headers, @Nullable String title) {
    if (view == null || url == null || url.isEmpty()) {
      emit("error", "Player not ready");
      return;
    }
    currentUrl = url;
    ensurePlayer();
    Map<String, String> hdrs = headers != null ? headers : new HashMap<>();
    DefaultHttpDataSource.Factory http =
      new DefaultHttpDataSource.Factory()
        .setAllowCrossProtocolRedirects(true)
        .setConnectTimeoutMs(15_000)
        .setReadTimeoutMs(20_000)
        .setUserAgent(
          hdrs.containsKey("User-Agent")
            ? hdrs.get("User-Agent")
            : "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36"
        );
    if (!hdrs.isEmpty()) {
      http.setDefaultRequestProperties(hdrs);
    }
    MediaItem.Builder item = new MediaItem.Builder().setUri(Uri.parse(url));
    if (title != null && !title.isEmpty()) {
      item.setMediaMetadata(
        new androidx.media3.common.MediaMetadata.Builder().setTitle(title).build()
      );
    }
    MediaSource source;
    String lower = url.toLowerCase();
    if (lower.contains(".m3u8") || lower.contains("format=m3u8") || lower.contains("/hls")) {
      source = new HlsMediaSource.Factory(http).createMediaSource(item.build());
    } else {
      source =
        new DefaultMediaSourceFactory(http).createMediaSource(item.build());
    }
    player.setMediaSource(source);
    player.prepare();
    player.setPlayWhenReady(true);
    view.setPlayer(player);
    setVisibility(View.VISIBLE);
    emit("loading", null);
  }

  void pause() {
    if (player != null) player.setPlayWhenReady(false);
  }

  void resume() {
    if (player != null) player.setPlayWhenReady(true);
  }

  void stop() {
    if (player != null) {
      try {
        player.stop();
        player.clearMediaItems();
      } catch (Throwable ignored) {}
    }
    playing = false;
    currentUrl = "";
    emit("idle", null);
  }

  void hide(boolean stopPlayback) {
    if (stopPlayback) stop();
    setVisibility(View.GONE);
  }

  void setVolume(float level) {
    if (player != null) {
      player.setVolume(Math.max(0f, Math.min(1f, level)));
    }
  }

  float getVolume() {
    return player != null ? player.getVolume() : 1f;
  }

  boolean isPlaying() {
    return playing && player != null && player.getPlayWhenReady();
  }

  String getCurrentUrl() {
    return currentUrl;
  }

  long getPositionMs() {
    return player != null ? Math.max(0, player.getCurrentPosition()) : 0;
  }

  void seekTo(long positionMs) {
    if (player != null) player.seekTo(Math.max(0, positionMs));
  }

  void destroy() {
    hide(true);
    if (player != null) {
      try {
        player.release();
      } catch (Throwable ignored) {}
      player = null;
    }
    if (view != null) {
      try {
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
      } catch (Throwable ignored) {}
      view = null;
    }
  }

  private void ensurePlayer() {
    if (player != null) return;
    player = new ExoPlayer.Builder(appContext).build();
    player.addListener(
      new Player.Listener() {
        @Override
        public void onPlaybackStateChanged(int state) {
          if (state == Player.STATE_BUFFERING) emit("buffering", null);
          else if (state == Player.STATE_READY) {
            playing = true;
            emit("playing", null);
          } else if (state == Player.STATE_ENDED) {
            playing = false;
            emit("ended", null);
          } else if (state == Player.STATE_IDLE) {
            playing = false;
            emit("idle", null);
          }
        }

        @Override
        public void onPlayerError(PlaybackException error) {
          playing = false;
          String msg = error != null ? error.getMessage() : "Playback error";
          emit("error", msg);
        }

        @Override
        public void onIsPlayingChanged(boolean isPlaying) {
          playing = isPlaying;
          if (isPlaying) emit("playing", null);
        }
      }
    );
  }

  private void emit(String state, @Nullable String detail) {
    Listener l = listener;
    if (l == null) return;
    main.post(() -> l.onState(state, detail));
  }
}
