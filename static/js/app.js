// ===== IndexedDB：風格樣本庫 =====
const DB_NAME = 'mindiwriter';
const STORE_NAME = 'samples';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(STORE_NAME, { keyPath: 'name' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbCountSamples() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetSamples(maxCount = 5, maxCharsEach = 2000) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const all = req.result;
      // 隨機取樣，每次不同的樣本組合
      const shuffled = all.sort(() => Math.random() - 0.5);
      resolve(shuffled.slice(0, maxCount).map(s => s.content.slice(0, maxCharsEach)));
    };
    req.onerror = () => reject(req.error);
  });
}

async function dbSaveSample(name, content) {
  if (!content.trim()) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    // 若同名已存在就跳過
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
    const check = store.get(name);
    check.onsuccess = () => {
      if (check.result) { resolve(false); return; }
      const put = store.put({ name, content });
      put.onsuccess = () => resolve(true);
      put.onerror = () => reject(put.error);
    };
  });
}

async function dbClearSamples() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', () => {
  loadSavedApiKey();
  refreshSampleCount();
  checkGoogleStatus();
});

// ===== API Key =====
function loadSavedApiKey() {
  const saved = localStorage.getItem('mindi_api_key');
  if (saved) document.getElementById('apiKey').value = saved;
}

function saveApiKey() {
  const key = document.getElementById('apiKey').value.trim();
  if (key) localStorage.setItem('mindi_api_key', key);
}

function toggleApiKey() {
  const input = document.getElementById('apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
}

document.getElementById('apiKey').addEventListener('change', saveApiKey);

// ===== 樣本數量 =====
async function refreshSampleCount() {
  try {
    const count = await dbCountSamples();
    updateSampleCount(count);
  } catch (e) {
    document.querySelector('.sample-count').textContent = '無法取得';
  }
}

function updateSampleCount(count) {
  const el = document.querySelector('.sample-count');
  if (count === 0) {
    el.textContent = '尚未上傳樣本';
    el.style.color = 'var(--text-3)';
  } else {
    el.textContent = `${count} 篇文章`;
    el.style.color = 'var(--success)';
  }
}

async function clearSamples() {
  if (!confirm('確定要清除所有風格樣本嗎？')) return;
  await dbClearSamples();
  updateSampleCount(0);
  showToast('已清除所有樣本', 'success');
}

// ===== 本機資料夾匯入（File System Access API + mammoth.js）=====
async function pickAndScanFolder() {
  if (!window.showDirectoryPicker) {
    showToast('此功能需要 Chrome 或 Edge 瀏覽器', 'error');
    return;
  }

  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (e) {
    // 使用者取消
    return;
  }

  const btn = document.getElementById('scanBtn');
  const progress = document.getElementById('uploadProgress');
  const fill = document.getElementById('progressFill');
  const text = document.getElementById('progressText');

  btn.disabled = true;
  btn.textContent = '⏳ 掃描中...';
  progress.classList.remove('hidden');
  fill.style.width = '5%';
  text.textContent = '正在尋找 .docx 檔案...';

  let success = 0;
  let skipped = 0;
  let total = 0;

  try {
    const docxFiles = [];
    await collectDocxFiles(dirHandle, docxFiles);
    total = docxFiles.length;

    if (total === 0) {
      showToast('此資料夾內沒有 .docx 檔案', 'error');
      return;
    }

    text.textContent = `找到 ${total} 個 .docx，開始轉換...`;

    for (let i = 0; i < docxFiles.length; i++) {
      const { name, handle } = docxFiles[i];
      try {
        const file = await handle.getFile();
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        const content = result.value.trim();
        if (content) {
          const saved = await dbSaveSample(name, content);
          if (saved) success++;
          else skipped++;
        }
      } catch (e) {
        // 個別檔案失敗不中斷
      }

      const pct = Math.round(((i + 1) / total) * 100);
      fill.style.width = pct + '%';
      text.textContent = `[${i + 1}/${total}] 已匯入 ${success} 篇，略過 ${skipped} 篇`;
    }

    const finalCount = await dbCountSamples();
    updateSampleCount(finalCount);
    showToast(`完成！匯入 ${success} 篇，略過 ${skipped} 篇`, 'success');
    fill.style.width = '100%';
    text.textContent = `完成！共 ${total} 篇，匯入 ${success} 篇，略過 ${skipped} 篇`;

    setTimeout(() => {
      progress.classList.add('hidden');
      fill.style.width = '0%';
    }, 4000);

  } catch (e) {
    showToast('匯入失敗：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📂 從本機資料夾匯入 .docx';
  }
}

async function collectDocxFiles(dirHandle, result) {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.docx')) {
      result.push({ name: entry.name.replace(/\.docx$/i, ''), handle: entry });
    } else if (entry.kind === 'directory') {
      await collectDocxFiles(entry, result);
    }
  }
}

// ===== Google Drive =====
let _googleAccessToken = null;
let _googleTokenExpiry = 0;

function checkGoogleStatus() {
  const clientId = localStorage.getItem('mindi_google_client_id');
  const stepCred = document.getElementById('stepCredentials');
  const stepAuth = document.getElementById('stepAuth');
  const stepImport = document.getElementById('stepImport');
  const status = document.getElementById('gdriveStatus');

  if (clientId) {
    document.getElementById('googleClientId').value = clientId;
  }

  const hasToken = _googleAccessToken && Date.now() < _googleTokenExpiry;

  if (!clientId) {
    stepCred.classList.remove('hidden');
    stepAuth.classList.add('hidden');
    stepImport.classList.add('hidden');
    status.textContent = '';
  } else if (!hasToken) {
    stepCred.classList.add('hidden');
    stepAuth.classList.remove('hidden');
    stepImport.classList.add('hidden');
    status.textContent = '待授權';
  } else {
    stepCred.classList.add('hidden');
    stepAuth.classList.add('hidden');
    stepImport.classList.remove('hidden');
    status.textContent = '已連接';
  }
}

function saveClientId() {
  const id = document.getElementById('googleClientId').value.trim();
  if (!id || !id.includes('.apps.googleusercontent.com')) {
    showToast('請輸入正確格式的 Client ID', 'error');
    return;
  }
  localStorage.setItem('mindi_google_client_id', id);
  showToast('Client ID 已儲存', 'success');
  checkGoogleStatus();
}

function startGoogleAuth() {
  const clientId = localStorage.getItem('mindi_google_client_id');
  if (!clientId) { showToast('請先儲存 Client ID', 'error'); return; }

  if (!window.google) {
    showToast('Google 驗證套件尚未載入，請稍後再試', 'error');
    return;
  }

  const btn = document.getElementById('authBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 等待授權...';

  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    callback: (tokenResponse) => {
      btn.disabled = false;
      btn.textContent = '🔗 授權連接';
      if (tokenResponse.error) {
        showToast('授權失敗：' + tokenResponse.error, 'error');
        return;
      }
      _googleAccessToken = tokenResponse.access_token;
      _googleTokenExpiry = Date.now() + (tokenResponse.expires_in - 60) * 1000;
      checkGoogleStatus();
      showToast('Google 授權成功！', 'success');
    },
  });

  tokenClient.requestAccessToken();
}

function disconnectGoogle() {
  _googleAccessToken = null;
  _googleTokenExpiry = 0;
  checkGoogleStatus();
  showToast('已斷開 Google 連接', '');
}

function getAccessToken() {
  if (!_googleAccessToken || Date.now() >= _googleTokenExpiry) {
    showToast('Google 授權已過期，請重新授權', 'error');
    _googleAccessToken = null;
    checkGoogleStatus();
    return null;
  }
  return _googleAccessToken;
}

// ===== Google Drive 資料夾選擇器 =====
let selectedFolderId = '';
let selectedFolderDisplayName = '整個 Google Drive';
let folderNavStack = [{ id: 'root', name: '整個 Drive' }];

async function openFolderPicker() {
  document.getElementById('folderModal').classList.remove('hidden');
  folderNavStack = [{ id: 'root', name: '整個 Drive' }];
  await loadFolders('root');
}

function closeFolderPicker() {
  document.getElementById('folderModal').classList.add('hidden');
}

async function loadFolders(parentId) {
  const list = document.getElementById('folderList');
  list.innerHTML = '<div class="folder-loading">載入中...</div>';
  renderBreadcrumb();

  const token = getAccessToken();
  if (!token) { list.innerHTML = '<div class="folder-empty">請先授權 Google Drive</div>'; return; }

  try {
    const q = encodeURIComponent(`'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&orderBy=name&pageSize=200`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.error) { list.innerHTML = `<div class="folder-empty">${data.error.message}</div>`; return; }
    const folders = data.files || [];
    if (folders.length === 0) {
      list.innerHTML = '<div class="folder-empty">此資料夾內沒有子資料夾</div>';
      return;
    }
    list.innerHTML = folders.map(f => `
      <div class="folder-item ${selectedFolderId === f.id ? 'selected' : ''}" id="fi-${f.id}" onclick="selectFolder('${f.id}', '${f.name.replace(/'/g, "\\'")}')">
        <span class="folder-item-name">📁 ${f.name}</span>
        <button class="folder-open-btn" onclick="event.stopPropagation(); enterFolder('${f.id}', '${f.name.replace(/'/g, "\\'")}')">進入 ›</button>
      </div>`).join('');
  } catch (e) {
    list.innerHTML = `<div class="folder-empty">載入失敗：${e.message}</div>`;
  }
}

function selectFolder(id, name) {
  selectedFolderId = id;
  selectedFolderDisplayName = folderNavStack.map(f => f.name).concat(name).join(' / ');
  document.querySelectorAll('.folder-item').forEach(el => el.classList.remove('selected'));
  const el = document.getElementById(`fi-${id}`);
  if (el) el.classList.add('selected');
}

async function enterFolder(id, name) {
  folderNavStack.push({ id, name });
  await loadFolders(id);
}

async function navigateFolder(id, name) {
  const idx = folderNavStack.findIndex(f => f.id === id);
  if (idx >= 0) folderNavStack = folderNavStack.slice(0, idx + 1);
  else folderNavStack = [{ id, name }];
  if (id === 'root') selectedFolderId = '';
  await loadFolders(id);
}

function renderBreadcrumb() {
  const bc = document.getElementById('folderBreadcrumb');
  bc.innerHTML = folderNavStack.map((f, i) =>
    `<button class="crumb" onclick="navigateFolder('${f.id}', '${f.name.replace(/'/g, "\\'")}')">${f.name}</button>`
    + (i < folderNavStack.length - 1 ? '<span class="crumb-sep">›</span>' : '')
  ).join('');
}

function confirmFolder() {
  const currentFolder = folderNavStack[folderNavStack.length - 1];
  if (!selectedFolderId && currentFolder.id !== 'root') {
    selectedFolderId = currentFolder.id;
    selectedFolderDisplayName = folderNavStack.map(f => f.name).join(' / ');
  }
  const label = selectedFolderId
    ? `📁 ${selectedFolderDisplayName.split(' / ').pop()}`
    : '📁 整個 Google Drive';
  document.getElementById('selectedFolderName').textContent = label;
  closeFolderPicker();
}

// ===== Google Drive 匯入 =====
async function importFromDrive() {
  const token = getAccessToken();
  if (!token) return;

  const btn = document.getElementById('importBtn');
  const progress = document.getElementById('uploadProgress');
  const fill = document.getElementById('progressFill');
  const text = document.getElementById('progressText');

  btn.disabled = true;
  btn.textContent = '⏳ 匯入中...';
  progress.classList.remove('hidden');
  fill.style.width = '5%';
  text.textContent = '連接 Google Drive...';

  let success = 0;
  let skipped = 0;
  let current = 0;

  try {
    const rootId = selectedFolderId || 'root';
    text.textContent = '開始搜尋文件...';

    for await (const doc of iterateDriveDocs(rootId, token)) {
      current++;
      const pct = Math.min(5 + current * 0.5, 95);
      fill.style.width = pct + '%';

      try {
        // 先檢查是否已存在
        const db = await openDB();
        const existing = await new Promise(r => {
          const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(doc.name);
          req.onsuccess = () => r(req.result);
        });
        if (existing) {
          skipped++;
          text.textContent = `[略過] ${doc.name}　匯入 ${success}，略過 ${skipped}`;
          continue;
        }

        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${doc.id}/export?mimeType=text/plain`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) { text.textContent = `[失敗] ${doc.name}`; continue; }
        const content = (await res.text()).trim();
        if (content) {
          await dbSaveSample(doc.name, content);
          success++;
          text.textContent = `[✓] ${doc.name}　已匯入 ${success} 篇`;
        }
      } catch (e) {
        text.textContent = `[失敗] ${doc.name}`;
      }
    }

    fill.style.width = '100%';
    text.textContent = `完成！共 ${current} 篇，匯入 ${success} 篇，略過 ${skipped} 篇`;
    const finalCount = await dbCountSamples();
    updateSampleCount(finalCount);
    showToast(`成功匯入 ${success} 篇 Google Docs`, 'success');
    setTimeout(() => { progress.classList.add('hidden'); fill.style.width = '0%'; }, 4000);

  } catch (e) {
    showToast('匯入失敗：' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '☁️ 開始匯入';
  }
}

async function* iterateDriveDocs(parentId, token) {
  // 先 yield 這層的 Google Docs
  let pageToken = null;
  do {
    const q = encodeURIComponent(`'${parentId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name)&pageSize=100${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    for (const doc of (data.files || [])) yield doc;
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  // 再遞迴子資料夾
  const q2 = encodeURIComponent(`'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const subRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q2}&fields=files(id,name)&pageSize=200`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const subData = await subRes.json();
  for (const sub of (subData.files || [])) {
    yield* iterateDriveDocs(sub.id, token);
  }
}

function showSetupGuide() { document.getElementById('setupModal').classList.remove('hidden'); }
function hideSetupGuide() { document.getElementById('setupModal').classList.add('hidden'); }

// ===== Anthropic API 直接呼叫 =====
async function callClaude(apiKey, model, systemPrompt, messages, onText, onDone, onError) {
  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-allow-browser': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        stream: true,
        system: systemPrompt,
        messages,
      })
    });
  } catch (e) {
    onError('網路錯誤：' + e.message);
    return;
  }

  if (!response.ok) {
    try {
      const err = await response.json();
      if (response.status === 401) onError('API Key 無效，請確認後重試');
      else onError(err.error?.message || `請求失敗（${response.status}）`);
    } catch {
      onError(`請求失敗（${response.status}）`);
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (!dataStr) continue;
        try {
          const data = JSON.parse(dataStr);
          if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
            onText(data.delta.text);
          } else if (data.type === 'message_stop') {
            onDone();
          } else if (data.type === 'error') {
            onError(data.error?.message || '生成失敗');
          }
        } catch (e) { /* 忽略解析錯誤 */ }
      }
    }
  } catch (e) {
    onError(e.message);
  }
}

// ===== System Prompt 建構 =====
function buildSystemPrompt(samples) {
  let prompt = `你是「敏迪選讀」的寫手，請模仿以下風格特徵來撰寫文章：

## 敏迪選讀風格特徵

**語氣與口吻：**
- 像朋友聊天般親切、自然，用「我們」拉近距離
- 有溫度、有個性，不是冷冰冰的新聞播報
- 偶爾會說「好，我來解釋一下」「你可能會問」「簡單來說就是」
- 用「欸」「其實」「說真的」「你知道嗎」等口語詞增加親近感

**結構與格式：**
- 段落短，每段 2-4 句話，閱讀節奏快
- 開頭要抓眼球，直接點出最重要或最有趣的點
- 善用比喻把複雜概念變簡單
- 結尾通常有一個小結論或引發思考的句子
- 適當使用換行留白，讓版面呼吸

**內容處理：**
- 把國際或複雜新聞翻譯成台灣人看得懂的語言
- 點出「這件事為什麼重要」「這跟我有什麼關係」
- 加入背景脈絡，但不會太學術
- 數字和專有名詞會簡化說明

**不要做的事：**
- 不用正式新聞稿的語氣
- 不要太長的句子
- 不要用太多艱澀詞彙
- 不要忘記加入個人觀點和溫度
`;

  if (samples.length > 0) {
    prompt += '\n\n## 以下是敏迪選讀的實際文章範本，請參考其寫作風格：\n\n';
    samples.forEach((s, i) => {
      prompt += `---【範本 ${i + 1}】---\n${s}\n\n`;
    });
  }
  return prompt;
}

// ===== 語氣 & 格式 =====
const toneLabels = { 1: '很嚴肅', 2: '嚴肅', 3: '正常', 4: '輕鬆', 5: '很輕鬆' };
const toneInstructions = {
  1: '語氣要非常嚴肅、專業，像深度評論，不用口語詞，保持客觀理性。',
  2: '語氣偏嚴肅，可以有少量口語，但整體保持專業感。',
  3: '語氣正常，維持敏迪一貫的親切但有深度的風格。',
  4: '語氣輕鬆，多用口語，像跟朋友聊天，可以加點幽默。',
  5: '語氣非常輕鬆活潑，大量口語，可以用「欸」「哇」「真的假的」等詞，帶點趣味感。',
};
const formatInstructions = {
  mindi: '【格式：敏迪斷行】每一句話單獨一行，段落之間空一行。節奏要快，短句為主，讓人一眼就能讀完一句。',
  normal: '【格式：正常文章】每段 3-5 句話，句子可以稍長，段落之間空一行。閱讀感受像在讀一篇完整的評論文章。',
};
let currentFormat = 'mindi';

function updateToneLabel() {
  const val = document.getElementById('toneSlider').value;
  document.getElementById('toneLabel').textContent = toneLabels[val];
}

function setFormat(fmt) {
  currentFormat = fmt;
  document.getElementById('fmtMindi').classList.toggle('active', fmt === 'mindi');
  document.getElementById('fmtNormal').classList.toggle('active', fmt === 'normal');
}

// ===== 生成文章 =====
async function generateArticle() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const title = document.getElementById('titleInput').value.trim();
  const newsContent = document.getElementById('newsInput').value.trim();
  const sampleCount = parseInt(document.getElementById('sampleCount').value);
  const model = document.getElementById('modelSelect').value;
  const tone = parseInt(document.getElementById('toneSlider').value);
  const wordCount = parseInt(document.getElementById('wordCountInput').value) || 2000;

  if (!apiKey) { showToast('請先輸入 API Key', 'error'); return; }
  if (!title) { showToast('請填寫文章標題', 'error'); return; }
  if (!newsContent) { showToast('請填寫新聞內容', 'error'); return; }

  saveApiKey();

  const btn = document.getElementById('generateBtn');
  const outputArea = document.getElementById('outputArea');
  const outputActions = document.getElementById('outputActions');

  btn.disabled = true;
  btn.innerHTML = '<span class="btn-icon-left">⏳</span>生成中...';
  outputArea.className = 'output-area generating';
  outputArea.textContent = '';
  outputActions.style.display = 'none';

  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  outputArea.appendChild(cursor);

  const samples = await dbGetSamples(sampleCount);
  const systemPrompt = buildSystemPrompt(samples);
  const userMessage = `請根據以下新聞內容，用敏迪選讀的風格寫一篇文章。

**文章標題：**${title}

**新聞原文：**
${newsContent}

**語氣要求：**${toneInstructions[tone]}

**格式要求：**${formatInstructions[currentFormat]}

**字數限制：**全文控制在 ${wordCount} 字以內，寧可精簡也不要超字。

請記得：
- 解釋清楚「這件事為什麼重要」
- 加入適當的比喻或生活化的說法
- 結尾要有力量`;

  let outputText = '';

  await callClaude(
    apiKey, model, systemPrompt,
    [{ role: 'user', content: userMessage }],
    (text) => {
      outputText += text;
      outputArea.textContent = outputText;
      outputArea.appendChild(cursor);
      outputArea.scrollTop = outputArea.scrollHeight;
    },
    () => {
      cursor.remove();
      outputArea.className = 'output-area';
      outputActions.style.display = 'flex';
      conversationHistory = [{ role: 'assistant', content: outputText }];
      document.getElementById('feedbackInput').focus();
      btn.disabled = false;
      btn.innerHTML = '<span class="btn-icon-left">✨</span>生成文章';
    },
    (errMsg) => {
      cursor.remove();
      outputArea.className = 'output-area';
      outputArea.innerHTML = `<div style="color: var(--danger)">❌ 錯誤：${errMsg}</div>`;
      showToast(errMsg, 'error');
      btn.disabled = false;
      btn.innerHTML = '<span class="btn-icon-left">✨</span>生成文章';
    }
  );
}

// ===== 回饋修改 =====
let conversationHistory = [];

function handleFeedbackKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendFeedback();
  }
}

async function sendFeedback() {
  const feedback = document.getElementById('feedbackInput').value.trim();
  if (!feedback) return;

  const apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey) { showToast('請先輸入 API Key', 'error'); return; }

  const btn = document.getElementById('feedbackBtn');
  const outputArea = document.getElementById('outputArea');

  btn.disabled = true;
  btn.textContent = '修改中...';
  document.getElementById('feedbackInput').value = '';

  conversationHistory.push({ role: 'user', content: feedback });

  outputArea.className = 'output-area generating';
  outputArea.textContent = '';
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  outputArea.appendChild(cursor);

  let newArticle = '';

  await callClaude(
    apiKey,
    'claude-opus-4-6',
    '你是「敏迪選讀」的寫手。使用者會給你一篇已生成的文章，以及修改意見。請根據意見修改文章，保持敏迪選讀的風格，輸出完整的修改後文章。',
    conversationHistory.slice(0, -1).concat([{ role: 'user', content: feedback }]),
    (text) => {
      newArticle += text;
      outputArea.textContent = newArticle;
      outputArea.appendChild(cursor);
      outputArea.scrollTop = outputArea.scrollHeight;
    },
    () => {
      cursor.remove();
      outputArea.className = 'output-area';
      conversationHistory.push({ role: 'assistant', content: newArticle });
      btn.disabled = false;
      btn.textContent = '送出';
    },
    (errMsg) => {
      cursor.remove();
      outputArea.className = 'output-area';
      showToast('修改失敗：' + errMsg, 'error');
      btn.disabled = false;
      btn.textContent = '送出';
    }
  );
}

// ===== 其他功能 =====
function clearAll() {
  document.getElementById('titleInput').value = '';
  document.getElementById('newsInput').value = '';
  const outputArea = document.getElementById('outputArea');
  outputArea.className = 'output-area';
  outputArea.innerHTML = `
    <div class="output-placeholder">
      <div class="placeholder-icon">✍️</div>
      <p>填寫左側的標題和新聞內容，<br>按下「生成文章」就會在這裡出現敏迪風格的文章</p>
    </div>`;
  document.getElementById('outputActions').style.display = 'none';
  document.getElementById('feedbackInput').value = '';
  conversationHistory = [];
}

async function copyOutput() {
  const text = document.getElementById('outputArea').textContent;
  try {
    await navigator.clipboard.writeText(text);
    showToast('已複製到剪貼簿', 'success');
  } catch (e) {
    showToast('複製失敗', 'error');
  }
}

// ===== Toast 通知 =====
let toastTimer;
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast hidden'; }, 3000);
}
