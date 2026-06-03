package nz.org.rowing.recorder;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CapsizeMonitor")
public class CapsizeMonitorPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String sessionId = call.getString("sessionId");
        String deviceId = call.getString("deviceId");
        String ingestUrl = call.getString("ingestUrl");
        if (sessionId == null || deviceId == null || ingestUrl == null) {
            call.reject("sessionId, deviceId, and ingestUrl are required");
            return;
        }
        Intent intent = new Intent(getContext(), CapsizeMonitorService.class);
        intent.putExtra("sessionId", sessionId);
        intent.putExtra("deviceId", deviceId);
        intent.putExtra("ingestUrl", ingestUrl);
        intent.putExtra("ingestToken", call.getString("ingestToken", ""));
        intent.putExtra("athleteId", call.getString("athleteId", ""));
        intent.putExtra("enableGps", call.getBoolean("enableGps", false));
        intent.putExtra("enableMotion", call.getBoolean("enableMotion", true));
        intent.putExtra("gpsIntervalMs", call.getInt("gpsIntervalMs", 1000));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), CapsizeMonitorService.class);
        getContext().stopService(intent);
        call.resolve();
    }

    @PluginMethod
    public void setStrokeRate(PluginCall call) {
        Double spm = call.getDouble("spm");
        if (spm == null) {
            call.reject("spm required");
            return;
        }
        CapsizeMonitorService.setStrokeRate(getContext(), spm.floatValue());
        call.resolve();
    }

    @PluginMethod
    public void setUpright(PluginCall call) {
        Double x = call.getDouble("x");
        Double y = call.getDouble("y");
        Double z = call.getDouble("z");
        if (x == null || y == null || z == null) {
            call.reject("x, y, z required");
            return;
        }
        CapsizeMonitorService.setUpright(getContext(), x.floatValue(), y.floatValue(), z.floatValue());
        call.resolve();
    }

    @PluginMethod
    public void setLiveMapMode(PluginCall call) {
        Boolean active = call.getBoolean("active", false);
        CapsizeMonitorService.setLiveMapMode(getContext(), active != null && active);
        call.resolve();
    }

    @PluginMethod
    public void setEconomyMode(PluginCall call) {
        Boolean active = call.getBoolean("active", false);
        Integer gpsIntervalMs = call.getInt("gpsIntervalMs", 30000);
        Integer uploadIntervalMs = call.getInt("uploadIntervalMs", 30000);
        Boolean enableCapsize = call.getBoolean("enableCapsize", true);
        CapsizeMonitorService.setEconomyMode(
            getContext(),
            active != null && active,
            gpsIntervalMs != null ? gpsIntervalMs.longValue() : 30000L,
            uploadIntervalMs != null ? uploadIntervalMs.longValue() : 30000L,
            enableCapsize == null || enableCapsize);
        call.resolve();
    }

    @PluginMethod
    public void checkRecordingSetup(PluginCall call) {
        call.resolve(RecordingSetupHelper.buildStatus(getContext()));
    }

    @PluginMethod
    public void prepareRecording(PluginCall call) {
        RecordingSetupHelper.startPrepare(this, call);
    }

    @PluginMethod
    public void getPulse(PluginCall call) {
        SharedPreferences p =
            getContext().getSharedPreferences(CapsizeMonitorService.PREFS, android.content.Context.MODE_PRIVATE);
        JSObject ret = new JSObject();
        if (p.contains("lastGpsT")) {
            JSObject gps = new JSObject();
            gps.put("t", p.getLong("lastGpsT", 0L));
            gps.put("lat", p.getFloat("lastGpsLat", 0f));
            gps.put("lon", p.getFloat("lastGpsLon", 0f));
            float spd = p.getFloat("lastGpsSpd", -1f);
            if (spd >= 0f) gps.put("spd", spd);
            ret.put("lastGps", gps);
        }
        ret.put("nativeGpsCount", p.getInt("nativeGpsCount", 0));
        if (p.contains("lastUploadT")) {
            JSObject upload = new JSObject();
            upload.put("seq", p.getInt("uploadSeq", 0));
            upload.put("ok", p.getBoolean("lastUploadOk", false));
            upload.put("code", p.getInt("lastUploadCode", 0));
            upload.put("samples", p.getInt("lastUploadSamples", 0));
            upload.put("okCount", p.getInt("uploadOkCount", 0));
            upload.put("failCount", p.getInt("uploadFailCount", 0));
            ret.put("upload", upload);
        }
        try {
            org.json.JSONArray pending =
                new org.json.JSONArray(p.getString("pendingIngestBatches", "[]"));
            ret.put("pendingIngestBatches", pending.length());
        } catch (Exception ignored) {
            ret.put("pendingIngestBatches", 0);
        }
        call.resolve(ret);
    }
}
