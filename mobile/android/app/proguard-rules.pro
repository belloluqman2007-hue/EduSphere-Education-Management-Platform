# Keep Capacitor's own annotations and the plugin surface intact.
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class app.edusphere.mobile.EduSphereNativePlugin { *; }
-keepclassmembers class app.edusphere.mobile.** { *; }
# The WebView talks to the page through @JavascriptInterface only.
-dontwarn org.apache.commons.**
