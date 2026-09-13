package moe.dill.campfire

import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * The web app's handle on the native notification service.
 *
 * Tauri injects a JS API for Rust commands, but the notification service is
 * pure Kotlin, so the site talks to it through a JavascriptInterface installed
 * on the WebView by MainActivity (`window.CampfireNative`). Every method runs on
 * a WebView-owned thread, never the UI thread, so anything that touches UI goes
 * through the activity (see PushService.requestPermission).
 *
 * Keeping this tiny is the point: the site reports the session, reads the state
 * back, and nothing else has to know the socket exists.
 */
class PushBridge(private val activity: MainActivity) {
  /** Signed in / signed out, and the on-off switch in Settings → Notifications. */
  @JavascriptInterface
  fun configure(token: String, origin: String, enabled: Boolean): Boolean =
    try {
      PushService.configure(activity, token ?: "", origin ?: "", enabled)
      true
    } catch (e: Exception) {
      false
    }

  /** `{ enabled, running, permission }` — what the settings tab prints. */
  @JavascriptInterface
  fun status(): String = try { PushService.statusJson(activity) } catch (e: Exception) { "{}" }

  @JavascriptInterface
  fun requestPermission(): Boolean =
    try {
      PushService.requestPermission(activity)
      true
    } catch (e: Exception) {
      false
    }

  /**
   * A conversation to open because a notification was tapped, or "" — the
   * service hands the push payload's url here through MainActivity's intent.
   * The page drains it after boot and on every return to the foreground.
   */
  @JavascriptInterface
  fun takeUrl(): String = try { activity.takePendingUrl() } catch (e: Exception) { "" }

  @JavascriptInterface
  fun version(): String = try { JSONObject().put("platform", "android").toString() } catch (e: Exception) { "{}" }
}
