package app.jiyu.mediacenter.bili;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Optional bilibili.tv account (Settings → Bilibili).
 *
 * GeckoView (the in-app browser) has no API to read its cookie jar, so sign-in uses a
 * dedicated full-screen Android System WebView: once a SESSDATA cookie for bilibili.tv shows
 * up in {@link CookieManager} (it includes HttpOnly cookies), the bilibili.tv cookies are
 * copied to app-private SharedPreferences, AES-GCM encrypted with an Android Keystore key,
 * and removed from the WebView jar. The cookie never reaches JS: {@link #fetch} adds it
 * only to the playurl / subtitle APIs on api.bilibili.tv. Cookie values are never logged.
 */
@CapacitorPlugin(name = "BiliSession")
public class BiliSessionPlugin extends Plugin {
  private static final String TAG = "JiyuBiliSession";
  private static final String PREFS = "jiyu_bili_tv_session";
  private static final String KEY_BLOB = "blob";
  private static final String KEY_SAVED_AT = "savedAt";
  private static final String KEY_ENCRYPTED = "encrypted";
  private static final String KEY_ALIAS = "jiyu_bili_tv_session_v1";
  private static final String LOGIN_URL = "https://www.bilibili.tv/en/";
  private static final List<String> COOKIE_URLS = Arrays.asList(
    "https://www.bilibili.tv",
    "https://api.bilibili.tv",
    "https://bilibili.tv"
  );
  private static final List<String> SESSION_PATHS = Arrays.asList(
    "/intl/gateway/web/playurl",
    "/intl/gateway/web/v2/subtitle"
  );
  private static final String UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  private final Handler main = new Handler(Looper.getMainLooper());
  private final ExecutorService io = Executors.newFixedThreadPool(2);

  private FrameLayout overlay;
  private WebView loginView;
  private TextView hint;
  private PluginCall pendingSignIn;
  private Runnable pollTask;
  private long deadline;

  // ---------------------------------------------------------------- status / sign-out

  @PluginMethod
  public void status(PluginCall call) {
    call.resolve(statusObject());
  }

  @PluginMethod
  public void signOut(PluginCall call) {
    prefs().edit().clear().apply();
    main.post(() -> {
      clearWebViewBiliCookies();
      Log.i(TAG, "signed out");
      call.resolve(statusObject());
    });
  }

  // ---------------------------------------------------------------- sign-in

  @PluginMethod
  public void signIn(PluginCall call) {
    final int timeoutMs = Math.max(60_000, call.getInt("timeoutMs", 15 * 60_000));
    main.post(() -> {
      if (pendingSignIn != null) {
        finishSignIn(false, "Replaced by a new sign-in");
      }
      try {
        pendingSignIn = call;
        call.setKeepAlive(true);
        deadline = System.currentTimeMillis() + timeoutMs;
        showOverlay();
        startPolling();
      } catch (Throwable t) {
        pendingSignIn = null;
        JSObject out = statusObject();
        out.put("ok", false);
        out.put("error", t.getMessage() != null ? t.getMessage() : "Sign-in failed to open");
        call.resolve(out);
      }
    });
  }

  @PluginMethod
  public void cancelSignIn(PluginCall call) {
    main.post(() -> {
      finishSignIn(false, "Cancelled");
      call.resolve(statusObject());
    });
  }

  /** Hardware Back while the sign-in sheet is open (MainActivity). */
  public boolean cancelIfVisible() {
    if (overlay == null || overlay.getVisibility() != View.VISIBLE) return false;
    main.post(() -> {
      if (loginView != null && loginView.canGoBack()) {
        loginView.goBack();
      } else {
        finishSignIn(false, "Cancelled");
      }
    });
    return true;
  }

  @SuppressLint("SetJavaScriptEnabled")
  private void showOverlay() {
    Activity activity = getActivity();
    if (activity == null) throw new IllegalStateException("No activity");
    ViewGroup root = activity.findViewById(android.R.id.content);
    if (overlay == null) {
      overlay = new FrameLayout(activity);
      overlay.setBackgroundColor(Color.parseColor("#080A0D"));
      overlay.setClickable(true);

      LinearLayout bar = new LinearLayout(activity);
      bar.setOrientation(LinearLayout.HORIZONTAL);
      bar.setGravity(Gravity.CENTER_VERTICAL);
      bar.setPadding(dp(12), dp(6), dp(8), dp(6));
      bar.setBackgroundColor(Color.parseColor("#12161E"));
      FrameLayout.LayoutParams barLp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
      barLp.gravity = Gravity.TOP;
      bar.setLayoutParams(barLp);

      hint = new TextView(activity);
      hint.setTextColor(Color.parseColor("#E8EEF8"));
      hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
      hint.setTypeface(Typeface.DEFAULT_BOLD);
      hint.setMaxLines(2);
      LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
      hintLp.rightMargin = dp(8);
      hint.setLayoutParams(hintLp);
      bar.addView(hint);

      Button cancel = new Button(activity);
      cancel.setText("Cancel");
      cancel.setAllCaps(false);
      cancel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
      cancel.setOnClickListener(v -> finishSignIn(false, "Cancelled"));
      bar.addView(cancel);

      overlay.addView(bar);
    }
    if (loginView == null) {
      loginView = new WebView(activity);
      WebSettings s = loginView.getSettings();
      s.setJavaScriptEnabled(true);
      s.setDomStorageEnabled(true);
      s.setSupportMultipleWindows(false);
      s.setJavaScriptCanOpenWindowsAutomatically(false);
      loginView.setWebViewClient(new WebViewClient());
      loginView.setWebChromeClient(new WebChromeClient());
      CookieManager cm = CookieManager.getInstance();
      cm.setAcceptCookie(true);
      try {
        cm.setAcceptThirdPartyCookies(loginView, true);
      } catch (Throwable ignored) {}
      FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      );
      lp.topMargin = dp(52);
      loginView.setLayoutParams(lp);
      overlay.addView(loginView);
    }
    if (overlay.getParent() == null) {
      root.addView(overlay, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      ));
    }
    hint.setText("Bilibili · tap Log in (top right) and sign in. Jiyu closes this when you're done.");
    overlay.setVisibility(View.VISIBLE);
    overlay.bringToFront();
    loginView.loadUrl(LOGIN_URL);
  }

  private void startPolling() {
    if (pollTask != null) main.removeCallbacks(pollTask);
    pollTask = new Runnable() {
      @Override
      public void run() {
        if (pendingSignIn == null) return;
        if (System.currentTimeMillis() > deadline) {
          finishSignIn(false, "Sign-in timed out");
          return;
        }
        String cookie = collectBiliCookies();
        if (cookie != null) {
          try {
            saveCookie(cookie);
            Log.i(TAG, "captured bilibili.tv session (" + cookie.split(";").length + " cookies)");
            finishSignIn(true, "");
          } catch (Throwable t) {
            Log.w(TAG, "save failed: " + t.getClass().getSimpleName());
            finishSignIn(false, "Could not store the sign-in");
          }
          return;
        }
        main.postDelayed(this, 1000);
      }
    };
    main.postDelayed(pollTask, 1000);
  }

  private void finishSignIn(boolean ok, String error) {
    PluginCall call = pendingSignIn;
    pendingSignIn = null;
    if (pollTask != null) main.removeCallbacks(pollTask);
    pollTask = null;
    teardownOverlay();
    // The copy lives in encrypted prefs; drop the WebView's own bilibili.tv cookies so they
    // ride on nothing else.
    if (ok) clearWebViewBiliCookies();
    if (call == null) return;
    JSObject out = statusObject();
    out.put("ok", ok);
    if (!ok) {
      out.put("error", error);
      out.put("cancelled", "Cancelled".equals(error));
    }
    call.resolve(out);
    try {
      call.setKeepAlive(false);
      getBridge().releaseCall(call);
    } catch (Throwable ignored) {}
  }

  private void teardownOverlay() {
    try {
      if (loginView != null) {
        loginView.stopLoading();
        loginView.loadUrl("about:blank");
        if (overlay != null) overlay.removeView(loginView);
        loginView.destroy();
      }
    } catch (Throwable ignored) {}
    loginView = null;
    try {
      if (overlay != null) {
        overlay.setVisibility(View.GONE);
        ViewGroup parent = (ViewGroup) overlay.getParent();
        if (parent != null) parent.removeView(overlay);
      }
    } catch (Throwable ignored) {}
  }

  /** bilibili.tv cookie header (incl. HttpOnly) when a SESSDATA is present; else null. */
  private static String collectBiliCookies() {
    CookieManager cm = CookieManager.getInstance();
    Map<String, String> byName = new LinkedHashMap<>();
    for (String u : COOKIE_URLS) {
      String raw;
      try {
        raw = cm.getCookie(u);
      } catch (Throwable t) {
        raw = null;
      }
      if (raw == null) continue;
      for (String part : raw.split(";")) {
        String p = part.trim();
        int eq = p.indexOf('=');
        if (eq <= 0) continue;
        byName.put(p.substring(0, eq).trim(), p.substring(eq + 1).trim());
      }
    }
    String sess = byName.get("SESSDATA");
    if (sess == null || sess.isEmpty()) return null;
    StringBuilder sb = new StringBuilder();
    for (Map.Entry<String, String> e : byName.entrySet()) {
      if (sb.length() > 0) sb.append("; ");
      sb.append(e.getKey()).append('=').append(e.getValue());
    }
    return sb.toString();
  }

  private static void clearWebViewBiliCookies() {
    try {
      CookieManager cm = CookieManager.getInstance();
      String[] domains = { ".bilibili.tv", "bilibili.tv", "www.bilibili.tv", "api.bilibili.tv" };
      for (String u : COOKIE_URLS) {
        String raw = cm.getCookie(u);
        if (raw == null) continue;
        for (String part : raw.split(";")) {
          String p = part.trim();
          int eq = p.indexOf('=');
          if (eq <= 0) continue;
          String name = p.substring(0, eq).trim();
          String expired = name + "=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/";
          cm.setCookie(u, expired);
          for (String d : domains) cm.setCookie(u, expired + "; Domain=" + d);
        }
      }
      cm.flush();
    } catch (Throwable ignored) {}
  }

  // ---------------------------------------------------------------- fetch (session APIs only)

  /** GET a bilibili.tv playurl / subtitle API URL with the stored account cookie. */
  @PluginMethod
  public void fetch(PluginCall call) {
    final String url = call.getString("url", "");
    final JSObject headersObj = call.getObject("headers", new JSObject());
    final int timeoutMs = Math.min(60_000, Math.max(3_000, call.getInt("timeoutMs", 15_000)));
    io.execute(() -> {
      JSObject out = new JSObject();
      HttpURLConnection conn = null;
      try {
        URL u = new URL(url);
        if (!"https".equals(u.getProtocol())
          || !"api.bilibili.tv".equalsIgnoreCase(u.getHost())
          || !SESSION_PATHS.contains(u.getPath())) {
          out.put("ok", false);
          out.put("status", 0);
          out.put("content", "");
          out.put("error", "URL not allowed");
          call.resolve(out);
          return;
        }
        String cookie = loadCookie();
        conn = (HttpURLConnection) u.openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(timeoutMs);
        conn.setReadTimeout(timeoutMs);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("User-Agent", UA);
        conn.setRequestProperty("Accept", "application/json, text/plain, */*");
        if (headersObj != null) {
          Iterator<String> keys = headersObj.keys();
          while (keys.hasNext()) {
            String k = keys.next();
            if (!k.matches("(?i)user-agent|accept|accept-language|referer|origin")) continue;
            String v = headersObj.optString(k, "");
            if (!v.isEmpty()) conn.setRequestProperty(k, v);
          }
        }
        if (cookie != null) conn.setRequestProperty("Cookie", cookie);
        int status = conn.getResponseCode();
        InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
        String body = "";
        if (in != null) {
          ByteArrayOutputStream buf = new ByteArrayOutputStream();
          byte[] chunk = new byte[16384];
          int n;
          int total = 0;
          while ((n = in.read(chunk)) > 0) {
            total += n;
            if (total > 4 * 1024 * 1024) throw new IllegalStateException("Response too large");
            buf.write(chunk, 0, n);
          }
          in.close();
          body = new String(buf.toByteArray(), StandardCharsets.UTF_8);
        }
        boolean ok = status >= 200 && status < 300;
        out.put("ok", ok);
        out.put("status", status);
        out.put("content", body);
        out.put("error", ok ? "" : "HTTP " + status);
        out.put("withSession", cookie != null);
        call.resolve(out);
      } catch (Throwable t) {
        out.put("ok", false);
        out.put("status", 0);
        out.put("content", "");
        out.put("error", t.getMessage() != null ? t.getMessage() : "Request failed");
        call.resolve(out);
      } finally {
        if (conn != null) conn.disconnect();
      }
    });
  }

  // ---------------------------------------------------------------- storage

  private SharedPreferences prefs() {
    return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private JSObject statusObject() {
    SharedPreferences p = prefs();
    JSObject out = new JSObject();
    boolean signedIn = loadCookie() != null;
    out.put("signedIn", signedIn);
    out.put("encrypted", signedIn ? p.getBoolean(KEY_ENCRYPTED, false) : true);
    out.put("savedAt", signedIn ? p.getLong(KEY_SAVED_AT, 0L) : 0L);
    out.put("capturing", pendingSignIn != null);
    return out;
  }

  private void saveCookie(String cookie) throws Exception {
    JSONObject json = new JSONObject();
    json.put("cookie", cookie);
    byte[] plain = json.toString().getBytes(StandardCharsets.UTF_8);
    String blob;
    boolean encrypted;
    try {
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.ENCRYPT_MODE, keystoreKey());
      byte[] iv = c.getIV();
      byte[] enc = c.doFinal(plain);
      blob = Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(enc, Base64.NO_WRAP);
      encrypted = true;
    } catch (Throwable t) {
      // Keystore unavailable (rare) — app-private storage only.
      blob = "p:" + Base64.encodeToString(plain, Base64.NO_WRAP);
      encrypted = false;
    }
    prefs().edit()
      .putString(KEY_BLOB, blob)
      .putLong(KEY_SAVED_AT, System.currentTimeMillis())
      .putBoolean(KEY_ENCRYPTED, encrypted)
      .apply();
  }

  /** Stored cookie header, or null when signed out / unreadable. */
  private String loadCookie() {
    String blob = prefs().getString(KEY_BLOB, null);
    if (blob == null || blob.isEmpty()) return null;
    try {
      byte[] plain;
      if (blob.startsWith("p:")) {
        plain = Base64.decode(blob.substring(2), Base64.NO_WRAP);
      } else {
        int colon = blob.indexOf(':');
        byte[] iv = Base64.decode(blob.substring(0, colon), Base64.NO_WRAP);
        byte[] enc = Base64.decode(blob.substring(colon + 1), Base64.NO_WRAP);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, keystoreKey(), new GCMParameterSpec(128, iv));
        plain = c.doFinal(enc);
      }
      String cookie = new JSONObject(new String(plain, StandardCharsets.UTF_8)).optString("cookie", "");
      return cookie.contains("SESSDATA=") ? cookie : null;
    } catch (Throwable t) {
      return null;
    }
  }

  private static SecretKey keystoreKey() throws Exception {
    KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
    ks.load(null);
    KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
    if (entry instanceof KeyStore.SecretKeyEntry) {
      return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
    }
    KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    kg.init(new KeyGenParameterSpec.Builder(
      KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .build());
    return kg.generateKey();
  }

  private int dp(int value) {
    float density = getContext().getResources().getDisplayMetrics().density;
    return Math.round(value * density);
  }
}
