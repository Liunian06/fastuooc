// ==UserScript==
// @name         Fast UOOC
// @namespace    fastuooc.local
// @version      0.9.1
// @description  自动控制UOOC视频播放、课程讨论和题目导出，支持传统自动讨论、基于帖子内容生成纯文本回复的AI讨论、测验/作业/考试长截图与新版考核批量截图，并提供仅供参考的AI选项分析。
// @homepageURL  https://greasyfork.org/zh-CN/scripts/595099-fast-uooc
// @supportURL   https://github.com/Liunian06/fastuooc/issues/
// @tag          uooc
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @resource    fastuooc-sponsor-image https://raw.githubusercontent.com/Liunian06/fastuooc/main/buymecoffee.jpg?v=0.9.1
// @author       Liunian06
// @license      MIT
// @match        *://www.uooc.net.cn/home/learn/*
// @match        *://*.uooc.net.cn/home/learn/*
// @match        *://*.uooconline.com/home/learn/*
// @match        *://*.uooc.online/home/learn/*
// @match        *://www.uooc.net.cn/home/course/*
// @match        *://*.uooc.net.cn/home/course/*
// @match        *://*.uooconline.com/home/course/*
// @match        *://*.uooc.online/home/course/*
// @match        *://www.uooc.net.cn/exam/*
// @match        *://*.uooc.net.cn/exam/*
// @match        *://*.uooconline.com/exam/*
// @match        *://*.uooc.online/exam/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_download
// @grant        GM_getResourceURL
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const SCRIPT_VERSION = '0.9.1';
  const LOG_PREFIX = '[Fast UOOC v' + SCRIPT_VERSION + ']';
  const CONFIG_KEY = 'fastuooc:auto-player:config';
  const SCREENSHOT_SCALE_DEFAULT = 1.5;
  const SCREENSHOT_SCALE_MIN = 0.5;
  const SCREENSHOT_SCALE_MAX = 4;
  const SPONSOR_IMAGE_URL = (() => {
    try {
      return typeof GM_getResourceURL === 'function'
        ? GM_getResourceURL('fastuooc-sponsor-image') || 'https://raw.githubusercontent.com/Liunian06/fastuooc/main/buymecoffee.jpg?v=0.9.1'
        : 'https://raw.githubusercontent.com/Liunian06/fastuooc/main/buymecoffee.jpg?v=0.9.1';
    } catch (_) {
      return 'https://raw.githubusercontent.com/Liunian06/fastuooc/main/buymecoffee.jpg?v=0.9.1';
    }
  })();
  const ASSESSMENT_SELECTION_KEY_PREFIX = 'fastuooc:assessment-batch:selection:';
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
    discussionCount: 1,
    discussionUnlimited: false,
    screenshotScale: SCREENSHOT_SCALE_DEFAULT,
    assessmentBatchMode: 'visible',
  });
  const AI_MAX_CONCURRENCY = 10;
  const AI_VISION_MAX_CONCURRENCY = 5;
  const QUIZ_IMAGE_MAX_CONCURRENCY = 10;

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
    aiQueue: { active: 0, visionActive: 0, pending: [] },
    quizImageQueue: { active: 0, pending: [] },
    aiResults: new WeakMap(),
    aiRunning: false,
    screenshotRunning: false,
    assessmentBatch: {
      active: false,
      route: '',
      runId: 0,
      phase: 'idle',
      items: [],
      queue: [],
      index: 0,
      completed: 0,
      failures: [],
      frame: null,
      tab: null,
      token: '',
      expectedUrl: '',
      requestId: '',
      requested: false,
      result: null,
    },
    discussion: {
      running: false,
      phase: 'idle',
      completed: 0,
      target: 1,
      timer: null,
      runId: 0,
      lastPage: 0,
      lastThreadId: '',
      lastContent: '',
      lastTitle: '',
      lastReply: '',
      seenThreadIds: new Set(),
      remainingMs: 0,
    },
    aiDiscussion: {
      running: false,
      phase: 'idle',
      completed: 0,
      target: 1,
      timer: null,
      runId: 0,
      lastPage: 0,
      lastThreadId: '',
      lastTitle: '',
      lastContent: '',
      lastReply: '',
      remainingMs: 0,
      seenThreadIds: new Set(),
    },
    discussionExitTimer: null,
    controlsUpdate: null,
  };

  function loadConfig() {
    try {
      const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
      const legacyApiKey = stored.aiApiKey || '';
      delete stored.aiApiKey;
      if (legacyApiKey) localStorage.setItem(CONFIG_KEY, JSON.stringify(stored));
      const config = Object.assign({}, DEFAULT_CONFIG, stored);
      const screenshotScale = Number(config.screenshotScale);
      config.screenshotScale = config.screenshotScale != null && config.screenshotScale !== '' && Number.isFinite(screenshotScale)
        ? Math.min(SCREENSHOT_SCALE_MAX, Math.max(SCREENSHOT_SCALE_MIN, screenshotScale))
        : SCREENSHOT_SCALE_DEFAULT;
      config.assessmentBatchMode = config.assessmentBatchMode === 'hidden' ? 'hidden' : 'visible';
      config.speed = DEFAULT_CONFIG.speed;
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
        discussionCount: state.config.discussionCount,
        discussionUnlimited: state.config.discussionUnlimited,
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
        discussion: {
          running: state.discussion.running,
          phase: state.discussion.phase,
          completed: state.discussion.completed,
          target: state.discussion.target,
          lastPage: state.discussion.lastPage,
          lastThreadId: state.discussion.lastThreadId,
          remainingMs: state.discussion.remainingMs,
        },
        aiDiscussion: {
          running: state.aiDiscussion.running,
          phase: state.aiDiscussion.phase,
          completed: state.aiDiscussion.completed,
          target: state.aiDiscussion.target,
          lastPage: state.aiDiscussion.lastPage,
          lastThreadId: state.aiDiscussion.lastThreadId,
          remainingMs: state.aiDiscussion.remainingMs,
        },
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

  const DISCUSSION_WAIT_MS = 120000;
  const DISCUSSION_REPLY_MAX_LENGTH = 600;
  const DISCUSSION_OPERATION_TIMEOUT = 18000;

  function refreshControls() {
    if (typeof state.controlsUpdate === 'function') state.controlsUpdate();
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function createStoppedDiscussionError() {
    const error = new Error('自动讨论已停止');
    error.code = 'DISCUSSION_STOPPED';
    return error;
  }

  function assertDiscussionRun(runId) {
    if (!state.discussion.running || state.discussion.runId !== runId) {
      throw createStoppedDiscussionError();
    }
  }

  function assertAIDiscussionRun(runId) {
    if (!state.aiDiscussion.running || state.aiDiscussion.runId !== runId) {
      throw createStoppedDiscussionError();
    }
  }

  async function waitForCondition(predicate, options = {}) {
    const timeout = Math.max(500, Number(options.timeout) || 10000);
    const interval = Math.max(50, Number(options.interval) || 250);
    const runId = options.runId;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (typeof options.assertRun === 'function') options.assertRun();
      else if (runId != null) assertDiscussionRun(runId);
      if (options.isCancelled && options.isCancelled()) return null;
      try {
        const value = await predicate();
        if (value) return value;
      } catch (error) {
        if (error && error.code === 'DISCUSSION_STOPPED') throw error;
      }
      await sleep(interval);
    }
    return null;
  }

  function getDiscussionRoute() {
    const segments = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const normalized = segments.map((part) => {
      try { return decodeURIComponent(part); } catch (_) { return part; }
    }).map((part) => String(part).split(/[?#;]/)[0]);
    const normalizedLower = normalized.map((part) => part.toLowerCase());
    const stateService = getStateService();
    const stateName = stateService && stateService.current && stateService.current.name || '';
    const stateParams = stateService && stateService.params || {};
    const pathMatch = location.pathname.match(/\/home\/course(?:\/new)?\/(\d+)/i);
    const courseId = String(
      stateParams.courseId ||
      (pathMatch && pathMatch[1]) ||
      pageWindow.cid ||
      ''
    );
    const hasOldDetailHash = normalizedLower[0] === 'discussdetail';
    const hasOldListHash = normalizedLower[0] === 'discusscom';
    const hasNewDetailHash = !hasOldDetailHash && normalizedLower.includes('discussdetail');
    const hasNewListHash = !hasOldDetailHash && !hasOldListHash && normalizedLower[0] === 'discuss';
    const isOldDetail = hasOldDetailHash || (!hasNewDetailHash && stateName === 'course.discussdetail');
    const isOldList = !isOldDetail && (hasOldListHash || (!hasNewListHash && stateName === 'course.discusscom'));
    const isNewDetail = !isOldDetail && (hasNewDetailHash || stateName === 'course.discuss.discussDetail');
    const isNewList = !isOldDetail && !isNewDetail && (hasNewListHash || stateName === 'course.discuss');
    let threadId = String(stateParams.tid || '');
    if (!threadId && isOldDetail && normalized[2]) threadId = normalized[2];
    if (!threadId && isNewDetail) {
      const numericSegments = normalized.filter((part) => /^\d+$/.test(part));
      const threadCandidates = numericSegments.filter((part) => String(part) !== String(courseId));
      threadId = threadCandidates[0] || numericSegments[0] || '';
    }
    return {
      kind: isNewDetail || isOldDetail ? 'detail' : isNewList || isOldList ? 'list' : '',
      mode: isNewDetail || isNewList ? 'new' : isOldDetail || isOldList ? 'old' : '',
      courseId,
      threadId,
      stateName,
    };
  }

  function findDiscussionScope(nodes, predicate) {
    if (!pageWindow.angular) return null;
    for (const node of nodes) {
      try {
        const scope = climbScope(pageWindow.angular.element(node).scope(), predicate);
        if (scope) return scope;
      } catch (_) {}
    }
    return null;
  }

  function getDiscussionListScope() {
    if (!pageWindow.angular) return null;
    const nodes = document.querySelectorAll([
      '[ng-repeat*="chapter_tiezi in questionList[2]"]',
      '[ng-repeat*="tiezi in studentList[0]"]',
      '[ng-repeat*="tiezi in comList"]',
      '[uooc-pager]',
      '.Discuz',
    ].join(','));
    return findDiscussionScope(nodes, (candidate) =>
      (typeof candidate.getPageDiscussion === 'function' && candidate.questionListPaper) ||
      (typeof candidate.getCourseDiscussionList === 'function' && candidate.noteListPaper)
    );
  }

  function getDiscussionDetailScope() {
    if (!pageWindow.angular) return null;
    const nodes = document.querySelectorAll([
      '[thread-detail]',
      '[ng-bind-html*="threads.content"]',
      '.discussionDesc',
      '.thesis-content',
      '.discuss-header',
    ].join(','));
    return findDiscussionScope(nodes, (candidate) =>
      (candidate.threads && (typeof candidate.replay === 'function' || typeof candidate.getList === 'function' || typeof candidate.handleRelease === 'function'))
    );
  }

  function getDiscussionList(scope) {
    if (!scope) return [];
    if (Array.isArray(scope.studentList && scope.studentList[0])) return scope.studentList[0];
    if (Array.isArray(scope.comList)) return scope.comList;
    if (Array.isArray(scope.questionList && scope.questionList[2])) return scope.questionList[2];
    return [];
  }

  function getDiscussionPage(scope, mode) {
    if (!scope) return 0;
    if (mode === 'new' && scope.noteListPaper) return Number(scope.noteListPaper.page) || 0;
    if (scope.questionListPaper && scope.questionListPaper[2]) {
      return Number(scope.questionListPaper[2].page) || 0;
    }
    return Number(scope.noteListPaper && scope.noteListPaper.page) || 0;
  }

  function getDiscussionPageCount(scope, mode) {
    if (!scope) return 0;
    if (mode === 'new' && scope.noteListPaper) return Number(scope.noteListPaper.total) || 0;
    if (scope.questionListPaper && scope.questionListPaper[2]) {
      return Number(scope.questionListPaper[2].pageCount || scope.questionListPaper[2].pages) || 0;
    }
    return Number(scope.noteListPaper && (scope.noteListPaper.total || scope.noteListPaper.pages)) || 0;
  }

  function discussionItemId(item) {
    if (!item) return '';
    return String(item.tid || item.thread_id || item.topic_id || item.id || '');
  }

  function discussionListFingerprint(list) {
    return (Array.isArray(list) ? list : []).map((item) =>
      discussionItemId(item) + ':' + String(item && (item.content || item.subject || item.title || '')).slice(0, 80)
    ).join('|');
  }

  function invokeAngular(scope, callback) {
    return new Promise((resolve, reject) => {
      const execute = () => {
        try {
          const result = callback();
          if (result && typeof result.then === 'function') {
            result.then(resolve, reject);
          } else {
            resolve(result);
          }
        } catch (error) {
          reject(error);
        }
      };
      if (scope && typeof scope.$evalAsync === 'function') scope.$evalAsync(execute);
      else execute();
    });
  }

  function randomInteger(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async function waitForDiscussionList(runId, mode, assertRun) {
    return waitForCondition(() => {
      const scope = getDiscussionListScope();
      if (!scope) return null;
      const list = getDiscussionList(scope);
      const pageCount = getDiscussionPageCount(scope, mode);
      if (!Array.isArray(list) || !pageCount) return null;
      return { scope, list, pageCount };
    }, { timeout: DISCUSSION_OPERATION_TIMEOUT, interval: 250, assertRun: assertRun || (() => assertDiscussionRun(runId)) });
  }

  async function switchDiscussionPage(scope, mode, page, runId, assertRun) {
    const beforeList = getDiscussionList(scope);
    const before = discussionListFingerprint(getDiscussionList(scope));
    await invokeAngular(scope, () => {
      if (mode === 'new') {
        if (scope.noteListPaper) scope.noteListPaper.page = page;
        if (typeof scope.getNoteList === 'function') return scope.getNoteList(page);
        if (typeof scope.getCourseDiscussionList === 'function') return scope.getCourseDiscussionList(page);
      } else {
        if (scope.questionListPaper && scope.questionListPaper[2]) scope.questionListPaper[2].page = page;
        if (typeof scope.getPageDiscussion === 'function') return scope.getPageDiscussion(page);
        if (typeof scope.getDiscussion === 'function') return scope.getDiscussion(page, 2);
      }
      throw new Error('未找到当前版本的讨论分页函数');
    });
    const switched = await waitForCondition(() => {
      const currentScope = getDiscussionListScope();
      if (!currentScope) return null;
      const list = getDiscussionList(currentScope);
      const currentPage = getDiscussionPage(currentScope, mode);
      const changed = list !== beforeList || discussionListFingerprint(list) !== before;
      if (currentPage === page && (changed || page === 1 || list.length === 0)) {
        return { scope: currentScope, list };
      }
      return null;
    }, { timeout: DISCUSSION_OPERATION_TIMEOUT, interval: 250, assertRun: assertRun || (() => assertDiscussionRun(runId)) });
    if (!switched) throw new Error('讨论分页加载超时');
    return getDiscussionListScope();
  }

  function navigateDiscussionDetail(route, threadId) {
    const stateService = getStateService();
    if (stateService && typeof stateService.go === 'function') {
      const target = route.mode === 'new' ? 'course.discuss.discussDetail' : 'course.discussdetail';
      const params = route.mode === 'new'
        ? { tid: String(threadId), courseId: route.courseId }
        : { type: 'com', tid: String(threadId), courseId: route.courseId };
      return Promise.resolve(stateService.go(target, params));
    }
    location.hash = route.mode === 'new'
      ? '#/discuss/' + encodeURIComponent(threadId) + '/' + encodeURIComponent(route.courseId) + '/discussDetail'
      : '#/discussdetail/com/' + encodeURIComponent(threadId);
    return Promise.resolve();
  }

  function navigateDiscussionList(route) {
    const stateService = getStateService();
    if (stateService && typeof stateService.go === 'function') {
      return Promise.resolve(stateService.go(route.mode === 'new' ? 'course.discuss' : 'course.discusscom', {}));
    }
    location.hash = route.mode === 'new' ? '#/discuss' : '#/discusscom';
    return Promise.resolve();
  }

  function discussionHtmlToText(value) {
    const source = String(value || '').trim();
    if (!source) return '';

    const container = document.createElement('div');
    container.innerHTML = source;
    container.querySelectorAll('br').forEach((node) => {
      node.replaceWith(document.createTextNode('\n'));
    });
    container.querySelectorAll('p,div,li,section,article').forEach((node) => {
      node.appendChild(document.createTextNode('\n'));
    });

    return (container.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function getDiscussionTitle(scope) {
    const raw = scope && scope.threads && (scope.threads.subject || scope.threads.title || scope.threads.name);
    if (raw && String(raw).trim()) return discussionHtmlToText(raw);
    const node = document.querySelector('.discussionTitle, .thesis-title, [ng-bind="threads.subject"], [ng-bind="threads.title"]');
    return node ? discussionHtmlToText(node.innerHTML || node.textContent || '') : '';
  }

  function getDiscussionContent(scope) {
    const raw = scope && scope.threads && scope.threads.content;
    if (raw && String(raw).trim()) return discussionHtmlToText(raw);
    const node = document.querySelector('[ng-bind-html="threads.content | to_trusted"], .discussionDesc, .thesis-content');
    return node ? discussionHtmlToText(node.innerHTML || node.textContent || '') : '';
  }

  function normalizeDiscussionReply(value) {
    let text = String(value || '').trim();
    if (!text) return '';
    text = discussionHtmlToText(text)
      .replace(/```(?:text|plaintext|plain)?/gi, '')
      .replace(/```/g, '')
      .replace(/\$\$/g, '')
      .replace(/\\?\(|\\?\)/g, '')
      .replace(/\\?\[|\\?\]/g, '')
      .replace(/\\[a-zA-Z]+/g, '')
      .replace(/[{}]/g, '')
      .replace(/^\s{0,3}#{1,6}\s*/gm, '')
      .replace(/[*_`~]/g, '')
      .replace(/^[ \t]*[-+]\s+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text.slice(0, DISCUSSION_REPLY_MAX_LENGTH).trim();
  }

  function buildAIDiscussionMessages(title, content) {
    return [
      {
        role: 'system',
        content: [
          '你是一名认真参与在线课程讨论的学生。',
          '请根据帖子题目和正文，写一条有价值、具体、自然、有一定新意的中文回复。',
          '回复要回应原帖中的核心问题，补充可执行的理解、方法、例子或容易忽略的角度，避免空泛赞同、重复原文、机械套话和灌水。',
          '只输出最终回复正文，使用纯文本raw text，不要输出Markdown、HTML、LaTeX公式、标题、引号、前缀或解释，也不要提及AI、提示词或生成过程。',
          '如果涉及公式，请改用普通文字、算式或文字描述表达。回复控制在80到220字之间。',
          '负向案例：题目“无穷小和无穷大是很小/很大的数吗？关系是什么？”，回复虽然概念基本准确、表达清楚，但只得到93分，说明仅停留在通用的概念解释、简单倒数关系和趋近过程提醒，缺少更深入的分析、具体方法或独到角度时，不应作为高质量满分范例。',
          '正向案例：题目“极限计算有什么实用技巧？刚学完数列极限与函数极限，每次碰到夹逼准则、洛必达法则的适用场景总容易混，想问问大家有没有快速判断方法，或者好用的解题小经验可以分享？”。高质量回复应像下面这样，针对题目比较夹逼准则与洛必达法则的适用边界，说明夹逼适合非光滑、不可导或含振荡因子的结构，洛必达适合满足规定型未定式且导数能显著简化的情形；还应提醒数列离散性、连续化处理、复杂度增长和优先使用泰勒展开等方法，体现深入细致、分析透彻、表达规范和独到见解。请学习这种分析深度和针对性，但不要机械复制内容，必须结合当前帖子重新作答。',
          '请在内部静默完成一次质量自检和修改，不要生成多个候选回复，也不要进行第二次调用。自检时按以下标准衡量：是否直接回应帖子核心问题；概念和结论是否准确；是否说明方法的适用条件；是否补充至少一个边界、限制或容易误用的情况；是否提供具体判断顺序、操作方法或实用经验；是否补充了原帖没有明确表达的独到角度；是否表达自然、像真实学生参与讨论。发现缺项时，请在本次生成过程中直接重写，最终只输出一条纯文本回复，不要输出评分、检查清单、修改过程、候选版本或任何AI说明。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: '帖子题目：\n' + title + '\n\n帖子正文：\n' + content,
      },
    ];
  }

  function setDiscussionEditorContent(content, detailScope) {
    const editor = pageWindow.DIR_EDITORS && (pageWindow.DIR_EDITORS.noteEditorAll || pageWindow.DIR_EDITORS.noteEditor);
    if (editor && typeof editor.setContent === 'function') {
      const applyEditorContent = () => {
        try { editor.setContent(content); } catch (_) {}
      };
      try {
        if (editor.isReady === false && typeof editor.ready === 'function') editor.ready(applyEditorContent);
        else applyEditorContent();
      } catch (_) {
        applyEditorContent();
      }
    }
    if (detailScope && Object.prototype.hasOwnProperty.call(detailScope, 'noteContent')) {
      detailScope.noteContent = content;
    }
    document.querySelectorAll('textarea[ng-model="content"], textarea[ng-model="noteContent"]').forEach((textarea) => {
      const setter = Object.getOwnPropertyDescriptor(pageWindow.HTMLTextAreaElement.prototype, 'value');
      if (setter && setter.set) setter.set.call(textarea, content);
      else textarea.value = content;
      try {
        const editorScope = pageWindow.angular && pageWindow.angular.element(textarea).scope();
        if (editorScope && Object.prototype.hasOwnProperty.call(editorScope, 'content')) {
          editorScope.content = content;
          if (typeof editorScope.$evalAsync === 'function') editorScope.$evalAsync();
        }
        if (editorScope && Object.prototype.hasOwnProperty.call(editorScope, 'noteContent')) {
          editorScope.noteContent = content;
          if (typeof editorScope.$evalAsync === 'function') editorScope.$evalAsync();
        }
      } catch (_) {}
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  async function sendDiscussionReply(route, threadId, content, runId, assertRun) {
    const checkRun = assertRun || (() => assertDiscussionRun(runId));
    const detailScope = await waitForCondition(() => getDiscussionDetailScope(), {
      timeout: DISCUSSION_OPERATION_TIMEOUT,
      interval: 250,
      assertRun: checkRun,
    });
    if (!detailScope) throw new Error('帖子详情未加载完成，无法发送回复');
    setDiscussionEditorContent(content, detailScope);
    const courseService = getCourseService();
    if (!courseService || typeof courseService.discReply !== 'function') {
      throw new Error('当前页面未找到讨论回复接口');
    }
    const response = await invokeAngular(detailScope, () => courseService.discReply({
      cid: route.courseId,
      tid: String(threadId),
      content,
      images: null,
    }));
    await sleep(800);
    try {
      await invokeAngular(detailScope, () => {
        if (typeof detailScope.getList === 'function') return detailScope.getList();
        if (typeof detailScope.getDetail === 'function') return detailScope.getDetail();
        return null;
      });
    } catch (_) {}
    return response;
  }

  async function sendDiscussionReplyByApi(route, threadId, content, assertRun) {
    const detailScope = await waitForCondition(() => getDiscussionDetailScope(), {
      timeout: DISCUSSION_OPERATION_TIMEOUT,
      interval: 250,
      assertRun,
    });
    if (!detailScope) throw new Error('帖子详情未加载完成，无法发送回复');
    assertRun();
    setDiscussionEditorContent(content, detailScope);
    await sleep(200);
    assertRun();
    const courseService = getCourseService();
    if (!courseService || typeof courseService.discReply !== 'function') {
      throw new Error('当前页面未找到讨论回复接口');
    }
    const response = await invokeAngular(detailScope, () => courseService.discReply({
      cid: route.courseId,
      tid: String(threadId),
      content,
      images: null,
    }));
    assertRun();
    await sleep(800);
    const refreshed = await invokeAngular(detailScope, () => {
      if (typeof detailScope.getList === 'function') return detailScope.getList();
      if (typeof detailScope.getDetail === 'function') return detailScope.getDetail();
      return null;
    });
    await sleep(500);
    assertRun();
    return { response, refreshed };
  }

  function waitForDiscussionDelay(runId, discussionState = state.discussion, assertRun = () => assertDiscussionRun(runId)) {
    discussionState.phase = 'waiting';
    refreshControls();
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + DISCUSSION_WAIT_MS;
      const tick = () => {
        try {
          assertRun();
          const remaining = Math.max(0, deadline - Date.now());
          discussionState.remainingMs = remaining;
          refreshControls();
          if (!remaining) {
            clearInterval(discussionState.timer);
            discussionState.timer = null;
            resolve();
          }
        } catch (error) {
          clearInterval(discussionState.timer);
          discussionState.timer = null;
          reject(error);
        }
      };
      discussionState.timer = setInterval(tick, 1000);
      tick();
    });
  }

  function formatDiscussionRemaining(milliseconds) {
    const seconds = Math.ceil(Math.max(0, Number(milliseconds) || 0) / 1000);
    const minutes = Math.floor(seconds / 60);
    return minutes + '分' + String(seconds % 60).padStart(2, '0') + '秒';
  }

  function clearDiscussionExitTimer() {
    clearTimeout(state.discussionExitTimer);
    state.discussionExitTimer = null;
  }

  function scheduleDiscussionStopIfNeeded() {
    if (!state.discussion.running && !state.aiDiscussion.running) {
      clearDiscussionExitTimer();
      return;
    }
    clearDiscussionExitTimer();
    state.discussionExitTimer = setTimeout(() => {
      state.discussionExitTimer = null;
      if (getDiscussionRoute().kind) return;
      if (state.discussion.running) stopDiscussion('已离开综合讨论，自动讨论已停止');
      if (state.aiDiscussion.running) stopAIDiscussion('已离开综合讨论，AI讨论已停止');
    }, 2500);
  }

  function finishDiscussion(message) {
    clearDiscussionExitTimer();
    clearInterval(state.discussion.timer);
    state.discussion.timer = null;
    state.discussion.running = false;
    state.discussion.phase = 'idle';
    state.discussion.remainingMs = 0;
    refreshControls();
    if (message) notify(message, 3200);
  }

  function stopDiscussion(message = '自动讨论已停止') {
    state.discussion.runId += 1;
    finishDiscussion(message);
  }

  async function runDiscussionLoop(runId, route) {
    try {
      while (true) {
        assertDiscussionRun(runId);
        const listState = await waitForDiscussionList(runId, route.mode);
        if (!listState) throw new Error('综合讨论列表加载超时');
        const page = randomInteger(1, listState.pageCount);
        state.discussion.phase = 'page';
        state.discussion.lastPage = page;
        refreshControls();
        const pageScope = await switchDiscussionPage(listState.scope, route.mode, page, runId);
        const list = getDiscussionList(pageScope || getDiscussionListScope());
        if (!list.length) throw new Error('随机页没有可用帖子');
        const item = list[randomInteger(0, list.length - 1)];
        const threadId = discussionItemId(item);
        if (!threadId) throw new Error('随机帖子缺少帖子ID');
        state.discussion.lastThreadId = threadId;
        state.discussion.phase = 'detail';
        refreshControls();
        await navigateDiscussionDetail(route, threadId);
        const detailRoute = await waitForCondition(() => {
          const current = getDiscussionRoute();
          return current.kind === 'detail' && current.threadId === threadId;
        }, { timeout: DISCUSSION_OPERATION_TIMEOUT, interval: 250, runId });
        if (!detailRoute) throw new Error('帖子详情路由切换超时');
        const detailScope = await waitForCondition(() => getDiscussionDetailScope(), {
          timeout: DISCUSSION_OPERATION_TIMEOUT,
          interval: 250,
          runId,
        });
        if (!detailScope) throw new Error('帖子详情加载超时');
        const content = getDiscussionContent(detailScope);
        if (!content) throw new Error('帖子内容为空，无法发送回复');
        state.discussion.lastContent = content;
        await sendDiscussionReply(route, threadId, content, runId);
        assertDiscussionRun(runId);
        state.discussion.completed += 1;
        refreshControls();
        if (!state.config.discussionUnlimited && state.discussion.completed >= state.discussion.target) {
          finishDiscussion('自动讨论已完成' + state.discussion.completed + '次');
          return;
        }
        await waitForDiscussionDelay(runId);
        assertDiscussionRun(runId);
        state.discussion.phase = 'returning';
        refreshControls();
        await navigateDiscussionList(route);
        const listRoute = await waitForCondition(() => {
          const current = getDiscussionRoute();
          return current.kind === 'list' && current.mode === route.mode;
        }, { timeout: DISCUSSION_OPERATION_TIMEOUT, interval: 250, runId });
        if (!listRoute) throw new Error('返回综合讨论页超时');
      }
    } catch (error) {
      if (error && error.code === 'DISCUSSION_STOPPED') return;
      logError('自动讨论失败', { error, route: getDiscussionRoute(), discussion: state.discussion });
      finishDiscussion('自动讨论已停止：' + (error && error.message ? error.message : '页面结构不兼容'));
    }
  }

  function startDiscussion() {
    const route = getDiscussionRoute();
    if (route.kind !== 'list') {
      notify('请先进入课程的综合讨论页');
      return;
    }
    if (state.discussion.running || state.aiDiscussion.running) return;
    const count = Math.max(1, Math.floor(Number(state.config.discussionCount) || 1));
    state.config.discussionCount = count;
    saveConfig();
    state.discussion.running = true;
    state.discussion.phase = 'loading';
    state.discussion.completed = 0;
    state.discussion.target = count;
    state.discussion.lastPage = 0;
    state.discussion.lastThreadId = '';
    state.discussion.lastContent = '';
    state.discussion.remainingMs = 0;
    state.discussion.runId += 1;
    const runId = state.discussion.runId;
    refreshControls();
    notify(state.config.discussionUnlimited ? '自动讨论已启动，将持续执行' : '自动讨论已启动，共' + count + '次');
    runDiscussionLoop(runId, route);
  }

  function chooseAIDiscussionItem(list) {
    const available = list.filter((item) => {
      const threadId = discussionItemId(item);
      return threadId && !state.aiDiscussion.seenThreadIds.has(threadId);
    });
    if (!available.length) {
      state.aiDiscussion.seenThreadIds.clear();
      return list.find((item) => discussionItemId(item)) || null;
    }
    return available[randomInteger(0, available.length - 1)];
  }

  function hasDiscussionDetailEvidence() {
    const hash = String(location.hash || '').toLowerCase();
    if (hash.includes('discussdetail')) return true;
    return !!document.querySelector([
      '.discussionTitle',
      '.thesis-title',
      '[ng-bind-html*="threads.content"]',
      '.discussionDesc',
      '.thesis-content',
      '.CourseDiscussionHeader',
      '.discuzDetails',
    ].join(','));
  }

  async function waitForDiscussionRoute(kind, mode, threadId, assertRun) {
    const matched = await waitForCondition(() => {
      const current = getDiscussionRoute();
      if (kind === 'detail') {
        const routeMatches = current.kind === 'detail';
        const stateMatches = /detail/i.test(String(current.stateName || ''));
        const domMatches = hasDiscussionDetailEvidence();
        if (!routeMatches && !stateMatches && !domMatches) return null;
        if (threadId && current.threadId && current.threadId !== String(threadId)) {
          logWarning('讨论详情路由帖子ID解析不一致，继续使用已请求的帖子', {
            expectedThreadId: String(threadId),
            parsedThreadId: current.threadId,
            stateName: current.stateName,
            hash: location.hash,
          });
        }
        return Object.assign({}, current, { kind: 'detail', mode: current.mode || mode });
      }
      if (current.kind !== kind || current.mode !== mode) return null;
      return current;
    }, { timeout: DISCUSSION_OPERATION_TIMEOUT, interval: 250, assertRun });
    if (!matched) throw new Error(kind === 'detail' ? '帖子详情页面加载超时' : '返回综合讨论页超时');
    return matched;
  }

  async function prepareAIDiscussionTask(runId, route) {
    const assertRun = () => assertAIDiscussionRun(runId);
    assertRun();
    if (getDiscussionRoute().kind === 'detail') {
      state.aiDiscussion.phase = 'returning';
      refreshControls();
      await navigateDiscussionList(route);
      await waitForDiscussionRoute('list', route.mode, '', assertRun);
    }
    const listState = await waitForDiscussionList(runId, route.mode, assertRun);
    if (!listState) throw new Error('综合讨论列表加载超时');
    const page = randomInteger(1, listState.pageCount);
    state.aiDiscussion.phase = 'page';
    state.aiDiscussion.lastPage = page;
    refreshControls();
    const pageScope = await switchDiscussionPage(listState.scope, route.mode, page, runId, assertRun);
    const list = getDiscussionList(pageScope || getDiscussionListScope());
    const item = chooseAIDiscussionItem(list);
    if (!item) throw new Error('随机页没有可用帖子');
    const threadId = discussionItemId(item);
    state.aiDiscussion.seenThreadIds.add(threadId);
    state.aiDiscussion.lastThreadId = threadId;
    state.aiDiscussion.phase = 'detail';
    refreshControls();
    await navigateDiscussionDetail(route, threadId);
    await waitForDiscussionRoute('detail', route.mode, threadId, assertRun);
    const detailScope = await waitForCondition(() => getDiscussionDetailScope(), {
      timeout: DISCUSSION_OPERATION_TIMEOUT,
      interval: 250,
      assertRun,
    });
    if (!detailScope) throw new Error('帖子详情加载超时');
    const title = getDiscussionTitle(detailScope) || '课程讨论';
    const content = getDiscussionContent(detailScope);
    if (!content) throw new Error('帖子内容为空，无法生成AI回复');
    state.aiDiscussion.lastTitle = title;
    state.aiDiscussion.lastContent = content;
    state.aiDiscussion.phase = 'ai';
    refreshControls();
    const reply = normalizeDiscussionReply(await requestAICompletion(buildAIDiscussionMessages(title, content)));
    assertRun();
    if (!reply) throw new Error('AI未返回有效的纯文本讨论回复');
    state.aiDiscussion.lastReply = reply;
    return { threadId, title, content, reply };
  }

  function finishAIDiscussion(message) {
    clearDiscussionExitTimer();
    clearInterval(state.aiDiscussion.timer);
    state.aiDiscussion.timer = null;
    state.aiDiscussion.running = false;
    state.aiDiscussion.phase = 'idle';
    state.aiDiscussion.remainingMs = 0;
    refreshControls();
    if (message) notify(message, 3200);
  }

  function stopAIDiscussion(message = 'AI讨论已停止') {
    state.aiDiscussion.runId += 1;
    finishAIDiscussion(message);
  }

  async function runAIDiscussionLoop(runId, route) {
    const assertRun = () => assertAIDiscussionRun(runId);
    try {
      let pending = await prepareAIDiscussionTask(runId, route);
      while (true) {
        assertRun();
        state.aiDiscussion.phase = 'sending';
        refreshControls();
        await sendDiscussionReplyByApi(route, pending.threadId, pending.reply, assertRun);
        state.aiDiscussion.completed += 1;
        refreshControls();
        if (!state.config.discussionUnlimited && state.aiDiscussion.completed >= state.aiDiscussion.target) {
          finishAIDiscussion('AI讨论已完成' + state.aiDiscussion.completed + '次');
          return;
        }

        const delayPromise = waitForDiscussionDelay(runId, state.aiDiscussion, assertRun);
        const nextTaskPromise = prepareAIDiscussionTask(runId, route)
          .then((task) => ({ task }), (error) => ({ error }));
        await delayPromise;
        assertRun();
        const next = await nextTaskPromise;
        if (next.error) throw next.error;
        pending = next.task;
      }
    } catch (error) {
      if (error && error.code === 'DISCUSSION_STOPPED') return;
      logError('AI讨论失败', { error, route: getDiscussionRoute(), discussion: state.aiDiscussion });
      finishAIDiscussion('AI讨论已停止：' + (error && error.message ? error.message : '页面结构或AI接口不兼容'));
    }
  }

  function startAIDiscussion() {
    const route = getDiscussionRoute();
    if (route.kind !== 'list') {
      notify('请先进入课程的综合讨论页');
      return;
    }
    if (state.discussion.running || state.aiDiscussion.running) return;
    const count = Math.max(1, Math.floor(Number(state.config.discussionCount) || 1));
    state.config.discussionCount = count;
    saveConfig();
    state.aiDiscussion.running = true;
    state.aiDiscussion.phase = 'loading';
    state.aiDiscussion.completed = 0;
    state.aiDiscussion.target = count;
    state.aiDiscussion.lastPage = 0;
    state.aiDiscussion.lastThreadId = '';
    state.aiDiscussion.lastTitle = '';
    state.aiDiscussion.lastContent = '';
    state.aiDiscussion.lastReply = '';
    state.aiDiscussion.remainingMs = 0;
    state.aiDiscussion.seenThreadIds.clear();
    state.aiDiscussion.runId += 1;
    const runId = state.aiDiscussion.runId;
    refreshControls();
    notify(state.config.discussionUnlimited ? 'AI讨论已启动，将持续执行' : 'AI讨论已启动，共' + count + '次');
    runAIDiscussionLoop(runId, route);
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

  function textFromElement(element, images, imagePrefix = '图片') {
    if (!element) return '';
    const clone = element.cloneNode(true);
    const ownerDocument = element.ownerDocument || document;
    const originalImages = images ? Array.from(element.querySelectorAll('img')) : [];
    clone.querySelectorAll('script,style,input,button,textarea,select').forEach((node) => node.remove());
    clone.querySelectorAll('br').forEach((node) => node.replaceWith(ownerDocument.createTextNode('\n')));
    clone.querySelectorAll('img').forEach((image, index) => {
      if (images) {
        const original = originalImages[index];
        const source = original && (original.currentSrc || original.getAttribute('src') || original.getAttribute('data-src')) || '';
        const label = imagePrefix + (index + 1);
        let url = '';
        try { if (source) url = new URL(source, ownerDocument.baseURI).href; } catch (_) {}
        images.push({ label, url });
        image.replaceWith(ownerDocument.createTextNode('[' + label + ']'));
      } else {
        const label = image.getAttribute('alt') || image.getAttribute('title') || image.getAttribute('src') || '图片';
        image.replaceWith(ownerDocument.createTextNode('[图片: ' + label + ']'));
      }
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
        const optionLabel = (letterMatch ? letterMatch[0] : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[optionIndex] || String(optionIndex + 1)).toUpperCase();
        const images = [];
        return {
          label: optionLabel,
          text: textFromElement(label.querySelector('.ti-a-c') || label, images, '选项' + optionLabel + '图片'),
          images,
        };
      }).filter((option) => option.text);
      const rawType = typeNode ? textFromElement(typeNode).replace(/\s*\(共[\s\S]*$/, '').trim() : '';
      const quizType = normalizeQuizType(rawType, container, options);
      const images = [];
      return {
        number,
        type: quizType.label,
        isMultiple: quizType.multiple,
        question: textFromElement(container.querySelector('.ti-q-c'), images, '题目图片'),
        images,
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

  async function waitForAssessmentPageReady(doc, isCancelled) {
    let stableSignature = '';
    let stableCount = 0;
    let fontsReady = !doc.fonts || doc.fonts.status === 'loaded';
    if (!fontsReady && doc.fonts && doc.fonts.ready) {
      doc.fonts.ready.then(() => { fontsReady = true; }).catch(() => { fontsReady = true; });
    }
    return waitForCondition(() => {
      if (isCancelled && isCancelled()) return null;
      if (!doc || !doc.documentElement || doc.readyState !== 'complete' || !fontsReady) return null;
      const target = getQuizScreenshotTarget([doc]);
      if (!target) return null;
      const images = Array.from(target.querySelectorAll('img'));
      if (images.some((image) => !image.complete)) return null;
      const rect = target.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const signature = [images.length, target.querySelectorAll('.queContainer').length,
        Math.round(rect.width), Math.round(rect.height), target.scrollHeight].join(':');
      if (signature === stableSignature) stableCount += 1;
      else { stableSignature = signature; stableCount = 1; }
      return stableCount >= 3 ? target : null;
    }, { timeout: 120000, interval: 400, isCancelled });
  }

  function getQuizScreenshotTarget(documents = getQuizDocuments()) {
    const candidates = [];
    documents.forEach((doc) => {
      ['.testPaper', '.testPaperShow'].forEach((selector) => {
        Array.from(doc.querySelectorAll(selector)).forEach((node) => {
          const rect = node.getBoundingClientRect();
          if (!rect.width || !rect.height || !node.getClientRects().length) return;
          const questionCount = node.querySelectorAll('.queContainer').length;
          candidates.push({
            node,
            score: questionCount * 1000000 + Math.round(rect.width * rect.height),
          });
        });
      });
    });
    candidates.sort((left, right) => right.score - left.score);
    return candidates.length ? candidates[0].node : null;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('读取截图图片失败'));
      reader.readAsDataURL(blob);
    });
  }

  function requestScreenshotImage(url) {
    if (/^data:/i.test(url)) return Promise.resolve(url);
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'blob',
          timeout: 15000,
          onload(response) {
            if (response.status < 200 || response.status >= 400 || !response.response) {
              reject(new Error('图片请求失败：HTTP ' + response.status));
              return;
            }
            blobToDataUrl(response.response).then(resolve, reject);
          },
          ontimeout() { reject(new Error('图片请求超时')); },
          onerror() { reject(new Error('图片请求失败')); },
        });
      });
    }
    return fetch(url, { credentials: 'include' })
      .then((response) => {
        if (!response.ok) throw new Error('图片请求失败：HTTP ' + response.status);
        return response.blob();
      })
      .then(blobToDataUrl);
  }

  async function collectScreenshotImageData(target) {
    const urls = new Set();
    const ownerDocument = target.ownerDocument || document;
    target.querySelectorAll('img').forEach((image) => {
      const source = image.currentSrc || image.getAttribute('src') || image.getAttribute('data-src') || '';
      if (!source || /^blob:/i.test(source)) return;
      try {
        urls.add(new URL(source, ownerDocument.baseURI || location.href).href);
      } catch (_) {}
    });
    const pending = Array.from(urls);
    const entries = [];
    const worker = async () => {
      while (pending.length) {
        const url = pending.shift();
        try {
          entries.push([url, await requestScreenshotImage(url)]);
        } catch (error) {
          logWarning('长截图图片转码失败，将保留原图', { url: sanitizeUrlForLog(url), error });
          entries.push([url, '']);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(QUIZ_IMAGE_MAX_CONCURRENCY, pending.length) }, worker));
    return new Map(entries.filter((entry) => entry[1]));
  }

  function downloadBlobWithAnchor(filename, blob, url) {
    return new Promise((resolve) => {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.style.display = 'none';
      (document.body || document.documentElement).appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(resolve, 800);
    });
  }

  function downloadBlob(filename, blob) {
    if (!blob) return Promise.reject(new Error('截图数据为空'));
    const url = URL.createObjectURL(blob);
    const revoke = () => {
      try { URL.revokeObjectURL(url); } catch (_) {}
    };
    if (typeof GM_download === 'function') {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          revoke();
          error ? reject(error) : resolve();
        };
        const timeout = setTimeout(() => finish(new Error('下载接口超时')), 180000);
        try {
          GM_download({
            url,
            name: filename,
            saveAs: false,
            onload: () => finish(),
            onerror: (error) => {
              logWarning('GM_download失败，回退浏览器下载', { filename, error });
              downloadBlobWithAnchor(filename, blob, url).then(() => finish(), finish);
            },
            ontimeout: () => finish(new Error('下载接口超时')),
          });
        } catch (error) {
          logWarning('调用GM_download失败，回退浏览器下载', { filename, error });
          downloadBlobWithAnchor(filename, blob, url).then(() => finish(), finish);
        }
      });
    }
    return downloadBlobWithAnchor(filename, blob, url).finally(revoke);
  }

  async function renderQuizScreenshot(target, message = true, scale = state.config.screenshotScale) {
    const renderer = typeof html2canvas === 'function' ? html2canvas : pageWindow.html2canvas;
    if (typeof renderer !== 'function') throw new Error('长截图组件未加载，请刷新页面后重试');
    const marker = 'data-fastuooc-screenshot-target';
    let imageData = null;
    let canvas = null;
    target.setAttribute(marker, '');
    try {
      if (message) notify('正在准备长截图图片…', 5000);
      imageData = await collectScreenshotImageData(target);
      const ownerWindow = target.ownerDocument.defaultView || window;
      if (message) notify('正在生成长截图，请稍候…', 5000);
      canvas = await renderer(target, {
        backgroundColor: null,
        useCORS: true,
        allowTaint: false,
        imageTimeout: 15000,
        logging: false,
        scale,
        scrollX: ownerWindow.scrollX || 0,
        scrollY: ownerWindow.scrollY || 0,
        onclone(clonedDocument) {
          const style = clonedDocument.createElement('style');
          style.textContent = '*{animation:none!important;transition:none!important;caret-color:transparent!important}';
          (clonedDocument.head || clonedDocument.documentElement).appendChild(style);
          const clonedTarget = clonedDocument.querySelector('[' + marker + ']');
          if (!clonedTarget) return;
          clonedTarget.querySelectorAll('img').forEach((image) => {
            const source = image.currentSrc || image.getAttribute('src') || image.getAttribute('data-src') || '';
            let absoluteUrl = '';
            try {
              absoluteUrl = new URL(source, clonedDocument.baseURI || location.href).href;
            } catch (_) {}
            const dataUrl = imageData.get(absoluteUrl);
            if (dataUrl) {
              image.removeAttribute('srcset');
              image.removeAttribute('data-src');
              image.src = dataUrl;
            }
          });
        },
      });
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('浏览器无法生成PNG图片')), 'image/png');
      });
      const titleNode = target.ownerDocument.querySelector('.testPaper-Top');
      const title = textFromElement(titleNode) || 'UOOC试卷';
      return { blob, title };
    } finally {
      target.removeAttribute(marker);
      if (imageData) imageData.clear();
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  }

  async function captureQuizScreenshot() {
    if (state.screenshotRunning) return false;
    const target = getQuizScreenshotTarget();
    if (!target) {
      notify('当前页面未找到可截图的试卷内容');
      return false;
    }
    state.screenshotRunning = true;
    refreshControls();
    try {
      const result = await renderQuizScreenshot(target);
      const safeTitle = result.title.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').slice(0, 80) || 'uooc-paper';
      const stamp = new Date().toISOString().slice(0, 10);
      await downloadBlob(safeTitle + '-长截图-' + stamp + '.png', result.blob);
      result.blob = null;
      notify('长截图已下载');
      return true;
    } catch (error) {
      logError('长截图失败', error);
      notify('长截图失败：' + (error && error.message ? error.message : '页面过长或图片无法读取'));
      return false;
    } finally {
      state.screenshotRunning = false;
      refreshControls();
    }
  }

  function isNewAssessmentPage() {
    const isNewCourse = /^\/home\/course\/new\/\d+(?:\/|$)/i.test(location.pathname);
    const section = location.hash.replace(/^#\/?/, '').split('/')[0].split(/[?#;]/)[0].toLowerCase();
    return isNewCourse && section === 'assessment';
  }

  function getAssessmentBatchItems() {
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href]')).map((link) => {
      let url;
      try { url = new URL(link.href, location.href); } catch (_) { return null; }
      if (!/^\/exam\/paper\/?$/i.test(url.pathname) || !url.searchParams.get('tid')) return null;
      const key = url.origin + url.pathname + '?cid=' + (url.searchParams.get('cid') || '') + '&tid=' + url.searchParams.get('tid');
      if (seen.has(key)) return null;
      seen.add(key);
      const row = link.closest('tr');
      const title = row && textFromElement(row.querySelector('td')) || textFromElement(link) || 'UOOC考核项目';
      return { key, url: url.href, title: title.replace(/\s+/g, ' ').trim(), selected: true, done: false, failed: '' };
    }).filter(Boolean);
  }

  // 按课程保存批量截图的勾选状态和已截图记录，便于下次继续
  function getAssessmentSelectionStorageKey() {
    const match = location.pathname.match(/^\/home\/course\/new\/(\d+)/i);
    return ASSESSMENT_SELECTION_KEY_PREFIX + (match ? match[1] : 'default');
  }

  function loadAssessmentSelection() {
    try {
      const stored = JSON.parse(localStorage.getItem(getAssessmentSelectionStorageKey()) || '{}');
      return {
        selected: stored.selected && typeof stored.selected === 'object' ? stored.selected : {},
        done: stored.done && typeof stored.done === 'object' ? stored.done : {},
      };
    } catch (_) {
      return { selected: {}, done: {} };
    }
  }

  function saveAssessmentSelection() {
    const stored = loadAssessmentSelection();
    state.assessmentBatch.items.forEach((item) => {
      stored.selected[item.key] = Boolean(item.selected);
      if (item.done) stored.done[item.key] = true;
      else delete stored.done[item.key];
    });
    try {
      localStorage.setItem(getAssessmentSelectionStorageKey(), JSON.stringify(stored));
    } catch (error) {
      logWarning('保存批量截图勾选状态失败', error);
    }
  }

  function applyAssessmentSelection(items) {
    const stored = loadAssessmentSelection();
    items.forEach((item) => {
      item.done = Boolean(stored.done[item.key]);
      // 新发现的项目默认勾选，已截图的默认不勾选
      item.selected = Object.prototype.hasOwnProperty.call(stored.selected, item.key)
        ? Boolean(stored.selected[item.key])
        : !item.done;
    });
    return items;
  }

  function setAssessmentSelection(mode) {
    const batch = state.assessmentBatch;
    if (batch.active || !batch.items.length) return;
    batch.items.forEach((item) => {
      item.selected = mode === 'all' ? true : mode === 'pending' ? !item.done : false;
    });
    saveAssessmentSelection();
    refreshControls();
  }

  function getAssessmentBatchSummary() {
    const batch = state.assessmentBatch;
    const total = batch.queue.length;
    if (batch.active && batch.phase === 'discovering') return '正在识别可截图项目…';
    if (batch.active) return '正在截图 ' + Math.min(batch.index + 1, total) + '/' + total;
    if (batch.phase === 'stopped') return '已停止：成功 ' + batch.completed + ' 个，失败 ' + batch.failures.length + ' 个';
    if (batch.phase === 'error') return '批量截图异常，请重试';
    if (batch.phase === 'empty') return '未找到可用项目，可重试';
    if (batch.phase === 'complete') return '已完成 ' + batch.completed + '/' + total + '，失败 ' + batch.failures.length + ' 个';
    if (batch.items.length) {
      const selected = batch.items.filter((item) => item.selected).length;
      const done = batch.items.filter((item) => item.done).length;
      return '共 ' + batch.items.length + ' 个，已截图 ' + done + ' 个，已选 ' + selected + ' 个';
    }
    return '先识别项目，勾选后开始截图';
  }

  // 仅在项目集合变化时重建列表，其余时候就地同步勾选和状态，避免刷新打断操作
  function renderAssessmentBatchList(container) {
    const batch = state.assessmentBatch;
    const signature = batch.items.map((item) => item.key).join('|');
    if (container.dataset.signature !== signature) {
      container.dataset.signature = signature;
      container.textContent = '';
      batch.items.forEach((item) => {
        const row = document.createElement('label');
        row.className = 'fastuooc-auto-assessment-item';
        row.title = item.title;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.role = 'assessment-item';
        checkbox.dataset.key = item.key;
        const title = document.createElement('span');
        title.className = 'fastuooc-auto-assessment-item-title';
        title.textContent = item.title;
        const tag = document.createElement('em');
        tag.className = 'fastuooc-auto-assessment-item-tag';
        row.append(checkbox, title, tag);
        container.appendChild(row);
      });
    }
    container.hidden = !batch.items.length;
    const byKey = new Map(batch.items.map((item) => [item.key, item]));
    const current = batch.active && batch.phase === 'capturing' ? batch.queue[batch.index] : null;
    container.querySelectorAll('.fastuooc-auto-assessment-item').forEach((row) => {
      const checkbox = row.querySelector('input');
      const item = byKey.get(checkbox.dataset.key);
      if (!item) return;
      checkbox.checked = Boolean(item.selected);
      checkbox.disabled = batch.active;
      const tag = row.querySelector('.fastuooc-auto-assessment-item-tag');
      const label = item === current ? '截图中' : item.failed ? '失败' : item.done ? '已截图' : '';
      tag.textContent = label;
      tag.title = item.failed || '';
      row.classList.toggle('is-done', item.done && !item.failed);
      row.classList.toggle('is-failed', Boolean(item.failed));
      row.classList.toggle('is-current', item === current);
    });
  }

  function removeAssessmentBatchFrame() {
    const frame = state.assessmentBatch.frame;
    if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
    state.assessmentBatch.frame = null;
  }

  function closeAssessmentBatchTab() {
    const batch = state.assessmentBatch;
    const tab = batch.tab;
    batch.tab = null;
    batch.token = '';
    batch.expectedUrl = '';
    batch.requestId = '';
    batch.result = null;
    if (tab) {
      try { if (!tab.closed) tab.close(); } catch (_) {}
    }
  }

  function isAssessmentPaperUrl(actual, expected) {
    try {
      const left = new URL(actual);
      const right = new URL(expected);
      return left.origin === right.origin && /^\/exam\/paper\/?$/i.test(left.pathname) &&
        left.searchParams.get('cid') === right.searchParams.get('cid') &&
        left.searchParams.get('tid') === right.searchParams.get('tid');
    } catch (_) {
      return false;
    }
  }

  function installAssessmentCaptureWorker() {
    if (!/^\/exam\/paper\/?$/i.test(location.pathname) || !window.opener || !window.name.startsWith('fastuooc-batch-')) return;
    const token = window.name.slice('fastuooc-batch-'.length);
    let generation = 0;
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (event.source !== window.opener || !data || data.token !== token) return;
      if (data.type === 'fastuooc-batch-cancel') {
        generation += 1;
        return;
      }
      if (data.type !== 'fastuooc-batch-capture' || !isAssessmentPaperUrl(location.href, data.url)) return;
      const current = ++generation;
      const cancelled = () => current !== generation;
      const reply = (success, error = '') => {
        try {
          window.opener.postMessage({ type: 'fastuooc-batch-result', token, requestId: data.requestId, url: location.href, success, error }, '*');
        } catch (_) {}
      };
      (async () => {
        let result = null;
        try {
          const target = await waitForAssessmentPageReady(document, cancelled);
          if (cancelled()) return;
          if (!target) throw new Error('未找到试卷内容');
          await sleep(1200);
          if (cancelled()) return;
          const scale = Math.min(SCREENSHOT_SCALE_MAX, Math.max(SCREENSHOT_SCALE_MIN, Number(data.scale) || SCREENSHOT_SCALE_DEFAULT));
          result = await renderQuizScreenshot(target, false, scale);
          if (cancelled()) return;
          const safeTitle = (data.title || result.title || 'uooc-assessment')
            .replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').slice(0, 80) || 'uooc-assessment';
          await downloadBlob(safeTitle + '-长截图-' + new Date().toISOString().slice(0, 10) + '.png', result.blob);
          result.blob = null;
          reply(true);
        } catch (error) {
          if (!cancelled()) reply(false, error && error.message ? error.message : String(error));
        } finally {
          if (result) result.blob = null;
        }
      })();
    });
    try { window.opener.postMessage({ type: 'fastuooc-batch-ready', token, url: location.href }, '*'); } catch (_) {}
  }

  function installAssessmentBatchMessages() {
    window.addEventListener('message', (event) => {
      const batch = state.assessmentBatch;
      const data = event.data;
      if (!batch.active || !batch.tab || event.source !== batch.tab || !data || data.token !== batch.token || !batch.expectedUrl) return;
      if (event.origin !== new URL(batch.expectedUrl).origin || !isAssessmentPaperUrl(data.url, batch.expectedUrl)) return;
      if (data.type === 'fastuooc-batch-ready' && !batch.requested) {
        batch.requested = true;
        try {
          batch.tab.postMessage({ type: 'fastuooc-batch-capture', token: batch.token,
            requestId: batch.requestId, url: batch.expectedUrl, title: batch.queue[batch.index].title,
            scale: state.config.screenshotScale }, event.origin);
        } catch (error) {
          batch.result = { success: false, error: '无法联系截图页面：' + error.message };
        }
      } else if (data.type === 'fastuooc-batch-result' && data.requestId === batch.requestId) {
        batch.result = { success: Boolean(data.success), error: data.error || '' };
      }
    });
  }

  function stopAssessmentBatch() {
    const batch = state.assessmentBatch;
    if (!batch.active) return;
    batch.runId += 1;
    batch.active = false;
    batch.phase = 'stopped';
    removeAssessmentBatchFrame();
    if (batch.tab) {
      try { batch.tab.postMessage({ type: 'fastuooc-batch-cancel', token: batch.token }, '*'); } catch (_) {}
      closeAssessmentBatchTab();
    }
    refreshControls();
  }

  function isAssessmentBatchCurrent(route, runId) {
    const batch = state.assessmentBatch;
    return batch.active && batch.runId === runId && location.href === route && isNewAssessmentPage();
  }

  function openAssessmentBatchTab() {
    const batch = state.assessmentBatch;
    if (batch.tab && !batch.tab.closed) return true;
    const token = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    const tab = window.open('about:blank', 'fastuooc-batch-' + token, 'popup,width=1280,height=900');
    if (!tab) throw new Error('浏览器阻止了新标签页，请允许当前网站打开弹出窗口后重试');
    batch.tab = tab;
    batch.token = token;
    batch.expectedUrl = '';
    batch.requestId = '';
    batch.requested = false;
    batch.result = null;
    try { tab.focus(); } catch (_) {}
    return true;
  }

  async function captureVisibleAssessmentItem(item, route, runId, index) {
    const batch = state.assessmentBatch;
    const tab = batch.tab;
    if (!tab || tab.closed) throw new Error('截图标签页已关闭');
    batch.expectedUrl = item.url;
    batch.requestId = runId + ':' + index;
    batch.requested = false;
    batch.result = null;
    tab.location.replace(item.url);
    const outcome = await waitForCondition(() => batch.result, {
      timeout: 120000, interval: 250,
      isCancelled: () => !isAssessmentBatchCurrent(route, runId) || tab.closed,
    });
    if (!isAssessmentBatchCurrent(route, runId)) return false;
    if (tab.closed) throw new Error('截图标签页已关闭');
    if (!outcome) throw new Error('截图页面未响应，请确认新标签页已加载本脚本');
    if (!outcome.success) throw new Error(outcome.error || '截图页面导出失败');
    batch.result = null;
    return true;
  }

  // 截图成功后记录为已截图并取消勾选，下次开始时自动跳过
  function markAssessmentItemDone(item) {
    state.assessmentBatch.completed += 1;
    item.done = true;
    item.failed = '';
    item.selected = false;
    saveAssessmentSelection();
  }

  async function runAssessmentBatchScreenshot(items, route, runId) {
    const batch = state.assessmentBatch;
    for (let index = 0; index < items.length; index += 1) {
      if (!isAssessmentBatchCurrent(route, runId)) return;
      batch.index = index;
      refreshControls();
      const item = items[index];
      let frame = null;
      let result = null;
      try {
        notify('正在截图 ' + (index + 1) + '/' + items.length + '：' + item.title, 5000);
        if (state.config.assessmentBatchMode === 'visible') {
          if (await captureVisibleAssessmentItem(item, route, runId, index)) markAssessmentItemDone(item);
          continue;
        }
        frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;left:-100000px;top:0;width:1280px;height:900px;border:0;opacity:1;pointer-events:none;z-index:-1;';
        batch.frame = frame;
        (document.body || document.documentElement).appendChild(frame);
        frame.src = item.url;
        const frameDocument = await waitForCondition(() => {
          try {
            return frame.contentDocument && frame.contentDocument.querySelector('html') ? frame.contentDocument : null;
          } catch (_) {
            return null;
          }
        }, { timeout: 30000, interval: 300, isCancelled: () => !isAssessmentBatchCurrent(route, runId) });
        if (!isAssessmentBatchCurrent(route, runId)) return;
        if (!frameDocument) throw new Error('考核项目页面加载超时');
        const target = await waitForAssessmentPageReady(frameDocument, () => !isAssessmentBatchCurrent(route, runId));
        if (!isAssessmentBatchCurrent(route, runId)) return;
        if (!target) throw new Error('未找到试卷内容');
        await sleep(1200);
        if (!isAssessmentBatchCurrent(route, runId)) return;
        result = await renderQuizScreenshot(target, false);
        if (!isAssessmentBatchCurrent(route, runId)) return;
        const safeTitle = (item.title || result.title || 'uooc-assessment')
          .replace(/[\\/:*?"<>|]/g, '-')
          .replace(/\s+/g, '-')
          .slice(0, 80) || 'uooc-assessment';
        const stamp = new Date().toISOString().slice(0, 10);
        await downloadBlob(safeTitle + '-长截图-' + stamp + '.png', result.blob);
        result.blob = null;
        markAssessmentItemDone(item);
      } catch (error) {
        if (!isAssessmentBatchCurrent(route, runId)) return;
        const message = error && error.message ? error.message : String(error);
        item.failed = message;
        batch.failures.push({ item, error: message });
        logWarning('批量长截图项目失败', { item, error });
        if (batch.tab && batch.tab.closed) {
          stopAssessmentBatch();
          notify('截图标签页已关闭，批量截图已停止');
          return;
        }
      } finally {
        if (result) result.blob = null;
        if (frame) {
          try { frame.src = 'about:blank'; } catch (_) {}
          if (frame.parentNode) frame.parentNode.removeChild(frame);
        }
        if (batch.frame === frame) batch.frame = null;
        refreshControls();
      }
      await sleep(300);
    }
    if (isAssessmentBatchCurrent(route, runId)) {
      closeAssessmentBatchTab();
      batch.active = false;
      batch.phase = 'complete';
      notify('新版考核批量截图完成：成功' + batch.completed + '个，失败' + batch.failures.length + '个', 5000);
      refreshControls();
    }
  }

  // 识别当前考核页的可截图项目，并恢复上次保存的勾选状态
  function discoverAssessmentBatchItems(route, runId) {
    return waitForCondition(() => {
      const found = getAssessmentBatchItems();
      return found.length ? found : null;
    }, { timeout: 20000, interval: 500, isCancelled: () => !isAssessmentBatchCurrent(route, runId) })
      .then((items) => (items ? applyAssessmentSelection(items) : []));
  }

  function beginAssessmentBatchRun() {
    const batch = state.assessmentBatch;
    closeAssessmentBatchTab();
    batch.route = location.href;
    batch.active = true;
    batch.runId += 1;
    batch.queue = [];
    batch.index = 0;
    batch.completed = 0;
    batch.failures = [];
    return { route: batch.route, runId: batch.runId };
  }

  function scanAssessmentBatchItems() {
    if (!isNewAssessmentPage()) return;
    const batch = state.assessmentBatch;
    if (batch.active) return;
    const { route, runId } = beginAssessmentBatchRun();
    batch.phase = 'discovering';
    notify('正在识别新版考核页面的可截图项目…', 5000);
    refreshControls();
    discoverAssessmentBatchItems(route, runId).then((items) => {
      if (!isAssessmentBatchCurrent(route, runId)) return;
      batch.active = false;
      batch.items = items;
      batch.phase = items.length ? 'ready' : 'empty';
      notify(items.length ? '已识别' + items.length + '个项目，请勾选需要截图的项目' : '新版考核页面未找到可用项目');
      refreshControls();
    }).catch((error) => {
      if (batch.runId !== runId) return;
      batch.active = false;
      batch.phase = 'error';
      logError('识别考核项目失败', error);
      notify('识别考核项目失败');
      refreshControls();
    });
  }

  function startAssessmentBatchScreenshot() {
    if (!isNewAssessmentPage()) return;
    const batch = state.assessmentBatch;
    if (batch.active) return;
    const hasList = batch.items.length > 0;
    if (hasList && !batch.items.some((item) => item.selected)) {
      notify('请先勾选需要截图的项目');
      return;
    }
    const { route, runId } = beginAssessmentBatchRun();
    batch.phase = hasList ? 'capturing' : 'discovering';
    try {
      // 显示式需在点击的同步阶段打开弹窗，避免被浏览器拦截
      if (state.config.assessmentBatchMode === 'visible') openAssessmentBatchTab();
    } catch (error) {
      batch.active = false;
      batch.phase = 'error';
      notify(error && error.message ? error.message : '无法打开显示式截图页面');
      refreshControls();
      return;
    }
    if (!hasList) notify('正在识别新版考核页面的可截图项目…', 5000);
    refreshControls();
    (hasList ? Promise.resolve(batch.items) : discoverAssessmentBatchItems(route, runId)).then((items) => {
      if (!isAssessmentBatchCurrent(route, runId)) return;
      batch.items = items;
      batch.items.forEach((item) => { if (item.selected) item.failed = ''; });
      batch.queue = batch.items.filter((item) => item.selected);
      if (!batch.queue.length) {
        closeAssessmentBatchTab();
        batch.active = false;
        batch.phase = batch.items.length ? 'ready' : 'empty';
        notify(batch.items.length ? '所有项目均已截图，可在列表中重新勾选' : '新版考核页面未找到可用项目');
        refreshControls();
        return;
      }
      batch.phase = 'capturing';
      notify('已选择' + batch.queue.length + '个考核项目，开始批量截图', 5000);
      refreshControls();
      return runAssessmentBatchScreenshot(batch.queue, route, runId);
    }).catch((error) => {
      if (batch.runId !== runId || location.href !== route || !isNewAssessmentPage()) return;
      closeAssessmentBatchTab();
      batch.active = false;
      batch.phase = 'error';
      logError('新版考核批量截图异常', error);
      notify('新版考核批量截图异常');
      refreshControls();
    });
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

  function enqueueAI(task, onStart, vision = false) {
    return new Promise((resolve, reject) => {
      state.aiQueue.pending.push({ task, onStart, vision, resolve, reject });
      pumpAIQueue();
    });
  }

  function pumpAIQueue() {
    while (state.aiQueue.active < AI_MAX_CONCURRENCY && state.aiQueue.pending.length) {
      const index = state.aiQueue.pending.findIndex((item) => !item.vision || state.aiQueue.visionActive < AI_VISION_MAX_CONCURRENCY);
      if (index < 0) break;
      const [item] = state.aiQueue.pending.splice(index, 1);
      state.aiQueue.active += 1;
      if (item.vision) state.aiQueue.visionActive += 1;
      Promise.resolve()
        .then(() => {
          if (typeof item.onStart === 'function') item.onStart();
          return item.task();
        })
        .then(item.resolve, item.reject)
        .finally(() => {
          state.aiQueue.active -= 1;
          if (item.vision) state.aiQueue.visionActive -= 1;
          pumpAIQueue();
        });
    }
  }

  function requestAICompletion(messages, onStart) {
    const endpoint = getAIEndpoint();
    const hasImages = messages.some((message) => Array.isArray(message.content));
    if (!endpoint) return Promise.reject(new Error('未配置AI接口地址'));
    if (!state.config.aiApiKey) return Promise.reject(new Error('未配置AI API Key'));
    if (!state.config.aiModel) return Promise.reject(new Error('未配置AI模型名称'));
    const body = JSON.stringify({
      model: state.config.aiModel,
      messages,
      temperature: 0.2,
      max_tokens: 500,
    });
    return enqueueAI(() => new Promise((resolve, reject) => {
      const configuredTimeout = Math.max(5000, Number(state.config.aiTimeout) || 45000);
      const timeout = hasImages ? Math.max(120000, configuredTimeout) : configuredTimeout;
      const timeoutError = () => new Error(hasImages ? '图片已读取，视觉AI请求超时（请检查接口或模型的图片输入支持）' : 'AI请求超时');
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => finish(reject, timeoutError()), timeout);
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
            finish(reject, new Error('AI接口返回HTTP ' + response.status + (hasImages ? '（请确认接口和模型支持图片输入）' : '')));
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
        ontimeout: () => finish(reject, timeoutError()),
      });
    }), onStart, hasImages);
  }

  function enqueueQuizImage(task) {
    return new Promise((resolve, reject) => {
      state.quizImageQueue.pending.push({ task, resolve, reject });
      pumpQuizImageQueue();
    });
  }

  function pumpQuizImageQueue() {
    while (state.quizImageQueue.active < QUIZ_IMAGE_MAX_CONCURRENCY && state.quizImageQueue.pending.length) {
      const item = state.quizImageQueue.pending.shift();
      state.quizImageQueue.active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          state.quizImageQueue.active -= 1;
          pumpQuizImageQueue();
        });
    }
  }

  function requestQuizImageBlob(url) {
    if (typeof GM_xmlhttpRequest !== 'function') {
      return Promise.reject(new Error('脚本管理器不支持读取跨域题目图片'));
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        timeout: Math.max(5000, Number(state.config.aiTimeout) || 45000),
        onload: (response) => {
          if (response.status < 200 || response.status >= 300 || !response.response) {
            reject(new Error('题目图片下载失败（HTTP ' + response.status + '）'));
            return;
          }
          resolve(response.response);
        },
        onerror: () => reject(new Error('题目图片下载失败')),
        ontimeout: () => reject(new Error('题目图片下载超时')),
      });
    });
  }

  async function getQuizImageMime(blob) {
    const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)).match(/^GIF8[79]a$/)) return 'image/gif';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
        String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
    throw new Error('题目图片格式不支持或返回的不是图片');
  }

  async function quizGifFirstFrame(blob) {
    if (typeof createImageBitmap !== 'function') throw new Error('当前浏览器不支持读取GIF首帧');
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob.type === 'image/gif' ? blob : new Blob([blob], { type: 'image/gif' }));
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 16 * 1024 * 1024) {
        throw new Error('题目GIF图片尺寸不支持');
      }
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return await new Promise((resolve, reject) => {
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error('题目GIF首帧转换失败')), 'image/png');
      });
    } finally {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    }
  }

  async function quizImageDataUrl(url) {
    if (!url) throw new Error('题目图片缺少地址');
    const source = new URL(url, location.href);
    if (!['http:', 'https:', 'data:', 'blob:'].includes(source.protocol)) {
      throw new Error('题目图片地址格式不支持');
    }
    let blob;
    if (source.protocol === 'data:' || source.protocol === 'blob:' || source.origin === location.origin) {
      try {
        const response = await fetch(source.href, { credentials: 'include' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        blob = await response.blob();
      } catch (error) {
        if (source.protocol !== 'http:' && source.protocol !== 'https:') throw new Error('题目图片读取失败');
        blob = await requestQuizImageBlob(source.href);
      }
    } else {
      blob = await requestQuizImageBlob(source.href);
    }
    if (!blob || typeof blob.size !== 'number' || !blob.size || blob.size > 5 * 1024 * 1024) {
      throw new Error('题目图片为空或超过5MB');
    }
    const mime = await getQuizImageMime(blob);
    const image = mime === 'image/gif' ? await quizGifFirstFrame(blob) :
      blob.type === mime ? blob : new Blob([blob], { type: mime });
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('题目图片编码失败'));
      reader.readAsDataURL(image);
    });
  }

  async function buildAIQuestionMessages(item) {
    const images = [...(item.images || []), ...item.options.flatMap((option) => option.images || [])];
    const prompt = buildAIQuestionPrompt(item);
    if (!images.length) return [{ role: 'user', content: prompt }];
    if (images.length > 16) throw new Error('单题图片超过16张，未发送不完整题目');
    renderAIStatus(item.element, 'AI参考：正在读取图片…', 'is-loading');
    const cache = new Map();
    const urls = await Promise.all(images.map((image) => {
      if (!cache.has(image.url)) cache.set(image.url, enqueueQuizImage(() => quizImageDataUrl(image.url)));
      return cache.get(image.url);
    }));
    const parts = [{ type: 'text', text: prompt }];
    images.forEach((image, index) => {
      parts.push({ type: 'text', text: image.label });
      parts.push({ type: 'image_url', image_url: { url: urls[index] } });
    });
    return [{ role: 'user', content: parts }];
  }

  function buildAIQuestionPrompt(item) {
    const options = item.options.map((option) => option.label + '. ' + option.text).join('\n');
    const typeLabel = item.isMultiple ? '多选题' : '单选题';
    return [
      '你是严谨的选择题分析助手。请独立判断下面题目的最可能正确答案。',
      '先判断知识类型：数学、物理、化学、生物等需要推导或计算的题目，请直接进行严谨分析；历史、地理、政治、经济、法律、学校信息、机构信息、时事和其他事实性题目，如果当前模型或接口实际提供联网搜索/浏览工具，必须先调用该工具核验关键事实。',
      '只有在确实调用了可用的联网搜索工具后，才可以声称完成了搜索；如果接口没有搜索工具，不要伪装已经搜索过，并根据已有知识谨慎判断。无法可靠判断时只输出“无法确定”，脚本会将其视为无效回答。',
      '题目或选项中的[题目图片1]、[选项A图片1]等标记对应消息后附带的同名图片。请读取图片中的文字、公式和图形，不要依据文件名猜测；若模型无法识别图片，只输出“无法确定”。',
      '题型：' + typeLabel,
      item.isMultiple
        ? '输出规则：这是多选题，实际选项数量不固定，可能超过4个；必须根据题目给出的全部选项判断，不要假定最多只有4个选项。只输出所有最可能正确的选项标签，按题目顺序用英文逗号分隔，例如A,C或A,C,E。不要输出解释、标点前缀、Markdown或其他文字。'
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
    const messages = await buildAIQuestionMessages(item);
    let started = false;
    const markStarted = () => {
      if (started) return;
      started = true;
      renderAIAnalyzing(item.element);
    };
    const firstRound = await Promise.all([1, 2, 3].map(() => requestAICompletion(messages, markStarted).catch((error) => ({ error }))));
    if (firstRound.every((result) => result && result.error)) throw firstRound[0].error;
    let answers = firstRound.map((result) => result && result.error ? [] : normalizeAIOptions(result, item));
    const firstVote = countAIVotes(answers, item);
    if (!firstVote.tied && firstVote.options.length && firstVote.votes === 3) return firstVote;
    const extraRound = await Promise.all([1, 2].map(() => requestAICompletion(messages, markStarted).catch((error) => ({ error }))));
    if (firstRound.concat(extraRound).every((result) => result && result.error)) throw firstRound[0].error;
    answers = answers.concat(extraRound.map((result) => result && result.error ? [] : normalizeAIOptions(result, item)));
    return countAIVotes(answers, item);
  }

  function ensureAIStyles(doc) {
    if (!doc || doc.getElementById('fastuooc-ai-reference-style')) return;
    const style = doc.createElement('style');
    style.id = 'fastuooc-ai-reference-style';
    style.textContent = '.fastuooc-ai-reference{display:inline-flex;align-items:center;flex-wrap:wrap;gap:5px;max-width:calc(100% - 8px);box-sizing:border-box;margin:0 0 8px 8px;padding:3px 8px;border:1px solid rgba(37,99,235,.25);border-radius:999px;background:rgba(37,99,235,.08);color:#2563eb;font:600 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:normal;overflow-wrap:anywhere;word-break:break-word;vertical-align:middle}.fastuooc-ai-reference.is-uncertain{border-color:rgba(100,116,139,.25);background:rgba(100,116,139,.08);color:#64748b}.fastuooc-ai-reference.is-waiting{border-color:rgba(148,163,184,.24);background:rgba(148,163,184,.08);color:#94a3b8}.fastuooc-ai-reference.is-loading{color:#2563eb;animation:fastuooc-ai-pulse 1.1s ease-in-out infinite}@keyframes fastuooc-ai-pulse{50%{opacity:.45}}';
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
        renderAIReference(item.element, { options: [], votes: 0, total: 0, tied: false, message: 'AI参考：' + (error && error.message || '分析失败') });
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
    const speed = DEFAULT_CONFIG.speed;
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
    if (enforceMasterConfig()) saveConfig();
    const controlPage = getControlPage();
    if (controlPage.playback) patchBackgroundPausePolicy();
    const controlPageKey = [controlPage.playback, controlPage.quiz, controlPage.discussion, isNewAssessmentPage()].join(':');
    if (state.controlPageKey !== controlPageKey) {
      state.controlPageKey = controlPageKey;
      refreshControls();
    }
    const video = controlPage.playback && findNativeVideo();
    if (video) bindVideo(video);
  }

  function hasVisibleQuizQuestions(doc) {
    return Array.from(doc.querySelectorAll('.queContainer .ti-q-c'))
      .some((node) => node.getClientRects().length > 0);
  }

  function hasLearnQuiz() {
    if (hasVisibleQuizQuestions(document)) return true;
    return Array.from(document.querySelectorAll('iframe')).some((frame) => {
      if (!frame.getClientRects().length) return false;
      try {
        if (frame.contentDocument && hasVisibleQuizQuestions(frame.contentDocument)) return true;
      } catch (_) {}
      try {
        return /^\/exam(?:\/|$)/i.test(new URL(frame.src, location.href).pathname);
      } catch (_) {
        return false;
      }
    });
  }

  function getControlPage() {
    const isCoursePage = /^\/home\/course\/(?:new\/)?\d+(?:\/|$)/i.test(location.pathname);
    const isLearnPage = /^\/home\/learn(?:\/|$)/i.test(location.pathname);
    const section = location.hash.replace(/^#\/?/, '').split('/')[0].split(/[?#;]/)[0].toLowerCase();
    const learnQuiz = isLearnPage && (['test', 'exam'].includes(section) || hasLearnQuiz());
    return {
      playback: isLearnPage && !learnQuiz,
      quiz: /^\/exam(?:\/|$)/i.test(location.pathname) ||
        learnQuiz || (isCoursePage && (section === 'test' || section === 'exam')),
      discussion: isCoursePage && ['discuss', 'discusscom', 'discussdetail'].includes(section),
    };
  }

  function openSponsorDialog() {
    const existing = document.getElementById('fastuooc-sponsor-dialog');
    if (existing) {
      existing.hidden = false;
      return;
    }
    const modal = document.createElement('div');
    modal.id = 'fastuooc-sponsor-dialog';
    modal.innerHTML = [
      '<div class="fastuooc-sponsor-backdrop" data-sponsor-action="close"></div>',
      '<section class="fastuooc-sponsor-dialog" role="dialog" aria-modal="true" aria-labelledby="fastuooc-sponsor-title">',
      '<div class="fastuooc-sponsor-head"><strong id="fastuooc-sponsor-title">请作者喝杯咖啡</strong><button type="button" data-sponsor-action="close" aria-label="关闭赞助弹窗">×</button></div>',
      '<p class="fastuooc-sponsor-help">如果这个脚本对你有帮助，欢迎支持一下作者。</p>',
      '<div class="fastuooc-sponsor-image-wrap"><img class="fastuooc-sponsor-image" alt="赞助二维码" loading="lazy"></div>',
      '</section>',
    ].join('');
    modal.querySelector('.fastuooc-sponsor-image').src = SPONSOR_IMAGE_URL;
    const close = () => modal.remove();
    modal.addEventListener('click', (event) => {
      const actionNode = event.target.closest('[data-sponsor-action]');
      if (actionNode && actionNode.dataset.sponsorAction === 'close') close();
    });
    (document.body || document.documentElement).appendChild(modal);
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
      '#fastuooc-auto-player-controls [hidden]{display:none!important}',
      '#fastuooc-auto-player-controls.is-collapsed{width:42px;border-radius:21px}',
      '#fastuooc-auto-player-controls.is-collapsed .fastuooc-auto-player-title-main,#fastuooc-auto-player-controls.is-collapsed .fastuooc-auto-player-body,#fastuooc-auto-player-controls.is-collapsed .fastuooc-auto-player-github,#fastuooc-auto-player-controls.is-collapsed .fastuooc-auto-player-sponsor,#fastuooc-auto-player-controls.is-collapsed .fastuooc-auto-player-theme{display:none!important}',
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
      '.fastuooc-auto-player-sponsor{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:50%;padding:0;background:transparent;color:var(--panel-muted);cursor:pointer;transition:background .18s ease,color .18s ease,transform .18s ease}',
      '.fastuooc-auto-player-sponsor:hover{background:var(--button-bg);color:var(--panel-text);transform:translateY(-1px)}',
      '.fastuooc-auto-player-sponsor svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}',
      '#fastuooc-sponsor-dialog{position:fixed;inset:0;z-index:2147483647}',
      '.fastuooc-sponsor-backdrop{position:absolute;inset:0;background:rgba(15,23,42,.48);backdrop-filter:blur(5px)}',
      '.fastuooc-sponsor-dialog{position:absolute;top:50%;left:50%;width:min(380px,calc(100vw - 28px));transform:translate(-50%,-50%);padding:18px;border:1px solid rgba(148,163,184,.28);border-radius:16px;background:#fff;color:#172033;box-shadow:0 24px 70px rgba(15,23,42,.3)}',
      '.fastuooc-sponsor-head{display:flex;align-items:center;justify-content:space-between;font-size:16px}',
      '.fastuooc-sponsor-head button{width:30px;height:30px;border:0;border-radius:50%;background:#f1f5f9;color:#64748b;font-size:20px;line-height:1;cursor:pointer}',
      '.fastuooc-sponsor-help{margin:8px 0 14px;color:#64748b}',
      '.fastuooc-sponsor-image-wrap{display:flex;justify-content:center;overflow:hidden;border-radius:12px;background:#f8fafc}',
      '.fastuooc-sponsor-image{display:block;width:100%;max-height:min(62vh,520px);object-fit:contain}',
      '@media(prefers-color-scheme:dark){.fastuooc-sponsor-dialog{background:#121824;color:#e7edf7}.fastuooc-sponsor-head button{background:#334155;color:#cbd5e1}.fastuooc-sponsor-help{color:#94a3b8}.fastuooc-sponsor-image-wrap{background:#1e293b}}',
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
      '.fastuooc-auto-player-screenshot{display:flex!important;align-items:center;justify-content:center;gap:7px;width:100%!important;height:38px!important;border:1px solid var(--panel-border)!important;border-radius:10px!important;padding:0 11px!important;background:var(--button-bg)!important;color:var(--button-text)!important;cursor:pointer;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;text-align:center}',
      '.fastuooc-auto-player-screenshot:hover{background:#2563eb!important;border-color:#60a5fa!important;color:#fff!important;transform:none!important}',
      '.fastuooc-auto-player-screenshot:disabled{opacity:.55!important;cursor:not-allowed!important}',
      '.fastuooc-auto-player-screenshot svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}',
      '.fastuooc-auto-player-screenshot-settings{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:3px 10px;color:var(--panel-muted);font-size:12px}',
      '.fastuooc-auto-player-screenshot-settings label{display:flex;align-items:center;gap:5px}',
      '.fastuooc-auto-player-screenshot-scale{width:66px;height:28px;border:1px solid var(--panel-border);border-radius:6px;padding:0 5px;background:var(--button-bg);color:var(--button-text);font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.fastuooc-auto-player-screenshot-scale:disabled{opacity:.55}',
      '.fastuooc-auto-assessment-batch{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border:1px solid var(--panel-border);border-radius:10px;background:rgba(15,23,42,.08)}',
      '.fastuooc-auto-assessment-batch span{color:var(--panel-muted);font-size:12px}',
      '.fastuooc-auto-assessment-mode{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--panel-muted);font-size:12px}',
      '.fastuooc-auto-assessment-mode select{min-width:116px;height:28px;border:1px solid var(--panel-border);border-radius:6px;padding:0 5px;background:var(--button-bg);color:var(--button-text);font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.fastuooc-auto-assessment-mode select:disabled{opacity:.55}',
      '.fastuooc-auto-assessment-tools{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:4px}',
      '.fastuooc-auto-assessment-tools button{height:28px;padding:0 4px;border:1px solid var(--panel-border);border-radius:6px;background:var(--button-bg);color:var(--button-text);font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap}',
      '.fastuooc-auto-assessment-tools button:hover{background:#2563eb;color:#fff}',
      '.fastuooc-auto-assessment-tools button:disabled{opacity:.55;cursor:not-allowed}',
      '.fastuooc-auto-assessment-list{display:flex;flex-direction:column;gap:2px;max-height:180px;overflow-y:auto;padding:4px;border:1px solid var(--panel-border);border-radius:8px;background:var(--button-bg)}',
      '.fastuooc-auto-assessment-list[hidden]{display:none}',
      '.fastuooc-auto-assessment-item{display:flex;align-items:center;gap:6px;min-height:24px;padding:2px 4px;border-radius:5px;color:var(--button-text);font-size:12px;cursor:pointer}',
      '.fastuooc-auto-assessment-item:hover{background:rgba(37,99,235,.12)}',
      '.fastuooc-auto-assessment-item input{flex:none;margin:0}',
      '.fastuooc-auto-assessment-item-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit!important}',
      '.fastuooc-auto-assessment-item-tag{flex:none;font-style:normal;font-size:11px;color:var(--panel-muted)}',
      '.fastuooc-auto-assessment-item.is-done .fastuooc-auto-assessment-item-tag{color:#16a34a}',
      '.fastuooc-auto-assessment-item.is-failed .fastuooc-auto-assessment-item-tag{color:#dc2626}',
      '.fastuooc-auto-assessment-item.is-current{background:rgba(37,99,235,.18)}',
      '.fastuooc-auto-assessment-actions{display:flex;gap:6px}',
      '.fastuooc-auto-assessment-actions button{flex:1;height:32px;border:1px solid var(--panel-border);border-radius:8px;background:var(--button-bg);color:var(--button-text);font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.fastuooc-auto-assessment-start:hover{background:#2563eb;color:#fff}',
      '.fastuooc-auto-assessment-stop:hover{background:#b91c1c;color:#fff}',
      '.fastuooc-auto-assessment-actions button:disabled{opacity:.55;cursor:not-allowed}',
      '.fastuooc-auto-player-ai-row{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
      '.fastuooc-auto-player-ai{display:flex!important;align-items:center;justify-content:center;width:100%!important;height:36px!important;border:1px solid var(--panel-border)!important;border-radius:10px!important;padding:0 8px!important;background:var(--button-bg)!important;color:var(--button-text)!important;cursor:pointer;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important}',
      '.fastuooc-auto-player-ai:hover{background:#2563eb!important;border-color:#60a5fa!important;color:#fff!important;transform:none!important}',
      '.fastuooc-auto-player-ai:disabled{opacity:.55!important;cursor:not-allowed!important}',
      '.fastuooc-auto-discussion{display:flex;flex-direction:column;gap:7px;padding:9px 10px;border:1px solid var(--panel-border);border-radius:10px;background:rgba(15,23,42,.08)}',
      '.fastuooc-auto-discussion-title{display:flex;align-items:center;justify-content:space-between;color:var(--panel-text);font-weight:650;font-size:12px}',
      '.fastuooc-auto-discussion-settings{display:flex;align-items:center;gap:8px;color:var(--panel-muted);font-size:11px}',
      '.fastuooc-auto-discussion-count{width:58px;height:27px;border:1px solid var(--panel-border);border-radius:6px;padding:0 7px;background:var(--button-bg);color:var(--button-text);font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.fastuooc-auto-discussion-unlimited{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}',
      '.fastuooc-auto-discussion-unlimited input{margin:0}',
      '.fastuooc-auto-discussion-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
      '.fastuooc-auto-discussion-toggle{width:100%;height:34px;border:1px solid var(--panel-border);border-radius:8px;background:var(--button-bg);color:var(--button-text);font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
      '.fastuooc-auto-discussion-toggle:hover{background:#2563eb;border-color:#60a5fa;color:#fff}',
      '.fastuooc-auto-discussion-toggle.is-running{background:#b91c1c;border-color:#f87171;color:#fff}',
      '.fastuooc-auto-discussion-toggle.is-ai:hover{background:#7c3aed;border-color:#a78bfa}',
      '.fastuooc-auto-discussion-toggle.is-ai.is-running{background:#6d28d9;border-color:#c4b5fd}',
      '.fastuooc-auto-discussion-toggle:disabled{opacity:.55;cursor:not-allowed}',
      '.fastuooc-auto-player-theme{display:inline-flex!important;align-items:center;justify-content:center;width:30px!important;height:30px!important;flex:none;border:0!important;border-radius:50%!important;padding:0!important;background:transparent!important;color:var(--panel-muted)!important;transform:none!important}',
      '.fastuooc-auto-player-theme:hover{background:var(--button-bg)!important;color:var(--panel-text)!important}',
      '.fastuooc-auto-player-theme svg{display:none;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
      '#fastuooc-auto-player-controls[data-theme="system"] .fastuooc-auto-player-theme svg[data-mode="system"],#fastuooc-auto-player-controls[data-theme="light"] .fastuooc-auto-player-theme svg[data-mode="light"],#fastuooc-auto-player-controls[data-theme="dark"] .fastuooc-auto-player-theme svg[data-mode="dark"]{display:block}',
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
        '<button class="fastuooc-auto-player-sponsor" data-action="sponsor" type="button" title="赞助作者" aria-label="赞助作者">',
        '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path d="M862.663111 464.327111a146.346667 146.346667 0 0 0-42.666667 5.973333v-48.64a128 128 0 0 0-128-128H128.369778a128 128 0 0 0-128 128v245.333334a341.333333 341.333333 0 0 0 341.333333 341.333333h138.666667a341.333333 341.333333 0 0 0 329.813333-256 145.066667 145.066667 0 0 0 52.48 10.666667 149.333333 149.333333 0 0 0 0-298.666667z m-128 202.666667a256 256 0 0 1-256 256h-136.96a256 256 0 0 1-256-256v-245.333334a42.666667 42.666667 0 0 1 42.666667-42.666666h565.333333a42.666667 42.666667 0 0 1 42.666667 42.666666l-1.706667 245.333334z m128 10.666666a62.72 62.72 0 0 1-37.546667-12.373333h-3.413333v-101.546667h2.986667a64 64 0 1 1 37.973333 113.92zM204.743111 188.302222l-8.106667 12.373334a42.666667 42.666667 0 0 0 11.946667 59.306666 42.666667 42.666667 0 0 0 23.466667 7.253334 42.666667 42.666667 0 0 0 35.413333-19.2l8.106667-12.373334a102.826667 102.826667 0 0 0-13.226667-128 19.626667 19.626667 0 0 1-2.986667-27.306666l9.386667-15.786667A42.666667 42.666667 0 0 0 195.356444 21.048889l-9.386666 16.64a105.386667 105.386667 0 0 0 15.36 128c6.968889 5.432889 8.448 15.36 3.413333 22.613333z m178.773333 0l-8.106666 12.373334a42.666667 42.666667 0 0 0 35.413333 66.56 42.666667 42.666667 0 0 0 35.413333-19.2l8.106667-12.373334a102.826667 102.826667 0 0 0-13.226667-128 20.053333 20.053333 0 0 1-3.413333-27.306666l9.813333-15.786667a42.666667 42.666667 0 0 0-73.386666-43.52l-9.386667 16.64a105.386667 105.386667 0 0 0 16.64 128c6.172444 5.973333 7.082667 15.587556 2.133333 22.613333z m178.773334 0l-8.106667 12.373334a42.666667 42.666667 0 0 0 35.413333 66.56 42.666667 42.666667 0 0 0 35.413334-19.2l8.106666-12.373334a102.826667 102.826667 0 0 0-13.226666-128 20.053333 20.053333 0 0 1-3.413334-27.306666l11.52-15.36A42.666667 42.666667 0 0 0 611.356444 6.542222a42.666667 42.666667 0 0 0-58.453333 14.506667l-10.24 16.64a105.813333 105.813333 0 0 0 16.213333 128 17.493333 17.493333 0 0 1 3.413334 22.613333z" fill="currentColor"></path></svg>',
        '</button>',
        '<a class="fastuooc-auto-player-github" href="https://github.com/Liunian06/fastuooc" target="_blank" rel="noopener noreferrer" title="打开GitHub项目主页" aria-label="打开GitHub项目主页">',
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.01c-3.2.7-3.87-1.54-3.87-1.54-.53-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.26-1.28-5.26-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11.06 11.06 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.12 3.06.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.27 5.68.42.36.78 1.08.78 2.18v3.23c0 .31.21.67.8.56A11.52 11.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"></path></svg>',
        '</a>',
        '<button class="fastuooc-auto-player-theme" data-action="theme" type="button" title="切换界面主题" aria-label="切换界面主题">',
        '<svg data-mode="system" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"></rect><path d="M8 21h8m-4-4v4"></path></svg>',
        '<svg data-mode="light" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"></path></svg>',
        '<svg data-mode="dark" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.1A8.5 8.5 0 0 1 9.9 3.5 8.5 8.5 0 1 0 20.5 14.1Z"></path></svg>',
        '</button>',
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
        '<button class="fastuooc-auto-player-screenshot" data-action="screenshot" title="生成当前测验或作业的长截图" aria-label="生成当前测验或作业的长截图">',
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h2l1.5-2h7L17 7h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"></path><circle cx="12" cy="13" r="3.5"></circle></svg>',
        '<span>长截图</span>',
        '</button>',
        '<div class="fastuooc-auto-player-screenshot-settings">',
        '<label title="控制长截图的输出分辨率，范围0.5到4倍">分辨率 <input class="fastuooc-auto-player-screenshot-scale" data-role="screenshot-scale" type="number" min="0.5" max="4" step="0.1" inputmode="decimal"></label>',
        '<span>倍</span>',
        '</div>',
        '<div class="fastuooc-auto-assessment-batch">',
        '<span data-role="assessment-batch-summary">点击开始批量截图</span>',
        '<label class="fastuooc-auto-assessment-mode">处理模式 <select data-role="assessment-batch-mode">',
        '<option value="visible">显示式：打开页面</option>',
        '<option value="hidden">隐藏式：后台处理</option>',
        '</select></label>',
        '<div class="fastuooc-auto-assessment-tools">',
        '<button data-action="assessment-scan" type="button" title="识别当前页面可截图的考核项目">识别项目</button>',
        '<button data-action="assessment-select-all" type="button" title="勾选全部项目">全选</button>',
        '<button data-action="assessment-select-pending" type="button" title="只勾选尚未截图的项目">未截图</button>',
        '<button data-action="assessment-select-none" type="button" title="取消全部勾选">清空</button>',
        '</div>',
        '<div class="fastuooc-auto-assessment-list" data-role="assessment-list" role="group" aria-label="选择需要截图的考核项目" hidden></div>',
        '<div class="fastuooc-auto-assessment-actions">',
        '<button class="fastuooc-auto-assessment-start" data-action="assessment-start" type="button">开始批量截图</button>',
        '<button class="fastuooc-auto-assessment-stop" data-action="assessment-stop" type="button">停止批量截图</button>',
        '</div>',
        '</div>',
        '<div class="fastuooc-auto-player-ai-row">',
        '<button class="fastuooc-auto-player-ai" data-action="ai-analyze" title="获取AI参考选项，不会自动作答">AI参考</button>',
        '<button class="fastuooc-auto-player-ai" data-action="ai-settings" title="配置OpenAI兼容接口">AI设置</button>',
        '</div>',
        '<div class="fastuooc-auto-discussion">',
        '<div class="fastuooc-auto-discussion-title"><span>自动讨论</span><span data-role="discussion-summary"></span></div>',
        '<div class="fastuooc-auto-discussion-settings">',
        '<label>次数 <input class="fastuooc-auto-discussion-count" data-role="discussion-count" type="number" min="1" step="1" inputmode="numeric"></label>',
        '<label class="fastuooc-auto-discussion-unlimited"><input data-action="discussion-unlimited" type="checkbox">无上限</label>',
        '</div>',
        '<div class="fastuooc-auto-discussion-actions">',
        '<button class="fastuooc-auto-discussion-toggle" data-action="discussion-toggle" title="在综合讨论页开始或停止自动讨论">开始自动讨论</button>',
        '<button class="fastuooc-auto-discussion-toggle is-ai" data-action="ai-discussion-toggle" title="根据帖子题目和正文生成纯文本AI讨论回复">开始AI讨论</button>',
        '</div>',
        '</div>',
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
        const screenshot = box.querySelector('[data-action="screenshot"]');
        const screenshotScale = box.querySelector('[data-role="screenshot-scale"]');
        const assessmentBatch = box.querySelector('.fastuooc-auto-assessment-batch');
        const assessmentBatchSummary = box.querySelector('[data-role="assessment-batch-summary"]');
        const assessmentBatchMode = box.querySelector('[data-role="assessment-batch-mode"]');
        const assessmentBatchStart = box.querySelector('[data-action="assessment-start"]');
        const assessmentBatchStop = box.querySelector('[data-action="assessment-stop"]');
        const discussionCount = box.querySelector('[data-role="discussion-count"]');
        const discussionUnlimited = box.querySelector('[data-action="discussion-unlimited"]');
        const discussionToggle = box.querySelector('[data-action="discussion-toggle"]');
        const aiDiscussionToggle = box.querySelector('[data-action="ai-discussion-toggle"]');
        const discussionSummary = box.querySelector('[data-role="discussion-summary"]');
        const controlPage = getControlPage();
        [enabled, next, mute, background].forEach((button) => { button.hidden = !controlPage.playback; });
        box.querySelector('[data-role="state"]').hidden = !controlPage.playback;
        box.querySelector('.fastuooc-auto-player-export').hidden = !controlPage.quiz;
        screenshot.hidden = !controlPage.quiz;
        screenshotScale.closest('.fastuooc-auto-player-screenshot-settings').hidden = !controlPage.quiz;
        box.querySelector('.fastuooc-auto-player-ai-row').hidden = !controlPage.quiz;
        assessmentBatch.hidden = !isNewAssessmentPage();
        assessmentBatchSummary.textContent = getAssessmentBatchSummary();
        assessmentBatchMode.value = state.config.assessmentBatchMode;
        assessmentBatchMode.disabled = state.assessmentBatch.active;
        assessmentBatchStart.disabled = state.assessmentBatch.active;
        assessmentBatchStop.disabled = !state.assessmentBatch.active;
        box.querySelector('[data-action="assessment-scan"]').disabled = state.assessmentBatch.active;
        box.querySelector('[data-action="assessment-scan"]').textContent = state.assessmentBatch.items.length ? '重新识别' : '识别项目';
        ['assessment-select-all', 'assessment-select-pending', 'assessment-select-none'].forEach((name) => {
          box.querySelector('[data-action="' + name + '"]').disabled = state.assessmentBatch.active || !state.assessmentBatch.items.length;
        });
        if (!assessmentBatch.hidden) renderAssessmentBatchList(box.querySelector('[data-role="assessment-list"]'));
        box.querySelector('.fastuooc-auto-discussion').hidden = !controlPage.discussion;
        if (!controlPage.quiz) {
          const aiSettings = document.getElementById('fastuooc-ai-settings');
          if (aiSettings) aiSettings.hidden = true;
        }
        if (!controlPage.discussion && (state.discussion.running || state.aiDiscussion.running)) {
          scheduleDiscussionStopIfNeeded();
        } else if (controlPage.discussion) {
          clearDiscussionExitTimer();
        }
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
        screenshot.disabled = state.screenshotRunning;
        screenshotScale.disabled = state.screenshotRunning;
        screenshotScale.value = String(state.config.screenshotScale);
        screenshot.querySelector('span').textContent = state.screenshotRunning ? '生成中…' : '长截图';
        if (document.activeElement !== discussionCount) discussionCount.value = state.config.discussionCount;
        discussionUnlimited.checked = Boolean(state.config.discussionUnlimited);
        const anyDiscussionRunning = state.discussion.running || state.aiDiscussion.running;
        discussionCount.disabled = anyDiscussionRunning || state.config.discussionUnlimited;
        discussionUnlimited.disabled = anyDiscussionRunning;
        discussionToggle.disabled = state.aiDiscussion.running;
        aiDiscussionToggle.disabled = state.discussion.running;
        discussionToggle.classList.toggle('is-running', state.discussion.running);
        aiDiscussionToggle.classList.toggle('is-running', state.aiDiscussion.running);
        discussionToggle.textContent = state.discussion.running ? '停止自动讨论' : '开始自动讨论';
        aiDiscussionToggle.textContent = state.aiDiscussion.running ? '停止AI讨论' : '开始AI讨论';
        const formatDiscussionSummary = (discussionState) => {
          if (!discussionState.running) return discussionState.phase === 'idle' ? '未运行' : discussionState.phase;
          const phase = discussionState.phase === 'waiting' ? '等待' : discussionState.phase;
          const remaining = discussionState.remainingMs > 0 ? ' · 冷却' + formatDiscussionRemaining(discussionState.remainingMs) : '';
          return discussionState.completed + '/' + (state.config.discussionUnlimited ? '∞' : discussionState.target) + ' · ' + phase + remaining;
        };
        discussionSummary.textContent = state.aiDiscussion.running
          ? 'AI · ' + formatDiscussionSummary(state.aiDiscussion)
          : formatDiscussionSummary(state.discussion);
        theme.title = `切换界面主题，当前为${themeLabel}`;
        theme.setAttribute('aria-label', theme.title);
        const discussionDetail = state.aiDiscussion.running
          ? 'AI讨论第' + (state.aiDiscussion.completed + 1) + '次' + (state.aiDiscussion.lastPage ? ' · 第' + state.aiDiscussion.lastPage + '页' : '')
          : state.discussion.running
            ? '自动讨论第' + (state.discussion.completed + 1) + '次' + (state.discussion.lastPage ? ' · 第' + state.discussion.lastPage + '页' : '')
            : '讨论未运行';
        box.querySelector('[data-role="state"]').textContent = masterEnabled ? `${state.config.speed}倍速 · 静音 · 后台播放 · ${themeLabel} · ${discussionDetail}` : `${state.config.speed}倍速 · ${state.config.autoNext ? '连播' : '不连播'} · ${state.config.muted ? '静音' : '有声'} · ${state.config.keepBackground ? '后台播放' : '前台播放'} · ${themeLabel} · ${discussionDetail}`;
      };
      state.controlsUpdate = update;
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
        if (action === 'sponsor') {
          openSponsorDialog();
          return;
        }
        if (action === 'export') {
          exportQuiz();
          return;
        }
        if (action === 'screenshot') {
          captureQuizScreenshot();
          return;
        }
        if (action === 'assessment-start') {
          startAssessmentBatchScreenshot();
          return;
        }
        if (action === 'assessment-scan') {
          scanAssessmentBatchItems();
          return;
        }
        if (action === 'assessment-select-all' || action === 'assessment-select-pending' || action === 'assessment-select-none') {
          setAssessmentSelection(action.slice('assessment-select-'.length));
          return;
        }
        if (action === 'assessment-stop') {
          if (!state.assessmentBatch.active) return;
          stopAssessmentBatch();
          notify('已停止新版考核批量截图');
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
        if (action === 'discussion-toggle') {
          if (state.discussion.running) stopDiscussion();
          else startDiscussion();
          update();
          return;
        }
        if (action === 'ai-discussion-toggle') {
          if (state.aiDiscussion.running) stopAIDiscussion();
          else startAIDiscussion();
          update();
          return;
        }
        if (action === 'discussion-unlimited') {
          state.config.discussionUnlimited = control.checked;
          saveConfig();
          update();
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
      box.addEventListener('input', (event) => {
        if (!event.target.matches('[data-role="discussion-count"]')) return;
        const value = Math.max(1, Math.floor(Number(event.target.value) || 1));
        state.config.discussionCount = value;
        saveConfig();
        refreshControls();
      });
      box.addEventListener('change', (event) => {
        if (event.target.matches('[data-role="assessment-item"]')) {
          const batch = state.assessmentBatch;
          const item = batch.items.find((entry) => entry.key === event.target.dataset.key);
          if (item && !batch.active) {
            item.selected = event.target.checked;
            saveAssessmentSelection();
          }
          refreshControls();
          return;
        }
        if (event.target.matches('[data-role="assessment-batch-mode"]')) {
          state.config.assessmentBatchMode = event.target.value === 'hidden' ? 'hidden' : 'visible';
          saveConfig();
          refreshControls();
          return;
        }
        if (!event.target.matches('[data-role="screenshot-scale"]')) return;
        const text = event.target.value.trim();
        const raw = Number(text);
        if (text && Number.isFinite(raw)) {
          const value = Math.min(SCREENSHOT_SCALE_MAX, Math.max(SCREENSHOT_SCALE_MIN, raw));
          state.config.screenshotScale = Math.round(value * 10) / 10;
          saveConfig();
        }
        refreshControls();
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
        if (state.assessmentBatch.active) stopAssessmentBatch();
        state.assessmentBatch.route = '';
        state.assessmentBatch.phase = 'idle';
        state.assessmentBatch.items = [];
        state.assessmentBatch.queue = [];
        state.assessmentBatch.index = 0;
        state.assessmentBatch.completed = 0;
        state.assessmentBatch.failures = [];
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
        refreshControls();
      }
      scan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('hashchange', () => setTimeout(() => {
      refreshControls();
      scan();
    }, 100));
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
    const initialize = () => {
      installAssessmentBatchMessages();
      installAssessmentCaptureWorker();
      installControls();
      startBackgroundPlaybackGuard();
      observe();
      scan();
    };
    if (document.documentElement) initialize();
    else document.addEventListener('DOMContentLoaded', initialize, { once: true });
  }

  start();
})();


