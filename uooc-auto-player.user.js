// ==UserScript==
// @name         Fast UOOC
// @namespace    fastuooc.local
// @version      0.6.5
// @description  自动控制UOOC视频播放，导出测验题目，并提供仅供参考的AI选项分析。
// @author       Liunian06
// @license      MIT
// @match        *://www.uooc.net.cn/home/learn/*
// @match        *://*.uooc.net.cn/home/learn/*
// @match        *://*.uooconline.com/home/learn/*
// @match        *://*.uooc.online/home/learn/*
// @match        *://www.uooc.net.cn/exam/*
// @match        *://*.uooc.net.cn/exam/*
// @match        *://*.uooconline.com/exam/*
// @match        *://*.uooc.online/exam/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const SCRIPT_VERSION = '0.6.5';
  const LOG_PREFIX = '[Fast UOOC v' + SCRIPT_VERSION + ']';
  const CONFIG_KEY = 'fastuooc:auto-player:config';
  const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    autoPlay: true,
    speed: 2,
    muted: true,
    autoNext: true,
    keepBackground: true,
    theme: 'system',
    nextDelay: 1200,
    aiBaseUrl: '',
    aiApiKey: '',
    aiModel: '',
    aiTimeout: 45000,
  });
  const AI_MAX_CONCURRENCY = 10;

  const state = {
    config: loadConfig(),
    video: null,
    player: null,
    videoGeneration: 0,
    handledErrors: new Set(),
    attemptedSources: new Set(),
    lastRoute: location.href,
    navigating: false,
    statusTimer: null,
    nextRun: 0,
    intendedPlayback: false,
    backgroundGuardTimer: null,
    patchedVideoService: null,
    unitSourcePromises: new WeakMap(),
    catalogRequestCount: 0,
    aiQueue: { active: 0, pending: [] },
    aiResults: new WeakMap(),
    aiRunning: false,
  };

  function loadConfig() {
    try {
      const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
      const legacyApiKey = stored.aiApiKey || '';
      delete stored.aiApiKey;
      if (legacyApiKey) localStorage.setItem(CONFIG_KEY, JSON.stringify(stored));
      const config = Object.assign({}, DEFAULT_CONFIG, stored);
      try {
        config.aiApiKey = (typeof GM_getValue === 'function' && GM_getValue('fastuooc:ai-api-key', '')) || legacyApiKey;
      } catch (_) {
        config.aiApiKey = legacyApiKey;
      }
      return config;
    } catch (_) {
      return Object.assign({}, DEFAULT_CONFIG, { aiApiKey: '' });
    }
  }

  function saveConfig() {
    const stored = Object.assign({}, state.config);
    delete stored.aiApiKey;
    localStorage.setItem(CONFIG_KEY, JSON.stringify(stored));
    try {
      if (typeof GM_setValue === 'function') GM_setValue('fastuooc:ai-api-key', state.config.aiApiKey || '');
    } catch (_) {
      logWarning('保存AI API Key失败');
    }
  }

  function enforceMasterConfig() {
    if (!state.config.enabled) return false;
    const changed = !state.config.autoNext || !state.config.muted || !state.config.keepBackground;
    state.config.autoNext = true;
    state.config.muted = true;
    state.config.keepBackground = true;
    return changed;
  }

  function writeLog(level, ...args) {
    const normalizedLevel = String(level || 'info').toLowerCase();
    const method = typeof console[normalizedLevel] === 'function' ? console[normalizedLevel] : console.log;
    const levelLabel = '[' + normalizedLevel.toUpperCase() + ']';
    method.call(console, LOG_PREFIX + levelLabel, new Date().toISOString(), ...args);
  }

  function log(...args) {
    writeLog('info', ...args);
  }

  function debugLog(...args) {
    writeLog('debug', ...args);
  }

  function logWarning(...args) {
    writeLog('warn', ...args);
  }

  function logError(...args) {
    writeLog('error', ...args);
  }

  function sanitizeUrlForLog(value) {
    if (!value) return '';
    try {
      const url = new URL(String(value), location.href);
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch (_) {
      return String(value).split('?')[0].split('#')[0];
    }
  }

  function getDiagnosticSnapshot() {
    const video = state.video;
    return {
      timestamp: new Date().toISOString(),
      version: SCRIPT_VERSION,
      url: sanitizeUrlForLog(location.href),
      route: getRouteParams(),
      config: {
        enabled: state.config.enabled,
        autoPlay: state.config.autoPlay,
        autoNext: state.config.autoNext,
        speed: state.config.speed,
        muted: state.config.muted,
        keepBackground: state.config.keepBackground,
        nextDelay: state.config.nextDelay,
      },
      runtime: {
        angularAvailable: Boolean(pageWindow.angular),
        angularInjectorAvailable: Boolean(getAngularInjector()),
        videoJsAvailable: Boolean(pageWindow.videojs),
        navigating: state.navigating,
        nextRun: state.nextRun,
        videoGeneration: state.videoGeneration,
        intendedPlayback: state.intendedPlayback,
        handledErrorCount: state.handledErrors.size,
        catalogRequestCount: state.catalogRequestCount,
        attemptedSources: Array.from(state.attemptedSources).map(sanitizeUrlForLog),
      },
      dom: {
        videoCount: document.querySelectorAll('video').length,
        chapterNodeCount: document.querySelectorAll('[ui-sref^="main.chapter("]').length,
        sectionNodeCount: document.querySelectorAll('[ui-sref^="main.chapter.section("]').length,
        sourceNodeCount: document.querySelectorAll('[ng-click*="goSource"]').length,
      },
      video: video ? {
        currentSrc: sanitizeUrlForLog(video.currentSrc || video.src || ''),
        currentTime: Number(video.currentTime) || 0,
        duration: Number(video.duration) || 0,
        paused: video.paused,
        ended: video.ended,
        readyState: video.readyState,
        networkState: video.networkState,
        playbackRate: video.playbackRate,
        muted: video.muted,
        error: video.error ? {
          code: video.error.code,
          message: video.error.message || '',
        } : null,
      } : null,
    };
  }

  function installDebugApi() {
    try {
      pageWindow.fastuoocDebug = {
        version: SCRIPT_VERSION,
        snapshot() {
          const snapshot = getDiagnosticSnapshot();
          log('诊断快照', snapshot);
          return snapshot;
        },
      };
    } catch (error) {
      logWarning('无法暴露fastuoocDebug诊断接口', error);
    }
  }

  function notify(message, timeout = 2200) {
    let box = document.getElementById('fastuooc-auto-player-status');
    if (!box) {
      box = document.createElement('div');
      box.id = 'fastuooc-auto-player-status';
      box.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
        'max-width:360px', 'padding:8px 12px', 'border-radius:4px',
        'background:rgba(20,20,20,.88)', 'color:#fff', 'font:13px/1.5 sans-serif',
        'box-shadow:0 2px 8px rgba(0,0,0,.25)', 'pointer-events:none',
      ].join(';');
      (document.body || document.documentElement).appendChild(box);
    }
    box.textContent = message;
    box.style.display = 'block';
    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(() => {
      box.style.display = 'none';
    }, timeout);
  }

  function getQuizDocuments() {
    const documents = [document];
    document.querySelectorAll('iframe').forEach((frame) => {
      try {
        if (frame.contentDocument && frame.contentDocument !== document) {
          documents.push(frame.contentDocument);
        }
      } catch (_) {
        // 跨域iframe无法读取时跳过，当前UOOC考试iframe通常与页面同源。
      }
    });
    return documents;
  }

  function textFromElement(element) {
    if (!element) return '';
    const clone = element.cloneNode(true);
    const ownerDocument = element.ownerDocument || document;
    clone.querySelectorAll('script,style,input,button,textarea,select').forEach((node) => node.remove());
    clone.querySelectorAll('br').forEach((node) => node.replaceWith(ownerDocument.createTextNode('\n')));
    clone.querySelectorAll('img').forEach((image) => {
      const label = image.getAttribute('alt') || image.getAttribute('title') || image.getAttribute('src') || '图片';
      image.replaceWith(ownerDocument.createTextNode('[图片: ' + label + ']'));
    });
    return (clone.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function escapeMarkdown(text) {
    return String(text || '')
      .replace(/\\/g, '\\\\')
      .replace(/\r?\n/g, '<br>')
      .replace(/\|/g, '\\|');
  }

  function normalizeQuizType(rawType, container, options) {
    const text = String(rawType || '').trim();
    const hasCheckbox = !!container.querySelector('input[type="checkbox"], .checkbox, [class*="checkbox"]');
    const isMultiple = /多选|多项|不定项|multiple|checkbox/i.test(text) || hasCheckbox;
    if (isMultiple) return { label: text || '多选题', multiple: true };
    if (options.length && /判断|true\s*\/\s*false|true\s*or\s*false/i.test(text)) return { label: text || '判断题', multiple: false };
    return { label: text || (options.length ? '单选题' : '主观题'), multiple: false };
  }

  function extractQuizQuestionsFromDocument(doc) {
    const containers = Array.from(doc.querySelectorAll('.queContainer'));
    return containers.map((container, index) => {
      const group = container.closest('.queItems');
      const typeNode = group && group.querySelector('.queItems-type');
      const indexText = textFromElement(container.querySelector('.index')) || String(index + 1) + '.';
      const number = indexText.replace(/\D/g, '') || String(index + 1);
      const options = Array.from(container.querySelectorAll('.ti-a')).map((label, optionIndex) => {
        const rawLabel = textFromElement(label.querySelector('.ti-a-i'));
        const letterMatch = rawLabel.match(/[A-Z]/i);
        return {
          label: (letterMatch ? letterMatch[0] : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[optionIndex] || String(optionIndex + 1)).toUpperCase(),
          text: textFromElement(label.querySelector('.ti-a-c') || label),
        };
      }).filter((option) => option.text);
      const rawType = typeNode ? textFromElement(typeNode).replace(/\s*\(共[\s\S]*$/, '').trim() : '';
      const quizType = normalizeQuizType(rawType, container, options);
      return {
        number,
        type: quizType.label,
        isMultiple: quizType.multiple,
        question: textFromElement(container.querySelector('.ti-q-c')),
        options,
        score: textFromElement(container.querySelector('.scores')),
        id: (container.querySelector('.index') || {}).id || (container.querySelector('input[name]') || {}).name || '',
        element: container,
      };
    }).filter((item) => item.question);
  }

  function findQuizQuestions() {
    for (const doc of getQuizDocuments()) {
      const questions = extractQuizQuestionsFromDocument(doc);
      if (questions.length) {
        return {
          document: doc,
          questions,
          title: textFromElement(doc.querySelector('.testPaper-Top')) || doc.title || 'UOOC测验',
        };
      }
    }
    return null;
  }

  function downloadText(filename, content, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function formatQuizMarkdown(result) {
    const source = result.document.location && result.document.location.href ? result.document.location.href : location.href;
    const lines = [
      '# ' + (result.title || 'UOOC测验'),
      '',
      '- 导出时间：' + new Date().toLocaleString('zh-CN'),
      '- 题目数量：' + result.questions.length,
      '- 来源页面：' + source,
      '',
    ];
    result.questions.forEach((item, index) => {
      lines.push('## ' + (item.number || index + 1) + '. ' + item.type);
      lines.push('');
      lines.push('**题目：** ' + escapeMarkdown(item.question));
      lines.push('');
      item.options.forEach((option) => {
        lines.push('- **' + option.label + '.** ' + escapeMarkdown(option.text));
      });
      if (item.score) {
        lines.push('');
        lines.push('> 分值：' + escapeMarkdown(item.score));
      }
      lines.push('');
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  function exportQuiz() {
    const result = findQuizQuestions();
    if (!result) {
      notify('当前页面未找到可导出的题目');
      return;
    }
    const safeTitle = (result.title || 'uooc-quiz')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'uooc-quiz';
    downloadText(safeTitle + '.md', formatQuizMarkdown(result), 'text/markdown;charset=utf-8');
    notify('已导出' + result.questions.length + '道题目');
  }

  function getAIEndpoint() {
    const raw = String(state.config.aiBaseUrl || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (/\/chat\/completions$/i.test(raw)) return raw;
    if (/\/v1$/i.test(raw)) return raw + '/chat/completions';
    return raw + '/v1/chat/completions';
  }

  function enqueueAI(task, onStart) {
    return new Promise((resolve, reject) => {
      state.aiQueue.pending.push({ task, onStart, resolve, reject });
      pumpAIQueue();
    });
  }

  function pumpAIQueue() {
    while (state.aiQueue.active < AI_MAX_CONCURRENCY && state.aiQueue.pending.length) {
      const item = state.aiQueue.pending.shift();
      state.aiQueue.active += 1;
      Promise.resolve()
        .then(() => {
          if (typeof item.onStart === 'function') item.onStart();
          return item.task();
        })
        .then(item.resolve, item.reject)
        .finally(() => {
          state.aiQueue.active -= 1;
          pumpAIQueue();
        });
    }
  }

  function requestAICompletion(messages, onStart) {
    const endpoint = getAIEndpoint();
    if (!endpoint) return Promise.reject(new Error('未配置AI接口地址'));
    if (!state.config.aiApiKey) return Promise.reject(new Error('未配置AI API Key'));
    if (!state.config.aiModel) return Promise.reject(new Error('未配置AI模型名称'));
    const body = JSON.stringify({
      model: state.config.aiModel,
      messages,
      temperature: 0.2,
      max_tokens: 50,
    });
    return enqueueAI(() => new Promise((resolve, reject) => {
      const timeout = Math.max(5000, Number(state.config.aiTimeout) || 45000);
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => finish(reject, new Error('AI请求超时')), timeout);
      if (typeof GM_xmlhttpRequest !== 'function') {
        finish(reject, new Error('当前脚本管理器不支持GM_xmlhttpRequest'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'POST',
        url: endpoint,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + state.config.aiApiKey,
        },
        data: body,
        timeout,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            finish(reject, new Error('AI接口返回HTTP ' + response.status));
            return;
          }
          try {
            const data = JSON.parse(response.responseText || '{}');
            const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
            const text = Array.isArray(content)
              ? content.map((part) => typeof part === 'string' ? part : (part && part.text) || '').join('')
              : String(content || '');
            if (!text.trim()) throw new Error('AI接口响应中没有choices[0].message.content');
            finish(resolve, text.trim());
          } catch (error) {
            finish(reject, error);
          }
        },
        onerror: () => finish(reject, new Error('AI接口网络请求失败')),
        ontimeout: () => finish(reject, new Error('AI请求超时')),
      });
    }), onStart);
  }

  function buildAIQuestionPrompt(item) {
    const options = item.options.map((option) => option.label + '. ' + option.text).join('\n');
    const typeLabel = item.isMultiple ? '多选题' : '单选题';
    return [
      '你是严谨的选择题分析助手。请独立判断下面题目的最可能正确答案。',
      '先判断知识类型：数学、物理、化学、生物等需要推导或计算的题目，请直接进行严谨分析；历史、地理、政治、经济、法律、学校信息、机构信息、时事和其他事实性题目，如果当前模型或接口实际提供联网搜索/浏览工具，必须先调用该工具核验关键事实。',
      '只有在确实调用了可用的联网搜索工具后，才可以声称完成了搜索；如果接口没有搜索工具，不要伪装已经搜索过，并根据已有知识谨慎判断。无法可靠判断时只输出“无法确定”，脚本会将其视为无效回答。',
      '题型：' + typeLabel,
      item.isMultiple
        ? '输出规则：这是多选题，只输出所有最可能正确的选项标签，按题目顺序用英文逗号分隔，例如A,C。不要输出解释、标点前缀、Markdown或其他文字。'
        : '输出规则：这是单选题，只输出一个最可能正确的选项标签，例如A。不要输出解释、标点前缀、Markdown或多个选项。',
      '',
      '题目：',
      item.question,
      '',
      '选项：',
      options,
    ].join('\n');
  }

  function normalizeAIOptions(answer, item) {
    const valid = new Set(item.options.map((option) => option.label.toUpperCase()));
    const text = String(answer || '').toUpperCase().trim();
    if (!text || /无法确定|不确定|无法判断/.test(text)) return [];
    const explicit = text.match(/\b[A-Z]\b/g) || [];
    let labels = explicit.filter((label) => valid.has(label));
    if (item.isMultiple) {
      const compact = text.replace(/[\s,，、/|+和及以及与&;；:：()[\]{}"'`。.!?？]/g, '');
      if (compact && compact.length <= item.options.length && Array.from(compact).every((label) => valid.has(label))) {
        labels = Array.from(compact);
      }
    }
    labels = Array.from(new Set(labels));
    if (!item.isMultiple) labels = labels.slice(0, 1);
    return item.options.map((option) => option.label.toUpperCase()).filter((label) => labels.includes(label));
  }

  function countAIVotes(answers, item) {
    const counts = {};
    answers.filter((answer) => Array.isArray(answer) && answer.length).forEach((answer) => {
      const key = answer.join(',');
      counts[key] = (counts[key] || 0) + 1;
    });
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return { options: [], option: '', votes: 0, total: answers.length, tied: false };
    const tied = entries.length > 1 && entries[0][1] === entries[1][1];
    const options = tied ? [] : entries[0][0].split(',');
    return {
      options,
      option: options.join('、'),
      votes: entries[0][1],
      total: answers.length,
      tied,
    };
  }

  async function analyzeQuizQuestion(item) {
    const messages = [{ role: 'user', content: buildAIQuestionPrompt(item) }];
    let started = false;
    const markStarted = () => {
      if (started) return;
      started = true;
      renderAIAnalyzing(item.element);
    };
    const firstRound = await Promise.all([1, 2, 3].map(() => requestAICompletion(messages, markStarted).catch((error) => ({ error }))));
    let answers = firstRound.map((result) => result && result.error ? [] : normalizeAIOptions(result, item));
    const firstVote = countAIVotes(answers, item);
    if (!firstVote.tied && firstVote.options.length && firstVote.votes === 3) return firstVote;
    const extraRound = await Promise.all([1, 2].map(() => requestAICompletion(messages, markStarted).catch((error) => ({ error }))));
    answers = answers.concat(extraRound.map((result) => result && result.error ? [] : normalizeAIOptions(result, item)));
    return countAIVotes(answers, item);
  }

  function ensureAIStyles(doc) {
    if (!doc || doc.getElementById('fastuooc-ai-reference-style')) return;
    const style = doc.createElement('style');
    style.id = 'fastuooc-ai-reference-style';
    style.textContent = '.fastuooc-ai-reference{display:inline-flex;align-items:center;gap:5px;margin:0 0 8px 8px;padding:3px 8px;border:1px solid rgba(37,99,235,.25);border-radius:999px;background:rgba(37,99,235,.08);color:#2563eb;font:600 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.fastuooc-ai-reference.is-uncertain{border-color:rgba(100,116,139,.25);background:rgba(100,116,139,.08);color:#64748b}.fastuooc-ai-reference.is-waiting{border-color:rgba(148,163,184,.24);background:rgba(148,163,184,.08);color:#94a3b8}.fastuooc-ai-reference.is-loading{color:#2563eb;animation:fastuooc-ai-pulse 1.1s ease-in-out infinite}@keyframes fastuooc-ai-pulse{50%{opacity:.45}}';
    (doc.head || doc.documentElement).appendChild(style);
  }

  function renderAIReference(container, result) {
    const doc = container.ownerDocument;
    ensureAIStyles(doc);
    const normalized = Object.assign({ options: [], option: '', votes: 0, total: 0, tied: false }, result);
    state.aiResults.set(container, normalized);
    let badge = container.querySelector('.fastuooc-ai-reference');
    if (!badge) {
      badge = doc.createElement('span');
      badge.className = 'fastuooc-ai-reference';
      const questionNode = container.querySelector('.ti-q-c') || container.firstElementChild;
      if (questionNode && questionNode.parentNode) questionNode.parentNode.appendChild(badge);
      else container.insertBefore(badge, container.firstChild);
    }
    badge.classList.toggle('is-uncertain', !normalized.options.length);
    badge.classList.remove('is-waiting', 'is-loading');
    badge.textContent = normalized.message || (normalized.options.length ? 'AI参考：' + normalized.options.join('、') + '（' + normalized.votes + '/' + normalized.total + '）' : 'AI参考：无法确定（票数并列或无有效回答）');
  }

  function renderAIStatus(container, message, className) {
    const doc = container.ownerDocument;
    ensureAIStyles(doc);
    let badge = container.querySelector('.fastuooc-ai-reference');
    if (!badge) {
      badge = doc.createElement('span');
      badge.className = 'fastuooc-ai-reference';
      const questionNode = container.querySelector('.ti-q-c') || container.firstElementChild;
      if (questionNode && questionNode.parentNode) questionNode.parentNode.appendChild(badge);
      else container.insertBefore(badge, container.firstChild);
    }
    badge.classList.remove('is-uncertain', 'is-waiting', 'is-loading');
    if (className) badge.classList.add(className);
    badge.textContent = message;
  }

  function renderAIWaiting(container) {
    state.aiResults.delete(container);
    renderAIStatus(container, 'AI参考：等待分析中…', 'is-waiting');
  }

  function renderAIAnalyzing(container) {
    renderAIStatus(container, 'AI参考：分析中…', 'is-loading');
  }

  async function requestQuizAIReference(mode = 'all') {
    const result = findQuizQuestions();
    if (!result) {
      notify('当前页面未找到可分析的题目');
      return;
    }
    if (!getAIEndpoint() || !state.config.aiApiKey || !state.config.aiModel) {
      notify('请先在AI设置中填写接口地址、Key和模型');
      openAISettings();
      return;
    }
    const selectable = result.questions.filter((item) => item.options.length > 0);
    const questions = mode === 'uncertain'
      ? selectable.filter((item) => {
        const cached = state.aiResults.get(item.element);
        return cached && !cached.options.length;
      })
      : selectable;
    if (mode === 'all') {
      questions.forEach((item) => renderAIWaiting(item.element));
      result.questions
        .filter((item) => !item.options.length)
        .forEach((item) => renderAIReference(item.element, { options: [], votes: 0, total: 0, tied: false, message: '主观题不支持选项参考' }));
    } else {
      questions.forEach((item) => renderAIWaiting(item.element));
    }
    if (!questions.length) {
      notify(mode === 'uncertain' ? '当前没有需要重试的无法确定题目' : '当前页面没有可分析的选择题');
      return;
    }
    notify((mode === 'uncertain' ? '正在重试' : '正在分析') + questions.length + '道选择题，最多10路并发');
    let completed = 0;
    await Promise.all(questions.map(async (item) => {
      try {
        const vote = await analyzeQuizQuestion(item);
        renderAIReference(item.element, vote);
      } catch (error) {
        logError('AI题目分析失败', item.number, error);
        renderAIReference(item.element, { options: [], votes: 0, total: 0, tied: false });
      } finally {
        completed += 1;
        if (completed === questions.length) notify('AI参考分析完成，共' + questions.length + '道选择题');
      }
    }));
  }

  function ensureAIChoiceStyles() {
    if (document.getElementById('fastuooc-ai-reference-choice-style')) return;
    const style = document.createElement('style');
    style.id = 'fastuooc-ai-reference-choice-style';
    style.textContent = '#fastuooc-ai-reference-choice{position:fixed;inset:0;z-index:2147483647;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#fastuooc-ai-reference-choice .fastuooc-ai-backdrop{position:absolute;inset:0;background:rgba(15,23,42,.38);backdrop-filter:blur(5px)}#fastuooc-ai-reference-choice .fastuooc-ai-dialog{position:absolute;top:50%;left:50%;width:min(420px,calc(100vw - 28px));transform:translate(-50%,-50%);padding:18px;border:1px solid rgba(148,163,184,.28);border-radius:16px;background:#fff;color:#172033;box-shadow:0 24px 70px rgba(15,23,42,.28)}#fastuooc-ai-reference-choice .fastuooc-ai-dialog-head{display:flex;align-items:center;justify-content:space-between;font-size:16px}#fastuooc-ai-reference-choice .fastuooc-ai-dialog-head button{width:30px;height:30px;border:0;border-radius:50%;background:#f1f5f9;color:#64748b;font-size:20px;line-height:1;cursor:pointer}#fastuooc-ai-reference-choice .fastuooc-ai-help{margin:8px 0 12px;color:#64748b}#fastuooc-ai-reference-choice .fastuooc-ai-reference-count{margin:0 0 16px;padding:10px 12px;border-radius:10px;background:#f1f5f9;color:#475569}#fastuooc-ai-reference-choice .fastuooc-ai-reference-actions{display:flex;justify-content:flex-end;gap:8px}#fastuooc-ai-reference-choice .fastuooc-ai-reference-actions button{height:36px;padding:0 13px;border:1px solid #cbd5e1;border-radius:9px;background:#f8fafc;color:#334155;font-weight:600;cursor:pointer}#fastuooc-ai-reference-choice .fastuooc-ai-reference-actions button.is-primary{border-color:#2563eb;background:#2563eb;color:#fff}@media(prefers-color-scheme:dark){#fastuooc-ai-reference-choice .fastuooc-ai-dialog{background:#121824;color:#e7edf7}#fastuooc-ai-reference-choice .fastuooc-ai-dialog-head button{background:#334155;color:#cbd5e1}#fastuooc-ai-reference-choice .fastuooc-ai-help{color:#94a3b8}#fastuooc-ai-reference-choice .fastuooc-ai-reference-count{background:#1e293b;color:#cbd5e1}#fastuooc-ai-reference-choice .fastuooc-ai-reference-actions button{border-color:#475569;background:#1e293b;color:#e2e8f0}}';
    (document.head || document.documentElement).appendChild(style);
  }

  function openAIReferenceModeDialog(questionCount, uncertainCount) {
    ensureAIChoiceStyles();
    return new Promise((resolve) => {
      const existing = document.getElementById('fastuooc-ai-reference-choice');
      if (existing) existing.remove();
      const modal = document.createElement('div');
      modal.id = 'fastuooc-ai-reference-choice';
      modal.innerHTML = [
        '<div class="fastuooc-ai-backdrop" data-reference-action="cancel"></div>',
        '<section class="fastuooc-ai-dialog fastuooc-ai-reference-dialog" role="dialog" aria-modal="true" aria-labelledby="fastuooc-ai-reference-choice-title">',
        '<div class="fastuooc-ai-dialog-head"><strong id="fastuooc-ai-reference-choice-title">已有AI参考结果</strong><button type="button" data-reference-action="cancel" aria-label="关闭提示">×</button></div>',
        '<p class="fastuooc-ai-help">当前页面已有' + questionCount + '道题生成过参考结果。请选择本次处理范围。</p>',
        '<div class="fastuooc-ai-reference-count">当前无法确定：' + uncertainCount + '道</div>',
        '<div class="fastuooc-ai-reference-actions">',
        '<button type="button" data-reference-action="uncertain">仅重试无法确定</button>',
        '<button type="button" class="is-primary" data-reference-action="all">覆盖全部</button>',
        '</div>',
        '</section>',
      ].join('');
      const finish = (mode) => {
        modal.remove();
        resolve(mode);
      };
      modal.addEventListener('click', (event) => {
        const actionNode = event.target.closest('[data-reference-action]');
        if (!actionNode) return;
        const action = actionNode.dataset.referenceAction;
        if (action === 'all') finish('all');
        else if (action === 'uncertain') finish('uncertain');
        else finish('cancel');
      });
      (document.body || document.documentElement).appendChild(modal);
    });
  }

  function openAISettings() {
    const existing = document.getElementById('fastuooc-ai-settings');
    if (existing) {
      existing.hidden = false;
      return;
    }
    const modal = document.createElement('div');
    modal.id = 'fastuooc-ai-settings';
    modal.innerHTML = [
      '<div class="fastuooc-ai-backdrop" data-ai-action="close"></div>',
      '<section class="fastuooc-ai-dialog" role="dialog" aria-modal="true" aria-labelledby="fastuooc-ai-settings-title">',
      '<div class="fastuooc-ai-dialog-head"><strong id="fastuooc-ai-settings-title">AI参考设置</strong><button type="button" data-ai-action="close" aria-label="关闭设置">×</button></div>',
      '<p class="fastuooc-ai-help">仅用于生成参考选项，不会自动勾选或提交测验。</p>',
      '<label>接口地址<input data-ai-field="baseUrl" type="url" placeholder="https://api.example.com/v1"></label>',
      '<label>API Key<input data-ai-field="apiKey" type="password" placeholder="sk-..."></label>',
      '<label>模型名称<input data-ai-field="model" type="text" placeholder="gpt-4o-mini"></label>',
      '<label>超时时间（毫秒）<input data-ai-field="timeout" type="number" min="5000" max="120000" step="1000"></label>',
      '<div class="fastuooc-ai-dialog-actions"><button type="button" data-ai-action="test">测试接口</button><button type="button" class="is-primary" data-ai-action="save">保存设置</button></div>',
      '<div class="fastuooc-ai-dialog-status" data-ai-role="status" aria-live="polite"></div>',
      '</section>',
    ].join('');
    const style = document.createElement('style');
    style.id = 'fastuooc-ai-settings-style';
    style.textContent = '#fastuooc-ai-settings{position:fixed;inset:0;z-index:2147483647;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}#fastuooc-ai-settings[hidden]{display:none}.fastuooc-ai-backdrop{position:absolute;inset:0;background:rgba(15,23,42,.38);backdrop-filter:blur(5px)}.fastuooc-ai-dialog{position:absolute;top:50%;left:50%;width:min(420px,calc(100vw - 28px));transform:translate(-50%,-50%);padding:18px;border:1px solid rgba(148,163,184,.28);border-radius:16px;background:#fff;color:#172033;box-shadow:0 24px 70px rgba(15,23,42,.28)}.fastuooc-ai-dialog-head{display:flex;align-items:center;justify-content:space-between;font-size:16px}.fastuooc-ai-dialog-head button{width:30px;height:30px;border:0;border-radius:50%;background:#f1f5f9;color:#64748b;font-size:20px;line-height:1;cursor:pointer}.fastuooc-ai-help{margin:8px 0 16px;color:#64748b}.fastuooc-ai-dialog label{display:flex;flex-direction:column;gap:6px;margin:12px 0;color:#334155;font-weight:600}.fastuooc-ai-dialog input{box-sizing:border-box;width:100%;height:38px;padding:0 10px;border:1px solid #cbd5e1;border-radius:9px;background:#f8fafc;color:#172033;font:13px inherit;outline:0}.fastuooc-ai-dialog input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}.fastuooc-ai-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.fastuooc-ai-dialog-actions button{height:36px;padding:0 13px;border:1px solid #cbd5e1;border-radius:9px;background:#f8fafc;color:#334155;font-weight:600;cursor:pointer}.fastuooc-ai-dialog-actions button.is-primary{border-color:#2563eb;background:#2563eb;color:#fff}.fastuooc-ai-dialog-status{min-height:20px;margin-top:10px;color:#64748b}@media(prefers-color-scheme:dark){.fastuooc-ai-dialog{background:#121824;color:#e7edf7}.fastuooc-ai-dialog-head button{background:#334155;color:#cbd5e1}.fastuooc-ai-help,.fastuooc-ai-dialog-status{color:#94a3b8}.fastuooc-ai-dialog label{color:#cbd5e1}.fastuooc-ai-dialog input{border-color:#475569;background:#1e293b;color:#e7edf7}.fastuooc-ai-dialog-actions button{border-color:#475569;background:#1e293b;color:#cbd5e1}}';
    (document.head || document.documentElement).appendChild(style);
    (document.body || document.documentElement).appendChild(modal);
    modal.querySelector('[data-ai-field="baseUrl"]').value = state.config.aiBaseUrl || '';
    modal.querySelector('[data-ai-field="apiKey"]').value = state.config.aiApiKey || '';
    modal.querySelector('[data-ai-field="model"]').value = state.config.aiModel || '';
    modal.querySelector('[data-ai-field="timeout"]').value = state.config.aiTimeout || 45000;
    const status = (message) => { modal.querySelector('[data-ai-role="status"]').textContent = message; };
    modal.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-ai-action]') && event.target.closest('[data-ai-action]').dataset.aiAction;
      if (action === 'close') { modal.hidden = true; return; }
      if (action === 'save') {
        state.config.aiBaseUrl = modal.querySelector('[data-ai-field="baseUrl"]').value.trim();
        state.config.aiApiKey = modal.querySelector('[data-ai-field="apiKey"]').value.trim();
        state.config.aiModel = modal.querySelector('[data-ai-field="model"]').value.trim();
        state.config.aiTimeout = Math.min(120000, Math.max(5000, Number(modal.querySelector('[data-ai-field="timeout"]').value) || 45000));
        saveConfig();
        status('设置已保存');
        notify('AI参考设置已保存');
        return;
      }
      if (action === 'test') {
        state.config.aiBaseUrl = modal.querySelector('[data-ai-field="baseUrl"]').value.trim();
        state.config.aiApiKey = modal.querySelector('[data-ai-field="apiKey"]').value.trim();
        state.config.aiModel = modal.querySelector('[data-ai-field="model"]').value.trim();
        state.config.aiTimeout = Math.min(120000, Math.max(5000, Number(modal.querySelector('[data-ai-field="timeout"]').value) || 45000));
        status('正在测试接口…');
        try {
          await requestAICompletion([{ role: 'user', content: '这是接口连通性测试。请只回复OK，不要输出其他内容。' }]);
          status('接口连接成功');
        } catch (error) {
          status('接口测试失败：' + error.message);
        }
      }
    });
  }

  function unique(values) {
    const seen = new Set();
    return values.filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function normalizeUrl(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'nosource') return '';
    try {
      return new URL(trimmed, location.href).href;
    } catch (_) {
      return trimmed;
    }
  }

  function isVideoSource(source) {
    return source && typeof source === 'object' &&
      (source.uri || source.src || source.source || source.url);
  }

  function sourceUrl(source) {
    if (typeof source === 'string') return normalizeUrl(source);
    if (!source) return '';
    return normalizeUrl(source.uri || source.src || source.source || source.url);
  }

  function flattenSources(value, output = [], seen = new Set(), depth = 0) {
    if (depth > 5 || value == null) return output;
    if (typeof value === 'string') {
      const url = normalizeUrl(value);
      if (url) output.push({ url, raw: value });
      return output;
    }
    if (typeof value !== 'object' || seen.has(value)) return output;
    seen.add(value);

    if (isVideoSource(value)) {
      const url = sourceUrl(value);
      if (url) output.push({ url, raw: value, name: value.name || '' });
    }
    if (Array.isArray(value)) {
      value.forEach((item) => flattenSources(item, output, seen, depth + 1));
    } else {
      Object.keys(value).forEach((key) => {
        if (key === 'subtitle' || key === 'quiz' || key === 'document') return;
        flattenSources(value[key], output, seen, depth + 1);
      });
    }
    return output;
  }

  function findNativeVideo() {
    return document.querySelector('video.video-js, video#player, video');
  }

  function findVideoJsPlayer(video) {
    if (!video || !pageWindow.videojs) return null;
    try {
      if (typeof pageWindow.videojs.getPlayers === 'function') {
        const players = pageWindow.videojs.getPlayers();
        const player = Object.keys(players || {})
          .map((key) => players[key])
          .find((candidate) => candidate && candidate.el && candidate.el() === video);
        if (player) return player;
      }
      if (typeof pageWindow.videojs.getPlayer === 'function' && video.id) {
        return pageWindow.videojs.getPlayer(video.id);
      }
    } catch (error) {
      logError('查找Video.js实例失败', error);
    }
    return null;
  }

  function getAngularInjector() {
    try {
      if (!pageWindow.angular || !document.body) return null;
      return pageWindow.angular.element(document.body).injector() || null;
    } catch (_) {
      return null;
    }
  }

  function getAngularRootScope() {
    try {
      const injector = getAngularInjector();
      return injector && injector.get('$rootScope');
    } catch (_) {
      return null;
    }
  }

  function climbScope(scope, predicate) {
    let current = scope;
    for (let depth = 0; current && depth < 12; depth += 1) {
      if (predicate(current)) return current;
      current = current['$' + 'parent'];
    }
    return null;
  }

  function getLearnScope() {
    if (!pageWindow.angular) return null;
    const root = getAngularRootScope();
    if (root && Array.isArray(root.chapterList)) return root;
    const nodes = document.querySelectorAll(
      '[ng-repeat*="chapterItem in chapterList"], .panel-catalog, .newlearn_left_card_chapter_list, [source-view]'
    );
    for (const node of nodes) {
      try {
        const scope = climbScope(pageWindow.angular.element(node).scope(), (candidate) =>
          Array.isArray(candidate.chapterList)
        );
        if (scope) return scope;
      } catch (_) {}
    }
    return null;
  }

  function patchBackgroundPausePolicy() {
    try {
      const injector = getAngularInjector();
      const videoService = injector && injector.get('videoService');
      if (!videoService || typeof videoService.setBlurPause !== 'function') return;
      if (!state.config.keepBackground) {
        if (state.patchedVideoService && state.patchedVideoService.videoService === videoService) {
          videoService.setBlurPause = state.patchedVideoService.original;
          delete videoService.__fastuoocBackgroundPatched;
          state.patchedVideoService = null;
          log('已恢复平台后台暂停策略');
        }
        return;
      }
      if (videoService.__fastuoocBackgroundPatched) return;
      const original = videoService.setBlurPause;
      videoService.setBlurPause = function (player) {
        // UOOC's own handler pauses when the tab loses focus. Keep playback under the userscript policy.
        return player;
      };
      videoService.__fastuoocBackgroundPatched = true;
      state.patchedVideoService = { videoService, original };
      log('已关闭平台后台失焦暂停策略');
    } catch (error) {
      logError('关闭平台后台暂停策略失败', error);
    }
  }

  function isBackgroundContext() {
    return document.visibilityState === 'hidden' || (typeof document.hasFocus === 'function' && !document.hasFocus());
  }

  function shouldRecoverBackgroundPlayback(video) {
    return Boolean(
      state.config.autoPlay &&
      state.config.keepBackground &&
      state.intendedPlayback &&
      video &&
      !video.ended &&
      isBackgroundContext()
    );
  }

  function recoverBackgroundPlayback(reason = 'background') {
    const video = state.video;
    if (!shouldRecoverBackgroundPlayback(video)) return;
    window.setTimeout(() => {
      if (!shouldRecoverBackgroundPlayback(video)) return;
      applyMediaSettings(video, true);
      debugLog('后台播放恢复检查', reason);
    }, 80);
  }

  function startBackgroundPlaybackGuard() {
    if (state.backgroundGuardTimer) return;
    const recover = () => recoverBackgroundPlayback('lifecycle');
    document.addEventListener('visibilitychange', recover, true);
    window.addEventListener('pageshow', recover, true);
    window.addEventListener('focus', recover, true);
    window.addEventListener('blur', recover, true);
    state.backgroundGuardTimer = window.setInterval(() => {
      recoverBackgroundPlayback('heartbeat');
    }, 1500);
  }

  function getPlayerSources(video, player) {
    const candidates = [];
    if (video) {
      candidates.push(video.currentSrc, video.src);
      video.querySelectorAll('source[src]').forEach((node) => candidates.push(node.src));
    }

    if (player) {
      try {
        candidates.push(player.currentSrc && player.currentSrc());
        candidates.push(player.options_ && player.options_.sources);
        candidates.push(player.options_ && player.options_.controlBar && player.options_.controlBar.videoSource);
      } catch (error) {
        logError('读取Video.js资源列表失败', error);
      }
    }

    document.querySelectorAll('.vjs-menu-content[uri], [data-uri]').forEach((node) => {
      candidates.push(node.getAttribute('uri') || node.getAttribute('data-uri'));
    });

    return unique(flattenSources(candidates).map((item) => item.url));
  }

  function applyMediaSettings(video, shouldPlay = false) {
    if (!video) return;
    const speed = Number(state.config.speed) || 2;
    try {
      video.defaultPlaybackRate = speed;
      video.playbackRate = speed;
      if (state.config.muted) {
        video.muted = true;
        video.defaultMuted = true;
        video.volume = 0;
      } else {
        video.muted = false;
        video.defaultMuted = false;
        if (video.volume === 0) video.volume = 1;
      }
      if (shouldPlay && state.config.autoPlay && !video.ended) {
        state.intendedPlayback = true;
        const result = video.play();
        if (result && typeof result.catch === 'function') {
          result.catch(() => notify('浏览器阻止了自动播放，请先手动点击一次播放'));
        }
      }
    } catch (error) {
      logError('应用播放器设置失败', error);
    }
  }

  function tryNextSource(video) {
    const sources = getPlayerSources(video, state.player);
    const current = normalizeUrl(video.currentSrc || video.src);
    const next = sources.find((url) => url !== current && !state.attemptedSources.has(url));
    if (!next) {
      setTimeout(() => playNextVideo(), state.config.nextDelay);
      return false;
    }

    state.attemptedSources.add(next);
    log('切换到候选视频资源', sanitizeUrlForLog(next));
    notify('当前线路不可用，正在切换视频资源');
    const position = Number(video.currentTime) || 0;
    if (state.player && typeof state.player.src === 'function') {
      state.player.src({ type: 'video/mp4', src: next });
      if (typeof state.player.load === 'function') state.player.load();
    } else {
      video.src = next;
      video.load();
    }
    video.addEventListener('loadedmetadata', () => {
      applyMediaSettings(video, true);
      if (position > 0 && Number.isFinite(video.duration) && position < video.duration) {
        try { video.currentTime = position; } catch (_) {}
      }
    }, { once: true });
    return true;
  }

  function getRouteParams() {
    const segments = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const numbers = segments.filter((part) => /^\d+$/.test(part));
    const suffix = segments[segments.length - 1] || '';
    const result = {
      courseId: numbers[0] || '',
      chapterId: numbers[1] || '',
      sectionId: numbers[2] || '',
      pointId: '',
      sourceId: '',
    };

    if (suffix === 'section') {
      result.sourceId = numbers[3] || '';
    } else if (suffix === 'subsection') {
      result.pointId = numbers[3] || '';
      result.sourceId = numbers[4] || '';
    } else if (numbers.length >= 5) {
      // Some saved/new UI URLs omit the textual route suffix but retain both IDs.
      result.pointId = numbers[3] || '';
      result.sourceId = numbers[4] || '';
    } else if (numbers.length >= 4) {
      // Four numeric segments are course/chapter/section/source in the old UI and saved new UI pages.
      result.sourceId = numbers[3] || '';
    }

    return result;
  }

  function getCurrentSourceId() {
    const params = getRouteParams();
    if (params.sourceId) return String(params.sourceId);
    try {
      const root = getAngularRootScope();
      const learnScope = getLearnScope();
      const stateService = getStateService();
      const stateParams = (stateService && stateService.params) ||
        (learnScope && learnScope.stateParams) ||
        (root && root.stateParams) || {};
      const currentState = stateService && stateService['$' + 'current'];
      const globals = currentState && currentState.locals && currentState.locals.globals;
      const unitSource = globals && globals.unitSource;
      const activeNode = document.querySelector('[ng-click*="goSource"].active, .resourcelist .active, .level_2_resourcelist_item.active, .level_3_resourcelist_item.active');
      let activeSource = null;
      if (activeNode && pageWindow.angular) {
        activeSource = climbScope(pageWindow.angular.element(activeNode).scope(), (candidate) =>
          candidate.source && candidate.source.id != null
        );
      }
      return String(
        stateParams.sourceId ||
        (unitSource && unitSource.id) ||
        (activeSource && activeSource.source && activeSource.source.id) ||
        (learnScope && learnScope.curSource && learnScope.curSource.id) ||
        (learnScope && learnScope.lastSource && learnScope.lastSource.id) ||
        (root && root.curSource && root.curSource.id) ||
        (root && root.lastSource && root.lastSource.id) ||
        ''
      );
    } catch (_) {
      return '';
    }
  }

  function sourceIsVideo(source) {
    return source && (String(source.type) === '10' ||
      String(source.mime_type || '').toLowerCase().startsWith('video/'));
  }

  function normalizeId(value) {
    return value == null ? '' : String(value);
  }

  function makeVideoEntry(source, route) {
    if (!sourceIsVideo(source) || !source.id) return null;
    const playableSources = flattenSources([
      source.video_url,
      source.video_play_list,
      source.uri,
      source.url,
    ]);
    // 目录项可能只包含资源ID，真实播放地址由平台的goSource逻辑按需解析。
    return {
      id: normalizeId(source.id),
      source,
      route,
      title: source.name || source.title || source.filename || '',
      playableSources,
    };
  }

  function collectCatalogEntries() {
    const learnScope = getLearnScope();
    const chapterList = learnScope && learnScope.chapterList;
    if (!Array.isArray(chapterList)) return [];

    const entries = [];
    const courseId = getRouteParams().courseId;
    const addSources = (sources, route) => {
      (Array.isArray(sources) ? sources : []).forEach((source) => {
        const entry = makeVideoEntry(source, route);
        if (entry) entries.push(entry);
      });
    };

    chapterList.forEach((chapter) => {
      const chapterId = normalizeId(chapter.id);
      const sections = Array.isArray(chapter.children) ? chapter.children : [];
      sections.forEach((section) => {
        const sectionId = normalizeId(section.id);
        addSources(section.unitSource, { courseId, chapterId, sectionId, pointId: '' });
        const points = Array.isArray(section.children) ? section.children : [];
        points.forEach((point) => {
          const pointId = normalizeId(point.id);
          addSources(point.unitSource, { courseId, chapterId, sectionId, pointId });
        });
      });
    });
    return entries;
  }

  function getCourseService() {
    try {
      const injector = getAngularInjector();
      return injector && injector.get('courseService');
    } catch (_) {
      return null;
    }
  }

  function extractSourceList(response) {
    const candidates = [
      response,
      response && response.data,
      response && response.data && response.data.data,
      response && response.data && response.data.unitSource,
      response && response.unitSource,
      response && response.list,
      response && response.items,
    ];
    return candidates.find((candidate) => Array.isArray(candidate)) || [];
  }

  function loadUnitSources(node, route) {
    if (!node) return Promise.resolve([]);
    if (Array.isArray(node.unitSource) && node.unitSource.length) return Promise.resolve(node.unitSource);
    const pending = state.unitSourcePromises.get(node);
    if (pending) return pending;

    const courseService = getCourseService();
    const params = getRouteParams();
    if (!courseService || typeof courseService.getUnitLearn !== 'function') {
      logWarning('无法读取课程资源：courseService.getUnitLearn不可用', {
        route,
        angularAvailable: Boolean(pageWindow.angular),
        injectorAvailable: Boolean(getAngularInjector()),
      });
      return Promise.resolve([]);
    }

    const request = {
      cid: params.courseId,
      chapter_id: route.chapterId,
      section_id: route.sectionId,
      subsection_id: route.pointId || 0,
      catalog_id: route.pointId || route.sectionId,
      load: false,
      hidemsg_: true,
    };
    state.catalogRequestCount += 1;
    log('请求课程资源', { request, requestNumber: state.catalogRequestCount });
    const promise = Promise.resolve(courseService.getUnitLearn(request))
      .then((response) => {
        node.unitSource = extractSourceList(response);
        log('课程资源读取完成', {
          chapterId: route.chapterId,
          sectionId: route.sectionId,
          pointId: route.pointId || '',
          sourceCount: node.unitSource.length,
        });
        return node.unitSource;
      })
      .catch((error) => {
        logError('读取课程资源失败', { request, error });
        return [];
      });
    state.unitSourcePromises.set(node, promise);
    return promise;
  }

  function buildCatalogUnits(chapterList, courseId) {
    const units = [];
    chapterList.forEach((chapter) => {
      const chapterId = normalizeId(chapter.id);
      const sections = Array.isArray(chapter.children) ? chapter.children : [];
      sections.forEach((section) => {
        const sectionId = normalizeId(section.id);
        units.push({
          node: section,
          route: { courseId, chapterId, sectionId, pointId: '' },
        });
        const points = Array.isArray(section.children) ? section.children : [];
        points.forEach((point) => {
          units.push({
            node: point,
            route: {
              courseId,
              chapterId,
              sectionId,
              pointId: normalizeId(point.id),
            },
          });
        });
      });
    });
    return units;
  }

  function catalogUnitMatchesRoute(unitRoute, currentRoute) {
    if (!unitRoute || !currentRoute) return false;
    return normalizeId(unitRoute.chapterId) === normalizeId(currentRoute.chapterId) &&
      normalizeId(unitRoute.sectionId) === normalizeId(currentRoute.sectionId) &&
      normalizeId(unitRoute.pointId) === normalizeId(currentRoute.pointId);
  }

  async function findNextVideoEntryLazy(currentRoute, currentSourceId) {
    const learnScope = getLearnScope();
    const chapterList = learnScope && learnScope.chapterList;
    if (!Array.isArray(chapterList)) {
      return { available: false, reason: 'chapter-list-unavailable' };
    }

    const units = buildCatalogUnits(chapterList, currentRoute.courseId);
    const startUnitIndex = units.findIndex((unit) => catalogUnitMatchesRoute(unit.route, currentRoute));
    if (startUnitIndex < 0) {
      logWarning('惰性搜索无法定位当前课程单元', {
        currentRoute,
        currentSourceId,
        unitCount: units.length,
      });
      return { available: false, reason: 'current-unit-not-found', unitCount: units.length };
    }

    let scannedUnitCount = 0;
    const requestCountAtStart = state.catalogRequestCount;
    for (let unitIndex = startUnitIndex; unitIndex < units.length; unitIndex += 1) {
      const unit = units[unitIndex];
      const sources = await loadUnitSources(unit.node, unit.route);
      scannedUnitCount += 1;

      let sourceStartIndex = 0;
      if (unitIndex === startUnitIndex) {
        const currentIndex = sources.findIndex((source) =>
          normalizeId(source && source.id) === normalizeId(currentSourceId)
        );
        if (currentIndex < 0) {
          logWarning('当前单元资源中未找到正在播放的视频，跳过当前单元剩余判断', {
            currentRoute,
            currentSourceId,
            sourceCount: sources.length,
          });
          sourceStartIndex = sources.length;
        } else {
          sourceStartIndex = currentIndex + 1;
        }
      }

      for (let sourceIndex = sourceStartIndex; sourceIndex < sources.length; sourceIndex += 1) {
        const entry = makeVideoEntry(sources[sourceIndex], unit.route);
        if (!entry) continue;
        return {
          available: true,
          entry,
          unitCount: units.length,
          startUnitIndex,
          matchedUnitIndex: unitIndex,
          scannedUnitCount,
          requestCount: state.catalogRequestCount - requestCountAtStart,
        };
      }

      debugLog('惰性搜索单元无后续视频', {
        unitIndex,
        route: unit.route,
        sourceCount: sources.length,
      });
    }

    return {
      available: true,
      entry: null,
      unitCount: units.length,
      startUnitIndex,
      matchedUnitIndex: -1,
      scannedUnitCount,
      requestCount: state.catalogRequestCount - requestCountAtStart,
    };
  }

  function getStateService() {
    try {
      const injector = getAngularInjector();
      return injector && injector.get('$state');
    } catch (_) {
      return null;
    }
  }

  function findCatalogSourceNode(entry) {
    if (!pageWindow.angular || !entry) return null;
    const nodes = document.querySelectorAll('[ng-click*="goSource"]');
    for (const node of nodes) {
      try {
        const scope = climbScope(pageWindow.angular.element(node).scope(), (candidate) =>
          candidate.source && candidate.source.id != null
        );
        const source = scope && scope.source;
        if (source && normalizeId(source.id) === normalizeId(entry.id)) return node;
      } catch (_) {}
    }
    return null;
  }

  function clickCatalogSource(entry) {
    const node = findCatalogSourceNode(entry);
    if (!node || typeof node.click !== 'function') return false;
    try {
      node.click();
      return true;
    } catch (error) {
      logError('点击目录视频资源失败', error);
      return false;
    }
  }

  function getTargetSourceState(route) {
    return route.pointId ? 'main.chapter.section.point.source' : 'main.chapter.section.source';
  }

  function getCatalogRouteFromNode(node) {
    if (!node) return null;
    const href = node.getAttribute('href') || '';
    const numbers = href.replace(/^#\/?/, '').split('/').filter((part) => /^\d+$/.test(part));
    if (numbers.length < 2) return null;
    return {
      courseId: numbers[0] || '',
      chapterId: numbers[1] || '',
      sectionId: numbers[2] || '',
    };
  }

  function getSectionNavigationNodes() {
    return Array.from(document.querySelectorAll('[ui-sref]')).filter((node) => {
      const stateName = node.getAttribute('ui-sref') || '';
      return stateName.startsWith('main.chapter.section(') && !stateName.includes('.point');
    });
  }

  function findNextSectionNode(currentChapterId, currentSectionId) {
    const routes = getSectionNavigationNodes()
      .map((node) => ({ node, route: getCatalogRouteFromNode(node) }))
      .filter((item) => item.route && normalizeId(item.route.chapterId) === normalizeId(currentChapterId));
    const currentIndex = routes.findIndex((item) =>
      normalizeId(item.route.sectionId) === normalizeId(currentSectionId)
    );
    return routes[currentIndex >= 0 ? currentIndex + 1 : 0] || null;
  }

  function clickNextSection(currentChapterId, currentSectionId) {
    const next = findNextSectionNode(currentChapterId, currentSectionId);
    if (!next || !next.node || typeof next.node.click !== 'function') return null;
    try {
      log('点击下一小节', {
        from: { chapterId: currentChapterId, sectionId: currentSectionId },
        to: next.route,
      });
      next.node.click();
      return next;
    } catch (error) {
      logError('点击下一小节失败', { currentChapterId, currentSectionId, error });
      return null;
    }
  }

  function catalogNodeIsVideo(node) {
    if (!node) return false;
    if (node.querySelector('.icon-video, [class*="icon-video"]')) return true;
    if (!pageWindow.angular) return false;
    try {
      const scope = climbScope(pageWindow.angular.element(node).scope(), (candidate) =>
        candidate.source && candidate.source.id != null
      );
      return sourceIsVideo(scope && scope.source);
    } catch (_) {
      return false;
    }
  }

  async function waitForSectionVideoNode(sectionId) {
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      const route = getRouteParams();
      if (normalizeId(route.sectionId) === normalizeId(sectionId)) {
        const node = Array.from(document.querySelectorAll('[ng-click*="goSource"]')).find(catalogNodeIsVideo);
        if (node) return node;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  function clickCatalogVideoNode(node) {
    if (!node || state.navigating || typeof node.click !== 'function') return false;
    state.navigating = true;
    try {
      log('点击小节首个视频DOM节点', {
        text: (node.textContent || '').trim(),
        route: getRouteParams(),
      });
      node.click();
      setTimeout(() => { state.navigating = false; }, 900);
      return true;
    } catch (error) {
      state.navigating = false;
      logError('点击小节首个视频失败', { route: getRouteParams(), error });
      return false;
    }
  }

  function getChapterNavigationNodes() {
    return Array.from(document.querySelectorAll('[ui-sref]')).filter((node) => {
      const state = node.getAttribute('ui-sref') || '';
      return state.startsWith('main.chapter(');
    });
  }

  function getChapterItemFromNode(node) {
    if (!node) return null;
    if (pageWindow.angular) {
      try {
        const scope = climbScope(pageWindow.angular.element(node).scope(), (candidate) =>
          candidate.chapterItem && candidate.chapterItem.id != null
        );
        if (scope && scope.chapterItem) return scope.chapterItem;
      } catch (_) {}
    }
    const route = getCatalogRouteFromNode(node);
    return route && route.chapterId ? { id: route.chapterId } : null;
  }

  function findNextChapterNode(currentChapterId) {
    const nodes = getChapterNavigationNodes();
    const currentId = normalizeId(currentChapterId);
    const currentIndex = nodes.findIndex((node) => {
      const item = getChapterItemFromNode(node);
      return item && normalizeId(item.id) === currentId;
    });
    const start = currentIndex >= 0 ? currentIndex + 1 : 0;
    for (let index = start; index < nodes.length; index += 1) {
      const item = getChapterItemFromNode(nodes[index]);
      if (item && normalizeId(item.id) !== currentId) return { node: nodes[index], item };
    }
    return null;
  }

  function clickNextChapter(currentChapterId) {
    const next = findNextChapterNode(currentChapterId);
    if (!next || !next.node || typeof next.node.click !== 'function') return null;
    try {
      log('点击下一章节', {
        fromChapterId: currentChapterId,
        toChapterId: normalizeId(next.item && next.item.id),
      });
      next.node.click();
      return next;
    } catch (error) {
      logError('点击下一章节失败', { currentChapterId, error });
      return null;
    }
  }

  async function waitForChapterEntries(chapterId, currentSourceId) {
    const deadline = Date.now() + 9000;
    let latest = [];
    while (Date.now() < deadline) {
      try {
        latest = collectCatalogEntries();
      } catch (error) {
        logError('等待章节资源时读取目录失败', { chapterId, currentSourceId, error });
      }
      if (latest.some((entry) =>
        normalizeId(entry.route.chapterId) === normalizeId(chapterId) &&
        normalizeId(entry.id) !== normalizeId(currentSourceId)
      )) return latest;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return latest;
  }

  function navigateToEntry(entry) {
    if (!entry || state.navigating) {
      logWarning('跳过视频跳转', {
        hasEntry: Boolean(entry),
        navigating: state.navigating,
        route: getRouteParams(),
      });
      return false;
    }
    state.navigating = true;
    log('准备跳转视频', {
      id: entry.id,
      title: entry.title || '',
      route: entry.route,
      currentRoute: getRouteParams(),
    });
    notify('正在播放：' + (entry.title || entry.id));

    // 优先模拟用户点击目录资源，让新旧UI各自执行原生goSource流程。
    if (clickCatalogSource(entry)) {
      log('通过目录DOM点击完成视频跳转', { id: entry.id, route: entry.route });
      setTimeout(() => { state.navigating = false; }, 900);
      return true;
    }

    const stateService = getStateService();
    if (!stateService || typeof stateService.go !== 'function') {
      state.navigating = false;
      logWarning('视频跳转失败：目录节点和Angular路由均不可用', {
        entry: { id: entry.id, title: entry.title || '', route: entry.route },
        snapshot: getDiagnosticSnapshot(),
      });
      return false;
    }

    const params = getRouteParams();
    const route = entry.route;
    const targetState = getTargetSourceState(route);
    const transition = stateService.go(targetState, {
      courseId: route.courseId || params.courseId,
      chapterId: route.chapterId,
      sectionId: route.sectionId,
      pointId: route.pointId || undefined,
      sourceId: entry.id,
    });
    log('通过Angular路由跳转视频', {
      targetState,
      params: {
        courseId: route.courseId || params.courseId,
        chapterId: route.chapterId,
        sectionId: route.sectionId,
        pointId: route.pointId || undefined,
        sourceId: entry.id,
      },
    });
    Promise.resolve(transition)
      .then(() => log('Angular路由跳转完成', { targetState, sourceId: entry.id, url: sanitizeUrlForLog(location.href) }))
      .catch((error) => logError('跳转视频资源失败', {
        targetState,
        entry: { id: entry.id, title: entry.title || '', route: entry.route },
        error,
      }))
      .finally(() => {
        setTimeout(() => { state.navigating = false; }, 900);
      });
    return true;
  }

  async function playNextVideo() {
    if (!state.config.autoNext || state.navigating || state.nextRun) {
      logWarning('跳过自动连播请求', {
        autoNext: state.config.autoNext,
        navigating: state.navigating,
        nextRun: state.nextRun,
        route: getRouteParams(),
      });
      return;
    }
    state.nextRun = Date.now();
    let currentId = getCurrentSourceId();
    const currentRoute = getRouteParams();
    log('开始寻找下一个视频', {
      currentSourceId: currentId,
      currentRoute,
      runId: state.nextRun,
    });
    let currentChapterId = currentRoute.chapterId;
    let currentSectionId = currentRoute.sectionId;
    const visitedChapters = new Set();
    const visitedSections = new Set();
    if (currentChapterId) visitedChapters.add(normalizeId(currentChapterId));
    if (currentSectionId) visitedSections.add(normalizeId(currentSectionId));

    try {
      const searchStartedAt = performance.now();
      const lazyResult = await findNextVideoEntryLazy(currentRoute, currentId);
      log('惰性搜索完成', {
        elapsedMs: Math.round(performance.now() - searchStartedAt),
        available: lazyResult.available,
        reason: lazyResult.reason || '',
        unitCount: lazyResult.unitCount || 0,
        startUnitIndex: lazyResult.startUnitIndex == null ? -1 : lazyResult.startUnitIndex,
        matchedUnitIndex: lazyResult.matchedUnitIndex == null ? -1 : lazyResult.matchedUnitIndex,
        scannedUnitCount: lazyResult.scannedUnitCount || 0,
        requestCount: lazyResult.requestCount || 0,
        nextEntry: lazyResult.entry ? {
          id: lazyResult.entry.id,
          title: lazyResult.entry.title || '',
          route: lazyResult.entry.route,
        } : null,
      });

      if (lazyResult.available && lazyResult.entry) {
        if (navigateToEntry(lazyResult.entry)) return;
        logWarning('惰性搜索已找到视频但无法直接跳转，改用DOM目录兜底', {
          entry: {
            id: lazyResult.entry.id,
            title: lazyResult.entry.title || '',
            route: lazyResult.entry.route,
          },
        });
      } else if (lazyResult.available) {
        notify('已到达课程最后一个可用视频');
        logWarning('惰性搜索未找到后续视频', {
          currentId,
          currentRoute,
          scannedUnitCount: lazyResult.scannedUnitCount || 0,
          requestCount: lazyResult.requestCount || 0,
        });
        return;
      } else {
        logWarning('惰性搜索不可用，改用DOM目录兜底', {
          reason: lazyResult.reason || 'unknown',
          currentId,
          currentRoute,
        });
      }

      for (let hop = 0; hop < 64; hop += 1) {
        const entries = collectCatalogEntries();
        const uniqueEntries = [];
        const seen = new Set();
        entries.forEach((entry) => {
          if (!seen.has(entry.id)) {
            seen.add(entry.id);
            uniqueEntries.push(entry);
          }
        });

        const currentIndex = currentId
          ? uniqueEntries.findIndex((entry) => entry.id === currentId)
          : -1;
        const next = currentIndex >= 0 ? uniqueEntries[currentIndex + 1] : null;
        log('DOM兜底目录扫描', {
          hop,
          currentId,
          currentChapterId,
          currentSectionId,
          entryCount: entries.length,
          uniqueEntryCount: uniqueEntries.length,
          currentIndex,
          nextEntry: next ? { id: next.id, title: next.title || '', route: next.route } : null,
          dom: {
            chapterNodeCount: getChapterNavigationNodes().length,
            sectionNodeCount: getSectionNavigationNodes().length,
            sourceNodeCount: document.querySelectorAll('[ng-click*="goSource"]').length,
          },
        });
        if (next && navigateToEntry(next)) return;

        const nextSection = clickNextSection(currentChapterId, currentSectionId);
        if (nextSection) {
          const nextSectionId = normalizeId(nextSection.route && nextSection.route.sectionId);
          if (!nextSectionId || visitedSections.has(nextSectionId)) {
            logWarning('检测到重复小节，停止小节遍历', { currentChapterId, currentSectionId, nextSectionId });
          } else {
            visitedSections.add(nextSectionId);
            notify('正在进入下一小节');
            const firstVideoNode = await waitForSectionVideoNode(nextSectionId);
            if (firstVideoNode && clickCatalogVideoNode(firstVideoNode)) return;
            logWarning('下一小节未找到可点击的视频节点', {
              nextSectionId,
              route: getRouteParams(),
              sourceNodeCount: document.querySelectorAll('[ng-click*="goSource"]').length,
            });
            currentSectionId = nextSectionId;
            currentId = '';
            continue;
          }
        }

        const nextChapter = clickNextChapter(currentChapterId);
        if (!nextChapter) {
          if (!uniqueEntries.length) {
            notify('暂未读取到可用的视频列表');
            logWarning('课程视频列表为空，无法自动连播', { currentId, currentChapterId });
          } else {
            notify('已到达课程最后一个可用视频');
            logWarning('没有下一个视频资源', {
              currentId,
              currentIndex,
              currentChapterId,
              total: uniqueEntries.length,
            });
          }
          return;
        }

        const nextChapterId = normalizeId(nextChapter.item && nextChapter.item.id);
        if (!nextChapterId || visitedChapters.has(nextChapterId)) {
          logWarning('检测到重复章节，停止自动连播', { currentChapterId, nextChapterId });
          notify('未找到下一个可播放视频');
          return;
        }
        visitedChapters.add(nextChapterId);
        notify('正在进入下一章节');

        const chapterEntries = await waitForChapterEntries(nextChapterId, currentId);
        const firstVideo = chapterEntries.find((entry) =>
          normalizeId(entry.route.chapterId) === nextChapterId &&
          normalizeId(entry.id) !== normalizeId(currentId)
        );
        if (firstVideo && navigateToEntry(firstVideo)) return;

        // 当前章节没有视频时继续点击下一个章节，直到目录末尾。
        currentChapterId = nextChapterId;
        currentSectionId = '';
        visitedSections.clear();
        currentId = '';
      }
      notify('未找到下一个可播放视频');
      logWarning('超过章节遍历上限，停止自动连播');
    } catch (error) {
      notify('自动连播失败，请查看控制台日志');
      logError('自动连播异常', { error, snapshot: getDiagnosticSnapshot() });
    } finally {
      const finishedRunId = state.nextRun;
      log('自动连播流程结束', {
        runId: finishedRunId,
        route: getRouteParams(),
        navigating: state.navigating,
      });
      setTimeout(() => {
        if (state.nextRun === finishedRunId) state.nextRun = 0;
      }, 500);
    }
  }

  function onVideoEnded(video, generation) {
    if (generation !== state.videoGeneration || state.video !== video) {
      logWarning('忽略过期播放器的ended事件', {
        eventGeneration: generation,
        currentGeneration: state.videoGeneration,
        isCurrentVideo: state.video === video,
      });
      return;
    }
    const currentSourceId = getCurrentSourceId();
    const key = location.href + '|' + currentSourceId;
    const endedKey = 'ended:' + key;
    if (state.handledErrors.has(endedKey)) {
      logWarning('忽略重复ended事件', { currentSourceId, route: getRouteParams() });
      return;
    }
    state.handledErrors.add(endedKey);
    const routeAtEnd = location.href;
    log('检测到视频播放结束', {
      generation,
      currentSourceId,
      route: getRouteParams(),
      currentTime: Number(video.currentTime) || 0,
      duration: Number(video.duration) || 0,
      nextDelay: state.config.nextDelay,
    });
    setTimeout(() => {
      if (generation !== state.videoGeneration || state.video !== video || location.href !== routeAtEnd) {
        logWarning('结束后自动连播已取消：播放器或路由发生变化', {
          eventGeneration: generation,
          currentGeneration: state.videoGeneration,
          isCurrentVideo: state.video === video,
          routeAtEnd: sanitizeUrlForLog(routeAtEnd),
          currentUrl: sanitizeUrlForLog(location.href),
        });
        return;
      }
      log('结束等待完成，开始执行自动连播', { currentSourceId, route: getRouteParams() });
      playNextVideo();
    }, state.config.nextDelay);
  }

  function bindVideo(video) {
    if (!video || state.video === video) {
      applyMediaSettings(video, false);
      return;
    }

    state.video = video;
    state.player = findVideoJsPlayer(video);
    patchBackgroundPausePolicy();
    if (state.player && typeof state.player.pause === 'function' && !state.player.__fastuoocPausePatched) {
      const originalPause = state.player.pause.bind(state.player);
      state.player.pause = function (...args) {
        if (shouldRecoverBackgroundPlayback(video)) {
          log('拦截平台后台暂停');
          return state.player;
        }
        return originalPause(...args);
      };
      state.player.__fastuoocPausePatched = true;
    }
    state.videoGeneration += 1;
    state.attemptedSources = new Set(getPlayerSources(video, state.player).slice(0, 1));
    const generation = state.videoGeneration;

    const apply = () => applyMediaSettings(video, true);
    ['loadedmetadata', 'canplay', 'play', 'ratechange', 'volumechange'].forEach((event) => {
      video.addEventListener(event, apply, { passive: true });
    });
    video.addEventListener('pause', () => {
      if (shouldRecoverBackgroundPlayback(video)) recoverBackgroundPlayback('pause');
    }, { passive: true });
    const handleEnded = () => {
      state.intendedPlayback = false;
      onVideoEnded(video, generation);
    };
    video.addEventListener('ended', handleEnded, { passive: true });
    if (state.player && typeof state.player.on === 'function') {
      state.player.on('ended', handleEnded);
    }
    video.addEventListener('error', () => {
      if (generation !== state.videoGeneration) return;
      const key = `${location.href}|${video.currentSrc || video.src}`;
      if (state.handledErrors.has(key)) return;
      state.handledErrors.add(key);
      logError('播放器触发error事件', {
        route: getRouteParams(),
        currentSrc: sanitizeUrlForLog(video.currentSrc || video.src || ''),
        mediaError: video.error ? {
          code: video.error.code,
          message: video.error.message || '',
        } : null,
        networkState: video.networkState,
        readyState: video.readyState,
      });
      if (!tryNextSource(video)) {
        logWarning('视频资源不可用，未找到可切换线路', {
          currentSrc: sanitizeUrlForLog(video.currentSrc || video.src || ''),
          attemptedSources: Array.from(state.attemptedSources).map(sanitizeUrlForLog),
        });
        notify('视频资源不可用，未找到可切换线路');
      }
    }, { passive: true });

    applyMediaSettings(video, true);
    log('已接管播放器', {
      generation,
      route: getRouteParams(),
      currentSourceId: getCurrentSourceId(),
      currentSrc: sanitizeUrlForLog(video.currentSrc || video.src || ''),
      sources: getPlayerSources(video, state.player).map(sanitizeUrlForLog),
      videoJsPlayerFound: Boolean(state.player),
      readyState: video.readyState,
      networkState: video.networkState,
    });
  }

  function scan() {
    patchBackgroundPausePolicy();
    if (enforceMasterConfig()) saveConfig();
    const video = findNativeVideo();
    if (video) bindVideo(video);
  }

  function installControls() {
    const style = document.createElement('style');
    style.textContent = [
      '#fastuooc-auto-player-controls{--panel-bg:rgba(18,24,36,.96);--panel-border:rgba(148,163,184,.22);--panel-text:#e7edf7;--panel-muted:#94a3b8;--button-bg:rgba(51,65,85,.68);--button-text:#dbeafe;position:fixed;right:18px;bottom:20px;z-index:2147483646;width:318px;color:var(--panel-text);background:var(--panel-bg);border:1px solid var(--panel-border);border-radius:14px;box-shadow:0 14px 38px rgba(15,23,42,.28),0 3px 10px rgba(15,23,42,.18);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden;backdrop-filter:blur(14px);transition:width .22s ease,transform .22s ease,box-shadow .22s ease}',
      '#fastuooc-auto-player-controls[data-theme="light"]{--panel-bg:rgba(255,255,255,.96);--panel-border:rgba(15,23,42,.12);--panel-text:#172033;--panel-muted:#64748b;--button-bg:#f1f5f9;--button-text:#334155;box-shadow:0 14px 38px rgba(15,23,42,.16),0 3px 10px rgba(15,23,42,.1)}',
      '#fastuooc-auto-player-controls[data-theme="dark"]{--panel-bg:rgba(18,24,36,.96);--panel-border:rgba(148,163,184,.22);--panel-text:#e7edf7;--panel-muted:#94a3b8;--button-bg:rgba(51,65,85,.68);--button-text:#dbeafe}',
      '@media (prefers-color-scheme:light){#fastuooc-auto-player-controls[data-theme="system"]{--panel-bg:rgba(255,255,255,.96);--panel-border:rgba(15,23,42,.12);--panel-text:#172033;--panel-muted:#64748b;--button-bg:#f1f5f9;--button-text:#334155}}',
      '@media (prefers-color-scheme:dark){#fastuooc-auto-player-controls[data-theme="system"]{--panel-bg:rgba(18,24,36,.96);--panel-border:rgba(148,163,184,.22);--panel-text:#e7edf7;--panel-muted:#94a3b8;--button-bg:rgba(51,65,85,.68);--button-text:#dbeafe}}',
      '#fastuooc-auto-player-controls:hover{transform:translateY(-2px);box-shadow:0 16px 40px rgba(15,23,42,.34),0 3px 10px rgba(15,23,42,.2)}',
      '#fastuooc-auto-player-controls.is-collapsed{width:42px;border-radius:21px}',
      '#fastuooc-auto-player-controls.is-collapsed .fastuooc-auto-player-title-main,#fastuooc-auto-player-controls.is-collapsed .fastuooc-auto-player-body,#fastuooc-auto-player-controls.is-collapsed .fastuooc-auto-player-github{display:none}',
      '#fastuooc-auto-player-controls.is-collapsed .fastuooc-auto-player-title{justify-content:center;padding:9px 0}',
      '#fastuooc-auto-player-controls.is-collapsed .fastuooc-auto-player-title-tools{display:block}',
      '#fastuooc-auto-player-controls.is-collapsed .fastuooc-auto-player-collapse svg{transform:rotate(180deg)}',
      '.fastuooc-auto-player-title{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 13px 9px;color:var(--panel-text);font-weight:650;white-space:nowrap}',
      '.fastuooc-auto-player-title-main{display:flex;align-items:center;min-width:0}',
      '.fastuooc-auto-player-title-main span:last-child{overflow:hidden;text-overflow:ellipsis}',
      '.fastuooc-auto-player-title-tools{display:flex;align-items:center;gap:5px}',
      '.fastuooc-auto-player-github{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;color:var(--panel-muted);text-decoration:none;transition:background .18s ease,color .18s ease,transform .18s ease}',
      '.fastuooc-auto-player-github:hover{background:var(--button-bg);color:var(--panel-text);transform:translateY(-1px)}',
      '.fastuooc-auto-player-github svg{width:17px;height:17px;fill:currentColor}',
      '.fastuooc-auto-player-collapse{display:inline-flex;align-items:center;justify-content:center;width:30px!important;height:30px!important;padding:0!important;border:0!important;border-radius:50%!important;background:transparent!important;color:var(--panel-muted)!important;font-size:0!important;line-height:1!important;transition:background .18s ease,color .18s ease,transform .18s ease!important}',
      '.fastuooc-auto-player-collapse:hover{background:var(--button-bg)!important;color:var(--panel-text)!important;transform:none!important}',
      '.fastuooc-auto-player-collapse svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:transform .2s ease}',
      '.fastuooc-auto-player-body{display:flex;flex-direction:column;gap:10px;padding:10px 13px 13px;border-top:1px solid var(--panel-border)}',
      '.fastuooc-auto-player-actions{display:flex;flex-direction:column;gap:5px}',
      '#fastuooc-auto-player-controls button{cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.fastuooc-auto-player-toggle-row{display:flex!important;align-items:center;justify-content:space-between;width:100%!important;height:38px!important;border:0!important;border-radius:10px!important;padding:0 9px 0 11px!important;background:transparent!important;color:var(--panel-text)!important;cursor:pointer;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;text-align:left;transform:none!important}',
      '.fastuooc-auto-player-toggle-row:hover{background:var(--button-bg)!important;color:var(--panel-text)!important;transform:none!important}',
      '.fastuooc-auto-player-toggle-row:disabled{opacity:.42!important;cursor:not-allowed!important}',
      '.fastuooc-auto-player-toggle-row:disabled:hover{background:transparent!important;color:var(--panel-text)!important}',
      '.fastuooc-auto-player-toggle-row:disabled .fastuooc-auto-player-toggle-switch{opacity:.72}',
      '.fastuooc-auto-player-toggle-label{display:flex;align-items:center;gap:7px}',
      '.fastuooc-auto-player-toggle-switch{position:relative;width:42px;height:25px;flex:none;border-radius:999px;background:var(--panel-muted);box-shadow:inset 0 0 0 1px rgba(15,23,42,.12);transition:background .2s ease,box-shadow .2s ease}',
      '.fastuooc-auto-player-toggle-switch i{position:absolute;top:3px;left:3px;width:19px;height:19px;border-radius:50%;background:#fff;box-shadow:0 2px 5px rgba(15,23,42,.28);transition:transform .2s cubic-bezier(.22,.61,.36,1)}',
      '.fastuooc-auto-player-toggle-row.is-on .fastuooc-auto-player-toggle-switch{background:#22c55e;box-shadow:inset 0 0 0 1px rgba(21,128,61,.18)}',
      '.fastuooc-auto-player-toggle-row.is-on .fastuooc-auto-player-toggle-switch i{transform:translateX(17px)}',
      '.fastuooc-auto-player-toggle-row:disabled.is-on .fastuooc-auto-player-toggle-switch{background:var(--panel-muted);box-shadow:inset 0 0 0 1px rgba(100,116,139,.2)}',
      '.fastuooc-auto-player-export{display:flex!important;align-items:center;justify-content:center;gap:7px;width:100%!important;height:38px!important;border:1px solid var(--panel-border)!important;border-radius:10px!important;padding:0 11px!important;background:var(--button-bg)!important;color:var(--button-text)!important;cursor:pointer;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;text-align:center}',
      '.fastuooc-auto-player-export:hover{background:#2563eb!important;border-color:#60a5fa!important;color:#fff!important;transform:none!important}',
      '.fastuooc-auto-player-export svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}',
      '.fastuooc-auto-player-ai-row{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
      '.fastuooc-auto-player-ai{display:flex!important;align-items:center;justify-content:center;width:100%!important;height:36px!important;border:1px solid var(--panel-border)!important;border-radius:10px!important;padding:0 8px!important;background:var(--button-bg)!important;color:var(--button-text)!important;cursor:pointer;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important}',
      '.fastuooc-auto-player-ai:hover{background:#2563eb!important;border-color:#60a5fa!important;color:#fff!important;transform:none!important}',
      '.fastuooc-auto-player-ai:disabled{opacity:.55!important;cursor:not-allowed!important}',
      '.fastuooc-auto-player-theme{display:flex!important;align-items:center;justify-content:space-between;width:100%!important;height:38px!important;border:1px solid var(--panel-border)!important;border-radius:10px!important;padding:0 11px!important;background:var(--button-bg)!important;color:var(--button-text)!important;cursor:pointer;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;text-align:left}',
      '.fastuooc-auto-player-theme:hover{background:#2563eb!important;border-color:#60a5fa!important;color:#fff!important;transform:none!important}',
      '.fastuooc-auto-player-theme-value{color:var(--panel-muted);font-size:11px}',
      '.fastuooc-auto-player-theme:hover .fastuooc-auto-player-theme-value{color:rgba(255,255,255,.82)}',
      '.fastuooc-auto-player-state{align-self:flex-start;color:var(--panel-muted);font-size:12px;white-space:nowrap}',
      '@media (max-width:480px){#fastuooc-auto-player-controls{right:10px;bottom:10px;width:min(318px,calc(100vw - 20px))}}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);

    const mount = () => {
      if (document.getElementById('fastuooc-auto-player-controls')) return;
      const box = document.createElement('div');
      box.id = 'fastuooc-auto-player-controls';
      box.innerHTML = [
        '<div class="fastuooc-auto-player-title">',
        '<div class="fastuooc-auto-player-title-main"><span>Fast UOOC</span></div>',
        '<div class="fastuooc-auto-player-title-tools">',
        '<a class="fastuooc-auto-player-github" href="https://github.com/Liunian06/fastuooc" target="_blank" rel="noopener noreferrer" title="打开GitHub项目主页" aria-label="打开GitHub项目主页">',
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.01c-3.2.7-3.87-1.54-3.87-1.54-.53-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.26-1.28-5.26-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11.06 11.06 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.12 3.06.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.27 5.68.42.36.78 1.08.78 2.18v3.23c0 .31.21.67.8.56A11.52 11.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"></path></svg>',
        '</a>',
        '<button class="fastuooc-auto-player-collapse" data-action="collapse" title="折叠控制面板" aria-label="折叠控制面板"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"></path></svg></button>',
        '</div>',
        '</div>',
        '<div class="fastuooc-auto-player-body">',
        '<span class="fastuooc-auto-player-state" data-role="state"></span>',
        '<div class="fastuooc-auto-player-actions">',
        '<button class="fastuooc-auto-player-toggle-row" data-action="enabled" title="开启或关闭自动控制" aria-label="开启或关闭自动控制" aria-pressed="false">',
        '<span class="fastuooc-auto-player-toggle-label"><span>自动控制</span></span>',
        '<span class="fastuooc-auto-player-toggle-switch" aria-hidden="true"><i></i></span>',
        '</button>',
        '<button class="fastuooc-auto-player-toggle-row" data-action="next" title="开启或关闭自动连播" aria-label="开启或关闭自动连播" aria-pressed="false">',
        '<span class="fastuooc-auto-player-toggle-label"><span>自动连播</span></span>',
        '<span class="fastuooc-auto-player-toggle-switch" aria-hidden="true"><i></i></span>',
        '</button>',
        '<button class="fastuooc-auto-player-toggle-row" data-action="mute" title="切换静音" aria-label="切换静音" aria-pressed="false">',
        '<span class="fastuooc-auto-player-toggle-label"><span>静音</span></span>',
        '<span class="fastuooc-auto-player-toggle-switch" aria-hidden="true"><i></i></span>',
        '</button>',
        '<button class="fastuooc-auto-player-toggle-row" data-action="background" title="允许后台播放" aria-label="允许后台播放" aria-pressed="false">',
        '<span class="fastuooc-auto-player-toggle-label"><span>后台播放</span></span>',
        '<span class="fastuooc-auto-player-toggle-switch" aria-hidden="true"><i></i></span>',
        '</button>',
        '<button class="fastuooc-auto-player-export" data-action="export" title="导出当前测验题目和选项" aria-label="导出当前测验题目和选项">',
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>',
        '<span>导出题目</span>',
        '</button>',
        '<div class="fastuooc-auto-player-ai-row">',
        '<button class="fastuooc-auto-player-ai" data-action="ai-analyze" title="获取AI参考选项，不会自动作答">AI参考</button>',
        '<button class="fastuooc-auto-player-ai" data-action="ai-settings" title="配置OpenAI兼容接口">AI设置</button>',
        '</div>',
        '<button class="fastuooc-auto-player-theme" data-action="theme" title="切换界面主题：跟随系统、浅色、深色" aria-label="切换界面主题">',
        '<span>界面主题</span><span class="fastuooc-auto-player-theme-value"></span>',
        '</button>',
        '</div>',
        '</div>',
      ].join('');
      const update = () => {
        const enabled = box.querySelector('[data-action="enabled"]');
        const next = box.querySelector('[data-action="next"]');
        const mute = box.querySelector('[data-action="mute"]');
        const background = box.querySelector('[data-action="background"]');
        const theme = box.querySelector('[data-action="theme"]');
        const aiAnalyze = box.querySelector('[data-action="ai-analyze"]');
        const masterEnabled = state.config.enabled;
        const themeMode = ['system', 'light', 'dark'].includes(state.config.theme) ? state.config.theme : 'system';
        const themeLabel = themeMode === 'system' ? '跟随系统' : themeMode === 'light' ? '浅色' : '深色';
        box.dataset.theme = themeMode;
        if (masterEnabled && enforceMasterConfig()) saveConfig();
        [[enabled, state.config.enabled, false], [next, state.config.autoNext, masterEnabled], [mute, state.config.muted, masterEnabled], [background, state.config.keepBackground, masterEnabled]].forEach(([button, isOn, disabled]) => {
          button.classList.toggle('is-on', isOn);
          button.disabled = disabled;
          button.setAttribute('aria-pressed', String(isOn));
          button.setAttribute('aria-disabled', String(disabled));
        });
        aiAnalyze.disabled = state.aiRunning;
        aiAnalyze.textContent = state.aiRunning ? '分析中…' : 'AI参考';
        theme.querySelector('.fastuooc-auto-player-theme-value').textContent = themeLabel;
        theme.setAttribute('aria-label', `切换界面主题，当前为${themeLabel}`);
        box.querySelector('[data-role="state"]').textContent = masterEnabled ? `${state.config.speed}倍速 · 静音 · 后台播放 · ${themeLabel}` : `${state.config.speed}倍速 · ${state.config.autoNext ? '连播' : '不连播'} · ${state.config.muted ? '静音' : '有声'} · ${state.config.keepBackground ? '后台播放' : '前台播放'} · ${themeLabel}`;
      };
      box.addEventListener('click', (event) => {
        const control = event.target.closest('[data-action]');
        if (!control || !box.contains(control)) return;
        const action = control.dataset.action;
        if (action === 'collapse') {
          const collapsed = box.classList.toggle('is-collapsed');
          control.setAttribute('title', collapsed ? '展开控制面板' : '折叠控制面板');
          control.setAttribute('aria-label', collapsed ? '展开控制面板' : '折叠控制面板');
          return;
        }
        if (action === 'export') {
          exportQuiz();
          return;
        }
        if (action === 'ai-settings') {
          openAISettings();
          return;
        }
        if (action === 'ai-analyze') {
          if (state.aiRunning) return;
          state.aiRunning = true;
          update();
          (async () => {
            try {
              const quiz = findQuizQuestions();
              if (!quiz) {
                notify('当前页面未找到可分析的题目');
                return;
              }
              const selectable = quiz.questions.filter((item) => item.options.length > 0);
              const existing = selectable.filter((item) => state.aiResults.has(item.element) || item.element.querySelector('.fastuooc-ai-reference:not(.is-loading)'));
              let mode = 'all';
              if (existing.length) {
                const uncertain = existing.filter((item) => {
                  const cached = state.aiResults.get(item.element);
                  return !cached || !cached.options || !cached.options.length;
                });
                mode = await openAIReferenceModeDialog(existing.length, uncertain.length);
                if (mode === 'cancel') return;
              }
              await requestQuizAIReference(mode);
            } finally {
              state.aiRunning = false;
              update();
            }
          })();
          return;
        }
        if (action === 'enabled') state.config.enabled = !state.config.enabled;
        if (action === 'next' && !state.config.enabled) state.config.autoNext = !state.config.autoNext;
        if (action === 'mute' && !state.config.enabled) state.config.muted = !state.config.muted;
        if (action === 'background' && !state.config.enabled) state.config.keepBackground = !state.config.keepBackground;
        if (action === 'theme') {
          const modes = ['system', 'light', 'dark'];
          const index = modes.indexOf(state.config.theme);
          state.config.theme = modes[(index + 1 + modes.length) % modes.length];
        }
        saveConfig();
        update();
        scan();
      });
      (document.body || document.documentElement).appendChild(box);
      update();
    };
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
  }

  function observe() {
    const observer = new MutationObserver(() => {
      if (location.href !== state.lastRoute) {
        const previousUrl = state.lastRoute;
        state.lastRoute = location.href;
        log('检测到页面路由变化', {
          from: sanitizeUrlForLog(previousUrl),
          to: sanitizeUrlForLog(state.lastRoute),
          route: getRouteParams(),
        });
        state.video = null;
        state.player = null;
        state.handledErrors.clear();
        state.attemptedSources.clear();
        state.intendedPlayback = false;
        state.navigating = false;
      }
      scan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('hashchange', () => setTimeout(scan, 100));
    setInterval(scan, 800);
  }

  function start() {
    installDebugApi();
    log('脚本启动', {
      version: SCRIPT_VERSION,
      url: sanitizeUrlForLog(location.href),
      runAt: document.readyState,
      unsafeWindowAvailable: typeof unsafeWindow !== 'undefined',
      angularAvailable: Boolean(pageWindow.angular),
      videoJsAvailable: Boolean(pageWindow.videojs),
      config: getDiagnosticSnapshot().config,
    });
    installControls();
    startBackgroundPlaybackGuard();
    observe();
    scan();
  }

  start();
})();


