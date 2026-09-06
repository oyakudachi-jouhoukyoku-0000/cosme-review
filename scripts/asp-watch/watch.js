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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-sonnet-5';

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

// カテゴリごとの「悩み・共感」導入、おすすめ対象、チェックポイントを用意し、
// 読み応えのある記事構成(共感→提案→対象読者→検討ポイント→行動喚起)のベースにする
const CATEGORY_HOOKS = {
  '総合通販': {
    pain: '欲しいものは決まっているのに、どこで買うのが一番お得か、なかなか決められないことはありませんか。似たような商品でも、お店によって価格やポイント還元、届くまでの日数は変わってきます。',
    points: ['普段の買い物をもっとお得にしたい方', '欲しい商品をまとめて探したい方', 'ポイント還元やセールを活用したい方', '信頼できるお店で買い物をしたい方'],
    checkpoints: ['取り扱っている商品のジャンルや品揃え', '送料や支払い方法の条件', 'ポイント制度やセール・キャンペーンの有無'],
  },
  '健康': {
    pain: '最近なんとなく体調がすぐれない日が続いていたり、健康診断の数値が気になったりすることはありませんか。忙しい毎日の中では、つい後回しになりがちです。',
    points: ['健康管理を見直したい方', '毎日のコンディションをサポートしたい方', '生活習慣を整えるきっかけを探している方'],
    checkpoints: ['続けやすい価格・続けやすい形式かどうか', '自分の悩みや目的に合っているか', '公式ページの説明や注意事項'],
  },
  '美容': {
    pain: '鏡を見るたびに、肌や見た目の変化が気になっていませんか。「何か変えてみたい」と思いつつ、選択肢が多すぎて決めきれないという方も多いはずです。',
    points: ['自分磨きを始めたい方', '新しいケア方法を試したい方', '自分に合うものをじっくり探したい方'],
    checkpoints: ['自分の肌質・悩みに合っているか', '続けやすい価格・手間かどうか', '公式ページで成分や使用方法を確認すること'],
  },
  'グルメ・食品': {
    pain: '毎日の食事、もっと美味しく・便利にできたらと思うことはありませんか。自炊も外食も、たまにはマンネリを感じてしまうものです。',
    points: ['自宅での食事を充実させたい方', '手軽に良いものを取り寄せたい方', '特別な日の食事を探している方'],
    checkpoints: ['届くまでの日数や配送方法', '内容量や価格のバランス', '公式ページの商品詳細'],
  },
  'ファッション': {
    pain: '「そろそろ新しい一着が欲しいな」と思いつつ、似合うものやトレンドが分からず迷ってしまうことはありませんか。',
    points: ['トレンドを取り入れたい方', 'お気に入りの一着を探している方', '普段のコーディネートに変化を加えたい方'],
    checkpoints: ['サイズ展開や素材の情報', '返品・交換の条件', '公式ページの写真やレビュー'],
  },
  '旅行': {
    pain: '「どこかへ出かけたいけど、何から決めればいいか分からない」ということはありませんか。行き先・時期・予算、決めることは意外と多いものです。',
    points: ['次の旅行先を探している方', 'お得に旅行を計画したい方', '新しい旅の過ごし方を探している方'],
    checkpoints: ['予約条件やキャンセルポリシー', '料金に含まれる内容', '公式ページの最新情報'],
  },
  '金融・投資・保険': {
    pain: 'このままの家計や備えで大丈夫か、ふと不安になることはありませんか。将来のことは気になっていても、何から始めればいいか分かりにくいテーマです。',
    points: ['家計や資産を見直したい方', '将来への備えを考えたい方', 'まずは情報収集から始めたい方'],
    checkpoints: ['自分のライフプランに合っているか', '手数料や条件をしっかり確認すること', '公式ページで最新の詳細を確認すること'],
  },
  '不動産・引越': {
    pain: '住まいのことで「そろそろ動くべきかな」と考えていませんか。情報を集めようにも、比較する手間が大変だと感じる方も多いはずです。',
    points: ['住み替えや引越しを検討している方', '物件情報を比較したい方', 'まずは相場を知りたい方'],
    checkpoints: ['対応エリアやサービス内容', '費用や条件の詳細', '公式ページでの最新情報の確認'],
  },
  '仕事情報': {
    pain: '今の職場、このまま働き続けていいのかなと感じることはありませんか。とはいえ、いきなり転職活動を始めるのはハードルが高いものです。',
    points: ['キャリアの選択肢を増やしたい方', '今より良い条件で働きたい方', 'まずは情報収集から始めたい方'],
    checkpoints: ['対応している職種やエリア', 'サポート内容や利用の流れ', '公式ページでの詳細確認'],
  },
  '学び・資格': {
    pain: '「何か新しいことを学びたい」と思いながら、忙しさを理由に後回しにしていませんか。',
    points: ['スキルアップを目指したい方', '新しい資格に挑戦したい方', '自分のペースで学びたい方'],
    checkpoints: ['学習スタイルや教材の形式', '費用と期間のバランス', '公式ページのカリキュラム詳細'],
  },
  '暮らし': {
    pain: '日々の暮らしの中で、ちょっとした不便やもっとこうだったらという思いを感じていませんか。',
    points: ['暮らしをもっと快適にしたい方', '便利なサービスを探している方', '日々の家事や手間を減らしたい方'],
    checkpoints: ['利用条件やエリア', '料金体系', '公式ページの詳細説明'],
  },
  'Webサービス': {
    pain: 'もっと便利なツールやサービスがあるはずなのに、と感じながら今のやり方を続けていませんか。',
    points: ['作業や手続きを効率化したい方', '新しいサービスを試したい方', '今の悩みを解決するツールを探している方'],
    checkpoints: ['料金プランや無料範囲', '対応環境やサポート体制', '公式ページの機能一覧'],
  },
  'インターネット接続': {
    pain: '今のネット環境、料金や速度に不満はありませんか。契約を見直すのは面倒でも、続けるほど差が出てくるテーマです。',
    points: ['通信費を見直したい方', 'より快適な通信環境を探している方', '契約内容を比較したい方'],
    checkpoints: ['対応エリアや工事の有無', '契約期間や解約条件', '公式ページでの料金詳細'],
  },
  'エンタメ': {
    pain: '「何か楽しいことがしたい」「気分転換がしたい」と思うことはありませんか。',
    points: ['新しい娯楽を探している方', '普段の生活に楽しみを増やしたい方', '手軽に始められるものを探している方'],
    checkpoints: ['利用料金や無料お試しの有無', 'コンテンツの内容', '公式ページでの詳細確認'],
  },
  'ギフト': {
    pain: '大切な人への贈り物、何にするか毎回悩んでしまうことはありませんか。',
    points: ['特別な人へのギフトを探している方', '記念日の贈り物を考えている方', '定番とは違う贈り物を探している方'],
    checkpoints: ['配送日の指定やラッピング対応', '価格帯とのバランス', '公式ページの商品詳細'],
  },
  'スポーツ・趣味': {
    pain: '「何か始めたいけど、きっかけがない」と感じていませんか。',
    points: ['新しい趣味やスポーツを始めたい方', '今の趣味をもっと充実させたい方', '気軽に始められるものを探している方'],
    checkpoints: ['初心者向けのサポート内容', '必要な道具や費用', '公式ページでの詳細確認'],
  },
  '結婚・恋愛': {
    pain: '人生の大切な選択について、一人で悩んでしまうことはありませんか。周りに相談しにくいテーマだからこそ、情報収集から始めたい方も多いはずです。',
    points: ['将来について考え始めた方', '新しい出会いを探している方', 'まずは情報収集から始めたい方'],
    checkpoints: ['サポート内容や利用の流れ', '料金体系', '公式ページでの詳細確認'],
  },
};

const GENERIC_FAQ = [
  {
    q: 'すぐに申し込んでも大丈夫ですか？',
    a: 'まずは公式ページで料金・条件・対応エリアなどの詳細を確認してから検討することをおすすめします。内容にしっかり納得したうえで申し込むことで、後からのミスマッチを防ぎやすくなります。',
  },
  {
    q: '口コミや体験談はどこで確認できますか？',
    a: '公式ページやSNS上で体験談が紹介されている場合がありますが、感じ方には個人差があります。あくまでひとつの参考情報として捉え、最終的な判断は公式の情報をもとに行うようにしましょう。',
  },
  {
    q: '他のサービスと比較してから決めた方がいいですか？',
    a: '同じジャンルの中でも、内容や条件はサービスによって異なります。気になるものが複数ある場合は、それぞれの公式ページを見比べてから決めるのも一つの方法です。',
  },
];

// ANTHROPIC_API_KEYが無い場合や、AI生成が失敗した場合のフォールバック用テンプレート
function buildFallbackDraft(item) {
  const hook = CATEGORY_HOOKS[item.category] || {
    pain: '「もっと良い方法があるかもしれない」と感じることはありませんか。今のやり方に大きな不満はなくても、比較してみることで新しい発見があるかもしれません。',
    points: ['新しい選択肢を探している方'],
    checkpoints: ['公式ページでの詳細確認'],
  };

  const pointsBlock = hook.points.map((p) => `・${p}`).join('\n');

  const checkpointsBlock = hook.checkpoints
    .map(
      (c, i) =>
        `【${i + 1}】${c}\n${c}について事前にしっかり確認しておくことで、申し込んだ後に「思っていたのと違った」と感じるリスクを減らせます。公式ページの説明を必ずチェックしましょう。`
    )
    .join('\n\n');

  const faqBlock = GENERIC_FAQ.map((f) => `Q. ${f.q}\nA. ${f.a}`).join('\n\n');

  const title = `${item.name}が気になる方へ`;
  const body = [
    '本記事は広告（PRリンク）を含みます。',
    '',
    hook.pain,
    '毎日の忙しさの中では、こうした悩みについてじっくり考える時間はなかなか取れないものです。それでも「このままでいいのかな」という気持ちがふと頭をよぎるようなら、一度立ち止まって情報を集めてみる価値はあります。',
    '',
    `そんな方に知っておいてほしいのが「${item.name}」です。`,
    'どんなサービスにも合う・合わないがあるからこそ、まずはどんな内容なのか、自分の状況に合っているのかを確認するところから始めてみましょう。',
    '',
    '■こんな方におすすめです',
    pointsBlock,
    '',
    '上記のいずれかに当てはまる方は、一度公式ページの内容を確認してみる価値があるかもしれません。特に、同じような悩みを抱えたまま日々を過ごしている方ほど、比較検討によって状況が大きく変わることもあります。',
    '',
    '■申し込む前にチェックしておきたいポイント',
    checkpointsBlock,
    '',
    '■こんな方は急がなくても良いかもしれません',
    '一方で、今の状況にすでに十分満足している方や、比較検討する時間を確保できない方は、無理に急いで申し込む必要はありません。「気になるものは他にもあるはず」と焦って決めてしまうと、後から見直したくなることもあります。ご自身の状況に合わせて、納得できるタイミングで判断することが大切です。',
    '',
    '■検討する際の進め方',
    '①公式ページで料金・条件・サービス内容を確認する\n②気になる点があれば、公式ページのお問い合わせ窓口で確認する\n③内容に納得できたら、案内に沿って申し込みを進める',
    '',
    '■よくある疑問',
    faqBlock,
    '',
    `ここまで「${item.name}」についてご紹介してきました。生活の中でふと感じる小さな違和感も、情報を集めて比較してみることで、思わぬ解決策が見つかることがあります。こうしたポイントをふまえて内容をよく確認し、納得したうえで検討することが、後悔しない選び方につながります。`,
    '',
    '▼詳細・お申し込みはこちら',
    item.url,
    '',
    '※効果・効能には個人差があります。詳しい商品説明・注意事項は公式ページでご確認ください。',
  ].join('\n');
  return { title, body };
}

async function callClaude(systemPrompt, userPrompt, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.content.map((c) => c.text || '').join('');
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON found in Claude response: ${text.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

const WRITER_SYSTEM_PROMPT = `あなたは「コスメ・美容レビューランキング」運営チームのライター担当AI社員です。
アフィリエイト案件を紹介するnote記事を、以下のルールに従って執筆してください。

【文体ルール】
- 敬体(です・ます調)で統一する
- 一文は60〜80字程度を目安に短くまとめる
- 断定を避けたレビュー調にする(「〜という声もあります」等)
- 「絶対」「必ず」「100%」等の断定的な強調語は使わない
- 絵文字は使わない

【薬機法・景品表示法の遵守(必須)】
- 医薬品的な効能効果(治る・消える・完治等)を標榜しない
- 化粧品・健康食品の効能効果として認められる範囲を超えた表現をしない
- 「業界No.1」等の最上級表現は、根拠が無いなら使わない
- 体験談・口コミを創作しない。個人の感想である旨や効果に個人差がある旨を明記する
- 本文の一番最初の行に必ず「本記事は広告（PRリンク）を含みます。」と書く

【最重要】
与えられた「わかっている事実」だけを根拠に書いてください。書かれていない具体的な数値・効果・体験談を勝手に作り出さないでください。わからないことは「公式ページでご確認ください」のように誘導してください。

本文は、共感・提案・具体的に検討すべきポイント・行動喚起を含む、読み応えのある構成にしてください。文字数の目安は1800〜2500字程度ですが、内容の水増しは避け、自然に書ける範囲で構いません。

出力は次のJSON形式のみを返してください。前後に説明文や\`\`\`は付けないこと。
{"title": "記事タイトル", "body": "記事本文"}`;

const EDITOR_SYSTEM_PROMPT = `あなたは「コスメ・美容レビューランキング」運営チームのエディター担当AI社員です。
ライター担当が書いた以下の記事を、次のチェックリストに従って校正してください。

【薬機法関連】
1. 「治る」「消える」「完治」「若返る」等の医薬品的な効能効果を標榜していないか
2. 化粧品・健康食品として認められる範囲を超えた表現をしていないか
3. 化粧品では標榜できない効果を暗示していないか
4. 「殺菌」「消毒」「治療」等の効果を誤って記載していないか
5. アンチエイジング等の表現が医学的効果を暗示していないか

【景品表示法関連】
6. 最上級表現に客観的根拠があるか、無ければ使っていないか
7. 体験談を掲載する場合「個人の感想」「効果には個人差」の明記があるか
8. 実際より著しく優良・お得であるかのような表示になっていないか
9. 不当な煽り表現になっていないか

【表示・アフィリエイト関連】
10. 本文冒頭に「本記事は広告（PRリンク）を含みます。」があるか
11. リンク誘導先と記事内容に齟齬がないか
12. 断定的すぎる強調語(絶対・必ず・100%等)が無いか

問題があれば自然な範囲で本文を修正してください。大きな問題が無ければ、文章の流れや読みやすさを整える程度の軽微な修正に留めてください。

出力は次のJSON形式のみを返してください。前後に説明文や\`\`\`は付けないこと。
{"title": "最終タイトル", "body": "最終本文", "verdict": "公開可 または 差し戻し", "notes": "修正点や気になる点の簡単なメモ"}`;

function buildResearchBrief(item) {
  return [
    `案件名: ${item.name}`,
    `カテゴリ: ${item.category}`,
    `成果報酬(アフィリエイト単価。読者には見せない内部情報): ${item.reward}円`,
    `確定率(承認率): ${item.approval}%`,
    `季節性判定: ${item.seasonal === '○' ? 'あり' : 'なし'}`,
    '',
    'A8.netの案件ページに記載されている、わかっている事実(生データ):',
    item.text,
  ].join('\n');
}

async function buildAiDraft(item) {
  if (!ANTHROPIC_API_KEY) {
    console.log(`ANTHROPIC_API_KEY not set, using fallback template for: ${item.name}`);
    return buildFallbackDraft(item);
  }

  try {
    const brief = buildResearchBrief(item);

    const writerRaw = await callClaude(
      WRITER_SYSTEM_PROMPT,
      `以下の「わかっている事実」をもとに、note記事を執筆してください。\n\n${brief}`,
      3000
    );
    const draft = extractJson(writerRaw);

    const editorRaw = await callClaude(
      EDITOR_SYSTEM_PROMPT,
      `【タイトル】\n${draft.title}\n\n【本文】\n${draft.body}`,
      3000
    );
    const edited = extractJson(editorRaw);

    console.log(`Editor verdict for "${item.name}": ${edited.verdict} (${edited.notes || ''})`);
    return { title: edited.title, body: edited.body };
  } catch (err) {
    console.error(`AI draft generation failed for ${item.name}, using fallback: ${err.message}`);
    return buildFallbackDraft(item);
  }
}

async function applyToProgram(page, item) {
  await page.goto(item.url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  const form = await page.$('form[action="/program/agreement/apply"]');
  if (!form) {
    console.log(`Apply form not found for: ${item.name} (may already be applied/partnered)`);
    return false;
  }
  const button = await form.$('button[type="submit"]');
  if (!button) {
    console.log(`Apply button not found for: ${item.name}`);
    return false;
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    button.click(),
  ]);
  console.log(`Applied to program: ${item.name}`);
  return true;
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

      const items = await page.$$eval('div.pgCard', (cards) => {
        const out = [];
        for (const card of cards) {
          const nameEl = card.querySelector('h3.pgName');
          const linkEl = card.querySelector('a[href*="programId="]');
          if (!nameEl || !linkEl) continue;
          out.push({
            name: nameEl.innerText.trim(),
            url: linkEl.href,
            text: card.innerText || '',
          });
        }
        return out;
      });
      for (const item of items) {
        rawItems.push({ ...item, category: category.name });
      }
      console.log(`[${category.name}] ${items.length} items scanned.`);
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

    // 条件に合う未提携案件には、その場で提携申請を送る
    // (すでに申請済み/提携中のものはステータス表示が変わるため「未提携」に該当しなくなり、再申請は起きない想定)
    let appliedCount = 0;
    for (const item of matchedItems) {
      if (item.text.includes('未提携')) {
        const applied = await applyToProgram(page, item);
        if (applied) appliedCount++;
      }
    }

    // データ分析用に、その日の巡回結果のサマリを記録する
    await postToSheet({
      type: 'analysis',
      date,
      scanned: rawItems.length,
      matched: matchedItems.length,
      applied: appliedCount,
    });

    if (matchedItems.length > 0) {
      // 条件に合った案件はすべて記事下書きにする
      for (const item of matchedItems) {
        const draft = await buildAiDraft(item);
        await postToSheet({
          type: 'note_draft',
          date,
          title: draft.title,
          body: draft.body,
          url: item.url,
        });
        console.log(`Note draft created for: ${item.name}`);
      }
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
