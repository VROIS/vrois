const nodemailer = require('nodemailer');
const { Client } = require('pg');

const SENDER_EMAIL = 'dbstour1@gmail.com';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const TESTING_LINK = 'https://play.google.com/apps/testing/com.sonanie.guide';

async function getGmailUsers() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const result = await client.query(
    `SELECT email, name FROM users WHERE email ILIKE '%@gmail.com' AND email IS NOT NULL ORDER BY email`
  );
  await client.end();
  return result.rows;
}

function getEmailHtml(name) {
  const greeting = name ? `안녕하세요, ${name}님! 👋` : '안녕하세요! 👋';
  return `
<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"></head>
<body style="font-family: 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">

  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #1a73e8; font-size: 24px;">📱 손안의 가이드</h1>
    <p style="color: #666; font-size: 14px;">AI 여행 가이드 앱</p>
  </div>

  <div style="background: #f8f9fa; border-radius: 12px; padding: 24px; margin-bottom: 20px;">
    <h2 style="color: #333; font-size: 18px; margin-top: 0;">${greeting}</h2>
    <p style="line-height: 1.8;">
      손안의 가이드 Android 앱이 Google Play Store 베타 테스트 중입니다.<br>
      회원님을 <strong>내부 테스터로 직접 등록</strong>해 드렸습니다. 🎉
    </p>
    <p style="line-height: 1.8;">
      아래 버튼을 클릭하면 바로 설치하실 수 있습니다.
    </p>
  </div>

  <div style="background: #fff8e1; border: 2px solid #f9a825; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
    <p style="margin: 0; font-size: 15px; font-weight: bold; color: #e65100;">
      ⚠️ 반드시 Chrome 브라우저로 열어주세요!
    </p>
    <p style="margin: 8px 0 0 0; font-size: 13px; color: #795548;">
      카카오톡이나 네이버 앱에서 링크를 클릭하면 오류가 납니다.<br>
      Gmail 앱에서 클릭하시면 자동으로 Chrome으로 열립니다. ✅
    </p>
  </div>

  <div style="background: #e8f5e9; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
    <h3 style="color: #2e7d32; margin-top: 0; font-size: 15px;">📋 설치 방법 (3단계)</h3>
    <ol style="line-height: 2.4; padding-left: 20px; margin: 0; font-size: 14px;">
      <li>아래 <strong>"지금 설치하기"</strong> 버튼 클릭</li>
      <li>Play Store에서 <strong>"테스터 되기"</strong> 클릭</li>
      <li><strong>"설치"</strong> 클릭 → 완료!</li>
    </ol>
  </div>

  <div style="background: #e8f0fe; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
    <h3 style="color: #1a73e8; margin-top: 0; font-size: 15px;">🎁 베타 테스터 혜택</h3>
    <ul style="line-height: 2; padding-left: 20px; margin: 0; font-size: 14px;">
      <li><strong>무료 100 크레딧</strong> 즉시 지급 (AI 가이드 50회)</li>
      <li>정식 출시 전 앱을 먼저 사용</li>
      <li>피드백이 앱 개선에 직접 반영</li>
    </ul>
  </div>

  <div style="text-align: center; margin: 30px 0;">
    <a href="${TESTING_LINK}"
       style="display: inline-block; background: #1a73e8; color: white; text-decoration: none; padding: 18px 48px; border-radius: 12px; font-size: 18px; font-weight: bold;">
      📱 지금 설치하기 (Android)
    </a>
    <p style="margin-top: 12px; font-size: 12px; color: #999;">Android 기기에서만 설치 가능합니다</p>
  </div>

  <div style="text-align: center; color: #999; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
    <p>본 메일은 손안의 가이드 가입 회원님께 발송되었습니다.</p>
    <p>문의: dbstour1@gmail.com</p>
  </div>

</body>
</html>`;
}

async function main() {
  if (!GMAIL_APP_PASSWORD) {
    console.error('❌ GMAIL_APP_PASSWORD 환경변수가 없습니다.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL 환경변수가 없습니다.');
    process.exit(1);
  }

  console.log('📡 DB에서 Gmail 사용자 조회 중...');
  const users = await getGmailUsers();
  console.log(`\n✅ Gmail 사용자 ${users.length}명 발견\n`);

  console.log('━'.repeat(60));
  console.log('📋 Play Console CSV 업로드용 이메일 목록 (아래를 복사하세요):');
  console.log('━'.repeat(60));
  users.forEach(u => console.log(u.email));
  console.log('━'.repeat(60));
  console.log('\n👆 위 이메일들을 Play Console → 내부 테스트 → 테스터 탭에 붙여넣으세요.');
  console.log('등록 완료 후 Enter를 눌러 이메일 발송을 시작하세요...\n');

  await new Promise(resolve => {
    process.stdin.once('data', resolve);
    process.stdout.write('준비되면 Enter ▶ ');
  });

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: SENDER_EMAIL, pass: GMAIL_APP_PASSWORD },
  });

  try {
    await transporter.verify();
    console.log('\n✅ Gmail SMTP 연결 성공!\n');
  } catch (err) {
    console.error('❌ Gmail SMTP 연결 실패:', err.message);
    process.exit(1);
  }

  let success = 0;
  let failed = 0;

  for (const user of users) {
    try {
      await transporter.sendMail({
        from: `"손안의 가이드" <${SENDER_EMAIL}>`,
        to: user.email,
        subject: '[손안의 가이드] Android 앱 베타 테스트 초대 (테스터로 등록되셨습니다)',
        html: getEmailHtml(user.name),
      });
      success++;
      console.log(`✅ [${success + failed}/${users.length}] ${user.email}`);
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      failed++;
      console.error(`❌ [${success + failed}/${users.length}] ${user.email}: ${err.message}`);
    }
  }

  console.log(`\n📊 완료: 성공 ${success}건, 실패 ${failed}건 (총 ${users.length}건)`);
}

main().catch(console.error);
