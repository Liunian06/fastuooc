// ==UserScript==
// @name         Fast UOOC
// @namespace    fastuooc.local
// @version      0.4.0
// @description  自动控制UOOC视频播放，并支持按题拆分导出当前测验的题目与选项。
// @author       Liunian06
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
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

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
  });

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
  };

  function loadConfig() {
    try {
      const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
      return Object.assign({}, DEFAULT_CONFIG, stored);
    } catch (_) {
      return Object.assign({}, DEFAULT_CONFIG);
    }
  }

  function saveConfig() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
  }

  function enforceMasterConfig() {
    if (!state.config.enabled) return false;
    const changed = !state.config.autoNext || !state.config.muted || !state.config.keepBackground;
    state.config.autoNext = true;
    state.config.muted = true;
    state.config.keepBackground = true;
    return changed;
  }

  function log(...args) {
    console.debug('[UOOC自动播放]', ...args);
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
      return {
        number,
        type: typeNode ? textFromElement(typeNode).replace(/\s*\(共[\s\S]*$/, '').trim() : '未分类',
        question: textFromElement(container.querySelector('.ti-q-c')),
        options,
        score: textFromElement(container.querySelector('.scores')),
        id: (container.querySelector('.index') || {}).id || (container.querySelector('input[name]') || {}).name || '',
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
    if (!video || !window.videojs) return null;
    try {
      if (typeof window.videojs.getPlayers === 'function') {
        const players = window.videojs.getPlayers();
        const player = Object.keys(players || {})
          .map((key) => players[key])
          .find((candidate) => candidate && candidate.el && candidate.el() === video);
        if (player) return player;
      }
      if (typeof window.videojs.getPlayer === 'function' && video.id) {
        return window.videojs.getPlayer(video.id);
      }
    } catch (error) {
      log('查找Video.js实例失败', error);
    }
    return null;
  }

  function getAngularInjector() {
    try {
      if (!window.angular || !document.body) return null;
      return window.angular.element(document.body).injector() || null;
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
    if (!window.angular) return null;
    const root = getAngularRootScope();
    if (root && Array.isArray(root.chapterList)) return root;
    const nodes = document.querySelectorAll(
      '[ng-repeat*="chapterItem in chapterList"], .panel-catalog, .newlearn_left_card_chapter_list, [source-view]'
    );
    for (const node of nodes) {
      try {
        const scope = climbScope(window.angular.element(node).scope(), (candidate) =>
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
      log('关闭平台后台暂停策略失败', error);
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
      log('后台播放恢复检查', reason);
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
        log('读取Video.js资源列表失败', error);
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
      log('应用播放器设置失败', error);
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
    log('切换到候选视频资源', next);
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
      if (activeNode && window.angular) {
        activeSource = climbScope(window.angular.element(activeNode).scope(), (candidate) =>
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
    if (Array.isArray(node.unitSource)) return Promise.resolve(node.unitSource);
    const pending = state.unitSourcePromises.get(node);
    if (pending) return pending;

    const courseService = getCourseService();
    const params = getRouteParams();
    if (!courseService || typeof courseService.getUnitLearn !== 'function') {
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
    const promise = Promise.resolve(courseService.getUnitLearn(request))
      .then((response) => {
        node.unitSource = extractSourceList(response);
        return node.unitSource;
      })
      .catch((error) => {
        log('读取课程资源失败', request, error);
        return [];
      });
    state.unitSourcePromises.set(node, promise);
    return promise;
  }

  async function collectAllCatalogEntries() {
    const learnScope = getLearnScope();
    const chapterList = learnScope && learnScope.chapterList;
    if (!Array.isArray(chapterList)) return collectCatalogEntries();

    const entries = [];
    const courseId = getRouteParams().courseId;
    for (const chapter of chapterList) {
      const chapterId = normalizeId(chapter.id);
      const sections = Array.isArray(chapter.children) ? chapter.children : [];
      for (const section of sections) {
        const sectionId = normalizeId(section.id);
        const sectionSources = await loadUnitSources(section, { courseId, chapterId, sectionId, pointId: '' });
        sectionSources.forEach((source) => {
          const entry = makeVideoEntry(source, { courseId, chapterId, sectionId, pointId: '' });
          if (entry) entries.push(entry);
        });

        const points = Array.isArray(section.children) ? section.children : [];
        for (const point of points) {
          const pointId = normalizeId(point.id);
          const pointSources = await loadUnitSources(point, { courseId, chapterId, sectionId, pointId });
          pointSources.forEach((source) => {
            const entry = makeVideoEntry(source, { courseId, chapterId, sectionId, pointId });
            if (entry) entries.push(entry);
          });
        }
      }
    }
    return entries;
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
    if (!window.angular || !entry) return null;
    const nodes = document.querySelectorAll('[ng-click*="goSource"]');
    for (const node of nodes) {
      try {
        const scope = climbScope(window.angular.element(node).scope(), (candidate) =>
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
      log('点击目录视频资源失败', error);
      return false;
    }
  }

  function getTargetSourceState(route) {
    return route.pointId ? 'main.chapter.section.point.source' : 'main.chapter.section.source';
  }

  function getChapterNavigationNodes() {
    return Array.from(document.querySelectorAll('[ui-sref]')).filter((node) => {
      const state = node.getAttribute('ui-sref') || '';
      return state.startsWith('main.chapter(');
    });
  }

  function getChapterItemFromNode(node) {
    if (!window.angular || !node) return null;
    try {
      const scope = climbScope(window.angular.element(node).scope(), (candidate) =>
        candidate.chapterItem && candidate.chapterItem.id != null
      );
      return scope && scope.chapterItem;
    } catch (_) {
      return null;
    }
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
      next.node.click();
      return next;
    } catch (error) {
      log('点击下一章节失败', error);
      return null;
    }
  }

  async function waitForChapterEntries(chapterId, currentSourceId) {
    const deadline = Date.now() + 9000;
    let latest = [];
    while (Date.now() < deadline) {
      try {
        latest = await collectAllCatalogEntries();
      } catch (error) {
        log('等待章节资源时读取目录失败', error);
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
    if (!entry || state.navigating) return false;
    state.navigating = true;
    notify('正在播放：' + (entry.title || entry.id));

    // 优先模拟用户点击目录资源，让新旧UI各自执行原生goSource流程。
    if (clickCatalogSource(entry)) {
      setTimeout(() => { state.navigating = false; }, 900);
      return true;
    }

    const stateService = getStateService();
    if (!stateService || typeof stateService.go !== 'function') {
      state.navigating = false;
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
    Promise.resolve(transition)
      .catch((error) => log('跳转视频资源失败', error))
      .finally(() => {
        setTimeout(() => { state.navigating = false; }, 900);
      });
    return true;
  }

  async function playNextVideo() {
    if (!state.config.autoNext || state.navigating || state.nextRun) return;
    state.nextRun = Date.now();
    let currentId = getCurrentSourceId();
    let currentChapterId = getRouteParams().chapterId;
    const visitedChapters = new Set();
    if (currentChapterId) visitedChapters.add(normalizeId(currentChapterId));

    try {
      for (let hop = 0; hop < 64; hop += 1) {
        const entries = await collectAllCatalogEntries();
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
        if (next && navigateToEntry(next)) return;

        const nextChapter = clickNextChapter(currentChapterId);
        if (!nextChapter) {
          if (!uniqueEntries.length) {
            notify('暂未读取到可用的视频列表');
            log('课程视频列表为空，无法自动连播', { currentId, currentChapterId });
          } else {
            notify('已到达课程最后一个可用视频');
            log('没有下一个视频资源', {
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
          log('检测到重复章节，停止自动连播', { currentChapterId, nextChapterId });
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
        currentId = '';
      }
      notify('未找到下一个可播放视频');
      log('超过章节遍历上限，停止自动连播');
    } catch (error) {
      notify('自动连播失败，请查看控制台日志');
      log('自动连播异常', error);
    } finally {
      setTimeout(() => { state.nextRun = 0; }, 500);
    }
  }

  function onVideoEnded(video, generation) {
    if (generation !== state.videoGeneration || state.video !== video) return;
    const key = `${location.href}|${getCurrentSourceId()}`;
    if (state.handledErrors.has(`ended:${key}`)) return;
    state.handledErrors.add(`ended:${key}`);
    const routeAtEnd = location.href;
    setTimeout(() => {
      if (generation !== state.videoGeneration || state.video !== video || location.href !== routeAtEnd) return;
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
      if (!tryNextSource(video)) notify('视频资源不可用，未找到可切换线路');
    }, { passive: true });

    applyMediaSettings(video, true);
    log('已接管播放器', { currentSrc: video.currentSrc, sources: getPlayerSources(video, state.player) });
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
        state.lastRoute = location.href;
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
    installControls();
    startBackgroundPlaybackGuard();
    observe();
    scan();
  }

  start();
})();


