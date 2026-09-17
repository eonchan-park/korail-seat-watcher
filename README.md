# 코레일 좌석 알리미

용산 ↔ 광주송정 등 원하는 구간의 코레일(KTX) 좌석을 1시간 동안 5분 간격으로 확인해
이메일로 알려주는 도구입니다.

- `index.html` — GitHub Pages로 배포하는 조회용 웹페이지
- `.github/workflows/check-seats.yml` — 실제 조회/이메일 발송을 수행하는 GitHub Actions
- `scripts/check-seats.js` — Playwright로 korail.com을 실제 브라우저처럼 조작해 좌석을 조회하는 스크립트

## 왜 이렇게 만들었는가

코레일 사이트의 좌석 조회 API는 세션마다 경로가 바뀌는 봇 차단 계층 뒤에 있어
단순 HTTP 요청으로는 안정적으로 호출할 수 없습니다. 그래서 매 조회마다 실제
브라우저(Playwright, headless Chromium)로 사람과 동일하게 출발역/도착역/날짜를
입력하고 "열차 조회"를 눌러 결과를 읽습니다.

## 최초 1회 설정

1. **저장소를 private으로 GitHub에 올립니다.**
2. **GitHub Pages 활성화**: Settings → Pages → Source를 `main` 브랜치 루트로 설정합니다.
   (private 저장소에서 Pages를 쓰려면 GitHub Pro/Team 이상 플랜이 필요합니다.)
3. **이메일 발송용 Secrets 등록**: Settings → Secrets and variables → Actions →
   New repository secret 에서 아래 두 개를 등록합니다.
   - `GMAIL_USER`: 보내는 Gmail 주소 (예: eonchan.park@gmail.com)
   - `GMAIL_APP_PASSWORD`: 구글 계정 2단계 인증 후 발급받은 **앱 비밀번호** (일반 로그인 비밀번호 아님)
     발급 경로: 구글 계정 → 보안 → 2단계 인증 → 앱 비밀번호
4. **워크플로 실행용 토큰 발급**: GitHub → Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new token
   - Repository access: 이 저장소만 선택
   - Permissions: **Actions: Read and write** 만 부여 (그 외 권한 불필요)
5. GitHub Pages로 열린 `index.html` 페이지의 "최초 1회 설정"에 owner/repo/branch와
   위에서 만든 토큰을 입력합니다. 이 토큰은 브라우저 localStorage에만 저장되고
   저장소에는 절대 커밋되지 않습니다.

## 사용법

웹페이지에서 출발역/도착역/날짜/시간대/수신 이메일을 입력하고
"조회 시작"을 누르면 GitHub Actions가 트리거되어 1시간 동안 5분마다 조회하고,
좌석이 새로 생기면 즉시 이메일을 보냅니다. 진행 상황은 저장소의 Actions 탭에서
확인할 수 있습니다.

## 로컬에서 직접 실행하기 (선택)

```bash
npm install
npx playwright install --with-deps chromium
FROM_STATION=용산 TO_STATION=광주송정 TRAVEL_DATE=2026-09-20 \
TIME_FROM=07:00 TIME_TO=12:00 RECIPIENT_EMAIL=you@example.com \
GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx \
npm run check
```
