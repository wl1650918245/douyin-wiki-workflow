# 抖音视频抓取工作流 - 详细技术文档

> **注意**: `kb-wiki` 是本项目的 Obsidian vault 路径示例。使用前请根据你的 Obsidian vault 路径修改输出目录。

## 概述

本文档详细介绍抖音视频自动化抓取工作流的技术实现，包括 Playwright 浏览器自动化、Get笔记 API 集成、状态管理等核心组件。

## 完整架构

```
┌─────────────────────────────────────────────────────────────────┐
│  fetch-by-douyin-id.js                                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Step 1: 初始化 Chrome 浏览器                                   │
│          └─→ playwright.launch()                               │
│          └─→ 设置反检测参数                                       │
│                                                                  │
│  Step 2: 打开抖音首页                                           │
│          └─→ page.goto('https://www.douyin.com')               │
│                                                                  │
│  Step 3: 搜索博主                                               │
│          └─→ 输入抖音号到搜索框                                  │
│          └─→ 点击"用户"标签                                     │
│          └─→ 选择正确的博主卡片                                  │
│                                                                  │
│  Step 4: 进入博主主页                                           │
│          └─→ 点击博主卡片进入主页                                │
│          └─→ 滚动加载视频列表（多容器滚动）                     │
│                                                                  │
│  Step 5: 提取视频信息                                           │
│          └─→ 获取视频链接、标题、日期、点赞数                    │
│          └─→ 应用日期和点赞数过滤                               │
│                                                                  │
│  Step 6: 处理每个视频                                          │
│          └─→ 调用 fetch-douyin-via-biji.js                     │
│          └─→ 通过 Get笔记解析视频                               │
│          └─→ 保存笔记到 raw/get笔记/                           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 核心脚本详解

### fetch-by-douyin-id.js

**功能**：提取抖音博主主页的视频列表，支持按日期和点赞数过滤。

**视频选择器**：
```javascript
// 视频容器 - 遍历所有 li 元素
document.querySelectorAll('li').forEach(li => {
  const link = li.querySelector('a[href*="/video/"]');
});

// 点赞数元素
const likeEl = li.querySelector('[class*="author-card-user-video-like"]');

// 标题元素
const titleEl = li.querySelector('p');
```

**视频信息结构**：
```javascript
const videoInfo = {
  videoId: "7612947951555480851",
  videoUrl: "https://www.douyin.com/video/7612947951555480851",
  shareUrl: "https://v.douyin.com/7612947951555480851/",
  title: "视频标题",
  date: "2024-01-15",
  likes: 36000
};
```

### 滚动加载机制

抖音页面使用虚拟化渲染，只在 DOM 中保留视口内可见的视频。通过模拟滚动加载触发更多视频的渲染。

**滚动策略**：
1. **多容器滚动**：依次尝试滚动 mainScroll、videoContainer、window
2. **wheelEvent 模拟**：使用 `deltaY: 600` 模拟真实用户滚动
3. **随机延迟**：每次滚动后等待 300-500ms 模拟真实用户

**稳定性检测**：
```javascript
const stableThreshold = 15;  // 连续 15 次无变化则判定为稳定
let stableCount = 0;

if (newCount === currentCount) {
  stableCount++;
  if (stableCount >= stableThreshold) {
    console.log(`视频数量已稳定，共${currentCount}个视频`);
    break;
  }
} else {
  stableCount = 0;
}
```

> **重要修复**：稳定性阈值必须使用变量 `stableThreshold`（15次），而非硬编码的 8。硬编码会导致提前终止，遗漏大量视频。

## API 配置

### Get笔记 API

```javascript
const BASE_URL = 'https://openapi.biji.com/open/api/v1';

// 请替换为你自己的 API 凭证（从 Get笔记 官网获取）
const API_KEY = 'YOUR_API_KEY';
const CLIENT_ID = 'YOUR_CLIENT_ID';

// 获取笔记列表
GET /resource/note/list?since_id=0
```

> **重要**: API 凭证需要从 Get笔记 官网购买后获取，切勿使用他人的凭证。

### API 响应格式

```json
{
  "data": {
    "notes": [
      {
        "id": "1907709813363377680",
        "title": "短视频底层逻辑深度解析",
        "content": "完整内容...",
        "source_url": "https://www.douyin.com/video/...",
        "created_at": 1713580800,
        "sync_status": "completed"
      }
    ],
    "has_more": true,
    "next_since_id": "123456"
  }
}
```

## 同步状态管理

### 状态文件位置

`raw/get笔记/.sync-state.json`

### 状态文件格式

```json
{
  "syncedNoteIds": ["123456", "789012"],
  "lastSync": "2026-04-19T10:35:00.000Z"
}
```

### 去重逻辑

1. 先通过 API 检查链接是否已有笔记
2. 记录已同步的 note_id
3. 轮询时跳过已存在的笔记

## 反检测措施

与抖音抓取相同的反检测策略：

```javascript
// 设置 navigator 属性
await page.evaluate(() => {
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false
  });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5]
  });
  Object.defineProperty(navigator, 'languages', {
    get: () => ['zh-CN', 'zh', 'en-US', 'en']
  });
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => 8
  });
});

// 禁用 console.debug
await page.evaluate(() => {
  console.debug = () => {};
});

// Chrome 启动参数
--disable-blink-features=AutomationControlled
```

## 等待生成策略

| 阶段 | 等待时间 | 说明 |
|------|---------|------|
| 前期 | 1.5秒/次 | 快速轮询（10次） |
| 后期 | 3秒/次 | 正常轮询（10次） |
| 总计 | 最多60次 | 约3分钟超时 |

```javascript
async function waitForNoteGeneration() {
  for (let i = 0; i < 60; i++) {
    // 检测加载状态
    const isLoading = await checkLoadingStatus();

    if (isLoading === 'done') {
      return true;
    }

    // 等待时间递增
    const waitTime = i < 10 ? 1500 : 3000;
    await sleep(waitTime);
  }
  return false;
}
```

## 笔记保存格式

保存到 `raw/get笔记/douyin_YYYYMMDD_标题.md`：

```markdown
---
title: 视频标题
note_id: 12345678
note_type: link
source: Get笔记
created_at: 2026-04-19 10:30:00
updated_at: 2026-04-19 10:35:00
tags: AI链接笔记
---

视频摘要内容...

## 网页原文

完整的网页内容...

## 音频转写

音频转写文本...
```

## 性能指标

### 修复前后对比

| 指标 | 修复前 | 修复后 | 提升 |
|------|--------|--------|------|
| 视频捕获数 | ~50个 | 134+个 | **+168%** |
| 完成率 | ~36% | 96%+ | **+60%** |
| 滚动稳定性阈值 | 硬编码8 | 变量15 | 正确配置 |

### 修复内容

**问题**：第 1209 行使用硬编码 `stableCount >= 8`，导致滚动提前终止。

**修复**：改为 `stableCount >= stableThreshold`，使用配置的 15 次阈值。

```javascript
// 修复前（错误）
if (stableCount >= 8) {
  console.log(`  视频数量已稳定...`);
  break;
}

// 修复后（正确）
if (stableCount >= stableThreshold) {
  console.log(`  视频数量已稳定...`);
  break;
}
```

## 故障排查

### 问题1: Get笔记没有自动解析

**可能原因**:
- Get笔记扩展未开启"自动解析"
- 视频格式不支持
- 网络问题

**解决**:
1. 检查 Get笔记设置
2. 手动点击扩展图标解析
3. 等待视频加载完成

### 问题2: 滚动后视频数为 0

**原因**: DOM 选择器错误

**解决**: 使用 `li` + `a[href*="/video/"]` 选择器

### 问题3: 点赞数为 0

**原因**: 选择器用了 `class*="like"` 而非 `class*="author-card-user-video-like"`

**解决**: 参考脚本中的正确选择器

### 问题4: Chrome 被检测为自动化

**解决**: 使用 `--disable-blink-features=AutomationControlled` 参数

### 问题5: Get笔记同步重复

**原因**: 未记录同步状态

**解决**: 使用 `.sync-state.json` 记录已同步文件

### 问题6: 笔记标题为空

**原因**: API 返回的笔记尚未完全生成

**解决**: 等待更长时间，或检查 Get笔记服务状态

### 问题7: 视频数量抓不全（最重要）

**原因**: 稳定性阈值硬编码为 8 而非 15

**症状**: 只能抓取 ~50 个视频，而页面显示有 130+ 个

**解决**:
1. 检查 line 1209 附近代码
2. 确认使用的是 `stableThreshold` 变量而非硬编码数字
3. 如果仍是 8，修改为 `stableCount >= stableThreshold`

## 文件位置

```
<你的Obsidian路径>\
├── scripts/
│   ├── fetch-by-douyin-id.js      # 抖音视频提取（主脚本）
│   ├── fetch-douyin-via-biji.js  # Get笔记集成
│   └── sync-getnotes.js           # Get笔记同步
└── raw/
    └── get笔记/               # Get笔记笔记存储
        └── .sync-state.json  # 同步状态
```
