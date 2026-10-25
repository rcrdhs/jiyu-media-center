package app.jiyu.mediacenter.sync;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Continue-watching sync device token (Android).
 *
 * Stored in app-private SharedPreferences, AES-GCM encrypted with an Android Keystore key
 * (same scheme as BiliSessionPlugin). The WebView keeps it only in memory. Never logged.
 */
@CapacitorPlugin(name = "SyncSecret")
public class SyncSecretPlugin extends Plugin {
  private static final String PREFS = "jiyu_sync_secret";
  private static final String KEY_BLOB = "token";
  private static final String KEY_ALIAS = "jiyu_sync_token_v1";
  private static final Pattern TOKEN_RE = Pattern.compile("^jys_[A-Za-z0-9_-]{40,128}$");

  @PluginMethod
  public void get(PluginCall call) {
    String token = readToken();
    JSObject out = new JSObject();
    out.put("token", token);
    out.put("encrypted", token != null && !prefs().getString(KEY_BLOB, "").startsWith("p:"));
    call.resolve(out);
  }

  @PluginMethod
  public void set(PluginCall call) {
    String token = call.getString("token", "");
    JSObject out = new JSObject();
    if (token == null || !TOKEN_RE.matcher(token).matches()) {
      out.put("ok", false);
      out.put("encrypted", false);
      call.resolve(out);
      return;
    }
    byte[] plain = token.getBytes(StandardCharsets.UTF_8);
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
    prefs().edit().putString(KEY_BLOB, blob).apply();
    out.put("ok", true);
    out.put("encrypted", encrypted);
    call.resolve(out);
  }

  @PluginMethod
  public void clear(PluginCall call) {
    prefs().edit().remove(KEY_BLOB).apply();
    JSObject out = new JSObject();
    out.put("ok", true);
    call.resolve(out);
  }

  private SharedPreferences prefs() {
    return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  private String readToken() {
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
      String token = new String(plain, StandardCharsets.UTF_8);
      return TOKEN_RE.matcher(token).matches() ? token : null;
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
}
