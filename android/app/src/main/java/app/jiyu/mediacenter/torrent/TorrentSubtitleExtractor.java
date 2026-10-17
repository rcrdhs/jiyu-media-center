package app.jiyu.mediacenter.torrent;

import android.content.Context;
import android.util.Log;

import com.arthenica.ffmpegkit.FFmpegKit;
import com.arthenica.ffmpegkit.FFmpegSession;
import com.arthenica.ffmpegkit.ReturnCode;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pull English softsubs out of MULTI anime packs (ASS/SRT inside the MKV).
 * Remux strips subtitle tracks, so the player needs a separate VTT URL.
 */
final class TorrentSubtitleExtractor {
  private static final String TAG = "JiyuTorrentSubs";
  private static final Pattern SUB_STREAM = Pattern.compile(
    "Stream\\s+#\\d+:(\\d+)(?:\\(([^)]*)\\))?:\\s*Subtitle:\\s*(\\S+)",
    Pattern.CASE_INSENSITIVE
  );
  private static final Pattern TITLE_LINE = Pattern.compile(
    "^\\s*title\\s*:\\s*(.+)$",
    Pattern.CASE_INSENSITIVE
  );

  private TorrentSubtitleExtractor() {}

  static final class SubTrack {
    final int streamIndex;
    final int subtitleOrdinal;
    final String language;
    final String codec;
    final String title;
    final boolean isDefault;

    SubTrack(
      int streamIndex,
      int subtitleOrdinal,
      String language,
      String codec,
      String title,
      boolean isDefault
    ) {
      this.streamIndex = streamIndex;
      this.subtitleOrdinal = subtitleOrdinal;
      this.language = language != null ? language : "";
      this.codec = codec != null ? codec : "";
      this.title = title != null ? title : "";
      this.isDefault = isDefault;
    }
  }

  /** Convert a companion .srt/.ass/.vtt next to the video into {@code outVtt}. */
  static boolean convertCompanionFile(File companion, File outVtt) {
    if (companion == null || !companion.isFile() || companion.length() < 8 || outVtt == null) {
      return false;
    }
    try {
      String name = companion.getName().toLowerCase(Locale.US);
      if (name.endsWith(".vtt")) {
        return copyFile(companion, outVtt);
      }
      File parent = outVtt.getParentFile();
      if (parent != null && !parent.isDirectory() && !parent.mkdirs()) return false;
      if (outVtt.exists()) {
        //noinspection ResultOfMethodCallIgnored
        outVtt.delete();
      }
      String cmd =
        "-y -hide_banner -loglevel error -nostdin "
          + "-i " + quote(companion.getAbsolutePath()) + " "
          + "-f webvtt " + quote(outVtt.getAbsolutePath());
      FFmpegSession session = FFmpegKit.execute(cmd);
      if (!ReturnCode.isSuccess(session.getReturnCode())) {
        Log.w(TAG, "companion convert failed: " + session.getOutput());
        return false;
      }
      return outVtt.isFile() && outVtt.length() > 16;
    } catch (Throwable t) {
      Log.w(TAG, "companion convert failed", t);
      return false;
    }
  }

  static File findCompanionSubtitle(File videoFile) {
    if (videoFile == null) return null;
    File dir = videoFile.getParentFile();
    if (dir == null || !dir.isDirectory()) return null;
    String stem = videoFile.getName().replaceFirst("\\.[^.]+$", "").toLowerCase(Locale.US);
    File best = null;
    long bestScore = -1;
    File[] files = dir.listFiles();
    if (files == null) return null;
    for (File f : files) {
      if (!f.isFile()) continue;
      String n = f.getName().toLowerCase(Locale.US);
      if (!(n.endsWith(".srt") || n.endsWith(".ass") || n.endsWith(".ssa") || n.endsWith(".vtt"))) {
        continue;
      }
      long score = 0;
      if (n.startsWith(stem)) score += 100;
      if (n.contains("eng") || n.contains(".en.") || n.endsWith(".en.srt") || n.endsWith(".en.ass")) {
        score += 50;
      }
      if (n.contains("signs") || n.contains("forced")) score -= 40;
      score += Math.min(20, f.length() / 50_000);
      if (score > bestScore) {
        bestScore = score;
        best = f;
      }
    }
    return best;
  }

  /**
   * Probe + extract best English text softsub to {@code outVtt}.
   * Returns true when the VTT has cues.
   */
  static boolean extractBestEnglish(Context context, String rawUrl, File outVtt) {
    if (rawUrl == null || rawUrl.isEmpty() || outVtt == null) return false;
    try {
      List<SubTrack> tracks = probeSubtitleTracks(rawUrl);
      if (tracks.isEmpty()) {
        Log.i(TAG, "no subtitle tracks in " + rawUrl);
        return false;
      }
      SubTrack best = pickBestTextTrack(tracks);
      if (best == null) {
        Log.i(TAG, "no usable text softsub track");
        return false;
      }
      Log.i(
        TAG,
        "extracting s:" + best.subtitleOrdinal
          + " stream=" + best.streamIndex
          + " lang=" + best.language
          + " codec=" + best.codec
          + " title=" + best.title
      );

      File parent = outVtt.getParentFile();
      if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
        return false;
      }
      if (outVtt.exists()) {
        //noinspection ResultOfMethodCallIgnored
        outVtt.delete();
      }

      String cmd =
        "-y -hide_banner -loglevel error -nostdin "
          + "-probesize 32M -analyzeduration 20000000 "
          + "-i " + quote(rawUrl) + " "
          + "-map 0:" + best.streamIndex + " "
          + "-f webvtt " + quote(outVtt.getAbsolutePath());

      FFmpegSession session = FFmpegKit.execute(cmd);
      if (!ReturnCode.isSuccess(session.getReturnCode())) {
        Log.w(TAG, "extract failed: " + session.getOutput());
        return false;
      }
      if (!outVtt.isFile() || outVtt.length() < 16) {
        Log.w(TAG, "extract produced empty VTT");
        return false;
      }
      Log.i(TAG, "softsubs ready " + outVtt.length() + " bytes");
      return true;
    } catch (Throwable t) {
      Log.w(TAG, "extract failed", t);
      return false;
    }
  }

  private static List<SubTrack> probeSubtitleTracks(String rawUrl) {
    List<SubTrack> tracks = new ArrayList<>();
    try {
      String probeCmd =
        "-hide_banner -probesize 32M -analyzeduration 20000000 -i " + quote(rawUrl);
      FFmpegSession session = FFmpegKit.execute(probeCmd);
      String logs = session.getAllLogsAsString();
      if (logs == null || logs.isEmpty()) logs = session.getOutput();
      if (logs == null) return tracks;

      SubTrack current = null;
      int subtitleOrdinal = -1;
      for (String line : logs.split("\\r?\\n")) {
        Matcher stream = SUB_STREAM.matcher(line);
        if (stream.find()) {
          if (current != null) tracks.add(current);
          subtitleOrdinal += 1;
          int streamIndex = Integer.parseInt(stream.group(1));
          String lang = stream.group(2) != null ? stream.group(2).trim().toLowerCase(Locale.US) : "";
          String codec = stream.group(3) != null ? stream.group(3).trim().toLowerCase(Locale.US) : "";
          boolean isDefault = line.toLowerCase(Locale.US).contains("(default)");
          current = new SubTrack(streamIndex, subtitleOrdinal, lang, codec, "", isDefault);
          continue;
        }
        if (current != null) {
          Matcher title = TITLE_LINE.matcher(line);
          if (title.find()) {
            current = new SubTrack(
              current.streamIndex,
              current.subtitleOrdinal,
              current.language,
              current.codec,
              title.group(1).trim(),
              current.isDefault
            );
          }
        }
      }
      if (current != null) tracks.add(current);
    } catch (Throwable t) {
      Log.w(TAG, "subtitle probe failed", t);
    }
    return tracks;
  }

  private static SubTrack pickBestTextTrack(List<SubTrack> tracks) {
    SubTrack best = null;
    double bestScore = Double.NEGATIVE_INFINITY;
    for (SubTrack track : tracks) {
      double score = scoreSubtitleTrack(track);
      if (score > bestScore) {
        bestScore = score;
        best = track;
      }
    }
    return bestScore > 0 ? best : null;
  }

  private static double scoreSubtitleTrack(SubTrack track) {
    double score = 0;
    String lang = track.language;
    String title = track.title.toLowerCase(Locale.US);
    String codec = track.codec;

    if (isTextSubtitleCodec(codec)) score += 100;
    else if (isImageSubtitleCodec(codec)) score -= 200;
    else score += 10;

    if (lang.matches("^(eng?|en)$") || lang.startsWith("en")) score += 50;
    else if (lang.isEmpty() || lang.equals("und") || lang.equals("unknown")) score += 5;
    else if (lang.matches("^(jpn?|ja|chi|zho|kor|ko|spa|es|fre?|fr).*")) score -= 15;

    if (title.matches(".*\\b(full|dialogue|dialog|english)\\b.*")) score += 25;
    if (title.matches(".*\\b(signs?|songs?|forced|commentary)\\b.*")) score -= 40;
    if (title.matches(".*\\b(sdh|hearing\\s*impaired|cc)\\b.*")) score -= 20;
    if (track.isDefault) score += 8;
    score -= track.subtitleOrdinal * 0.1;
    return score;
  }

  private static boolean isTextSubtitleCodec(String codec) {
    String c = codec.toLowerCase(Locale.US);
    return c.contains("ass") || c.contains("ssa") || c.contains("subrip")
      || c.contains("srt") || c.contains("webvtt") || c.contains("mov_text")
      || c.contains("text");
  }

  private static boolean isImageSubtitleCodec(String codec) {
    String c = codec.toLowerCase(Locale.US);
    return c.contains("hdmv") || c.contains("pgs") || c.contains("dvd_subtitle")
      || c.contains("dvb_subtitle") || c.contains("xsub");
  }

  private static boolean copyFile(File from, File to) throws java.io.IOException {
    File parent = to.getParentFile();
    if (parent != null && !parent.isDirectory() && !parent.mkdirs()) return false;
    try (
      java.io.InputStream in = new java.io.FileInputStream(from);
      java.io.OutputStream out = new java.io.FileOutputStream(to)
    ) {
      byte[] buf = new byte[8192];
      int n;
      while ((n = in.read(buf)) >= 0) {
        if (n > 0) out.write(buf, 0, n);
      }
    }
    return to.isFile() && to.length() > 16;
  }

  private static String quote(String value) {
    return "\"" + value.replace("\"", "") + "\"";
  }
}
