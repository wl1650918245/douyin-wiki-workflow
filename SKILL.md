---
name: douyin-wiki-workflow
description: 抖音视频自动化抓取工作流，通过 Get笔记 解析视频并存储到 kb-wiki 知识库，支持完整视频列表抓取、视频筛选和自动解析
triggers:
  - "抖音视频抓取"
  - "抓取抖音视频"
  - "抖音博主视频"
  - "douyin fetch"
  - "Get笔记解析"
  - "抖音知识库"
  - "抖音号搜索"
type: automation
version: 2.1.0
author: Claude
created: 2026-04-20
updated: 2026-04-23
platforms:
  - claude
---

# douyin-wiki-workflow

抖音视频自动化抓取工作流技能，将抖音视频内容提取、Get笔记解析、kb-wiki知识库存储整合为一体。

## 核心功能

- **抖音号直接搜索**：无需手动查找 MS4wLj... ID，直接使用抖音号/用户名搜索博主
- **完整视频列表抓取**：通过模拟滚动加载获取博主主页全部视频列表（支持 130+ 视频）
- **视频筛选**：按日期范围和点赞数过滤，获取最新热门视频
- **Get笔记自动解析**：调用 Get笔记 API 将视频转换为带音频转写的笔记
- **kb-wiki 存储**：自动保存到 `raw/get笔记/` 目录
- **分享链接去重**：使用 `v.douyin.com` 短链接格式进行视频去重，避免重复处理

## 工作流程

```
抖音博主主页
  → fetch-by-douyin-id.js 提取视频链接（滚动加载）
  → fetch-douyin-via-biji.js 调用 Get笔记
  → Get笔记 自动解析视频生成文字稿
  → 笔记保存到 raw/get笔记/
```

## 使用方法

### 基础命令

```bash
# 获取最近3天超过1000赞的最新视频
node scripts/fetch-by-douyin-id.js <douyin_id> --days=3 --min-likes=1000 --limit=1
```

### 参数说明

| 参数 | 说明 | 示例 |
|------|------|------|
| `<douyin-id>` | 抖音号或用户名 | `example123`, `bigman1234` |
| `--days=<N>` | 只获取最近N天内的视频 | `--days=7` |
| `--min-likes=<N>` | 最低点赞数过滤 | `--min-likes=1000` |
| `--limit=<N>` | 只获取最近N条视频 | `--limit=5` |
| `--no-skip` | 不跳过已处理视频 | `--no-skip` |
| `--dry` | 预览模式，不实际打开视频 | `--dry` |

### 使用示例

```bash
# 获取任意博主最近7天超过1000赞的视频
node scripts/fetch-by-douyin-id.js example123 --days=7 --min-likes=1000

# 获取最近3天点赞最高的视频
node scripts/fetch-by-douyin-id.js example123 --days=3 --min-likes=1000 --limit=1

# 获取博主全部视频（不过滤）
node scripts/fetch-by-douyin-id.js bigman1234

# 预览模式 - 查看视频列表不处理
node scripts/fetch-by-douyin-id.js bigman1234 --dry
```

## 性能指标

| 指标 | 修复前 | 修复后 | 提升 |
|------|--------|--------|------|
| 视频捕获数 | ~50个 | 134+个 | **+168%** |
| 完成率 | ~36% | 96%+ | **+60%** |
| 滚动稳定性阈值 | 8次 | 15次 | 更完整 |

**关键修复**：稳定性阈值从硬编码 8 次修正为配置变量 15 次，显著提升视频捕获率。

### 视频列表输出格式

运行脚本后，会输出完整的视频列表，包含以下信息：

```
视频列表:
  1. 视频标题 #话题标签
     分享链接: https://v.douyin.com/xxx/
     点赞: 142,000
  2. 视频标题
     分享链接: https://v.douyin.com/xxx/
     点赞: 4,185
```

**关键特性：**
- 使用分享链接 (`v.douyin.com`) 作为唯一标识，便于分享和去重
- 点赞数以千位分隔符格式化显示
- 已处理的视频会标记 `✓ 已处理`
- 支持按点赞数或日期排序输出

## 技术要点

### Obsidian 存储配置

脚本默认将笔记保存到 `raw/get笔记/` 目录。使用前请根据你的 Obsidian vault 路径修改输出目录：

```javascript
// 修改脚本中的 OUTPUT_DIR 为你的路径
const OUTPUT_DIR = '你的Obsidian路径/raw/get笔记/';
```

### URL 要求

**必须使用完整视频链接格式：**
- 正确: `https://www.douyin.com/video/7630837327660584238`
- 错误: `https://v.douyin.com/xxx/` (短链接)

脚本已内置自动转换，使用 `video.videoUrl` 获取完整链接。

### 依赖工具

- **Playwright**: 用于浏览器自动化
- **Chrome**: 反检测模式启动 (`--disable-blink-features=AutomationControlled`)
- **Get笔记**: 视频解析服务 (https://www.biji.com)

### Get笔记 API 配置

```javascript
const BASE_URL = 'https://openapi.biji.com/open/api/v1';
const API_KEY = 'YOUR_API_KEY';  // 从 Get笔记 官网获取
const CLIENT_ID = 'YOUR_CLIENT_ID';  // 从 Get笔记 官网获取
```

## 相关脚本

| 脚本 | 功能 |
|------|------|
| `scripts/fetch-by-douyin-id.js` | 主脚本 - 抖音视频提取（滚动加载） |
| `scripts/fetch-douyin-via-biji.js` | Get笔记集成 - 视频转笔记 |
| `scripts/sync-getnotes.js` | Get笔记同步 |

## 常见问题

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

### 问题3: 视频数量抓不全
**原因**: 稳定性阈值硬编码为 8 次而非配置的 15 次

**解决**: 修改 line 1209 从 `stableCount >= 8` 改为 `stableCount >= stableThreshold`

### 问题4: Chrome 被检测为自动化
**解决**: 使用 `--disable-blink-features=AutomationControlled` 参数

### 问题5: Get笔记同步重复
**原因**: 未记录同步状态

**解决**: 使用 `.sync-state.json` 记录已同步文件

### 问题6: 笔记标题为空
**原因**: API 返回的笔记尚未完全生成

**解决**: 等待更长时间，或检查 Get笔记服务状态

## 扩展阅读

详细的技术文档和工作流图示请参阅：
- `references/detailed-workflow.md` - 完整工作流详解
