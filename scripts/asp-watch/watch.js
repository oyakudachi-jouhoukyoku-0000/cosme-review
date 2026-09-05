const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const LOGIN_URL = 'https://media-console.a8.net/program/search/top';

// 「新着」に限らず、全カテゴリを巡回して確定率(承認率)の実績があるプログラムも対象にする
const CATEGORIES = [
  { code: '01', name: '総合通販' },
  { code: '02', name: '健康' },
  { code: '03', name: '美容' },
  { code: '04', name: 'グルメ・食品' },
  { code: '05', name: 'ファッション' },
  { code: '06', name: '旅行' },
  { code: '07', name: '金融・投資・保険' },
  { code: '08', name: '不動産・引越' },
  { code: '09', name: '仕事情報' },
  { code: '10', name: '学び・資格' },
  { code: '11', name: '暮らし' },
  { code: '12', name: 'Webサービス' },
  { code: '13', name: 'インターネット接続' },
  { code: '14', name: 'エンタメ' },
  { code: '15', name: 'ギフト' },
  { code: '16', name: 'スポーツ・趣味' },
  { code: '17', name: '結婚・恋愛' },
];

const A8_ID = process.env.A8_LOGIN_ID;
const A8_PW = process.env.A8_LOGIN_PASSWORD;
const SHEET_WEBAPP_URL = process.env.SHEET_WEBAPP_URL;

const MIN_APPROVAL_RATE = 70; // %
const MIN_REWARD = 20000; // yen

// 季節性ありと判定するキーワード（広め判定）
const SEASONAL_KEYWORDS = [
  '日焼け止め', 'UV', '紫外線', '花粉', 'マスク', '加湿器', '除湿',
  '扇風機', '冷感', 'ホッカイロ', 'カイロ', 'ヒーター', '暖房',
  'クリスマス', 'ハロウィン', 'バレンタイン', 'ホワイトデー',
  '母の日', '父の日', 'お中元', 'お歳暮', '福袋', '年賀',
  '新生活', '入学', '卒業', '衣替え', '浴衣', '水着',
];

const DEBUG_DIR = path.join(__dirname, 'debug');

function isSeasonal(text) {
  return SEASONAL_KEYWORDS.some((kw) => text.includes(kw));
}

function parseYen(text) {
  const m = text.match(/([0-9][0-9,]*)\s*円/);
  if (!m) return null;
  return parseInt(m[1].replace(/,/g, ''), 10);
}

function parsePercent(text) {
  const m = text.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  if (!m) return null;
  return parseFloat(m[1]);
}

function todayJST() {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .replace(/\//g, '-');
}

function buildNoteDraft(item) {
  const title = `${item.name}が気になっている方へ`;
  const body = [
    '本記事は広告（PRリンク）を含みます。',
    '',
    `今回ご紹介するのは「${item.name}」です。`,
    '',
    '気になる方は、下記の詳細ページで内容をチェックしてみてください。',
    item.url,
    '',
    '※効果・効能には個人差があります。詳しい商品説明・注意事項は公式ページでご確認ください。',
  ].join('\n');
  return { title, body };
}

async function postToSheet(row) {
  if (!SHEET_WEBAPP_URL) {
    console.log('SHEET_WEBAPP_URL not set, skipping write:', row);
    return;
  }
  const res = await fetch(SHEET_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`Sheet write failed: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  if (!A8_ID || !A8_PW) {
    throw new Error('A8_LOGIN_ID / A8_LOGIN_PASSWORD is not set');
  }
  fs.mkdirSync(DEBUG_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const passwordInput = await page.$('input[type="password"]');
    if (passwordInput) {
      console.log('Login form detected, logging in...');
      const idInput = await page.$(
        'input[name="login_id"], input[type="email"], input[type="text"]'
      );
      if (!idInput) throw new Error('Could not find login ID field');
      await idInput.fill(A8_ID);
      await passwordInput.fill(A8_PW);

      const submitButton = await page.$(
        'button[type="submit"], input[type="submit"]'
      );
      if (!submitButton) throw new Error('Could not find login submit button');

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        submitButton.click(),
      ]);
      await page.waitForTimeout(2000);
    } else {
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    }

    // カテゴリを1つずつ巡回して、各カテゴリのプログラム一覧を集める
    const rawItems = [];
    for (const category of CATEGORIES) {
      const categoryUrl = `https://media-console.a8.net/program/search/category?primaryCategoryCode=${category.code}`;
      await page.goto(categoryUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});

      const items = await page.$$eval('a[href*="program"]', (links) => {
        const seen = new Set();
        const out = [];
        for (const link of links) {
          const href = link.href;
          const name = (link.innerText || '').trim();
          if (!href || !name || seen.has(href)) continue;
          seen.add(href);
          let container = link;
          for (let i = 0; i < 5 && container.parentElement; i++) {
            container = container.parentElement;
          }
          out.push({ name, url: href, text: container.innerText || '' });
        }
        return out;
      });
      for (const item of items) {
        rawItems.push({ ...item, category: category.name });
      }
      console.log(`[${category.name}] ${items.length} items scanned.`);

      if (category.code === '02') {
        fs.writeFileSync(path.join(DEBUG_DIR, 'sample-page.html'), await page.content());
      }
    }

    await page.screenshot({ path: path.join(DEBUG_DIR, 'page.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(
      path.join(DEBUG_DIR, 'raw-items.json'),
      JSON.stringify(rawItems, null, 2)
    );

    const date = todayJST();
    const matchedItems = [];

    for (const item of rawItems) {
      const reward = parseYen(item.text);
      const approval = parsePercent(item.text);
      if (reward === null || approval === null) continue;
      if (reward < MIN_REWARD || approval < MIN_APPROVAL_RATE) continue;

      const seasonal = isSeasonal(item.name + ' ' + item.text) ? '○' : '×';

      await postToSheet({
        date,
        asp: 'A8.net',
        name: item.name,
        reward,
        approval: `${approval}%`,
        seasonal,
        url: item.url,
      });
      matchedItems.push({ ...item, reward, approval, seasonal });
      console.log(`Saved: ${item.name} (reward=${reward}, approval=${approval}%, seasonal=${seasonal})`);
    }

    console.log(`Done. ${rawItems.length} items scanned, ${matchedItems.length} matched and saved.`);

    if (matchedItems.length > 0) {
      // その日の候補の中から単価が一番高いものを、note記事の下書き1本分として採用
      const best = matchedItems.reduce((a, b) => (b.reward > a.reward ? b : a));
      const draft = buildNoteDraft(best);
      await postToSheet({
        type: 'note_draft',
        date,
        title: draft.title,
        body: draft.body,
        url: best.url,
      });
      console.log(`Note draft created for: ${best.name}`);
    } else {
      console.log('No matched items today, no note draft created.');
    }
  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: path.join(DEBUG_DIR, 'error.png'), fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
