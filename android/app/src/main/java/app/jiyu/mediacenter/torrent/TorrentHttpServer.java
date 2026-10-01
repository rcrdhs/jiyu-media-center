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
      if (!torrent.waitForBytes(0, 60_000)) {
        return newFixedLengthResponse(Response.Status.SERVICE_UNAVAILABLE, MIME_PLAINTEXT, "buffering");
      }
      RandomAccessFile raf = new RandomAccessFile(file, "r");
      return newFixedLengthResponse(Response.Status.OK, mime, new WaitingInputStream(torrent, raf, 0, total), total);
    } catch (Exception e) {
      Log.e(TAG, "serve failed", e);
      return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, e.getMessage());
    }
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

    cancelRemux();
    TorrentRemuxer.Job job;
    try {
      job = TorrentRemuxer.start(appContext, baseUrl() + "/stream/" + hash, startAt);
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
    return res;
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
    if (!torrent.waitForBytes(start, 90_000)) {
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
      if (!torrent.waitForRange(position, want, 90_000)) {
        throw new IOException("torrent piece timeout at " + position);
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
