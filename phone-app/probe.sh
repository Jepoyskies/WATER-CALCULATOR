#!/usr/bin/env bash
# Temporary: works out why d8 refuses MainActivity$LocalFiles.class.
# Prints one PROBE line per variant so the answer is in the job log.

set -u

SDK="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
D8="$SDK/build-tools/34.0.0/d8"
ANDROID_JAR="$SDK/platforms/android-34/android.jar"
SRC="phone-app/android/src/ph/watercalc/app/MainActivity.java"
WORK="$(mktemp -d)"

echo "toolchain: $(which javac) / $D8 / $ANDROID_JAR"
javac -version 2>&1

compile() {
    local out="$1"; shift
    rm -rf "$out"; mkdir -p "$out"
    javac -encoding UTF-8 -nowarn "$@" -classpath "$ANDROID_JAR" -d "$out" "$SRC" 2>&1 | head -n 5
    return ${PIPESTATUS[0]}
}

run_d8() {
    local label="$1"; local classes="$2"; shift 2
    if [ ! -d "$classes" ] || [ -z "$(ls -A "$classes" 2>/dev/null)" ]; then
        echo "PROBE $label: javac FAILED"
        return
    fi
    local dex="$WORK/dex-$label"
    rm -rf "$dex"; mkdir -p "$dex"
    local err
    err=$("$D8" --release --min-api 21 --lib "$ANDROID_JAR" --output "$dex" "$classes/ph/watercalc/app/"*.class 2>&1)
    if [ $? -eq 0 ]; then
        echo "PROBE $label: d8 OK"
    else
        echo "PROBE $label: d8 FAILED -- $(echo "$err" | grep -m1 -E 'NullPointerException|CompilationFailed|error:')"
    fi
}

# --- flag variants, handing d8 the .class files directly ------------------
for variant in "release8:--release 8" "source8target8:-source 8 -target 8" \
               "release11:--release 11" "release17:--release 17" "default:-g"; do
    label="${variant%%:*}"
    flags="${variant#*:}"
    classes="$WORK/classes-$label"
    compile "$classes" $flags > /dev/null
    run_d8 "$label" "$classes"
done

# --- the same classes, but wrapped in a jar first -------------------------
classes="$WORK/classes-release8"
if [ -d "$classes" ]; then
    rm -rf "$WORK/jarout"; mkdir -p "$WORK/jarout"
    (cd "$classes" && jar cf "$WORK/jarout/classes.jar" .)
    dex="$WORK/dex-jar"
    rm -rf "$dex"; mkdir -p "$dex"
    if "$D8" --release --min-api 21 --lib "$ANDROID_JAR" --output "$dex" "$WORK/jarout/classes.jar" > /dev/null 2>&1; then
        echo "PROBE jar-release8: d8 OK"
    else
        echo "PROBE jar-release8: d8 FAILED"
    fi
fi

# --- is it inner classes in general, or this one specifically? ------------
cat > "$WORK/Tiny.java" <<'JAVA'
package probe;
import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
public class Tiny extends Activity {
    private class Inner extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
            return null;
        }
    }
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        WebView w = new WebView(this);
        w.setWebViewClient(new Inner());
        setContentView(w);
    }
}
JAVA

rm -rf "$WORK/tiny"; mkdir -p "$WORK/tiny"
if javac -encoding UTF-8 -nowarn --release 8 -classpath "$ANDROID_JAR" -d "$WORK/tiny" "$WORK/Tiny.java" 2>/dev/null; then
    rm -rf "$WORK/dex-tiny"; mkdir -p "$WORK/dex-tiny"
    if "$D8" --release --min-api 21 --lib "$ANDROID_JAR" --output "$WORK/dex-tiny" "$WORK/tiny/probe/"*.class > /dev/null 2>&1; then
        echo "PROBE tiny-inner-class: d8 OK  (so inner classes are fine - it is something in MainActivity)"
    else
        echo "PROBE tiny-inner-class: d8 FAILED  (inner classes themselves break this d8)"
    fi
else
    echo "PROBE tiny-inner-class: javac FAILED"
fi

echo "probe finished"
