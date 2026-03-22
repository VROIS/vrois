// ⚠️ 수정금지(승인필요): 2026-03-22 One-Time Token (OTT) Store
// 앱 OAuth 세션 교환용 — Auth0/Keycloak 표준 패턴
// 외부 브라우저(Safari/Chrome)와 WebView 간 쿠키 미공유 문제 해결
// 토큰은 1회용 + 60초 만료

import crypto from 'crypto';

// 메모리 저장소: { token → { userId, expiresAt } }
const tokens = new Map<string, { userId: number; expiresAt: number }>();

export const ottStore = {
  // ⚠️ 수정금지(승인필요): OTT 토큰 생성 — userId 매핑, 60초 만료
  create(userId: number): string {
    const token = crypto.randomUUID();
    tokens.set(token, {
      userId,
      expiresAt: Date.now() + 60_000 // 60초 만료
    });
    return token;
  },

  // ⚠️ 수정금지(승인필요): OTT 토큰 검증 + 소비 — 1회용 (검증 즉시 삭제)
  consume(token: string): number | null {
    const entry = tokens.get(token);
    if (!entry) return null;
    tokens.delete(token); // 1회용 — 즉시 삭제

    if (Date.now() > entry.expiresAt) return null; // 만료
    return entry.userId;
  },

  // 만료된 토큰 정리 (5분마다 자동 실행)
  cleanup() {
    const now = Date.now();
    for (const [token, entry] of tokens) {
      if (now > entry.expiresAt) tokens.delete(token);
    }
  }
};

// 5분마다 만료 토큰 정리
setInterval(() => ottStore.cleanup(), 5 * 60_000);
