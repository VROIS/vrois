import express, { type Request, Response, NextFunction } from "express";
import compression from "compression";
import { registerRoutes } from "./routes";
import { storage } from "./storage";
import fs from 'fs';
import path from 'path';

const app = express();

// 프록시 신뢰 설정 - HTTPS 쿠키 정상 동작 (세션 유지)
app.set("trust proxy", 1);

// 🚀 Gzip 압축 - 모든 응답 자동 압축 (파일 크기 60-70% 감소)
app.use(compression({ level: 6 }));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

// Simple logging function
const log = (message: string) => {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${timestamp} [express] ${message}`);
};

// Basic request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    // Log ALL requests temporarily to debug /s/:id issue
    log(`${req.method} ${req.path} ${res.statusCode} in ${duration}ms`);
  });
  next();
});

// 🔧 [CRITICAL] /s/:id 라우트 - express.static()보다 먼저 등록!
// ⚠️ MUST be registered OUTSIDE the async IIFE!
// Express route registration is SYNCHRONOUS - async IIFE runs later
app.get('/s/:id', async (req, res) => {
  try {
    const { id } = req.params;
    log(`[SHARE] Request for ID: ${id}`);
    
    // DB에서 공유 페이지 조회
    const page = await storage.getSharedHtmlPage(id);
    
    if (!page) {
      log(`[SHARE] Page not found: ${id}`);
      return res.status(404).send('Not Found');
    }
    
    if (!page.isActive) {
      log(`[SHARE] Page inactive: ${id}`);
      return res.status(410).send('Link Expired');
    }
    
    // 조회수 증가
    await storage.incrementDownloadCount(id);
    
    // HTML 반환
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
    
    // ═══════════════════════════════════════════════════════════════
    // 🔧 App Storage 마이그레이션 (2025-11-23)
    // ═══════════════════════════════════════════════════════════════
    // 변경: DB htmlContent 우선 → htmlFilePath fallback (하위 호환성)
    // 이유: Production 환경에서 파일 시스템은 ephemeral (재배포 시 삭제)
    // 해결: DB에 저장된 HTML을 우선 사용, 파일은 fallback만
    // ═══════════════════════════════════════════════════════════════
    
    // ═══════════════════════════════════════════════════════════════
    // 🎁 Referral 시스템: 공유페이지 생성자의 referralCode 주입 (2025-11-29)
    // ═══════════════════════════════════════════════════════════════
    // 공유페이지의 "나도 만들어보기" 버튼에 생성자의 referralCode 추가
    // 이 링크로 가입한 신규 사용자 → 공유페이지 생성자에게 리워드!
    // ═══════════════════════════════════════════════════════════════
    let creatorReferralCode = '';
    try {
      if (page.userId) {
        const creator = await storage.getUser(page.userId);
        if (creator?.referralCode) {
          creatorReferralCode = creator.referralCode;
          log(`[SHARE] 🎁 Creator referralCode: ${creatorReferralCode}`);
        }
      }
    } catch (refError) {
      log(`[SHARE] ⚠️ Could not get creator referralCode: ${refError}`);
    }
    
    // HTML에 referralCode 주입 + 버튼 문구 통일 + 구글 번역 쿠키 설정 함수
    const injectReferralAndUpdateButton = (html: string): string => {
      let result = html;
      
      // 0. 🌐 구글 번역 쿠키 설정 스크립트 주입 (구버전 페이지 호환!)
      // #googtrans(ko|언어코드) 해시 감지 → 쿠키 설정 (구글 번역 로드 전)
      const googTransScript = `
    <!-- 🌐 2025.12.03: 쿼리 파라미터로 구글 번역 쿠키 설정 (자동 번역용) -->
    <script>
        (function() {
            var params = new URLSearchParams(window.location.search);
            var lang = params.get('lang');
            if (lang && /^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) {
                var domain = window.location.hostname;
                document.cookie = 'googtrans=/ko/' + lang + ';path=/;domain=' + domain;
                document.cookie = 'googtrans=/ko/' + lang + ';path=/';
                console.log('🌐 Pre-set googtrans cookie for:', lang);
            }
        })();
    </script>`;
      
      // <head> 바로 뒤에 스크립트 삽입 (구글 번역 로드보다 먼저!)
      if (!result.includes('Pre-set googtrans cookie')) {
        result = result.replace(/<head>/i, '<head>' + googTransScript);
      }
      
      // 🌐 구글 번역 위젯 주입 (기존 페이지에 없는 경우만!)
      // 2025-12-27: pageLanguage 제거 → 자동 감지 (프랑스어 원본 등 다국어 지원)
      const googleTranslateWidget = `
    <!-- 🌐 2025.12.04: 구글 번역 위젯 자동 주입 (다국어 지원) -->
    <div id="google_translate_element" style="display:none;"></div>
    <script type="text/javascript">
        function googleTranslateElementInit() {
            new google.translate.TranslateElement({
                includedLanguages: 'ko,en,ja,zh-CN,fr,de,es',
                autoDisplay: false
            }, 'google_translate_element');
        }
    </script>
    <script type="text/javascript" src="//translate.google.com/translate_a/element.js?cb=googleTranslateElementInit"></script>
    <style>
        .skiptranslate { display: none !important; }
        body { top: 0 !important; }
    </style>`;
      
      // </body> 앞에 구글 번역 위젯 삽입 (없으면만!)
      if (!result.includes('google_translate_element')) {
        result = result.replace(/<\/body>/i, googleTranslateWidget + '</body>');
      }
      
      // 🎤 2025-12-25: TTS 차단 스크립트 제거됨
      // share-page.js에서 TTS 로직 전담 (appLanguage 우선, font 태그 추출)
      
      // 1. 버튼 문구 통일: 다양한 기존 문구 → "나도 만들어보기"
      // (이모지 제거, 모든 기존 페이지에 적용)
      result = result
        .replace(/손안에 가이드 시작하기/g, '나도 만들어보기')
        .replace(/나도 만들어보기\s*✨/g, '나도 만들어보기')
        .replace(/나도 만들어보기\s*\*/g, '나도 만들어보기');
      
      // 2. referralCode 주입 (생성자 코드가 있을 때만)
      if (creatorReferralCode) {
        // href="https://My-handyguide1.replit.app" → href="https://My-handyguide1.replit.app?ref=코드"
        result = result
          .replace(/href="(https:\/\/My-handyguide1\.replit\.app)(\/?)"/g, 
            `href="$1$2?ref=${creatorReferralCode}"`)
          .replace(/href='(https:\/\/My-handyguide1\.replit\.app)(\/?)'/g, 
            `href='$1$2?ref=${creatorReferralCode}'`);
      }
      
      // ⚠️ 수정금지(승인필요): 2026-03-08 X 닫기 버튼만 유지
      // ← 리턴 버튼 주입 제거. closeWindowBtn(X 버튼)은 template에서 생성, 그대로 유지.
      // 기존 DB에 저장된 HTML 중 ← 리턴(shareReturnBtn)이 있으면 제거
      result = result.replace(/<button[^>]*id\s*=\s*["']?shareReturnBtn["']?[^>]*>[\s\S]*?<\/button>/gi, '');
      // 기존 DB에 저장된 HTML 중 featured ← sticky bar가 있으면 제거
      result = result.replace(/<div[^>]*style="[^"]*position:\s*sticky[^"]*background:\s*#4285F4[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
      // 기존 DB HTML에 closeWindowBtn이 없으면 추가 (이전 런타임이 제거한 경우 대비)
      if (!result.includes('closeWindowBtn')) {
        const closeButtonHTML = `<button id="closeWindowBtn" onclick="window.close()" title="페이지 닫기" style="position: fixed; top: 1rem; right: 1rem; z-index: 10000; width: 3rem; height: 3rem; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(8px); border-radius: 50%; color: #4285F4; cursor: pointer; transition: all 0.2s ease; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); border: none;"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg></button>`;
        result = result.replace(/<body>/i, '<body>' + closeButtonHTML);
      }

      // 4. TTS 음성 최적화 스크립트 주입 (한국어 하드코딩 + 다른언어 저장된 voiceName)
      const ttsVoiceOptimizationScript = `
    <!-- 🔊 2025.12.15: TTS 음성 최적화 (한국어 하드코딩: Yuna→Sora→유나→소라→Heami) -->
    <script>
        (function() {
            // 언어별 최적 음성 찾기
            window.getOptimalVoice = function(langCode, voices, savedVoiceName) {
                var allVoices = voices || speechSynthesis.getVoices();
                var targetVoice = null;
                
                // ⭐ 한국어 하드코딩 (Yuna → Sora → 유나 → 소라 → Heami)
                if (langCode === 'ko-KR' || (langCode && langCode.startsWith('ko'))) {
                    var koVoices = allVoices.filter(function(v) { return v.lang.startsWith('ko'); });
                    targetVoice = koVoices.find(function(v) { return v.name.includes('Yuna'); })
                               || koVoices.find(function(v) { return v.name.includes('Sora'); })
                               || koVoices.find(function(v) { return v.name.includes('유나'); })
                               || koVoices.find(function(v) { return v.name.includes('소라'); })
                               || koVoices.find(function(v) { return v.name.includes('Heami'); })
                               || koVoices[0];
                    console.log('[Runtime TTS] 한국어 음성:', targetVoice ? targetVoice.name : 'default');
                } else {
                    // 다른 언어: 저장된 voiceName 사용
                    if (savedVoiceName) {
                        targetVoice = allVoices.find(function(v) { return v.name.includes(savedVoiceName); });
                        console.log('[Runtime TTS] 저장된 음성:', savedVoiceName, '→', targetVoice ? targetVoice.name : 'not found');
                    }
                    
                    // 저장된 음성 없으면 언어 코드로 찾기
                    if (!targetVoice && langCode) {
                        var langPrefix = langCode.substring(0, 2);
                        targetVoice = allVoices.find(function(v) { return v.lang.replace('_', '-').startsWith(langPrefix); });
                    }
                }
                
                return targetVoice || allVoices[0];
            };
            
            console.log('🔊 TTS 음성 최적화 로드 완료 (한국어 하드코딩)');
        })();
    </script>`;
      
      // </head> 앞에 TTS 최적화 스크립트 삽입 (없으면)
      if (!result.includes('getOptimalVoice')) {
        result = result.replace(/<\/head>/i, ttsVoiceOptimizationScript + '</head>');
      }
      
      // 🔊 2025-12-27: 외부 TTS 로직 강제 주입 + 캐시 버스팅
      // 인라인 TTS 코드 대신 share-page.js의 최신 로직 사용
      // 캐시 버스팅: 서버 시작 시간을 버전으로 사용 → 재배포 시 자동 갱신
      const cacheVersion = Date.now();
      const sharePageScript = `
    <!-- 🔊 2025-12-27: 외부 TTS 로직 + 캐시 버스팅 (기존 DB 페이지도 동적 업데이트) -->
    <script src="/share-page.js?v=${cacheVersion}"></script>`;
      
      // </body> 앞에 share-page.js 삽입 (없으면만!)
      if (!result.includes('src="/share-page.js"')) {
        result = result.replace(/<\/body>/i, sharePageScript + '</body>');
      }
      
      return result;
    };
    
    // 1. DB htmlContent 우선 (런타임 변환 적용)
    if (page.htmlContent) {
      log(`[SHARE] ✅ Serving from DB (htmlContent)`);
      return res.send(injectReferralAndUpdateButton(page.htmlContent));
    }
    
    // 3. htmlFilePath fallback (구 데이터 호환성)
    if (page.htmlFilePath) {
      const relativePath = page.htmlFilePath.replace(/^\//, '');
      const fullPath = path.join(process.cwd(), 'public', relativePath);
      
      if (fs.existsSync(fullPath)) {
        const htmlContent = fs.readFileSync(fullPath, 'utf8');
        log(`[SHARE] ⚠️ Serving from file (legacy): ${relativePath}`);
        return res.send(injectReferralAndUpdateButton(htmlContent));
      } else {
        log(`[SHARE] ❌ File not found: ${fullPath}`);
      }
    }
    
    return res.status(404).send('HTML content not found');
  } catch (error) {
    console.error('[SHARE] Error:', error);
    return res.status(500).send('Internal Server Error');
  }
});

(async () => {
  console.log('[startup] Server initialization started');

  // 🔧 Ensure temp-user-id exists for share functionality
  try {
    const tempUser = await storage.getUser('temp-user-id');
    if (!tempUser) {
      await storage.upsertUser({
        id: 'temp-user-id',
        email: 'temp@example.com',
        firstName: '임시',
        lastName: '사용자',
      });
      log('Created temp-user-id for share functionality');
    }
  } catch (error) {
    log('Warning: Could not create temp-user-id: ' + error);
  }
  
  // 🔧 [공유링크 수정] 정적 파일 서빙을 라우트 등록보다 먼저 설정
  const publicDir = process.env.NODE_ENV === 'production' ? 'dist/public' : 'public';
  
  // ⚠️ 2025.11.02: 스마트 캐시 전략 (업데이트 vs 성능 균형)
  // 🚀 2025-12-01: 최적화된 캐시 헤더 - 재방문 즉시 로딩
  app.use(express.static(publicDir, {
    maxAge: '1d',  // 기본 캐시: 24시간
    etag: true,    // ETag 기반 유효성 검사
    setHeaders: (res, filePath) => {
      // HTML/JS만 캐시 비활성화 (업데이트 즉시 반영)
      // 이미지/CSS/폰트: 장기 캐시 (1일~30일)
      if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } else if (filePath.endsWith('.css') || filePath.endsWith('.woff2') || filePath.endsWith('.woff')) {
        // CSS/폰트: 30일 캐시 (거의 안 바뀜)
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      } else if (filePath.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
        // 이미지: 7일 캐시 (해시값 기반 버전관리)
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      } else {
        // 기타: 1시간 캐시
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    }
  }));
  
  // Route for root page
  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile('index.html', { root: publicDir });
  });
  
  // Route for share page - 명시적 라우트 추가
  app.get('/share.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile('share.html', { root: publicDir });
  });
  
  // 🔧 명시적 HTML 파일 라우트 (SPA Fallback 우회)
  app.get('/profile.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile('profile.html', { root: publicDir });
  });
  
  app.get('/admin-dashboard.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile('admin-dashboard.html', { root: publicDir });
  });
  
  app.get('/user-guide.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile('user-guide.html', { root: publicDir });
  });
  
  app.get('/download.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile('download.html', { root: publicDir });
  });
  
  app.get('/privacy.html', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile('privacy.html', { root: publicDir });
  });
  
  // 🔧 [공유링크 임시 비활성화] SEO 친화적 URL은 추후 구현 예정

  const server = await registerRoutes(app);

  // ⚠️ 2025.11.02: SPA Fallback - 모든 클라이언트 라우트를 index.html로
  // API 라우트가 먼저 처리되고, 나머지는 모두 index.html로 (SPA 라우팅)
  app.get('*', (req, res) => {
    // API 경로는 이미 위에서 처리되었으므로 여기 도달하지 않음
    // 클라이언트 라우트(/archive, /settings 등)를 index.html로 보냄
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile('index.html', { root: publicDir });
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Express error:", err);
    res.status(status).json({ message });
    // Don't throw err after sending response to prevent server crashes
  });

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    console.log(`[startup] Server listening on port ${port}`);
    log(`serving on port ${port}`);
  });
})().catch((err) => {
  console.error('[startup] Fatal startup error:', err);
  process.exit(1);
});
