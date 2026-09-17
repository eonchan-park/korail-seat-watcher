// 코레일(korail.com) 승차권 예매 사이트에서 지정한 구간/날짜/시간대의 열차 좌석 현황을
// 5분 간격으로 1시간(총 12회) 동안 조회하고, 좌석이 새로 생기면 이메일로 알린다.
//
// 코레일 사이트는 실제 조회 API가 세션마다 바뀌는 난독화된 경로(/web_s/...) 뒤에 있어
// 순수 HTTP 요청으로는 차단되기 쉽다. 그래서 매 조회마다 실제 브라우저(Playwright)로
// 사람이 하는 것과 동일하게 출발역/도착역/날짜를 입력하고 "열차 조회"를 눌러 결과를 읽는다.

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');

const SEARCH_URL = 'https://korail.com/ticket/search/general';
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const POLL_COUNT = 12; // 5분 x 12회 = 1시간
const SEARCH_TIMEOUT_MS = 20000;

function env(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

const FROM_STATION = env('FROM_STATION', '용산');
const TO_STATION = env('TO_STATION', '광주송정');
const TRAVEL_DATE = env('TRAVEL_DATE'); // YYYY-MM-DD
const TIME_FROM = env('TIME_FROM', '00:00'); // HH:MM
const TIME_TO = env('TIME_TO', '23:59'); // HH:MM
const RECIPIENT_EMAIL = env('RECIPIENT_EMAIL');
const GMAIL_USER = env('GMAIL_USER');
const GMAIL_APP_PASSWORD = env('GMAIL_APP_PASSWORD');

if (!TRAVEL_DATE) throw new Error('TRAVEL_DATE (YYYY-MM-DD) 값이 필요합니다.');
if (!RECIPIENT_EMAIL) throw new Error('RECIPIENT_EMAIL 값이 필요합니다.');
if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD 시크릿이 설정되어 있지 않습니다.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
});

async function sendEmail(subject, html) {
  await transporter.sendMail({
    from: `"코레일 좌석 알리미" <${GMAIL_USER}>`,
    to: RECIPIENT_EMAIL,
    subject,
    html,
  });
  console.log(`[메일 발송] ${subject} -> ${RECIPIENT_EMAIL}`);
}

async function selectStation(page, placeholder, stationName) {
  await page.locator(`input[placeholder="${placeholder}"]`).click();
  const dialog = page.getByRole('dialog').filter({ hasText: '기차역 조회' });
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  const searchBox = dialog.getByPlaceholder(/역 이름 또는 초성 검색/);
  await searchBox.click();
  await searchBox.fill(stationName);
  const suggestion = dialog.getByRole('link', { name: stationName, exact: true });
  await suggestion.first().click({ timeout: 10000 });
  await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
}

async function selectDate(page, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  await page.locator('input[placeholder="날짜를 선택해주세요"]').click();
  const dialog = page.getByRole('dialog').filter({ hasText: '날짜 선택' });
  await dialog.waitFor({ state: 'visible', timeout: 10000 });

  const targetIdx = y * 12 + (m - 1);
  for (let i = 0; i < 24; i += 1) {
    const label = await dialog.locator('text=/^\\d{4}\\.\\s*\\d{2}\\.$/').first().innerText();
    const match = label.match(/(\d{4})\.\s*(\d{2})\./);
    if (!match) break;
    const curIdx = Number(match[1]) * 12 + (Number(match[2]) - 1);
    if (curIdx === targetIdx) break;
    if (curIdx < targetIdx) {
      await dialog.getByRole('button', { name: 'Next' }).click();
    } else {
      await dialog.getByRole('button', { name: 'Previous' }).click();
    }
    await page.waitForTimeout(150);
  }

  const dayCell = dialog
    .locator('table td:not(.disabled)')
    .filter({ has: page.locator(`span.day:text-is("${d}")`) });
  await dayCell.first().locator('a').click();

  await dialog.getByRole('link', { name: '00시' }).click().catch(() => {});
  await dialog.getByRole('button', { name: '적용' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
}

async function searchOnce(browser) {
  const context = await browser.newContext({
    locale: 'ko-KR',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  try {
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
    await page.locator('input[placeholder="출발역"]').waitFor({ state: 'visible', timeout: 15000 });

    await selectStation(page, '출발역', FROM_STATION);
    await selectStation(page, '도착역', TO_STATION);
    await selectDate(page, TRAVEL_DATE);

    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/web_s/') && r.request().method() === 'POST',
        { timeout: SEARCH_TIMEOUT_MS },
      ),
      page.getByRole('button', { name: '열차 조회' }).click(),
    ]);

    const data = await response.json().catch(() => null);
    const trains = data?.trn_infos?.trn_info;
    if (!trains) {
      throw new Error(`예상치 못한 응답: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return Array.isArray(trains) ? trains : [trains];
  } finally {
    await context.close();
  }
}

async function searchWithRetry(browser, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await searchOnce(browser);
    } catch (err) {
      lastErr = err;
      console.warn(`[조회 재시도 ${i}/${attempts}] ${err.message}`);
      await sleep(4000);
    }
  }
  throw lastErr;
}

function timeInRange(hhmm, from, to) {
  return hhmm >= from && hhmm <= to;
}

function isAvailable(train) {
  return train.h_rsv_psb_flg === 'Y' || (train.h_gen_rsv_nm && !train.h_gen_rsv_nm.includes('매진'));
}

function summarize(trains) {
  return trains
    .filter((t) => timeInRange(t.h_dpt_tm_qb, TIME_FROM, TIME_TO))
    .map((t) => ({
      trainNo: t.h_trn_no,
      trainType: t.h_trn_gp_nm || t.h_trn_clsf_nm,
      dep: t.h_dpt_tm_qb,
      arr: t.h_arv_tm_qb,
      general: t.h_gen_rsv_nm,
      special: t.h_spe_rsv_nm,
      available: isAvailable(t),
    }));
}

function buildEmailHtml(rows, timestamp) {
  const lines = rows
    .map(
      (r) =>
        `<tr>
          <td style="padding:6px 10px;border:1px solid #ddd;">${r.trainType} ${r.trainNo}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;">${r.dep} → ${r.arr}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;">일반실: ${r.general || '-'}</td>
          <td style="padding:6px 10px;border:1px solid #ddd;">특실: ${r.special || '-'}</td>
        </tr>`,
    )
    .join('\n');
  return `
    <p><b>${FROM_STATION} → ${TO_STATION}</b> / ${TRAVEL_DATE} ${TIME_FROM}~${TIME_TO}</p>
    <p>확인 시각: ${timestamp}</p>
    <table style="border-collapse:collapse;">
      <tr>
        <th style="padding:6px 10px;border:1px solid #ddd;">열차</th>
        <th style="padding:6px 10px;border:1px solid #ddd;">시간</th>
        <th style="padding:6px 10px;border:1px solid #ddd;">일반실</th>
        <th style="padding:6px 10px;border:1px solid #ddd;">특실</th>
      </tr>
      ${lines}
    </table>
    <p style="margin-top:12px;color:#666;">예매는 직접 코레일 사이트(https://korail.com)에서 진행해주세요. 이 메일은 좌석 현황만 알려줍니다.</p>
  `;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  let prevAvailableKey = null;
  let notifiedAvailability = false;

  try {
    for (let i = 1; i <= POLL_COUNT; i += 1) {
      const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
      console.log(`\n=== [${i}/${POLL_COUNT}] ${timestamp} 조회 시작 ===`);

      let rows = [];
      try {
        const trains = await searchWithRetry(browser);
        rows = summarize(trains);
        console.log(
          rows
            .map((r) => `${r.trainType} ${r.trainNo} ${r.dep}~${r.arr} 일반:${r.general} 특실:${r.special}`)
            .join('\n') || '(시간대 내 열차 없음)',
        );
      } catch (err) {
        console.error(`[조회 실패] ${err.message}`);
      }

      const availableRows = rows.filter((r) => r.available);
      const currentKey = availableRows.map((r) => r.trainNo).sort().join(',');

      if (currentKey && currentKey !== prevAvailableKey) {
        await sendEmail(
          `[코레일 좌석 알림] ${FROM_STATION}→${TO_STATION} ${TRAVEL_DATE} 좌석 발견`,
          buildEmailHtml(availableRows, timestamp),
        );
        notifiedAvailability = true;
      }
      prevAvailableKey = currentKey;

      const isLast = i === POLL_COUNT;
      if (isLast && !notifiedAvailability) {
        await sendEmail(
          `[코레일 좌석 알림] ${FROM_STATION}→${TO_STATION} ${TRAVEL_DATE} 조회 종료 (좌석 없음)`,
          `<p>1시간 동안 5분 간격으로 조회했지만 지정한 시간대(${TIME_FROM}~${TIME_TO})에 예약 가능한 좌석을 찾지 못했습니다.</p>`,
        );
      }

      if (!isLast) await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
