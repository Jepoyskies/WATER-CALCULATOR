package ph.watercalc.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.util.HashMap;

/**
 * Water Delivery Manager as a real Android app.
 *
 * The whole web app is packaged inside the APK, so this never needs a network
 * connection - not on the first run, not ever.
 *
 * Why the app serves its own files instead of loading them off the disk:
 *
 *   IndexedDB (where every sheet, customer and payment is stored) is not
 *   available to pages loaded from file:// - the browser treats them as having
 *   no origin and refuses. So instead the files are served over a made-up
 *   https address. As far as the WebView is concerned the app is a normal
 *   secure website, which means IndexedDB, localStorage and everything else
 *   behave exactly as they do in Chrome - except the storage now belongs to
 *   this app alone. Clearing Chrome on the phone cannot touch it.
 */
public class MainActivity extends Activity {

    /**
     * A hostname that can never really exist (".invalid" is reserved by
     * RFC 2606), so there is no chance of this accidentally reaching the
     * network or shadowing a real site.
     */
    private static final String ORIGIN = "https://watercalc.invalid/";
    private static final String HOME = "index.html";

    private WebView web;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        getWindow().setStatusBarColor(Color.parseColor("#025aa5"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#f4f7f6"));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);        // localStorage: the draft autosave
        settings.setDatabaseEnabled(true);          // IndexedDB: all the real data
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(false);         // respect the app's own viewport tag

        web.setWebViewClient(new LocalFiles());

        setContentView(web);

        if (saved == null) {
            web.loadUrl(ORIGIN + HOME);
        } else {
            web.restoreState(saved);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        // Let the in-app back button win first, so a half-typed sheet is not lost
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private class LocalFiles extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            URL url = request.getUrl();
            if (url == null) return null;

            String host = url.getHost();
            if (host == null || !host.equals("watercalc.invalid")) return null;

            return serve(url.getPath());
        }

        /** On some older WebViews the first load is not intercepted - catch it here. */
        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame() && view.getUrl() != null
                    && view.getUrl().startsWith(ORIGIN)) {
                view.loadDataWithBaseURL(ORIGIN, readHome(), "text/html", "utf-8", null);
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            URL url = request.getUrl();
            return url != null && leaveForBrowser(url.toString());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return leaveForBrowser(url);
        }

        /** Hand anything that is not ours to the phone's browser. */
        private boolean leaveForBrowser(String url) {
            if (url == null || url.startsWith(ORIGIN)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
                // no browser installed - nothing we can do, just swallow it
            }
            return true;
        }
    }

    private WebResourceResponse serve(String path) {
        if (path == null || path.length() == 0 || path.equals("/")) path = "/" + HOME;

        String name = path.startsWith("/") ? path.substring(1) : path;
        if (name.contains("..")) return null;           // never step outside assets/www

        try {
            InputStream in = getAssets().open("www/" + name);
            return new WebResourceResponse(mimeOf(name), "utf-8", in);
        } catch (IOException missing) {
            // A missing favicon is not worth an error page
            if (name.equals("favicon.ico")) {
                return new WebResourceResponse("image/png", null,
                        new ByteArrayInputStream(new byte[0]));
            }
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                    new HashMap<String, String>(), null);
        }
    }

    private String readHome() {
        try {
            InputStream in = getAssets().open("www/" + HOME);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            in.close();
            return new String(out.toByteArray(), "UTF-8");
        } catch (IOException err) {
            return "<h1>The app files are missing.</h1>";
        }
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html")) return "text/html";
        if (n.endsWith(".js")) return "application/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".webmanifest")) return "application/manifest+json";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".woff2")) return "font/woff2";
        if (n.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }
}
