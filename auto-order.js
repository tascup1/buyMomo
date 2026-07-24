/**
 * momo購物網 定時自動下單腳本(Puppeteer)
 *
 * 流程(每次執行都是全新登入,確保交易 session 有效、避免 SCS076):
 * 1. 啟動時先清空瀏覽器資料(browser-data)→ 必定走「輸入帳密」的完整 Google 登入
 * 2. 登入後開購物車頁實測「交易 session」有效(不是只看首頁 header)
 * 3. 停在商品頁倒數,到 orderTime 後:reload → 點「直接購買」
 *    (按鈕沒出現就重整重試;點到並確認生效後即收手,結帳手動完成)
 *
 * 使用方式:
 *   npm install
 *   node auto-order.js
 *
 * ⚠️ 帳號密碼以明文存在此檔案中,請勿把這個資料夾分享給別人。
 */

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

// 打包成執行檔(pkg)後,__dirname 指向執行檔內部的「唯讀」虛擬檔案系統,
// 需要寫入的檔案(config.json、browser-data)必須放在執行檔所在的真實目錄。
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');

// ============================================================
// 設定區(帳密/商品網址/搶購時間 由啟動時的問答填入,存於 config.json)
// ============================================================
const CONFIG = {
  homeUrl: 'https://www.momoshop.com.tw/',
  loginUrl:
    'https://www.momoshop.com.tw/mypage/MemberCenter.jsp?func=18&cid=memfu&oid=login',

  // 測試模式:true = 登入成功後只停留在商品頁,不執行購買/結帳
  stopAfterLogin: false,

  // 以下三項由啟動問答填入
  productUrl: '',
  google: { email: '', password: '' },
  orderTime: '',

  // 提前幾毫秒開始動作(補償頁面載入延遲)
  earlyOffsetMs: 500,

  // 登入完成後自動再開第二個視窗(共用同一個登入狀態),兩個視窗同時搶,
  // 誰先看到「直接購買」誰先點;任一個成功,另一個自動收手
  dualWindow: true,

  // 商品頁要點擊的按鈕文字(比對「包含」該文字的可見按鈕)
  buttons: {
    buy: ['直接購買'],
  },

  // 「直接購買」的等待/重整策略(人潮多、頁面慢時避免誤判)
  buttonPoll: {
    renderedWaitMs: 5000,  // 頁面「已完整載入」後,再多等這麼久仍沒按鈕 → 才重新整理
    slowLoadMaxMs: 30000,  // 頁面一直載不完時,單次最多等這麼久才重新整理
    reloadDelayMs: 300,    // 每次重新整理之間的間隔
  },

  // 瀏覽器資料存放位置(每次啟動前會自動清空,確保全新登入)
  userDataDir: path.join(BASE_DIR, 'browser-data'),
};
// ============================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// 啟動問答:向使用者詢問帳密/商品網址/搶購時間,存到 config.json
// ============================================================

// 全程共用同一個 readline 介面,並用「行佇列」收集所有輸入。
// 這樣不論使用者逐題輸入,或輸入被整批送達(貼上多行/管線),都不會遺失。
let rlInstance = null;
const lineQueue = [];
let lineWaiter = null;

function getRl() {
  if (!rlInstance) {
    rlInstance = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rlInstance.on('line', (line) => {
      if (lineWaiter) {
        const w = lineWaiter;
        lineWaiter = null;
        w(line);
      } else {
        lineQueue.push(line);
      }
    });
  }
  return rlInstance;
}

/** 問一個問題;hidden=true 時輸入內容以 * 顯示(用於密碼) */
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = getRl();
    const orig = rl._writeToOutput.bind(rl);
    if (hidden) {
      // 遮蔽使用者敲的字元(問題本身由下面的 stdout.write 直接印,不經過 rl)
      rl._writeToOutput = (str) => orig(str.replace(/[^\r\n]/g, '*'));
    }
    process.stdout.write(question);

    const finish = (answer) => {
      if (hidden) {
        rl._writeToOutput = orig; // 恢復正常輸出
        process.stdout.write('\n');
      }
      resolve(answer.trim());
    };
    if (lineQueue.length > 0) return finish(lineQueue.shift());
    lineWaiter = finish;
  });
}

/** 解析使用者輸入的時間字串,回傳合法的 Date 或 null */
function parseOrderTime(str) {
  if (!str) return null;
  const normalized = str.trim().replace('T', ' ');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 載入上次設定 + 問答(按 Enter 沿用上次的值),結果寫回 config.json 與 CONFIG */
async function loadOrAskConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* 第一次執行,沒有 config.json */
  }

  console.log('======================================');
  console.log('   傻比你好 momo 定時搶購小幫手 - 設定');
  console.log('   (直接按 Enter 可沿用上次的設定)');
  console.log('======================================\n');

  const email =
    (await ask(
      `Gmail 帳號${saved.email ? `(上次:${saved.email})` : ''}:`
    )) || saved.email;
  if (!email) {
    console.log('❌ 沒有輸入帳號,無法繼續。');
    process.exit(1);
  }

  const password =
    (await ask(
      `Gmail 密碼${saved.password ? '(Enter 沿用上次)' : ''}:`,
      { hidden: true }
    )) || saved.password;
  if (!password) {
    console.log('❌ 沒有輸入密碼,無法繼續。');
    process.exit(1);
  }

  const productUrl =
    (await ask(
      `商品網址${saved.productUrl ? `(上次:${saved.productUrl.slice(0, 50)}...)` : ''} 要到商品的詳細頁喔:`
    )) || saved.productUrl;
  if (!productUrl || !productUrl.startsWith('http')) {
    console.log('❌ 商品網址不正確,無法繼續。');
    process.exit(1);
  }

  let orderTime = null;
  while (!orderTime) {
    console.log('搶購時間,格式 2026-07-28 10:00:00, 如果輸入現在之前的時間就會是立刻執行');
    const input =
      (await ask(
        `${saved.orderTime ? `(上次:${saved.orderTime})` : ''}:`
      )) || saved.orderTime;
    orderTime = parseOrderTime(input);
    if (!orderTime) {
      console.log('   ⚠️ 時間格式看不懂,請再輸入一次(例:2026-07-28 10:00:00)');
      saved.orderTime = ''; // 沿用值也不合法時,強制重新輸入
    } else {
      saved.orderTime = input.trim();
    }
  }

  // 寫回 config.json(密碼為明文,請提醒使用者不要外流這個檔案)
  const toSave = {
    email,
    password,
    productUrl,
    orderTime: saved.orderTime,
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(toSave, null, 2), 'utf8');

  CONFIG.google.email = email;
  CONFIG.google.password = password;
  CONFIG.productUrl = productUrl;
  CONFIG.orderTime = saved.orderTime;

  console.log('\n✅ 設定完成(已存到 config.json,下次可直接按 Enter 沿用)');
  if (orderTime.getTime() < Date.now()) {
    console.log('ℹ️  注意:搶購時間已是過去時間,將立刻開始搶購流程!');
  }
  console.log('');
}

/** 發生致命錯誤時暫停,讓「點兩下執行」的使用者看得到錯誤訊息再關窗 */
async function pauseBeforeExit() {
  await ask('\n(按 Enter 鍵結束程式)');
  process.exit(1);
}

/**
 * 等待直到 wakeEpochMs(毫秒時間戳)。
 * 倒數顯示以 displayTargetMs(預設同 wakeEpochMs)為準,
 * 讓「分段等待」時畫面仍顯示距離真正開賣的時間。
 */
function waitUntilEpoch(wakeEpochMs, displayTargetMs = wakeEpochMs) {
  return new Promise((resolve) => {
    const tick = () => {
      const remaining = wakeEpochMs - Date.now();
      if (remaining <= 0) return resolve();
      const show = Math.max(displayTargetMs - Date.now(), 0);
      const h = Math.floor(show / 3600000);
      const m = Math.floor((show % 3600000) / 60000);
      const s = Math.floor((show % 60000) / 1000);
      process.stdout.write(`\r⏳ 距離下單時間還有 ${h}時${m}分${s}秒   `);
      setTimeout(tick, remaining > 1000 ? 1000 : 10);
    };
    tick();
  });
}

/**
 * 在頁面上尋找「文字包含 texts 之一」的可見按鈕並點擊。
 * momo 是動態渲染、class 名稱不固定,用文字比對最穩。
 */
async function clickByText(page, texts, { timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate((texts) => {
      const candidates = [
        ...document.querySelectorAll(
          'button, a, [role="button"], input[type="button"], input[type="submit"]'
        ),
      ];
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      for (const t of texts) {
        const el = candidates.find((n) => {
          const label = ((n.innerText || n.value || '') + '').replace(/\s+/g, '');
          return label.includes(t) && isVisible(n) && !n.disabled;
        });
        if (el) {
          el.scrollIntoView({ block: 'center' });
          el.click();
          return t;
        }
      }
      return null;
    }, texts);
    if (clicked) return clicked;
    await sleep(200);
  }
  throw new Error(`找不到可點擊的按鈕:${texts.join(' / ')}`);
}

/** 判斷 momo 是否已登入(看頁面上有沒有「登入」的連結) */
async function isLoggedIn(page) {
  await page.goto(CONFIG.homeUrl, { waitUntil: 'domcontentloaded' });
  await sleep(2500); // 等 header 動態渲染完成
  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a, button, span')];
    const hasLoginEntry = links.some((el) => {
      const t = (el.innerText || '').replace(/\s+/g, '');
      return t === '登入' || t === '登入/註冊' || t === '會員登入';
    });
    return !hasLoginEntry;
  });
}

/**
 * 驗證「交易 session」是否有效:直接開購物車頁(交易網域),
 * 若被要求登入(出現登入 iframe 或「請先登入」字樣)代表交易 session 失效。
 * 這比看首頁 header 準——SCS076 的教訓:顯示層登入 ≠ 交易層登入。
 */
async function verifyCartSession(page) {
  try {
    await page.goto('https://cart.momoshop.com.tw/view/cart/WEB/newNormal', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
  } catch {
    return false;
  }
  await sleep(2500); // 等動態內容渲染
  const loginFrame = page
    .frames()
    .some((fr) => fr.url().includes('account.momoshop.com.tw'));
  const loginText = await page
    .evaluate(() => /請先登入|SCS076|會員登入/.test(document.body.innerText))
    .catch(() => false);
  return !(loginFrame || loginText);
}

/** 診斷用:截圖登入頁,並列出頁面(含 iframe)上所有可點擊元素的文字 */
async function debugDumpLoginPage(page, screenshotPath) {
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log('🖼️  已截圖登入頁:', screenshotPath);
  } catch (e) {
    console.log('(截圖失敗:', e.message, ')');
  }
  for (const frame of page.frames()) {
    try {
      const texts = await frame.evaluate(() => {
        const els = [
          ...document.querySelectorAll('a, button, [role="button"], [onclick]'),
        ];
        return els
          .map((el) => (el.innerText || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim())
          .filter((t) => t && t.length < 40);
      });
      console.log(`   frame: ${frame.url().slice(0, 100)}`);
      console.log(`   可點擊元素: ${JSON.stringify([...new Set(texts)])}`);
    } catch {
      /* 跨域 iframe 無法讀取,略過 */
    }
  }
}

/** 等待 momo 登入彈窗的 iframe(account.momoshop.com.tw)出現 */
async function getAccountFrame(page, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const f = page
      .frames()
      .find((fr) => fr.url().includes('account.momoshop.com.tw'));
    if (f) return f;
    await sleep(300);
  }
  return null;
}

/**
 * momo 的登入流程:點頁面上方「登入」→ 出現登入彈窗(iframe)→ 點「Google 登入」
 */
async function clickGoogleLoginButton(page) {
  // 步驟 1:點主頁面上的「登入」,打開登入彈窗
  try {
    await clickByText(page, ['登入'], { timeout: 5000 });
    console.log('🖱️  已點擊「登入」,等待登入彈窗...');
  } catch {
    console.log('ℹ️  找不到「登入」入口,可能彈窗已經開啟,直接找 Google 按鈕...');
  }
  await sleep(1500);

  // 步驟 2:在登入彈窗的 iframe 裡找「Google 登入」
  const frame = await getAccountFrame(page);
  if (!frame) throw new Error('等不到登入彈窗(account.momoshop.com.tw iframe)');

  const deadline = Date.now() + 15000;
  let dumped = false;
  while (Date.now() < deadline) {
    let clicked = false;
    try {
      // 診斷:第一次先列出彈窗內所有帶有第三方登入線索的元素
      if (!dumped) {
        dumped = true;
        const clues = await frame.evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll('*')) {
            const info = [
              el.getAttribute && el.getAttribute('alt'),
              el.getAttribute && el.getAttribute('aria-label'),
              el.getAttribute && el.getAttribute('title'),
              el.src,
              typeof el.className === 'string' ? el.className : '',
              el.children.length === 0 ? el.textContent : '',
            ].join(' ');
            if (/google|line|apple|facebook|快速登入/i.test(info)) {
              out.push(
                `<${el.tagName.toLowerCase()}> ${info.replace(/\s+/g, ' ').trim().slice(0, 120)}`
              );
            }
          }
          return out.slice(0, 30);
        });
        console.log('🔎 彈窗內第三方登入相關元素:');
        clues.forEach((c) => console.log('   ', c));
      }

      clicked = await frame.evaluate(() => {
        const match = (s) => /google/i.test(s || '');
        const els = [...document.querySelectorAll('*')];
        // 優先:文字就是 Google(登入)的小元素
        let target = els.find((el) => {
          const t = (el.textContent || '').replace(/\s+/g, '');
          return t && t.length <= 12 && match(t) && el.children.length <= 2;
        });
        // 其次:alt / aria-label / title / 圖片網址 / class 帶 google 字樣
        if (!target) {
          target = els.find(
            (el) =>
              match(el.getAttribute && el.getAttribute('alt')) ||
              match(el.getAttribute && el.getAttribute('aria-label')) ||
              match(el.getAttribute && el.getAttribute('title')) ||
              match(el.src) ||
              match(typeof el.className === 'string' ? el.className : '')
          );
        }
        if (!target) return false;
        const clickable =
          target.closest('a, button, [role="button"], [onclick]') || target;
        clickable.click();
        return true;
      });
    } catch {
      /* iframe 重新載入中,略過重試 */
    }
    if (clicked) {
      console.log('✅ 已點擊登入彈窗中的 Google 登入');
      return;
    }
    await sleep(500);
  }
  throw new Error('在登入彈窗中找不到 Google 登入按鈕');
}

/**
 * 單次掃描所有視窗的所有 frame,找出第一個「可見的」符合 selectors 的輸入框。
 * 回傳 { frame, page, selector },找不到回傳 null(不等待,立即回傳)。
 */
async function scanInputOnce(browser, selectors) {
  for (const p of await browser.pages()) {
    for (const f of p.frames()) {
      for (const sel of selectors) {
        try {
          const h = await f.$(sel);
          if (!h) continue;
          const visible = await h.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && !el.disabled;
          });
          if (visible) return { frame: f, page: p, selector: sel };
        } catch {
          /* frame 載入中/已卸載,略過 */
        }
      }
    }
  }
  return null;
}

/** 在 frame 裡點「下一步」;找不到就改按 Enter */
async function clickNextInFrame(frame, page) {
  const clicked = await frame
    .evaluate(() => {
      const btns = [
        ...document.querySelectorAll('button, [role="button"], input[type="submit"]'),
      ];
      const el = btns.find((b) =>
        /下一步|next|繼續|continue|登入|sign in/i.test(
          (b.innerText || b.value || '').trim()
        )
      );
      if (el) {
        el.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
  if (!clicked) await page.keyboard.press('Enter');
}

/** 診斷:截圖目前所有 Google 相關視窗 */
async function debugShotGooglePages(browser) {
  let i = 0;
  for (const p of await browser.pages()) {
    if (!/google/i.test(p.url())) continue;
    const shot = path.join(BASE_DIR, `google-page-debug-${i++}.png`);
    try {
      await p.screenshot({ path: shot });
      console.log('🖼️  Google 視窗截圖:', shot, '| URL:', p.url().slice(0, 100));
    } catch {
      /* ignore */
    }
  }
}

/**
 * 處理 Google 登入 —— 狀態機:每 0.5 秒看一次目前畫面,出現什麼就處理什麼。
 * 涵蓋四種情況:
 *   A. 帳號選擇畫面(已有 Google session)→ 點選帳號,免填帳密
 *   B. email 輸入框 → 填帳號按下一步
 *   C. 密碼輸入框 → 填密碼送出
 *   D. 授權「繼續」畫面 → 點繼續
 * 完成判斷:Google 視窗全部關閉,或 momo 登入彈窗消失(= 免輸入直接登入成功)。
 */
async function doGoogleLogin(browser, page) {
  console.log('🔐 處理 Google 登入(自動判斷:免輸入/選帳號/填帳密)...');
  const deadline = Date.now() + 90000;
  let sawGooglePage = false;
  let emailDone = false;
  let pwdDone = false;

  while (Date.now() < deadline) {
    const modalOpen = page
      .frames()
      .some((fr) => fr.url().includes('account.momoshop.com.tw'));
    const googlePages = (await browser.pages()).filter((p) =>
      /accounts\.google/.test(p.url())
    );
    if (googlePages.length > 0) sawGooglePage = true;

    // 完成判斷 1:Google 視窗開過且已全部關閉、momo 登入彈窗也消失
    if (sawGooglePage && googlePages.length === 0 && !modalOpen) {
      console.log('✅ Google 視窗與登入彈窗都已關閉,登入完成');
      return;
    }

    // 完成判斷 2(不依賴「有沒有看到 Google 視窗」):
    // 免輸入的秒速登入可能快到 Google 視窗來不及被輪詢到,
    // 所以只要「登入彈窗消失 + 沒有 Google 視窗」,就直接檢查目前頁面是否已登入。
    if (!modalOpen && googlePages.length === 0) {
      const loggedIn = await page
        .evaluate(() => {
          const els = [...document.querySelectorAll('a, button, span')];
          return !els.some((el) => {
            const t = (el.innerText || '').replace(/\s+/g, '');
            return t === '登入' || t === '登入/註冊' || t === '會員登入';
          });
        })
        .catch(() => false);
      if (loggedIn) {
        console.log('✅ 已偵測到登入完成(快速登入,未經過帳密輸入)');
        return;
      }
    }

    // 情況 A:帳號選擇畫面 → 點選既有帳號(優先選 CONFIG 裡的帳號)
    let acted = false;
    try {
      for (const p of googlePages) {
        for (const f of p.frames()) {
          const r = await f
            .evaluate((email) => {
              const exact = document.querySelector(
                `[data-identifier="${email}"]`
              );
              const any = exact || document.querySelector('[data-identifier]');
              if (any) {
                any.click();
                return true;
              }
              return false;
            }, CONFIG.google.email)
            .catch(() => false);
          if (r) {
            console.log('👤 出現帳號選擇畫面,已點選帳號(免填帳密)');
            acted = true;
            break;
          }
        }
        if (acted) break;
      }
    } catch {
      /* Google 視窗正在關閉,frame 已銷毀 —— 下一輪的完成判斷會接手 */
    }
    if (acted) {
      await sleep(1500);
      continue;
    }

    // 情況 B:email 輸入框
    if (!emailDone) {
      const t = await scanInputOnce(browser, [
        'input#identifierId',
        'input[type="email"]',
        'input[name="identifier"]',
      ]);
      if (t) {
        console.log(`📧 填入帳號(${t.selector})...`);
        await t.frame.click(t.selector).catch(() => {});
        await t.frame.type(t.selector, CONFIG.google.email, { delay: 60 });
        await clickNextInFrame(t.frame, t.page);
        emailDone = true;
        await sleep(1000);
        continue;
      }
    }

    // 情況 C:密碼輸入框
    if (!pwdDone) {
      const t = await scanInputOnce(browser, [
        'input[name="Passwd"]',
        'input[type="password"]',
      ]);
      if (t) {
        await sleep(800); // 等密碼欄動畫結束,避免打字被吃掉
        console.log(`🔑 填入密碼(${t.selector})...`);
        await t.frame.click(t.selector).catch(() => {});
        await t.frame.type(t.selector, CONFIG.google.password, { delay: 60 });
        await clickNextInFrame(t.frame, t.page);
        pwdDone = true;
        console.log('📨 已送出密碼,等待 Google 驗證...');
        await sleep(1000);
        continue;
      }
    }

    // 情況 D:授權/確認畫面 → 點「繼續」
    try {
      for (const p of googlePages) {
        let cont = false;
        for (const f of p.frames()) {
          cont = await f
            .evaluate(() => {
              const btns = [
                ...document.querySelectorAll('button, [role="button"]'),
              ];
              const el = btns.find((b) =>
                /^(繼續|Continue)$/.test((b.innerText || '').trim())
              );
              if (el) {
                el.click();
                return true;
              }
              return false;
            })
            .catch(() => false);
          if (cont) {
            console.log('▶️  已點擊「繼續」');
            break;
          }
        }
        if (cont) break;
      }
    } catch {
      /* Google 視窗正在關閉(登入完成的瞬間),frame 已銷毀 —— 下一輪的完成判斷會接手 */
    }

    await sleep(500);
  }

  await debugShotGooglePages(browser);
  throw new Error('Google 登入流程逾時(90 秒),已截圖供診斷');
}

/** 清除所有 momo 網域的 cookies(處理「頁面看似登入、交易 session 卻失效」的狀況) */
async function clearMomoCookies(page) {
  const client = await page.target().createCDPSession();
  const { cookies } = await client.send('Network.getAllCookies');
  const momoCookies = cookies.filter((c) =>
    c.domain.includes('momoshop.com.tw')
  );
  for (const c of momoCookies) {
    await client.send('Network.deleteCookies', {
      name: c.name,
      domain: c.domain,
      path: c.path,
    });
  }
  await client.detach();
  console.log(`🧹 已清除 ${momoCookies.length} 個 momo cookies`);
}

/** 完整登入流程:嘗試 Google 自動登入,失敗則等待手動登入 */
async function ensureLoggedIn(browser, page, { force = false } = {}) {
  if (!force) {
    console.log('🔍 檢查登入狀態...');
    if (await isLoggedIn(page)) {
      console.log('✅ 已是登入狀態(沿用上次的登入資料)');
      return;
    }
  }

  console.log('➡️  尚未登入,開啟登入頁...');
  await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle2' });
  await sleep(2000); // 等動態內容渲染

  // 診斷:截圖 + 列出登入頁上的可點擊元素
  await debugDumpLoginPage(
    page,
    path.join(BASE_DIR, 'login-page-debug.png')
  );

  try {
    console.log('🖱️  點擊 Google 登入...');
    await clickGoogleLoginButton(page);

    await doGoogleLogin(browser, page);
    console.log('⌛ 等待登入完成...');
  } catch (err) {
    console.log(`⚠️  自動登入未成功:${err.message} 你手動按或是重開吧傻逼`);
  }

  // 被動等待登入完成:不主動導航頁面,以免打斷登入流程(含手動登入/兩步驟驗證)。
  // 判斷方式:登入彈窗 iframe 消失、且不在 Google 登入頁 → 主動確認一次登入狀態。
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      // 任何一個視窗還在 Google 登入頁(含兩步驟驗證)→ 繼續等
      const allPages = await browser.pages();
      if (allPages.some((p) => p.url().includes('accounts.google.com'))) {
        continue;
      }

      // 登入彈窗還開著(使用者可能正在輸入)→ 不要動頁面
      const modalStillOpen = page
        .frames()
        .some((fr) => fr.url().includes('account.momoshop.com.tw'));
      if (modalStillOpen) continue;

      // 彈窗已關閉 → 主動確認登入狀態
      if (await isLoggedIn(page)) {
        console.log('✅ 登入成功!狀態已保存至', CONFIG.userDataDir);
        return;
      }
      // 沒登入成功,回到登入頁重新等待
      console.log('ℹ️  尚未偵測到登入成功,返回登入頁繼續等待...');
      await page.goto(CONFIG.loginUrl, { waitUntil: 'domcontentloaded' });
    } catch {
      /* 頁面跳轉中,忽略,下一輪再檢查 */
    }
  }
  throw new Error('等待登入逾時(10 分鐘),請重新執行腳本再試一次');
}

/**
 * 在頁面裡安裝「直接購買一出現就立刻點」的觀察器(MutationObserver)。
 * 高流量時頁面會轉很久、按鈕不知何時才蹦出來 —— 用 Node 端輪詢最壞要慢 250ms,
 * 而 MutationObserver 在按鈕被渲染出來的「同一個瞬間」就會在瀏覽器內部直接點下去,零輪詢延遲。
 * 用 evaluateOnNewDocument 註冊:之後每次 reload 都自動重新生效。
 * 只在「商品頁」作用(比對網址路徑),避免登入流程或結帳頁誤點。
 */
async function armInstantBuyClicker(page) {
  await page.evaluateOnNewDocument(
    (texts, targetPath) => {
      // 只在商品頁啟動(reload 後的每個新文件都會跑到這裡)
      if (!location.hostname.endsWith('momoshop.com.tw')) return;
      if (targetPath && location.pathname !== targetPath) return;

      const tryClick = () => {
        if (window.__buyClickedAt) return true;
        const candidates = document.querySelectorAll(
          'button, a, [role="button"], input[type="button"], input[type="submit"]'
        );
        for (const t of texts) {
          for (const n of candidates) {
            const label = ((n.innerText || n.value || '') + '').replace(/\s+/g, '');
            if (!label.includes(t) || n.disabled) continue;
            const r = n.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            n.click();
            window.__buyClickedAt = Date.now(); // 讓 Node 端知道已經點下去了
            if (window.__buyObserver) window.__buyObserver.disconnect();
            return true;
          }
        }
        return false;
      };

      // DOM 每長出/改變任何東西就立刻檢查一次(涵蓋「轉圈圈轉到第 57 秒突然出現按鈕」)
      window.__buyObserver = new MutationObserver(tryClick);
      window.__buyObserver.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'disabled', 'hidden'],
      });
      tryClick();
    },
    CONFIG.buttons.buy,
    (() => {
      try {
        return new URL(CONFIG.productUrl).pathname;
      } catch {
        return '';
      }
    })()
  );
  console.log('⚡ 已安裝「直接購買」瞬間點擊觀察器(按鈕一渲染出來就會立刻點下)');
}

/** 單次嘗試:在目前頁面上找「直接購買」並點擊(立即回傳,不等待) */
async function tryClickBuyOnce(page) {
  return page
    .evaluate((texts) => {
      // 頁面內的瞬間點擊觀察器已經搶先點過了 → 直接回報成功
      if (window.__buyClickedAt) return true;
      const candidates = [
        ...document.querySelectorAll(
          'button, a, [role="button"], input[type="button"], input[type="submit"]'
        ),
      ];
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      for (const t of texts) {
        const el = candidates.find((n) => {
          const label = ((n.innerText || n.value || '') + '').replace(/\s+/g, '');
          return label.includes(t) && isVisible(n) && !n.disabled;
        });
        if (el) {
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        }
      }
      return false;
    }, CONFIG.buttons.buy)
    .catch(() => false); // 頁面導航中 evaluate 會失敗,視為沒點到
}

/**
 * 在商品頁等「直接購買」出現並點擊。
 * 防誤判:人潮多時頁面會很慢,所以——
 *  - 按鈕隨時出現就立刻點,不用等頁面載完
 *  - 「頁面已完整載入」後再多等 renderedWaitMs,仍沒按鈕才判定目前買不到
 *  - 頁面一直載不完,最多等 slowLoadMaxMs 才放棄這一輪
 */
async function waitAndClickBuy(page) {
  const { renderedWaitMs, slowLoadMaxMs } = CONFIG.buttonPoll;
  const start = Date.now();
  let completeAt = null;

  while (true) {
    if (await tryClickBuyOnce(page)) return true;

    const state = await page
      .evaluate(() => document.readyState)
      .catch(() => 'loading');
    const now = Date.now();
    if (state === 'complete' && !completeAt) completeAt = now;

    if (completeAt && now - completeAt > renderedWaitMs) return false;
    if (now - start > slowLoadMaxMs) return false;

    // 備援輪詢(頁面內的 MutationObserver 才是主力,這裡只是保險)
    await sleep(100);
  }
}

/**
 * 開第二個「已登入」的瀏覽器視窗:同一個 Chrome、同一個 profile,
 * cookies 完全共用,所以開起來就是登入狀態,不用(也不能)再登入一次。
 * 網址加上無害的 __w=2 參數以便辨識(pathname 不變,瞬間點擊觀察器照常作用)。
 */
async function openSecondWindow(browser, url) {
  const url2 = url + (url.includes('?') ? '&' : '?') + '__w=2';
  try {
    const cdp = await browser.target().createCDPSession();
    const { targetId } = await cdp.send('Target.createTarget', {
      url: url2,
      newWindow: true, // 開成獨立視窗(不是分頁),避免背景分頁被 Chrome 降速
    });
    await cdp.detach().catch(() => {});
    const target = await browser.waitForTarget(
      (t) => t.url().includes('__w=2'),
      { timeout: 15000 }
    );
    const p = await target.page();
    if (p) return p;
    throw new Error(`拿不到新視窗的分頁物件(targetId: ${targetId})`);
  } catch (e) {
    console.log('⚠️  開獨立視窗失敗,改用新分頁代替:', e.message);
    const p = await browser.newPage();
    await p.goto(url2, { waitUntil: 'domcontentloaded' }).catch(() => {});
    return p;
  }
}

// 任一視窗搶購成功後設為 true,通知其他視窗的搶購迴圈收手
let snipeDone = false;

// 重新登入互斥鎖:雙視窗同時遇到 SCS076 時,只讓一個視窗執行重登,另一個等它完成
let reloginPromise = null;

/** 搶購主迴圈:reload → 點「直接購買」→ 確認點擊生效,直到成功為止 */
async function snipeBuy(browser, page, label = '') {
  // 關鍵:先在頁面裡裝好「一出現就點」的觀察器,之後每次 reload 都自動生效
  await armInstantBuyClicker(page);
  for (let attempt = 1; ; attempt++) {
    if (snipeDone) return false; // 另一個視窗已經搶到,這個迴圈收手
    console.log(`\n🛒 ${label}第 ${attempt} 次嘗試(重新整理商品頁)...`);
    try {
      await page.goto(CONFIG.productUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
    } catch (err) {
      // 載入逾時不代表沒救,頁面可能已經渲染一半 → 照樣試著找按鈕
      console.log(`⚠️  頁面載入逾時,直接在現有頁面上找按鈕...`);
    }

    // 特例:觀察器可能在載入途中就點到「直接購買」並已跳轉(此時已在購物車/結帳頁)
    const alreadyThere = await page
      .evaluate(() => /前往結帳|購物車明細/.test(document.body.innerText))
      .catch(() => false);
    if (alreadyThere) {
      snipeDone = true;
      console.log(`\n🎉 ${label}「直接購買」已在頁面載入途中被瞬間點擊!(目前頁面:${page.url().slice(0, 100)})`);
      console.log('   腳本到此收手,接下來請手動完成結帳。');
      return true;
    }

    const urlBefore = page.url();
    const pagesBefore = (await browser.pages()).map((p) => p.url());

    const clicked = await waitAndClickBuy(page);
    if (!clicked) {
      console.log('   「直接購買」尚未出現,重新整理再試...');
      await sleep(CONFIG.buttonPoll.reloadDelayMs);
      continue;
    }
    console.log('✅ 已點擊「直接購買」,確認是否生效...');

    // 確認點擊真的有效:原分頁跳轉、出現購物車內容,或「開了新分頁」都算成功
    const deadline = Date.now() + 10000;
    let confirmed = false;
    let needRelogin = false;
    let where = '';
    while (Date.now() < deadline) {
      await sleep(300);

      // 特例:momo 回報「請先登入」(SCS076)= 交易 session 失效,需重新登入
      const loginRequired = await page
        .evaluate(() =>
          /SCS076|請先登入|限momo會員購買/.test(document.body.innerText)
        )
        .catch(() => false);
      if (loginRequired) {
        needRelogin = true;
        break;
      }

      if (page.url() !== urlBefore) {
        confirmed = true;
        where = `原分頁跳轉 → ${page.url().slice(0, 100)}`;
        break;
      }
      const pagesNow = await browser.pages();
      const newPage = pagesNow.find((p) => !pagesBefore.includes(p.url()));
      if (newPage) {
        confirmed = true;
        where = `開啟新分頁 → ${newPage.url().slice(0, 100)}`;
        break;
      }
      const marker = await page
        .evaluate(() => /前往結帳|購物車明細/.test(document.body.innerText))
        .catch(() => false);
      if (marker) {
        confirmed = true;
        where = '原分頁出現購物車內容';
        break;
      }
    }

    if (needRelogin) {
      console.log(`\n🔁 ${label}momo 回報「請先登入」(SCS076)—— 交易 session 已失效。`);
      if (reloginPromise) {
        // 另一個視窗已經在重登了(cookies 是共用的,重登一次兩個視窗都會恢復)
        console.log('   另一個視窗正在重新登入,等待它完成後繼續搶購...');
        await reloginPromise.catch(() => {});
      } else {
        console.log('   自動處理:清除 momo cookies → 重新登入 → 繼續搶購...');
        reloginPromise = (async () => {
          await clearMomoCookies(page);
          await ensureLoggedIn(browser, page, { force: true });
        })();
        try {
          await reloginPromise;
        } finally {
          reloginPromise = null;
        }
      }
      continue; // 重新登入完成,回到搶購迴圈
    }

    if (confirmed) {
      snipeDone = true;
      console.log(`\n🎉 ${label}「直接購買」點擊成功!(${where})`);
      console.log('   腳本到此收手,接下來請手動完成結帳。');
      return true;
    }

    // 失敗診斷:截圖 + 印出目前所有分頁與頁面線索
    console.log('⚠️  點了但偵測不到任何反應,收集診斷資訊...');
    const shot = path.join(BASE_DIR, `buy-debug-${attempt}.png`);
    try {
      await page.screenshot({ path: shot });
      console.log('🖼️  截圖:', shot);
    } catch {
      /* ignore */
    }
    const allUrls = (await browser.pages()).map((p) => p.url().slice(0, 100));
    console.log('📑 目前所有分頁:', JSON.stringify(allUrls, null, 2));
    console.log('   重新整理再試...');
  }
}

async function main() {
  // 啟動問答:帳密 / 商品網址 / 搶購時間(存 config.json,下次 Enter 沿用)
  await loadOrAskConfig();

  // 每次執行都清空瀏覽器資料:不留任何舊 session,
  // 強制走「輸入帳密」的完整 Google 登入(最穩定、也確保交易 session 全新)
  console.log('🧹 清空瀏覽器資料(browser-data),本次將全新登入...');
  fs.rmSync(CONFIG.userDataDir, { recursive: true, force: true });

  console.log('🚀 啟動瀏覽器(使用電腦上已安裝的 Google Chrome)...');
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false, // 一定要顯示視窗:方便確認流程與手動結帳
      channel: 'chrome', // 使用系統安裝的 Google Chrome(打包版不自帶瀏覽器)
      userDataDir: CONFIG.userDataDir,
      defaultViewport: null,
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  } catch (err) {
    console.error('\n💥 無法啟動 Chrome:', err.message);
    console.error('   請確認電腦已安裝 Google Chrome(https://www.google.com/chrome/)後再試一次。');
    return pauseBeforeExit();
  }

  const page = (await browser.pages())[0] || (await browser.newPage());

  try {
    // 步驟 1:全新登入(browser-data 已清空,必定走「輸入帳密」的完整流程)
    await ensureLoggedIn(browser, page, { force: true });

    // 測試模式:登入完成後停在商品頁,不往下執行
    if (CONFIG.stopAfterLogin) {
      await page.goto(CONFIG.productUrl, { waitUntil: 'domcontentloaded' });
      console.log('\n🧪 測試模式:已登入並停留在商品頁,不執行購買。');
      console.log('   確認沒問題後,把 CONFIG.stopAfterLogin 改成 false 即可跑完整流程。');
      console.log('\n(瀏覽器保持開啟,按 Ctrl+C 結束程式)');
      return;
    }

    // 步驟 2:驗證「交易 session」真的有效(開購物車頁實測,不是只看首頁 header)
    for (let i = 1; i <= 2; i++) {
      if (await verifyCartSession(page)) {
        console.log('✅ 交易 session 驗證通過(購物車頁可正常存取)');
        break;
      }
      console.log(`⚠️  交易 session 驗證失敗,重新登入(第 ${i} 次)...`);
      await clearMomoCookies(page);
      await ensureLoggedIn(browser, page, { force: true });
    }

    // 步驟 3:前往商品頁停留,倒數等待下單時間
    await page.goto(CONFIG.productUrl, { waitUntil: 'domcontentloaded' });

    // 步驟 3.5:登入就緒後,再開第二個視窗(共用登入狀態,不用重新登入)
    let page2 = null;
    if (CONFIG.dualWindow) {
      console.log('\n🪟 登入就緒,開啟第二個視窗(共用同一個登入 session)...');
      page2 = await openSecondWindow(browser, CONFIG.productUrl);
      console.log('✅ 第二個視窗已開啟並停在商品頁,兩個視窗將同時搶購');
    }

    console.log(`\n📅 已停在商品頁,預定下單時間:${CONFIG.orderTime}`);
    await waitUntilEpoch(
      new Date(CONFIG.orderTime).getTime() - CONFIG.earlyOffsetMs
    );
    console.log('\n⏰ 時間到!開始搶購!');

    // 步驟 4:reload → 點「直接購買」→ 成功後交還手動操作
    // 雙視窗:兩個搶購迴圈同時跑,誰先點到誰贏;任一個成功另一個自動收手。
    // Promise.any:一個視窗出錯(例如重登逾時)不會拖垮另一個。
    if (page2) {
      await Promise.any([
        snipeBuy(browser, page, '[視窗1] '),
        snipeBuy(browser, page2, '[視窗2] '),
      ]);
    } else {
      await snipeBuy(browser, page);
    }
  } catch (err) {
    console.error('\n💥 發生錯誤:', err.message);
    return pauseBeforeExit();
  }

  console.log('\n(瀏覽器保持開啟以便確認,關閉此視窗或按 Ctrl+C 結束程式)');
}

main().catch(async (err) => {
  console.error('\n💥 程式發生未預期的錯誤:', err.message);
  await pauseBeforeExit();
});
