package ph.watercalc.app;

import android.app.Activity;
import android.content.Intent;
import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;

/**
 * Serves the app's own files to the WebView over a made-up https address,
 * instead of letting it read them off the disk.
 *
 * The reason is storage. IndexedDB - where every sheet, customer and payment
 * is kept - is not available to pages loaded from file://, because a browser
 * treats those as having no origin and refuses to store anything against
 * them. Going through a real https origin means IndexedDB, localStorage and
 * the rest behave exactly as they do in Chrome, except that the storage now
 * belongs to this one app. Clearing Chrome on the phone cannot reach it.
 *
 * This is deliberately its own class rather than one nested inside
 * MainActivity. javac adds a MethodParameters attribute to an inner class's
 * constructor to name the synthetic reference to the outer class, and the d8
 * that ships with build-tools 34 crashes on that attribute, so nesting the
 * two together simply cannot be built.
 */
class AssetSite extends WebViewClient {

    /**
     * ".invalid" is reserved by RFC 2606 and can never resolve, so there is no
     * chance of this reaching the network or shadowing a real site. Every
     * request for it is answered from the APK, and nothing else ever is.
     */
    static final String HOST = "watercalc.invalid";
    static final String ORIGIN = "https://" + HOST + "/";
    static final String HOME = "index.html";

    private final Activity activity;
    private final AssetManager assets;

    AssetSite(Activity activity) {
        this.activity = activity;
        this.assets = activity.getAssets();
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri == null) return null;

        String host = uri.getHost();
        if (host == null || !host.equals(HOST)) return null;

        return serve(uri.getPath());
    }

    /**
     * Safety net. Every WebView since Android 5 hands the first page load to
     * shouldInterceptRequest too, but if one ever does not, the request goes
     * out to a hostname that cannot resolve, lands here, and gets answered
     * from the APK instead.
     *
     * This uses the older form of the callback on purpose. The newer one takes
     * a WebResourceError, a class that does not exist before Android 6, and
     * merely naming it in a method signature is enough to stop a class from
     * loading on an older phone - which is exactly the phone this is here for.
     */
    @SuppressWarnings("deprecation")
    @Override
    public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
        if (failingUrl != null && failingUrl.startsWith(ORIGIN)) {
            view.loadDataWithBaseURL(ORIGIN, read(HOME), "text/html", "utf-8", null);
        }
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        return uri != null && leaveForBrowser(uri.toString());
    }

    @SuppressWarnings("deprecation")
    @Override
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return leaveForBrowser(url);
    }

    /** Anything that is not ours belongs in the phone's own browser. */
    private boolean leaveForBrowser(String url) {
        if (url == null || url.startsWith(ORIGIN)) return false;
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
            // no browser installed - nothing to do but swallow it
        }
        return true;
    }

    private WebResourceResponse serve(String path) {
        if (path == null || path.length() == 0 || path.equals("/")) path = "/" + HOME;

        String name = path.startsWith("/") ? path.substring(1) : path;
        if (name.contains("..")) return null;    // never step outside assets/www

        try {
            InputStream in = assets.open("www/" + name);
            return new WebResourceResponse(mimeOf(name), "utf-8", in);
        } catch (IOException missing) {
            if (name.equals("favicon.ico")) {
                // Not worth an error page
                return new WebResourceResponse("image/png", null, new ByteArrayInputStream(new byte[0]));
            }
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                    new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
        }
    }

    private String read(String assetName) {
        try {
            InputStream in = assets.open("www/" + assetName);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = in.read(buffer)) > 0) out.write(buffer, 0, count);
            in.close();
            return new String(out.toByteArray(), "UTF-8");
        } catch (IOException err) {
            return "<h1>The app's own files are missing.</h1>";
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
