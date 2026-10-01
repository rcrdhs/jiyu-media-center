package app.jiyu.mediacenter.cast;

import android.content.Context;

import com.google.android.gms.cast.framework.CastOptions;
import com.google.android.gms.cast.framework.OptionsProvider;
import com.google.android.gms.cast.framework.SessionProvider;
import com.google.android.gms.cast.framework.media.CastMediaOptions;
import com.google.android.gms.cast.framework.media.NotificationOptions;

import java.util.List;

/** Default Cast receiver — HLS / MP4 URLs Jiyu can hand off. */
public final class CastOptionsProvider implements OptionsProvider {
  @Override
  public CastOptions getCastOptions(Context context) {
    NotificationOptions notificationOptions =
      new NotificationOptions.Builder().setTargetActivityClassName(app.jiyu.mediacenter.MainActivity.class.getName()).build();
    CastMediaOptions mediaOptions =
      new CastMediaOptions.Builder().setNotificationOptions(notificationOptions).build();
    return new CastOptions.Builder()
      .setReceiverApplicationId(com.google.android.gms.cast.CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID)
      .setCastMediaOptions(mediaOptions)
      .build();
  }

  @Override
  public List<SessionProvider> getAdditionalSessionProviders(Context context) {
    return null;
  }
}
