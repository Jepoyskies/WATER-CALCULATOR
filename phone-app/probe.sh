#!/usr/bin/env bash
# Temporary round 2: inner classes extending WebViewClient are enough to kill
# this d8 on their own. Work out which half of that matters.

set -u

SDK="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
D8="$SDK/build-tools/34.0.0/d8"
ANDROID_JAR="$SDK/platforms/android-34/android.jar"
WORK="$(mktemp -d)"

mkdir -p "$WORK/src/probe"

# --- one file per shape ---------------------------------------------------

cat > "$WORK/src/probe/TopLevel.java" <<'JAVA'
package probe;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
public class TopLevel extends WebViewClient {
    @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
        return null;
    }
}
JAVA

cat > "$WORK/src/probe/StaticNested.java" <<'JAVA'
package probe;
import android.app.Activity;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
public class StaticNested extends Activity {
    static class Helper extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
            return null;
        }
    }
}
JAVA

cat > "$WORK/src/probe/InnerClass.java" <<'JAVA'
package probe;
import android.app.Activity;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
public class InnerClass extends Activity {
    private class Helper extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
            return null;
        }
    }
}
JAVA

cat > "$WORK/src/probe/InnerPlain.java" <<'JAVA'
package probe;
public class InnerPlain {
    private class Helper {
        int value() { return 1; }
    }
    int use() { return new Helper().value(); }
}
JAVA

# --- helpers --------------------------------------------------------------

build() {
    local name="$1"
    rm -rf "$WORK/out-$name"; mkdir -p "$WORK/out-$name"
    javac -encoding UTF-8 -nowarn --release 8 -classpath "$ANDROID_JAR" \
        -d "$WORK/out-$name" "$WORK/src/probe/$name.java" 2>&1 | head -n 3
    if [ ! -d "$WORK/out-$name/probe" ]; then echo "   javac FAILED"; return 1; fi
    return 0
}

try_d8() {
    local label="$1"; local name="$2"; shift 2
    local dex="$WORK/dex-$label"
    rm -rf "$dex"; mkdir -p "$dex"
    local err
    err=$("$D8" "$@" --lib "$ANDROID_JAR" --output "$dex" "$WORK/out-$name/probe/"*.class 2>&1)
    if [ $? -eq 0 ]; then
        echo "PROBE $label: d8 OK"
    else
        echo "PROBE $label: d8 FAILED"
    fi
}

echo "=== shapes (all with --release --min-api 21) ==="
for name in TopLevel StaticNested InnerClass InnerPlain; do
    if build "$name"; then
        try_d8 "$name" "$name" --release --min-api 21
    else
        echo "PROBE $name: javac FAILED"
    fi
done

echo ""
echo "=== does it still happen without --release / with a different min-api? ==="
build InnerClass > /dev/null && try_d8 "InnerClass-noRelease" InnerClass --min-api 21
build InnerClass > /dev/null && try_d8 "InnerClass-minApi24"  InnerClass --release --min-api 24
build InnerClass > /dev/null && try_d8 "InnerClass-minApi34"  InnerClass --release --min-api 34
build InnerClass > /dev/null && try_d8 "InnerClass-noDesugar" InnerClass --release --min-api 21 --no-desugaring

echo ""
echo "=== what is actually in the failing class file ==="
javap -v -p "$WORK/out-InnerClass/probe/InnerClass\$Helper.class" 2>&1 |
    grep -E "^  (major|minor|flags)|SourceFile|InnerClasses|EnclosingMethod|Signature|RuntimeVisible" |
    head -n 20
echo "--- constant pool entries that look like names ---"
javap -v -p "$WORK/out-InnerClass/probe/InnerClass\$Helper.class" 2>&1 |
    grep -E "= Utf8" | head -n 25

echo ""
echo "=== full stack trace from d8 on that class ==="
rm -rf "$WORK/dex-stack"; mkdir -p "$WORK/dex-stack"
"$D8" --release --min-api 21 --lib "$ANDROID_JAR" --output "$WORK/dex-stack" \
    "$WORK/out-InnerClass/probe/"*.class 2>&1 | head -n 30

echo ""
echo "=== which d8 is this ==="
head -n 20 "$D8"
echo "probe2 finished"
