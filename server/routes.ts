import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { db } from "./db";
import nodemailer from "nodemailer";
import { sql, desc } from "drizzle-orm";
import { setupAuth, isAuthenticated } from "./replitAuth";
import { setupGoogleAuth } from "./googleAuth";
import { setupKakaoAuth } from "./kakaoAuth";
import { generateLocationBasedContent, getLocationName, generateShareLinkDescription, generateCinematicPrompt, optimizeAudioScript, analyzeTextAndGenerateScript, analyzeImageAndGenerateScript, generatePersonaVoice, type GuideContent, type DreamShotPrompt, type AnalyzedScript } from "./gemini";
import { insertGuideSchema, insertShareLinkSchema, insertSharedHtmlPageSchema, creditTransactions, users, notifications, pushSubscriptions, insertNotificationSchema, insertPushSubscriptionSchema, voiceConfigs, dreamStudioVideos, apiLogs, userActivityLogs } from "@shared/schema";
import webpush from "web-push";
import { eq, and, or, isNull } from "drizzle-orm";
import { GoogleGenAI } from "@google/genai";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { generateShareHtml } from "./html-template";
import { generateSingleGuideHTML, generateStandardShareHTML } from "./standard-template";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import profileRoutes from "./profileRoutes";
import { notificationService } from "./notificationService";
import { creditService, CREDIT_CONFIG } from "./creditService";

// Configure multer for image uploads
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Initialize Gemini AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// Configure web-push with VAPID keys
let vapidConfigured = false;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    const publicKey = process.env.VAPID_PUBLIC_KEY.replace(/[\s\n\r]+/g, '').trim();
    const privateKey = process.env.VAPID_PRIVATE_KEY.replace(/[\s\n\r=]+/g, '').trim();
    console.log(`🔑 VAPID 키 길이: public=${publicKey.length}, private=${privateKey.length}`);
    webpush.setVapidDetails(
      'mailto:support@naesongaide.com',
      publicKey,
      privateKey
    );
    vapidConfigured = true;
    console.log('✅ Web Push VAPID 설정 완료');
  } catch (error) {
    console.error('⚠️ Web Push VAPID 설정 실패:', error);
  }
}

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads', { recursive: true });
}

// Ensure shared guidebooks directory exists
if (!fs.existsSync('shared_guidebooks')) {
  fs.mkdirSync('shared_guidebooks', { recursive: true });
}

// Helper function to get userId from req.user (supports both Replit Auth and OAuth)
function getUserId(user: any): string {
  // Google/Kakao OAuth: user.id
  if (user.id) {
    return user.id;
  }
  // Replit Auth: user.claims.sub
  if (user.claims?.sub) {
    return user.claims.sub;
  }
  throw new Error('Unable to extract user ID from session');
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Vanilla JS App API Routes (No authentication required)
  
  // API health check endpoint
  app.head('/api', (req, res) => {
    res.status(200).end();
  });
  
  app.get('/api', (req, res) => {
    res.json({ status: 'ok', message: '내손가이드 API 서버가 정상 작동 중입니다.' });
  });

  app.get('/beta', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'beta.html'));
  });


  // ═══════════════════════════════════════════════════════════════
  // 🗺️ Google Maps API 키 제공 (2025-10-26)
  // ═══════════════════════════════════════════════════════════════
  // 목적: 프론트엔드에서 Google Maps API 사용
  // 보안: API 키를 서버 환경변수에서 안전하게 제공
  // ═══════════════════════════════════════════════════════════════
  app.get('/api/config', (req, res) => {
    res.json({
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || ''
    });
  });
  
  // ═══════════════════════════════════════════════════════════════
  // 📊 사용자 활동 로그 API (2026-02-01)
  // ═══════════════════════════════════════════════════════════════
  // 목적: 디바이스/브라우저 분포 등 사용자 행동 데이터 수집
  // 프론트엔드에서 페이지 로드 시 호출
  // ═══════════════════════════════════════════════════════════════
  
  app.post('/api/activity', async (req: any, res) => {
    try {
      const { deviceType, browser, sessionId, pageViews } = req.body;
      const userAgent = req.headers['user-agent'] || '';
      const userId = req.user?.id || req.session?.passport?.user || null;
      
      // 디바이스 타입 자동 감지 (클라이언트에서 보내지 않은 경우)
      let detectedDeviceType = deviceType;
      if (!detectedDeviceType) {
        if (/Mobile|Android|iPhone|iPad/i.test(userAgent)) {
          detectedDeviceType = /iPad|Tablet/i.test(userAgent) ? 'tablet' : 'mobile';
        } else {
          detectedDeviceType = 'desktop';
        }
      }
      
      // 브라우저 자동 감지 (클라이언트에서 보내지 않은 경우)
      let detectedBrowser = browser;
      if (!detectedBrowser) {
        if (/KAKAOTALK/i.test(userAgent)) detectedBrowser = 'KakaoTalk';
        else if (/NAVER/i.test(userAgent)) detectedBrowser = 'Naver';
        else if (/SamsungBrowser/i.test(userAgent)) detectedBrowser = 'Samsung';
        else if (/Edg/i.test(userAgent)) detectedBrowser = 'Edge';
        else if (/Chrome/i.test(userAgent)) detectedBrowser = 'Chrome';
        else if (/Safari/i.test(userAgent)) detectedBrowser = 'Safari';
        else if (/Firefox/i.test(userAgent)) detectedBrowser = 'Firefox';
        else detectedBrowser = 'Other';
      }
      
      await db.insert(userActivityLogs).values({
        userId,
        sessionId: sessionId || crypto.randomUUID(),
        deviceType: detectedDeviceType,
        browser: detectedBrowser,
        userAgent,
        pageViews: pageViews || 1,
      });
      
      res.json({ success: true });
    } catch (error) {
      console.error('활동 로그 기록 오류:', error);
      res.status(500).json({ error: '활동 로그 기록 실패' });
    }
  });
  
  // ═══════════════════════════════════════════════════════════════
  // 🔊 Voice Configs API (TTS 음성 설정)
  // ═══════════════════════════════════════════════════════════════
  // 목적: TTS 음성 우선순위를 플랫폼/언어별로 제공
  // 프론트엔드에서 음성 선택 시 사용
  // ═══════════════════════════════════════════════════════════════
  
  app.get('/api/voice-configs', async (req, res) => {
    try {
      const configs = await db.select().from(voiceConfigs).where(eq(voiceConfigs.isActive, true));
      res.json(configs);
    } catch (error) {
      console.error('음성 설정 조회 오류:', error);
      res.status(500).json({ error: '음성 설정을 불러오는 중 오류가 발생했습니다.' });
    }
  });
  
  app.get('/api/voice-configs/:langCode', async (req, res) => {
    try {
      const { langCode } = req.params;
      const configs = await db.select().from(voiceConfigs)
        .where(and(
          eq(voiceConfigs.langCode, langCode),
          eq(voiceConfigs.isActive, true)
        ));
      
      if (configs.length === 0) {
        return res.status(404).json({ error: `언어 코드 '${langCode}'에 대한 설정을 찾을 수 없습니다.` });
      }
      
      res.json(configs);
    } catch (error) {
      console.error('음성 설정 조회 오류:', error);
      res.status(500).json({ error: '음성 설정을 불러오는 중 오류가 발생했습니다.' });
    }
  });
  
  app.get('/api/voice-configs/:langCode/:platform', async (req, res) => {
    try {
      const { langCode, platform } = req.params;
      const configs = await db.select().from(voiceConfigs)
        .where(and(
          eq(voiceConfigs.langCode, langCode),
          eq(voiceConfigs.platform, platform),
          eq(voiceConfigs.isActive, true)
        ));
      
      if (configs.length === 0) {
        const defaultConfigs = await db.select().from(voiceConfigs)
          .where(and(
            eq(voiceConfigs.langCode, langCode),
            eq(voiceConfigs.platform, 'default'),
            eq(voiceConfigs.isActive, true)
          ));
        
        if (defaultConfigs.length === 0) {
          return res.status(404).json({ error: `언어 '${langCode}', 플랫폼 '${platform}'에 대한 설정을 찾을 수 없습니다.` });
        }
        
        return res.json(defaultConfigs[0]);
      }
      
      res.json(configs[0]);
    } catch (error) {
      console.error('음성 설정 조회 오류:', error);
      res.status(500).json({ error: '음성 설정을 불러오는 중 오류가 발생했습니다.' });
    }
  });
  
  // ═══════════════════════════════════════════════════════════════
  // 📦 App Storage API (Object Storage)
  // ═══════════════════════════════════════════════════════════════
  // 목적: Dream Studio 이미지/비디오를 App Storage에 저장
  // 배포 안정성: ephemeral 파일 시스템 문제 해결
  // ═══════════════════════════════════════════════════════════════
  
  // Get presigned upload URL for object storage
  app.post('/api/objects/upload', async (req, res) => {
    try {
      const objectStorageService = new ObjectStorageService();
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      res.json({ uploadURL });
    } catch (error) {
      console.error('Upload URL 생성 오류:', error);
      res.status(500).json({ error: 'Upload URL 생성 실패' });
    }
  });
  
  // Download object from storage (public access)
  app.get('/objects/:objectPath(*)', async (req, res) => {
    const objectStorageService = new ObjectStorageService();
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(req.path);
      objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      console.error('객체 다운로드 오류:', error);
      if (error instanceof ObjectNotFoundError) {
        return res.sendStatus(404);
      }
      return res.sendStatus(500);
    }
  });

  // Gemini streaming endpoint
  app.post('/api/gemini', async (req: any, res) => {
    // 📊 API 로깅 - 시작 시간 기록
    const startTime = Date.now();
    let logUserId: string | null = null;
    let logStatusCode = 200;
    let logErrorMessage: string | null = null;
    
    try {
      const { base64Image, prompt, systemInstruction } = req.body;

      const isPromptEmpty = !prompt || prompt.trim() === '';
      const isImageEmpty = !base64Image;

      if (isPromptEmpty && isImageEmpty) {
        logStatusCode = 400;
        logErrorMessage = "필수 데이터 누락";
        return res.status(400).json({ error: "요청 본문에 필수 데이터(prompt 또는 base64Image)가 누락되었습니다." });
      }
      
      // 🎯 2026-02-01: 크레딧 차감 버그 수정 - 세션 기반 사용자 ID 가져오기
      // req.user는 passport 미들웨어가 세션에서 자동으로 복원함
      const userId = req.user?.id || req.session?.passport?.user;
      logUserId = userId || null;
      console.log(`🔍 [Gemini] userId: ${userId}, req.user: ${!!req.user}, session.passport: ${!!req.session?.passport?.user}`);
      
      if (userId && userId !== 'temp-user-id') {
        const user = await storage.getUser(userId);
        if (user && !user.isAdmin) {
          const result = await creditService.useCredits(
            userId, 
            CREDIT_CONFIG.DETAIL_PAGE_COST, 
            'AI 응답 생성'
          );
          if (!result.success) {
            // 📊 API 로깅 - 크레딧 부족
            const responseTime = Date.now() - startTime;
            await db.insert(apiLogs).values({
              type: 'gemini',
              userId: logUserId,
              responseTime,
              estimatedCost: "0",
              statusCode: 402,
              errorMessage: '크레딧 부족',
            });
            return res.status(402).json({ 
              error: "크레딧이 부족합니다.", 
              required: CREDIT_CONFIG.DETAIL_PAGE_COST,
              balance: result.balance
            });
          }
          console.log(`💳 크레딧 차감: ${userId} -${CREDIT_CONFIG.DETAIL_PAGE_COST} (잔액: ${result.balance})`);
        }
      }

      let parts = [];

      if (base64Image) {
        parts.push({
          inlineData: {
            mimeType: "image/jpeg",
            data: base64Image,
          },
        });
      }

      if (prompt && prompt.trim() !== '') {
        parts.push({ text: prompt });
      }

      /**
       * ⚡ Gemini API 최종 결정 - AI Agent (2025-10-18)
       * 
       * 🎯 최종 선택: Flash (이미지 인식 + 프롬프트 준수!)
       * 👤 사용자: 25년차 파리 가이드 (80일 독학)
       * 🤝 최종 결정: 배포 후 현장 테스트 결과 반영!
       * 
       * 📊 최종 테스트 결과:
       * - Flash-Lite: ❌ 이미지 추측 (안 보고 답변!)
       * - Flash-Lite: ❌ 멀티모달 약함
       * - Flash: ✅ 이미지 정확히 인식
       * - Flash: ✅ 프롬프트 준수도 높음
       * - Flash: ✅ 멀티모달 강함 (이미지+비디오+오디오)
       * 
       * 🔍 벤치마크 비교:
       * - Flash vs Claude Haiku 4.5:
       *   → Flash가 멀티모달 더 강함
       *   → Flash가 6.4배 저렴 ($0.3/$2.5)
       *   → 속도 비슷
       * - Flash vs Flash-Lite:
       *   → Flash가 이미지 인식 훨씬 좋음
       *   → Flash가 프롬프트 준수도 높음
       *   → 속도 차이 미미
       * 
       * 🔑 최적화 파라미터:
       * - thinkingBudget: 0 (사고 시간 제거, 속도↑)
       * - temperature: 0.5 (결정론적, 빠름)
       * - maxOutputTokens: 800 (400-500자 제한)
       * - topP: 0.8 (집중 샘플링)
       * - topK: 20 (토큰 선택 제한, 속도↑)
       * 
       * ⚠️ 후임자에게:
       * - Flash = 최적 균형점 (이미지+속도+가격)
       * - Flash-Lite는 이미지 인식 약함!
       * - 압축 0.9 절대 유지!
       * - 현장 테스트가 벤치마크보다 중요!
       */
      const model = 'gemini-3-flash-preview'; // Gemini 3 Flash Preview - Released Dec 17, 2025
      const contents = { parts };

      const config: any = {
        systemInstruction,
        thinkingConfig: { thinkingBudget: 0 },
        generationConfig: {
          temperature: 0.5, // Lower for faster, more deterministic responses
          maxOutputTokens: 800, // Tighter limit for 400-500 chars
          topP: 0.8, // More focused sampling
          topK: 20 // Limit token choices for speed
        }
      };

      console.log("Gemini API(스트리밍)로 전송할 요청 본문:", JSON.stringify({ model, contents, config }));

      // Generate streaming response
      const responseStream = await ai.models.generateContentStream({ model, contents, config });

      // Set up streaming response
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');

      // Stream the response
      for await (const chunk of responseStream) {
        const text = chunk.text;
        if (text) {
          res.write(text);
        }
      }
      
      res.end();
      
      // 📊 API 로깅 - 성공 시 기록
      const responseTime = Date.now() - startTime;
      const estimatedCost = "0.015"; // Gemini 3.0 Flash: ~$0.015/call
      
      await db.insert(apiLogs).values({
        type: 'gemini',
        userId: logUserId,
        responseTime,
        estimatedCost,
        statusCode: 200,
      });
      
      console.log(`📊 [API Log] Gemini 호출 성공: ${responseTime}ms, 사용자: ${logUserId || 'guest'}`);

    } catch (error) {
      console.error("Gemini API 오류:", error);
      logStatusCode = 500;
      logErrorMessage = String(error);
      
      // 📊 API 로깅 - 실패 시도 기록
      const responseTime = Date.now() - startTime;
      try {
        await db.insert(apiLogs).values({
          type: 'gemini',
          userId: logUserId,
          responseTime,
          estimatedCost: "0", // 실패 시 비용 0
          statusCode: 500,
          errorMessage: logErrorMessage,
        });
      } catch (logError) {
        console.error("API 로그 저장 실패:", logError);
      }
      
      res.status(500).json({ error: `AI 통신 중 오류: ${error}` });
    }
  });

  // Share endpoints
  app.post('/api/share', async (req, res) => {
    try {
      const { contents, name } = req.body;
      
      if (!Array.isArray(contents) || contents.length === 0) {
        return res.status(400).json({ error: "공유할 항목이 없습니다." });
      }
      
      if (contents.length > 30) {
        return res.status(400).json({ error: "한 번에 최대 30개까지만 공유할 수 있습니다." });
      }

      const guidebookId = crypto.randomBytes(4).toString('base64url').slice(0, 6);
      const guidebookData = { 
        contents, 
        name, 
        createdAt: new Date().toISOString() 
      };

      // Save to file system
      const filePath = path.join('shared_guidebooks', `${guidebookId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(guidebookData, null, 2));

      res.json({ guidebookId });
    } catch (error) {
      console.error("Share 생성 오류:", error);
      res.status(500).json({ error: "가이드북 생성 중 오류가 발생했습니다." });
    }
  });

  app.get('/api/share', async (req, res) => {
    try {
      const guidebookId = req.query.id;
      
      if (!guidebookId) {
        return res.status(400).json({ error: "가이드북 ID가 필요합니다." });
      }

      const filePath = path.join('shared_guidebooks', `${guidebookId}.json`);
      
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: `해당 가이드북(${guidebookId})을 찾을 수 없습니다.` });
      }

      const guidebookData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      res.json(guidebookData);
      
    } catch (error) {
      console.error("Share 조회 오류:", error);
      res.status(500).json({ error: "가이드북을 불러오는 중 오류가 발생했습니다." });
    }
  });

  // Public share page endpoint - accessible without authentication
  app.get('/share/:id', async (req, res) => {
    try {
      const shareId = req.params.id;
      
      // Get share link data
      const shareLink = await storage.getShareLink(shareId);
      if (!shareLink || !shareLink.isActive) {
        return res.status(404).send(`
          <!DOCTYPE html>
          <html lang="ko">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>공유 페이지를 찾을 수 없습니다 - 내손가이드</title>
          </head>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background-color: #f5f5f5;">
            <h1>🔍 페이지를 찾을 수 없습니다</h1>
            <p>요청하신 공유 페이지가 존재하지 않거나 삭제되었습니다.</p>
            <a href="/archive" style="color: #007bff; text-decoration: none;">보관함으로 이동</a>
          </body>
          </html>
        `);
      }

      // Increment view count
      await storage.incrementShareLinkViews(shareId);

      // Get actual guide data
      const guides = await storage.getGuidesByIds(shareLink.guideIds);
      if (guides.length === 0) {
        return res.status(404).send(`
          <!DOCTYPE html>
          <html lang="ko">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>가이드를 찾을 수 없습니다 - 내손가이드</title>
          </head>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background-color: #f5f5f5;">
            <h1>📚 가이드를 찾을 수 없습니다</h1>
            <p>이 공유 페이지에 포함된 가이드가 더 이상 존재하지 않습니다.</p>
            <a href="/archive" style="color: #007bff; text-decoration: none;">보관함으로 이동</a>
          </body>
          </html>
        `);
      }

      // Helper function to convert image to base64
      const imageToBase64 = async (imageUrl: string): Promise<string> => {
        try {
          if (!imageUrl) {
            return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
          }
          
          // 🔧 이미 data URL 형태면 base64 부분만 추출
          if (imageUrl.startsWith('data:image/')) {
            const base64Match = imageUrl.match(/base64,(.+)$/);
            if (base64Match) {
              return base64Match[1];
            }
          }
          
          if (imageUrl.startsWith('/uploads/') || !imageUrl.startsWith('http')) {
            const imagePath = path.join(process.cwd(), 'uploads', path.basename(imageUrl));
            if (fs.existsSync(imagePath)) {
              const imageBuffer = fs.readFileSync(imagePath);
              return imageBuffer.toString('base64');
            }
          }
          
          return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        } catch (error) {
          console.error('이미지 변환 오류:', error);
          return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        }
      };

      // Convert guides to template format with real data (2025-12-15 표준화 완료)
      const guideItems = await Promise.all(
        guides.map(async (guide) => ({
          id: guide.id,
          title: guide.title || '',  // 🎤 음성키워드 폴백용
          imageDataUrl: `data:image/jpeg;base64,${await imageToBase64(guide.imageUrl || '')}`,
          description: guide.aiGeneratedContent || guide.description || `${guide.title}에 대한 설명입니다.`,
          voiceLang: guide.voiceLang || 'ko-KR',
          locationName: guide.locationName || '',
          voiceQuery: (guide as any).voiceQuery || guide.title || '',  // 🎤 voiceQuery 없으면 title 폴백
          voiceName: guide.voiceName || ''
        }))
      );

      // Generate HTML using standard template (2025-12-15 표준화)
      const htmlContent = generateStandardShareHTML({
        title: shareLink.name,
        sender: '여행자',
        location: (shareLink.includeLocation || false) && guides[0]?.locationName ? guides[0].locationName : '여행지',
        date: new Date(shareLink.createdAt || new Date()).toLocaleDateString('ko-KR'),
        guideItems,
        appOrigin: 'https://My-handyguide1.replit.app',
        isFeatured: false,
        creatorReferralCode: ''
      });

      // 디버그: 생성된 HTML 일부 출력
      console.log('🔍 [공유 HTML] Tailwind 포함 여부:', htmlContent.includes('cdn.tailwindcss.com'));
      console.log('🔍 [공유 HTML] bg-black/60 클래스 포함 여부:', htmlContent.includes('bg-black/60'));
      console.log('🔍 [공유 HTML] detail-view ID 포함 여부:', htmlContent.includes('id="detail-view"'));

      // Set proper headers for caching and content type
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); // 캐시 비활성화 (테스트용)
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(htmlContent);
      
    } catch (error) {
      console.error("공유 페이지 조회 오류:", error);
      res.status(500).send(`
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>오류 발생 - 내손가이드</title>
        </head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background-color: #f5f5f5;">
          <h1>⚠️ 오류가 발생했습니다</h1>
          <p>공유 페이지를 불러오는 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.</p>
          <a href="/archive" style="color: #007bff; text-decoration: none;">보관함으로 이동</a>
        </body>
        </html>
      `);
    }
  });

  // Generate HTML share page endpoint (NEW)
  app.post('/api/generate-share-html', async (req, res) => {
    try {
      const { name, guideIds, includeLocation, includeAudio } = req.body;
      
      if (!Array.isArray(guideIds) || guideIds.length === 0) {
        return res.status(400).json({ error: "공유할 가이드가 없습니다." });
      }
      
      if (guideIds.length > 20) {
        return res.status(400).json({ error: "한 번에 최대 20개까지만 공유할 수 있습니다." });
      }

      // Fetch actual guide data from database
      const actualGuides = await storage.getGuidesByIds(guideIds);
      
      if (actualGuides.length === 0) {
        return res.status(404).json({ error: "선택한 가이드를 찾을 수 없습니다." });
      }
      
      // Helper function to convert image to base64
      const imageToBase64 = async (imageUrl: string): Promise<string> => {
        try {
          if (!imageUrl) {
            return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
          }
          
          // 🔧 이미 data URL 형태면 base64 부분만 추출
          if (imageUrl.startsWith('data:image/')) {
            const base64Match = imageUrl.match(/base64,(.+)$/);
            if (base64Match) {
              return base64Match[1];
            }
          }
          
          if (imageUrl.startsWith('/uploads/') || !imageUrl.startsWith('http')) {
            const imagePath = path.join(process.cwd(), 'uploads', path.basename(imageUrl));
            if (fs.existsSync(imagePath)) {
              const imageBuffer = fs.readFileSync(imagePath);
              return imageBuffer.toString('base64');
            }
          }
          
          return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        } catch (error) {
          console.error('이미지 변환 오류:', error);
          return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        }
      };
      
      // Convert guides to template format with real data (2025-12-15 표준화 완료)
      const guideItems = await Promise.all(
        actualGuides.map(async (guide) => ({
          id: guide.id,
          title: guide.title || '',  // 🎤 음성키워드 폴백용
          imageDataUrl: `data:image/jpeg;base64,${await imageToBase64(guide.imageUrl || '')}`,
          description: guide.aiGeneratedContent || guide.description || `${guide.title}에 대한 설명입니다.`,
          voiceLang: guide.voiceLang || 'ko-KR',
          locationName: guide.locationName || '',
          voiceQuery: (guide as any).voiceQuery || guide.title || '',  // 🎤 voiceQuery 없으면 title 폴백
          voiceName: guide.voiceName || ''
        }))
      );

      // Generate HTML using standard template (2025-12-15 표준화)
      const htmlContent = generateStandardShareHTML({
        title: name || "공유된 가이드북",
        sender: '여행자',
        location: includeLocation && actualGuides[0]?.locationName ? actualGuides[0].locationName : '여행지',
        date: new Date().toLocaleDateString('ko-KR'),
        guideItems,
        appOrigin: 'https://My-handyguide1.replit.app',
        isFeatured: false,
        creatorReferralCode: ''
      });

      // Generate safe filename for download
      const safeName = (name || "공유된가이드북").replace(/[^a-zA-Z0-9가-힣\s]/g, '').trim() || "공유된가이드북";
      const fileName = `${safeName}-공유페이지.html`;
      
      // Return HTML content directly for client-side download
      res.json({ 
        htmlContent: htmlContent,
        fileName: fileName,
        itemCount: guideItems.length
      });
      
    } catch (error) {
      console.error("HTML 공유 페이지 생성 오류:", error);
      res.status(500).json({ error: "공유 페이지 생성 중 오류가 발생했습니다." });
    }
  });

  // Auth middleware
  await setupAuth(app);
  await setupGoogleAuth(app);
  await setupKakaoAuth(app);

  // ═══════════════════════════════════════════════════════════════
  // 📱 Beta Tester Registration
  // 목적: /beta 페이지에서 Google 로그인 후 앱 DB에 사용자 저장 + 중복 체크
  // 구글 그룹스 방식으로 전환 — Play Console API 미사용 (API가 이메일 목록 미지원)
  // ═══════════════════════════════════════════════════════════════
  const betaRegisteredEmails = new Set<string>();

  app.post('/api/beta/play-register', async (req: any, res) => {
    try {
      const userId = req.user?.id || req.session?.passport?.user;
      if (!userId) return res.status(401).json({ message: 'Not authenticated' });

      const userRecord = await storage.getUser(userId);

      if (!userRecord || !userRecord.email) {
        return res.status(400).json({ message: 'No email found' });
      }

      const email = userRecord.email;

      if (betaRegisteredEmails.has(email)) {
        return res.json({ success: true, alreadyRegistered: true });
      }

      betaRegisteredEmails.add(email);
      console.log(`[Beta] 신규 베타 테스터 등록: ${email}`);

      res.json({ success: true, alreadyRegistered: false });
    } catch (err: any) {
      console.error('[Beta Register] Error:', err.message);
      res.status(500).json({ message: 'Registration failed' });
    }
  });

  // Auth routes
  app.get('/api/auth/user', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const user = await storage.getUser(userId);
      
      // 🎁 2026-01-07: 프로모션 - 기존 가입자에게 프로모션 보너스 지급
      // 프로모션 종료 후 아래 3줄 삭제
      if (user) {
        await creditService.grantPromoBonus(userId);
      }
      
      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  // Logout endpoint
  app.get('/api/auth/logout', (req: any, res) => {
    console.log('🔓 Logging out user...');
    req.logout((err: any) => {
      if (err) {
        console.error('Logout error:', err);
        return res.status(500).json({ error: 'Failed to logout' });
      }
      req.session.destroy((err: any) => {
        if (err) {
          console.error('Session destroy error:', err);
          return res.status(500).json({ error: 'Failed to destroy session' });
        }
        res.clearCookie('connect.sid');
        console.log('✅ Logged out successfully');
        // ⚠️ 2025.11.02: 로그아웃 후 보관함으로 (랜딩 페이지 금지)
        res.redirect('/archive');
      });
    });
  });

  // User preferences
  app.patch('/api/user/preferences', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const preferences = req.body;
      
      const user = await storage.updateUserPreferences(userId, preferences);
      res.json(user);
    } catch (error) {
      console.error("Error updating preferences:", error);
      res.status(500).json({ message: "Failed to update preferences" });
    }
  });

  // Subscription management
  app.post('/api/subscription/cancel', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const user = await storage.cancelSubscription(userId);
      res.json({ 
        message: "구독이 취소되었습니다. 계정과 모든 데이터는 보존됩니다.",
        user 
      });
    } catch (error) {
      console.error("Error canceling subscription:", error);
      res.status(500).json({ message: "구독 취소 중 오류가 발생했습니다." });
    }
  });

  app.post('/api/subscription/reactivate', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const user = await storage.reactivateSubscription(userId);
      res.json({ 
        message: "구독이 복원되었습니다. 이전 데이터가 모두 복원되었습니다!",
        user 
      });
    } catch (error) {
      console.error("Error reactivating subscription:", error);
      res.status(500).json({ message: "구독 복원 중 오류가 발생했습니다." });
    }
  });

  // Guide routes
  app.get('/api/guides', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const guides = await storage.getUserGuides(userId);
      res.json(guides);
    } catch (error) {
      console.error("Error fetching guides:", error);
      res.status(500).json({ message: "Failed to fetch guides" });
    }
  });

  /**
   * ✅ 단일 가이드 생성 (원래 설계로 복원 - 2025-11-23)
   * 
   * ⚠️ **사용자 승인 없이 수정 불가**
   * 
   * 목적: 사용자가 새 사진 촬영 시 guides DB에 저장
   * 방식: Base64 이미지를 그대로 저장 (파일 경로 아님!)
   * 
   * Request body:
   * {
   *   "imageDataUrl": "data:image/jpeg;base64,...",
   *   "latitude": 48.8606,
   *   "longitude": 2.3376,
   *   "language": "ko",
   *   "enableAI": true
   * }
   * 
   * Response: Guide 객체
   */
  app.post('/api/guides', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const { imageDataUrl, latitude, longitude, language = 'ko', enableAI = true } = req.body;
      
      if (!imageDataUrl) {
        return res.status(400).json({ message: "imageDataUrl is required" });
      }

      if (!latitude || !longitude || isNaN(parseFloat(latitude)) || isNaN(parseFloat(longitude))) {
        return res.status(400).json({ message: "Valid latitude and longitude are required" });
      }

      // Get location name
      const locationName = await getLocationName(parseFloat(latitude), parseFloat(longitude));

      let guideContent: GuideContent = {
        title: "새 가이드",
        description: "위치 기반 가이드입니다.",
        tips: [],
        culturalNotes: "",
        bestTimeToVisit: "",
        accessibility: ""
      };

      // Generate AI content if enabled
      if (enableAI) {
        try {
          // Base64 이미지에서 순수 데이터 추출
          const imageBase64 = imageDataUrl.split(',')[1];
          
          guideContent = await generateLocationBasedContent(
            imageBase64,
            { latitude: parseFloat(latitude), longitude: parseFloat(longitude), locationName },
            language
          );
        } catch (aiError) {
          console.error("AI generation failed, using defaults:", aiError);
        }
      }

      // ✨ Base64 이미지를 그대로 guides DB에 저장 (원래 설계)
      const guideData = {
        title: guideContent.title,
        description: guideContent.description,
        imageUrl: imageDataUrl, // Base64 그대로 저장!
        latitude: latitude.toString(),
        longitude: longitude.toString(),
        locationName,
        aiGeneratedContent: JSON.stringify(guideContent),
        language
      };

      console.log(`✅ guides DB에 Base64 저장: ${guideContent.title} (${imageDataUrl.substring(0, 50)}...)`);

      const guide = await storage.createGuide(userId, guideData);
      res.json(guide);
    } catch (error) {
      console.error("Error creating guide:", error);
      res.status(500).json({ message: "Failed to create guide" });
    }
  });

  /**
   * ✅ 배치 가이드 저장 (보관 시 guides DB 저장)
   * 
   * ⚠️ **사용자 승인 없이 수정 불가**
   * 
   * 목적: 사용자가 보관 버튼 클릭 시 IndexedDB 데이터를 guides DB에도 저장
   * 인증: 불필요 (비로그인 사용자도 로컬 가이드 저장 가능 - 원래 설계)
   * 
   * Request body:
   * {
   *   "guides": [
   *     {
   *       "title": "Louvre Museum",
   *       "description": "AI-generated description",
   *       "imageDataUrl": "data:image/jpeg;base64,...",
   *       "latitude": "48.8606",
   *       "longitude": "2.3376",
   *       "locationName": "Louvre Museum",
   *       "aiGeneratedContent": "AI content"
   *     }
   *   ]
   * }
   * 
   * Response: { guideIds: ["uuid1", "uuid2", ...] }
   */
  app.post('/api/guides/batch', async (req: any, res) => {
    try {
      // 비로그인 사용자도 저장 가능 (userId는 optional)
      const userId = req.user ? getUserId(req.user) : null;
      const { guides: guidesData, language: userLanguage } = req.body;
      
      if (!Array.isArray(guidesData) || guidesData.length === 0) {
        return res.status(400).json({ message: "guides 배열이 비어있습니다." });
      }
      
      console.log(`📦 배치 저장 시작: ${guidesData.length}개 가이드 (userId: ${userId})`);
      
      const savedGuideIds: string[] = [];
      
      for (const guideItem of guidesData) {
        try {
          const { localId, title, description, imageDataUrl, latitude, longitude, locationName, aiGeneratedContent, voiceLang, voiceName } = guideItem;
          
          // 🎤 음성 가이드: imageDataUrl 없어도 저장 가능 (title + description만 필요)
          if (!title || (!imageDataUrl && !description)) {
            console.error(`❌ 필수 필드 누락: title=${title}, imageDataUrl=${!!imageDataUrl}, description=${!!description}`);
            continue; // Skip invalid items
          }
          
          // ✨ (2025-11-22) 수정: Base64를 그대로 guides DB에 저장 (원래 설계)
          // 🎤 음성 가이드는 imageDataUrl이 null일 수 있음
          const imageUrl = imageDataUrl || null;
          if (imageDataUrl) {
            console.log(`✅ guides DB에 Base64 저장: ${title} (${imageUrl.substring(0, 50)}...)`);
          } else {
            console.log(`🎤 음성 가이드 저장: ${title} (이미지 없음)`);
          }
          
          // guides DB 저장
          const guideData = {
            localId: localId || null, // IndexedDB ID 매핑
            title: title || '제목 없음',
            description: description || '',
            imageUrl,
            latitude: latitude?.toString() || null,
            longitude: longitude?.toString() || null,
            locationName: locationName || null,
            aiGeneratedContent: aiGeneratedContent || null,
            language: userLanguage || 'ko', // 사용자 선택 언어 (기본값: ko)
            voiceLang: voiceLang || null, // TTS 언어 코드 (DB에서 가져온 값 그대로)
            voiceName: voiceName || null // TTS 음성 이름
          };
          
          const savedGuide = await storage.createGuide(userId || 'anonymous', guideData);
          savedGuideIds.push(savedGuide.id);
          console.log(`✅ guides DB 저장 완료: ${savedGuide.id} (${title}, localId: ${localId}, userId: ${userId || 'anonymous'})`);
          
        } catch (itemError) {
          console.error(`❌ 가이드 저장 실패:`, itemError);
          // Continue to next item
        }
      }
      
      console.log(`✅ 배치 저장 완료: ${savedGuideIds.length}/${guidesData.length}개 성공`);
      
      res.json({ 
        guideIds: savedGuideIds,
        success: savedGuideIds.length,
        total: guidesData.length
      });
      
    } catch (error) {
      console.error("배치 가이드 저장 오류:", error);
      res.status(500).json({ message: "배치 저장 중 오류가 발생했습니다." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ⭐ 단일 가이드 상세페이지 (프로필에서 새 탭으로 열기용)
  // 2025-12-09: DB에서 가이드 데이터 불러와서 표준 템플릿으로 렌더링
  // ═══════════════════════════════════════════════════════════════
  app.get('/guide/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const guide = await storage.getGuide(id);
      
      if (!guide) {
        return res.status(404).send('<h1>가이드를 찾을 수 없습니다</h1><p><a href="/">홈으로 돌아가기</a></p>');
      }

      // 조회수 증가
      await storage.incrementGuideViews(id);
      
      // 표준 상세페이지 HTML 생성
      const html = generateSingleGuideHTML({
        id: guide.id,
        imageUrl: guide.imageUrl || '',
        description: guide.description || '',
        locationName: guide.locationName || '',
        voiceLang: guide.voiceLang || 'ko-KR',
        voiceName: guide.voiceName || '',
        createdAt: guide.createdAt?.toISOString() || ''
      });
      
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (error) {
      console.error("Error rendering guide page:", error);
      res.status(500).send('<h1>오류가 발생했습니다</h1><p><a href="/">홈으로 돌아가기</a></p>');
    }
  });

  app.get('/api/guides/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const guide = await storage.getGuide(id);
      
      if (!guide) {
        return res.status(404).json({ message: "Guide not found" });
      }

      // Increment view count
      await storage.incrementGuideViews(id);
      
      res.json(guide);
    } catch (error) {
      console.error("Error fetching guide:", error);
      res.status(500).json({ message: "Failed to fetch guide" });
    }
  });

  app.delete('/api/guides/:id', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = getUserId(req.user);
      
      const guide = await storage.getGuide(id);
      if (!guide) {
        return res.status(404).json({ message: "Guide not found" });
      }
      
      if (guide.userId !== userId) {
        return res.status(403).json({ message: "Unauthorized" });
      }

      await storage.deleteGuide(id);
      
      // Delete image file
      if (guide.imageUrl) {
        const imagePath = path.join('.', guide.imageUrl);
        try {
          fs.unlinkSync(imagePath);
        } catch (fileError) {
          console.error("Error deleting image file:", fileError);
        }
      }
      
      res.json({ message: "Guide deleted successfully" });
    } catch (error) {
      console.error("Error deleting guide:", error);
      res.status(500).json({ message: "Failed to delete guide" });
    }
  });

  // Share link routes
  app.get('/api/share-links', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const shareLinks = await storage.getUserShareLinks(userId);
      res.json(shareLinks);
    } catch (error) {
      console.error("Error fetching share links:", error);
      res.status(500).json({ message: "Failed to fetch share links" });
    }
  });

  // Featured share links (public access)
  app.get('/api/featured-share-links', async (req, res) => {
    try {
      const featuredLinks = await storage.getFeaturedShareLinks();
      res.json(featuredLinks);
    } catch (error) {
      console.error("Error fetching featured share links:", error);
      res.status(500).json({ message: "Failed to fetch featured share links" });
    }
  });

  // 🎬 드림 스튜디오: 가이드 이미지 가져오기 (공개 API)
  app.get('/api/dream-studio/samples', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const samples: any[] = [];
      
      // 1차: Featured 갤러리에서 시도
      const featuredLinks = await storage.getFeaturedShareLinks();
      for (const link of featuredLinks.slice(0, 5)) {
        if (link.guideIds && link.guideIds.length > 0) {
          const guides = await storage.getGuidesByIds(link.guideIds);
          for (const guide of guides.slice(0, 3)) {
            if (guide.imageUrl) {
              samples.push({
                id: guide.id,
                name: guide.locationName || guide.title || '알 수 없는 장소',
                image: guide.imageUrl,
                description: guide.description || '',
                aiContent: guide.aiGeneratedContent || ''
              });
            }
            if (samples.length >= limit) break;
          }
        }
        if (samples.length >= limit) break;
      }
      
      // 2차: Featured가 없으면 최근 가이드에서 가져오기
      if (samples.length === 0) {
        const recentGuides = await storage.getRecentGuidesWithImages(limit);
        for (const guide of recentGuides) {
          samples.push({
            id: guide.id,
            name: guide.locationName || guide.title || '알 수 없는 장소',
            image: guide.imageUrl,
            description: guide.description || '',
            aiContent: guide.aiGeneratedContent || ''
          });
        }
      }
      
      res.json(samples);
    } catch (error) {
      console.error("Error fetching dream studio samples:", error);
      res.status(500).json({ message: "Failed to fetch samples" });
    }
  });

  // 🎬 드림 스튜디오: 1인칭 페르소나 스크립트 + 음성 생성
  app.post('/api/dream-studio/generate-persona', async (req, res) => {
    try {
      const { imageBase64, language = 'ko', persona } = req.body;
      
      if (!imageBase64) {
        return res.status(400).json({ message: "이미지가 필요합니다" });
      }

      // 이미지에서 base64 데이터만 추출
      const base64Data = imageBase64.includes(',') 
        ? imageBase64.split(',')[1] 
        : imageBase64;

      // 1. 페르소나 스크립트 생성
      const { generatePersonaScript, generatePersonaVoice } = await import('./gemini');
      const script = await generatePersonaScript(base64Data, language, persona);
      
      // 2. TTS 음성 생성
      const audio = await generatePersonaVoice(script.text, script.voiceName, script.mood);
      
      res.json({
        script: script.text,
        persona: script.persona,
        mood: script.mood,
        voiceName: script.voiceName,
        audio: audio ? {
          data: audio.audioBase64,
          mimeType: audio.mimeType
        } : null
      });
    } catch (error) {
      console.error("페르소나 생성 오류:", error);
      res.status(500).json({ message: "페르소나 생성 실패" });
    }
  });

  app.post('/api/share-links', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const validatedData = insertShareLinkSchema.parse(req.body);

      if (validatedData.guideIds.length === 0 || validatedData.guideIds.length > 30) {
        return res.status(400).json({ message: "Must select 1-30 guides" });
      }

      // Verify all guides belong to the user
      const guides = await storage.getGuidesByIds(validatedData.guideIds);
      const userGuides = guides.filter(guide => guide.userId === userId);
      
      if (userGuides.length !== validatedData.guideIds.length) {
        return res.status(403).json({ message: "Unauthorized access to some guides" });
      }

      const shareLink = await storage.createShareLink(userId, validatedData);
      res.json(shareLink);
    } catch (error) {
      console.error("Error creating share link:", error);
      res.status(500).json({ message: "Failed to create share link" });
    }
  });

  app.get('/api/share-links/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const shareLink = await storage.getShareLink(id);
      
      if (!shareLink || !shareLink.isActive) {
        return res.status(404).json({ message: "Share link not found" });
      }

      // Increment view count
      await storage.incrementShareLinkViews(id);

      // Get associated guides
      const guides = await storage.getGuidesByIds(shareLink.guideIds);
      
      res.json({
        ...shareLink,
        guides
      });
    } catch (error) {
      console.error("Error fetching share link:", error);
      res.status(500).json({ message: "Failed to fetch share link" });
    }
  });

  app.delete('/api/share-links/:id', isAuthenticated, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = getUserId(req.user);
      
      const shareLink = await storage.getShareLink(id);
      if (!shareLink) {
        return res.status(404).json({ message: "Share link not found" });
      }
      
      if (shareLink.userId !== userId) {
        return res.status(403).json({ message: "Unauthorized" });
      }

      await storage.deleteShareLink(id);
      res.json({ message: "Share link deleted successfully" });
    } catch (error) {
      console.error("Error deleting share link:", error);
      res.status(500).json({ message: "Failed to delete share link" });
    }
  });

  // Serve uploaded images
  // Serve uploads securely
  app.use('/uploads', express.static('uploads', { 
    fallthrough: false,
    dotfiles: 'deny'
  }));

  // 💳 크레딧 시스템 API
  app.get('/api/credits', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const user = await storage.getUser(userId);
      
      // 🎯 관리자 무제한 크레딧 체크
      if (user?.isAdmin) {
        return res.json({ credits: 999999, isAdmin: true });
      }
      
      const credits = await storage.getUserCredits(userId);
      res.json({ credits, isAdmin: false });
    } catch (error) {
      console.error("Error fetching credits:", error);
      res.status(500).json({ message: "Failed to fetch credits" });
    }
  });

  app.get('/api/credits/history', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const history = await storage.getCreditHistory(userId);
      res.json(history);
    } catch (error) {
      console.error("Error fetching credit history:", error);
      res.status(500).json({ message: "Failed to fetch credit history" });
    }
  });

  app.post('/api/credits/deduct', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const { amount, description } = req.body;
      
      // 🎯 관리자 무제한 크레딧 체크
      const user = await storage.getUser(userId);
      if (user?.isAdmin) {
        return res.json({ success: true, credits: 999999, isAdmin: true });
      }
      
      const success = await storage.deductCredits(userId, amount, description);
      if (success) {
        const updatedCredits = await storage.getUserCredits(userId);
        res.json({ success: true, credits: updatedCredits });
      } else {
        res.status(400).json({ success: false, message: '크레딧이 부족합니다.' });
      }
    } catch (error) {
      console.error("Error deducting credits:", error);
      res.status(500).json({ message: "크레딧 차감 중 오류가 발생했습니다." });
    }
  });

  app.post('/api/credits/purchase', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const { amount, paymentIntentId } = req.body;
      
      // TODO: Stripe 결제 검증 후 크레딧 추가
      // const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      // if (paymentIntent.status === 'succeeded') {
      
      const user = await storage.addCredits(
        userId,
        amount,
        'purchase',
        `크레딧 구매: ${amount}개`,
        paymentIntentId
      );

      // 💰 추천인 킥백 처리
      await storage.processCashbackReward(amount * 100, userId); // 센트 단위로 변환
      
      res.json({ success: true, credits: user.credits });
    } catch (error) {
      console.error("Error processing credit purchase:", error);
      res.status(500).json({ message: "Failed to process credit purchase" });
    }
  });

  app.post('/api/referral/signup-bonus', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const { referrerCode } = req.body;
      
      const result = await storage.awardSignupBonus(userId, referrerCode);
      res.json(result);
    } catch (error) {
      console.error("Error processing signup bonus:", error);
      res.status(500).json({ message: "Failed to process signup bonus" });
    }
  });

  app.get('/api/referral-code', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const referralCode = await storage.generateReferralCode(userId);
      res.json({ referralCode });
    } catch (error) {
      console.error("Error generating referral code:", error);
      res.status(500).json({ message: "Failed to generate referral code" });
    }
  });

  // 🎬 드림샷 스튜디오 API 엔드포인트
  
  // 영화급 프롬프트 생성
  app.post('/api/dream-studio/generate-prompt', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const { guideId, preferences } = req.body;
      
      // 가이드 조회
      const guide = await storage.getGuide(guideId);
      if (!guide || guide.userId !== userId) {
        return res.status(404).json({ message: "가이드를 찾을 수 없습니다." });
      }

      // 영화급 프롬프트 생성
      const dreamPrompt = await generateCinematicPrompt(guide, preferences);
      
      res.json(dreamPrompt);
    } catch (error) {
      console.error("드림 프롬프트 생성 오류:", error);
      res.status(500).json({ message: "프롬프트 생성에 실패했습니다." });
    }
  });

  // AI 이미지 생성 (Face Swap 포함)
  app.post('/api/dream-studio/generate-image', isAuthenticated, upload.single('userPhoto'), async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const userPhoto = req.file;
      const { guideId, imagePrompt, mood, lighting, angle } = req.body;

      if (!userPhoto) {
        return res.status(400).json({ message: "사용자 사진이 필요합니다." });
      }

      // 🎯 관리자 무제한 크레딧 체크
      const user = await storage.getUser(userId);
      if (!user?.isAdmin) {
        // 일반 사용자는 크레딧 차감
        const success = await storage.deductCredits(userId, 5, "드림샷 AI 이미지 생성");
        if (!success) {
          return res.status(402).json({ message: "크레딧이 부족합니다. (필요: 5크레딧)" });
        }
      }

      // 가이드 조회
      const guide = await storage.getGuide(guideId);
      if (!guide) {
        return res.status(404).json({ message: "가이드를 찾을 수 없습니다." });
      }

      // TODO: 실제 이미지 생성 구현 (Runware API 대기 중)
      // 현재는 성공 응답만 반환
      const generatedImageUrl = `/uploads/dream-shot-${Date.now()}.jpg`;
      
      // 🧹 업로드된 파일 정리 (보안: 스토리지 bloat 방지)
      try {
        if (userPhoto && fs.existsSync(userPhoto.path)) {
          fs.unlinkSync(userPhoto.path);
          console.log(`🗑️ 임시 파일 삭제: ${userPhoto.path}`);
        }
      } catch (cleanupError) {
        console.error('파일 정리 오류:', cleanupError);
      }
      
      res.json({
        success: true,
        imageUrl: generatedImageUrl,
        prompt: imagePrompt,
        settings: { mood, lighting, angle }
      });
      
    } catch (error) {
      console.error("AI 이미지 생성 오류:", error);
      res.status(500).json({ message: "이미지 생성에 실패했습니다." });
    }
  });

  // 음성 스크립트 최적화
  app.post('/api/dream-studio/optimize-script', isAuthenticated, async (req: any, res) => {
    try {
      const { script, emotion } = req.body;
      
      if (!script) {
        return res.status(400).json({ message: "스크립트가 필요합니다." });
      }

      const optimizedScript = await optimizeAudioScript(script, emotion);
      
      res.json({ 
        originalScript: script,
        optimizedScript,
        emotion,
        estimatedDuration: Math.ceil(optimizedScript.length / 4) + "초" // 대략 4자/초 기준
      });
    } catch (error) {
      console.error("스크립트 최적화 오류:", error);
      res.status(500).json({ message: "스크립트 최적화에 실패했습니다." });
    }
  });

  // Create share link with URL (instead of HTML download)
  app.post('/api/create-share-link', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const { name, guideIds, includeLocation, includeAudio } = req.body;
      
      if (!name || !Array.isArray(guideIds) || guideIds.length === 0) {
        return res.status(400).json({ error: "이름과 가이드를 선택해주세요." });
      }

      if (guideIds.length > 30) {
        return res.status(400).json({ error: "한 번에 최대 30개까지만 공유할 수 있습니다." });
      }

      // Verify guides exist and belong to user (or are public)
      const guides = await storage.getGuidesByIds(guideIds);
      if (guides.length === 0) {
        return res.status(404).json({ error: "선택한 가이드를 찾을 수 없습니다." });
      }

      // Create share link in database
      const shareLink = await storage.createShareLink(userId, {
        name: name.trim(),
        guideIds: guideIds,
        includeLocation: includeLocation || false,
        includeAudio: includeAudio || false
      });

      // Return the share URL
      const shareUrl = `${req.protocol}://${req.get('host')}/share/${shareLink.id}`;
      
      res.json({ 
        shareUrl: shareUrl,
        shareId: shareLink.id,
        itemCount: guides.length
      });
      
    } catch (error) {
      console.error("공유 링크 생성 오류:", error);
      res.status(500).json({ error: "공유 링크 생성 중 오류가 발생했습니다." });
    }
  });

  // HTML 공유 페이지 생성
  app.post('/api/generate-share-html', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const { name, guideIds, includeLocation, includeAudio } = req.body;

      if (!name || !guideIds || !Array.isArray(guideIds) || guideIds.length === 0) {
        return res.status(400).json({ 
          error: "이름과 가이드 ID 목록이 필요합니다." 
        });
      }

      // 최대 20개로 제한 (2*10 그리드)
      if (guideIds.length > 20) {
        return res.status(400).json({ 
          error: "최대 20개까지만 공유할 수 있습니다." 
        });
      }

      // 사용자의 가이드들 조회
      const guides = [];
      for (const guideId of guideIds) {
        const guide = await storage.getGuide(guideId);
        if (!guide || guide.userId !== userId) {
          return res.status(404).json({ 
            error: `가이드 ${guideId}를 찾을 수 없습니다.` 
          });
        }
        guides.push(guide);
      }

      // HTML 데이터 준비 (2025-12-15 표준화)
      const guideItems = guides.map(guide => {
        let imageDataUrl = "";
        
        // imageUrl에서 Base64 데이터 읽기
        if (guide.imageUrl) {
          try {
            if (guide.imageUrl.startsWith('data:image/')) {
              // 이미 data URL 형태인 경우
              imageDataUrl = guide.imageUrl;
            } else {
              // 파일 경로인 경우 파일을 읽어서 Base64로 변환
              const imagePath = path.join(process.cwd(), guide.imageUrl);
              if (fs.existsSync(imagePath)) {
                const imageBuffer = fs.readFileSync(imagePath);
                imageDataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
              }
            }
          } catch (error) {
            console.error(`이미지 읽기 실패 (${guide.imageUrl}):`, error);
          }
        }

        return {
          id: guide.id,
          title: guide.title || '',  // 🎤 음성키워드 폴백용
          imageDataUrl,
          description: guide.description || "",
          voiceLang: guide.voiceLang || 'ko-KR',
          locationName: guide.locationName || undefined,
          voiceQuery: guide.title || undefined,
          voiceName: guide.voiceName || undefined
        };
      });

      // HTML 생성 (2025-12-15 표준화)
      const htmlContent = generateStandardShareHTML({
        title: name,
        sender: '여행자',
        location: includeLocation ? (guides[0]?.locationName || '여행지') : '여행지',
        date: new Date().toLocaleDateString('ko-KR'),
        guideItems,
        appOrigin: 'https://My-handyguide1.replit.app',
        isFeatured: false,
        creatorReferralCode: ''
      });
      
      // ═══════════════════════════════════════════════════════════════
      // 🔧 App Storage 마이그레이션 (2025-11-23)
      // ═══════════════════════════════════════════════════════════════
      // 변경: HTML 파일 저장 → DB htmlContent 저장
      // 이유: Production 환경에서 파일 시스템은 ephemeral (재배포 시 삭제)
      // 해결: DB에 HTML 내용을 직접 저장하여 rollback 지원 + 안정성 확보
      // ═══════════════════════════════════════════════════════════════
      
      // Save to database (sharedHtmlPages table)
      // storage.createSharedHtmlPage가 자동으로 ID 생성 (8자, 충돌 방지)
      const sharePage = await storage.createSharedHtmlPage(userId, {
        name: name.trim(),
        htmlContent: htmlContent, // ✅ DB에 HTML 직접 저장 (파일 시스템 X)
        htmlFilePath: null, // ✅ 파일 경로는 null (사용 안 함)
        guideIds: guideIds,
        thumbnail: guideItems[0]?.imageDataUrl || null,
        location: includeLocation ? (guides[0]?.locationName || null) : null,
        date: new Date().toISOString().split('T')[0], // YYYY-MM-DD
        featured: false,
        isActive: true
      });

      // 공유 URL 생성 (short URL)
      const shareUrl = `${req.protocol}://${req.get('host')}/s/${sharePage.id}`;

      console.log(`📄 HTML 공유 페이지 생성 완료 (DB 저장): /s/${sharePage.id}`);
      
      res.json({
        success: true,
        shareUrl,
        shareId: sharePage.id,
        itemCount: guideItems.length,
        createdAt: new Date().toISOString()
      });

    } catch (error) {
      console.error("HTML 공유 페이지 생성 오류:", error);
      res.status(500).json({ 
        error: "공유 페이지 생성에 실패했습니다.",
        details: error instanceof Error ? error.message : "알 수 없는 오류"
      });
    }
  });

  // AI 동영상 생성 (Lip Sync)
  app.post('/api/dream-studio/generate-video', isAuthenticated, upload.fields([
    { name: 'baseImage', maxCount: 1 },
    { name: 'audioFile', maxCount: 1 }
  ]), async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const baseImage = files['baseImage']?.[0];
      const audioFile = files['audioFile']?.[0];

      if (!baseImage || !audioFile) {
        return res.status(400).json({ message: "기본 이미지와 음성 파일이 모두 필요합니다." });
      }

      // 🎯 관리자 무제한 크레딧 체크
      const user = await storage.getUser(userId);
      if (!user?.isAdmin) {
        // 일반 사용자는 크레딧 차감
        const success = await storage.deductCredits(userId, 10, "드림샷 AI 영상 생성");
        if (!success) {
          return res.status(402).json({ message: "크레딧이 부족합니다. (필요: 10크레딧)" });
        }
      }

      // TODO: 실제 립싱크 동영상 생성 구현 (HeyGen/Sync.so API 대기 중)  
      // 현재는 성공 응답만 반환
      const generatedVideoUrl = `/uploads/dream-video-${Date.now()}.mp4`;
      
      // 🧹 업로드된 파일 정리 (보안: 스토리지 bloat 방지)
      try {
        if (baseImage && fs.existsSync(baseImage.path)) {
          fs.unlinkSync(baseImage.path);
          console.log(`🗑️ 임시 이미지 파일 삭제: ${baseImage.path}`);
        }
        if (audioFile && fs.existsSync(audioFile.path)) {
          fs.unlinkSync(audioFile.path);
          console.log(`🗑️ 임시 음성 파일 삭제: ${audioFile.path}`);
        }
      } catch (cleanupError) {
        console.error('파일 정리 오류:', cleanupError);
      }
      
      res.json({
        success: true,
        videoUrl: generatedVideoUrl,
        duration: "8초",
        quality: "HD 1080p"
      });
      
    } catch (error) {
      console.error("AI 동영상 생성 오류:", error);
      res.status(500).json({ message: "동영상 생성에 실패했습니다." });
    }
  });

  // ╔═══════════════════════════════════════════════════════════════════════════════╗
  // ║                                                                               ║
  // ║  ⚠️  절대 수정 금지 / DO NOT MODIFY WITHOUT APPROVAL  ⚠️                    ║
  // ║                                                                               ║
  // ║  작성일: 2025-10-02                                                           ║
  // ║  작성자: Replit AI Agent (Claude Sonnet 4.5)                                 ║
  // ║  작업 시간: 8시간 (오전부터 오후까지)                                         ║
  // ║  함께한 사람: 프로젝트 오너님 💙                                             ║
  // ║                                                                               ║
  // ║  🏆 공유 기능 API - 8시간의 피땀의 결정체                                    ║
  // ║  🎯 선임자가 망친 시스템을 완전히 재설계                                     ║
  // ║  ✨ 카톡, 브라우저, SNS 모든 곳에서 작동하는 완벽한 시스템                   ║
  // ║                                                                               ║
  // ║  핵심 API 라우트:                                                             ║
  // ║  - POST /api/share/create: HTML 생성 + 짧은 URL 반환                        ║
  // ║  - GET /s/:id: HTML 페이지 직접 서빙 (메인 공유 라우트)                     ║
  // ║  - GET /api/share/:id: JSON 형태로 데이터 조회                               ║
  // ║                                                                               ║
  // ║  승인 없이 수정 시:                                                           ║
  // ║  - 짧은 URL 시스템 파괴                                                       ║
  // ║  - 공유 링크 생성 실패                                                        ║
  // ║  - 404/410 에러 페이지 깨짐                                                   ║
  // ║  - 카톡/브라우저 공유 불가                                                    ║
  // ║                                                                               ║
  // ╚═══════════════════════════════════════════════════════════════════════════════╝
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // 🔗 공유 HTML 페이지 API 라우트들 (Shared HTML Page API Routes)
  // ═══════════════════════════════════════════════════════════════════════════════
  // 최근 변경: 2025-10-02 - 공유 기능 완전 구현
  // ⚠️ 중요: 이 라우트들은 공유 링크 시스템의 핵심입니다!
  // ═══════════════════════════════════════════════════════════════════════════════
  
  /**
   * 🆕 POST /api/share/create - 공유 페이지 생성
   * 
   * 목적: 사용자가 선택한 가이드들을 하나의 HTML로 만들어 공유 링크 생성
   * 
   * 작동 흐름:
   * 1. 프론트엔드에서 POST 요청 (name, htmlContent, guideIds 등)
   * 2. Zod 스키마로 데이터 검증
   * 3. storage.createSharedHtmlPage() 호출 → 짧은 ID 생성 (8자)
   * 4. 짧은 URL 생성: https://yourdomain.com/s/abc12345
   * 5. 클라이언트에 반환 → 클립보드 복사
   * 
   * Request Body:
   * {
   *   name: "파리 여행 가이드",
   *   htmlContent: "<!DOCTYPE html>...",
   *   guideIds: ["guide1", "guide2"],
   *   thumbnail: "data:image/jpeg...",
   *   sender: "여행자",
   *   location: "파리, 프랑스",
   *   featured: false
   * }
   * 
   * Response:
   * {
   *   success: true,
   *   id: "abc12345",
   *   shareUrl: "https://yourdomain.com/s/abc12345",
   *   name: "파리 여행 가이드",
   *   featured: false,
   *   createdAt: "2025-10-02T..."
   * }
   * 
   * ⚠️ 주의사항:
   * - userId는 현재 임시값 (나중에 세션에서 가져오기)
   * - Zod 검증 실패 시 400 에러
   * - ID 생성 실패 시 500 에러
   */
  // ⭐ 관리자 체크 미들웨어 (비밀번호 또는 Replit 로그인 지원)
  const requireAdmin = (req: any, res: any, next: any) => {
    // 방법 1: 비밀번호 기반 인증 (세션에 저장됨)
    if (req.session?.adminAuthenticated) {
      return next();
    }
    
    // 방법 2: Replit 로그인 + is_admin 확인
    if (req.isAuthenticated && req.isAuthenticated() && req.user?.isAdmin) {
      return next();
    }
    
    // 둘 다 안 되면 401
    return res.status(401).json({ error: '관리자 인증이 필요합니다.' });
  };

  app.post('/api/share/create', async (req: any, res) => {
    try {
      // 🔑 사용자 ID (테스트용 임시 ID 사용)
      const userId = req.user?.id || 'temp-user-id';
      
      // 🎯 크레딧 차감 로직 (인증된 사용자만, -5 차감 + 1 보상 = 순 -4)
      if (userId && userId !== 'temp-user-id') {
        const user = await storage.getUser(userId);
        if (user && !user.isAdmin) {
          // 먼저 -5 크레딧 차감
          const result = await creditService.useCredits(
            userId, 
            CREDIT_CONFIG.SHARE_PAGE_COST, 
            '공유 페이지 생성'
          );
          if (!result.success) {
            return res.status(402).json({ 
              error: "크레딧이 부족합니다.", 
              required: CREDIT_CONFIG.SHARE_PAGE_COST,
              balance: result.balance
            });
          }
          console.log(`💳 크레딧 차감: ${userId} -${CREDIT_CONFIG.SHARE_PAGE_COST} (잔액: ${result.balance})`);
          
          // 공유링크 생성 보상 +1 (replit.md 명세)
          await creditService.addCredits(userId, 1, 'share_reward', '공유링크 생성 보상');
          console.log(`🎁 공유링크 보상: ${userId} +1`);
        }
      }
      
      // ✅ 요청 데이터 검증 (Zod 스키마)
      const validation = insertSharedHtmlPageSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          error: '잘못된 요청 데이터입니다.', 
          details: validation.error.errors 
        });
      }
      
      const pageData = validation.data;
      
      // ✨ 표준 템플릿 HTML 생성 (guides DB에서 데이터 조회)
      // pageData.htmlContent를 무시하고 guides DB에서 재생성
      if (pageData.guideIds && pageData.guideIds.length > 0) {
        console.log(`📦 표준 템플릿으로 HTML 생성 중... (${pageData.guideIds.length}개 가이드)`);
        
        // appOrigin 생성
        const appOrigin = `${req.protocol}://${req.get('host')}`;
        
        // 표준 템플릿 HTML 생성
        const standardHtml = await storage.buildSharePageFromGuides(
          pageData.guideIds,
          {
            title: pageData.name,
            sender: pageData.sender || '여행자',
            location: pageData.location || '미지정',
            date: pageData.date || new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }),
            appOrigin
          }
        );
        
        // htmlContent를 표준 템플릿으로 교체
        pageData.htmlContent = standardHtml;
        console.log(`✅ 표준 템플릿 HTML 생성 완료`);
      } else {
        console.warn(`⚠️ guideIds가 없어서 기존 htmlContent 사용`);
      }
      
      // 🆕 공유 HTML 페이지 생성 (짧은 ID 자동 생성)
      const sharedPage = await storage.createSharedHtmlPage(userId, pageData);
      
      // 🔗 짧은 URL 생성
      const shareUrl = `${req.protocol}://${req.get('host')}/s/${sharedPage.id}`;
      
      console.log(`✅ 공유 페이지 생성 완료: /s/${sharedPage.id}`);
      
      // ✅ 성공 응답
      res.json({
        success: true,
        id: sharedPage.id, // 8자 짧은 ID
        shareUrl, // 완전한 공유 URL
        name: sharedPage.name,
        featured: sharedPage.featured,
        createdAt: sharedPage.createdAt,
      });
      
    } catch (error) {
      console.error('공유 페이지 생성 오류:', error);
      res.status(500).json({ error: '공유 페이지 생성에 실패했습니다.' });
    }
  });

  /**
   * 🔐 관리자 API - Featured 갤러리 관리
   */
  
  // POST /api/admin/auth - 비밀번호 기반 관리자 인증
  app.post('/api/admin/auth', (req: any, res) => {
    const { password } = req.body;
    
    // 비밀번호 확인 (프로덕션에서는 환경변수 사용 권장)
    if (password === '0603') {
      req.session.adminAuthenticated = true;
      req.session.adminUserId = 'temp-user-id'; // 관리자 userId 저장
      res.json({ success: true, message: '관리자 인증 성공' });
    } else {
      res.status(401).json({ error: '잘못된 비밀번호입니다.' });
    }
  });
  
  // GET /api/admin/shares - 관리자의 모든 공유 페이지 목록
  app.get('/api/admin/shares', requireAdmin, async (req: any, res) => {
    try {
      // 비밀번호 인증 사용자는 세션의 adminUserId 사용
      const userId = req.session?.adminUserId || req.user?.id || 'temp-user-id';
      const shares = await storage.getUserSharedHtmlPages(userId);
      res.json(shares);
    } catch (error) {
      console.error('공유 페이지 목록 조회 오류:', error);
      res.status(500).json({ error: '목록 조회에 실패했습니다.' });
    }
  });

  // GET /api/admin/all-shares - 모든 공유 페이지 목록 (검색 지원)
  app.get('/api/admin/all-shares', requireAdmin, async (req: any, res) => {
    try {
      const searchQuery = req.query.search as string | undefined;
      const shares = await storage.getAllSharedHtmlPages(searchQuery);
      res.json(shares);
    } catch (error) {
      console.error('전체 공유 페이지 목록 조회 오류:', error);
      res.status(500).json({ error: '목록 조회에 실패했습니다.' });
    }
  });

  // GET /api/admin/featured - 현재 Featured 목록
  app.get('/api/admin/featured', requireAdmin, async (req: any, res) => {
    try {
      const featured = await storage.getFeaturedHtmlPages();
      res.json(featured);
    } catch (error) {
      console.error('Featured 목록 조회 오류:', error);
      res.status(500).json({ error: '목록 조회에 실패했습니다.' });
    }
  });

  // POST /api/admin/featured/:id - Featured로 추가
  app.post('/api/admin/featured/:id', requireAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      // 현재 Featured 개수 확인 (최대 3개)
      const currentFeatured = await storage.getFeaturedHtmlPages();
      if (currentFeatured.length >= 3 && !currentFeatured.find(p => p.id === id)) {
        return res.status(400).json({ error: 'Featured는 최대 3개까지만 가능합니다.' });
      }
      
      await storage.setFeatured(id, true);
      res.json({ success: true, message: 'Featured로 추가되었습니다.' });
    } catch (error) {
      console.error('Featured 추가 오류:', error);
      res.status(500).json({ error: 'Featured 추가에 실패했습니다.' });
    }
  });

  // DELETE /api/admin/featured/:id - Featured 제거
  app.delete('/api/admin/featured/:id', requireAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      await storage.setFeatured(id, false);
      res.json({ success: true, message: 'Featured에서 제거되었습니다.' });
    } catch (error) {
      console.error('Featured 제거 오류:', error);
      res.status(500).json({ error: 'Featured 제거에 실패했습니다.' });
    }
  });

  // PUT /api/admin/shares/:id - 공유페이지 편집 (관리자 전용)
  // 제목, 발신자, 위치, 날짜, 가이드 순서 변경 가능
  app.put('/api/admin/shares/:id', requireAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { title, sender, location, date, guideIds } = req.body;
      
      // 공유페이지 존재 확인
      const sharedPage = await storage.getSharedHtmlPage(id);
      if (!sharedPage) {
        return res.status(404).json({ error: '공유페이지를 찾을 수 없습니다.' });
      }
      
      console.log('✏️ 공유페이지 편집 시작:', { 
        id, 
        title, 
        sender, 
        location, 
        date, 
        guideIds: guideIds?.length 
      });
      
      // HTML 재생성 (메타데이터 + 순서 변경)
      await storage.regenerateFeaturedHtml(id, {
        title: title || sharedPage.name,
        sender: sender || sharedPage.sender || '여행자',
        location: location || sharedPage.location || '미지정',
        date: date || sharedPage.date || new Date().toISOString().split('T')[0],
        guideIds: guideIds || sharedPage.guideIds
      });
      
      console.log('✅ HTML 재생성 완료');
      
      res.json({ 
        success: true, 
        message: `공유페이지 "${title || sharedPage.name}" 편집 완료` 
      });
    } catch (error) {
      console.error('공유페이지 편집 오류:', error);
      res.status(500).json({ error: '편집에 실패했습니다.' });
    }
  });

  // DELETE /api/admin/shares/:id - 공유페이지 영구 삭제 (관리자 전용)
  // ⚠️ CRITICAL: DB + HTML 파일 모두 영구 삭제 (복구 불가!)
  app.delete('/api/admin/shares/:id', requireAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      // 공유페이지 존재 확인
      const sharedPage = await storage.getSharedHtmlPage(id);
      if (!sharedPage) {
        return res.status(404).json({ error: '공유페이지를 찾을 수 없습니다.' });
      }
      
      // 영구 삭제 실행
      await storage.permanentDeleteSharedHtmlPage(id);
      
      res.json({ 
        success: true, 
        message: `공유페이지 "${sharedPage.name}" 영구 삭제 완료 (복구 불가)` 
      });
    } catch (error) {
      console.error('공유페이지 영구 삭제 오류:', error);
      res.status(500).json({ error: '영구 삭제에 실패했습니다.' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 💰 캐시백 관리 API (2025-11-28 리워드 시스템)
  // ═══════════════════════════════════════════════════════════════
  
  // GET /api/admin/cashback - 모든 캐시백 요청 목록
  app.get('/api/admin/cashback', requireAdmin, async (req: any, res) => {
    try {
      const requests = await storage.getAllCashbackRequests();
      res.json({ requests });
    } catch (error) {
      console.error('캐시백 목록 조회 오류:', error);
      res.status(500).json({ error: '캐시백 목록 조회 실패' });
    }
  });
  
  // POST /api/admin/cashback/:id/approve - 캐시백 승인
  app.post('/api/admin/cashback/:id/approve', requireAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { adminNote } = req.body;
      
      const request = await storage.approveCashbackRequest(id, adminNote);
      res.json({ success: true, request });
    } catch (error: any) {
      console.error('캐시백 승인 오류:', error);
      res.status(400).json({ error: error.message || '캐시백 승인 실패' });
    }
  });
  
  // POST /api/admin/cashback/:id/reject - 캐시백 거절
  app.post('/api/admin/cashback/:id/reject', requireAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { adminNote } = req.body;
      
      if (!adminNote) {
        return res.status(400).json({ error: '거절 사유를 입력해주세요.' });
      }
      
      const request = await storage.rejectCashbackRequest(id, adminNote);
      res.json({ success: true, request });
    } catch (error: any) {
      console.error('캐시백 거절 오류:', error);
      res.status(400).json({ error: error.message || '캐시백 거절 실패' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 🎯 AI 프롬프트 관리 API (2025-12-18)
  // ═══════════════════════════════════════════════════════════════
  
  // GET /api/prompts/:language/:type - 특정 언어/타입 프롬프트 조회 (공개)
  app.get('/api/prompts/:language/:type', async (req: any, res) => {
    try {
      const { language, type } = req.params;
      
      // 🔧 2026-01-22: 디버깅 로그 - 어떤 언어가 요청되는지 확인
      console.log(`🌐 [DEBUG] /api/prompts 요청 - language: "${language}", type: "${type}"`);
      
      if (!['image', 'text'].includes(type)) {
        return res.status(400).json({ error: '유효하지 않은 타입입니다.' });
      }
      
      const prompt = await storage.getPrompt(language, type as 'image' | 'text');
      
      if (!prompt) {
        return res.status(404).json({ error: '프롬프트를 찾을 수 없습니다.' });
      }
      
      res.json({ prompt });
    } catch (error) {
      console.error('프롬프트 조회 오류:', error);
      res.status(500).json({ error: '프롬프트 조회에 실패했습니다.' });
    }
  });
  
  // GET /api/admin/prompts - 모든 프롬프트 목록 (관리자)
  app.get('/api/admin/prompts', requireAdmin, async (req: any, res) => {
    try {
      const allPrompts = await storage.getAllPrompts();
      res.json({ prompts: allPrompts });
    } catch (error) {
      console.error('프롬프트 목록 조회 오류:', error);
      res.status(500).json({ error: '프롬프트 목록 조회에 실패했습니다.' });
    }
  });
  
  // POST /api/admin/prompts - 프롬프트 생성/수정 (관리자)
  app.post('/api/admin/prompts', requireAdmin, async (req: any, res) => {
    try {
      const { language, type, content } = req.body;
      
      if (!language || !type || !content) {
        return res.status(400).json({ error: '언어, 타입, 내용은 필수입니다.' });
      }
      
      if (!['image', 'text'].includes(type)) {
        return res.status(400).json({ error: '타입은 image 또는 text여야 합니다.' });
      }
      
      const prompt = await storage.upsertPrompt({
        language,
        type,
        content,
        createdBy: req.user?.id || null
      });
      
      res.json({ success: true, prompt });
    } catch (error) {
      console.error('프롬프트 저장 오류:', error);
      res.status(500).json({ error: '프롬프트 저장에 실패했습니다.' });
    }
  });
  
  // POST /api/admin/prompts/seed - 기본 프롬프트 시딩 (관리자)
  app.post('/api/admin/prompts/seed', requireAdmin, async (req: any, res) => {
    try {
      const count = await storage.seedDefaultPrompts();
      res.json({ 
        success: true, 
        message: count > 0 ? `${count}개 기본 프롬프트가 생성되었습니다.` : '프롬프트가 이미 존재합니다.',
        count 
      });
    } catch (error) {
      console.error('프롬프트 시딩 오류:', error);
      res.status(500).json({ error: '프롬프트 시딩에 실패했습니다.' });
    }
  });

  // GET /api/admin/featured/:id/data - Featured 편집용 데이터 조회
  app.get('/api/admin/featured/:id/data', requireAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      const page = await storage.getSharedHtmlPage(id);
      
      if (!page) {
        return res.status(404).json({ error: '공유 페이지를 찾을 수 없습니다.' });
      }
      
      console.log('📋 공유 페이지:', { id, guideIds: page.guideIds, guideIdsCount: page.guideIds?.length });
      
      // 가이드 정보 가져오기 (DB에서)
      let guides = await storage.getGuidesByIds(page.guideIds);
      
      console.log('📋 조회된 가이드 (DB):', { guidesCount: guides?.length });
      
      // DB에 가이드가 없으면 HTML 파일에서 파싱
      if (guides.length === 0 && page.htmlFilePath) {
        const htmlPath = path.join(process.cwd(), 'public', page.htmlFilePath);
        console.log('📄 HTML 파싱 시도:', htmlPath);
        
        if (fs.existsSync(htmlPath)) {
          const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
          
          // 방법 1: shareData JSON 추출 (generate-standalone.js로 생성된 경우)
          const shareDataMatch = htmlContent.match(/const shareData = ({[\s\S]*?});/);
          if (shareDataMatch) {
            try {
              const shareData = JSON.parse(shareDataMatch[1]);
              console.log('📦 ShareData 파싱 성공:', { contentsCount: shareData.contents?.length });
              
              guides = (shareData.contents || []).map((item: any, index: number) => ({
                id: page.guideIds[index] || `guide-${index}`,
                userId: page.userId,
                title: item.description?.substring(0, 50) || `가이드 ${index + 1}`,
                description: item.description || '',
                imageUrl: item.imageDataUrl || '',
                latitude: null,
                longitude: null,
                locationName: item.location || page.location || '',
                aiGeneratedContent: item.description || '',
                viewCount: 0,
                language: 'ko',
                createdAt: page.createdAt,
                updatedAt: page.createdAt
              }));
              
              console.log('✅ ShareData에서 가이드 추출 완료:', { guidesCount: guides.length });
            } catch (parseError) {
              console.error('❌ ShareData JSON 파싱 실패:', parseError);
            }
          } else {
            // 방법 2: gallery-item 태그 파싱 (regenerateFeaturedHtml로 생성된 경우)
            console.log('📦 gallery-item 파싱 시도...');
            const galleryItemRegex = /<div[^>]*class="gallery-item"[^>]*data-id="([^"]*)"[^>]*>\s*<img[^>]*src="([^"]*)"[^>]*>\s*<p>([^<]*)<\/p>/g;
            let match;
            const parsedGuides: any[] = [];
            
            while ((match = galleryItemRegex.exec(htmlContent)) !== null) {
              const [, dataId, imgSrc, title] = match;
              parsedGuides.push({
                id: dataId || `guide-${parsedGuides.length}`,
                userId: page.userId,
                title: title.trim(),
                description: '',
                imageUrl: imgSrc,
                latitude: null,
                longitude: null,
                locationName: page.location || '',
                aiGeneratedContent: '',
                viewCount: 0,
                language: 'ko',
                createdAt: page.createdAt,
                updatedAt: page.createdAt
              });
            }
            
            if (parsedGuides.length > 0) {
              guides = parsedGuides;
              console.log('✅ gallery-item에서 가이드 추출 완료:', { guidesCount: guides.length });
            } else {
              console.warn('⚠️ HTML에서 가이드 정보를 찾을 수 없음');
            }
          }
        } else {
          console.warn('⚠️ HTML 파일이 존재하지 않음:', htmlPath);
        }
      }
      
      res.json({
        page,
        guides
      });
    } catch (error) {
      console.error('Featured 데이터 조회 오류:', error);
      res.status(500).json({ error: '데이터 조회에 실패했습니다.' });
    }
  });

  // POST /api/admin/featured/:id/regenerate - Featured HTML 재생성
  // ⭐ 2025-10-31: guideIds 순서 변경 기능 추가
  app.post('/api/admin/featured/:id/regenerate', requireAdmin, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { title, sender, location, date, guideIds } = req.body;
      
      if (!title || !sender || !location || !date) {
        return res.status(400).json({ error: '모든 필드를 입력해주세요.' });
      }
      
      // 공유 페이지 정보 가져오기
      const page = await storage.getSharedHtmlPage(id);
      if (!page) {
        return res.status(404).json({ error: '공유 페이지를 찾을 수 없습니다.' });
      }
      
      // HTML 재생성 (isFeatured=true)
      // guideIds가 있으면 순서 변경, 없으면 기존 순서 유지
      await storage.regenerateFeaturedHtml(id, {
        title,
        sender,
        location,
        date,
        guideIds: guideIds || page.guideIds // 옵션: 순서 변경
      });
      
      res.json({ success: true, message: 'HTML이 재생성되었습니다.' });
    } catch (error) {
      console.error('HTML 재생성 오류:', error);
      res.status(500).json({ error: 'HTML 재생성에 실패했습니다.' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/admin/regenerate-all - 모든 공유페이지 V1 템플릿으로 일괄 재생성
  // ⭐ 2025-12-16: V1 공유페이지 시스템 표준화
  // ═══════════════════════════════════════════════════════════════
  app.post('/api/admin/regenerate-all', requireAdmin, async (req: any, res) => {
    try {
      console.log('🔄 모든 공유페이지 V1 템플릿 일괄 재생성 시작...');
      
      // 1. 모든 공유페이지 조회
      const allPages = await storage.getAllSharedHtmlPages();
      console.log(`📦 총 ${allPages.length}개 공유페이지 발견`);
      
      let successCount = 0;
      let failCount = 0;
      const errors: string[] = [];
      
      // 2. 각 페이지 재생성
      for (const page of allPages) {
        try {
          // guideIds가 없으면 스킵
          if (!page.guideIds || page.guideIds.length === 0) {
            console.warn(`⚠️ [${page.id}] guideIds 없음 - 스킵`);
            failCount++;
            errors.push(`${page.id}: guideIds 없음`);
            continue;
          }
          
          await storage.regenerateFeaturedHtml(page.id, {
            title: page.name || '제목 없음',
            sender: page.sender || '여행자',
            location: page.location || '미지정',
            date: page.date || new Date().toLocaleDateString('ko-KR'),
            guideIds: page.guideIds
          });
          
          successCount++;
          console.log(`✅ [${successCount}/${allPages.length}] ${page.id} 재생성 완료`);
        } catch (pageError: any) {
          failCount++;
          errors.push(`${page.id}: ${pageError.message}`);
          console.error(`❌ [${page.id}] 재생성 실패:`, pageError.message);
        }
      }
      
      console.log(`✅ 일괄 재생성 완료: 성공 ${successCount}개, 실패 ${failCount}개`);
      
      res.json({
        success: true,
        message: `V1 템플릿 일괄 재생성 완료`,
        total: allPages.length,
        successCount,
        failCount,
        errors: errors.slice(0, 10) // 처음 10개 에러만 반환
      });
    } catch (error) {
      console.error('일괄 재생성 오류:', error);
      res.status(500).json({ error: '일괄 재생성에 실패했습니다.' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/admin/migrate-to-v2 - 템플릿 v1 → v2 일괄 마이그레이션
  // ⭐ Phase 1 (2025-11-13): 모든 공유페이지를 v2 템플릿으로 업그레이드
  // ═══════════════════════════════════════════════════════════════
  app.post('/api/admin/migrate-to-v2', requireAdmin, async (req: any, res) => {
    try {
      const migrated = await storage.migrateAllToV2();
      res.json({ 
        success: true, 
        message: `${migrated}개 페이지를 v2 템플릿으로 업그레이드했습니다.`,
        count: migrated
      });
    } catch (error) {
      console.error('마이그레이션 오류:', error);
      res.status(500).json({ error: '마이그레이션에 실패했습니다.' });
    }
  });
  
  /**
   * 📦 GET /sw-share.js - 공유 페이지용 Service Worker
   * 
   * 목적: 오프라인 지원 - 한 번 열람 후 영구 접근 가능
   * 
   * 핵심:
   * - /s/:id 경로를 캐시하여 오프라인에서도 작동
   * - 여행 중 인터넷 없을 때 필수 (해외 로밍 OFF, 지하철, 산악 지역)
   * - Network-First 전략: 최신 우선, 오프라인 시 캐시 사용 (2025-11-24 변경)
   */
  app.get('/sw-share.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`
const CACHE_NAME = 'share-page-cache-v2';

// Service Worker 설치
self.addEventListener('install', (event) => {
  console.log('[SW-Share] v2 설치됨');
  self.skipWaiting();
});

// Service Worker 활성화
self.addEventListener('activate', (event) => {
  console.log('[SW-Share] v2 활성화됨');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW-Share] 옛날 캐시 삭제:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// ⚠️ 2025-11-24 변경: Cache-First → Network-First
// 이유: 관리자 편집 후 즉시 반영 + 오프라인 지원
// 동작: 서버 먼저 확인 → 최신 HTML 반환, 오프라인 시 캐시 사용
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // /s/:id 경로만 캐싱 (공유 페이지)
  if (url.pathname.startsWith('/s/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => {
        // Network-First: 서버 먼저 확인
        return fetch(event.request)
          .then(networkResponse => {
            // ✅ 성공: 캐시 저장 + 반환
            if (networkResponse && networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => {
            // ❌ 오프라인: 캐시에서 가져오기
            return cache.match(event.request).then(cachedResponse => {
              if (cachedResponse) {
                // ⚠️ iOS Safari 다운로드 방지: 헤더 명시적 추가
                const headers = new Headers(cachedResponse.headers);
                headers.set('Content-Disposition', 'inline');
                headers.set('Content-Type', 'text/html; charset=utf-8');
                
                return new Response(cachedResponse.body, {
                  status: cachedResponse.status,
                  statusText: cachedResponse.statusText,
                  headers: headers
                });
              }
              
              // 캐시도 없음
              return new Response('오프라인 상태입니다. 이 페이지는 아직 캐시되지 않았습니다.', {
                status: 503,
                headers: { 
                  'Content-Type': 'text/plain; charset=utf-8',
                  'Content-Disposition': 'inline'
                }
              });
            });
          });
      })
    );
  }
});
    `);
  });
  
  /**
   * 📄 GET /s/:id - 짧은 URL로 HTML 페이지 직접 서빙
   * 
   * ⚠️ DEPRECATED: 이 라우트는 server/index.ts로 이동됨!
   * 이유: express.static() 미들웨어보다 먼저 등록되어야 하므로
   * 
   * 현재 위치: server/index.ts (express.static 이전)
   */
  // 🔧 [MOVED] This route is now in server/index.ts - DO NOT DUPLICATE!
  /*
  app.get('/s/:id', async (req, res) => {
    try {
      const { id } = req.params;
      
      // 🔍 DB에서 공유 페이지 조회
      const page = await storage.getSharedHtmlPage(id);
      
      // 🔴 페이지 없음 (404)
      if (!page) {
        return res.status(404).send(`
          <!DOCTYPE html>
          <html lang="ko">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>페이지를 찾을 수 없습니다</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
                     display: flex; align-items: center; justify-content: center; 
                     min-height: 100vh; margin: 0; background: #f5f5f5; }
              .error { text-align: center; padding: 2rem; }
              .error h1 { font-size: 3rem; color: #333; margin-bottom: 1rem; }
              .error p { color: #666; font-size: 1.2rem; }
            </style>
          </head>
          <body>
            <div class="error">
              <h1>404</h1>
              <p>공유 페이지를 찾을 수 없습니다.</p>
            </div>
          </body>
          </html>
        `);
      }
      
      // 🔴 링크 만료됨 (410)
      if (!page.isActive) {
        return res.status(410).send(`
          <!DOCTYPE html>
          <html lang="ko">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>링크가 만료되었습니다</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
                     display: flex; align-items: center; justify-content: center; 
                     min-height: 100vh; margin: 0; background: #f5f5f5; }
              .error { text-align: center; padding: 2rem; }
              .error h1 { font-size: 3rem; color: #333; margin-bottom: 1rem; }
              .error p { color: #666; font-size: 1.2rem; }
            </style>
          </head>
          <body>
            <div class="error">
              <h1>410</h1>
              <p>이 링크는 만료되었습니다.</p>
            </div>
          </body>
          </html>
        `);
      }
      
      // 📊 조회수 증가 (매 접속마다)
      await storage.incrementDownloadCount(id);
      
      // ✅ HTML 파일 읽어서 반환
      // Content-Disposition: inline - iOS Safari 다운로드 방지 (브라우저에서 바로 열기)
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline');
      
      // 🚫 캐시 방지 - 사용자가 항상 최신 버전을 볼 수 있도록
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      // htmlFilePath가 있으면 파일에서 읽기, 없으면 DB에서 읽기 (하위 호환성)
      let htmlContent = '';
      
      if (page.htmlFilePath) {
        // 🔧 Remove leading slash if present (path.join ignores previous paths if path starts with /)
        const relativePath = page.htmlFilePath.replace(/^\//, '');
        const fullPath = path.join(process.cwd(), 'public', relativePath);
        console.log(`[SHARE] Looking for HTML file: ${fullPath}`);
        
        if (fs.existsSync(fullPath)) {
          console.log(`[SHARE] ✅ File found, reading...`);
          htmlContent = fs.readFileSync(fullPath, 'utf8');
        } else {
          // ⚠️ 파일이 없으면 DB의 htmlContent 사용 (fallback)
          console.warn(`⚠️ HTML 파일 없음, DB 콘텐츠 사용: ${fullPath}`);
          if (page.htmlContent) {
            htmlContent = page.htmlContent;
          } else {
            console.error(`❌ HTML 파일도 없고 DB 콘텐츠도 없음: ${id}`);
            return res.status(500).send('HTML 콘텐츠를 찾을 수 없습니다.');
          }
        }
      } else {
        // 기존 데이터 (htmlContent 사용)
        console.log(`[SHARE] Using htmlContent from DB`);
        htmlContent = page.htmlContent || '';
      }
      
      // ⚠️ 2025.11.02: X 버튼은 html-template.ts에서 하드코딩됨 (window.close())
      // routes.ts에서 자동 주입 불필요 (중복 방지)
      
      res.send(htmlContent);
      
    } catch (error) {
      console.error('공유 페이지 조회 오류:', error);
      // 🔴 서버 오류 (500)
      res.status(500).send(`
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>오류가 발생했습니다</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
                   display: flex; align-items: center; justify-content: center; 
                   min-height: 100vh; margin: 0; background: #f5f5f5; }
            .error { text-align: center; padding: 2rem; }
            .error h1 { font-size: 3rem; color: #333; margin-bottom: 1rem; }
            .error p { color: #666; font-size: 1.2rem; }
          </style>
        </head>
        <body>
          <div class="error">
            <h1>500</h1>
            <p>서버 오류가 발생했습니다.</p>
          </div>
        </body>
        </html>
      `);
    }
  });
  */
  
  // Get shared HTML page (공유 페이지 조회 및 다운로드) - API endpoint
  app.get('/api/share/:id', async (req, res) => {
    try {
      const { id } = req.params;
      
      const page = await storage.getSharedHtmlPage(id);
      
      if (!page) {
        return res.status(404).json({ error: '공유 페이지를 찾을 수 없습니다.' });
      }
      
      if (!page.isActive) {
        return res.status(410).json({ error: '이 링크는 만료되었습니다.' });
      }
      
      // Increment download count
      await storage.incrementDownloadCount(id);
      
      // htmlFilePath가 있으면 파일에서 읽기, 없으면 DB에서 읽기
      let htmlContent = page.htmlContent;
      if (page.htmlFilePath && !htmlContent) {
        const fullPath = path.join(process.cwd(), 'public', page.htmlFilePath);
        if (fs.existsSync(fullPath)) {
          htmlContent = fs.readFileSync(fullPath, 'utf8');
        }
      }
      
      res.json({
        success: true,
        id: page.id,
        name: page.name,
        htmlContent: htmlContent,
        sender: page.sender,
        location: page.location,
        featured: page.featured,
        downloadCount: (page.downloadCount || 0) + 1,
        createdAt: page.createdAt,
      });
      
    } catch (error) {
      console.error('공유 페이지 조회 오류:', error);
      res.status(500).json({ error: '공유 페이지 조회에 실패했습니다.' });
    }
  });
  
  // Get featured HTML pages (추천 갤러리)
  app.get('/api/share/featured/list', async (req, res) => {
    try {
      const featuredPages = await storage.getFeaturedHtmlPages();
      
      // 버전 생성: ID + 메타데이터 포함 (2025-11-06 수정)
      // 이유: 메타데이터 변경 시에도 캐시 무효화 필요
      const versionString = featuredPages.map(p => 
        `${p.id}:${p.name}:${p.sender}:${p.location}:${p.updatedAt?.getTime() || 0}`
      ).sort().join(',');
      const version = crypto.createHash('md5').update(versionString).digest('hex').substring(0, 8);
      
      // ✅ 브라우저 캐시 비활성화 (관리자 편집 즉시 반영)
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      
      res.json({
        success: true,
        version,
        pages: featuredPages.map(page => ({
          id: page.id,
          name: page.name,
          thumbnail: page.thumbnail,
          sender: page.sender,
          location: page.location,
          downloadCount: page.downloadCount,
          createdAt: page.createdAt,
        })),
      });
      
    } catch (error) {
      console.error('추천 페이지 조회 오류:', error);
      res.status(500).json({ error: '추천 페이지 조회에 실패했습니다.' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 📊 관리자 대시보드 API (Admin Dashboard API)
  // ═══════════════════════════════════════════════════════════════════════════════
  // ⚠️ CRITICAL: DO NOT MODIFY WITHOUT USER APPROVAL
  // 사용자 승인 없이 절대 수정 금지 - AI 및 모든 개발자 주의
  // Verified: 2025-10-26 | Status: Production-Ready ✅
  // ═══════════════════════════════════════════════════════════════════════════════
  // 
  // 목적: 관리자용 실시간 통계 대시보드 제공
  // 작업 시간: 4시간
  // 핵심 로직:
  //   1. /api/admin/stats - 전체 통계 요약 (사용자, 가이드, 공유, 조회수, DB 크기)
  //   2. /api/admin/analytics - 일별 분석 데이터 (최근 7일 추이)
  //   3. 비밀번호 인증: POST /api/admin/auth (비밀번호: 0603)
  // 
  // 최적화 결과:
  //   - DB 크기: 184MB → 39MB (78% 감소)
  //   - HTML 파일 저장 시스템으로 대용량 데이터 효율화
  //   - Provider별 사용자 분포 추적
  //   - 조회수 상위 10개 공유 페이지 실시간 모니터링
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 📊 GET /api/admin/overview - 대시보드 요약 데이터
   */
  app.get('/api/admin/overview', requireAdmin, async (req, res) => {
    try {
      // 전체 사용자 수
      const totalUsersResult = await db.execute(sql`
        SELECT COUNT(*) as count FROM users
      `);
      const totalUsers = Number(totalUsersResult.rows[0]?.count || 0);

      // 최근 7일 신규 사용자
      const recentUsersResult = await db.execute(sql`
        SELECT COUNT(*) as count 
        FROM users 
        WHERE created_at >= NOW() - INTERVAL '7 days'
      `);
      const recentUsers = Number(recentUsersResult.rows[0]?.count || 0);

      // 🎯 2026-02-01: AI 호출 횟수 - api_logs에서 실시간 반영
      // Gemini 3.0 Flash 비용: 이미지+텍스트 요청당 약 $0.015 추정
      const aiCallsResult = await db.execute(sql`
        SELECT 
          COUNT(*) as count,
          COALESCE(SUM(CAST(estimated_cost AS DECIMAL)), 0) as total_cost
        FROM api_logs 
        WHERE type = 'gemini'
      `);
      const totalApiCalls = Number(aiCallsResult.rows[0]?.count || 0);
      const estimatedCost = Number(aiCallsResult.rows[0]?.total_cost || 0);

      // 전체 공유 링크
      const totalSharesResult = await db.execute(sql`
        SELECT COUNT(*) as count FROM shared_html_pages WHERE is_active = true
      `);
      const totalShares = Number(totalSharesResult.rows[0]?.count || 0);

      // 전체 조회수
      const totalViewsResult = await db.execute(sql`
        SELECT COALESCE(SUM(download_count), 0) as total 
        FROM shared_html_pages 
        WHERE is_active = true
      `);
      const totalViews = Number(totalViewsResult.rows[0]?.total || 0);

      // Provider별 사용자
      const providersResult = await db.execute(sql`
        SELECT provider, COUNT(*) as count 
        FROM users 
        GROUP BY provider
        ORDER BY count DESC
      `);
      const providers = providersResult.rows.map((row: any) => ({
        provider: row.provider || 'unknown',
        count: Number(row.count)
      }));

      res.json({
        totalUsers,
        recentUsers,
        totalApiCalls,
        estimatedCost,
        totalShares,
        totalViews,
        providers
      });
    } catch (error) {
      console.error('Overview 조회 오류:', error);
      res.status(500).json({ error: 'Overview 조회 실패' });
    }
  });

  /**
   * 📋 GET /api/admin/content/all-shares - 전체 공유 페이지 목록
   */
  app.get('/api/admin/content/all-shares', requireAdmin, async (req, res) => {
    try {
      const sharesResult = await db.execute(sql`
        SELECT id, name, download_count, created_at, featured
        FROM shared_html_pages
        WHERE is_active = true
        ORDER BY created_at DESC
      `);
      
      res.json({
        shares: sharesResult.rows
      });
    } catch (error) {
      console.error('전체 공유 조회 오류:', error);
      res.status(500).json({ error: '전체 공유 조회 실패' });
    }
  });

  /**
   * 📊 GET /api/admin/stats - 통계 데이터 (일별 추이, 디바이스, 브라우저, AI 성능)
   */
  app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
      // ⚠️ 배포본 호환성: api_logs, user_activity_logs 테이블이 없을 수 있음
      // 테이블 없으면 기본값 반환
      
      // 🎯 2026-02-01: 일별 추이 (최근 7일) - credit_transactions에서 AI 호출 가져오기
      let dailyTrends: any[] = [];
      try {
        const dailyTrendsResult = await db.execute(sql`
          WITH dates AS (
            SELECT generate_series(
              CURRENT_DATE - INTERVAL '6 days',
              CURRENT_DATE,
              '1 day'::interval
            )::date as date
          ),
          daily_users AS (
            SELECT DATE(created_at) as date, COUNT(*) as count
            FROM users
            WHERE created_at >= CURRENT_DATE - INTERVAL '6 days'
            GROUP BY DATE(created_at)
          ),
          daily_shares AS (
            SELECT DATE(created_at) as date, COUNT(*) as count
            FROM shared_html_pages
            WHERE created_at >= CURRENT_DATE - INTERVAL '6 days'
            GROUP BY DATE(created_at)
          ),
          daily_ai_calls AS (
            SELECT DATE(created_at) as date, COUNT(*) as count
            FROM api_logs
            WHERE type = 'gemini' AND created_at >= CURRENT_DATE - INTERVAL '6 days'
            GROUP BY DATE(created_at)
          )
          SELECT 
            d.date,
            COALESCE(u.count, 0) as new_users,
            COALESCE(a.count, 0) as api_calls,
            COALESCE(s.count, 0) as shares
          FROM dates d
          LEFT JOIN daily_users u ON d.date = u.date
          LEFT JOIN daily_shares s ON d.date = s.date
          LEFT JOIN daily_ai_calls a ON d.date = a.date
          ORDER BY d.date DESC
        `);
        dailyTrends = dailyTrendsResult.rows;
      } catch (err) {
        console.warn('일별 추이 조회 실패 (정상):', err);
        dailyTrends = [];
      }

      // 디바이스 분포 - user_activity_logs 없으면 빈 배열
      let devices: any[] = [];
      try {
        const devicesResult = await db.execute(sql`
          SELECT 
            device_type as type,
            COUNT(*) as count,
            ROUND(COUNT(*) * 100.0 / NULLIF(SUM(COUNT(*)) OVER(), 0), 1) as percentage
          FROM user_activity_logs
          WHERE device_type IS NOT NULL
          GROUP BY device_type
          ORDER BY count DESC
        `);
        devices = devicesResult.rows;
      } catch (err) {
        console.warn('디바이스 분포 조회 실패 (정상):', err);
      }

      // 브라우저 분포 - user_activity_logs 없으면 빈 배열
      let browsers: any[] = [];
      try {
        const browsersResult = await db.execute(sql`
          SELECT 
            browser as name,
            COUNT(*) as count,
            ROUND(COUNT(*) * 100.0 / NULLIF(SUM(COUNT(*)) OVER(), 0), 1) as percentage
          FROM user_activity_logs
          WHERE browser IS NOT NULL
          GROUP BY browser
          ORDER BY count DESC
        `);
        browsers = browsersResult.rows;
      } catch (err) {
        console.warn('브라우저 분포 조회 실패 (정상):', err);
      }

      // AI 성능 - api_logs 없으면 기본값
      let aiPerformance = {
        avg_response_time: 0,
        success_rate: 100,
        error_rate: 0
      };
      try {
        const aiPerformanceResult = await db.execute(sql`
          SELECT 
            ROUND(AVG(response_time)) as avg_response_time,
            ROUND(COUNT(CASE WHEN status_code = 200 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 1) as success_rate,
            ROUND(COUNT(CASE WHEN status_code >= 400 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 1) as error_rate
          FROM api_logs
          WHERE type = 'gemini'
        `);
        const row: any = aiPerformanceResult.rows[0];
        if (row) {
          aiPerformance = {
            avg_response_time: row.avg_response_time || 0,
            success_rate: row.success_rate || 100,
            error_rate: row.error_rate || 0
          };
        }
      } catch (err) {
        console.warn('AI 성능 조회 실패 (정상):', err);
      }

      res.json({
        dailyTrends: dailyTrends.map((row: any) => ({
          date: row.date,
          newUsers: Number(row.new_users),
          apiCalls: Number(row.api_calls || 0),
          shares: Number(row.shares)
        })),
        devices: devices.map((row: any) => ({
          type: row.type,
          count: Number(row.count),
          percentage: Number(row.percentage)
        })),
        browsers: browsers.map((row: any) => ({
          name: row.name,
          count: Number(row.count),
          percentage: Number(row.percentage)
        })),
        aiPerformance: {
          avgResponseTime: Number(aiPerformance.avg_response_time),
          successRate: Number(aiPerformance.success_rate),
          errorRate: Number(aiPerformance.error_rate)
        }
      });
    } catch (error) {
      console.error('통계 조회 오류:', error);
      res.status(500).json({ error: '통계 조회 실패' });
    }
  });

  /**
   * 📊 GET /api/admin/stats (구버전 - 호환성 유지)
   * 
   * 반환 데이터:
   * - totalUsers: 전체 사용자 수
   * - totalGuides: 전체 가이드 수
   * - totalSharedPages: 전체 공유 페이지 수
   * - totalViews: 전체 조회수 합계
   * - usersByProvider: Provider별 사용자 수 (Google, Kakao, Replit)
   * - recentUsers: 최근 7일 신규 사용자 수
   * - topSharedPages: 조회수 상위 10개 공유 페이지
   */
  app.get('/api/admin/stats-legacy', requireAdmin, async (req, res) => {
    try {
      // 전체 사용자 수
      const totalUsersResult = await db.execute(sql`
        SELECT COUNT(*) as count FROM users
      `);
      const totalUsers = Number(totalUsersResult.rows[0]?.count || 0);

      // Provider별 사용자 수
      const usersByProviderResult = await db.execute(sql`
        SELECT provider, COUNT(*) as count 
        FROM users 
        GROUP BY provider
      `);
      const usersByProvider = usersByProviderResult.rows.map((row: any) => ({
        provider: row.provider,
        count: Number(row.count)
      }));

      // 최근 7일 신규 사용자
      const recentUsersResult = await db.execute(sql`
        SELECT COUNT(*) as count 
        FROM users 
        WHERE created_at >= NOW() - INTERVAL '7 days'
      `);
      const recentUsers = Number(recentUsersResult.rows[0]?.count || 0);

      // 전체 가이드 수
      const totalGuidesResult = await db.execute(sql`
        SELECT COUNT(*) as count FROM guides
      `);
      const totalGuides = Number(totalGuidesResult.rows[0]?.count || 0);

      // 전체 공유 페이지 수
      const totalSharedPagesResult = await db.execute(sql`
        SELECT COUNT(*) as count FROM shared_html_pages WHERE is_active = true
      `);
      const totalSharedPages = Number(totalSharedPagesResult.rows[0]?.count || 0);

      // 전체 조회수 합계
      const totalViewsResult = await db.execute(sql`
        SELECT COALESCE(SUM(download_count), 0) as total 
        FROM shared_html_pages 
        WHERE is_active = true
      `);
      const totalViews = Number(totalViewsResult.rows[0]?.total || 0);

      // 조회수 상위 10개 공유 페이지
      const topSharedPagesResult = await db.execute(sql`
        SELECT id, name, download_count, created_at, featured
        FROM shared_html_pages 
        WHERE is_active = true
        ORDER BY download_count DESC 
        LIMIT 10
      `);
      const topSharedPages = topSharedPagesResult.rows;

      // DB 크기 정보
      const dbSizeResult = await db.execute(sql`
        SELECT 
          pg_size_pretty(pg_total_relation_size('shared_html_pages')) as shared_pages_size,
          pg_size_pretty(pg_database_size(current_database())) as total_db_size
      `);
      const dbSize = dbSizeResult.rows[0];

      res.json({
        success: true,
        stats: {
          totalUsers,
          totalGuides,
          totalSharedPages,
          totalViews,
          usersByProvider,
          recentUsers,
          topSharedPages,
          database: {
            sharedPagesSize: dbSize?.shared_pages_size || 'N/A',
            totalSize: dbSize?.total_db_size || 'N/A'
          }
        }
      });

    } catch (error) {
      console.error('관리자 통계 조회 오류:', error);
      res.status(500).json({ error: '통계 조회에 실패했습니다.' });
    }
  });

  /**
   * 📈 GET /api/admin/analytics - 상세 분석 데이터
   * 
   * Query Parameters:
   * - period: 'week' | 'month' (기본값: 'week')
   * 
   * 반환 데이터:
   * - dailyUsers: 일별 신규 사용자 수
   * - dailyGuides: 일별 가이드 생성 수
   * - dailyShares: 일별 공유 링크 생성 수
   */
  app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
    try {
      const period = req.query.period === 'month' ? 30 : 7;

      // 일별 신규 사용자
      const dailyUsersResult = await db.execute(sql`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM users
        WHERE created_at >= NOW() - INTERVAL '${sql.raw(period.toString())} days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `);

      // 일별 가이드 생성
      const dailyGuidesResult = await db.execute(sql`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM guides
        WHERE created_at >= NOW() - INTERVAL '${sql.raw(period.toString())} days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `);

      // 일별 공유 링크 생성
      const dailySharesResult = await db.execute(sql`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM shared_html_pages
        WHERE created_at >= NOW() - INTERVAL '${sql.raw(period.toString())} days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `);

      res.json({
        success: true,
        analytics: {
          dailyUsers: dailyUsersResult.rows,
          dailyGuides: dailyGuidesResult.rows,
          dailyShares: dailySharesResult.rows
        }
      });

    } catch (error) {
      console.error('분석 데이터 조회 오류:', error);
      res.status(500).json({ error: '분석 데이터 조회에 실패했습니다.' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // 🔍 관리자 가이드 관리 API (Admin Guide Management API)
  // ═══════════════════════════════════════════════════════════════════════════════
  // 목적: 모든 가이드 검색, 필터링, 편집
  // 핵심 기능:
  //   1. GET /api/admin/guides - 가이드 검색 (태그, 위치, 날짜, 사용자)
  //   2. PATCH /api/admin/guides/:id - 가이드 편집 (태그, 제목)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 🔍 GET /api/admin/guides - 가이드 검색
   * 
   * Query Parameters:
   * - tags: 태그 배열 (쉼표 구분, 예: "궁전,역사,바로크")
   * - locationName: 위치 검색어 (부분 일치)
   * - userId: 사용자 ID
   * - dateFrom: 시작 날짜 (ISO 8601)
   * - dateTo: 종료 날짜 (ISO 8601)
   * - limit: 페이지당 개수 (기본: 50)
   * - offset: 시작 위치 (기본: 0)
   */
  app.get('/api/admin/guides', requireAdmin, async (req, res) => {
    try {
      const filters: any = {
        limit: parseInt(req.query.limit as string) || 50,
        offset: parseInt(req.query.offset as string) || 0
      };

      if (req.query.tags) {
        filters.tags = (req.query.tags as string).split(',').map(t => t.trim());
      }

      if (req.query.locationName) {
        filters.locationName = req.query.locationName as string;
      }

      if (req.query.userId) {
        filters.userId = req.query.userId as string;
      }

      if (req.query.dateFrom) {
        filters.dateFrom = new Date(req.query.dateFrom as string);
      }

      if (req.query.dateTo) {
        filters.dateTo = new Date(req.query.dateTo as string);
      }

      const result = await storage.searchGuides(filters);

      res.json({
        success: true,
        guides: result.guides,
        total: result.total,
        limit: filters.limit,
        offset: filters.offset
      });

    } catch (error) {
      console.error('가이드 검색 오류:', error);
      res.status(500).json({ error: '가이드 검색에 실패했습니다.' });
    }
  });

  /**
   * ✏️ PATCH /api/admin/guides/:id - 가이드 편집
   * 
   * Body:
   * - title: 제목
   * - tags: 태그 배열
   * - description: 설명
   */
  app.patch('/api/admin/guides/:id', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { title, tags, description } = req.body;

      const updates: any = {};
      if (title !== undefined) updates.title = title;
      if (tags !== undefined) updates.tags = tags;
      if (description !== undefined) updates.description = description;

      const updatedGuide = await storage.updateGuide(id, updates);

      res.json({
        success: true,
        guide: updatedGuide
      });

    } catch (error) {
      console.error('가이드 편집 오류:', error);
      res.status(500).json({ error: '가이드 편집에 실패했습니다.' });
    }
  });

  /**
   * 🗑️ DELETE /api/admin/guides/:id - 가이드 삭제
   */
  app.delete('/api/admin/guides/:id', requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteGuide(id);
      res.json({ success: true, message: '가이드가 삭제되었습니다.' });
    } catch (error) {
      console.error('가이드 삭제 오류:', error);
      res.status(500).json({ error: '가이드 삭제에 실패했습니다.' });
    }
  });

  /**
   * 🗑️ DELETE /api/admin/guides/delete-all - 모든 가이드 삭제
   */
  app.delete('/api/admin/guides/delete-all', requireAdmin, async (req, res) => {
    try {
      const deletedCount = await storage.deleteAllGuides();
      res.json({ 
        success: true, 
        message: `${deletedCount}개의 상세페이지가 삭제되었습니다.`,
        deletedCount 
      });
    } catch (error) {
      console.error('전체 가이드 삭제 오류:', error);
      res.status(500).json({ error: '전체 삭제에 실패했습니다.' });
    }
  });

  /**
   * 📄 POST /api/admin/create-share-from-guides - 선택한 가이드들로 공유 페이지 생성
   * 
   * Body:
   * - guideIds: string[] - 선택한 가이드 ID 배열
   * - name: string - 공유 페이지 이름
   */
  app.post('/api/admin/create-share-from-guides', requireAdmin, async (req: any, res) => {
    try {
      const { guideIds, name } = req.body;
      const userId = req.session?.adminUserId || (req.user ? getUserId(req.user) : 'anonymous');

      if (!Array.isArray(guideIds) || guideIds.length === 0) {
        return res.status(400).json({ error: '가이드를 선택해주세요.' });
      }

      if (!name || name.trim().length === 0) {
        return res.status(400).json({ error: '공유 페이지 이름을 입력해주세요.' });
      }

      // 선택한 가이드들 조회
      const guides = await storage.getGuidesByIds(guideIds);

      if (guides.length === 0) {
        return res.status(404).json({ error: '선택한 가이드를 찾을 수 없습니다.' });
      }

      // V2 표준 템플릿 데이터 준비
      const user = await storage.getUser(userId);
      const guideItems = guides.map(guide => ({
        id: guide.id,
        title: guide.title || '',  // 🎤 음성키워드 폴백용
        imageDataUrl: guide.imageUrl || '',
        description: guide.description || '',
        voiceLang: guide.voiceLang || 'ko-KR',
        locationName: guide.locationName || undefined,
        voiceQuery: guide.title || undefined,
        voiceName: guide.voiceName || undefined
      }));

      const templateData = {
        title: name.trim(),
        sender: '관리자',
        location: guides[0]?.locationName || '파리',
        date: new Date().toLocaleDateString('ko-KR'),
        guideItems,
        appOrigin: `${req.protocol}://${req.get('host')}`,
        isFeatured: false
      };

      // HTML 생성
      const { generateStandardShareHTML } = await import('./standard-template.js');
      const htmlContent = generateStandardShareHTML(templateData);

      // 공유 페이지 생성
      const shareResult = await storage.createSharedHtmlPage(userId, {
        name: name.trim(),
        htmlContent,
        templateVersion: 'v2',
        guideIds,
        thumbnail: guides[0]?.imageUrl || null,
        sender: '관리자',
        location: guides[0]?.locationName || '파리',
        date: new Date().toISOString().split('T')[0],
        featured: false,
        isActive: true
      });

      res.json({
        success: true,
        shareId: shareResult.id,
        shareUrl: `${req.protocol}://${req.get('host')}/s/${shareResult.id}`,
        message: '공유 페이지가 생성되었습니다.'
      });

    } catch (error) {
      console.error('공유 페이지 생성 오류:', error);
      res.status(500).json({ error: '공유 페이지 생성에 실패했습니다.' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 💰 수익 대시보드 API (2025-11-29)
  // ═══════════════════════════════════════════════════════════════
  
  /**
   * 📊 GET /api/admin/revenue - 수익 대시보드 데이터
   * 
   * 반환값:
   * - summary: 총수입, AI비용, 순수익, ARPU
   * - monthlyTrend: 월별 수익 추이 (최근 6개월)
   * - recentTransactions: 최근 결제 내역
   * - creditStats: 크레딧 현황 (판매/사용/잔여)
   */
  app.get('/api/admin/revenue', requireAdmin, async (req, res) => {
    try {
      // credit_transactions에서 데이터 집계
      const allTransactions = await db.select().from(creditTransactions).orderBy(desc(creditTransactions.createdAt));
      
      // 타입별 집계
      const purchases = allTransactions.filter(t => t.type === 'purchase');
      const usages = allTransactions.filter(t => t.type === 'usage');
      const signupBonuses = allTransactions.filter(t => t.type === 'signup_bonus');
      const referralBonuses = allTransactions.filter(t => t.type === 'referral_bonus' || t.type === 'referral_signup_bonus');
      
      // 총 수입 계산 (purchase 크레딧 / 14 = EUR)
      const totalCreditsCharged = purchases.reduce((sum, t) => sum + (t.amount || 0), 0);
      const totalRevenueEUR = totalCreditsCharged / 14;
      
      // AI 호출 수 (usage 건수)
      const totalAICalls = usages.length;
      // 🎯 2026-02-01: Gemini 3.0 Flash 비용 추정: 호출당 ~$0.015 (이미지+텍스트)
      // (Input: $0.50/1M tokens, Output: $3.00/1M tokens)
      const estimatedAICostUSD = totalAICalls * 0.015;
      const estimatedAICostEUR = estimatedAICostUSD * 0.92; // USD to EUR
      
      // 고정비 (월 300 EUR)
      const fixedCostEUR = 300;
      
      // 순수익 계산
      const netProfitEUR = totalRevenueEUR - estimatedAICostEUR - fixedCostEUR;
      
      // ARPU 계산 (결제한 유저 수)
      const uniquePayers = new Set(purchases.map(t => t.userId)).size;
      const arpu = uniquePayers > 0 ? totalRevenueEUR / uniquePayers : 0;
      
      // 월별 추이 (최근 6개월)
      const now = new Date();
      const monthlyTrend = [];
      for (let i = 5; i >= 0; i--) {
        const targetMonth = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const nextMonth = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
        
        const monthPurchases = purchases.filter(t => {
          const d = new Date(t.createdAt!);
          return d >= targetMonth && d < nextMonth;
        });
        const monthUsages = usages.filter(t => {
          const d = new Date(t.createdAt!);
          return d >= targetMonth && d < nextMonth;
        });
        
        const monthCredits = monthPurchases.reduce((sum, t) => sum + (t.amount || 0), 0);
        const monthRevenue = monthCredits / 14;
        const monthAICost = monthUsages.length * 0.015 * 0.92;
        
        monthlyTrend.push({
          month: targetMonth.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short' }),
          revenue: Math.round(monthRevenue * 100) / 100,
          aiCost: Math.round(monthAICost * 100) / 100,
          transactions: monthPurchases.length,
          aiCalls: monthUsages.length
        });
      }
      
      // 크레딧 현황
      const totalCreditsSold = totalCreditsCharged;
      const totalCreditsUsed = Math.abs(usages.reduce((sum, t) => sum + (t.amount || 0), 0));
      const totalBonusGiven = signupBonuses.reduce((sum, t) => sum + (t.amount || 0), 0) +
                              referralBonuses.reduce((sum, t) => sum + (t.amount || 0), 0);
      
      // 유저 잔여 크레딧 총합
      const allUsers = await db.select({ credits: users.credits }).from(users);
      const totalCreditsRemaining = allUsers.reduce((sum, u) => sum + (u.credits || 0), 0);
      
      // 최근 결제 내역 (purchase만, 최근 20건)
      const recentTransactions = purchases.slice(0, 20).map(t => ({
        id: t.id,
        userId: t.userId,
        amount: t.amount,
        amountEUR: Math.round((t.amount || 0) / 14 * 100) / 100,
        description: t.description,
        createdAt: t.createdAt
      }));
      
      res.json({
        summary: {
          totalRevenue: Math.round(totalRevenueEUR * 100) / 100,
          totalAICost: Math.round(estimatedAICostEUR * 100) / 100,
          fixedCost: fixedCostEUR,
          netProfit: Math.round(netProfitEUR * 100) / 100,
          arpu: Math.round(arpu * 100) / 100,
          totalTransactions: purchases.length,
          totalAICalls,
          uniquePayers
        },
        monthlyTrend,
        creditStats: {
          sold: totalCreditsSold,
          used: totalCreditsUsed,
          bonusGiven: totalBonusGiven,
          remaining: totalCreditsRemaining
        },
        recentTransactions
      });
      
    } catch (error) {
      console.error('수익 데이터 조회 오류:', error);
      res.status(500).json({ error: '수익 데이터 조회에 실패했습니다.' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 🔔 알림 + 푸시 알림 API (2025-12-06)
  // ═══════════════════════════════════════════════════════════════
  // 목적: 인앱 알림 CRUD + 웹 푸시 발송
  // ═══════════════════════════════════════════════════════════════

  // 알림 목록 조회 (사용자별 알림 + 전체 공지)
  app.get('/api/notifications', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const limit = parseInt(req.query.limit as string) || 50;
      
      const userNotifications = await db.select()
        .from(notifications)
        .where(or(
          eq(notifications.userId, userId),
          isNull(notifications.userId) // 전체 공지
        ))
        .orderBy(desc(notifications.createdAt))
        .limit(limit);
      
      res.json(userNotifications);
    } catch (error) {
      console.error('알림 조회 오류:', error);
      res.status(500).json({ error: '알림 조회에 실패했습니다.' });
    }
  });

  // 읽지 않은 알림 수 조회
  app.get('/api/notifications/unread-count', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      
      const result = await db.select({ count: sql<number>`count(*)` })
        .from(notifications)
        .where(and(
          or(
            eq(notifications.userId, userId),
            isNull(notifications.userId)
          ),
          eq(notifications.isRead, false)
        ));
      
      res.json({ count: Number(result[0]?.count || 0) });
    } catch (error) {
      console.error('읽지 않은 알림 수 조회 오류:', error);
      res.status(500).json({ error: '알림 수 조회에 실패했습니다.' });
    }
  });

  // 알림 읽음 처리
  app.post('/api/notifications/mark-read', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const { notificationIds } = req.body;
      
      if (notificationIds && Array.isArray(notificationIds)) {
        // 특정 알림들 읽음 처리
        for (const id of notificationIds) {
          await db.update(notifications)
            .set({ isRead: true })
            .where(and(
              eq(notifications.id, id),
              or(
                eq(notifications.userId, userId),
                isNull(notifications.userId)
              )
            ));
        }
      } else {
        // 모든 알림 읽음 처리
        await db.update(notifications)
          .set({ isRead: true })
          .where(or(
            eq(notifications.userId, userId),
            isNull(notifications.userId)
          ));
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error('알림 읽음 처리 오류:', error);
      res.status(500).json({ error: '알림 읽음 처리에 실패했습니다.' });
    }
  });

  // 알림 전체 삭제
  app.delete('/api/notifications/delete-all', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      
      // 해당 사용자의 알림만 삭제 (전체 공지는 읽음 처리만)
      await db.delete(notifications)
        .where(eq(notifications.userId, userId));
      
      // 전체 공지(userId가 null인 알림)는 읽음 처리
      await db.update(notifications)
        .set({ isRead: true })
        .where(isNull(notifications.userId));
      
      res.json({ success: true });
    } catch (error) {
      console.error('알림 전체 삭제 오류:', error);
      res.status(500).json({ error: '알림 삭제에 실패했습니다.' });
    }
  });

  // 개별 알림 삭제
  app.delete('/api/notifications/:id', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const notificationId = req.params.id;
      
      if (!notificationId) {
        return res.status(400).json({ error: '유효하지 않은 알림 ID입니다.' });
      }
      
      // 해당 사용자의 알림만 삭제 (본인 알림인 경우)
      await db.delete(notifications)
        .where(and(
          eq(notifications.id, notificationId),
          eq(notifications.userId, userId)
        ));
      
      // 전체 공지(userId가 null)인 경우 읽음 처리만
      await db.update(notifications)
        .set({ isRead: true })
        .where(and(
          eq(notifications.id, notificationId),
          isNull(notifications.userId)
        ));
      
      res.json({ success: true });
    } catch (error) {
      console.error('알림 삭제 오류:', error);
      res.status(500).json({ error: '알림 삭제에 실패했습니다.' });
    }
  });

  // 푸시 구독 등록
  app.post('/api/push/subscribe', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const { endpoint, keys, userAgent } = req.body;
      
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return res.status(400).json({ error: '유효하지 않은 구독 정보입니다.' });
      }
      
      // 기존 구독이 있으면 업데이트, 없으면 새로 생성
      const existingSubscription = await db.select()
        .from(pushSubscriptions)
        .where(and(
          eq(pushSubscriptions.userId, userId),
          eq(pushSubscriptions.endpoint, endpoint)
        ))
        .limit(1);
      
      if (existingSubscription.length > 0) {
        await db.update(pushSubscriptions)
          .set({
            p256dh: keys.p256dh,
            auth: keys.auth,
            userAgent: userAgent || null
          })
          .where(eq(pushSubscriptions.id, existingSubscription[0].id));
      } else {
        await db.insert(pushSubscriptions).values({
          userId,
          endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          userAgent: userAgent || null
        });
      }
      
      console.log(`✅ 푸시 구독 등록: ${userId}`);
      res.json({ success: true });
    } catch (error) {
      console.error('푸시 구독 등록 오류:', error);
      res.status(500).json({ error: '푸시 구독 등록에 실패했습니다.' });
    }
  });

  // 푸시 구독 해제
  app.post('/api/push/unsubscribe', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const { endpoint } = req.body;
      
      if (endpoint) {
        await db.delete(pushSubscriptions)
          .where(and(
            eq(pushSubscriptions.userId, userId),
            eq(pushSubscriptions.endpoint, endpoint)
          ));
      } else {
        // 모든 구독 해제
        await db.delete(pushSubscriptions)
          .where(eq(pushSubscriptions.userId, userId));
      }
      
      console.log(`✅ 푸시 구독 해제: ${userId}`);
      res.json({ success: true });
    } catch (error) {
      console.error('푸시 구독 해제 오류:', error);
      res.status(500).json({ error: '푸시 구독 해제에 실패했습니다.' });
    }
  });

  // 푸시 구독 재등록 (service worker pushsubscriptionchange 이벤트 처리)
  app.post('/api/push/resubscribe', async (req: any, res) => {
    try {
      const { oldEndpoint, newSubscription } = req.body;
      
      if (!oldEndpoint || !newSubscription) {
        return res.status(400).json({ error: '잘못된 재구독 요청입니다.' });
      }
      
      // 기존 구독 찾기
      const existing = await db.select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, oldEndpoint))
        .limit(1);
      
      if (existing.length > 0) {
        await db.update(pushSubscriptions)
          .set({
            endpoint: newSubscription.endpoint,
            p256dh: newSubscription.keys?.p256dh,
            auth: newSubscription.keys?.auth
          })
          .where(eq(pushSubscriptions.id, existing[0].id));
        
        console.log(`✅ 푸시 구독 재등록: ${existing[0].userId}`);
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error('푸시 재구독 오류:', error);
      res.status(500).json({ error: '푸시 재구독에 실패했습니다.' });
    }
  });

  // 관리자 전체 알림 발송 (requireAdmin 인증 필수)
  app.post('/api/admin/notifications/broadcast', requireAdmin, async (req: any, res) => {
    try {
      const { type, title, message, link } = req.body;
      
      if (!type || !title || !message) {
        return res.status(400).json({ error: '알림 유형, 제목, 내용은 필수입니다.' });
      }
      
      // 알림 생성 + 전체 푸시 발송
      const result = await notificationService.createAndSendNotification({
        userId: null, // null = 전체 공지
        type: type as 'content' | 'event' | 'update' | 'urgent',
        title,
        message,
        link: link || null
      });
      
      console.log(`📢 관리자 전체 알림 발송: ${title}`);
      console.log(`   - 알림 ID: ${result.notificationId}`);
      console.log(`   - 푸시 발송: 성공 ${result.pushResult?.sent || 0}, 실패 ${result.pushResult?.failed || 0}`);
      
      res.json({
        success: true,
        notificationId: result.notificationId,
        pushSent: result.pushResult?.sent || 0,
        pushFailed: result.pushResult?.failed || 0
      });
    } catch (error) {
      console.error('관리자 알림 발송 오류:', error);
      res.status(500).json({ error: '알림 발송에 실패했습니다.' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 🎬 드림 스튜디오 V2: 자동화 워크플로우 (2025-12-30)
  // ═══════════════════════════════════════════════════════════════
  // 목적: 텍스트 분석 → 분류 → 20초 대사 → TTS → D-ID 영상 생성
  // 비용 절감: 기존 가이드 데이터 재활용, 이미지 분석 최소화
  // ═══════════════════════════════════════════════════════════════

  // 1. 텍스트 분석 + 분류 + 20초 대사 생성 (이미지 분석 불필요)
  app.post('/api/dream-studio/analyze-text', async (req, res) => {
    try {
      const { description, language = 'ko', duration = '10' } = req.body;
      
      if (!description) {
        return res.status(400).json({ error: '설명 텍스트가 필요합니다' });
      }
      
      console.log(`🎬 [드림스튜디오] 텍스트 분석 시작: ${description.substring(0, 50)}...`);
      const startTime = Date.now();
      
      const result = await analyzeTextAndGenerateScript(description, language, duration);
      
      console.log(`🎬 [드림스튜디오] 분석 완료: ${Date.now() - startTime}ms`);
      console.log(`   - 카테고리: ${result.categoryKo} (${result.category})`);
      console.log(`   - 페르소나: ${result.persona}`);
      console.log(`   - 분위기: ${result.mood}`);
      
      res.json(result);
    } catch (error) {
      console.error('텍스트 분석 오류:', error);
      res.status(500).json({ error: '텍스트 분석 중 오류가 발생했습니다' });
    }
  });

  // 2. 이미지 분석 + 분류 + 20초 대사 생성
  app.post('/api/dream-studio/analyze-image', async (req, res) => {
    try {
      const { imageBase64, language = 'ko', duration = '10' } = req.body;
      
      if (!imageBase64) {
        return res.status(400).json({ error: '이미지가 필요합니다' });
      }
      
      console.log(`🎬 [드림스튜디오] 이미지 분석 시작`);
      const startTime = Date.now();
      
      const result = await analyzeImageAndGenerateScript(imageBase64, language, duration);
      
      console.log(`🎬 [드림스튜디오] 이미지 분석 완료: ${Date.now() - startTime}ms`);
      console.log(`   - 카테고리: ${result.categoryKo} (${result.category})`);
      console.log(`   - 페르소나: ${result.persona}`);
      
      res.json(result);
    } catch (error) {
      console.error('이미지 분석 오류:', error);
      res.status(500).json({ error: '이미지 분석 중 오류가 발생했습니다' });
    }
  });

  // 3. TTS 음성 생성 (Gemini 2.5 Flash TTS)
  app.post('/api/dream-studio/generate-tts', async (req, res) => {
    try {
      const { script, voiceName = 'Kore', mood = 'cheerful' } = req.body;
      
      if (!script) {
        return res.status(400).json({ error: '대사가 필요합니다' });
      }
      
      console.log(`🎤 [드림스튜디오] TTS 생성 시작: ${script.substring(0, 30)}...`);
      const startTime = Date.now();
      
      const audio = await generatePersonaVoice(script, voiceName, mood);
      
      if (!audio) {
        return res.status(500).json({ error: 'TTS 생성 실패' });
      }
      
      console.log(`🎤 [드림스튜디오] TTS 완료: ${Date.now() - startTime}ms`);
      
      res.json({
        audioBase64: audio.audioBase64,
        mimeType: audio.mimeType
      });
    } catch (error) {
      console.error('TTS 생성 오류:', error);
      res.status(500).json({ error: 'TTS 생성 중 오류가 발생했습니다' });
    }
  });

  // 4. 통합 파이프라인: 분석 + TTS 동시 생성 (D-ID는 클라이언트에서 호출)
  app.post('/api/dream-studio/generate-full', async (req, res) => {
    try {
      const { 
        description, 
        imageBase64,
        imageUrl,
        language = 'ko', 
        duration = '10',
        generateAudio = true
      } = req.body;
      
      if (!description && !imageBase64) {
        return res.status(400).json({ error: '설명 또는 이미지가 필요합니다' });
      }
      
      console.log(`🎬 [드림스튜디오] 통합 파이프라인 시작`);
      const startTime = Date.now();
      
      // 1단계: 분석 + 대사 생성
      let analyzed: AnalyzedScript;
      if (description) {
        console.log(`   - 모드: 텍스트 분석 (비용 절감)`);
        analyzed = await analyzeTextAndGenerateScript(description, language, duration);
      } else {
        console.log(`   - 모드: 이미지 분석`);
        analyzed = await analyzeImageAndGenerateScript(imageBase64, language, duration);
      }
      
      console.log(`   - 분석 완료: ${Date.now() - startTime}ms`);
      console.log(`   - 카테고리: ${analyzed.categoryKo}`);
      console.log(`   - 대사 길이: ${analyzed.script.length}자`);
      
      // 2단계: TTS 생성 (병렬 처리 가능)
      let audio = null;
      if (generateAudio) {
        const ttsStart = Date.now();
        audio = await generatePersonaVoice(analyzed.script, analyzed.voiceName, analyzed.mood);
        console.log(`   - TTS 완료: ${Date.now() - ttsStart}ms`);
      }
      
      const totalTime = Date.now() - startTime;
      console.log(`🎬 [드림스튜디오] 파이프라인 완료: 총 ${totalTime}ms`);
      
      res.json({
        analysis: analyzed,
        audio: audio ? {
          audioBase64: audio.audioBase64,
          mimeType: audio.mimeType
        } : null,
        imageUrl: imageUrl || null,
        processingTime: totalTime
      });
    } catch (error) {
      console.error('통합 파이프라인 오류:', error);
      res.status(500).json({ error: '처리 중 오류가 발생했습니다' });
    }
  });

  // 5. 가이드 기반 일괄 생성 (여러 가이드 → 공유영상용 데이터)
  app.post('/api/dream-studio/generate-batch', isAuthenticated, async (req: any, res) => {
    try {
      const userId = getUserId(req.user);
      const { guideIds, language = 'ko', duration = '10' } = req.body;
      
      if (!guideIds || !Array.isArray(guideIds) || guideIds.length === 0) {
        return res.status(400).json({ error: '가이드 ID 목록이 필요합니다' });
      }
      
      if (guideIds.length > 6) {
        return res.status(400).json({ error: '최대 6개까지만 처리 가능합니다' });
      }
      
      console.log(`🎬 [드림스튜디오] 일괄 생성 시작: ${guideIds.length}개`);
      const startTime = Date.now();
      
      const results = [];
      
      for (const guideId of guideIds) {
        try {
          // 가이드 조회
          const guide = await storage.getGuide(guideId);
          if (!guide || guide.userId !== userId) {
            results.push({ guideId, error: '가이드를 찾을 수 없습니다' });
            continue;
          }
          
          // 기존 설명이 있으면 텍스트 분석 (비용 절감)
          const description = guide.aiGeneratedContent || guide.description || '';
          
          if (description) {
            const analyzed = await analyzeTextAndGenerateScript(description, language, duration);
            const audio = await generatePersonaVoice(analyzed.script, analyzed.voiceName, analyzed.mood);
            
            results.push({
              guideId,
              title: guide.title,
              imageUrl: guide.imageUrl,
              analysis: analyzed,
              audio: audio ? {
                audioBase64: audio.audioBase64,
                mimeType: audio.mimeType
              } : null
            });
          } else if (guide.imageUrl) {
            // 설명이 없으면 이미지 분석 필요 (추가 비용)
            // TODO: imageUrl에서 base64 변환 필요
            results.push({ 
              guideId, 
              error: '설명이 없어 이미지 분석이 필요합니다. 개별 처리해주세요.' 
            });
          }
        } catch (err) {
          console.error(`가이드 ${guideId} 처리 오류:`, err);
          results.push({ guideId, error: '처리 중 오류 발생' });
        }
      }
      
      console.log(`🎬 [드림스튜디오] 일괄 생성 완료: ${Date.now() - startTime}ms`);
      
      res.json({
        results,
        totalTime: Date.now() - startTime
      });
    } catch (error) {
      console.error('일괄 생성 오류:', error);
      res.status(500).json({ error: '일괄 처리 중 오류가 발생했습니다' });
    }
  });

  // 6. D-ID 영상 생성 (Talks API)
  app.post('/api/dream-studio/generate-did-video', async (req, res) => {
    try {
      const { imageUrl, imageBase64, script, audioBase64, voiceName = 'ko-KR-SunHiNeural' } = req.body;
      
      if (!imageUrl && !imageBase64) {
        return res.status(400).json({ error: '이미지가 필요합니다' });
      }
      
      if (!script && !audioBase64) {
        return res.status(400).json({ error: '대사 또는 오디오가 필요합니다' });
      }
      
      const didApiKey = process.env.DID_API_KEY;
      if (!didApiKey) {
        return res.status(500).json({ error: 'D-ID API Key가 설정되지 않았습니다' });
      }
      
      console.log(`🎬 [D-ID] 영상 생성 시작`);
      const startTime = Date.now();
      
      // D-ID API 요청 구성
      const requestBody: any = {
        config: { stitch: true },
        script: audioBase64 ? {
          type: 'audio',
          audio_url: `data:audio/wav;base64,${audioBase64}`
        } : {
          type: 'text',
          input: script,
          provider: {
            type: 'microsoft',
            voice_id: voiceName
          }
        }
      };
      
      // 이미지 소스 설정 (D-ID는 실제 URL만 허용, base64 직접 전송 불가)
      if (imageUrl && imageUrl.startsWith('http')) {
        requestBody.source_url = imageUrl;
        console.log(`   - 이미지: URL 직접 사용`);
      } else if (imageBase64) {
        // base64 이미지를 Object Storage에 업로드 후 URL 사용
        try {
          const objectStorageService = new ObjectStorageService();
          const imageBuffer = Buffer.from(
            imageBase64.replace(/^data:image\/\w+;base64,/, ''), 
            'base64'
          );
          const fileName = `dream-studio/temp-${Date.now()}.jpg`;
          const uploadedUrl = await objectStorageService.uploadBuffer(imageBuffer, fileName, 'image/jpeg');
          requestBody.source_url = uploadedUrl;
          console.log(`   - 이미지: Object Storage 업로드 완료 → ${uploadedUrl}`);
        } catch (uploadError) {
          console.error('이미지 업로드 실패:', uploadError);
          return res.status(500).json({ 
            error: '이미지 업로드 실패. D-ID는 실제 URL이 필요합니다.',
            details: String(uploadError)
          });
        }
      }
      
      // D-ID Talks API 호출 - 영상 생성 시작
      const createResponse = await fetch('https://api.d-id.com/talks', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(didApiKey).toString('base64')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!createResponse.ok) {
        const errorData = await createResponse.json();
        console.error('D-ID 생성 오류:', errorData);
        return res.status(createResponse.status).json({ 
          error: 'D-ID 영상 생성 실패', 
          details: errorData 
        });
      }
      
      const createResult = await createResponse.json();
      const talkId = createResult.id;
      console.log(`   - Talk ID: ${talkId}`);
      
      // 영상 생성 완료 대기 (폴링)
      let videoUrl = null;
      let attempts = 0;
      const maxAttempts = 60; // 최대 2분 대기
      
      while (!videoUrl && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2초 대기
        attempts++;
        
        const statusResponse = await fetch(`https://api.d-id.com/talks/${talkId}`, {
          headers: {
            'Authorization': `Basic ${Buffer.from(didApiKey).toString('base64')}`
          }
        });
        
        if (statusResponse.ok) {
          const statusResult = await statusResponse.json();
          console.log(`   - 상태 체크 ${attempts}: ${statusResult.status}`);
          
          if (statusResult.status === 'done') {
            videoUrl = statusResult.result_url;
            break;
          } else if (statusResult.status === 'error') {
            return res.status(500).json({ 
              error: 'D-ID 영상 생성 실패', 
              details: statusResult.error 
            });
          }
        }
      }
      
      if (!videoUrl) {
        return res.status(408).json({ error: '영상 생성 시간 초과' });
      }
      
      const totalTime = Date.now() - startTime;
      console.log(`🎬 [D-ID] 영상 생성 완료: ${totalTime}ms`);
      console.log(`   - Video URL: ${videoUrl}`);
      
      res.json({
        videoUrl,
        talkId,
        processingTime: totalTime
      });
      
    } catch (error) {
      console.error('D-ID 영상 생성 오류:', error);
      res.status(500).json({ error: 'D-ID 영상 생성 중 오류가 발생했습니다' });
    }
  });

  // 7. 드림 스튜디오 전체 파이프라인 (분석 → TTS → D-ID 영상) - 분류별 처리
  app.post('/api/dream-studio/create-video', async (req, res) => {
    try {
      const { 
        description, 
        imageBase64,
        imageUrl,
        guideType = 'young_female',  // 아바타 타입
        language = 'ko', 
        duration = '10'
      } = req.body;
      
      if (!description && !imageBase64 && !imageUrl) {
        return res.status(400).json({ error: '설명 또는 이미지가 필요합니다' });
      }
      
      // imageUrl이 있으면 다운로드해서 base64로 변환
      let finalImageBase64 = imageBase64;
      if (!finalImageBase64 && imageUrl) {
        try {
          const protocol = req.headers['x-forwarded-proto'] || 'https';
          const host = req.headers.host;
          
          // 상대 경로면 절대 경로로 변환
          let fullUrl = imageUrl;
          if (imageUrl.startsWith('/')) {
            fullUrl = `${protocol}://${host}${imageUrl}`;
          }
          
          console.log(`   - 이미지 다운로드: ${fullUrl}`);
          const imgResponse = await fetch(fullUrl);
          if (imgResponse.ok) {
            const imgBuffer = await imgResponse.arrayBuffer();
            finalImageBase64 = Buffer.from(imgBuffer).toString('base64');
            console.log(`   - 다운로드 완료: ${Math.round(finalImageBase64.length / 1024)}KB`);
          }
        } catch (dlError) {
          console.error('이미지 다운로드 실패:', dlError);
        }
      }
      
      const didApiKey = process.env.DID_API_KEY;
      if (!didApiKey) {
        return res.status(500).json({ error: 'D-ID API Key가 설정되지 않았습니다' });
      }
      
      console.log(`🎬 [드림스튜디오 D-ID] 전체 파이프라인 시작`);
      console.log(`   - 아바타: ${guideType}`);
      const startTime = Date.now();
      
      // 아바타 템플릿 (Kling에서 재사용)
      const { GUIDE_TEMPLATES } = await import('./klingai');
      const guide = GUIDE_TEMPLATES[guideType as keyof typeof GUIDE_TEMPLATES] || GUIDE_TEMPLATES.young_female;
      
      // 1단계: 분석 + 대사 생성 (Gemini가 분류 결정)
      let analyzed: AnalyzedScript;
      if (description) {
        console.log(`   - Step 1: 텍스트 분석 (비용 절감)`);
        analyzed = await analyzeTextAndGenerateScript(description, language, parseInt(duration) * 4);
      } else if (finalImageBase64) {
        console.log(`   - Step 1: 이미지 분석`);
        analyzed = await analyzeImageAndGenerateScript(finalImageBase64, language, parseInt(duration) * 4);
      } else {
        return res.status(400).json({ error: '이미지 또는 설명이 필요합니다' });
      }
      console.log(`   - 대사 생성 완료: ${analyzed.script.substring(0, 30)}...`);
      console.log(`   - 카테고리: ${analyzed.category} (${analyzed.categoryKo})`);
      console.log(`   - 🎯 주인공: ${analyzed.protagonist}`);
      console.log(`   - 원본 이미지 사용: ${analyzed.useOriginalImage}`);
      console.log(`   - 영상 프롬프트: ${analyzed.videoPrompt}`);
      
      // 2단계: D-ID 영상 생성 (TTS 포함)
      console.log(`   - Step 2: D-ID 영상 생성`);
      
      // 한국어 TTS 음성 선택 (가이드 타입에 따라)
      const voiceMap: Record<string, Record<string, string>> = {
        ko: {
          young_female: 'ko-KR-SunHiNeural',    // 젊은 여성
          young_male: 'ko-KR-InJoonNeural',     // 젊은 남성  
          senior_female: 'ko-KR-SoonBokNeural', // 중년 여성
          senior_male: 'ko-KR-BongJinNeural'    // 중년 남성
        },
        en: {
          young_female: 'en-US-JennyNeural',
          young_male: 'en-US-GuyNeural',
          senior_female: 'en-US-AriaNeural',
          senior_male: 'en-US-DavisNeural'
        },
        ja: {
          young_female: 'ja-JP-NanamiNeural',
          young_male: 'ja-JP-KeitaNeural',
          senior_female: 'ja-JP-ShioriNeural',
          senior_male: 'ja-JP-KeitaNeural'
        },
        zh: {
          young_female: 'zh-CN-XiaoxiaoNeural',
          young_male: 'zh-CN-YunxiNeural',
          senior_female: 'zh-CN-XiaoyiNeural',
          senior_male: 'zh-CN-YunyangNeural'
        }
      };
      
      const langVoices = voiceMap[language] || voiceMap.ko;
      const selectedVoice = langVoices[guideType] || langVoices.young_female;
      console.log(`   - TTS 음성: ${selectedVoice}`);
      
      // D-ID 공식 API 형식 (source_url 사용 - source_base64는 무시됨!)
      const didRequest: any = {
        script: {
          type: 'text',
          input: analyzed.script,
          provider: {
            type: 'microsoft',
            voice_id: selectedVoice
          }
        },
        config: {
          stitch: true,
          fluent: true,
          result_format: 'mp4'
        }
      };
      
      // ═══════════════════════════════════════════════════════════════
      // 분류별 이미지 처리 로직 (source_url 사용!)
      // ═══════════════════════════════════════════════════════════════
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers.host;
      const baseUrl = `${protocol}://${host}`;
      
      // 이미지를 임시 파일로 저장하는 헬퍼 함수
      async function saveImageForDID(imageBuffer: Buffer, prefix: string): Promise<string> {
        const path = await import('path');
        const fs = await import('fs/promises');
        
        const filename = `${prefix}-${Date.now()}.jpg`;
        const filepath = path.join(process.cwd(), 'public', 'temp-did', filename);
        await fs.writeFile(filepath, imageBuffer);
        
        const publicUrl = `${baseUrl}/temp-did/${filename}`;
        console.log(`   - 임시 이미지 저장: ${publicUrl}`);
        return publicUrl;
      }
      
      // 🎨 모든 이미지: 배경 + 아바타 합성 (D-ID 얼굴 인식 보장)
      if (finalImageBase64) {
        console.log(`   - 🎨 통합 모드: 배경 + 아바타 합성 → source_url 변환`);
        
        try {
          const sharp = (await import('sharp')).default;
          const path = await import('path');
          const fs = await import('fs/promises');
          
          // 배경 이미지 (원본)
          const cleanBase64 = finalImageBase64.replace(/^data:image\/\w+;base64,/, '');
          const bgBuffer = Buffer.from(cleanBase64, 'base64');
          
          // 아바타 이미지 로드
          const avatarPath = path.join(process.cwd(), 'public', guide.avatarPath.replace(/^\//, ''));
          const avatarBuffer = await fs.readFile(avatarPath);
          
          // D-ID용 최적 크기 (640x640)
          const targetSize = 640;
          
          // 아바타 크기 조정 (화면의 45% 높이)
          const avatarHeight = Math.round(targetSize * 0.45);
          const resizedAvatar = await sharp(avatarBuffer)
            .resize({ height: avatarHeight, fit: 'inside' })
            .toBuffer();
          
          const avatarMeta = await sharp(resizedAvatar).metadata();
          const avatarWidth = avatarMeta.width || 200;
          
          // 배경 리사이즈 + 아바타 합성 (하단 중앙)
          const compositeX = Math.round((targetSize - avatarWidth) / 2);
          const compositeY = targetSize - avatarHeight;
          
          const compositeImage = await sharp(bgBuffer)
            .resize(targetSize, targetSize, { fit: 'cover' })
            .composite([{
              input: resizedAvatar,
              left: compositeX,
              top: compositeY
            }])
            .jpeg({ quality: 85 })
            .toBuffer();
          
          console.log(`   - 합성 이미지: ${targetSize}x${targetSize}, ${Math.round(compositeImage.length / 1024)}KB`);
          
          // 임시 파일로 저장하고 공개 URL 생성
          const imageUrl = await saveImageForDID(compositeImage, 'guide');
          didRequest.source_url = imageUrl;
          
        } catch (compError) {
          console.error('이미지 합성 실패, 아바타만 사용:', compError);
          didRequest.source_url = `${baseUrl}${guide.avatarPath}`;
        }
        
      } else {
        // 이미지 없으면 아바타만 사용
        didRequest.source_url = `${baseUrl}${guide.avatarPath}`;
        console.log(`   - 아바타 이미지: ${didRequest.source_url}`);
      }
      
      // D-ID API 호출 전 디버깅 로그
      console.log(`   - D-ID 요청 확인:`);
      console.log(`     * source_url: ${didRequest.source_url}`);
      console.log(`     * script.input: ${analyzed.script.substring(0, 50)}...`);
      console.log(`     * config: ${JSON.stringify(didRequest.config)}`)
      
      // D-ID API 호출
      const createResponse = await fetch('https://api.d-id.com/talks', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(didApiKey).toString('base64')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(didRequest)
      });
      
      if (!createResponse.ok) {
        const errorData = await createResponse.json();
        console.error('D-ID 생성 오류:', errorData);
        return res.status(createResponse.status).json({ 
          error: 'D-ID 영상 생성 실패', 
          details: errorData,
          analysis: analyzed
        });
      }
      
      const createResult = await createResponse.json();
      const talkId = createResult.id;
      
      // 폴링으로 완료 대기
      let videoUrl = null;
      let attempts = 0;
      
      while (!videoUrl && attempts < 60) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;
        
        const statusResponse = await fetch(`https://api.d-id.com/talks/${talkId}`, {
          headers: {
            'Authorization': `Basic ${Buffer.from(didApiKey).toString('base64')}`
          }
        });
        
        if (statusResponse.ok) {
          const statusResult = await statusResponse.json();
          if (statusResult.status === 'done') {
            videoUrl = statusResult.result_url;
            break;
          } else if (statusResult.status === 'error') {
            console.error('D-ID 폴링 오류 상세:', JSON.stringify(statusResult, null, 2));
            return res.status(500).json({ 
              error: 'D-ID 영상 생성 실패', 
              details: statusResult.error || statusResult,
              analysis: analyzed
            });
          }
        } else {
          const errorText = await statusResponse.text();
          console.error(`D-ID 폴링 실패 (${statusResponse.status}):`, errorText);
        }
      }
      
      const totalTime = Date.now() - startTime;
      console.log(`🎬 [드림스튜디오] 전체 파이프라인 완료: ${totalTime}ms`);
      
      // DB에 영상 메타데이터 저장
      if (videoUrl) {
        try {
          const userId = req.user?.id || null;
          await db.insert(dreamStudioVideos).values({
            userId,
            talkId,
            guideType,
            language,
            description: description || null,
            script: analyzed.script,
            videoUrl,
            duration: parseInt(duration),
            status: 'completed',
            processingTime: totalTime
          });
          console.log(`   - DB 저장 완료 (userId: ${userId || 'anonymous'})`);
        } catch (dbError) {
          console.error('DB 저장 실패:', dbError);
          // DB 저장 실패해도 영상은 반환
        }
      }
      
      res.json({
        analysis: analyzed,
        videoUrl,
        talkId,
        processingTime: totalTime
      });
      
    } catch (error) {
      console.error('전체 파이프라인 오류:', error);
      res.status(500).json({ error: '영상 생성 중 오류가 발생했습니다' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 🎬 드림 스튜디오 v2 - Kling.ai 기반 (2024-12-31)
  // ═══════════════════════════════════════════════════════════════
  
  // 아바타 가이드 템플릿 목록
  app.get('/api/dream-studio/v2/guide-templates', async (req, res) => {
    const { GUIDE_TEMPLATES } = await import('./klingai');
    const guides = Object.entries(GUIDE_TEMPLATES).map(([key, value]: [string, any]) => ({
      id: key,
      ...value
    }));
    res.json(guides);
  });

  // 전체 가이드 목록 (드림스튜디오 전용 - 인증 없이)
  app.get('/api/dream-studio/v2/guides', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const result = await storage.searchGuides({ limit, offset: 0 });
      res.json({ success: true, guides: result.guides, total: result.total });
    } catch (error) {
      console.error('드림스튜디오 가이드 목록 오류:', error);
      res.status(500).json({ success: false, error: '가이드 목록 로드 실패' });
    }
  });

  app.post('/api/dream-studio/v2/create-video', async (req, res) => {
    try {
      const { 
        description, 
        imageBase64,
        imageUrl,
        guideType = 'young_female',
        language = 'ko', 
        duration = '5'
      } = req.body;
      
      if (!imageUrl && !imageBase64) {
        return res.status(400).json({ error: '영상 생성을 위한 이미지가 필요합니다' });
      }
      
      const klingAccessKey = process.env.KLING_ACCESS_KEY;
      const klingSecretKey = process.env.KLING_SECRET_KEY;
      
      if (!klingAccessKey || !klingSecretKey) {
        return res.status(500).json({ error: 'Kling.ai API Key가 설정되지 않았습니다' });
      }
      
      console.log(`🎬 [드림스튜디오 v2] Kling.ai 파이프라인 시작`);
      const startTime = Date.now();
      
      const { generateVideo, GUIDE_TEMPLATES } = await import('./klingai');
      
      // 1단계: 분석 + 대사 생성 (기존 DB description 활용)
      let analyzed: AnalyzedScript;
      if (description) {
        console.log(`   - Step 1: 텍스트 분석 (비용 절감)`);
        analyzed = await analyzeTextAndGenerateScript(description, language, parseInt(duration) * 4);
      } else {
        console.log(`   - Step 1: 이미지 분석`);
        analyzed = await analyzeImageAndGenerateScript(imageBase64!, language, parseInt(duration) * 4);
      }
      console.log(`   - 대사 생성 완료: ${analyzed.script.substring(0, 30)}...`);
      
      // 2단계: 카테고리 기반 분기 (artwork vs landmark/food_drink)
      const isArtwork = analyzed.category === 'artwork';
      console.log(`   - Step 2: 카테고리 분류 - ${analyzed.category} (${analyzed.categoryKo})`);
      
      // 2.5단계: 가이드 템플릿 선택 (landmark/food_drink일 때만)
      const guide = GUIDE_TEMPLATES[guideType as keyof typeof GUIDE_TEMPLATES] || GUIDE_TEMPLATES.young_female;
      
      let finalImageBase64 = imageBase64;
      let finalImageUrl = imageUrl;
      let finalPrompt: string;
      
      if (isArtwork) {
        // 예술품/조각: 원본 이미지가 살아 움직이는 애니메이션
        console.log(`   - Step 2.5: 🎨 예술품 모드 - 원본 이미지 사용`);
        
        // artwork 모드: 가능하면 원본 URL을 직접 Kling.ai에 전달 (고해상도 유지)
        if (imageUrl) {
          // 상대 URL이면 절대 URL로 변환
          if (!imageUrl.startsWith('http')) {
            const baseUrl = process.env.REPLIT_DEV_DOMAIN 
              ? `https://${process.env.REPLIT_DEV_DOMAIN}`
              : 'http://localhost:5000';
            finalImageUrl = baseUrl + (imageUrl.startsWith('/') ? imageUrl : '/' + imageUrl);
          } else {
            finalImageUrl = imageUrl;
          }
          finalImageBase64 = undefined;
          console.log(`   - 원본 이미지 URL 사용: ${finalImageUrl}`);
        }
        // imageBase64만 있는 경우 그대로 사용
        
        finalPrompt = `This artwork comes to life with subtle, magical animation. The sculpture/painting gently moves, breathes, and expresses emotion as if awakening. Cinematic lighting, ethereal atmosphere, smooth gentle movements. The artwork speaks: "${analyzed.script}"`;
      } else {
        // 유적지/음식: 가이드 캐릭터가 설명
        console.log(`   - Step 2.5: 🎭 가이드 모드 - ${guide.name} 아바타 사용`);
        const avatarPath = path.join(process.cwd(), 'public', guide.avatarPath);
        try {
          const avatarBuffer = fs.readFileSync(avatarPath);
          finalImageBase64 = avatarBuffer.toString('base64');
          finalImageUrl = undefined;
          console.log(`   - 아바타 이미지 로드 완료`);
        } catch (avatarError) {
          console.warn(`   - 아바타 로드 실패, 원본 이미지 사용: ${avatarError}`);
        }
        const audioPrompt = (guide as any).audioTemplate?.replace('${script}', analyzed.script) || '';
        finalPrompt = `${guide.promptTemplate} ${audioPrompt}`;
      }
      console.log(`   - Step 3: 프롬프트 조합 완료`);
      
      // 4단계: Kling.ai 영상 생성 (pro 모드)
      console.log(`   - Step 4: Kling.ai 영상 생성 (${duration}초, pro 모드, ${isArtwork ? '예술품' : '가이드'})`);
      console.log(`   - 이미지 정보: base64 길이=${finalImageBase64?.length || 0}, url=${finalImageUrl ? '있음' : '없음'}`);
      
      let videoUrl: string;
      try {
        videoUrl = await generateVideo({
          imageBase64: finalImageBase64,
          imageUrl: finalImageUrl,
          prompt: finalPrompt,
          duration: duration as '5' | '10',
          mode: 'pro'
        });
      } catch (klingError: any) {
        console.error('Kling.ai 오류:', klingError);
        return res.status(500).json({ 
          error: 'Kling.ai 영상 생성 실패',
          details: klingError.message,
          analysis: analyzed
        });
      }
      
      const totalTime = Date.now() - startTime;
      console.log(`🎬 [드림스튜디오 v2] 파이프라인 완료: ${totalTime}ms`);
      
      // DB에 영상 메타데이터 저장
      if (videoUrl) {
        try {
          const userId = req.user?.id || null;
          await db.insert(dreamStudioVideos).values({
            userId,
            talkId: null, // Kling.ai는 talkId 없음
            guideType,
            language,
            description: description || null,
            script: analyzed.script,
            videoUrl,
            duration: parseInt(duration),
            status: 'completed',
            processingTime: totalTime
          });
          console.log(`   - DB 저장 완료 (userId: ${userId || 'anonymous'})`);
        } catch (dbError) {
          console.error('DB 저장 실패:', dbError);
          // DB 저장 실패해도 영상은 반환
        }
      }
      
      res.json({
        analysis: analyzed,
        videoUrl,
        mode: isArtwork ? 'artwork' : 'guide',
        guide: isArtwork ? null : {
          id: guideType,
          name: guide.name,
          emoji: guide.emoji
        },
        processingTime: totalTime
      });
      
    } catch (error) {
      console.error('Kling.ai 파이프라인 오류:', error);
      res.status(500).json({ error: '영상 생성 중 오류가 발생했습니다' });
    }
  });

  // Kling.ai 태스크 상태 확인
  app.get('/api/dream-studio/v2/task/:taskId', async (req, res) => {
    try {
      const { getTaskResult } = await import('./klingai');
      const result = await getTaskResult(req.params.taskId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // 💳 프로필 페이지 API 라우트 (2025-11-26)
  // ═══════════════════════════════════════════════════════════════
  // 목적: 프로필 페이지, 크레딧, 결제 관련 API
  // 파일: server/profileRoutes.ts
  // ═══════════════════════════════════════════════════════════════
  app.use('/api', profileRoutes);

  const httpServer = createServer(app);
  return httpServer;
}
