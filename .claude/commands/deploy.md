# /deploy — 커밋 + 푸시 (원스톱 배포)

변경사항을 커밋하고 GitHub에 push합니다.
push 후 Replit에서 Pull + Deploy, EAS에서 앱 빌드가 진행됩니다.

## 실행 순서  **커밋전 Simplify+Review Skills 사용 2단계 검증 필수**

### 1. 변경사항 확인
- `git status`로 변경 파일 목록 확인
- `git diff --stat`로 변경 규모 확인
- 변경 없으면 "변경사항 없음" 출력 후 중단

### 2. 스테이징
- 변경된 파일을 개별적으로 `git add` (git add -A 사용 금지)
- 민감 파일 제외: `.env`, `credentials.json`, `*.p12`, `*.mobileprovision`, `*.keystore`, `*.jks`, `*.b64`, `*.p8`
- 제외된 파일이 있으면 사용자에게 알림

### 3. 커밋 메시지 생성
- `git diff --cached`를 분석하여 변경 내용 파악
- 한국어로 간결한 커밋 메시지 작성 (예: "TTS 자동재생 전환 + keepAwake 연결")
- 최근 커밋 스타일(`git log --oneline -5`)에 맞춤
- Co-Authored-By 포함

### 4. 커밋 실행
- HEREDOC 형식으로 커밋 메시지 전달
- pre-commit hook 실패 시 수정 후 새 커밋 (amend 금지)

### 5. GitHub push
- `git push origin main`
- push 실패 시 원인 분석 후 보고 (force push 절대 금지)

### 6. 결과 보고
push 성공 시 아래 메시지 출력:

```
✅ Push 완료
- 커밋: [커밋 해시] [메시지]
- 파일: [N]개 변경

📱 앱 빌드:
- EAS Build 자동 트리거됨 → Expo 대시보드에서 확인

🌐 서버 배포:
- Replit → Git 탭 → Pull 버튼 → Deploy
  (Deployment 설정에 Build command: npm run build 지정되어 있으면 자동 빌드)
```
