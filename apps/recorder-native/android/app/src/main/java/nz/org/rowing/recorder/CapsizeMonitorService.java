package nz.org.rowing.recorder;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Native session recorder — GPS + capsize run outside the WebView with a foreground service.
 */
public class CapsizeMonitorService extends Service implements SensorEventListener, LocationListener {

    private static final String TAG = "SessionRecorder";
    public static final String PREFS = "rnz_capsize_monitor";
    private static final String CHANNEL_ID = "rnz_capsize_native";
    private static final int NOTIF_ID_FOREGROUND = 9101;
    private static final int NOTIF_ID_ALERT = 9102;
    private static final float GRAVITY_ALPHA = 0.04f;
    private static final float STILL_VAR_MAX = 0.35f;
    private static final int CALIBRATE_MIN_SAMPLES = 8;
    private static final long CALIBRATE_WINDOW_MS = 2500L;
    private static final long CAPSIZE_HOLD_MS = 400L;
    private static final long CAPSIZE_UPLOAD_MIN_INTERVAL_MS = 4000L;
    private static final int MAX_PENDING_BATCHES = 60;
    private static final int MAX_PENDING_FLUSH_PER_CYCLE = 8;
    private static final String PENDING_BATCHES_KEY = "pendingIngestBatches";

    private SensorManager sensorManager;
    private Sensor accelerometer;
    private LocationManager locationManager;
    private PowerManager.WakeLock wakeLock;
    private ExecutorService uploadExecutor;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private boolean enableGps;
    private boolean enableMotion = true;
    private long gpsIntervalMs = 1000L;

    private float gx;
    private float gy;
    private float gz = 9.81f;
    private float uprightX;
    private float uprightY = 0f;
    private float uprightZ = 1f;
    private boolean calibrated;
    private boolean capsizeActive;
    private long capsizeSinceMs;
    private long lastCapsizeUploadMs;
    private long lastGpsPostMs;
    private int nativeGpsCount;
    private int sampleCount;
    private float lastAx;
    private float lastAy;
    private float lastAz;
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
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        uploadExecutor = Executors.newSingleThreadExecutor();
        createNotificationChannel();
        loadUprightFromPrefs();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            saveConfigFromIntent(intent);
        }
        loadSessionFlagsFromPrefs();
        startForeground(NOTIF_ID_FOREGROUND, buildForegroundNotification());
        acquireWakeLock();
        if (enableMotion) {
            registerSensor();
        }
        if (enableGps) {
            registerLocation();
        }
        Log.i(
            TAG,
            "Native session service started gps="
                + enableGps
                + " motion="
                + enableMotion
                + " intervalMs="
                + gpsIntervalMs);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        unregisterSensor();
        unregisterLocation();
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
        lastAx = ax;
        lastAy = ay;
        lastAz = az;

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

    @Override
    public void onLocationChanged(Location location) {
        if (!enableGps || location == null) return;
        if (!isGpsFixUsable(location)) return;
        long t = System.currentTimeMillis();
        if (t - lastGpsPostMs < gpsIntervalMs) return;
        lastGpsPostMs = t;
        nativeGpsCount++;
        saveLastGpsToPrefs(location, t, nativeGpsCount);
        final Location loc = location;
        uploadExecutor.execute(() -> {
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            flushPendingIngest(p);
            postGpsToIngest(loc, t);
        });
    }

    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onProviderDisabled(String provider) {
        Log.w(TAG, "Location provider disabled: " + provider);
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

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
        for (int i = 0; i < recentCount; i++) {
            if (recentT[i] >= t - CALIBRATE_WINDOW_MS) n++;
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
        if (t - lastCapsizeUploadMs < CAPSIZE_UPLOAD_MIN_INTERVAL_MS) return;
        lastCapsizeUploadMs = t;
        uploadExecutor.execute(() -> postCapsizeToIngest(t, ax, ay, az, tiltDeg));
    }

    private void postGpsToIngest(Location location, long t) {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String ingestUrl = p.getString("ingestUrl", "");
        String deviceId = p.getString("deviceId", "");
        String sessionId = p.getString("sessionId", "");
        if (ingestUrl.isEmpty() || deviceId.isEmpty() || sessionId.isEmpty()) {
            Log.e(TAG, "Missing ingest config for GPS");
            return;
        }
        try {
            JSONObject gps = new JSONObject();
            gps.put("lat", location.getLatitude());
            gps.put("lon", location.getLongitude());
            if (location.hasAccuracy()) gps.put("acc", location.getAccuracy());
            if (location.hasSpeed() && location.getSpeed() >= 0f) {
                gps.put("spd", Math.round(location.getSpeed() * 100) / 100.0);
            }
            if (location.hasBearing() && location.getBearing() >= 0f) {
                gps.put("hdg", Math.round(location.getBearing() * 10) / 10.0);
            }
            if (location.hasAltitude()) {
                gps.put("alt", Math.round(location.getAltitude() * 10) / 10.0);
            }

            JSONObject sample = new JSONObject();
            sample.put("t", t);
            sample.put("gps", gps);

            if (enableMotion && (lastAx != 0f || lastAy != 0f || lastAz != 0f)) {
                JSONObject motion = new JSONObject();
                motion.put("ax", Math.round(lastAx * 100) / 100.0);
                motion.put("ay", Math.round(lastAy * 100) / 100.0);
                motion.put("az", Math.round(lastAz * 100) / 100.0);
                sample.put("motion", motion);
            }

            JSONArray samples = new JSONArray();
            samples.put(sample);
            if (postBatch(p, sessionId, deviceId, samples)) {
                Log.d(TAG, "GPS ingest OK");
            } else {
                Log.w(TAG, "GPS ingest queued for retry");
            }
        } catch (Exception e) {
            recordUploadResult(-1, 1, false);
            Log.e(TAG, "GPS ingest failed", e);
        }
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
            if (postBatch(p, sessionId, deviceId, samples)) {
                Log.i(TAG, "Capsize ingest sent");
            } else {
                Log.w(TAG, "Capsize ingest queued for retry");
            }
        } catch (Exception e) {
            recordUploadResult(-1, 1, false);
            Log.e(TAG, "Capsize ingest failed", e);
        }
    }

    private JSONObject buildBatch(
            SharedPreferences p, String sessionId, String deviceId, JSONArray samples)
            throws Exception {
        JSONObject batch = new JSONObject();
        batch.put("sessionId", sessionId);
        batch.put("deviceId", deviceId);
        String athleteId = p.getString("athleteId", "");
        if (!athleteId.isEmpty()) batch.put("athleteId", athleteId);
        batch.put("samples", samples);
        return batch;
    }

    private boolean postBatch(
            SharedPreferences p, String sessionId, String deviceId, JSONArray samples) {
        try {
            return postBatchJson(p, buildBatch(p, sessionId, deviceId, samples), true);
        } catch (Exception e) {
            Log.e(TAG, "postBatch build failed", e);
            recordUploadResult(-1, samples.length(), false);
            return false;
        }
    }

    private boolean postBatchJson(SharedPreferences p, JSONObject batch, boolean requeueOnFailure) {
        int sampleCount = 0;
        try {
            JSONArray samples = batch.getJSONArray("samples");
            sampleCount = samples.length();
            String ingestUrl = p.getString("ingestUrl", "");
            if (ingestUrl.isEmpty()) {
                recordUploadResult(-1, sampleCount, false);
                return false;
            }
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
            boolean ok = code >= 200 && code < 300;
            recordUploadResult(code, sampleCount, ok);
            if (!ok) {
                Log.w(TAG, "Ingest HTTP " + code);
                if (requeueOnFailure) enqueuePendingBatch(p, batch);
            }
            return ok;
        } catch (Exception e) {
            recordUploadResult(-1, sampleCount, false);
            Log.e(TAG, "Ingest POST failed", e);
            if (requeueOnFailure) enqueuePendingBatch(p, batch);
            return false;
        }
    }

    private void enqueuePendingBatch(SharedPreferences p, JSONObject batch) {
        try {
            JSONArray queue = new JSONArray(p.getString(PENDING_BATCHES_KEY, "[]"));
            queue.put(batch);
            while (queue.length() > MAX_PENDING_BATCHES) {
                queue.remove(0);
            }
            p.edit().putString(PENDING_BATCHES_KEY, queue.toString()).apply();
        } catch (Exception e) {
            Log.e(TAG, "enqueuePendingBatch failed", e);
        }
    }

    private void flushPendingIngest(SharedPreferences p) {
        try {
            JSONArray queue = new JSONArray(p.getString(PENDING_BATCHES_KEY, "[]"));
            if (queue.length() == 0) return;
            JSONArray remaining = new JSONArray();
            int sent = 0;
            for (int i = 0; i < queue.length(); i++) {
                JSONObject batch = queue.getJSONObject(i);
                if (postBatchJson(p, batch, false)) {
                    sent++;
                } else {
                    remaining.put(batch);
                }
                if (sent >= MAX_PENDING_FLUSH_PER_CYCLE) {
                    for (int j = i + 1; j < queue.length(); j++) {
                        remaining.put(queue.getJSONObject(j));
                    }
                    break;
                }
            }
            p.edit().putString(PENDING_BATCHES_KEY, remaining.toString()).apply();
            if (sent > 0) {
                Log.i(
                    TAG,
                    "Flushed "
                        + sent
                        + " pending ingest batch(es), "
                        + remaining.length()
                        + " left");
            }
        } catch (Exception e) {
            Log.e(TAG, "flushPendingIngest failed", e);
        }
    }

    private void recordUploadResult(int httpCode, int sampleCount, boolean ok) {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        int seq = p.getInt("uploadSeq", 0) + 1;
        SharedPreferences.Editor ed =
            p.edit()
                .putInt("uploadSeq", seq)
                .putLong("lastUploadT", System.currentTimeMillis())
                .putBoolean("lastUploadOk", ok)
                .putInt("lastUploadCode", httpCode)
                .putInt("lastUploadSamples", sampleCount);
        if (ok) {
            ed.putInt("uploadOkCount", p.getInt("uploadOkCount", 0) + 1);
        } else {
            ed.putInt("uploadFailCount", p.getInt("uploadFailCount", 0) + 1);
        }
        ed.apply();
    }

    private void saveLastGpsToPrefs(Location location, long t, int count) {
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putLong("lastGpsT", t)
            .putFloat("lastGpsLat", (float) location.getLatitude())
            .putFloat("lastGpsLon", (float) location.getLongitude())
            .putFloat(
                "lastGpsSpd",
                location.hasSpeed() && location.getSpeed() >= 0f ? location.getSpeed() : -1f)
            .putInt("nativeGpsCount", count)
            .apply();
    }

    private void saveConfigFromIntent(Intent intent) {
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putString("sessionId", intent.getStringExtra("sessionId"))
            .putString("deviceId", intent.getStringExtra("deviceId"))
            .putString("ingestUrl", intent.getStringExtra("ingestUrl"))
            .putString("ingestToken", intent.getStringExtra("ingestToken"))
            .putString("athleteId", intent.getStringExtra("athleteId"))
            .putBoolean("enableGps", intent.getBooleanExtra("enableGps", false))
            .putBoolean("enableMotion", intent.getBooleanExtra("enableMotion", true))
            .putLong("gpsIntervalMs", intent.getLongExtra("gpsIntervalMs", 1000L))
            .putInt("uploadSeq", 0)
            .putInt("uploadOkCount", 0)
            .putInt("uploadFailCount", 0)
            .putString(PENDING_BATCHES_KEY, "[]")
            .putInt("pendingBatchCount", 0)
            .apply();
    }

    private void loadSessionFlagsFromPrefs() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        enableGps = p.getBoolean("enableGps", false);
        enableMotion = p.getBoolean("enableMotion", true);
        gpsIntervalMs = Math.max(500L, p.getLong("gpsIntervalMs", 1000L));
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

    /** Reject null-island / invalid coords only (accuracy filtered server-side for smoothing). */
    private static boolean isGpsFixUsable(Location location) {
        if (location == null) return false;
        double lat = location.getLatitude();
        double lon = location.getLongitude();
        if (Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4) return false;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
        return true;
    }

    private void registerLocation() {
        if (locationManager == null) {
            Log.e(TAG, "No LocationManager");
            return;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            Log.e(TAG, "ACCESS_FINE_LOCATION not granted — native GPS disabled");
            return;
        }
        long minTime = Math.max(500L, gpsIntervalMs);
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER, minTime, 0f, this, mainHandler.getLooper());
            }
            Location last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (last != null && isGpsFixUsable(last)) {
                onLocationChanged(last);
            }
            Log.i(TAG, "Native GPS updates registered (" + minTime + "ms, GPS provider only)");
        } catch (SecurityException e) {
            Log.e(TAG, "Location permission error", e);
        }
    }

    private void unregisterLocation() {
        if (locationManager != null) {
            try {
                locationManager.removeUpdates(this);
            } catch (SecurityException ignored) {
            }
        }
    }

    private void acquireWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm == null) return;
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RNZ::SessionRecorder");
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
                "Session recording (native)",
                NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("GPS and capsize monitoring while recording");
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(ch);

        NotificationChannel alertCh =
            new NotificationChannel(
                CHANNEL_ID + "_alert",
                "Capsize alerts",
                NotificationManager.IMPORTANCE_HIGH);
        alertCh.enableVibration(true);
        if (nm != null) nm.createNotificationChannel(alertCh);
    }

    private Notification buildForegroundNotification() {
        Intent launch = new Intent(this, MainActivity.class);
        PendingIntent pi =
            PendingIntent.getActivity(
                this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String detail;
        if (enableGps && enableMotion) {
            detail = "GPS + capsize — runs with screen off";
        } else if (enableGps) {
            detail = "GPS tracking — runs with screen off";
        } else {
            detail = "Capsize monitoring — runs with screen off";
        }
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("RNZ session recording")
            .setContentText(detail)
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
            new NotificationCompat.Builder(this, CHANNEL_ID + "_alert")
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
