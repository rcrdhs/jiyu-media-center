package app.jiyu.mediacenter.torrent;

import android.content.Context;
import android.util.Log;

import org.libtorrent4j.AlertListener;
import org.libtorrent4j.FileStorage;
import org.libtorrent4j.Priority;
import org.libtorrent4j.SessionManager;
import org.libtorrent4j.SessionParams;
import org.libtorrent4j.SettingsPack;
import org.libtorrent4j.TorrentFlags;
import org.libtorrent4j.TorrentHandle;
import org.libtorrent4j.TorrentInfo;
import org.libtorrent4j.TorrentStatus;
import org.libtorrent4j.alerts.Alert;
import org.libtorrent4j.alerts.AlertType;
import org.libtorrent4j.alerts.PieceFinishedAlert;
import org.libtorrent4j.swig.settings_pack;
import org.libtorrent4j.swig.torrent_flags_t;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * libtorrent4j session + sequential download of the chosen video file,
 * exposed over a local HTTP Range server for the Capacitor WebView.
 */
public final class TorrentEngine {
  private static final String TAG = "JiyuTorrent";
  private static final long PREPARE_BYTES = 12L * 1024L * 1024L;
  private static final int MAGNET_TIMEOUT_SEC = 60;
  private static final int READY_TIMEOUT_SEC = 180;
  /** Unfinished downloads are removed after this long. Finished ones go immediately. */
  private static final long PARTIAL_TTL_MS = 3L * 60L * 60L * 1000L;

  private static TorrentEngine instance;

  private final Context appContext;
  private final SessionManager session;
  private final Map<String, ActiveTorrent> active = new ConcurrentHashMap<>();
  private TorrentHttpServer httpServer;
  private final Object sessionLock = new Object();
  private final ScheduledExecutorService sweeper = Executors.newSingleThreadScheduledExecutor(r -> {
    Thread t = new Thread(r, "jiyu-torrent-sweep");
    t.setDaemon(true);
    return t;
  });

  public static synchronized TorrentEngine get(Context context) {
    if (instance == null) {
      instance = new TorrentEngine(context.getApplicationContext());
    }
    return instance;
  }

  private TorrentEngine(Context context) {
    this.appContext = context;
    this.session = new SessionManager();
    SettingsPack pack = new SettingsPack()
      .connectionsLimit(200)
      .activeDownloads(8)
      .activeSeeds(8)
      .activeLimit(16)
      .anonymousMode(false);
    pack.setBoolean(settings_pack.bool_types.enable_dht.swigValue(), true);
    pack.setBoolean(settings_pack.bool_types.enable_lsd.swigValue(), true);
    pack.setBoolean(settings_pack.bool_types.enable_upnp.swigValue(), true);
    pack.setBoolean(settings_pack.bool_types.enable_natpmp.swigValue(), true);
    session.start(new SessionParams(pack));
    try {
      session.startDht();
    } catch (Throwable t) {
      Log.w(TAG, "DHT start failed", t);
    }
    sweeper.execute(this::sweepStaleDownloads);
    sweeper.scheduleAtFixedRate(this::sweepStaleDownloads, 15, 15, TimeUnit.MINUTES);
  }

  public synchronized StreamResult stream(
    String uri,
    boolean keepOthers,
    Integer fileIndex,
    String fileNameHint
  ) {
    if (uri == null || uri.trim().isEmpty()) {
      return StreamResult.fail("Missing torrent URI");
    }
    String trimmed = uri.trim();

    ensureHttpServer();

    if (!keepOthers) {
      stopAllExcept(null);
    }

    try {
      TorrentInfo info = resolveTorrentInfo(trimmed);
      if (info == null) {
        return StreamResult.fail("Could not fetch torrent metadata (no peers / timed out)");
      }

      String hash = info.infoHash().toHex().toLowerCase(Locale.US);
      ActiveTorrent existing = active.get(hash);
      if (existing != null && existing.videoFile != null && existing.videoFile.exists()) {
        existing.touch();
        return StreamResult.ok(existing, httpServer.baseUrl());
      }

      if (!keepOthers) {
        stopAllExcept(hash);
      }

      File saveDir = new File(appContext.getCacheDir(), "torrents/" + hash);
      if (!saveDir.isDirectory() && !saveDir.mkdirs()) {
        return StreamResult.fail("Could not create torrent cache directory");
      }

      int selected = pickVideoFile(info, fileIndex, fileNameHint);
      if (selected < 0) {
        return StreamResult.fail("No playable video file in torrent");
      }

      Priority[] priorities = new Priority[info.numFiles()];
      Arrays.fill(priorities, Priority.IGNORE);
      priorities[selected] = Priority.DEFAULT;

      torrent_flags_t flags = TorrentFlags.SEQUENTIAL_DOWNLOAD;
      session.download(info, saveDir, null, priorities, null, flags);

      TorrentHandle handle = waitForHandle(info, 20);
      if (handle == null || !handle.isValid()) {
        return StreamResult.fail("Torrent failed to start");
      }

      prioritizeOpening(handle, selected);

      File videoFile = new File(saveDir, info.files().filePath(selected));
      String displayName = torrentDisplayName(info, selected, trimmed);
      ActiveTorrent slot = new ActiveTorrent(hash, displayName, handle, selected, videoFile, info.files().fileSize(selected));
      active.put(hash, slot);
      session.addListener(slot);

      boolean ready = waitUntilReady(slot, READY_TIMEOUT_SEC);
      if (!ready) {
        TorrentStatus st = handle.status();
        int peers = st != null ? st.numPeers() : 0;
        stop(hash);
        if (peers <= 0) {
          return StreamResult.fail("No peers — swarm may be dead");
        }
        return StreamResult.fail("Torrent took too long to buffer");
      }

      return StreamResult.ok(slot, httpServer.baseUrl());
    } catch (Exception e) {
      Log.e(TAG, "stream failed", e);
      return StreamResult.fail(e.getMessage() != null ? e.getMessage() : "Torrent engine error");
    }
  }

  public synchronized boolean stop(String infoHash) {
    if (infoHash == null || infoHash.isEmpty()) {
      stopAllExcept(null);
      return true;
    }
    String key = infoHash.toLowerCase(Locale.US);
    ActiveTorrent slot = active.remove(key);
    if (slot == null) return true;
    removeSlot(slot);
    return true;
  }

  public List<StatusRow> status(String infoHash) {
    List<StatusRow> rows = new ArrayList<>();
    if (infoHash != null && !infoHash.isEmpty()) {
      ActiveTorrent slot = active.get(infoHash.toLowerCase(Locale.US));
      if (slot != null) rows.add(slot.toStatus());
      return rows;
    }
    for (ActiveTorrent slot : active.values()) {
      rows.add(slot.toStatus());
    }
    return rows;
  }

  public synchronized boolean ensureDownloading(String infoHash, Double playheadSec, Double runtimeSec) {
    ActiveTorrent slot = active.get(infoHash == null ? "" : infoHash.toLowerCase(Locale.US));
    if (slot == null || slot.handle == null || !slot.handle.isValid()) return false;
    try {
      slot.handle.resume();
      noteIfComplete(slot);
      if (playheadSec != null && runtimeSec != null && runtimeSec > 0 && slot.length > 0) {
        double ratio = Math.max(0, Math.min(1, playheadSec / runtimeSec));
        long byteOffset = (long) (slot.length * ratio);
        slot.setInterestedBytes(byteOffset);
      }
      return true;
    } catch (Throwable t) {
      Log.w(TAG, "ensureDownloading failed", t);
      return false;
    }
  }

  ActiveTorrent findByHash(String hash) {
    return active.get(hash.toLowerCase(Locale.US));
  }

  private void ensureHttpServer() {
    if (httpServer != null) return;
    try {
      httpServer = new TorrentHttpServer(this, appContext, 0);
      // No socket read timeout — a remux pipe stays open for the whole title.
      httpServer.start(0, true);
      Log.i(TAG, "HTTP stream server on port " + httpServer.getListeningPort());
    } catch (IOException e) {
      throw new IllegalStateException("Could not start torrent HTTP server", e);
    }
  }

  private void stopAllExcept(String keepHash) {
    List<String> keys = new ArrayList<>(active.keySet());
    for (String key : keys) {
      if (keepHash != null && key.equalsIgnoreCase(keepHash)) continue;
      ActiveTorrent slot = active.remove(key);
      if (slot != null) removeSlot(slot);
    }
  }

  private void removeSlot(ActiveTorrent slot) {
    try {
      if (httpServer != null) httpServer.cancelRemux();
    } catch (Throwable ignored) {}
    boolean complete = false;
    long downloaded = 0;
    try {
      if (slot.handle != null && slot.handle.isValid()) {
        TorrentStatus st = slot.handle.status();
        if (st != null) {
          downloaded = st.totalDone();
          complete = st.progress() >= 0.999f;
        }
      }
    } catch (Throwable ignored) {}
    try {
      session.removeListener(slot);
    } catch (Throwable ignored) {}
    try {
      if (slot.handle != null && slot.handle.isValid()) {
        session.remove(slot.handle);
      }
    } catch (Throwable t) {
      Log.w(TAG, "remove torrent failed", t);
    }
    File dir = torrentDir(slot.infoHash);
    if (complete || downloaded <= 0) {
      deleteTree(dir);
      Log.i(TAG, "deleted torrent download " + slot.infoHash);
    } else {
      writePartialMarker(dir);
    }
  }

  private void noteIfComplete(ActiveTorrent slot) {
    try {
      if (slot.handle == null || !slot.handle.isValid()) return;
      TorrentStatus st = slot.handle.status();
      if (st == null || st.progress() < 0.999f) return;
      File marker = new File(torrentDir(slot.infoHash), ".jiyu-complete");
      if (!marker.exists()) marker.createNewFile();
    } catch (Throwable t) {
      Log.w(TAG, "noteIfComplete", t);
    }
  }

  private File torrentDir(String infoHash) {
    String hash = infoHash == null ? "" : infoHash.toLowerCase(Locale.US);
    return new File(new File(appContext.getCacheDir(), "torrents"), hash);
  }

  private void writePartialMarker(File dir) {
    if (dir == null || !dir.isDirectory()) return;
    File marker = new File(dir, ".jiyu-partial");
    long expires = System.currentTimeMillis() + PARTIAL_TTL_MS;
    try (FileOutputStream out = new FileOutputStream(marker)) {
      out.write(Long.toString(expires).getBytes(StandardCharsets.UTF_8));
    } catch (Throwable t) {
      Log.w(TAG, "writePartialMarker", t);
    }
  }

  private void sweepStaleDownloads() {
    File root = new File(appContext.getCacheDir(), "torrents");
    File[] dirs = root.listFiles();
    if (dirs == null) return;
    long now = System.currentTimeMillis();
    for (File dir : dirs) {
      if (!dir.isDirectory()) continue;
      if (active.containsKey(dir.getName().toLowerCase(Locale.US))) continue;
      File complete = new File(dir, ".jiyu-complete");
      if (complete.exists()) {
        deleteTree(dir);
        continue;
      }
      File partial = new File(dir, ".jiyu-partial");
      long expires = 0;
      if (partial.isFile()) {
        try (FileInputStream in = new FileInputStream(partial)) {
          byte[] buf = new byte[(int) Math.min(32, partial.length())];
          int n = in.read(buf);
          if (n > 0) {
            expires = Long.parseLong(new String(buf, 0, n, StandardCharsets.UTF_8).trim());
          }
        } catch (Throwable ignored) {
          expires = 0;
        }
      }
      if ((expires > 0 && now >= expires) || (expires == 0 && now - dir.lastModified() >= PARTIAL_TTL_MS)) {
        deleteTree(dir);
        Log.i(TAG, "removed unfinished torrent " + dir.getName());
      }
    }
  }

  private static void deleteTree(File file) {
    if (file == null || !file.exists()) return;
    if (file.isDirectory()) {
      File[] kids = file.listFiles();
      if (kids != null) {
        for (File kid : kids) deleteTree(kid);
      }
    }
    if (!file.delete()) Log.w(TAG, "could not delete " + file.getAbsolutePath());
  }

  private TorrentInfo resolveTorrentInfo(String uri) throws Exception {
    if (uri.regionMatches(true, 0, "magnet:", 0, 7)) {
      File temp = new File(appContext.getCacheDir(), "torrent-meta");
      if (!temp.isDirectory() && !temp.mkdirs()) {
        throw new IOException("meta cache mkdir failed");
      }
      byte[] data = session.fetchMagnet(uri, MAGNET_TIMEOUT_SEC, temp);
      if (data == null || data.length == 0) return null;
      return TorrentInfo.bdecode(data);
    }
    if (uri.regionMatches(true, 0, "http://", 0, 7) || uri.regionMatches(true, 0, "https://", 0, 8)) {
      byte[] bytes = downloadBytes(uri);
      if (bytes.length == 0) return null;
      return TorrentInfo.bdecode(bytes);
    }
    if (uri.regionMatches(true, 0, "file:", 0, 5)) {
      File file = new File(android.net.Uri.parse(uri).getPath());
      try (FileInputStream in = new FileInputStream(file)) {
        return TorrentInfo.bdecode(readAll(in));
      }
    }
    // Raw .torrent path
    File local = new File(uri);
    if (local.isFile()) {
      try (FileInputStream in = new FileInputStream(local)) {
        return TorrentInfo.bdecode(readAll(in));
      }
    }
    throw new IllegalArgumentException("Unsupported torrent URI");
  }

  private static byte[] downloadBytes(String urlStr) throws IOException {
    HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
    conn.setInstanceFollowRedirects(true);
    conn.setConnectTimeout(20_000);
    conn.setReadTimeout(30_000);
    conn.connect();
    try (InputStream in = conn.getInputStream()) {
      return readAll(in);
    } finally {
      conn.disconnect();
    }
  }

  private static byte[] readAll(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
    return out.toByteArray();
  }

  private static String torrentDisplayName(TorrentInfo info, int fileIndex, String uri) {
    String name = info.name();
    if (name != null && !name.trim().isEmpty()) return name.trim();
    FileStorage files = info.files();
    if (fileIndex >= 0 && fileIndex < files.numFiles()) {
      String fn = files.fileName(fileIndex);
      int slash = Math.max(fn.lastIndexOf('/'), fn.lastIndexOf('\\'));
      if (slash >= 0) fn = fn.substring(slash + 1);
      int dot = fn.lastIndexOf('.');
      if (dot > 0) fn = fn.substring(0, dot);
      if (!fn.isEmpty()) return fn;
    }
    if (uri != null && uri.regionMatches(true, 0, "magnet:", 0, 7)) {
      try {
        for (String part : uri.split("&")) {
          if (part.regionMatches(true, 0, "dn=", 0, 3)) {
            String dn = URLDecoder.decode(part.substring(3), "UTF-8");
            if (dn != null && !dn.trim().isEmpty()) return dn.trim();
          }
        }
      } catch (Throwable ignored) {}
    }
    return info.infoHash().toHex();
  }

  private static int pickVideoFile(TorrentInfo info, Integer fileIndex, String fileNameHint) {
    FileStorage files = info.files();
    if (fileIndex != null && fileIndex >= 0 && fileIndex < files.numFiles()) {
      return fileIndex;
    }
    if (fileNameHint != null && !fileNameHint.isEmpty()) {
      String hint = fileNameHint.toLowerCase(Locale.US);
      for (int i = 0; i < files.numFiles(); i++) {
        String name = files.fileName(i).toLowerCase(Locale.US);
        if (name.equals(hint) || name.endsWith(hint) || name.contains(hint)) {
          if (isVideoName(name)) return i;
        }
      }
    }
    long best = -1;
    int bestIdx = -1;
    for (int i = 0; i < files.numFiles(); i++) {
      String name = files.fileName(i);
      if (!isVideoName(name)) continue;
      long size = files.fileSize(i);
      if (size > best) {
        best = size;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) return bestIdx;
    // Fallback: largest file
    for (int i = 0; i < files.numFiles(); i++) {
      long size = files.fileSize(i);
      if (size > best) {
        best = size;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  private static boolean isVideoName(String name) {
    String n = name.toLowerCase(Locale.US);
    return n.endsWith(".mp4") || n.endsWith(".mkv") || n.endsWith(".webm")
      || n.endsWith(".avi") || n.endsWith(".mov") || n.endsWith(".m4v")
      || n.endsWith(".ts") || n.endsWith(".m2ts") || n.endsWith(".wmv");
  }

  private TorrentHandle waitForHandle(TorrentInfo info, int timeoutSec) throws InterruptedException {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSec);
    while (System.nanoTime() < deadline) {
      TorrentHandle h = session.find(info.infoHash());
      if (h != null && h.isValid()) {
        try {
          h.resume();
        } catch (Throwable ignored) {}
        return h;
      }
      Thread.sleep(200);
    }
    return session.find(info.infoHash());
  }

  private void prioritizeOpening(TorrentHandle handle, int fileIndex) {
    try {
      TorrentInfo ti = handle.torrentFile();
      if (ti == null) return;
      FileStorage fs = ti.files();
      long fileSize = fs.fileSize(fileIndex);
      long fileOffset = fs.fileOffset(fileIndex);
      int pieceLength = ti.pieceLength();
      if (pieceLength <= 0) return;

      int firstPiece = (int) (fileOffset / pieceLength);
      int lastPiece = (int) ((fileOffset + fileSize - 1) / pieceLength);
      int preparePieces = (int) Math.max(2, Math.min(20, PREPARE_BYTES / pieceLength));

      for (int i = firstPiece; i <= lastPiece; i++) {
        handle.piecePriority(i, Priority.IGNORE);
      }
      for (int i = 0; i < preparePieces && firstPiece + i <= lastPiece; i++) {
        int p = firstPiece + i;
        handle.piecePriority(p, Priority.TOP_PRIORITY);
        handle.setPieceDeadline(p, 1000);
      }
      for (int i = 0; i < Math.min(2, preparePieces) && lastPiece - i >= firstPiece; i++) {
        int p = lastPiece - i;
        handle.piecePriority(p, Priority.TOP_PRIORITY);
        handle.setPieceDeadline(p, 1500);
      }
      handle.setFlags(handle.getFlags().or_(TorrentFlags.SEQUENTIAL_DOWNLOAD));
      handle.resume();
    } catch (Throwable t) {
      Log.w(TAG, "prioritizeOpening failed", t);
    }
  }

  private boolean waitUntilReady(ActiveTorrent slot, int timeoutSec) throws InterruptedException {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSec);
    while (System.nanoTime() < deadline) {
      if (slot.isPrepared()) return true;
      if (!slot.handle.isValid()) return false;
      Thread.sleep(250);
    }
    return slot.isPrepared();
  }

  static final class StreamResult {
    final boolean ok;
    final String error;
    final ActiveTorrent torrent;
    final String baseUrl;

    private StreamResult(boolean ok, String error, ActiveTorrent torrent, String baseUrl) {
      this.ok = ok;
      this.error = error;
      this.torrent = torrent;
      this.baseUrl = baseUrl;
    }

    static StreamResult ok(ActiveTorrent t, String baseUrl) {
      return new StreamResult(true, null, t, baseUrl);
    }

    static StreamResult fail(String error) {
      return new StreamResult(false, error, null, null);
    }

    String playUrl() {
      if (torrent == null || baseUrl == null) return null;
      // Player treats ?source= as a remux pipe (ffmpeg -ss resume, longer start budget).
      return baseUrl + "/stream.mp4?source=" + torrent.infoHash;
    }
  }

  static final class StatusRow {
    final String infoHash;
    final String name;
    final double progress;
    final double downloadSpeed;
    final int numPeers;
    final long downloaded;
    final long length;

    StatusRow(String infoHash, String name, double progress, double downloadSpeed, int numPeers, long downloaded, long length) {
      this.infoHash = infoHash;
      this.name = name;
      this.progress = progress;
      this.downloadSpeed = downloadSpeed;
      this.numPeers = numPeers;
      this.downloaded = downloaded;
      this.length = length;
    }
  }

  final class ActiveTorrent implements AlertListener {
    final String infoHash;
    final String name;
    final TorrentHandle handle;
    final int fileIndex;
    final File videoFile;
    final long length;
    /** Byte offset of this file inside the torrent, for piece mapping. */
    long torrentByteOffset;
    final AtomicBoolean prepared = new AtomicBoolean(false);
    final Object pieceLock = new Object();
    boolean[] havePieces;
    int firstPiece;
    int lastPiece;
    int prepareCount;
    volatile long lastTouch = System.currentTimeMillis();

    ActiveTorrent(String infoHash, String name, TorrentHandle handle, int fileIndex, File videoFile, long length) {
      this.infoHash = infoHash;
      this.name = name != null ? name : infoHash;
      this.handle = handle;
      this.fileIndex = fileIndex;
      this.videoFile = videoFile;
      this.length = length;
      initPieceWindow();
    }

    void touch() {
      lastTouch = System.currentTimeMillis();
    }

    boolean isPrepared() {
      return prepared.get();
    }

    private void initPieceWindow() {
      try {
        TorrentInfo ti = handle.torrentFile();
        if (ti == null) return;
        FileStorage fs = ti.files();
        torrentByteOffset = fs.fileOffset(fileIndex);
        int pieceLength = ti.pieceLength();
        firstPiece = (int) (torrentByteOffset / pieceLength);
        lastPiece = (int) ((torrentByteOffset + length - 1) / pieceLength);
        prepareCount = (int) Math.max(2, Math.min(20, PREPARE_BYTES / Math.max(1, pieceLength)));
        havePieces = new boolean[lastPiece - firstPiece + 1];
        for (int p = firstPiece; p <= lastPiece; p++) {
          if (handle.havePiece(p)) havePieces[p - firstPiece] = true;
        }
      } catch (Throwable t) {
        Log.w(TAG, "initPieceWindow", t);
      }
    }

    int pieceForFileByte(long fileByteOffset) {
      TorrentInfo ti = handle.torrentFile();
      int pieceLength = ti != null ? ti.pieceLength() : 0;
      if (pieceLength <= 0) return firstPiece;
      long abs = torrentByteOffset + Math.max(0, fileByteOffset);
      return (int) (abs / pieceLength);
    }

    boolean hasBytes(long fileByteOffset) {
      int piece = pieceForFileByte(fileByteOffset);
      try {
        if (handle != null && handle.isValid() && handle.havePiece(piece)) return true;
      } catch (Throwable ignored) {}
      if (havePieces == null) return false;
      int local = piece - firstPiece;
      if (local < 0 || local >= havePieces.length) return false;
      return havePieces[local];
    }

    void setInterestedBytes(long fileByteOffset) {
      try {
        TorrentInfo ti = handle.torrentFile();
        if (ti == null) return;
        int global = pieceForFileByte(fileByteOffset);
        for (int i = 0; i < 24; i++) {
          int p = global + i;
          if (p > lastPiece) break;
          handle.piecePriority(p, Priority.TOP_PRIORITY);
          handle.setPieceDeadline(p, 1000 + i * 50);
        }
        // Keep a longer runway at DEFAULT so sequential doesn't stall mid-file.
        for (int i = 24; i < 64; i++) {
          int p = global + i;
          if (p > lastPiece) break;
          handle.piecePriority(p, Priority.DEFAULT);
        }
      } catch (Throwable t) {
        Log.w(TAG, "setInterestedBytes", t);
      }
    }

    boolean waitForBytes(long fileByteOffset, long timeoutMs) {
      return waitForRange(fileByteOffset, 1, timeoutMs);
    }

    /**
     * libtorrent sparse files report their full size while unread pieces are
     * still zeros. File.length() is not proof the bytes exist.
     */
    boolean waitForRange(long fileByteOffset, int count, long timeoutMs) {
      long end = fileByteOffset + Math.max(0, count - 1);
      long deadline = System.currentTimeMillis() + timeoutMs;
      setInterestedBytes(fileByteOffset);
      while (System.currentTimeMillis() < deadline) {
        if (hasBytes(fileByteOffset) && hasBytes(end)) return true;
        synchronized (pieceLock) {
          try {
            pieceLock.wait(200);
          } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
          }
        }
      }
      return hasBytes(fileByteOffset) && hasBytes(end);
    }

    StatusRow toStatus() {
      double progress = 0;
      double speed = 0;
      int peers = 0;
      long downloaded = 0;
      try {
        TorrentStatus st = handle.status();
        if (st != null) {
          progress = st.progress();
          speed = st.downloadPayloadRate();
          peers = st.numPeers();
          downloaded = st.totalDone();
        }
      } catch (Throwable ignored) {}
      return new StatusRow(infoHash, name, progress, speed, peers, downloaded, length);
    }

    private void markPiece(int pieceIndex) {
      if (havePieces == null) return;
      int local = pieceIndex - firstPiece;
      if (local < 0 || local >= havePieces.length) return;
      havePieces[local] = true;
      noteIfComplete(this);
      int needed = Math.min(prepareCount, havePieces.length);
      boolean ready = true;
      for (int i = 0; i < needed; i++) {
        if (!havePieces[i]) {
          ready = false;
          break;
        }
      }
      if (ready) {
        prepared.set(true);
        try {
          // After the opening buffer, download the rest of the file (not IGNORE).
          // Previously only ~8 pieces past prepare were prioritized — mid-movie starved.
          for (int i = firstPiece + prepareCount; i <= lastPiece; i++) {
            handle.piecePriority(i, Priority.DEFAULT);
          }
          int ahead = Math.min(24, Math.max(8, prepareCount));
          for (int i = firstPiece + prepareCount; i <= Math.min(lastPiece, firstPiece + prepareCount + ahead); i++) {
            handle.piecePriority(i, Priority.TOP_PRIORITY);
            handle.setPieceDeadline(i, 2000);
          }
          handle.setFlags(handle.getFlags().or_(TorrentFlags.SEQUENTIAL_DOWNLOAD));
          handle.resume();
        } catch (Throwable ignored) {}
      }
      synchronized (pieceLock) {
        pieceLock.notifyAll();
      }
    }

    @Override
    public int[] types() {
      return new int[]{ AlertType.PIECE_FINISHED.swig() };
    }

    @Override
    public void alert(Alert<?> alert) {
      if (alert.type() == AlertType.PIECE_FINISHED) {
        markPiece(((PieceFinishedAlert) alert).pieceIndex());
      }
    }
  }
}
