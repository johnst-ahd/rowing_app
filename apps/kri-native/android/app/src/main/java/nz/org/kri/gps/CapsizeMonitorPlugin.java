package nz.org.kri.gps;

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
        call.resolve(ret);
    }
}
