package moe.dill.campfire

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * The Android app's notification path.
 *
 * WHY THIS EXISTS AT ALL: Android WebView implements neither the Push API
 * (`PushManager`) nor the Notification API, and Tauri's WebView calls
 * `WebView.onPause()` whenever the activity is backgrounded, so the page inside
 * the app can neither subscribe to web push nor stay awake to watch a socket.
 * There is no Firebase project behind Campfire either (it is self-hosted), so
 * FCM is not an option. What is left is the thing every no-GCM self-hosted
 * client does: hold the connection ourselves, in a foreground service, and post
 * the notification locally.
 *
 * The service owns its own socket to `/ws/push` — it does NOT depend on the
 * WebView, so it survives the app being backgrounded AND the task being swiped
 * away (`android:stopWithTask="false"`). The server sends it exactly the payload
 * it would have handed to a Web Push endpoint ("#chat · Server" / "Alex (DM)",
 * already filtered through the account's mute + mention rules), so every rule
 * lives in one place on the server.
 *
 * The socket is not a chat session: it never registers in live_sessions, so a
 * phone with the app closed does not look online, and it is not part of the
 * account-wide "is the page visible" push gate. Whether a notification is shown
 * is decided here, per device: `appVisible` (MainActivity's onResume/onPause,
 * mirrored to the server over the socket) is the only suppression, so a phone
 * in someone's pocket still rings while Campfire is open on a desktop.
 */
class PushService : Service() {
  private val client: OkHttpClient by lazy {
    OkHttpClient.Builder()
      // Keeps NAT bindings and mobile-radio state warm, and is what lets the
      // server's own ping sweep drop a silently dead socket.
      .pingInterval(20, TimeUnit.SECONDS)
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .retryOnConnectionFailure(true)
      .build()
  }
  private val handler = Handler(Looper.getMainLooper())
  private var socket: WebSocket? = null
  private var attempts = 0
  private var reconnect: Runnable? = null
  private var stopped = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    ensureChannels(this)
    // startForeground inside the 5s window startForegroundService() allows.
    try {
      ServiceCompat.startForeground(
        this,
        SERVICE_NOTIF_ID,
        buildServiceNotification(),
        if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
      )
    } catch (e: Exception) {
      Log.w(TAG, "startForeground failed", e)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      closeSocket()
      stopSelf()
      return START_NOT_STICKY
    }
    stopped = false
    connect()
    // START_STICKY: if Android kills us for memory it restarts the service with
    // a null intent, which reconnects from the stored config.
    return START_STICKY
  }

  override fun onDestroy() {
    stopped = true
    closeSocket()
    if (instance === this) { instance = null; appVisible = false }
    super.onDestroy()
  }

  // ---------- connection ----------

  private fun connect() {
    if (stopped) return
    val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val token = prefs.getString(KEY_TOKEN, "").orEmpty()
    val origin = prefs.getString(KEY_ORIGIN, "").orEmpty()
    if (token.isEmpty() || origin.isEmpty()) { stopSelf(); return }
    try { socket?.cancel() } catch {}
    val url = origin.trimEnd('/')
      .replaceFirst("https://", "wss://")
      .replaceFirst("http://", "ws://") + "/ws/push?token=" + URLEncoder.encode(token, "UTF-8")
    socket = client.newWebSocket(Request.Builder().url(url).build(), listener)
  }

  private fun scheduleReconnect() {
    if (stopped) return
    reconnect?.let { handler.removeCallbacks(it) }
    val delay = when (attempts) {
      0 -> 3000L
      1 -> 5000L
      2 -> 15000L
      else -> 60000L
    }
    val r = Runnable { reconnect = null; connect() }
    reconnect = r
    handler.postDelayed(r, delay)
  }

  private fun closeSocket() {
    reconnect?.let { handler.removeCallbacks(it) }
    reconnect = null
    val ws = socket
    socket = null
    try { ws?.close(1000, "bye") } catch {}
  }

  private val listener = object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      attempts = 0
      sendVisibility(webSocket)
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      try {
        val msg = JSONObject(text)
        when (msg.optString("t")) {
          "push" -> showMessageNotification(msg.optJSONObject("payload"))
          "ping" -> webSocket.send("{\"t\":\"pong\"}")
        }
      } catch (e: Exception) {
        Log.w(TAG, "bad frame", e)
      }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      Log.w(TAG, "socket closed: ${t.message}")
      attempts++
      scheduleReconnect()
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      attempts++
      scheduleReconnect()
    }
  }

  private fun sendVisibility(ws: WebSocket?) {
    if (ws == null) return
    try { ws.send(JSONObject().put("t", "visibility").put("visible", appVisible).toString()) } catch {}
  }

  // ---------- notifications ----------

  private fun showMessageNotification(payload: JSONObject?) {
    payload ?: return
    // On screen already: the app itself is showing the conversation, and the
    // server's own "any device visible" gate is not what decides this — the
    // device is. The Settings tab's "Send test notification" is the exception,
    // or it would look broken while you are looking at the button.
    val isTest = payload.optBoolean("test", false)
    if (appVisible && !isTest) return
    if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return
    val title = payload.optString("title", "Campfire")
    val body = payload.optString("body", "")
    val tag = payload.optString("tag", "campfire")
    val url = payload.optString("url", "/")
    val n = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
      .setSmallIcon(R.drawable.ic_stat_campfire)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setWhen(System.currentTimeMillis())
      .setContentIntent(openIntent(url))
      .build()
    try {
      // Tagged like the service worker tags web-push notifications, so a busy
      // channel collapses into one line instead of a stack.
      NotificationManagerCompat.from(this).notify(tag, MESSAGE_NOTIF_ID, n)
    } catch (e: SecurityException) {
      Log.w(TAG, "notify denied", e)
    }
  }

  private fun openIntent(url: String): PendingIntent {
    val i = Intent(this, MainActivity::class.java).apply {
      action = Intent.ACTION_VIEW
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      putExtra(EXTRA_URL, url)
    }
    val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    return PendingIntent.getActivity(this, url.hashCode(), i, piFlags)
  }

  private fun buildServiceNotification(): Notification =
    NotificationCompat.Builder(this, CHANNEL_SERVICE)
      .setSmallIcon(R.drawable.ic_stat_campfire)
      .setContentTitle(getString(R.string.app_name))
      .setContentText("Messages arrive in the background")
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setOngoing(true)
      .setShowWhen(false)
      .setSilent(true)
      .setContentIntent(openIntent("/"))
      .build()

  companion object {
    private const val TAG = "CampfirePush"
    const val PREFS = "campfire_push"
    const val KEY_TOKEN = "token"
    const val KEY_ORIGIN = "origin"
    const val KEY_ENABLED = "enabled"
    const val ACTION_START = "moe.dill.campfire.PUSH_START"
    const val ACTION_STOP = "moe.dill.campfire.PUSH_STOP"
    const val EXTRA_URL = "campfire_url"
    private const val CHANNEL_MESSAGES = "campfire_messages"
    private const val CHANNEL_SERVICE = "campfire_service"
    private const val SERVICE_NOTIF_ID = 8801
    private const val MESSAGE_NOTIF_ID = 8802
    private const val PERMISSION_REQ = 8803

    @Volatile private var instance: PushService? = null

    /** Is the app's window on screen right now? MainActivity owns this. */
    @Volatile var appVisible = false

    fun setAppVisible(visible: Boolean) {
      appVisible = visible
      instance?.let { it.sendVisibility(it.socket) }
    }

    fun running(): Boolean = instance != null

    /** Called from the WebView bridge with the signed-in session. */
    fun configure(ctx: Context, token: String, origin: String, enabled: Boolean) {
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putString(KEY_TOKEN, token)
        .putString(KEY_ORIGIN, origin)
        .putBoolean(KEY_ENABLED, enabled)
        .apply()
      val svc = Intent(ctx, PushService::class.java)
      if (enabled && token.isNotEmpty() && origin.isNotEmpty()) {
        svc.action = ACTION_START
        try { ContextCompat.startForegroundService(ctx, svc) } catch (e: Exception) { Log.w(TAG, "start failed", e) }
      } else {
        // Signed out or turned off: tear the socket down (the stored config is
        // what a later start reads, so prefs stay authoritative).
        try { ctx.stopService(svc) } catch {}
      }
    }

    fun statusJson(ctx: Context): String {
      val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      return JSONObject()
        .put("enabled", prefs.getBoolean(KEY_ENABLED, false))
        .put("running", running())
        .put("permission", NotificationManagerCompat.from(ctx).areNotificationsEnabled())
        .toString()
    }

    /** Android 13+ needs the runtime grant; without it notifications are dropped silently. */
    fun requestPermission(activity: Activity) {
      if (Build.VERSION.SDK_INT < 33) return
      if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
      activity.runOnUiThread {
        try { ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), PERMISSION_REQ) } catch {}
      }
    }

    fun ensureChannels(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val mgr = ctx.getSystemService(NotificationManager::class.java) ?: return
      if (mgr.getNotificationChannel(CHANNEL_MESSAGES) == null) {
        mgr.createNotificationChannel(
          NotificationChannel(CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Direct messages, mentions and replies"
          }
        )
      }
      if (mgr.getNotificationChannel(CHANNEL_SERVICE) == null) {
        mgr.createNotificationChannel(
          NotificationChannel(CHANNEL_SERVICE, "Background connection", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Keeps a connection open so messages arrive while the app is closed"
            setShowBadge(false)
          }
        )
      }
    }
  }
}
