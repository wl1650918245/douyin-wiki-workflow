const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://openapi.biji.com/open/api/v1';

// Get笔记 API 配置（请替换为你自己的 API 凭证）
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

const STATE_FILE = path.join(__dirname, 'raw', 'get笔记', '.sync-state.json');
const NOTES_DIR = path.join(__dirname, 'raw', 'get笔记');

async function extractNoteIdFromFile(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf8');
    const match = content.match(/^note_id: (.+)$/m);
    if (match) {
      // Always return as string to avoid precision issues with large numbers
      return match[1].trim();
    }
  } catch (e) {
    // Ignore errors
  }
  return null;
}

async function initializeStateFromFiles() {
  console.log('Initializing state from existing files...');
  const syncedNoteIds = [];

  if (fs.existsSync(NOTES_DIR)) {
    const files = fs.readdirSync(NOTES_DIR)
      .filter(f => f.match(/^.*\.md$/));

    for (const file of files) {
      const filepath = path.join(NOTES_DIR, file);
      const noteId = await extractNoteIdFromFile(filepath);
      if (noteId !== null) {
        syncedNoteIds.push(noteId);
        console.log(`  Found existing note: ${file} (note_id: ${noteId})`);
      }
    }
  }

  console.log(`Initialized with ${syncedNoteIds.length} existing notes`);
  return { syncedNoteIds, lastSync: new Date().toISOString() };
}

async function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (state.syncedNoteIds && state.syncedNoteIds.length > 0) {
        return state;
      }
    }
  } catch (e) {
    console.log('No previous state found, initializing...');
  }
  return await initializeStateFromFiles();
}

async function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function request(method, path, params, data) {
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
  return request('GET', '/resource/note/list', { since_id });
}

async function saveNoteToFile(note) {
  const noteId = String(note.note_id || note.id);
  const safeTitle = note.title.replace(/[<>:"/\\|?*]/g, '_');
  // 用note_id作为文件名前缀，确保唯一，不会重复
  const filename = `${noteId}-${safeTitle}.md`;
  const filepath = path.join(__dirname, 'raw', 'get笔记', filename);

  // 先删除同note_id的旧文件（可能标题不同的旧版本）
  const existingFiles = fs.readdirSync(path.join(__dirname, 'raw', 'get笔记'))
    .filter(f => f.startsWith(`${noteId}-`));
  for (const oldFile of existingFiles) {
    const oldFilepath = path.join(__dirname, 'raw', 'get笔记', oldFile);
    fs.unlinkSync(oldFilepath);
    console.log(`Removed old version: ${oldFile}`);
  }

  let content = `---
title: ${note.title}
note_id: ${noteId}
note_type: ${note.note_type}
source: Get笔记
created_at: ${note.created_at}
updated_at: ${note.updated_at}
tags: ${note.tags?.map(t => t.name).join(', ') || ''}
---

# ${note.title}

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

  if (note.attachments && note.attachments.length > 0) {
    content += '## 附件\n\n';
    note.attachments.forEach(att => {
      content += `- [${att.title || att.url}](${att.url})\n`;
    });
    content += '\n';
  }

  fs.writeFileSync(filepath, content, 'utf8');
  console.log(`Saved: ${filename}`);
  return filename;
}

async function deduplicateNotes() {
  console.log('\n=== 开始去重检查 ===');
  const noteIdMap = new Map();

  if (fs.existsSync(NOTES_DIR)) {
    const files = fs.readdirSync(NOTES_DIR)
      .filter(f => f.match(/^.*\.md$/));

    for (const file of files) {
      const filepath = path.join(NOTES_DIR, file);
      const noteId = await extractNoteIdFromFile(filepath);
      if (noteId !== null) {
        if (!noteIdMap.has(noteId)) {
          noteIdMap.set(noteId, []);
        }
        noteIdMap.get(noteId).push({ file, mtime: fs.statSync(filepath).mtime });
      }
    }
  }

  let removedCount = 0;
  for (const [noteId, files] of noteIdMap.entries()) {
    if (files.length > 1) {
      console.log(`发现重复笔记 note_id: ${noteId}，共${files.length}个版本`);
      // 按修改时间排序，保留最新的，删除其他的
      files.sort((a, b) => b.mtime - a.mtime);
      const keepFile = files[0];
      const deleteFiles = files.slice(1);

      for (const delFile of deleteFiles) {
        const delFilePath = path.join(NOTES_DIR, delFile.file);
        fs.unlinkSync(delFilePath);
        console.log(`  删除重复文件: ${delFile.file} (保留最新版本: ${keepFile.file})`);
        removedCount++;
      }
    }
  }

  console.log(`去重完成，共删除${removedCount}个重复文件`);
  return noteIdMap;
}

async function main() {
  console.log('=== Get笔记 增量同步 ===');
  console.log('Start time:', new Date().toLocaleString());

  // 先去重
  await deduplicateNotes();

  const state = await loadState();
  const existingIds = new Set(state.syncedNoteIds);

  let since_id = 0;
  let newNotes = [];
  let page = 1;

  while (true) {
    console.log(`Fetching page ${page} (since_id: ${since_id})...`);
    const data = await listNotes(since_id);

    if (!data.notes || data.notes.length === 0) {
      break;
    }

    // Check if we've already seen all these notes
    const batchNewNotes = data.notes.filter(note => {
      const noteId = String(note.note_id || note.id);
      return !existingIds.has(noteId);
    });

    if (batchNewNotes.length === 0) {
      console.log('No new notes in this batch, stopping...');
      break;
    }

    newNotes = newNotes.concat(batchNewNotes);
    console.log(`Found ${batchNewNotes.length} new notes in this page, total: ${newNotes.length}`);

    if (!data.has_more) {
      console.log('No more notes (has_more: false)');
      break;
    }

    // Use note_id for pagination
    if (data.notes.length > 0) {
      const lastNote = data.notes[data.notes.length - 1];
      since_id = lastNote.note_id || lastNote.id;
    }
    page++;

    await new Promise(r => setTimeout(r, 1000));
  }

  if (newNotes.length === 0) {
    console.log('\nNo new notes to sync.');
  } else {
    console.log(`\nFound ${newNotes.length} new notes to sync!`);

    // Save new notes
    for (let i = 0; i < newNotes.length; i++) {
      try {
        const note = newNotes[i];
        const noteId = String(note.note_id || note.id);
        await saveNoteToFile(note);
        existingIds.add(noteId);
      } catch (err) {
        console.error(`Error saving note ${newNotes[i].id}:`, err.message);
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Update state
  state.syncedNoteIds = Array.from(existingIds);
  state.lastSync = new Date().toISOString();
  await saveState(state);

  console.log('\n=== Sync complete ===');
  console.log('End time:', new Date().toLocaleString());
}

main().catch(console.error);
