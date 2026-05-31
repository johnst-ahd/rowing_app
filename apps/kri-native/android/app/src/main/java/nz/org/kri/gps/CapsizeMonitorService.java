package nz.org.kri.gps;

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
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.android.gms.tasks.CancellationTokenSource;
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
    public static final String PREFS = "kri_capsize_monitor";
    private static final String CHANNEL_ID = "kri_capsize_native";
    private static final int NOTIF_ID_FOREGROUND = 9101;
    private static final int NOTIF_ID_ALERT = 9102;
    private static final float GRAVITY_ALPHA = 0.04f;
    private static final float STILL_VAR_MAX = 0.35f;
    private static final int CALIBRATE_MIN_SAMPLES = 8;
    private static final long CALIBRATE_WINDOW_MS = 2500L;
    private static final long CAPSIZE_HOLD_MS = 400L;
    private static final long CAPSIZE_UPLOAD_MIN_INTERVAL_MS = 4000L;
    /** Batched ingest — fewer HTTP posts while GPS still samples at gpsIntervalMs. */
    private static final long UPLOAD_FLUSH_INTERVAL_MS = 3_000L;
    /** Live map mode — faster GPS on dashboard (~2 s flush). */
    private static final long LIVE_MAP_FLUSH_INTERVAL_MS = 2_000L;
    private static final int UPLOAD_FLUSH_MAX_SAMPLES = 12;
    /** Keeps dashboard "online" when GPS fixes pause (independent of gpsIntervalMs). */
    private static final long HEARTBEAT_INTERVAL_MS = 10_000L;
    /** Battery % on ingest — every 10 min (session start always includes a reading). */
    private static final long BATTERY_REPORT_INTERVAL_MS = 10L * 60L * 1000L;
    /** Motion samples queued into the ingest batch (no separate HTTP). */
    private static final long MOTION_POST_INTERVAL_MS = 2000L;
    /** Reject cached fixes older than this when uploading to ingest. */
    private static final long GPS_MAX_UPLOAD_FIX_AGE_MS = 45_000L;
    /** If Android fix clock lags more than this, timestamp sample at receive time. */
    private static final long GPS_STALE_FIX_CLOCK_MS = 8_000L;

    private SensorManager sensorManager;
    private Sensor accelerometer;
    private LocationManager locationManager;
    private FusedLocationProviderClient fusedClient;
    private LocationCallback fusedCallback;
    private PowerManager.WakeLock wakeLock;
    private ExecutorService uploadExecutor;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private JSONArray ingestBuffer = new JSONArray();
    private long lastIngestFlushMs;
    private long lastSuccessfulUploadMs;

    private boolean enableGps;
    private boolean enableMotion = true;
    private long gpsIntervalMs = 1000L;
    private boolean economyActive = false;
    private long economyGpsIntervalMs = 30_000L;
    private long economyUploadIntervalMs = 30_000L;
    private boolean liveMapActive = false;
    private boolean enableCapsizeDetection = true;

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
    private long lastBatteryReportMs;
    private Location latestGpsLocation;
    private long lastMotionPostMs;
    private long lastGpsUploadWallMs;
    private long lastUploadedFixTimeMs;
    private double lastUploadedLat = Double.NaN;
    private double lastUploadedLon = Double.NaN;
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
    private final Runnable ingestFlushRunnable =
            () -> {
                runOnUpload(() -> maybeAutoFlushIngest(false));
                scheduleIngestFlush();
            };
    private final Runnable heartbeatRunnable =
            () -> {
                if (uploadExecutor == null || uploadExecutor.isShutdown()) return;
                uploadExecutor.execute(() -> enqueueHeartbeatSample(System.currentTimeMillis()));
                scheduleHeartbeat();
            };
    private final Runnable motionPostRunnable =
            () -> {
                if (!enableMotion || uploadExecutor == null || uploadExecutor.isShutdown()) {
                    scheduleMotionPost();
                    return;
                }
                uploadExecutor.execute(() -> enqueueMotionSample(System.currentTimeMillis()));
                scheduleMotionPost();
            };
    private final Runnable gpsFlushRunnable =
            () -> {
                requestGpsFlush();
                scheduleGpsFlush();
            };

    @Override
    public void onCreate() {
        super.onCreate();
        sensorManager = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        if (sensorManager != null) {
            accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        }
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        fusedClient = LocationServices.getFusedLocationProviderClient(this);
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
        lastBatteryReportMs = 0L;
        lastMotionPostMs = 0L;
        lastIngestFlushMs = 0L;
        lastSuccessfulUploadMs = 0L;
        ingestBuffer = new JSONArray();
        startForeground(NOTIF_ID_FOREGROUND, buildForegroundNotification());
        acquireWakeLock();
        if (enableMotion) {
            registerSensor();
        }
        if (enableGps) {
            registerLocation();
            scheduleGpsFlush();
            requestGpsFlush();
        }
        uploadExecutor.execute(() -> enqueueSessionStartSample(System.currentTimeMillis()));
        scheduleHeartbeat();
        scheduleIngestFlush();
        if (enableMotion) {
            scheduleMotionPost();
        }
        Log.i(
            TAG,
            "Native session service started gps="
                + enableGps
                + " motion="
                + enableMotion
                + " intervalMs="
                + gpsIntervalMs
                + " heartbeatMs="
                + HEARTBEAT_INTERVAL_MS);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        mainHandler.removeCallbacks(ingestFlushRunnable);
        mainHandler.removeCallbacks(heartbeatRunnable);
        mainHandler.removeCallbacks(motionPostRunnable);
        mainHandler.removeCallbacks(gpsFlushRunnable);
        unregisterSensor();
        unregisterLocation();
        releaseWakeLock();
        if (uploadExecutor != null) {
            uploadExecutor.execute(this::flushIngestBufferNow);
            uploadExecutor.shutdown();
            try {
                uploadExecutor.awaitTermination(3, java.util.concurrent.TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
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
        deliverLocation(location);
    }

    private void cacheGpsLocation(Location location) {
        if (!enableGps || location == null) return;
        latestGpsLocation = location;
        saveLastGpsToPrefs(location, ingestTimeMs(location), nativeGpsCount);
    }

    private void deliverLocation(Location location) {
        if (!enableGps || location == null) return;
        cacheGpsLocation(location);
        maybeUploadGpsFix(location);
    }

    private static boolean isGpsFixUsable(Location location) {
        if (location == null) return false;
        double lat = location.getLatitude();
        double lon = location.getLongitude();
        if (Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4) return false;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
        return true;
    }

    private static boolean isGpsFixFresh(Location location) {
        if (location == null) return false;
        return System.currentTimeMillis() - location.getTime() <= GPS_MAX_UPLOAD_FIX_AGE_MS;
    }

    private static boolean sameCoords(Location a, double lat, double lon) {
        if (a == null || !Double.isFinite(lat)) return false;
        return Math.abs(a.getLatitude() - lat) < 1e-6 && Math.abs(a.getLongitude() - lon) < 1e-6;
    }

    /** Rate-limited upload on each fresh fused/legacy fix. */
    private void maybeUploadGpsFix(Location location) {
        if (!enableGps || location == null || !isGpsFixUsable(location)) return;
        if (!isGpsFixFresh(location)) return;
        long fixTime = location.getTime();
        long now = System.currentTimeMillis();
        if (now - lastGpsUploadWallMs < Math.max(500L, effectiveGpsIntervalMs())) return;
        if (fixTime <= lastUploadedFixTimeMs && sameCoords(location, lastUploadedLat, lastUploadedLon)) {
            return;
        }
        if (uploadExecutor == null || uploadExecutor.isShutdown()) return;

        lastGpsUploadWallMs = now;
        lastUploadedFixTimeMs = fixTime;
        lastUploadedLat = location.getLatitude();
        lastUploadedLon = location.getLongitude();
        nativeGpsCount++;
        saveLastGpsToPrefs(location, ingestTimeMs(location), nativeGpsCount);
        final Location uploadLoc = location;
        runOnUpload(() -> enqueueGpsSample(uploadLoc));
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
        loadEconomyFromPrefs();
        if (!enableCapsizeDetection) {
            if (capsizeActive) {
                capsizeActive = false;
                capsizeSinceMs = 0;
                cancelAlertNotification();
            }
            return;
        }
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
        uploadExecutor.execute(() -> enqueueCapsizeSample(t, ax, ay, az, tiltDeg));
    }

    private void runOnUpload(Runnable task) {
        if (uploadExecutor == null || uploadExecutor.isShutdown()) return;
        uploadExecutor.execute(task);
    }

    private void scheduleIngestFlush() {
        mainHandler.removeCallbacks(ingestFlushRunnable);
        mainHandler.postDelayed(ingestFlushRunnable, effectiveUploadFlushMs());
    }

    private void offerIngestSample(JSONObject sample, boolean flushNow) {
        ingestBuffer.put(sample);
        maybeAutoFlushIngest(flushNow);
    }

    private void maybeAutoFlushIngest(boolean force) {
        if (ingestBuffer.length() == 0) return;
        long now = System.currentTimeMillis();
        if (force
                || ingestBuffer.length() >= UPLOAD_FLUSH_MAX_SAMPLES
                || now - lastIngestFlushMs >= effectiveUploadFlushMs()) {
            flushIngestBufferNow();
        }
    }

    private void flushIngestBufferNow() {
        if (ingestBuffer.length() == 0) return;
        JSONArray toSend = ingestBuffer;
        ingestBuffer = new JSONArray();
        lastIngestFlushMs = System.currentTimeMillis();
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        String ingestUrl = p.getString("ingestUrl", "");
        String deviceId = p.getString("deviceId", "");
        String sessionId = p.getString("sessionId", "");
        if (ingestUrl.isEmpty() || deviceId.isEmpty() || sessionId.isEmpty()) {
            Log.e(TAG, "Missing ingest config — dropping " + toSend.length() + " buffered sample(s)");
            return;
        }
        try {
            postBatch(p, sessionId, deviceId, toSend);
            lastSuccessfulUploadMs = System.currentTimeMillis();
            Log.d(TAG, "Ingest batch OK (" + toSend.length() + " samples)");
        } catch (Exception e) {
            Log.e(TAG, "Ingest batch failed", e);
        }
    }

    private void enqueueGpsSample(Location location) {
        try {
            long t = ingestTimeMs(location);
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
            long now = System.currentTimeMillis();
            if (lastBatteryReportMs == 0L
                    || now - lastBatteryReportMs >= BATTERY_REPORT_INTERVAL_MS) {
                int batteryPct = readBatteryPct();
                if (batteryPct >= 0) {
                    JSONObject derived = new JSONObject();
                    derived.put("batteryPct", batteryPct);
                    sample.put("derived", derived);
                    lastBatteryReportMs = now;
                }
            }
            offerIngestSample(sample, false);
        } catch (Exception e) {
            Log.e(TAG, "GPS sample enqueue failed", e);
        }
    }

    private void enqueueSessionStartSample(long t) {
        try {
            JSONObject derived = new JSONObject();
            derived.put("heartbeat", true);
            int batteryPct = readBatteryPct();
            if (batteryPct >= 0) {
                derived.put("batteryPct", batteryPct);
                lastBatteryReportMs = t;
                Log.i(TAG, "Session start battery " + batteryPct + "%");
            }
            JSONObject sample = new JSONObject();
            sample.put("t", t);
            sample.put("derived", derived);
            offerIngestSample(sample, true);
        } catch (Exception e) {
            Log.e(TAG, "Session start telemetry failed", e);
        }
    }

    private void enqueueMotionSample(long t) {
        if (t - lastMotionPostMs < MOTION_POST_INTERVAL_MS) return;
        if (lastAx == 0f && lastAy == 0f && lastAz == 0f) return;
        lastMotionPostMs = t;
        try {
            JSONObject motion = new JSONObject();
            motion.put("ax", Math.round(lastAx * 100) / 100.0);
            motion.put("ay", Math.round(lastAy * 100) / 100.0);
            motion.put("az", Math.round(lastAz * 100) / 100.0);
            JSONObject sample = new JSONObject();
            sample.put("t", t);
            sample.put("motion", motion);
            offerIngestSample(sample, false);
        } catch (Exception e) {
            Log.e(TAG, "Motion sample enqueue failed", e);
        }
    }

    private void enqueueHeartbeatSample(long t) {
        if (lastSuccessfulUploadMs > 0L
                && t - lastSuccessfulUploadMs < HEARTBEAT_INTERVAL_MS - 1000L) {
            return;
        }
        try {
            JSONObject derived = new JSONObject();
            derived.put("heartbeat", true);
            boolean reportBattery =
                    lastBatteryReportMs == 0L
                            || t - lastBatteryReportMs >= BATTERY_REPORT_INTERVAL_MS;
            if (reportBattery) {
                int batteryPct = readBatteryPct();
                if (batteryPct >= 0) {
                    derived.put("batteryPct", batteryPct);
                    lastBatteryReportMs = t;
                    Log.i(TAG, "Including battery " + batteryPct + "% on heartbeat");
                }
            }
            JSONObject sample = new JSONObject();
            sample.put("t", t);
            sample.put("derived", derived);
            offerIngestSample(sample, false);
        } catch (Exception e) {
            Log.e(TAG, "Heartbeat sample enqueue failed", e);
        }
    }

    private void enqueueCapsizeSample(long t, float ax, float ay, float az, int tiltDeg) {
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
            offerIngestSample(sample, true);
            Log.i(TAG, "Capsize ingest queued");
        } catch (Exception e) {
            Log.e(TAG, "Capsize ingest failed", e);
        }
    }

    /** Timer backup — always requests a new fix; never uploads stale cache. */
    private void requestGpsFlush() {
        if (!enableGps) return;
        requestFreshGpsLocation(
                loc -> {
                    if (loc == null) return;
                    cacheGpsLocation(loc);
                    maybeUploadGpsFix(loc);
                });
    }

    private void requestFreshGpsLocation(java.util.function.Consumer<Location> onResult) {
        if (!enableGps) {
            onResult.accept(null);
            return;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            onResult.accept(null);
            return;
        }
        if (fusedClient != null) {
            CancellationTokenSource cts = new CancellationTokenSource();
            fusedClient
                    .getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.getToken())
                    .addOnSuccessListener(onResult::accept)
                    .addOnFailureListener(
                            e -> {
                                Log.w(TAG, "getCurrentLocation failed", e);
                                onResult.accept(null);
                            });
            return;
        }
        onResult.accept(null);
    }

    private int readBatteryPct() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            BatteryManager bm = (BatteryManager) getSystemService(BATTERY_SERVICE);
            if (bm != null) {
                int level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
                if (level >= 0 && level <= 100) return level;
            }
        }
        return -1;
    }

    private void postBatch(
            SharedPreferences p, String sessionId, String deviceId, JSONArray samples)
            throws Exception {
        String ingestUrl = p.getString("ingestUrl", "");
        JSONObject batch = new JSONObject();
        batch.put("sessionId", sessionId);
        batch.put("deviceId", deviceId);
        String athleteId = p.getString("athleteId", "");
        if (!athleteId.isEmpty()) batch.put("athleteId", athleteId);
        batch.put("samples", samples);

        String body = batch.toString();
        URL url = new URL(ingestUrl);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(8000);
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
        if (code < 200 || code >= 300) {
            Log.w(TAG, "Ingest HTTP " + code);
        }
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
            .apply();
    }

    private void loadSessionFlagsFromPrefs() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        enableGps = p.getBoolean("enableGps", false);
        enableMotion = p.getBoolean("enableMotion", true);
        gpsIntervalMs = Math.max(500L, p.getLong("gpsIntervalMs", 1000L));
        loadEconomyFromPrefs();
    }

    private void loadEconomyFromPrefs() {
        SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
        economyActive = p.getBoolean("economyActive", false);
        economyGpsIntervalMs = Math.max(5000L, p.getLong("economyGpsIntervalMs", 30_000L));
        economyUploadIntervalMs = Math.max(5000L, p.getLong("economyUploadIntervalMs", 30_000L));
        enableCapsizeDetection = p.getBoolean("enableCapsizeDetection", true);
        liveMapActive = p.getBoolean("liveMapActive", false);
    }

    private long effectiveGpsIntervalMs() {
        loadEconomyFromPrefs();
        return economyActive ? economyGpsIntervalMs : gpsIntervalMs;
    }

    private long effectiveUploadFlushMs() {
        loadEconomyFromPrefs();
        if (economyActive) return economyUploadIntervalMs;
        if (liveMapActive) return LIVE_MAP_FLUSH_INTERVAL_MS;
        return UPLOAD_FLUSH_INTERVAL_MS;
    }

    public static void setLiveMapMode(Context ctx, boolean active) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putBoolean("liveMapActive", active)
            .apply();
    }

    public static void setEconomyMode(
            Context ctx,
            boolean active,
            long gpsInterval,
            long uploadInterval,
            boolean enableCapsize) {
        ctx.getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putBoolean("economyActive", active)
            .putLong("economyGpsIntervalMs", Math.max(5000L, gpsInterval))
            .putLong("economyUploadIntervalMs", Math.max(5000L, uploadInterval))
            .putBoolean("enableCapsizeDetection", enableCapsize)
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

    private void scheduleHeartbeat() {
        mainHandler.removeCallbacks(heartbeatRunnable);
        mainHandler.postDelayed(heartbeatRunnable, HEARTBEAT_INTERVAL_MS);
    }

    private void scheduleMotionPost() {
        mainHandler.removeCallbacks(motionPostRunnable);
        mainHandler.postDelayed(motionPostRunnable, MOTION_POST_INTERVAL_MS);
    }

    private void registerSensor() {
        if (sensorManager == null || accelerometer == null) return;
        sensorManager.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_GAME);
    }

    private void unregisterSensor() {
        if (sensorManager != null) sensorManager.unregisterListener(this);
    }

    /**
     * Ingest timestamp: prefer Android fix time when fresh; otherwise receive time so
     * dashboard age does not climb when fix clock stalls but coords still update.
     */
    private static long ingestTimeMs(Location location) {
        long now = System.currentTimeMillis();
        if (location == null) return now;
        long fixTime = location.getTime();
        if (fixTime <= 0L || fixTime > now + 5_000L) return now;
        long fixAge = now - fixTime;
        if (fixAge > GPS_STALE_FIX_CLOCK_MS) return now;
        return fixTime;
    }

    private void scheduleGpsFlush() {
        mainHandler.removeCallbacks(gpsFlushRunnable);
        if (!enableGps) return;
        mainHandler.postDelayed(gpsFlushRunnable, Math.max(500L, effectiveGpsIntervalMs()));
    }

    private void registerLocation() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            Log.e(TAG, "ACCESS_FINE_LOCATION not granted — native GPS disabled");
            return;
        }
        unregisterLocation();
        registerFusedLocation();
    }

    private void registerFusedLocation() {
        if (fusedClient == null) {
            registerLegacyLocation();
            return;
        }
        long interval = Math.max(500L, effectiveGpsIntervalMs());
        LocationRequest request =
                new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, interval)
                        .setMinUpdateIntervalMillis(interval)
                        .setMaxUpdateDelayMillis(interval)
                        .setMaxUpdateAgeMillis(GPS_MAX_UPLOAD_FIX_AGE_MS)
                        .setWaitForAccurateLocation(false)
                        .build();
        fusedCallback =
                new LocationCallback() {
                    @Override
                    public void onLocationResult(@NonNull LocationResult result) {
                        Location loc = result.getLastLocation();
                        if (loc != null) deliverLocation(loc);
                    }
                };
        fusedClient
                .requestLocationUpdates(request, fusedCallback, Looper.getMainLooper())
                .addOnSuccessListener(
                        unused -> Log.i(TAG, "Fused location registered (" + interval + "ms)"))
                .addOnFailureListener(
                        e -> {
                            Log.w(TAG, "Fused location unavailable, using legacy", e);
                            registerLegacyLocation();
                        });
        fusedClient
                .getLastLocation()
                .addOnSuccessListener(
                        loc -> {
                            if (loc != null && isGpsFixFresh(loc)) {
                                deliverLocation(loc);
                            } else if (loc != null) {
                                cacheGpsLocation(loc);
                            }
                        });
    }

    private void registerLegacyLocation() {
        if (locationManager == null) {
            Log.e(TAG, "No LocationManager");
            return;
        }
        long minTime = Math.max(500L, effectiveGpsIntervalMs());
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                        LocationManager.GPS_PROVIDER, minTime, 0f, this, mainHandler.getLooper());
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(
                        LocationManager.NETWORK_PROVIDER, minTime, 0f, this, mainHandler.getLooper());
            }
            Location last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (last == null) {
                last = locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            }
            if (last != null && isGpsFixFresh(last)) {
                deliverLocation(last);
            } else if (last != null) {
                cacheGpsLocation(last);
            }
            Log.i(TAG, "Legacy location updates registered (" + minTime + "ms)");
        } catch (SecurityException e) {
            Log.e(TAG, "Location permission error", e);
        }
    }

    private void unregisterLocation() {
        if (fusedClient != null && fusedCallback != null) {
            fusedClient.removeLocationUpdates(fusedCallback);
            fusedCallback = null;
        }
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
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "KRI::SessionRecorder");
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
            .setContentTitle("KRI session recording")
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
