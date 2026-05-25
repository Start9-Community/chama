package app.chama.market;

import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String PREFS_NAME = "chama_native";
    private static final String ASSET_VERSION_KEY = "web_asset_version";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        clearWebViewCacheAfterAppUpdate();
        super.onCreate(savedInstanceState);
    }

    private void clearWebViewCacheAfterAppUpdate() {
        String currentVersion = getAppVersionName();
        if (currentVersion == null || currentVersion.isEmpty()) {
            return;
        }

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String previousVersion = prefs.getString(ASSET_VERSION_KEY, "");
        if (currentVersion.equals(previousVersion)) {
            return;
        }

        try {
            WebView webView = new WebView(this);
            webView.clearCache(true);
            webView.destroy();
        } catch (Exception ignored) {
            // Best effort: stale web assets should never block app startup.
        }

        prefs.edit().putString(ASSET_VERSION_KEY, currentVersion).apply();
    }

    private String getAppVersionName() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName;
        } catch (Exception ignored) {
            return null;
        }
    }
}
