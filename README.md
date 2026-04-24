# douyin-wiki-workflow

抖音视频自动化抓取工作流，通过 Get笔记 解析视频并存储到 kb-wiki 知识库。

## 功能特点

- **抖音号直接搜索**：无需手动查找 MS4wLj... ID，直接使用抖音号/用户名搜索
- **完整视频列表抓取**：模拟滚动加载获取博主主页全部视频（支持 130+ 视频，96%+ 完成率）
- **按条件筛选**：支持按日期范围和点赞数过滤热门视频
- **Get笔记自动解析**：将视频转换为带音频转写的笔记
- **自动保存**：笔记存储到 `raw/get笔记/` 目录

## 工作原理

```
抖音博主主页 → 滚动加载全部视频 → 筛选 → Get笔记解析 → 保存笔记
```

## 安装

将此技能文件夹放入 Claude Code 的 skills 目录：

```bash
# 或创建符号链接
ln -s /path/to/douyin-wiki-workflow ~/.claude/skills/douyin-wiki-workflow
```

## 使用方法

### 命令格式

```bash
node scripts/fetch-by-douyin-id.js <douyin_id> --days=N --min-likes=N --limit=N
```

### 参数说明

| 参数 | 说明 | 示例 |
|------|------|------|
| `douyin-id` | 抖音号或用户名 | `example123`, `bigman1234` |
| `--days` | 最近N天内的视频 | `--days=3` |
| `--min-likes` | 最低点赞数 | `--min-likes=1000` |
| `--limit` | 获取最近N条 | `--limit=5` |
| `--dry` | 预览模式 | `--dry` |
| `--no-skip` | 不跳过已处理视频 | `--no-skip` |

### 示例

```bash
# 获取任意博主最近7天超过1000赞的视频
node scripts/fetch-by-douyin-id.js example123 --days=7 --min-likes=1000

# 获取最近3天点赞最高的1条视频
node scripts/fetch-by-douyin-id.js example123 --days=3 --min-likes=1000 --limit=1

# 获取博主全部视频（预览模式）
node scripts/fetch-by-douyin-id.js bigman1234 --dry
```

## 性能对比

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 视频捕获数 | ~50个 | 134+个 |
| 完成率 | ~36% | 96%+ |
| 滚动稳定性阈值 | 8次 | 15次 |

## 依赖

- Node.js
- Playwright
- Chrome 浏览器
- Get笔记 账号
- Obsidian 知识库（需配置存储路径）

## 配置

### Obsidian 存储路径

脚本默认将笔记保存到 `raw/get笔记/` 目录。如需使用其他路径，请修改脚本中的输出目录设置：

```javascript
// 在脚本中设置你的 Obsidian vault 路径
const OUTPUT_DIR = '你的Obsidian路径/raw/get笔记/';
```

### Get笔记 API

需要在 Get笔记官网获取 API 凭证，配置在脚本中：

```javascript
const API_KEY = 'YOUR_API_KEY';
const CLIENT_ID = 'YOUR_CLIENT_ID';
```

## 相关脚本

- `scripts/fetch-by-douyin-id.js` - 主脚本（视频提取+滚动加载）
- `scripts/fetch-douyin-via-biji.js` - Get笔记集成
- `scripts/sync-getnotes.js` - Get笔记同步

## 故障排查

### 视频数量抓不全
- 检查稳定性阈值设置（应为 15 次而非 8 次）
- 确保网络稳定

### Get笔记未自动解析
- 检查扩展是否开启"自动解析"
- 手动点击扩展图标
- 等待视频加载完成

### Chrome 被检测
- 使用反检测参数启动
- 检查 Chrome 路径配置

详细技术文档见 `references/detailed-workflow.md`