package nz.org.kri.gps;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Native capsize monitor — runs with screen off (no WebView). Posts capsize samples to ingest
 * and shows a high-priority notification.
 */
public class CapsizeMonitorService extends Service implements SensorEventListener {

    private static final String TAG = "CapsizeMonitor";
    private static final String PREFS = "kri_capsize_monitor";
    private static final String CHANNEL_ID = "kri_capsize_native";
    private static final int NOTIF_ID_FOREGROUND = 9101;
    private static final int NOTIF_ID_ALERT = 9102;
    private static final float GRAVITY_ALPHA = 0.04f;
    private static final float STILL_VAR_MAX = 0.35f;
    private static final int CALIBRATE_MIN_SAMPLES = 8;
    private static final long CALIBRATE_WINDOW_MS = 2500L;
    private static final long CAPSIZE_HOLD_MS = 400L;
    private static final long UPLOAD_MIN_INTERVAL_MS = 4000L;

    private SensorManager sensorManager;
    private Sensor accelerometer;
    private PowerManager.WakeLock wakeLock;
    private ExecutorService uploadExecutor;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private float gx;
    private float gy;
    private float gz = 9.81f;
    private float uprightX;
    private float uprightY = 0f;
    private float uprightZ = 1f;
    private boolean calibrated;
    private boolean capsizeActive;
    private long capsizeSinceMs;
    private long lastUploadMs;
    private int sampleCount;
    private final float[] recentAx = new float[64];
    private final float[] recentAy = new float[64];
    private final float[] recentAz = new float[64];
    private final long[] recentT = new long[64];
    private int recentCount;

    @Override
    public void onCreate() {
        super.onCreate();
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        }
        uploadExecutor = Executors.newSingleThreadExecutor();
        createNotificationChannel();
        loadUprightFromPrefs();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            saveConfigFromIntent(intent);
        }
        startForeground(NOTIF_ID_FOREGROUND, buildForegroundNotification());
        acquireWakeLock();
        registerSensor();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        unregisterSensor();
        releaseWakeLock();
        if (uploadExecutor != null) {
            uploadExecutor.shutdownNow();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() != Sensor.TYPE_ACCELEROMETER) return;
        float ax = event.values[0];
        float ay = event.values[1];
        float az = event.values[2];
        long t = System.currentTimeMillis();

        gx = GRAVITY_ALPHA * ax + (1f - GRAVITY_ALPHA) * gx;
        gy = GRAVITY_ALPHA * ay + (1f - GRAVITY_ALPHA) * gy;
        gz = GRAVITY_ALPHA * az + (1f - GRAVITY_ALPHA) * gz;
        sampleCount++;

        pushRecent(t, ax, ay, az);
        tryCalibrate(t);
        loadUprightFromPrefs();
        updateCapsize(t, ax, ay, az);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {}

    private void pushRecent(long t, float ax, float ay, float az) {
        if (recentCount < recentAx.length) {
            int i = recentCount++;
            recentT[i] = t;
            recentAx[i] = ax;
            recentAy[i] = ay;
            recentAz[i] = az;
        } else {
            System.arraycopy(recentAx, 1, recentAx, 0, recentAx.length - 1);
            System.arraycopy(recentAy, 1, recentAy, 0, recentAy.length - 1);
            System.arraycopy(recentAz, 1, recentAz, 0, recentAz.length - 1);
            System.arraycopy(recentT, 1, recentT, 0, recentT.length - 1);
            int i = recentAx.length - 1;
            recentT[i] = t;
            recentAx[i] = ax;
            recentAy[i] = ay;
            recentAz[i] = az;
        }
    }

    private void tryCalibrate(long t) {
        if (calibrated || recentCount < CALIBRATE_MIN_SAMPLES) return;
        int n = 0;
        float sx = 0, sy = 0, sz = 0;
        for (int i = 0; i < recentCount; i++) {
            if (recentT[i] >= t - CALIBRATE_WINDOW_MS) {
                sx += recentAx[i];
                sy += recentAy[i];
                sz += recentAz[i];
                n++;
            }
        }
        if (n < CALIBRATE_MIN_SAMPLES) return;
        float vx = stdDevWindow(recentAx, t);
        float vy = stdDevWindow(recentAy, t);
        float vz = stdDevWindow(recentAz, t);
        if (vx + vy + vz > STILL_VAR_MAX) return;
        uprightX = gx;
        uprightY = gy;
        uprightZ = gz;
        normalizeUpright();
        calibrated = true;
        saveUprightToPrefs();
        Log.i(TAG, "Calibrated upright (native)");
    }

    private float stdDevWindow(float[] arr, long newestT) {
        float mean = 0f;
        int n = 0;
        for (int i = 0; i < recentCount; i++) {
            if (recentT[i] >= newestT - CALIBRATE_WINDOW_MS) {
                mean += arr[i];
                n++;
            }
        }
        if (n < 2) return 0f;
        mean /= n;
        float sum = 0f;
        for (int i = 0; i < recentCount; i++) {
            if (recentT[i] >= newestT - CALIBRATE_WINDOW_MS) {
                float d = arr[i] - mean;
                sum += d * d;
            }
        }
        return (float) Math.sqrt(sum / n);
    }

    private void updateCapsize(long t, float ax, float ay, float az) {
        if (!calibrated) return;
        float mag = (float) Math.sqrt(ax * ax + ay * ay + az * az);
        if (mag < 7f || mag > 12f) return;

        float nx = ax / mag;
        float ny = ay / mag;
        float nz = az / mag;
        float dot = nx * uprightX + ny * uprightY + nz * uprightZ;
        int tiltDeg = (int) Math.round(Math.acos(clamp(dot, -1f, 1f)) * (180.0 / Math.PI));

        boolean tipped = dot < 0f;
        if (tipped) {
            if (capsizeSinceMs == 0) capsizeSinceMs = t;
            if (!capsizeActive && t - capsizeSinceMs >= CAPSIZE_HOLD_MS) {
                capsizeActive = true;
                onCapsizeTriggered(t, ax, ay, az, tiltDeg);
            }
        } else if (dot > 0.55f) {
            capsizeSinceMs = 0;
            if (capsizeActive) {
                capsizeActive = false;
                cancelAlertNotification();
            }
        } else {
            capsizeSinceMs = 0;
        }
    }

    private void onCapsizeTriggered(long t, float ax, float ay, float az, int tiltDeg) {
        Log.w(TAG, "CAPSIZE detected (native)");
        showAlertNotification();
        if (t - lastUploadMs < UPLOAD_MIN_INTERVAL_MS) return;
        lastUploadMs = t;
        uploadExecutor.execute(() -> postCapsizeToIngest(t, ax, ay, az, tiltDeg));
    }

    private void postCapsizeToIngest(long t, float ax, float ay, float az, int tiltDeg) {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String ingestUrl = p.getString("ingestUrl", "");
        String deviceId = p.getString("deviceId", "");
        String sessionId = p.getString("sessionId", "");
        if (ingestUrl.isEmpty() || deviceId.isEmpty() || sessionId.isEmpty()) {
            Log.e(TAG, "Missing ingest config");
            return;
        }
        try {
            JSONObject derived = new JSONObject();
            derived.put("capsize", true);
            derived.put("tiltDeg", tiltDeg);
            JSONObject motion = new JSONObject();
            motion.put("ax", Math.round(ax * 100) / 100.0);
            motion.put("ay", Math.round(ay * 100) / 100.0);
            motion.put("az", Math.round(az * 100) / 100.0);
            JSONObject sample = new JSONObject();
            sample.put("t", t);
            sample.put("motion", motion);
            sample.put("derived", derived);
            JSONArray samples = new JSONArray();
            samples.put(sample);
            JSONObject batch = new JSONObject();
            batch.put("sessionId", sessionId);
            batch.put("deviceId", deviceId);
            String athleteId = p.getString("athleteId", "");
            if (!athleteId.isEmpty()) batch.put("athleteId", athleteId);
            batch.put("samples", samples);

            String body = batch.toString();
            URL url = new URL(ingestUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(20000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            String token = p.getString("ingestToken", "");
            if (!token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            conn.disconnect();
            Log.i(TAG, "Capsize ingest HTTP " + code);
        } catch (Exception e) {
            Log.e(TAG, "Capsize ingest failed", e);
        }
    }

    private void saveConfigFromIntent(Intent intent) {
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putString("sessionId", intent.getStringExtra("sessionId"))
            .putString("deviceId", intent.getStringExtra("deviceId"))
            .putString("ingestUrl", intent.getStringExtra("ingestUrl"))
            .putString("ingestToken", intent.getStringExtra("ingestToken"))
            .putString("athleteId", intent.getStringExtra("athleteId"))
            .apply();
    }

    private void loadUprightFromPrefs() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!p.getBoolean("hasUpright", false)) return;
        uprightX = p.getFloat("uprightX", 0f);
        uprightY = p.getFloat("uprightY", 0f);
        uprightZ = p.getFloat("uprightZ", 1f);
        normalizeUpright();
        calibrated = true;
    }

    private void saveUprightToPrefs() {
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putBoolean("hasUpright", true)
            .putFloat("uprightX", uprightX)
            .putFloat("uprightY", uprightY)
            .putFloat("uprightZ", uprightZ)
            .apply();
    }

    public static void setUpright(Context ctx, float x, float y, float z) {
        float mag = (float) Math.sqrt(x * x + y * y + z * z);
        if (mag < 1e-3f) return;
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putBoolean("hasUpright", true)
            .putFloat("uprightX", x / mag)
            .putFloat("uprightY", y / mag)
            .putFloat("uprightZ", z / mag)
            .apply();
    }

    private void normalizeUpright() {
        float mag = (float) Math.sqrt(uprightX * uprightX + uprightY * uprightY + uprightZ * uprightZ);
        if (mag < 1e-3f) return;
        uprightX /= mag;
        uprightY /= mag;
        uprightZ /= mag;
    }

    private void registerSensor() {
        if (sensorManager == null || accelerometer == null) return;
        sensorManager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_GAME);
    }

    private void unregisterSensor() {
        if (sensorManager != null) sensorManager.unregisterListener(this);
    }

    private void acquireWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm == null) return;
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "KRI::CapsizeMonitor");
        wakeLock.acquire(4 * 60 * 60 * 1000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel ch =
            new NotificationChannel(
                CHANNEL_ID,
                "Capsize alerts (native)",
                NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Native capsize detection while recording");
        ch.enableVibration(true);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(ch);
    }

    private Notification buildForegroundNotification() {
        Intent launch = new Intent(this, MainActivity.class);
        PendingIntent pi =
            PendingIntent.getActivity(
                this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("KRI capsize monitor active")
            .setContentText("Watching for capsize while recording")
            .setSmallIcon(R.drawable.ic_stat_rnz_alert)
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void showAlertNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        Intent launch = new Intent(this, MainActivity.class);
        PendingIntent pi =
            PendingIntent.getActivity(
                this, 1, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n =
            new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("CAPSIZE ALERT")
                .setContentText("Boat tipped — check crew immediately")
                .setSmallIcon(R.drawable.ic_stat_rnz_alert)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE)
                .build();
        nm.notify(NOTIF_ID_ALERT, n);
    }

    private void cancelAlertNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(NOTIF_ID_ALERT);
    }

    private static float clamp(float v, float lo, float hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
