package moe.dill.campfire

import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  // A conversation url carried by a tapped notification. Held until the page is
  // ready to route it (the site drains it through the bridge), because a cold
  // start has no JS to hand it to yet.
  @Volatile private var pendingUrl: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    takeIntentUrl(intent)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    // The site sees window.CampfireNative (see public/js/final.js).
    try { webView.addJavascriptInterface(PushBridge(this), "CampfireNative") } catch {}
  }

  override fun onResume() {
    super.onResume()
    // The only suppression the push service applies: on screen means the app is
    // already showing the conversation, so no notification is posted.
    PushService.setAppVisible(true)
    flushPendingUrl()
  }

  override fun onPause() {
    super.onPause()
    PushService.setAppVisible(false)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    takeIntentUrl(intent)
    flushPendingUrl()
  }

  @Synchronized
  fun takePendingUrl(): String {
    val u = pendingUrl ?: return ""
    pendingUrl = null
    return u
  }

  private fun takeIntentUrl(intent: Intent?) {
    val u = intent?.getStringExtra(PushService.EXTRA_URL)
    if (!u.isNullOrEmpty()) pendingUrl = u
  }

  /**
   * Try to hand the pending url to the running page. If the page is still
   * loading (or the app was cold-started) the hook is missing and the url is
   * left for the page's own drain through the bridge — never dropped.
   */
  fun flushPendingUrl() {
    val url = pendingUrl ?: return
    val wv = webView ?: return
    wv.post {
      try {
        wv.evaluateJavascript(
          "(function(){try{return !!(window.__cfDeepLink && window.__cfDeepLink(" +
            JSONObject.quote(url) + "));}catch(e){return false;}})()"
        ) { result ->
          if (result == "true") {
            synchronized(this) { if (pendingUrl == url) pendingUrl = null }
          }
        }
      } catch {}
    }
  }
}
