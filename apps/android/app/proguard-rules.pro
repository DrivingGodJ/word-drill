# Keep @JavascriptInterface methods
-keepattributes *Annotation*
-keepclassmembers class com.drivinggodj.worddrill.MainActivity$AndroidBridge {
    @android.webkit.JavascriptInterface <methods>;
}
