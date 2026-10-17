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
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Same remux the desktop app runs: fragmented MP4, video copied, audio to AAC.
 * HEVC is copied too — this phone's decoder plays it inside MP4, and this
 * ffmpeg build has no H.264 encoder.
 *
 * MULTI packs often put French on a:0 — pick Japanese (anime) or English first.
 */
final class TorrentRemuxer {
  private static final String TAG = "JiyuRemux";
  private static final Pattern AUDIO_STREAM = Pattern.compile(
    "Stream\\s+#\\d+:(\\d+)(?:\\(([^)]*)\\))?:\\s*Audio:\\s*(\\S+)",
    Pattern.CASE_INSENSITIVE
  );
  private static final Pattern TITLE_LINE = Pattern.compile(
    "^\\s*title\\s*:\\s*(.+)$",
    Pattern.CASE_INSENSITIVE
  );
  /** Avoid re-probing on every Resume remux — cold probe was making Resume time out. */
  private static final java.util.Map<String, Integer> audioOrdinalCache =
    new java.util.concurrent.ConcurrentHashMap<>();

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

  private static final class AudioTrack {
    final int audioOrdinal;
    final String language;
    final String title;
    final boolean isDefault;

    AudioTrack(int audioOrdinal, String language, String title, boolean isDefault) {
      this.audioOrdinal = audioOrdinal;
      this.language = language != null ? language : "";
      this.title = title != null ? title : "";
      this.isDefault = isDefault;
    }
  }

  /**
   * Starts ffmpeg and blocks until the output pipe is open (header can flow).
   * {@code rawUrl} is the local torrent HTTP file. {@code startAt} is seconds.
   */
  static Job start(Context context, String rawUrl, double startAt, boolean preferJapanese)
    throws IOException {
    final String pipe = FFmpegKitConfig.registerNewFFmpegPipe(context);
    if (pipe == null || pipe.isEmpty()) {
      throw new IOException("Could not create remux pipe");
    }

    int audioOrdinal = preferJapanese
      ? probePreferredAudioOrdinal(rawUrl, true)
      : probePreferredAudioOrdinal(rawUrl, false);
    final String cmd = command(rawUrl, pipe, startAt, audioOrdinal);
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

  /** Probe media for audio tracks; return ordinal for -map 0:a:N. */
  private static int probePreferredAudioOrdinal(String rawUrl, boolean preferJapanese) {
    String cacheKey = (preferJapanese ? "ja|" : "en|") + rawUrl;
    Integer cached = audioOrdinalCache.get(cacheKey);
    if (cached != null) return cached;
    try {
      String probeCmd =
        "-hide_banner -probesize 2M -analyzeduration 2000000 -i " + quote(rawUrl);
      FFmpegSession session = FFmpegKit.execute(probeCmd);
      String logs = session.getAllLogsAsString();
      if (logs == null || logs.isEmpty()) logs = session.getOutput();
      List<AudioTrack> tracks = parseAudioTracks(logs != null ? logs : "");
      if (tracks.size() < 2) {
        audioOrdinalCache.put(cacheKey, 0);
        return 0;
      }
      AudioTrack best = null;
      double bestScore = Double.NEGATIVE_INFINITY;
      for (AudioTrack track : tracks) {
        double score = scoreAudioTrack(track, preferJapanese);
        if (score > bestScore) {
          bestScore = score;
          best = track;
        }
      }
      if (best != null) {
        int ordinal = Math.max(0, best.audioOrdinal);
        Log.i(
          TAG,
          "preferred audio a:" + ordinal
            + " lang=" + best.language
            + " title=" + best.title
            + " anime=" + preferJapanese
        );
        audioOrdinalCache.put(cacheKey, ordinal);
        return ordinal;
      }
    } catch (Throwable t) {
      Log.w(TAG, "audio probe failed", t);
    }
    return 0;
  }

  private static List<AudioTrack> parseAudioTracks(String logs) {
    List<AudioTrack> tracks = new ArrayList<>();
    String[] lines = logs.split("\\r?\\n");
    AudioTrack current = null;
    int audioOrdinal = -1;
    for (String line : lines) {
      Matcher stream = AUDIO_STREAM.matcher(line);
      if (stream.find()) {
        if (current != null) tracks.add(current);
        audioOrdinal += 1;
        String lang = stream.group(2) != null ? stream.group(2).trim().toLowerCase(Locale.US) : "";
        boolean isDefault = line.toLowerCase(Locale.US).contains("(default)");
        current = new AudioTrack(audioOrdinal, lang, "", isDefault);
        continue;
      }
      if (current != null) {
        Matcher title = TITLE_LINE.matcher(line);
        if (title.find()) {
          current = new AudioTrack(
            current.audioOrdinal,
            current.language,
            title.group(1).trim(),
            current.isDefault
          );
        }
      }
    }
    if (current != null) tracks.add(current);
    return tracks;
  }

  private static double scoreAudioTrack(AudioTrack track, boolean preferJapanese) {
    double score = 0;
    String lang = track.language;
    String title = track.title.toLowerCase(Locale.US);

    if (preferJapanese) {
      if (lang.matches("^(jpn?|ja)$") || lang.startsWith("ja")) score += 100;
      else if (lang.matches("^(eng?|en)$") || lang.startsWith("en")) score += 40;
      else if (lang.isEmpty() || lang.equals("und") || lang.equals("unknown")) score += 8;
      else if (lang.matches("^(fre?|fr|fra)$") || lang.startsWith("fr")) score -= 80;
      else score -= 35;
      if (title.matches(".*\\b(japanese|jap|jpn|nihongo)\\b.*")) score += 55;
      if (title.matches(".*\\b(english|eng)\\b.*")) score += 25;
    } else {
      if (lang.matches("^(eng?|en)$") || lang.startsWith("en")) score += 80;
      else if (lang.isEmpty() || lang.equals("und") || lang.equals("unknown")) score += 15;
      else if (lang.matches("^(fre?|fr|fra)$") || lang.startsWith("fr")) score -= 60;
      else if (lang.matches("^(spa|es|ger|de|deu|ita|jpn|ja|rus|hin).*")) score -= 40;
      if (title.matches(".*\\b(english|eng|original)\\b.*")) score += 40;
    }

    if (title.matches(".*\\b(french|français|francais|vff|vfq|truefrench|deutsch|german|latino)\\b.*")) {
      score -= 50;
    }
    if (title.matches(".*\\b(commentary|descriptive)\\b.*")) score -= 70;
    if (track.isDefault) score += preferJapanese ? 2 : 5;
    score -= track.audioOrdinal * 0.1;
    return score;
  }

  private static String command(String rawUrl, String pipe, double startAt, int audioOrdinal) {
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
    int a = Math.max(0, audioOrdinal);
    args.append("-map 0:v:0 -map \"0:a:").append(a).append("?\" ");
    args.append("-c:v copy -c:a aac -b:a 192k -ar 48000 -ac 2 ");
    args.append("-af aresample=first_pts=0 ");
    args.append("-avoid_negative_ts make_zero -max_muxing_queue_size 2048 -max_interleave_delta 0 ");
    args.append("-f mp4 -movflags frag_keyframe+empty_moov+default_base_moof ");
    args.append(quote(pipe));
    return args.toString();
  }

  private static String formatSeconds(double seconds) {
    return String.format(Locale.US, "%.3f", Math.max(0, seconds));
  }

  private static String quote(String value) {
    return "\"" + value.replace("\"", "") + "\"";
  }
}
