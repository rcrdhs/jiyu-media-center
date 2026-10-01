package app.jiyu.mediacenter.torrent;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.arthenica.ffmpegkit.FFmpegKitConfig;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.util.Log;

import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "TorrentStreamer")
public class TorrentStreamerPlugin extends Plugin {
  private final ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
    Thread t = new Thread(r, "jiyu-torrent");
    t.setDaemon(true);
    return t;
  });

  @Override
  public void load() {
    executor.execute(() -> {
      try {
        Log.i("JiyuRemux", "ffmpeg ready " + FFmpegKitConfig.getVersion());
      } catch (Throwable t) {
        Log.e("JiyuRemux", "ffmpeg failed to load", t);
      }
    });
  }

  @PluginMethod
  public void stream(PluginCall call) {
    String uri = call.getString("uri");
    boolean keepOthers = Boolean.TRUE.equals(call.getBoolean("keepOthers", false));
    Integer fileIndex = call.getInt("fileIndex");
    String fileName = call.getString("fileName");

    executor.execute(() -> {
      try {
        TorrentEngine.StreamResult result = TorrentEngine.get(getContext())
          .stream(uri, keepOthers, fileIndex, fileName);
        JSObject out = new JSObject();
        out.put("ok", result.ok);
        if (!result.ok) {
          out.put("error", result.error != null ? result.error : "Torrent failed");
          call.resolve(out);
          return;
        }
        TorrentEngine.ActiveTorrent t = result.torrent;
        out.put("url", result.playUrl());
        out.put("infoHash", t.infoHash);
        out.put("name", t.name);
        out.put("fileName", t.videoFile != null ? t.videoFile.getName() : null);
        out.put("progress", 0);
        out.put("downloadSpeed", 0);
        out.put("numPeers", 0);
        out.put("downloaded", 0);
        out.put("length", t.length);
        call.resolve(out);
      } catch (Throwable e) {
        JSObject out = new JSObject();
        out.put("ok", false);
        out.put("error", e.getMessage() != null ? e.getMessage() : "Torrent engine error");
        call.resolve(out);
      }
    });
  }

  @PluginMethod
  public void stop(PluginCall call) {
    String infoHash = call.getString("infoHash");
    executor.execute(() -> {
      boolean ok = TorrentEngine.get(getContext()).stop(infoHash);
      JSObject out = new JSObject();
      out.put("ok", ok);
      call.resolve(out);
    });
  }

  @PluginMethod
  public void status(PluginCall call) {
    String infoHash = call.getString("infoHash");
    executor.execute(() -> {
      List<TorrentEngine.StatusRow> rows = TorrentEngine.get(getContext()).status(infoHash);
      JSArray torrents = new JSArray();
      for (TorrentEngine.StatusRow row : rows) {
        JSObject o = new JSObject();
        o.put("infoHash", row.infoHash);
        o.put("name", row.name);
        o.put("progress", row.progress);
        o.put("downloadSpeed", row.downloadSpeed);
        o.put("numPeers", row.numPeers);
        o.put("downloaded", row.downloaded);
        o.put("length", row.length);
        torrents.put(o);
      }
      JSObject out = new JSObject();
      out.put("ok", true);
      out.put("torrents", torrents);
      call.resolve(out);
    });
  }

  @PluginMethod
  public void ensureDownloading(PluginCall call) {
    String infoHash = call.getString("infoHash");
    Double playhead = call.getDouble("playheadSec");
    Double runtime = call.getDouble("runtimeSec");
    executor.execute(() -> {
      boolean ok = TorrentEngine.get(getContext()).ensureDownloading(infoHash, playhead, runtime);
      JSObject out = new JSObject();
      out.put("ok", ok);
      if (!ok) out.put("error", "Torrent not active");
      call.resolve(out);
    });
  }

  @Override
  protected void handleOnDestroy() {
    executor.shutdownNow();
    try {
      TorrentEngine.get(getContext()).stop(null);
    } catch (Throwable ignored) {}
    super.handleOnDestroy();
  }
}
