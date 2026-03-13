import { StatusBar } from 'expo-status-bar';
import { StyleSheet, SafeAreaView, Platform, BackHandler, PermissionsAndroid } from 'react-native';
import { WebView } from 'react-native-webview';
import { useRef, useEffect, useCallback } from 'react';
import Constants from 'expo-constants';

// ⚠️ 수정금지(승인필요): 2026-03-11 네이티브 브릿지용 모듈 import
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import * as SecureStore from 'expo-secure-store';
import * as Localization from 'expo-localization';

// ⚠️ 수정금지(승인필요): 2026-03-11 fallback URL에 "1" 누락 수정 — 실제 도메인은 my-handyguide1.replit.app
const WEB_APP_URL = Constants.expoConfig?.extra?.webAppUrl || 'https://my-handyguide1.replit.app';

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

  // ⚠️ 수정금지(승인필요): 2026-03-11 네이티브 → 웹 응답 전송 함수
  const sendToWeb = useCallback((type, payload) => {
    if (webViewRef.current) {
      const data = JSON.stringify({ type, ...payload });
      webViewRef.current.injectJavaScript(`
        (function() {
          window.dispatchEvent(new CustomEvent('nativeResponse', { detail: ${data} }));
        })();
        true;
      `);
    }
  }, []);

  // ⚠️ 수정금지(승인필요): 2026-03-11 웹 → 네이티브 메시지 처리 (onMessage 핸들러)
  const handleMessage = useCallback(async (event) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      const { type, payload } = message;

      switch (type) {
        // --- TTS (텍스트 음성 변환) ---
        case 'speak': {
          // ⚠️ 수정금지(승인필요): expo-speech 네이티브 TTS
          const { text, language = 'en-US', rate = 1.0, pitch = 1.0 } = payload;
          Speech.speak(text, { language, rate, pitch });
          break;
        }
        case 'stopSpeech': {
          Speech.stop();
          break;
        }
        case 'isSpeaking': {
          const speaking = await Speech.isSpeakingAsync();
          sendToWeb('isSpeaking', { speaking });
          break;
        }
        case 'getVoices': {
          const voices = await Speech.getAvailableVoicesAsync();
          sendToWeb('voices', { voices });
          break;
        }

        // --- 햅틱 (진동 피드백) ---
        case 'haptic': {
          // ⚠️ 수정금지(승인필요): expo-haptics 네이티브 햅틱
          const style = payload?.style || 'light';
          const styles = {
            light: Haptics.ImpactFeedbackStyle.Light,
            medium: Haptics.ImpactFeedbackStyle.Medium,
            heavy: Haptics.ImpactFeedbackStyle.Heavy,
          };
          await Haptics.impactAsync(styles[style] || styles.light);
          break;
        }
        case 'hapticNotification': {
          const notifType = payload?.notifType || 'success';
          const types = {
            success: Haptics.NotificationFeedbackType.Success,
            warning: Haptics.NotificationFeedbackType.Warning,
            error: Haptics.NotificationFeedbackType.Error,
          };
          await Haptics.notificationAsync(types[notifType] || types.success);
          break;
        }

        // --- 공유 ---
        case 'share': {
          // ⚠️ 수정금지(승인필요): expo-sharing 네이티브 공유 시트
          const { url, title } = payload;
          if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(url, { dialogTitle: title });
          }
          break;
        }

        // --- 클립보드 ---
        case 'clipboard': {
          // ⚠️ 수정금지(승인필요): expo-clipboard 네이티브 클립보드
          const { action, text: clipText } = payload;
          if (action === 'copy') {
            await Clipboard.setStringAsync(clipText);
            sendToWeb('clipboardResult', { success: true });
          } else if (action === 'paste') {
            const content = await Clipboard.getStringAsync();
            sendToWeb('clipboardResult', { content });
          }
          break;
        }

        // --- 위치 ---
        case 'getLocation': {
          // ⚠️ 수정금지(승인필요): expo-location 네이티브 위치
          const { status } = await Location.requestForegroundPermissionsAsync();
          if (status === 'granted') {
            const location = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            });
            sendToWeb('location', {
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
              accuracy: location.coords.accuracy,
            });
          } else {
            sendToWeb('location', { error: 'permission_denied' });
          }
          break;
        }

        // --- 이미지 피커 (카메라/갤러리) ---
        case 'pickImage': {
          // ⚠️ 수정금지(승인필요): expo-image-picker 네이티브 이미지 선택
          const { source = 'gallery' } = payload;
          let result;
          if (source === 'camera') {
            const { status } = await ImagePicker.requestCameraPermissionsAsync();
            if (status !== 'granted') {
              sendToWeb('imageResult', { error: 'permission_denied' });
              break;
            }
            result = await ImagePicker.launchCameraAsync({
              mediaTypes: ['images'],
              quality: 0.8,
              base64: true,
            });
          } else {
            const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (status !== 'granted') {
              sendToWeb('imageResult', { error: 'permission_denied' });
              break;
            }
            result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              quality: 0.8,
              base64: true,
            });
          }
          if (!result.canceled && result.assets?.[0]) {
            sendToWeb('imageResult', {
              uri: result.assets[0].uri,
              base64: result.assets[0].base64,
              width: result.assets[0].width,
              height: result.assets[0].height,
            });
          } else {
            sendToWeb('imageResult', { canceled: true });
          }
          break;
        }

        // --- 인증 캐시 (SecureStore) ---
        case 'secureStore': {
          // ⚠️ 수정금지(승인필요): expo-secure-store 네이티브 암호화 저장소 (인증 캐시 영구 보관)
          const { action: storeAction, key, value } = payload;
          if (storeAction === 'set') {
            await SecureStore.setItemAsync(key, value);
            sendToWeb('secureStoreResult', { success: true, key });
          } else if (storeAction === 'get') {
            const storedValue = await SecureStore.getItemAsync(key);
            sendToWeb('secureStoreResult', { key, value: storedValue });
          } else if (storeAction === 'delete') {
            await SecureStore.deleteItemAsync(key);
            sendToWeb('secureStoreResult', { success: true, key });
          }
          break;
        }

        // --- 언어/로케일 ---
        case 'getLocale': {
          // ⚠️ 수정금지(승인필요): expo-localization 디바이스 언어 정보
          const locales = Localization.getLocales();
          sendToWeb('locale', {
            languageCode: locales[0]?.languageCode,
            languageTag: locales[0]?.languageTag,
            regionCode: locales[0]?.regionCode,
          });
          break;
        }

        // --- 오버레이 닫기 (추천갤러리 리턴 문제 해결) ---
        case 'closeWindow': {
          // ⚠️ 수정금지(승인필요): window.close() 대신 네이티브에서 뒤로가기 처리
          if (webViewRef.current) {
            webViewRef.current.goBack();
          }
          break;
        }

        default:
          console.log('[Bridge] 알 수 없는 메시지 타입:', type);
      }
    } catch (error) {
      console.error('[Bridge] 메시지 처리 오류:', error);
    }
  }, [sendToWeb]);

  // ⚠️ 수정금지(승인필요): 2026-03-11 Android WebView 권한 요청 자동 허용 (카메라/마이크)
  const handlePermissionRequest = useCallback((request) => {
    request.grant(request.resources);
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
        onMessage={handleMessage}
        androidLayerType="hardware"
        onAndroidPermissionRequest={handlePermissionRequest}
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
