/**
 * fetch-by-douyin-id.js
 *
 * 通过抖音号/账号名自动获取博主视频并通过 Get笔记 解析
 *
 * 工作流：打开抖音首页 -> 搜索框搜索账号 -> 点击博主卡片 -> 提取视频 -> Get笔记解析
 *
 * 包含高级反检测措施，保护账号安全
 *
 * 用法:
 *   node fetch-by-douyin-id.js <douyin_id> [options]
 *
 *   参数:
 *   <douyin_id>          抖音号、账号名、或主页链接中的ID
 *
 *   选项:
 *   --limit=<N>           只获取最近 N 条视频 (默认: 10)
 *   --days=<N>            只获取最近 N 天内的视频
 *   --date=<YYYY-MM-DD>   获取指定日期及之后的视频
 *   --min-likes=<N>       只获取点赞数 >= N 的视频
 *   --sort-by=<date|likes> 按日期或点赞数排序
 *   --sort-order=<asc|desc> 升序或降序 (默认: desc)
 *   --skip-existing       跳过已有笔记的视频 (默认: true)
 *   --no-skip             不跳过已处理视频
 *   --alt-profile          使用备用 Chrome Profile (避免与主浏览器冲突)
 *   --dry                 预览模式
 *
 * 示例:
 *   node fetch-by-douyin-id.js MS4wLjABAAAAxxx --limit=20
 *   node fetch-by-douyin-id.js 姜胡说 --days=30
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// 反检测插件
let stealthPlugin;
try {
  stealthPlugin = require('puppeteer-extra-plugin-stealth')();
} catch (e) {
  console.log('注意: puppeteer-extra-plugin-stealth 未安装，反检测功能受限');
}

// 复用 fetch-douyin-via-biji.js 的核心功能
const { fetchDouyinNote } = require('./fetch-douyin-via-biji.js');

const DEFAULT_CHROME_PROFILE = path.join(
  process.env.LOCALAPPDATA || '',
  'Google',
  'Chrome',
  'User Data',
  'Default'
);

// 关闭可能占用 Chrome profile 的进程
function closeChromeProcesses() {
  const { execSync } = require('child_process');
  try {
    // 更彻底地杀死 Chrome 进程
    execSync('taskkill /F /IM chrome.exe 2>nul', { stdio: 'ignore' });
    execSync('taskkill /F /IM chromedriver.exe 2>nul', { stdio: 'ignore' });
    const { setTimeout: sleep } = require('timers/promises');
    sleep(3000); // 等待 3 秒让 profile lock 释放
  } catch (e) {}
}

// 获取备用 Chrome profile 路径（用于避免与主 Chrome 冲突）
function getAltChromeProfile() {
  const appData = process.env.LOCALAPPDATA || '';
  return path.join(appData, 'Google', 'Chrome', 'User Data', 'Profile 2');
}

// 获取临时 Chrome profile 路径（固定的临时目录，用于保持登录状态）
function getTempChromeProfile() {
  const appData = process.env.LOCALAPPDATA || '';
  return path.join(appData, 'Google', 'Chrome', 'User Data', 'DouyinScraper');
}

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    douyinId: null,
    url: null,          // 直接访问的URL
    limit: 0,           // 0 = 获取所有视频
    days: null,
    date: null,
    minLikes: 0,
    skipExisting: true,
    dry: false,
    profile: null,
    sortBy: null,      // 'date' | 'likes'
    sortOrder: 'desc' // 'asc' | 'desc'
  };

  for (const arg of args) {
    if (arg.startsWith('--limit=')) {
      options.limit = parseInt(arg.replace('--limit=', ''), 10);
    } else if (arg.startsWith('--days=')) {
      options.days = parseInt(arg.replace('--days=', ''), 10);
    } else if (arg.startsWith('--date=')) {
      options.date = arg.replace('--date=', '');
    } else if (arg.startsWith('--min-likes=')) {
      options.minLikes = parseInt(arg.replace('--min-likes=', ''), 10);
    } else if (arg.startsWith('--sort-by=')) {
      const val = arg.replace('--sort-by=', '').toLowerCase();
      if (['date', 'likes'].includes(val)) {
        options.sortBy = val;
      }
    } else if (arg.startsWith('--sort-order=')) {
      const val = arg.replace('--sort-order=', '').toLowerCase();
      if (['asc', 'desc'].includes(val)) {
        options.sortOrder = val;
      }
    } else if (arg === '--skip-existing') {
      options.skipExisting = true;
    } else if (arg === '--no-skip') {
      options.skipExisting = false;
    } else if (arg === '--dry') {
      options.dry = true;
    } else if (arg === '--alt-profile' || arg === '--alt') {
      options.profile = getAltChromeProfile();
    } else if (arg === '--temp-profile') {
      options.profile = getTempChromeProfile();
    } else if (arg.startsWith('--profile=')) {
      options.profile = arg.replace('--profile=', '');
    } else if (arg.startsWith('--url=')) {
      options.url = arg.replace('--url=', '');
    } else if (!arg.startsWith('--') && !options.douyinId) {
      options.douyinId = arg;
    }
  }

  return options;
}

// 检测短链接重定向
function resolveShortUrl(shortUrl) {
  return new Promise((resolve, reject) => {
    const protocol = shortUrl.startsWith('https') ? https : http;
    const urlObj = new URL(shortUrl);

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    const req = protocol.request(options, (res) => {
      if (res.headers.location) {
        resolve(res.headers.location);
      } else {
        resolve(shortUrl);
      }
    });

    req.on('error', reject);
    req.end();
  });
}

// 加载已处理记录
function loadProcessedState() {
  const stateFile = path.join(__dirname, 'raw', 'get笔记', '.douyin-id-processed.json');
  try {
    if (fs.existsSync(stateFile)) {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return {
        processedUrls: new Set(data.processedUrls || []),
        processedVideoIds: new Set(data.processedVideoIds || [])
      };
    }
  } catch (e) {}
  return { processedUrls: new Set(), processedVideoIds: new Set() };
}

// 保存已处理记录
function saveProcessedState(state) {
  const stateFile = path.join(__dirname, 'raw', 'get笔记', '.douyin-id-processed.json');
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      processedUrls: Array.from(state.processedUrls),
      processedVideoIds: Array.from(state.processedVideoIds),
      lastUpdate: new Date().toISOString()
    }, null, 2), 'utf8');
  } catch (e) {}
}

// 随机延迟（模拟人类行为）
async function randomDelay(min = 1000, max = 3000) {
  const delay = Math.floor(Math.random() * (max - min)) + min;
  await new Promise(r => setTimeout(r, delay));
}

// 检查页面是否仍然活跃（未被关闭）
async function safePageAlive(page) {
  try {
    if (!page || page.isClosed()) return false;
    await page.title(); // 尝试获取标题以确认页面可用
    return true;
  } catch (e) {
    return false;
  }
}

// 解析相对日期文本为实际日期字符串
// 支持: "3天前", "1周前", "2月前", "1年前", "刚刚", "今天"
function parseRelativeDate(text) {
  if (!text) return '';
  const now = new Date();

  // 刚刚/今天
  if (text.includes('刚刚') || text.includes('今天') || text.includes('方才')) {
    return now.toISOString().substring(0, 10);
  }

  // 分钟前
  const minMatch = text.match(/(\d+)\s*分钟前/);
  if (minMatch) {
    const mins = parseInt(minMatch[1]);
    const date = new Date(now.getTime() - mins * 60 * 1000);
    return date.toISOString().substring(0, 10);
  }

  // 小时前
  const hourMatch = text.match(/(\d+)\s*小时前/);
  if (hourMatch) {
    const hours = parseInt(hourMatch[1]);
    const date = new Date(now.getTime() - hours * 60 * 60 * 1000);
    return date.toISOString().substring(0, 10);
  }

  // 天前
  const dayMatch = text.match(/(\d+)\s*天前/);
  if (dayMatch) {
    const days = parseInt(dayMatch[1]);
    const date = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return date.toISOString().substring(0, 10);
  }

  // 周前
  const weekMatch = text.match(/(\d+)\s*周前/);
  if (weekMatch) {
    const weeks = parseInt(weekMatch[1]);
    const date = new Date(now.getTime() - weeks * 7 * 24 * 60 * 60 * 1000);
    return date.toISOString().substring(0, 10);
  }

  // 月前
  const monthMatch = text.match(/(\d+)\s*月前/);
  if (monthMatch) {
    const months = parseInt(monthMatch[1]);
    const date = new Date(now);
    date.setMonth(date.getMonth() - months);
    return date.toISOString().substring(0, 10);
  }

  // 年前
  const yearMatch = text.match(/(\d+)\s*年前/);
  if (yearMatch) {
    const years = parseInt(yearMatch[1]);
    const date = new Date(now);
    date.setFullYear(date.getFullYear() - years);
    return date.toISOString().substring(0, 10);
  }

  return '';
}

// 使用 Playwright 原生 API 提取视频ID，避免 page.evaluate() 的不稳定问题
async function extractVisibleVideoIds(page) {
  try {
    // 使用 $$eval - Playwright 原生方法，比 page.evaluate 更稳定
    const ids = await page.$$eval('a[href*="/video/"]', links => {
      return links.map(a => {
        const match = a.href.match(/\/video\/(\d+)/);
        return match ? match[1] : null;
      }).filter(Boolean);
    });
    return ids;
  } catch (e) {
    // 备用方法：从 v.douyin.com 链接提取
    try {
      const backupIds = await page.$$eval('a[href*="v.douyin.com"]', links => {
        return links.map(a => {
          const match = a.href.match(/v\.douyin\.com\/([^\/\?#]+)/);
          return match ? match[1] : null;
        }).filter(Boolean);
      });
      return backupIds;
    } catch (e2) {
      return [];
    }
  }
}

// 从页面 HTML 中提取视频数据（作为备用）
async function extractVideosFromPage(page) {
  try {
    return await page.$$eval('a[href*="/video/"]', links => {
      const seenIds = new Set();
      const videos = [];
      for (const link of links) {
        const match = link.href.match(/\/video\/(\d+)/);
        if (match && !seenIds.has(match[1])) {
          seenIds.add(match[1]);
          videos.push({
            videoId: match[1],
            videoUrl: link.href,
            shareUrl: link.href,
            title: link.textContent?.trim().substring(0, 200) || '',
            date: '',
            likes: 0
          });
        }
      }
      return videos;
    });
  } catch (e) {
    return [];
  }
}

// 主函数
async function main() {
  const options = parseArgs();

  if (!options.douyinId) {
    console.log('用法: node fetch-by-douyin-id.js <douyin_id> [options]');
    console.log('');
    console.log('参数:');
    console.log('  <douyin_id>    抖音号/博主ID');
    console.log('');
    console.log('选项:');
    console.log('  --limit=<N>      只获取最近 N 条视频 (默认: 10)');
    console.log('  --days=<N>       只获取最近 N 天内的视频');
    console.log('  --date=<YYYY-MM-DD>  获取指定日期及之后的视频');
    console.log('  --min-likes=<N>  只获取点赞数 >= N 的视频');
    console.log('  --sort-by=<field>  排序字段: date | likes');
    console.log('  --sort-order=<order>  排序方向: asc | desc (默认: desc)');
    console.log('  --dry            预览模式');
    console.log('');
    console.log('示例:');
    console.log('  node fetch-by-douyin-id.js MS4wLjABAAAAxxx --limit=20');
    console.log('  node fetch-by-douyin-id.js 1234567890 --days=7');
    console.log('  node fetch-by-douyin-id.js 1234567890 --sort-by=likes --sort-order=desc --limit=5');
    return;
  }

// 检测是否是主页链接
function isProfileUrl(input) {
  return input && (
    input.includes('douyin.com/user/') ||
    input.includes('v.douyin.com/') ||
    input.startsWith('http')
  );
}

// 从URL中提取douyin ID
function extractDouyinIdFromUrl(url) {
  const match = url.match(/douyin\.com\/user\/([^?]+)/);
  return match ? match[1] : null;
}

  console.log('===== 通过抖音号获取视频 =====');

  // 检测是否是主页URL
  let profileUrl = null;
  if (isProfileUrl(options.douyinId)) {
    profileUrl = options.douyinId;
    // 清理URL中的多余参数
    if (profileUrl.includes('douyin.com/user/')) {
      const match = profileUrl.match(/(https?:\/\/www\.douyin\.com\/user\/[^?]+)/);
      if (match) profileUrl = match[1];
    }
    console.log(`主页链接: ${profileUrl}`);
  } else {
    console.log(`抖音号: ${options.douyinId}`);
  }
  console.log(`获取限制: ${options.days ? `最近 ${options.days} 天` : options.date ? `从 ${options.date} 开始` : `最近 ${options.limit} 条`}`);
  if (options.minLikes > 0) {
    console.log(`最低点赞: ${options.minLikes}+`);
  }
  if (options.sortBy) {
    const orderLabel = options.sortOrder === 'asc' ? '升序' : '降序';
    console.log(`排序: ${options.sortBy} (${orderLabel})`);
  }
  console.log('');

  // 计算起始日期
  let startDate = null;
  if (options.days) {
    startDate = new Date();
    startDate.setDate(startDate.getDate() - options.days);
  } else if (options.date) {
    startDate = new Date(options.date);
  }
  if (startDate) {
    startDate.setHours(0, 0, 0, 0);
  }

  const processedState = loadProcessedState();

  closeChromeProcesses();

  console.log('启动 Chrome 浏览器（反检测模式）...');
  const chromeProfile = options.profile || DEFAULT_CHROME_PROFILE;
  const profileDir = path.basename(chromeProfile);
  const isDefaultProfile = profileDir === 'Default' || profileDir === DEFAULT_CHROME_PROFILE;

  // 构建反检测参数
  const stealthArgs = [
    `--profile-directory=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-accelerated-2d-canvas',
    '--no-zygote',
    '--disable-gpu',
    '--window-size=1920,1080',
    '--start-maximized'
  ];

  // 如果安装了 stealth 插件，使用它
  let contextOptions;
  if (stealthPlugin) {
    contextOptions = {
      executablePath: findChromePath(),
      headless: false,
      args: stealthArgs,
      plugins: [stealthPlugin],
      ignoreDefaultArgs: ['--enable-automation']
    };
  } else {
    contextOptions = {
      executablePath: findChromePath(),
      headless: false,
      args: stealthArgs
    };
  }

  const context = await chromium.launchPersistentContext(chromeProfile, contextOptions);

  // 隐藏自动化特征 - 额外层保护
  await context.addInitScript(() => {
    // 隐藏 navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true
    });

    // 隐藏 Chrome 运行时
    if (window.chrome) {
      Object.defineProperty(window.chrome, 'runtime', {
        get: () => ({ connected: true, id: '' }),
        configurable: true
      });
    }

    // 修改 permissions.query
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );

    // 隐藏 plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
      configurable: true
    });

    // 隐藏 languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['zh-CN', 'zh', 'en-US', 'en'],
      configurable: true
    });

    // 禁用 HardwareConcurrency 检测
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
      configurable: true
    });

    // 禁用 deviceMemory 检测
    if (navigator.deviceMemory) {
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
        configurable: true
      });
    }

    // 移除 automation 相关的 iframe
    const removeAutomationIframe = () => {
      const iframe = document.querySelector('iframe[src*="google.com"]');
      if (iframe) iframe.remove();
    };
    setTimeout(removeAutomationIframe, 100);

    // 覆盖 toString 避免检测
    window.console.debug = () => {};
  });

  const page = context.pages()[0] || await context.newPage();

  // 设置视口（模拟真实设备）
  await page.setViewportSize({ width: 1920, height: 1080 });

  // 设置 User Agent（模拟真实浏览器）
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  });

  try {
    // 第一步：打开抖音首页
    console.log('\n打开抖音首页...');

    let gotoSuccess = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`导航尝试 ${attempt}/2...`);
        await page.goto('https://www.douyin.com', {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        gotoSuccess = true;
        break;
      } catch (e) {
        console.log(`导航失败: ${e.message}`);
        if (attempt < 2) {
          console.log('等待 3 秒后重试...');
          await page.waitForTimeout(3000);
        }
      }
    }

    if (!gotoSuccess) {
      console.log('无法打开抖音页面，尝试使用备用方法...');
      await page.goto('https://www.douyin.com', { timeout: 60000 });
    }

    // 等待页面基本渲染
    console.log('等待页面加载...');
    await page.waitForTimeout(3000);
    await randomDelay(2000, 3000);

    // 检查页面是否有效
    try {
      const pageTitle = await page.title();
      console.log(`页面标题: ${pageTitle}`);
    } catch (e) {
      console.log('警告: 无法获取页面标题');
    }

    // 检查是否需要登录
    let needsLogin = false;
    try {
      needsLogin = await page.evaluate(() => {
        return document.body.textContent.includes('登录') &&
               document.body.textContent.includes('登录/注册');
      });
    } catch (e) {
      console.log('警告: 无法检查登录状态:', e.message);
    }

    if (needsLogin) {
      console.log('⚠️ 检测到登录页面，请手动登录...');
      console.log('请在浏览器窗口中完成登录，然后按 Enter 继续...');
      // 等待 60 秒让用户登录
      await page.waitForTimeout(60000);
    }

    // 检查页面是否仍然活跃（未被关闭）
    let pageAlive = false;
    try {
      pageAlive = await safePageAlive(page);
    } catch (e) {
      console.log('检查页面活跃状态时出错:', e.message);
      pageAlive = false;
    }
    if (!pageAlive) {
      console.log('页面已关闭，正在重新加载...');
      try {
        await page.goto('https://www.douyin.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
      } catch (reloadError) {
        console.log('重新加载失败:', reloadError.message);
        console.log('尝试恢复浏览器上下文...');
        // 跳过重新加载，直接尝试导航
      }
    }

    // 关闭可能出现的登录弹窗（使用 JavaScript 直接操作 DOM）
    console.log('检查并关闭登录弹窗...');
    try {
      const closeResult = await page.evaluate(() => {
        // 方法1: 查找并点击关闭按钮
        const closeSelectors = [
          '[class*="close"]',
          'button[class*="close"]',
          '[aria-label*="关闭"]',
          '[aria-label*="close"]',
          '[class*="login"] [class*="close"]'
        ];

        for (const selector of closeSelectors) {
          const btn = document.querySelector(selector);
          if (btn && btn.offsetParent !== null) { // 检查元素是否可见
            btn.click();
            return 'closed-via-close-button';
          }
        }

        // 方法2: 按 ESC 键
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return 'tried-esc-key';
      });

      console.log(`登录弹窗处理结果: ${closeResult}`);
    } catch (e) {
      console.log('关闭登录弹窗时出错（继续执行）:', e.message);
    }

    // 根据是否有主页URL决定导航方式
    if (profileUrl) {
      // 直接访问博主主页，跳过搜索步骤
      console.log('\n直接访问博主主页...');
      try {
        // 先检查页面是否可用
        if (page && !page.isClosed()) {
          await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(3000);
        } else {
          console.log('页面上下文已关闭，无法导航');
        }
      } catch (navError) {
        console.log('导航到博主主页时出错:', navError.message);
        console.log('尝试使用新页面打开...');
        try {
          const newPage = await browser.newPage();
          await newPage.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await newPage.waitForTimeout(3000);
          // 将新页面设置为当前页面
          page = newPage;
        } catch (newPageError) {
          console.log('创建新页面也失败:', newPageError.message);
        }
      }
    } else {
      // 通过搜索方式查找博主
      // 第二步：找到搜索框并输入搜索内容
      console.log(`搜索账号: ${options.douyinId}`);

      // 尝试多种方式找到搜索框
      let searchBox = null;
      const searchSelectors = [
        'input[type="search"]',
        'input[placeholder*="搜索"]',
        'input[placeholder*="搜索用户"]',
        '[class*="search-input"] input',
        '[class*="searchBox"] input',
        '[class*="search-box"] input',
        'header input',
        '.search-input'
      ];

      for (const selector of searchSelectors) {
        searchBox = await page.$(selector);
        if (searchBox) {
          console.log(`找到搜索框: ${selector}`);
          break;
        }
      }

      if (!searchBox) {
        // 如果找不到，尝试点击搜索图标展开搜索框
        const searchIconSelectors = [
          '[class*="search-icon"]',
          '[class*="searchIcon"]',
          '[class*="search-btn"]',
          '[class*="searchBtn"]',
          '[class*="search-button"]',
          '[class*="searchButton"]',
          'svg[class*="search"]',
          'i[class*="search"]'
        ];

        for (const selector of searchIconSelectors) {
          const icon = await page.$(selector);
          if (icon) {
            console.log(`点击搜索图标: ${selector}`);
            await icon.click();
            await randomDelay(1000, 2000);
            break;
          }
        }

        // 再次尝试找搜索框
        for (const selector of searchSelectors) {
          searchBox = await page.$(selector);
          if (searchBox) break;
        }
      }

      if (!searchBox) {
        throw new Error('无法找到搜索框，请手动操作');
      }

      // 输入搜索内容 - 添加页面存活检查
      if (!(await safePageAlive(page))) {
        console.log('警告: 页面在找到搜索框后已关闭，尝试重新导航...');
        await page.goto('https://www.douyin.com/search/' + encodeURIComponent(options.douyinId), {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        await page.waitForTimeout(3000);
        // 重新获取搜索框
        for (const selector of searchSelectors) {
          searchBox = await page.$(selector);
          if (searchBox) break;
        }
        if (!searchBox) {
          throw new Error('重新导航后无法找到搜索框');
        }
      }

      try {
        await searchBox.click();
        await randomDelay(500, 1000);
      } catch (e) {
        console.log('点击搜索框失败:', e.message);
        // 尝试重新获取并点击
        for (const selector of searchSelectors) {
          const sb = await page.$(selector);
          if (sb) {
            searchBox = sb;
            break;
          }
        }
        if (searchBox) {
          await searchBox.click().catch(() => {});
          await randomDelay(1000, 2000);
        }
      }

      // 再次检查页面状态
      if (!(await safePageAlive(page))) {
        console.log('警告: 页面在点击搜索框后已关闭');
        throw new Error('页面在操作过程中关闭');
      }

      try {
        await searchBox.fill('');
        await randomDelay(300, 500);
      } catch (e) {
        console.log('清空搜索框失败:', e.message);
      }

      try {
        await searchBox.type(options.douyinId, { delay: 100 });
        await randomDelay(500, 1000);
      } catch (e) {
        console.log('输入搜索内容失败:', e.message);
        // 尝试使用 keyboard.type
        try {
          await page.keyboard.type(options.douyinId, { delay: 100 });
          await randomDelay(500, 1000);
        } catch (kbError) {
          console.log('键盘输入也失败:', kbError.message);
          throw new Error('无法输入搜索内容');
        }
      }

      // 按回车搜索
      await page.keyboard.press('Enter');

      // 等待搜索结果导航完成
      console.log('\n等待搜索结果...');
      try {
        // 等待导航，最多等待10秒
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(3000);
      } catch (e) {
        console.log('等待搜索结果时出错:', e.message);
        // 尝试等待页面稳定
        await page.waitForTimeout(2000);
      }

      // 安全检查：确保页面仍然可用
      if (!(await safePageAlive(page))) {
        console.log('警告: 页面可能在搜索过程中关闭，尝试重新导航...');
        try {
          await page.goto('https://www.douyin.com/search/' + encodeURIComponent(options.douyinId), {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          });
          await page.waitForTimeout(3000);
        } catch (navError) {
          console.log('重新导航失败:', navError.message);
        }
      }

      // 查找用户搜索结果标签（通常搜索后会有"用户"标签）
      const userTabSelectors = [
        '[class*="tab"]:has-text("用户")',
        '[class*="user-tab"]',
        '[class*="userTab"]',
        '[role="tab"]:has-text("用户")',
        'div:has-text("用户")'
      ];

      let userTabFound = false;
      for (const selector of userTabSelectors) {
        try {
          if (!(await safePageAlive(page))) break;
          const userTab = await page.$(selector);
          if (userTab) {
            console.log('找到"用户"标签，点击进入');
            await userTab.click();
            await randomDelay(2000, 3000);
            userTabFound = true;
            break;
          }
        } catch (e) {
          console.log('查找用户标签时出错:', e.message);
        }
      }

      // 第四步：点击博主卡片进入主页
      console.log('\n查找博主卡片...');

      // 等待并查找博主卡片
      try {
        if (await safePageAlive(page)) {
          await page.waitForTimeout(2000);
        }
      } catch (e) {
        console.log('等待博主卡片时出错:', e.message);
      }

      const creatorCardSelectors = [
        '[class*="user-card"]',
        '[class*="userCard"]',
        '[class*="author-card"]',
        '[class*="authorCard"]',
        '[class*="search-user"]',
        '[class*="searchResult"] [class*="avatar"]',
        '[class*="result-user"]'
      ];

      let creatorLink = null;

      for (const selector of creatorCardSelectors) {
        if (!(await safePageAlive(page))) break;
        const cards = await page.$$(selector);
        if (cards.length > 0) {
          console.log(`找到 ${cards.length} 个用户卡片，尝试获取链接...`);
          // 尝试从卡片中找链接
          for (const card of cards) {
            const link = await card.$('a[href*="douyin.com/user"]');
            if (link) {
              creatorLink = link;
              break;
            }
            // 尝试点击整个卡片
            const href = await card.getAttribute('href');
            if (href && href.includes('/user/')) {
              creatorLink = card;
              break;
            }
          }
          if (creatorLink) break;
        }
      }

      // 如果上面没找到，尝试更通用的方式
      if (!creatorLink) {
        // 查看所有 /user/ 链接，但排除 self 链接
        const allLinks = await page.evaluate(() => {
          const links = document.querySelectorAll('a[href*="/user/"]');
          const results = [];

          for (const link of links) {
            const href = link.href;
            const text = link.textContent?.trim() || '';

            // 跳过 self 链接（自己的主页）
            if (href.includes('/user/self') || href.includes('from_nav=1')) {
              continue;
            }

            results.push({
              href: href,
              text: text.substring(0, 50),
              visible: link.offsetParent !== null
            });
          }

          return results;
        });

        console.log(`找到 ${allLinks.length} 个其他用户链接:`);
        for (const link of allLinks) {
          console.log(`  - ${link.text || '无标题'}: ${link.href}`);
        }

        // 优先使用第一个有效的用户链接
        if (allLinks.length > 0) {
          // 找第一个可见的链接
          const visibleLink = allLinks.find(l => l.visible) || allLinks[0];
          creatorLink = visibleLink.href;
          console.log(`\n选择博主链接: ${creatorLink}`);
        }
      }

      if (!creatorLink) {
        throw new Error('无法找到博主卡片，请手动操作或检查抖音号是否正确');
      }

      // 获取博主信息（在点击前）
      const creatorInfo = await page.evaluate(() => {
        // 尝试从搜索结果卡片中获取信息
        const searchResultCards = document.querySelectorAll('[class*="search-result"], [class*="searchResult"], [class*="user-item"]');
        for (const card of searchResultCards) {
          const link = card.querySelector('a[href*="/user/"]');
          const nameEl = card.querySelector('[class*="nickname"], [class*="user-name"], [class*="author-name"], [class*="title"]');
          const fansEl = card.querySelector('[class*="follower"], [class*="fans"]');
          if (link && nameEl) {
            return {
              name: nameEl.textContent?.trim() || '',
              fans: fansEl?.textContent?.trim() || ''
            };
          }
        }
        return { name: '', fans: '' };
      });

      console.log(`\n找到博主: ${creatorInfo.name || '未知'}`);
      if (creatorInfo.fans) console.log(`粉丝数: ${creatorInfo.fans}`);

      // 点击进入博主主页 - 直接导航到获取到的链接
      console.log(`\n进入博主主页: ${creatorLink}`);

      // 【修复】添加网络空闲等待，确保页面完全加载
      try {
        await page.goto(creatorLink, {
          waitUntil: 'networkidle',
          timeout: 60000
        });
      } catch (e) {
        // 如果 networkidle 超时，尝试 domcontentloaded
        console.log('networkidle 超时，尝试 domcontentloaded...');
        await page.goto(creatorLink, {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });
      }

      // 【修复】等待更长时间让页面稳定，并添加存活检查
      console.log('等待页面稳定...');
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(1000);
        const isAlive = await safePageAlive(page);
        if (isAlive) {
          console.log(`页面稳定 (检查 ${i + 1}/10)`);
        } else {
          console.log(`页面在检查 ${i + 1} 时已关闭`);
          throw new Error('页面在加载过程中关闭');
        }
      }

      // 验证是否在正确的页面
      const currentUrl = page.url();
      console.log(`当前页面: ${currentUrl}`);
    }

    // 获取博主信息
    let finalCreatorInfo = { name: '未知', fans: '未知' };
    try {
      // 【修复】先确认页面存活再执行 evaluate
      if (await safePageAlive(page)) {
        finalCreatorInfo = await page.evaluate(() => {
          const nameEl = document.querySelector('[class*="nickname"], [class*="name"], h1, [class*="author-title"]');
          const fansEl = document.querySelector('[class*="follower"], [class*="fans"], [class*="count"]');
          return {
            name: nameEl?.textContent?.trim() || '',
            fans: fansEl?.textContent?.trim() || ''
          };
        });
      }
    } catch (e) {
      console.log(`获取博主信息失败: ${e.message}`);
      // 尝试从 URL 中提取博主 ID 作为后备
      const urlMatch = page.url().match(/\/user\/([^?]+)/);
      if (urlMatch) {
        console.log(`博主ID: ${urlMatch[1]}`);
      }
    }

    console.log(`\n博主主页信息:`);
    console.log(`  昵称: ${finalCreatorInfo.name || '未知'}`);
    console.log(`  粉丝: ${finalCreatorInfo.fans || '未知'}`);

    // 滚动加载更多视频 - 模拟真实用户行为
    console.log('\n滚动加载视频列表（模拟真实用户）...');
    let lastVideoCount = 0;
    let scrollCount = 0;
    let stableCount = 0; // 视频数量稳定的连续次数
    let maxFoundCount = 0; // 记录最大发现数量
    const maxScrolls = 500; // 大幅增加滚动次数上限（抖音博主可能有几百上千个视频）
    const stableThreshold = 15; // 连续15次视频数不变认为加载完成

    // 【重构】使用 Map 而非 Set，存储完整视频信息用于去重和输出
    // Key: videoId, Value: { videoId, title, likes, shareUrl, videoUrl }
    const foundVideoIds = new Map();

    // 提取单个视频的详细信息
    const extractVideoDetails = async () => {
      try {
        const videos = await page.$$eval('li', lis => {
          return lis.map(li => {
            // 获取视频链接
            const link = li.querySelector('a[href*="/video/"]') || li.querySelector('a[href*="v.douyin.com"]');
            if (!link) return null;

            const href = link.href;
            let videoId = '';
            let shareUrl = '';

            // 从 /video/xxx 格式提取
            const videoMatch = href.match(/\/video\/(\d+)/);
            // 从 v.douyin.com/xxx 格式提取
            const shareMatch = href.match(/v\.douyin\.com\/([^\/\?#]+)/);

            if (videoMatch) {
              videoId = videoMatch[1];
              shareUrl = `https://v.douyin.com/${videoId}/`;
            } else if (shareMatch) {
              // 短链接格式，videoId 就是链接中的部分
              videoId = shareMatch[1];
              shareUrl = href.split('?')[0] + '/'; // 确保格式正确
            }

            if (!videoId) return null;

            // 获取标题
            const titleEl = li.querySelector('p') || li.querySelector('[class*="title"]') || li.querySelector('span');
            let title = '';
            if (titleEl) {
              title = titleEl.textContent?.trim() || '';
              // 清理标题：移除多余的空白字符
              title = title.replace(/\s+/g, ' ').substring(0, 200);
            }

            // 获取点赞数
            let likes = 0;
            const likeEl = li.querySelector('[class*="like"], [class*="author-card-user-video-like"]');
            if (likeEl) {
              const likeText = likeEl.textContent || '';
              // 提取数字（支持万、亿单位）
              const likeMatch = likeText.match(/([\d.]+)([万千百亿]?)/);
              if (likeMatch) {
                let num = parseFloat(likeMatch[1]);
                const unit = likeMatch[2];
                if (unit === '万') num *= 10000;
                else if (unit === '亿') num *= 100000000;
                else if (unit === '千') num *= 1000;
                else if (unit === '百') num *= 100;
                likes = Math.round(num);
              }
            }

            return {
              videoId,
              shareUrl,
              title,
              likes
            };
          }).filter(Boolean);
        });
        return videos;
      } catch (e) {
        console.log('提取视频详情失败:', e.message);
        return [];
      }
    };

    // 等待初始视频加载
    await page.waitForTimeout(3000);

    // 安全检查函数（使用不同的变量名避免与全局函数冲突）
    const checkPageAlive = async (p) => {
      try {
        await p.evaluate(() => document.readyState);
        return true;
      } catch (e) {
        return false;
      }
    };

    // 提取当前页面可见的视频ID（用于统计）
    // 使用 page.$$eval() 替代 page.evaluate()，更稳定
    const extractVisibleVideoIds = async () => {
      try {
        const ids = new Set();
        const links = await page.$$eval('a[href*="/video/"]', els =>
          els.map(el => {
            const match = el.href.match(/\/video\/(\d+)/);
            return match ? match[1] : null;
          }).filter(Boolean)
        );
        links.forEach(id => ids.add(id));
        // 备用方法：从 v.douyin.com 链接提取
        try {
          const shortLinks = await page.$$eval('a[href*="v.douyin.com"]', els =>
            els.map(el => {
              const match = el.href.match(/v\.douyin\.com\/([^\/\?#]+)/);
              return match ? match[1] : null;
            }).filter(Boolean)
          );
          shortLinks.forEach(id => ids.add(id));
        } catch (e2) {
          // 忽略备用方法错误
        }
        return Array.from(ids);
      } catch (e) {
        return [];
      }
    };

    while (scrollCount < maxScrolls) {
      // 检查页面是否仍然活跃
      const isAlive = await checkPageAlive(page);
      if (!isAlive) {
        console.log('页面已关闭或崩溃，停止滚动');
        break;
      }

      // 【关键修复】使用更小的滚动步长，确保不遗漏任何视频
      let scrollAmount;
      try {
        // 策略：使用10%-30%的视口高度滚动，大幅增加滚动次数
        // 这样可以确保每次滚动都有新内容被加载到DOM中
        scrollAmount = await page.evaluate((count) => {
          const clientHeight = window.innerHeight;
          // 每5次滚动中有1次滚半屏，其他使用更小步长
          if (count % 5 === 4) {
            return Math.floor(clientHeight * 0.5); // 半屏
          } else {
            // 10%-30%的随机步长，大幅增加采样密度
            const randomRatio = 0.10 + Math.random() * 0.20; // 10%-30%
            return Math.floor(clientHeight * randomRatio);
          }
        }, scrollCount);
      } catch (e) {
        console.log('获取滚动位置失败:', e.message);
        // 尝试诊断问题
        try {
          const pageInfo = await page.evaluate(() => {
            return {
              readyState: document.readyState,
              bodyExists: !!document.body,
              scrollHeight: document.body ? document.body.scrollHeight : 0,
              url: window.location.href,
              title: document.title
            };
          });
          console.log('页面诊断:', JSON.stringify(pageInfo));
        } catch (diagError) {
          console.log('页面诊断也失败:', diagError.message);
        }
        // 等待一下再重试
        await page.waitForTimeout(2000);
        try {
          // 再尝试一次 - 使用较小步长确保不遗漏
          scrollAmount = await page.evaluate(() => Math.floor(window.innerHeight * 0.6));
          console.log('重试滚动成功');
        } catch (retryError) {
          console.log('重试也失败，停止滚动');
          break;
        }
      }
      let scrollResult;
      try {
        scrollResult = await page.evaluate(async (amount) => {
          const results = {};
          // 方式1: 尝试内容区滚动容器（抖音PC版专用）
          const mainScroll = document.querySelector('#main-scroll, .main-scroll, [class*="scroll-container"], [class*="mainContainer"]');
          if (mainScroll) {
            mainScroll.scrollTop += amount;
            results.scrolled = 'mainScroll';
          } else {
            // 方式2: 尝试视频列表父容器
            const videoContainer = document.querySelector('[class*="videoList"], [class*="video-list"], [class*="videoList"], ul[class*="video"]');
            if (videoContainer) {
              videoContainer.scrollTop += amount;
              results.scrolled = 'videoContainer';
            } else {
              // 方式3: 窗口滚动（兜底）
              window.scrollBy({ top: amount, behavior: 'instant' });
              results.scrolled = 'window';
            }
          }
          // 方式4: 模拟鼠标滚轮事件（更真实的人类滚动行为）
          // 找到视频列表容器并发送 wheel 事件
          const targetEl = document.querySelector('#main-scroll, .main-scroll, [class*="scroll-container"], [class*="mainContainer"]') || window;
          if (targetEl !== window) {
            const wheelEvent = new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              view: window,
              deltaY: amount
            });
            targetEl.dispatchEvent(wheelEvent);
            results.wheelDispatched = true;
          }
          // 记录滚动后状态
          const scrollEl = document.querySelector('#main-scroll, .main-scroll, [class*="scroll-container"]') || window;
          results.scrollTop = scrollEl.scrollTop || window.scrollY;
          results.scrollHeight = scrollEl.scrollHeight || document.body.scrollHeight;
          return results;
        }, scrollAmount);
      } catch (e) {
        console.log('滚动操作失败，停止滚动');
        break;
      }

      // 等待内容加载（抖音需要时间渲染新视频，增加等待时间）
      await randomDelay(3500, 5000);

      // 检查页面是否仍然活跃
      if (!(await safePageAlive(page))) {
        console.log('页面在等待后已关闭，停止滚动');
        break;
      }

      // 收集新发现的视频（提取详细信息：标题、点赞数、分享链接）
      const visibleVideos = await extractVideoDetails();
      let newIdsFound = 0;
      visibleVideos.forEach(v => {
        if (!foundVideoIds.has(v.videoId)) {
          // 使用 Map 存储完整信息，保留最好的标题和点赞数
          foundVideoIds.set(v.videoId, {
            videoId: v.videoId,
            shareUrl: v.shareUrl,
            title: v.title || '',
            likes: v.likes || 0,
            videoUrl: `https://www.douyin.com/video/${v.videoId}`
          });
          newIdsFound++;
        }
      });

      const currentCount = foundVideoIds.size;

      if (scrollCount % 5 === 0 || newIdsFound > 0) {
        console.log(`  滚动 ${scrollCount + 1}: 累计发现 ${currentCount} 个视频 (本次新发现: ${newIdsFound})`);
      }

      // 【关键修复】更新最大发现数量
      if (currentCount > maxFoundCount) {
        maxFoundCount = currentCount;
        stableCount = 0; // 发现新视频，重置稳定计数
      } else {
        stableCount++;
      }

      // 如果发现数量达到目标限制，提前退出
      if (options.limit > 0 && currentCount >= options.limit) {
        console.log(`  已加载 ${currentCount} 个视频（达到限制）`);
        break;
      }

      // 【关键修复】稳定检测 - 使用变量确保一致性
      // 由于抖音虚拟化 DOM，只有继续滚动才能加载更多内容
      // 增加阈值到 20 次，确保获取完整视频列表
      if (stableCount >= stableThreshold) {
        console.log(`  视频数量已稳定（连续${stableThreshold}次无变化，共${currentCount}个视频），结束加载`);
        break;
      }

      // 如果是新发现视频，延长滚动时间
      if (newIdsFound > 0 && currentCount < 100) {
        // 视频较少时，继续滚动
      } else if (newIdsFound === 0 && stableCount > 5) {
        // 连续多次无新发现，减少等待时间快速检测
        await randomDelay(500, 1000);
      }

      scrollCount++;
    }

    console.log(`\n滚动结束: 共滚动 ${scrollCount} 次，累计发现 ${foundVideoIds.size} 个视频`);

    // 提取视频列表
    console.log('\n提取视频信息...');

    // 【重构】直接使用 Map 中存储的完整视频信息生成视频列表
    let videos = Array.from(foundVideoIds.values()).map(video => ({
      videoId: video.videoId,
      videoUrl: video.videoUrl || `https://www.douyin.com/video/${video.videoId}`,
      shareUrl: video.shareUrl || `https://v.douyin.com/${video.videoId}/`,
      title: video.title || '',
      date: video.date || '',
      likes: video.likes || 0
    }));

    console.log(`提取到 ${videos.length} 个视频`);

    if (videos.length === 0) {
      console.log('\n未找到视频，可能需要调整页面选择器');
      console.log('请确认抖音号是否正确');
      return;
    }

    // 过滤和排序
    let filteredVideos = videos;

    // 按日期过滤
    if (startDate) {
      filteredVideos = filteredVideos.filter(v => {
        if (!v.date) return true;
        const dateMatch = v.date.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
        if (dateMatch) {
          const publishDate = new Date(dateMatch[1], dateMatch[2] - 1, dateMatch[3]);
          return publishDate >= startDate;
        }
        // 尝试解析ISO格式
        const isoDate = new Date(v.date);
        if (!isNaN(isoDate.getTime())) {
          return isoDate >= startDate;
        }
        return true;
      });
      console.log(`日期过滤后: ${filteredVideos.length} 个视频`);
    }

    // 按点赞数过滤
    if (options.minLikes > 0) {
      const beforeCount = filteredVideos.length;
      filteredVideos = filteredVideos.filter(v => v.likes >= options.minLikes);
      console.log(`点赞数 >= ${options.minLikes} 过滤后: ${filteredVideos.length} 个视频 (移除了 ${beforeCount - filteredVideos.length} 个)`);
    }

    // 排序
    if (options.sortBy) {
      filteredVideos.sort((a, b) => {
        let aVal, bVal;

        if (options.sortBy === 'date') {
          // 优先使用实际日期，没有则尝试解析相对日期
          aVal = a.date || '';
          bVal = b.date || '';

          // 如果没有日期，设为极小值排到最后
          if (!aVal) return 1;
          if (!bVal) return -1;

          // 解析日期用于比较
          const aMatch = aVal.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
          const bMatch = bVal.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);

          if (aMatch && bMatch) {
            aVal = new Date(aMatch[1], aMatch[2] - 1, aMatch[3]).getTime();
            bVal = new Date(bMatch[1], bMatch[2] - 1, bMatch[3]).getTime();
          } else {
            // 尝试ISO格式
            aVal = new Date(aVal).getTime() || 0;
            bVal = new Date(bVal).getTime() || 0;
          }
        } else if (options.sortBy === 'likes') {
          aVal = a.likes || 0;
          bVal = b.likes || 0;
        }

        // 根据排序方向返回
        if (options.sortOrder === 'asc') {
          return aVal - bVal;
        } else {
          return bVal - aVal;
        }
      });

      const orderLabel = options.sortOrder === 'asc' ? '升序' : '降序';
      console.log(`排序 (${options.sortBy} ${orderLabel}): ${filteredVideos.length} 个视频`);
    }

    // 限制数量（取最新的）
    if (options.limit && filteredVideos.length > options.limit) {
      filteredVideos = filteredVideos.slice(0, options.limit);
    }

    // 显示视频列表（完整信息：序号、标题、分享链接、点赞数）
    console.log('\n视频列表:');
    filteredVideos.forEach((v, i) => {
      const processed = processedState.processedVideoIds.has(v.videoId);
      const titleDisplay = v.title ? v.title : '[无标题]';
      const likesDisplay = v.likes > 0 ? `点赞: ${v.likes.toLocaleString()}` : '';
      const processedMark = processed ? ' ✓ 已处理' : '';

      console.log(`  ${i + 1}. ${titleDisplay}${processedMark}`);
      console.log(`     分享链接: ${v.shareUrl}`);
      if (likesDisplay) console.log(`     ${likesDisplay}`);
    });

    if (options.dry) {
      console.log('\n预览模式：退出');
      return;
    }

    // 处理视频
    console.log('\n===== 开始处理视频 =====\n');

    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (let i = 0; i < filteredVideos.length; i++) {
      const video = filteredVideos[i];

      // 检查是否已处理
      const alreadyProcessed =
        processedState.processedVideoIds.has(video.videoId) ||
        processedState.processedUrls.has(video.shareUrl) ||
        processedState.processedUrls.has(video.videoUrl);

      if (alreadyProcessed && options.skipExisting) {
        console.log(`[${i + 1}/${filteredVideos.length}] 跳过: ${video.title}`);
        skipCount++;
        continue;
      }

      console.log(`\n[${i + 1}/${filteredVideos.length}] 处理: ${video.title}`);
      console.log(`  视频链接: ${video.videoUrl}`);
      console.log(`  分享链接: ${video.shareUrl}`);

      try {
        // 使用完整视频页面URL而非短链接
        const result = await fetchDouyinNote(video.videoUrl, { profile: chromeProfile });

        if (result.success) {
          console.log(`  ✓ 成功`);
          processedState.processedVideoIds.add(video.videoId);
          processedState.processedUrls.add(video.shareUrl);
          processedState.processedUrls.add(video.videoUrl);
          successCount++;
        } else {
          console.log(`  ✗ 失败: ${result.error}`);
          failCount++;
        }
      } catch (e) {
        console.log(`  ✗ 错误: ${e.message}`);
        failCount++;
      }

      // 保存进度
      saveProcessedState(processedState);

      // 处理间隔（模拟用户浏览行为）
      if (i < filteredVideos.length - 1) {
        const waitTime = 8 + Math.random() * 7; // 8-15秒随机
        console.log(`  等待 ${waitTime.toFixed(0)} 秒...`);
        await new Promise(r => setTimeout(r, waitTime * 1000));
      }
    }

    console.log('\n===== 处理完成 =====');
    console.log(`成功: ${successCount}`);
    console.log(`跳过: ${skipCount}`);
    console.log(`失败: ${failCount}`);
    console.log(`总计: ${filteredVideos.length}`);

  } catch (e) {
    console.error('错误:', e.message);
  } finally {
    console.log('\n浏览器保持打开状态');
  }
}

function findChromePath() {
  const possiblePaths = [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/c/Program Files (x86)/Google/Chrome/Application/chrome.exe'
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      console.log(`使用 Chrome: ${p}`);
      return p;
    }
  }
  throw new Error('未找到 Chrome 浏览器');
}

// 运行
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
