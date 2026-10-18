package app.jiyu.mediacenter.torrent;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.util.HashMap;
import java.util.Map;

import fi.iki.elonen.NanoHTTPD;

/**
 * Local HTTP Range server so the WebView can play the active torrent file
 * while pieces are still arriving.
 */
final class TorrentHttpServer extends NanoHTTPD {
  private static final String TAG = "JiyuTorrentHttp";
  private final TorrentEngine engine;
  private final Context appContext;
  private TorrentRemuxer.Job remuxJob;

  TorrentHttpServer(TorrentEngine engine, Context appContext, int port) {
    super(port);
    this.engine = engine;
    this.appContext = appContext;
  }

  void cancelRemux() {
    TorrentRemuxer.Job job;
    synchronized (this) {
      job = remuxJob;
      remuxJob = null;
    }
    if (job != null) job.cancel();
  }

  String baseUrl() {
    return "http://127.0.0.1:" + getListeningPort();
  }

  @Override
  public Response serve(IHTTPSession session) {
    String uri = session.getUri();
    if (uri == null) {
      return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "not found");
    }
    if ("/stream.mp4".equals(uri)) {
      return serveRemux(session);
    }
    if ("/subs.vtt".equals(uri)) {
      return serveSubtitles(session);
    }
    if (!uri.startsWith("/stream/")) {
      return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "not found");
    }
    String hash = uri.substring("/stream/".length()).trim().toLowerCase();
    int slash = hash.indexOf('/');
    if (slash >= 0) hash = hash.substring(0, slash);
    int q = hash.indexOf('?');
    if (q >= 0) hash = hash.substring(0, q);

    TorrentEngine.ActiveTorrent torrent = engine.findByHash(hash);
    if (torrent == null || torrent.videoFile == null) {
      return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "torrent not active");
    }

    File file = torrent.videoFile;
    long total = torrent.length > 0 ? torrent.length : (file.exists() ? file.length() : 0);
    if (total <= 0) {
      return newFixedLengthResponse(Response.Status.SERVICE_UNAVAILABLE, MIME_PLAINTEXT, "file not ready");
    }

    String mime = guessMime(file.getName());
    String rangeHeader = session.getHeaders().get("range");
    if (rangeHeader == null) {
      rangeHeader = session.getHeaders().get("Range");
    }

    try {
      if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
        return serveRange(torrent, file, total, mime, rangeHeader);
      }
      // Full-body: wait for opening buffer then stream from 0
      if (!torrent.waitForRangeWhileProgressing(0, 1, 60_000)) {
        return newFixedLengthResponse(Response.Status.SERVICE_UNAVAILABLE, MIME_PLAINTEXT, "buffering");
      }
      RandomAccessFile raf = new RandomAccessFile(file, "r");
      return newFixedLengthResponse(Response.Status.OK, mime, new WaitingInputStream(torrent, raf, 0, total), total);
    } catch (Exception e) {
      Log.e(TAG, "serve failed", e);
      return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, e.getMessage());
    }
  }

  private Response serveSubtitles(IHTTPSession session) {
    String hash = firstParam(session, "source");
    if (hash == null || !hash.matches("[a-fA-F0-9]{20,64}")) {
      return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "missing torrent");
    }
    hash = hash.toLowerCase();
    TorrentEngine.ActiveTorrent torrent = engine.findByHash(hash);
    if (torrent == null) {
      return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "torrent not active");
    }
    torrent.kickSubtitleExtract(baseUrl());
    File vtt = torrent.readySubtitleVtt();
    if (vtt != null) {
      try {
        InputStream body = new java.io.FileInputStream(vtt);
        Response res = newFixedLengthResponse(
          Response.Status.OK,
          "text/vtt; charset=utf-8",
          body,
          vtt.length()
        );
        res.addHeader("Cache-Control", "no-store");
        res.addHeader("X-Jiyu-Subs-Done", "1");
        return withCors(res);
      } catch (IOException e) {
        Log.w(TAG, "serveSubtitles read failed", e);
        return withCors(newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "read failed"));
      }
    }
    // Progressive: serve the cues ffmpeg has flushed so far (done=0, player keeps polling).
    File partial = torrent.partialSubtitleVtt();
    if (partial != null) {
      String text = readCompleteCues(partial);
      if (text != null && text.contains("-->")) {
        Response res = newFixedLengthResponse(Response.Status.OK, "text/vtt; charset=utf-8", text);
        res.addHeader("Cache-Control", "no-store");
        res.addHeader("X-Jiyu-Subs-Done", "0");
        return withCors(res);
      }
    }
    if (torrent.subtitleMissing.get()) {
      return withCors(newFixedLengthResponse(
        Response.Status.NOT_FOUND,
        MIME_PLAINTEXT,
        "no subtitle track"
      ));
    }
    return withCors(newFixedLengthResponse(
      Response.Status.NOT_FOUND,
      MIME_PLAINTEXT,
      "not ready"
    ));
  }

  private Response serveRemux(IHTTPSession session) {
    String hash = firstParam(session, "source");
    if (hash == null || !hash.matches("[a-fA-F0-9]{20,64}")) {
      return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "missing torrent");
    }
    hash = hash.toLowerCase();
    TorrentEngine.ActiveTorrent torrent = engine.findByHash(hash);
    if (torrent == null) {
      return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "torrent not active");
    }

    double startAt = 0;
    String t = firstParam(session, "t");
    if (t != null) {
      try {
        startAt = Double.parseDouble(t);
      } catch (NumberFormatException ignored) {}
    }

    boolean preferJapanese =
      "1".equals(firstParam(session, "anime"))
        || "ja".equalsIgnoreCase(firstParam(session, "audio"))
        || "jpn".equalsIgnoreCase(firstParam(session, "audio"));

    cancelRemux();
    TorrentRemuxer.Job job;
    try {
      job = TorrentRemuxer.start(
        appContext,
        baseUrl() + "/stream/" + hash,
        startAt,
        preferJapanese
      );
    } catch (Throwable e) {
      Log.e(TAG, "remux failed to start", e);
      return withCors(newFixedLengthResponse(
        Response.Status.SERVICE_UNAVAILABLE,
        MIME_PLAINTEXT,
        e.getMessage() != null ? e.getMessage() : "remux failed"
      ));
    }
    synchronized (this) {
      remuxJob = job;
    }

    final TorrentRemuxer.Job bound = job;
    InputStream body = new InputStream() {
      private final InputStream in = bound.stream;

      @Override
      public int read() throws IOException {
        return in.read();
      }

      @Override
      public int read(byte[] b, int off, int len) throws IOException {
        return in.read(b, off, len);
      }

      @Override
      public void close() throws IOException {
        try {
          in.close();
        } finally {
          synchronized (TorrentHttpServer.this) {
            if (remuxJob == bound) remuxJob = null;
          }
          bound.cancel();
        }
      }
    };

    Response res = newChunkedResponse(Response.Status.OK, "video/mp4", body);
    res.addHeader("Cache-Control", "no-store");
    res.addHeader("Accept-Ranges", "none");
    return withCors(res);
  }

  private static Response withCors(Response res) {
    res.addHeader("Access-Control-Allow-Origin", "*");
    // Let the WebView read X-Jiyu-Subs-Done cross-origin (https://localhost -> 127.0.0.1).
    res.addHeader("Access-Control-Expose-Headers", "X-Jiyu-Subs-Done");
    return res;
  }

  /** Read a growing VTT and drop the trailing cue that ffmpeg may still be writing. */
  private static String readCompleteCues(File vtt) {
    try {
      long len = vtt.length();
      if (len <= 16 || len > 32L * 1024L * 1024L) return null;
      byte[] buf = new byte[(int) len];
      int read = 0;
      try (java.io.FileInputStream in = new java.io.FileInputStream(vtt)) {
        while (read < buf.length) {
          int n = in.read(buf, read, buf.length - read);
          if (n < 0) break;
          read += n;
        }
      }
      String text = new String(buf, 0, read, java.nio.charset.StandardCharsets.UTF_8).replace("\r\n", "\n");
      int cut = text.lastIndexOf("\n\n");
      if (cut <= 0) return null;
      return text.substring(0, cut + 2);
    } catch (Throwable t) {
      Log.w(TAG, "partial subtitles read failed", t);
      return null;
    }
  }

  private static String firstParam(IHTTPSession session, String name) {
    try {
      Map<String, String> parms = session.getParms();
      if (parms == null) return null;
      String value = parms.get(name);
      if (value == null || value.isEmpty()) return null;
      return value;
    } catch (Throwable t) {
      return null;
    }
  }

  private Response serveRange(
    TorrentEngine.ActiveTorrent torrent,
    File file,
    long total,
    String mime,
    String rangeHeader
  ) throws IOException {
    String spec = rangeHeader.substring("bytes=".length()).trim();
    long start;
    long end;
    if (spec.startsWith("-")) {
      long suffix = Long.parseLong(spec.substring(1));
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else {
      String[] parts = spec.split("-", 2);
      start = Long.parseLong(parts[0]);
      end = (parts.length > 1 && parts[1] != null && !parts[1].isEmpty())
        ? Long.parseLong(parts[1])
        : total - 1;
    }
    if (start < 0) start = 0;
    if (end >= total) end = total - 1;
    if (start > end) {
      Response r = newFixedLengthResponse(Response.Status.RANGE_NOT_SATISFIABLE, MIME_PLAINTEXT, "");
      r.addHeader("Content-Range", "bytes */" + total);
      return r;
    }

    long length = end - start + 1;
    // Seek support: prioritize & wait for the requested region
    torrent.setInterestedBytes(start);
    if (!torrent.waitForRangeWhileProgressing(start, 1, 90_000)) {
      return newFixedLengthResponse(Response.Status.SERVICE_UNAVAILABLE, MIME_PLAINTEXT, "seeking buffer");
    }

    RandomAccessFile raf = new RandomAccessFile(file, "r");
    raf.seek(start);
    Response res = newFixedLengthResponse(
      Response.Status.PARTIAL_CONTENT,
      mime,
      new WaitingInputStream(torrent, raf, start, length),
      length
    );
    res.addHeader("Accept-Ranges", "bytes");
    res.addHeader("Content-Range", "bytes " + start + "-" + end + "/" + total);
    res.addHeader("Content-Length", String.valueOf(length));
    return res;
  }

  private static String guessMime(String name) {
    String n = name == null ? "" : name.toLowerCase();
    if (n.endsWith(".mp4") || n.endsWith(".m4v")) return "video/mp4";
    if (n.endsWith(".webm")) return "video/webm";
    if (n.endsWith(".mkv")) return "video/x-matroska";
    if (n.endsWith(".ts") || n.endsWith(".m2ts")) return "video/mp2t";
    return "video/mp4";
  }

  /**
   * Reads from an incomplete torrent file, waiting for pieces as needed.
   */
  private static final class WaitingInputStream extends java.io.InputStream {
    private static final long STALL_TIMEOUT_MS = 180_000L;
    private final TorrentEngine.ActiveTorrent torrent;
    private final RandomAccessFile raf;
    private long remaining;
    private long position;

    WaitingInputStream(TorrentEngine.ActiveTorrent torrent, RandomAccessFile raf, long start, long length) {
      this.torrent = torrent;
      this.raf = raf;
      this.position = start;
      this.remaining = length;
    }

    @Override
    public int read() throws IOException {
      byte[] b = new byte[1];
      int n = read(b, 0, 1);
      return n < 0 ? -1 : (b[0] & 0xff);
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
      if (remaining <= 0) return -1;
      int want = (int) Math.min(len, remaining);
      // Keep the connection open while pieces keep arriving; only a removed torrent
      // or a swarm stalled for 3 minutes ends the body early (ffmpeg then reconnects
      // or the subtitle extract retries).
      if (!torrent.waitForRangeWhileProgressing(position, want, STALL_TIMEOUT_MS)) {
        throw new IOException("torrent stalled at " + position);
      }
      int n = raf.read(b, off, want);
      if (n < 0) return -1;
      position += n;
      remaining -= n;
      torrent.setInterestedBytes(position);
      return n;
    }

    @Override
    public void close() throws IOException {
      raf.close();
    }
  }
}
