package app.jiyu.mediacenter.torrent;

import android.content.Context;
import android.util.Log;

import com.arthenica.ffmpegkit.FFmpegKit;
import com.arthenica.ffmpegkit.FFmpegKitConfig;
import com.arthenica.ffmpegkit.FFmpegSession;
import com.arthenica.ffmpegkit.ReturnCode;
import com.arthenica.ffmpegkit.SessionState;

import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Same remux the desktop app runs: fragmented MP4, video copied, audio to AAC.
 * HEVC is copied too — this phone's decoder plays it inside MP4, and this
 * ffmpeg build has no H.264 encoder.
 */
final class TorrentRemuxer {
  private static final String TAG = "JiyuRemux";

  static final class Job {
    final long sessionId;
    final String pipe;
    final InputStream stream;

    Job(long sessionId, String pipe, InputStream stream) {
      this.sessionId = sessionId;
      this.pipe = pipe;
      this.stream = stream;
    }

    void cancel() {
      try {
        FFmpegKit.cancel(sessionId);
      } catch (Throwable ignored) {}
      try {
        if (stream != null) stream.close();
      } catch (Throwable ignored) {}
      try {
        FFmpegKitConfig.closeFFmpegPipe(pipe);
      } catch (Throwable ignored) {}
    }
  }

  /**
   * Starts ffmpeg and blocks until the output pipe is open (header can flow).
   * {@code rawUrl} is the local torrent HTTP file. {@code startAt} is seconds.
   */
  static Job start(Context context, String rawUrl, double startAt) throws IOException {
    final String pipe = FFmpegKitConfig.registerNewFFmpegPipe(context);
    if (pipe == null || pipe.isEmpty()) {
      throw new IOException("Could not create remux pipe");
    }

    final String cmd = command(rawUrl, pipe, startAt);
    Log.i(TAG, cmd);

    final InputStream[] opened = new InputStream[1];
    final IOException[] openError = new IOException[1];
    Thread opener = new Thread(() -> {
      try {
        opened[0] = new FileInputStream(pipe);
      } catch (IOException e) {
        openError[0] = e;
      }
    }, "jiyu-remux-open");
    opener.start();

    FFmpegSession session = FFmpegKit.executeAsync(cmd, completed -> {
      ReturnCode code = completed.getReturnCode();
      if (ReturnCode.isSuccess(code) || ReturnCode.isCancel(code)) {
        Log.i(TAG, "ffmpeg finished " + code);
      } else {
        Log.w(TAG, "ffmpeg failed " + code + " " + completed.getOutput());
      }
    }, log -> {
      String message = log.getMessage();
      if (message != null && !message.isEmpty()) Log.i(TAG, message);
    }, null);

    long deadline = System.currentTimeMillis() + 45_000;
    try {
      while (opened[0] == null && openError[0] == null && System.currentTimeMillis() < deadline) {
        SessionState state = session.getState();
        if (state == SessionState.COMPLETED || state == SessionState.FAILED) break;
        opener.join(250);
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      FFmpegKit.cancel(session.getSessionId());
      FFmpegKitConfig.closeFFmpegPipe(pipe);
      throw new IOException("Remux interrupted");
    }

    if (opened[0] == null) {
      FFmpegKit.cancel(session.getSessionId());
      try {
        FFmpegKitConfig.closeFFmpegPipe(pipe);
      } catch (Throwable ignored) {}
      try {
        opener.join(2000);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
      if (openError[0] != null) throw openError[0];
      String output = session.getOutput();
      throw new IOException(output != null && !output.isEmpty() ? output : "Remux did not start");
    }

    return new Job(session.getSessionId(), pipe, opened[0]);
  }

  private static String command(String rawUrl, String pipe, double startAt) {
    StringBuilder args = new StringBuilder();
    // -y: the pipe file is created first. ffmpeg exits if that path already exists.
    args.append("-y -hide_banner -loglevel warning -nostdin ");
    args.append("-fflags +genpts+igndts -probesize 1M -analyzeduration 1000000 ");
    if (startAt >= 1) {
      // Coarse input seek, then a short output seek, matching the desktop pipe.
      double coarse = Math.max(0, startAt - 3);
      if (coarse >= 1) {
        args.append("-ss ").append(formatSeconds(coarse)).append(' ');
      }
      args.append("-i ").append(quote(rawUrl)).append(' ');
      args.append("-ss ").append(formatSeconds(startAt - coarse)).append(' ');
    } else {
      args.append("-i ").append(quote(rawUrl)).append(' ');
    }
    // Optional audio map: a video-only file should still remux.
    args.append("-map 0:v:0 -map \"0:a:0?\" ");
    args.append("-c:v copy -c:a aac -b:a 192k -ar 48000 -ac 2 ");
    args.append("-af aresample=first_pts=0 ");
    args.append("-avoid_negative_ts make_zero -max_muxing_queue_size 2048 -max_interleave_delta 0 ");
    args.append("-f mp4 -movflags frag_keyframe+empty_moov+default_base_moof ");
    args.append(quote(pipe));
    return args.toString();
  }

  private static String formatSeconds(double seconds) {
    return String.format(java.util.Locale.US, "%.3f", Math.max(0, seconds));
  }

  private static String quote(String value) {
    return "\"" + value.replace("\"", "") + "\"";
  }
}
