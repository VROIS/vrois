import { StatusBar } from 'expo-status-bar';
import { StyleSheet, SafeAreaView, Platform, BackHandler, PermissionsAndroid } from 'react-native';
import { WebView } from 'react-native-webview';
import { useRef, useEffect } from 'react';
import Constants from 'expo-constants';

const WEB_APP_URL = Constants.expoConfig?.extra?.webAppUrl || 'https://my-handyguide.replit.app';

// iOS: 기본 Safari UA 사용 (Apple 심사에서 UA 위조 시 거절 가능)
// Android: Chrome UA 강제 (WebView 호환성)
const ANDROID_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 10; Android SDK built for x86) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36';

const INJECTED_JS = `
(function() {
  var style = document.createElement('style');
  style.textContent = 
    'body { padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }' +
    '.footer-safe-area { padding-bottom: env(safe-area-inset-bottom) !important; }' +
    '.gallery-footer { padding-bottom: env(safe-area-inset-bottom) !important; }' +
    '.bottom-nav { padding-bottom: env(safe-area-inset-bottom) !important; }' +
    '.fixed-bottom, [style*="position: fixed"][style*="bottom"] { padding-bottom: env(safe-area-inset-bottom) !important; }';
  document.head.appendChild(style);
})();
true;
`;

async function requestAndroidPermissions() {
  if (Platform.OS !== 'android') return;
  try {
    await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
  } catch (err) {
    console.warn('Permission request error:', err);
  }
}

export default function App() {
  const webViewRef = useRef(null);

  useEffect(() => {
    requestAndroidPermissions();

    if (Platform.OS === 'android') {
      const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
        if (webViewRef.current) {
          webViewRef.current.goBack();
          return true;
        }
        return false;
      });
      return () => backHandler.remove();
    }
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" backgroundColor="#4285F4" />
      <WebView
        ref={webViewRef}
        source={{ uri: WEB_APP_URL }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
        allowsBackForwardNavigationGestures={true}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        geolocationEnabled={true}
        cacheEnabled={true}
        originWhitelist={['*']}
        mixedContentMode="compatibility"
        sharedCookiesEnabled={true}
        thirdPartyCookiesEnabled={true}
        mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
        injectedJavaScript={INJECTED_JS}
        {...(Platform.OS === 'android' && { userAgent: ANDROID_USER_AGENT })}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#4285F4',
  },
  webview: {
    flex: 1,
  },
});
