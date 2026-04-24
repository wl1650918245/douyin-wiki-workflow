/**
 * fetch-douyin-via-biji.js
 *
 * 使用 Playwright 自动化 Get笔记 网页版 + API 获取抖音视频完整笔记
 *
 * 工作流：打开 /note 页面 -> 点击"添加链接" -> 粘贴链接 -> 等待生成 -> 通过 API 获取完整笔记
 *
 * 包含高级反检测措施，保护账号安全
 *
 * 用法:
 *   node fetch-douyin-via-biji.js <douyin_url>
 *   node fetch-douyin-via-biji.js <douyin_url> --profile=<chrome_profile_path>
 */

const { chromium } = require('playwright');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

// 反检测插件
let stealthPlugin;
try {
  stealthPlugin = require('puppeteer-extra-plugin-stealth')();
} catch (e) {
  console.log('注意: puppeteer-extra-plugin-stealth 未安装，反检测功能受限');
}

// Get笔记 API 配置（请替换为你自己的 API 凭证）
const BASE_URL = 'https://openapi.biji.com/open/api/v1';
const API_KEY = 'gk_live_ac491dd189d01fdd.55d2db323b1c35ab2bdfe1869051b56510452da9b9463f62';
const CLIENT_ID = 'cli_a1b2c3d4e5f6789012345678abcdef90';

const http = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: API_KEY,  // 注意：不用 Bearer 前缀！
    'X-Client-ID': CLIENT_ID,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

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
    // 尝试关闭 chrome.exe 进程
    execSync('taskkill /F /IM chrome.exe 2>nul', { stdio: 'ignore' });
    // 等待一下让进程完全退出
    const { setTimeout: sleep } = require('timers/promises');
    sleep(1000);
    console.log('已关闭 Chrome 进程');
  } catch (e) {
    // 忽略错误（进程可能不存在）
  }
}

// API 请求函数
async function apiRequest(method, path, params, data) {
  const res = await http.request({
    method,
    url: path,
    params,
    data,
  });
  const body = res.data;
  if (!body.success) {
    throw new Error(`API Error: ${body.error?.message || 'Unknown error'}`);
  }
  return body.data;
}

async function listNotes(since_id = 0) {
  return apiRequest('GET', '/resource/note/list', { since_id });
}

// 通过 API 检查该链接是否已有笔记
async function findExistingNoteByUrl(douyinUrl) {
  // 从抖音URL提取视频ID
  const videoIdMatch = douyinUrl.match(/(\d+)/);
  const videoId = videoIdMatch ? videoIdMatch[1] : '';

  let since_id = 0;
  let maxRetries = 3;

  while (maxRetries > 0) {
    try {
      const data = await listNotes(since_id);

      if (!data.notes || data.notes.length === 0) {
        maxRetries--;
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      // 遍历笔记查找匹配的链接
      for (const note of data.notes) {
        const noteContent = note.content || '';
        const webPageUrl = note.web_page?.url || '';

        // 检查笔记内容或web_page是否包含该抖音链接
        const urlMatches = douyinUrl.includes(videoId) ||
            noteContent.includes(videoId) ||
            webPageUrl.includes(videoId) ||
            noteContent.includes(douyinUrl) ||
            webPageUrl.includes(douyinUrl.replace('https://', ''));

        if (urlMatches && note.web_page?.content && note.web_page.content.length > 100) {
          console.log(`找到已有笔记: note_id=${note.note_id}, title=${note.title}`);
          return note;
        }
      }

      // 继续翻页查找
      const lastNote = data.notes[data.notes.length - 1];
      since_id = lastNote.note_id || lastNote.id;

      maxRetries--;
      await new Promise(r => setTimeout(r, 1000));

    } catch (e) {
      console.log(`检查已有笔记失败: ${e.message}`);
      maxRetries--;
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return null;
}

// 通过 API 获取最新生成的抖音笔记
async function getNewDouyinNoteViaAPI(douyinUrl, existingNoteIds) {
  console.log('通过 API 获取最新笔记...');

  // 从抖音URL提取可能的标题关键词
  // 例如: https://v.douyin.com/yw3yPhgOl_0/ -> 提取视频ID
  const videoIdMatch = douyinUrl.match(/(\d+)/);
  const videoId = videoIdMatch ? videoIdMatch[1] : '';

  let since_id = 0;
  let maxRetries = 20; // 保持足够的重试次数
  let lastFoundNoteId = null;
  let shortWait = true; // 前期快速轮询

  while (maxRetries > 0) {
    try {
      const data = await listNotes(since_id);

      if (!data.notes || data.notes.length === 0) {
        // 空列表时稍微延长等待，但不要太长
        const waitTime = shortWait ? 1500 : 3000;
        console.log(`API 返回空列表，等待 ${waitTime / 1000} 秒...`);
        await new Promise(r => setTimeout(r, waitTime));
        // 3次空结果后切换到正常等待模式
        if (--maxRetries < 15) shortWait = false;
        continue;
      }

      console.log(`API 返回 ${data.notes.length} 条笔记，检查新笔记...`);

      // 查找新笔记（不在已同步列表中的）
      for (const note of data.notes) {
        const noteId = String(note.note_id || note.id);

        // 跳过已存在的笔记
        if (existingNoteIds.has(noteId)) {
          continue;
        }

        // 检查是否是最近找到的笔记
        if (noteId === lastFoundNoteId) {
          continue;
        }

        // 检查笔记内容是否包含抖音链接
        const noteContent = note.content || '';
        const webPageUrl = note.web_page?.url || '';

        // 检查是否有抖音链接
        const hasDouyinLink = noteContent.includes('douyin.com') ||
            noteContent.includes('v.douyin.com') ||
            webPageUrl.includes('douyin.com') ||
            webPageUrl.includes('v.douyin.com');

        // 检查是否有完整内容（web_page.content 存在且长度足够）
        const hasFullContent = note.web_page?.content && note.web_page.content.length > 500;

        // 检查是否是同步中的笔记
        const isSyncing = note.sync_status === 'syncing' || note.sync_status === 'pending';

        // 新笔记且有完整内容，或者有抖音链接
        if ((hasFullContent || hasDouyinLink) && !isSyncing) {
          console.log(`找到可用的新笔记: note_id=${noteId}, title=${note.title}`);
          console.log(`  - web_page.content 长度: ${note.web_page?.content?.length || 0}`);
          return note;
        }

        // 如果是新笔记但还在处理中，记录下来继续等待
        if (isSyncing || (noteContent.length > 50 && !hasFullContent)) {
          lastFoundNoteId = noteId;
          console.log(`检测到处理中的笔记: note_id=${noteId}, title=${note.title}, sync_status=${note.sync_status || 'unknown'}`);
        }
      }

      // 更新 since_id 继续查询
      const lastNote = data.notes[data.notes.length - 1];
      since_id = lastNote.note_id || lastNote.id;

      console.log(`未找到可用的笔记，继续等待... (剩余重试: ${maxRetries - 1})`);
      // 快速轮询模式：前10次每次1.5秒，之后每次3秒
      const waitTime = shortWait ? 1500 : 3000;
      await new Promise(r => setTimeout(r, waitTime));
      maxRetries--;
      if (maxRetries < 10) shortWait = false;

    } catch (e) {
      console.log(`API 查询失败: ${e.message}，等待 3 秒后重试...`);
      await new Promise(r => setTimeout(r, 3000));
      shortWait = false;
      maxRetries--;
    }
  }

  // 最后尝试：获取最新的笔记（不管内容）
  // 注意：如果已知有笔记在处理中，直接获取最新的未同步笔记
  console.log('尝试直接获取最新笔记...');
  try {
    const data = await listNotes(0);
    if (data.notes && data.notes.length > 0) {
      // 获取最新的一条笔记
      const latestNote = data.notes[0];
      const noteId = String(latestNote.note_id || latestNote.id);

      // 如果是已同步笔记，获取第二条（最新未同步的）
      if (existingNoteIds.has(noteId) && data.notes.length > 1) {
        const secondNote = data.notes[1];
        const secondNoteId = String(secondNote.note_id || secondNote.id);
        console.log(`最新笔记已同步，获取第二条: note_id=${secondNoteId}, title=${secondNote.title}`);
        return secondNote;
      }

      console.log(`返回最新笔记: note_id=${noteId}, title=${latestNote.title}`);
      return latestNote;
    }
  } catch (e) {
    console.log(`最后尝试失败: ${e.message}`);
  }

  return null;
}

// kb-wiki 笔记保存目录
// 注意：Windows 上 HOMEPATH/USERPROFILE 可能不带盘符，需要特殊处理
function getKbWikiPath() {
  // 优先使用 USERPROFILE（通常包含完整路径）
  let homePath = process.env.USERPROFILE || process.env.HOMEPATH || '';

  // Windows 上 HOMEPATH 可能不带盘符（如 \Users\用户名），需要补全
  if (homePath && !homePath.match(/^[A-Za-z]:/)) {
    const homeDrive = process.env.HOMEDRIVE || 'C:';
    homePath = homeDrive + homePath;
  }

  return path.join(homePath, 'kb-wiki');
}

const KB_WIKI_PATH = getKbWikiPath();
const NOTE_SAVE_DIR = path.join(KB_WIKI_PATH, 'raw', 'get笔记');
const STATE_FILE = path.join(KB_WIKI_PATH, 'raw', '.sync-state.json');

// 确保目录存在
function ensureDirectoriesExist() {
  if (!fs.existsSync(NOTE_SAVE_DIR)) {
    fs.mkdirSync(NOTE_SAVE_DIR, { recursive: true });
    console.log(`创建笔记目录: ${NOTE_SAVE_DIR}`);
  }
}

// 保存笔记到文件
function saveNoteToFile(note, douyinUrl) {
  ensureDirectoriesExist();

  const noteId = String(note.note_id || note.id);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const title = note.title || 'untitled';
  // 清理标题用于文件名：移除特殊字符，保留中文和字母数字
  const safeTitle = title.replace(/[<>:"/\\|?*\n\r]/g, '_').substring(0, 50);
  const filename = `douyin_${dateStr}_${safeTitle}.md`;
  const filepath = path.join(NOTE_SAVE_DIR, filename);

  const createdAt = note.created_at || now.toISOString().replace('T', ' ').slice(0, 19);
  const updatedAt = now.toISOString().replace('T', ' ').slice(0, 19);

  // 使用 Obsidian YAML Frontmatter 格式
  let content = `---
title: ${title}
note_id: ${noteId}
note_type: link
source: Get笔记
created_at: ${createdAt}
updated_at: ${updatedAt}
tags: AI链接笔记
---

`;

  if (note.content) {
    content += note.content + '\n\n';
  }

  if (note.web_page?.content) {
    content += '## 网页原文\n\n' + note.web_page.content + '\n\n';
  }

  if (note.audio?.original) {
    content += '## 音频转写\n\n' + note.audio.original + '\n\n';
  }

  fs.writeFileSync(filepath, content, 'utf8');
  console.log(`笔记已保存到: ${filepath}`);

  return filepath;
}

async function fetchDouyinNote(douyinUrl, options = {}) {
  const chromeProfile = options.profile || DEFAULT_CHROME_PROFILE;

  console.log('关闭可能占用 Chrome profile 的进程...');
  closeChromeProcesses();

  console.log('启动 Chrome 浏览器（反检测模式）...');

  // 构建反检测参数
  const stealthArgs = [
    '--profile-directory=Default',
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

    // 禁用 console.debug 避免被检测
    window.console.debug = () => {};
  });

  const page = context.pages()[0] || await context.newPage();

  // 设置视口
  await page.setViewportSize({ width: 1920, height: 1080 });

  // 设置 HTTP 头
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  });

  try {
    // Step 0: 先检查该链接是否已有笔记
    console.log('检查该链接是否已有笔记...');
    const existingNote = await findExistingNoteByUrl(douyinUrl);
    if (existingNote) {
      console.log(`该链接已有笔记: ${existingNote.title} (${existingNote.note_id})`);
      const filepath = saveNoteToFile(existingNote, douyinUrl);
      return {
        success: true,
        content: existingNote.content || '',
        note: existingNote,
        filepath: filepath,
        url: douyinUrl,
        reused: true
      };
    }

    // Step 1: 打开 /note 页面
    console.log('打开 Get笔记 /note 页面...');
    await page.goto('https://www.biji.com/note', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    await page.waitForTimeout(2000);

    // Step 2: 点击页面中央的"添加链接"按钮
    console.log('点击"添加链接"按钮...');
    await clickAddLinkButton(page);

    await page.waitForTimeout(1500);

    // Step 3: 在输入框中粘贴抖音链接
    console.log('粘贴抖音链接...');
    await pasteUrl(page, douyinUrl);

    // Step 4: 记录当前笔记数量
    const initialNoteCount = await page.evaluate(() => {
      const notes = document.querySelectorAll('.note-list-item, [class*="note-list-item"]');
      return notes.length;
    });
    console.log(`当前笔记数量: ${initialNoteCount}`);

    // Step 5: 等待笔记生成
    console.log('等待笔记生成...');
    await waitForNoteGeneration(page, initialNoteCount, douyinUrl);

    console.log('\n笔记已生成！正在通过 API 获取完整内容...\n');

    // Step 6: 通过 API 获取完整笔记内容
    // 读取已同步的笔记 ID
    let existingNoteIds = new Set();
    try {
      if (fs.existsSync(STATE_FILE)) {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        existingNoteIds = new Set(state.syncedNoteIds || []);
        console.log(`已有 ${existingNoteIds.size} 个已同步笔记`);
      }
    } catch (e) {
      console.log('无法读取同步状态，继续...');
    }

    const note = await getNewDouyinNoteViaAPI(douyinUrl, existingNoteIds);

    if (note) {
      // 保存笔记
      const filepath = saveNoteToFile(note, douyinUrl);

      // 更新同步状态
      const noteId = String(note.note_id || note.id);
      existingNoteIds.add(noteId);
      try {
        const state = {
          syncedNoteIds: Array.from(existingNoteIds),
          lastSync: new Date().toISOString()
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
      } catch (e) {
        console.log('无法更新同步状态');
      }

      console.log('\n===== 生成的笔记 =====\n');
      console.log(`标题: ${note.title}`);
      console.log(`内容长度: ${(note.content || '').length} 字符`);
      console.log('\n======================\n');

      return {
        success: true,
        content: note.content || '',
        note: note,
        filepath: filepath,
        url: douyinUrl
      };
    } else {
      return {
        success: false,
        error: '未找到生成的笔记',
        url: douyinUrl
      };
    }
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

async function clickAddLinkButton(page) {
  // 页面中央的"添加链接"按钮（带链接图标的那个）
  const selectors = [
    // 带图标的添加链接按钮
    '[class*="add-link"]',
    '[class*="link-btn"]',
    '[class*="addLink"]',
    // 添加链接图标按钮
    '[class*="icon-link"]',
    '[class*="link-icon"]',
    // 页面中央的链接按钮
    'button[class*="link"]',
    'div[class*="link"]',
    // 包含链接文字和图标的区域
    'div:has-text("添加链接")',
    'span:has-text("添加链接")',
    // 带特定样式的链接按钮
    '[data-testid*="link"]',
    // 通用的按钮/可点击元素
    '.note-editor button',
    '.editor button',
    '[role="button"]:has-text("链接")'
  ];

  for (const selector of selectors) {
    try {
      const elements = await page.$$(selector);
      for (const el of elements) {
        const text = await el.textContent();
        const isVisible = await el.isVisible();
        if (isVisible && (text?.includes('添加链接') || text?.includes('链接'))) {
          console.log(`找到添加链接按钮: ${selector}, 文本: ${text.trim()}`);
          await el.click();
          return true;
        }
      }
    } catch (e) {
      // 继续尝试
    }
  }

  // 尝试点击带有链接图标的区域
  console.log('尝试其他方式查找添加链接按钮...');
  try {
    // 查找包含链接图标的元素
    const linkIcon = await page.evaluate(() => {
      // 查找链接相关的图标元素
      const allElements = document.querySelectorAll('button, div, span, a');
      for (const el of allElements) {
        const className = el.className || '';
        const text = el.textContent || '';
        // 查找有链接相关类名或文本的元素
        if (className.includes('link') || text.includes('添加链接')) {
          const rect = el.getBoundingClientRect();
          // 跳过太小或不可见的元素
          if (rect.width > 50 && rect.height > 30 && rect.top > 100) {
            return className;
          }
        }
      }
      return null;
    });
    if (linkIcon) {
      console.log(`找到链接元素: ${linkIcon}`);
    }
  } catch (e) {
    // 忽略
  }

  return false;
}

async function pasteUrl(page, url) {
  // 等待输入框出现
  await page.waitForTimeout(1000);

  const inputSelectors = [
    // 链接输入框
    'input[placeholder*="链接"]',
    'input[placeholder*="URL"]',
    'input[placeholder*="抖音"]',
    'input[placeholder*="网址"]',
    'textarea[placeholder*="链接"]',
    'textarea[placeholder*="URL"]',
    'textarea',
    'input[type="text"]',
    'input:not([type])'
  ];

  for (const selector of inputSelectors) {
    try {
      const input = await page.$(selector);
      if (input) {
        const isVisible = await input.isVisible();
        if (isVisible) {
          console.log(`在输入框 ${selector} 中粘贴 URL`);
          await input.click();
          await input.fill(url);
          await page.waitForTimeout(500);
          // 按回车或点击确定
          await page.keyboard.press('Enter');
          return true;
        }
      }
    } catch (e) {
      // 继续尝试
    }
  }

  // 使用键盘直接输入
  console.log('使用键盘输入 URL...');
  await page.keyboard.type(url);
  await page.keyboard.press('Enter');
  return true;
}

async function waitForNoteGeneration(page, initialNoteCount, douyinUrl) {
  const maxAttempts = 60; // 增加等待时间，因为需要解析抖音页面
  let attempts = 0;

  while (attempts < maxAttempts) {
    console.log(`检查笔记生成进度... (${attempts + 1}/${maxAttempts})`);

    // 检查是否显示"正在访问网站，获取内容"
    const accessingText = await page.$('text=/正在访问|获取内容|分析中/i');
    if (accessingText) {
      console.log('正在访问网站获取内容...');
      await page.waitForTimeout(5000); // 等待更长时间
      attempts += 2;
      continue;
    }

    // 检查是否有加载/生成状态
    const loadingIndicators = [
      'text=/加载中|生成中|处理中/i',
      '[class*="loading"]',
      '[class*="spinner"]',
      '[class*="generating"]'
    ];

    for (const indicator of loadingIndicators) {
      try {
        const el = await page.$(indicator);
        if (el) {
          const isVisible = await el.isVisible();
          if (isVisible) {
            console.log('检测到加载状态...');
            await page.waitForTimeout(5000);
            attempts += 2;
            continue;
          }
        }
      } catch (e) {
        // 继续
      }
    }

    // 检查是否有新增的笔记
    const hasNewNote = await page.evaluate((url) => {
      const noteItems = document.querySelectorAll('.note-list-item, [class*="note-list-item"]');
      for (const item of noteItems) {
        const text = item.innerText || '';
        // 查找包含抖音链接的新笔记
        if (text.includes(url) || text.includes('v.douyin.com') || text.includes('抖音')) {
          return true;
        }
      }
      return false;
    }, douyinUrl);

    if (hasNewNote) {
      console.log('检测到新生成的笔记!');
      // 再等一下确保内容完全加载
      await page.waitForTimeout(3000);
      return true;
    }

    // 如果笔记数量增加了，也说明生成了新笔记
    const currentNoteCount = await page.evaluate(() => {
      return document.querySelectorAll('.note-list-item, [class*="note-list-item"]').length;
    });

    if (currentNoteCount > initialNoteCount) {
      console.log(`笔记数量增加: ${initialNoteCount} -> ${currentNoteCount}`);
      await page.waitForTimeout(3000);
      return true;
    }

    await page.waitForTimeout(3000);
    attempts++;
  }

  console.log('等待超时');
  return false;
}

async function clickAndOpenFullNote(page, douyinUrl) {
  // 等待一下确保新笔记完全渲染
  await page.waitForTimeout(2000);

  // 查找包含指定抖音链接的笔记并点击打开
  const clicked = await page.evaluate((url) => {
    const noteItems = document.querySelectorAll('.note-list-item, [class*="note-list-item"], .note-item, [class*="noteItem"]');

    console.log(`Looking for note with URL: ${url}`);

    for (const item of noteItems) {
      const text = item.innerText || '';
      // 优先找完全匹配URL的笔记
      if (text.includes(url)) {
        console.log(`Found note with exact URL match`);
        item.click();
        return 'exact';
      }
    }

    // 如果没找到完全匹配，尝试短链接
    const shortId = url.match(/v\.douyin\.com\/([^/]+)/);
    if (shortId) {
      for (const item of noteItems) {
        const text = item.innerText || '';
        if (text.includes(shortId[1])) {
          console.log(`Found note with short URL match`);
          item.click();
          return 'short';
        }
      }
    }

    // 找今天生成的抖音笔记
    const today = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    for (const item of noteItems) {
      const text = item.innerText || '';
      if ((text.includes('抖音') || text.includes('v.douyin.com')) && text.includes(today)) {
        console.log(`Found today's Douyin note`);
        item.click();
        return 'today';
      }
    }

    return false;
  }, douyinUrl);

  if (clicked) {
    console.log(`已点击笔记项 (${clicked})`);
    // 等待模态框加载
    await page.waitForTimeout(3000);

    // 尝试滚动模态框内容
    await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"], .modal-content, [class*="modal"]');
      if (modal) {
        modal.scrollTop = modal.scrollHeight;
      }
    });
    await page.waitForTimeout(1000);

    return true;
  }

  // 回退：尝试双击第一个长笔记
  try {
    const fallbackClicked = await page.evaluate(() => {
      const noteItems = document.querySelectorAll('.note-list-item, [class*="note-list-item"]');
      for (const item of noteItems) {
        const text = item.innerText || '';
        if (text.length > 500) {
          console.log(`Fallback: clicking note with length ${text.length}`);
          item.click();
          return true;
        }
      }
      return false;
    });

    if (fallbackClicked) {
      console.log('使用回退方式点击了长笔记');
      await page.waitForTimeout(3000);
      return true;
    }
  } catch (e) {
    console.log('回退点击失败:', e.message);
  }

  return false;
}

async function extractNoteContent(page) {
  // 首先尝试滚动页面以确保所有内容加载
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(2000);

  // 尝试多次提取，每次滚动一点
  let bestContent = null;
  let bestLength = 0;

  for (let scrollAttempt = 0; scrollAttempt < 3; scrollAttempt++) {
    try {
      const content = await page.evaluate((attempt) => {
        // 滚动模态框内容
        const modal = document.querySelector('[role="dialog"], .modal-content, [class*="modal"], .note-detail');
        if (modal) {
          modal.scrollTop = attempt * modal.scrollHeight / 3;
        }

        // 优先查找模态框/对话框中的完整内容
        const modalSelectors = [
          '[role="dialog"]',
          '.modal-content',
          '.modal-body',
          '.note-modal',
          '.note-modal-content',
          '[class*="modal"]',
          '[class*="Modal"]'
        ];

        for (const selector of modalSelectors) {
          const modalEl = document.querySelector(selector);
          if (modalEl) {
            const text = modalEl.innerText?.trim() || '';
            const rect = modalEl.getBoundingClientRect();
            const isVisible = rect.width > 100 && rect.height > 100 &&
                             getComputedStyle(modalEl).display !== 'none';
            if (text.length > 500 && isVisible) {
              console.log(`Found modal content with length ${text.length}`);
              return text;
            }
          }
        }

        // 查找笔记详情页面中的内容
        const detailSelectors = [
          '.note-detail',
          '.note-detail-content',
          '.note-view',
          '[class*="noteDetail"]',
          '[class*="note-content"]',
          '[class*="noteView"]'
        ];

        for (const selector of detailSelectors) {
          const detail = document.querySelector(selector);
          if (detail) {
            const text = detail.innerText?.trim() || '';
            if (text.length > 500) {
              console.log(`Found detail content with length ${text.length}`);
              return text;
            }
          }
        }

        // 查找所有笔记列表项
        const noteItems = document.querySelectorAll('.note-list-item, [class*="note-list-item"], .note-item, [class*="noteItem"]');
        let bestItem = null;
        let maxLength = 0;

        if (noteItems.length > 0) {
          console.log(`Found ${noteItems.length} note items`);
          noteItems.forEach((item, index) => {
            const text = item.innerText?.trim() || '';
            const rect = item.getBoundingClientRect();
            const isVisible = rect.width > 100 && rect.height > 100 &&
                             getComputedStyle(item).display !== 'none';
            if (text.length > maxLength && text.length > 300 && isVisible) {
              if (text.includes('v.douyin.com') || text.includes('抖音')) {
                bestItem = text;
                maxLength = text.length;
                console.log(`Selected note item ${index} with length ${text.length}`);
              } else if (!bestItem || text.length > bestItem.length) {
                bestItem = text;
                maxLength = text.length;
              }
            }
          });
        }

        if (bestItem && bestItem.length > 300) {
          return bestItem;
        }

        // 回退：查找包含中文标题的大文本区域
        const allElements = document.querySelectorAll('div, section, article, main');
        let bestElement = null;
        maxLength = 0;

        allElements.forEach(el => {
          if (el.offsetHeight < 100 || el.offsetWidth < 100) return;
          if (getComputedStyle(el).display === 'none') return;

          const text = el.innerText?.trim() || '';
          if (text.length > maxLength && text.length > 500) {
            const excludedPatterns = ['导航', 'Copyright', '登录', '注册', '关于', '帮助'];
            const shouldExclude = excludedPatterns.some(p => text.includes(p) && text.indexOf(p) < 100);
            if (!shouldExclude) {
              maxLength = text.length;
              bestElement = el;
            }
          }
        });

        return bestElement ? bestElement.innerText.trim() : null;
      }, scrollAttempt);

      if (content && content.length > bestLength) {
        bestContent = content;
        bestLength = content.length;
        console.log(`提取尝试 ${scrollAttempt + 1}: 获得 ${content.length} 字符`);
      }
    } catch (e) {
      console.log(`提取尝试 ${scrollAttempt + 1} 失败:`, e.message);
    }

    // 等待一下再下一次提取
    if (scrollAttempt < 2) {
      await page.waitForTimeout(1000);
    }
  }

  if (bestContent && bestLength > 300) {
    console.log(`最佳提取结果: ${bestLength} 字符`);
    return bestContent;
  }

  return null;
}

// 主函数
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('用法: node fetch-douyin-via-biji.js <douyin_url> [--profile=<chrome_profile_path>]');
    console.log('');
    console.log('示例:');
    console.log('  node fetch-douyin-via-biji.js https://v.douyin.com/xxxxx');
    console.log('  node fetch-douyin-via-biji.js https://www.douyin.com/video/1234567890');
    process.exit(1);
  }

  let douyinUrl = args[0];
  let profile = null;

  for (const arg of args) {
    if (arg.startsWith('--profile=')) {
      profile = arg.replace('--profile=', '');
    }
  }

  try {
    const result = await fetchDouyinNote(douyinUrl, { profile });

    if (result.success) {
      if (result.reused) {
        console.log('\n===== 已有笔记 =====');
        console.log(`标题: ${result.note.title}`);
        console.log(`note_id: ${result.note.note_id}`);
        console.log('这是已有的笔记，未生成新笔记');
      } else {
        console.log('\n===== 生成的笔记 =====');
        console.log(`标题: ${result.note.title}`);
        console.log(`内容长度: ${(result.note.content || '').length} 字符`);
      }
      console.log('\n笔记已保存到:', result.filepath);
      console.log('===================');
    } else {
      console.log('获取笔记失败:', result.error);
    }
  } catch (error) {
    console.error('错误:', error.message);
    process.exit(1);
  }
}

module.exports = { fetchDouyinNote };

if (require.main === module) {
  main();
}
