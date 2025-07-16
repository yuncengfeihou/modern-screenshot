// --- START OF FILE index.js ---

import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import {
    saveSettingsDebounced,
} from '../../../../script.js';

// --- 插件元数据 ---
const PLUGIN_ID = 'modern-screenshot';
const PLUGIN_NAME = 'Modern Screenshot';

// --- 日志系统 ---
const captureLogger = {
    log: (message, level = 'info', data = null) => {
        const timer = new Date().toLocaleTimeString();
        console[level](`[${timer}][${PLUGIN_NAME}] ${message}`, data || '');
    },
    info: (message, data) => { captureLogger.log(message, 'info', data); },
    warn: (message, data) => { captureLogger.log(message, 'warn', data); },
    error: (message, data) => { captureLogger.log(message, 'error', data); },
};

// --- 默认设置与配置 ---
const defaultSettings = {
    screenshotScale: 1.5,
    imageFormat: 'jpeg',
    imageQuality: 0.92,
    autoInstallButtons: true,
    debugOverlay: false,
};
const config = {
    buttonClass: 'st-screenshot-button',
    chatContentSelector: '#chat',
    messageSelector: '.mes',
};


// --- 新增：性能优化 ---

// 优化2：样式白名单 - 只复制必要的CSS属性以提高克隆速度
const OPTIMIZED_STYLE_PROPERTIES = new Set([
    'display', 'position', 'top', 'right', 'bottom', 'left', 'float', 'clear',
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border', 'border-width', 'border-style', 'border-color', 'border-radius', 
    'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
    'border-collapse', 'border-spacing', 'box-sizing', 'overflow', 'overflow-x', 'overflow-y',
    'flex', 'flex-basis', 'flex-direction', 'flex-flow', 'flex-grow', 'flex-shrink', 'flex-wrap',
    'align-content', 'align-items', 'align-self', 'justify-content', 'justify-items', 'justify-self',
    'gap', 'row-gap', 'column-gap',
    'grid', 'grid-area', 'grid-template', 'grid-template-areas', 'grid-template-rows', 'grid-template-columns',
    'grid-row', 'grid-row-start', 'grid-row-end', 'grid-column', 'grid-column-start', 'grid-column-end',
    'color', 'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
    'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-decoration', 'text-indent',
    'text-transform', 'text-shadow', 'white-space', 'vertical-align',
    'background', 'background-color', 'background-image', 'background-repeat', 'background-position', 'background-size', 'background-clip',
    'opacity', 'visibility', 'box-shadow', 'outline', 'outline-offset', 'cursor',
    'transform', 'transform-origin', 'transform-style', 'transition', 'animation', 'filter',
    'list-style', 'list-style-type', 'list-style-position', 'list-style-image',
]);
const STYLE_WHITELIST_ARRAY = Array.from(OPTIMIZED_STYLE_PROPERTIES);

// 优化1：缓存单位背景
let CACHED_UNIT_BACKGROUND = null;
function invalidateUnitBackgroundCache() {
    if (CACHED_UNIT_BACKGROUND) {
        captureLogger.info('缓存失效：单位背景已被清除。');
        CACHED_UNIT_BACKGROUND = null;
    }
}

// --- 新增：字体管理器 (FontManager) ---
// 该管理器负责处理自定义主题字体的检测、后台下载、持久化缓存和供应。
class FontManager {
    constructor(dbName = 'ModernScreenshotDB', storeName = 'FontCache') {
        this.DB_NAME = dbName;
        this.STORE_NAME = storeName;
        this.db = null;
        this.worker = null;
        this.fontState = new Map(); // 存储每个字体URL的状态: 'READY', 'DOWNLOADING', 'ERROR'
        this.memoryCache = new Map(); // 内存缓存，用于存储已准备好的字体CSS
        this.downloadPromises = new Map(); // 存储正在下载的字体的Promise
        // --- 修复：新增一个Map专门用于存储resolve函数 ---
        this.downloadResolvers = new Map();
    }

    async _initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, 1);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'cssUrl' });
                }
            };
            request.onerror = (event) => reject(`IndexedDB error: ${event.target.errorCode}`);
            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve(this.db);
            };
        });
    }

    _initWorker() {
        // 注意：这里的路径是相对于SillyTavern根目录的
        const workerUrl = `/scripts/extensions/third-party/${PLUGIN_ID}/font-worker.js`;
        this.worker = new Worker(workerUrl);
        this.worker.onmessage = (event) => {
            const { status, payload } = event.data;
            const { cssUrl, fontFaceCss, message } = payload;
            
            // --- 修复：从专门的Map中获取resolve函数 ---
            const resolve = this.downloadResolvers.get(cssUrl);

            if (status === 'success') {
                captureLogger.info(`字体下载成功: ${cssUrl}`);
                this.fontState.set(cssUrl, 'READY');
                this.memoryCache.set(cssUrl, fontFaceCss);
                this._saveToDB({ cssUrl, fontFaceCss });
                if (resolve) resolve(fontFaceCss);
            } else {
                captureLogger.error(`字体处理失败: ${cssUrl}`, message);
                this.fontState.set(cssUrl, 'ERROR');
                if (resolve) resolve(''); // 返回空字符串表示失败
            }
            // --- 修复：清理两个Map ---
            this.downloadPromises.delete(cssUrl);
            this.downloadResolvers.delete(cssUrl);
        };
    }

    async _getFromDB(key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.STORE_NAME], 'readonly');
            const store = transaction.objectStore(this.STORE_NAME);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject('Failed to get from DB');
        });
    }

    async _saveToDB(data) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.STORE_NAME], 'readwrite');
            const store = transaction.objectStore(this.STORE_NAME);
            const request = store.put(data);
            request.onsuccess = () => resolve();
            request.onerror = () => reject('Failed to save to DB');
        });
    }

    async _handleStyleChange() {
        const styleElement = document.querySelector('#custom-style');
        if (!styleElement) return;

        const rawCss = styleElement.textContent || '';
        const importMatch = /@import\s+url\((['"]?)(.*?)\1\);/g.exec(rawCss);
        
        // 如果没有@import规则，则认为没有自定义字体
        if (!importMatch) {
            this.currentThemeCssUrl = null;
            return;
        }
        
        const cssUrl = importMatch[2];
        this.currentThemeCssUrl = cssUrl;

        // 如果字体已就绪或正在下载，则不重复处理
        if (this.fontState.get(cssUrl) === 'READY' || this.fontState.get(cssUrl) === 'DOWNLOADING') {
            return;
        }

        // 检查内存缓存
        if (this.memoryCache.has(cssUrl)) {
            this.fontState.set(cssUrl, 'READY');
            return;
        }
        
        // 检查IndexedDB
        const cachedFont = await this._getFromDB(cssUrl);
        if (cachedFont) {
            captureLogger.info(`从IndexedDB加载了缓存字体: ${cssUrl}`);
            this.memoryCache.set(cssUrl, cachedFont.fontFaceCss);
            this.fontState.set(cssUrl, 'READY');
            return;
        }

        // 如果哪里都找不到，则开始下载
        captureLogger.info(`检测到新字体，开始后台下载: ${cssUrl}`);
        this.fontState.set(cssUrl, 'DOWNLOADING');
        
        // --- 修复：正确地创建Promise并分别存储Promise和resolve函数 ---
        const promise = new Promise(resolve => {
            this.downloadResolvers.set(cssUrl, resolve);
        });
        this.downloadPromises.set(cssUrl, promise);

        this.worker.postMessage({ type: 'DOWNLOAD_FONT', cssUrl });
    }

    async init() {
        await this._initDB();
        this._initWorker();

        const observer = new MutationObserver(() => {
            captureLogger.info('检测到 #custom-style 变化，正在处理字体...');
            this._handleStyleChange();
        });

        const styleNode = document.getElementById('custom-style');
        if (styleNode) {
            observer.observe(styleNode, { childList: true, characterData: true });
            // 初始触发一次
            this._handleStyleChange();
        } else {
            captureLogger.warn('未能找到 #custom-style，无法启动字体监控。');
        }
    }

    async getCurrentThemeFontCssAsync() {
        const cssUrl = this.currentThemeCssUrl;
        if (!cssUrl) return ''; // 没有自定义字体

        const state = this.fontState.get(cssUrl);

        if (state === 'READY') {
            return this.memoryCache.get(cssUrl) || '';
        }

        if (state === 'DOWNLOADING') {
            captureLogger.info('截图操作正在等待字体下载完成...');
            // 这里等待的是Promise对象，是正确的
            return await this.downloadPromises.get(cssUrl) || '';
        }
        
        if (state === 'ERROR') {
            return ''; // 字体下载失败
        }

        // 如果由于某种原因状态未知，则强制重新处理
        await this._handleStyleChange();
        return await this.getCurrentThemeFontCssAsync();
    }
}
const fontManager = new FontManager();
// --- 字体管理器结束 ---


// --- 字体数据缓存 (仅用于Font Awesome) ---
const FONT_DATA_CACHE = new Map();

let CACHED_FA_CSS = null;

async function getFontAwesomeCssAsync() {
    // 缓存依然有效且重要
    if (CACHED_FA_CSS) {
        captureLogger.info('命中缓存：正在使用已缓存的 Font Awesome CSS。');
        return CACHED_FA_CSS;
    }

    captureLogger.info('正在从 document.styleSheets 中直接读取和处理 Font Awesome @font-face 规则...');
    
    // 1. 遍历所有样式表和规则，直接找到 @font-face 规则
    const fontFaceRules = [];
    for (const sheet of document.styleSheets) {
        // 安全地访问cssRules，防止跨域错误
        let rules;
        try {
            rules = sheet.cssRules;
        } catch (e) {
            // captureLogger.warn(`无法读取样式表: ${sheet.href}`, e);
            continue;
        }
        if (!rules) continue;

        for (const rule of rules) {
            // 检查是否是 @font-face 规则，并且 font-family 包含 'Font Awesome'
            if (rule.type === CSSRule.FONT_FACE_RULE) {
                const fontFaceRule = rule;
                if (fontFaceRule.style.fontFamily.includes('Font Awesome')) {
                    fontFaceRules.push(fontFaceRule);
                }
            }
        }
    }

    if (fontFaceRules.length === 0) {
        captureLogger.error('未能从 document.styleSheets 中找到任何 Font Awesome 的 @font-face 规则。图标将无法显示。');
        return '';
    }

    captureLogger.info(`找到了 ${fontFaceRules.length} 条 Font Awesome @font-face 规则。`);

    // 2. 处理每一条规则，下载并内联字体
    const fontUrlRegex = /url\((['"]?)(.+?)\1\)/g;
    const processedRulesPromises = fontFaceRules.map(async (rule) => {
        let originalCssText = rule.cssText;
        let processedRule = originalCssText;

        const fontUrlMatches = [...originalCssText.matchAll(fontUrlRegex)];

        for (const urlMatch of fontUrlMatches) {
            const originalUrlToken = urlMatch[0]; // 完整 url(...)
            const fontPath = urlMatch[2]; // 字体文件路径
            
            // 此时的 fontPath 已经是浏览器解析过的绝对路径
            const absoluteFontUrl = fontPath;

            let fontDataUrl = FONT_DATA_CACHE.get(absoluteFontUrl);
            if (!fontDataUrl) {
                captureLogger.info(`正在下载并缓存 Font Awesome 字体文件: ${absoluteFontUrl}`);
                try {
                    const fontBlob = await fetch(absoluteFontUrl).then(res => {
                        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                        return res.blob();
                    });
                    fontDataUrl = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.onerror = reject;
                        reader.readAsDataURL(fontBlob);
                    });
                    FONT_DATA_CACHE.set(absoluteFontUrl, fontDataUrl);
                } catch (err) {
                    captureLogger.error(`下载字体失败: ${absoluteFontUrl}`, err);
                    continue; // 跳过这个失败的字体
                }
            }
            
            // 替换规则中的 URL
            processedRule = processedRule.replace(originalUrlToken, `url("${fontDataUrl}")`);
        }
        return processedRule;
    });

    const finalRules = await Promise.all(processedRulesPromises);
    const finalCss = finalRules.join('\n');
    
    captureLogger.info(`Font Awesome CSS 处理完成，成功内联了 ${finalRules.length} 个 @font-face 规则。`);
    CACHED_FA_CSS = finalCss; // 存入缓存
    return finalCss;
}

// --- 背景与合成核心 (单消息) ---

function findActiveBackgroundElement() {
    const selectors = ['#bg_animation_container > div[id^="bg"]', '#background > div[id^="bg"]', '#bg1', '#bg_animation_container', '#background'];
    for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).backgroundImage !== 'none') return el;
    }
    captureLogger.warn("未能找到特定的背景元素，将回退到 #chat 作为背景源。");
    return document.querySelector(config.chatContentSelector);
}

function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = (err) => reject(new Error('图片加载失败', { cause: err }));
        img.src = dataUrl;
    });
}

async function createCompositeCanvas(foregroundImg, originalElement) {
    const timer = (label, start = performance.now()) => () => captureLogger.info(`⏱️ [合成耗时] ${label}: ${(performance.now() - start).toFixed(2)} ms`);
    const dataAcqStart = timer('1. 数据采集');
    const settings = getPluginSettings();
    const scale = settings.screenshotScale;
    const backgroundHolder = findActiveBackgroundElement();
    if (!backgroundHolder) throw new Error("无法找到有效的背景持有元素。");
    const chatContainer = document.querySelector(config.chatContentSelector);
    const chatRect = chatContainer.getBoundingClientRect();
    const messageRect = originalElement.getBoundingClientRect();
    const messageOffsetY = messageRect.top - chatRect.top;
    const messageWidth = foregroundImg.width;
    const messageHeight = foregroundImg.height;
    dataAcqStart();
    const bgCaptureStart = timer('2. 捕获背景并裁剪');
    const foregroundSelectors = ['#chat', '#form_sheld', '.header', '#right-panel', '#left-panel', '#character-popup'];
    const hiddenElements = [];
    let fullBackgroundDataUrl;
    try {
        foregroundSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                if (el.style.visibility !== 'hidden') {
                    el.style.visibility = 'hidden';
                    hiddenElements.push(el);
                }
            });
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        fullBackgroundDataUrl = await window.domToDataUrl(backgroundHolder, {
            scale: scale,
            includeStyleProperties: STYLE_WHITELIST_ARRAY, // 优化2：应用样式白名单
        });
    } finally {
        hiddenElements.forEach(el => { el.style.visibility = 'visible'; });
    }
    if (!fullBackgroundDataUrl) throw new Error("背景截图失败，未能获取DataURL。");
    const fullBgImage = await loadImage(fullBackgroundDataUrl);
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = messageWidth;
    finalCanvas.height = messageHeight;
    const finalCtx = finalCanvas.getContext('2d');

    // 步骤 1: 绘制背景图
    finalCtx.drawImage(fullBgImage, (messageRect.left) * scale, (messageOffsetY) * scale, messageWidth, messageHeight, 0, 0, messageWidth, messageHeight);
    bgCaptureStart();

    // --- 新增：合成 #chat 背景色 ---
    const chatElement = document.querySelector(config.chatContentSelector);
    if (chatElement) {
        const chatBgColor = window.getComputedStyle(chatElement).backgroundColor;
        // 只有在背景色不是完全透明时才绘制，以避免不必要的性能开销
        if (chatBgColor && chatBgColor !== 'rgba(0, 0, 0, 0)') {
            captureLogger.info(`正在应用 #chat 背景色: ${chatBgColor}`);
            finalCtx.fillStyle = chatBgColor;
            finalCtx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
        }
    }
    // --- 新增结束 ---

    const compositionStart = timer('3. 合成前景');
    // 步骤 3: 绘制消息内容
    finalCtx.drawImage(foregroundImg, 0, 0);
    compositionStart();

    return finalCanvas;
}

// --- 长截图核心逻辑 ---

// --- 优化1：修改函数以使用缓存 ---
async function createUnitBackgroundAsync(scale) {
    if (CACHED_UNIT_BACKGROUND) {
        captureLogger.info('命中缓存：正在使用已缓存的“单位背景”。');
        // 返回克隆体以防后续操作污染缓存
        const clonedCanvas = CACHED_UNIT_BACKGROUND.cloneNode(true);
        const ctx = clonedCanvas.getContext('2d');
        ctx.drawImage(CACHED_UNIT_BACKGROUND, 0, 0);
        return clonedCanvas;
    }

    captureLogger.info('正在创建可平铺的“单位背景”...');
    const backgroundHolder = findActiveBackgroundElement();
    const chatContainer = document.querySelector(config.chatContentSelector);
    const formSheld = document.querySelector('#form_sheld');
    if (!backgroundHolder || !chatContainer) throw new Error("无法找到 #chat 或背景元素！");
    const chatRect = chatContainer.getBoundingClientRect();
    const formSheldHeight = formSheld ? formSheld.offsetHeight : 0;
    const unitWidth = chatContainer.clientWidth;
    const unitHeight = chatRect.height - formSheldHeight;
    const unitTop = chatRect.top;
    const unitLeft = chatContainer.getBoundingClientRect().left;
    const foregroundSelectors = ['#chat', '#form_sheld', '.header', '#right-panel', '#left-panel', '#character-popup'];
    const hiddenElements = [];
    let fullBackgroundDataUrl;
    try {
        foregroundSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                if (el.style.visibility !== 'hidden') {
                    el.style.visibility = 'hidden';
                    hiddenElements.push(el);
                }
            });
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        // --- 优化2：应用样式白名单 ---
        fullBackgroundDataUrl = await window.domToDataUrl(backgroundHolder, { 
            scale,
            includeStyleProperties: STYLE_WHITELIST_ARRAY,
        });
    } finally {
        hiddenElements.forEach(el => el.style.visibility = 'visible');
    }
    if (!fullBackgroundDataUrl) throw new Error("创建单位背景时，背景截图失败。");
    const fullBgImage = await loadImage(fullBackgroundDataUrl);
    const unitCanvas = document.createElement('canvas');
    unitCanvas.width = unitWidth * scale;
    unitCanvas.height = unitHeight * scale;
    const unitCtx = unitCanvas.getContext('2d');
    unitCtx.drawImage(fullBgImage, unitLeft * scale, unitTop * scale, unitWidth * scale, unitHeight * scale, 0, 0, unitWidth * scale, unitHeight * scale);
    
    // --- 优化1：将结果存入缓存 ---
    CACHED_UNIT_BACKGROUND = unitCanvas;
    captureLogger.info('“单位背景”创建并缓存成功！');

    // 返回克隆体以防万一
    const returnedCanvas = unitCanvas.cloneNode(true);
    const returnedCtx = returnedCanvas.getContext('2d');
    returnedCtx.drawImage(unitCanvas, 0, 0);
    return returnedCanvas;
}

async function captureLongScreenshot(elementsToCapture) {
    if (!elementsToCapture || elementsToCapture.length === 0) throw new Error("没有提供任何用于长截图的元素。");
    const timer = (label, start = performance.now()) => () => captureLogger.info(`⏱️ [长截图耗时] ${label}: ${(performance.now() - start).toFixed(2)} ms`);
    const mainProcessStart = timer('总流程');
    const settings = getPluginSettings();
    const scale = settings.screenshotScale;

    const fontPrepStart = timer('0. 聚合字体准备');
    
    // --- 修改：使用新的FontManager ---
    const [customFontCss, faCss] = await Promise.all([
        fontManager.getCurrentThemeFontCssAsync(),
        getFontAwesomeCssAsync(),
    ]);
    const combinedCss = `${customFontCss}\n${faCss}`;
    // --- 修改结束 ---
    
    fontPrepStart();

    const calcStart = timer('1. 计算总尺寸');
    let totalHeight = 0;
    let maxWidth = 0;
    elementsToCapture.forEach(el => {
        const rect = el.getBoundingClientRect();
        totalHeight += rect.height;
        if (el.clientWidth > maxWidth) maxWidth = el.clientWidth;
    });
    const messageMargin = elementsToCapture.length > 1 ? 5 : 0;
    totalHeight += (elementsToCapture.length - 1) * messageMargin;
    const finalWidth = maxWidth * scale;
    const finalHeight = totalHeight * scale;
    captureLogger.info(`计算出的最终尺寸: ${finalWidth / scale}x${totalHeight} (scaled: ${finalWidth}x${finalHeight})`);
    calcStart();

    const bgPrepStart = timer('2. 准备背景');
    const unitBgCanvas = await createUnitBackgroundAsync(scale); // 调用优化后的函数
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = finalWidth;
    finalCanvas.height = finalHeight;
    const finalCtx = finalCanvas.getContext('2d');
    
    // 步骤 1: 绘制平铺背景图
    const pattern = finalCtx.createPattern(unitBgCanvas, 'repeat-y');
    finalCtx.fillStyle = pattern;
    finalCtx.fillRect(0, 0, finalWidth, finalHeight);
    bgPrepStart();

    // --- 新增：在整个长截图上应用 #chat 的背景色 ---
    const chatElement = document.querySelector(config.chatContentSelector);
    if (chatElement) {
        const chatBgColor = window.getComputedStyle(chatElement).backgroundColor;
        // 只有在背景色不是完全透明时才绘制
        if (chatBgColor && chatBgColor !== 'rgba(0, 0, 0, 0)') {
            captureLogger.info(`正在为长截图应用 #chat 背景色: ${chatBgColor}`);
            finalCtx.fillStyle = chatBgColor;
            finalCtx.fillRect(0, 0, finalWidth, finalHeight);
        }
    }
    // --- 新增结束 ---
    
    const stitchStart = timer('3. 拼接前景');

    // === CONTEXT REUSE + DIRECT CANVAS RENDERING ===
    const lib = window.modernScreenshot;
    // 第一次创建 Context，关闭 autoDestruct，后续循环复用
    const context = await lib.createContext(elementsToCapture[0], {
        scale,
        font: false,
        includeStyleProperties: STYLE_WHITELIST_ARRAY, // 优化2：应用样式白名单
        style: { margin: '0' },
        features: { restoreScrollPosition: true },
        // 复用原 onCreateForeignObjectSvg 回调
        onCreateForeignObjectSvg: (svg) => {
                const quoteFixCss = 'q::before, q::after { content: none !important; }';
				
                // --- 新增：最终的换行与布局修复方案 ---
                const layoutFixCss = `
                    /* 方案A：强制代码块正确换行，这是解决您问题的核心 */
                    pre {
                        white-space: pre-wrap !important; /* 允许长代码行在容器边界处自动换行 */
                        word-break: break-all !important; /* 允许在任意字符间断行，对付超长无空格字符串，确保不溢出 */
                        overflow-wrap: break-word !important; /* 另一个强制换行的属性，增加兼容性 */
                    }

                    /* 方案B：语义修复，保证名字本身不换行 */
                    .name_text { 
                        white-space: nowrap !important; 
                    }

                    /* 方案C：物理修复，为父容器提供微小的“收缩”缓冲区，解决亚像素渲染差异 */
                    .ch_name { 
                        letter-spacing: -0.5px !important; 
                    }
				`;

                const finalCss = combinedCss + '\n' + quoteFixCss + '\n' + layoutFixCss;

                if (finalCss) {
                    const styleElement = document.createElement('style');
                    styleElement.textContent = finalCss;
                    let defs = svg.querySelector('defs');
                    if (!defs) { defs = document.createElement('defs'); svg.prepend(defs); }
                    defs.appendChild(styleElement);
                }
            },
        workerUrl: `/scripts/extensions/third-party/${PLUGIN_ID}/worker.js`,
        autoDestruct: false,
    });

    let currentY = 0;
    for (const element of elementsToCapture) {
        captureLogger.info(`正在处理消息: ${element.getAttribute('mesid') || '未知ID'}`);
        const rect = element.getBoundingClientRect();
        // 切换 Context 的节点和尺寸
        context.node   = element;
        context.width  = rect.width;
        context.height = rect.height;
        // 直接拿 Canvas，不再经过 toDataURL→Image
        const sectionCanvas = await lib.domToCanvas(context);
        const offsetX = (finalWidth - sectionCanvas.width) / 2;
        finalCtx.drawImage(sectionCanvas, offsetX, currentY);
        currentY += rect.height * scale + messageMargin * scale;
    }
    // 用完手动销毁
    lib.destroyContext(context);
    stitchStart();
    const exportStart = timer('4. 导出最终图像');
    const finalDataUrl = finalCanvas.toDataURL(settings.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png', settings.imageQuality);
    exportStart();
    mainProcessStart();
    return finalDataUrl;
}

// --- 主截图函数 (单消息，精确裁剪模式) ---
async function captureElementWithModernLib(elementToCapture) {
    const timer = (label, start = performance.now()) => () => captureLogger.info(`⏱️ [主流程耗时] ${label}: ${(performance.now() - start).toFixed(2)} ms`);
    captureLogger.info('截图流程开始 (精确裁剪模式)');
    const mainProcessStart = timer('总流程');

    try {
        const resourcePrepStart = timer('1. 字体与截图选项准备');
        
        // --- 修改：使用新的FontManager ---
        const [customFontCss, faCss] = await Promise.all([
            fontManager.getCurrentThemeFontCssAsync(),
            getFontAwesomeCssAsync(),
        ]);
        const combinedCss = `${customFontCss}\n${faCss}`;
        // --- 修改结束 ---

        const settings = getPluginSettings();
        resourcePrepStart();

        const messageRenderStart = timer('2. 消息截图 (modern-screenshot)');
        
        const libOptions = {
            scale: settings.screenshotScale,
            font: false,
			debug: true, 
            includeStyleProperties: STYLE_WHITELIST_ARRAY, // 优化2：应用样式白名单
            style: {
                margin: '0',
            },
            features: {
                restoreScrollPosition: true,
            },
            onCreateForeignObjectSvg: (svg) => {
                const quoteFixCss = 'q::before, q::after { content: none !important; }';
				
                const layoutFixCss = `
                    pre {
                        white-space: pre-wrap !important;
                        word-break: break-all !important;
                        overflow-wrap: break-word !important;
                    }
                    .name_text { 
                        white-space: nowrap !important; 
                    }
                    .ch_name { 
                        letter-spacing: -0.5px !important; 
                    }
				`;

                const finalCss = combinedCss + '\n' + quoteFixCss + '\n' + layoutFixCss;

                if (finalCss) {
                    const styleElement = document.createElement('style');
                    styleElement.textContent = finalCss;
                    let defs = svg.querySelector('defs');
                    if (!defs) { defs = document.createElement('defs'); svg.prepend(defs); }
                    defs.appendChild(styleElement);
                }
            },
            debug: settings.debugOverlay,
            workerUrl: `/scripts/extensions/third-party/${PLUGIN_ID}/worker.js`,
        };

        const messageDataUrl = await window.modernScreenshot.domToDataUrl(elementToCapture, libOptions);
        messageRenderStart();

        const compositionStart = timer('3. 加载前景图并启动合成');
        const foregroundImg = await loadImage(messageDataUrl);
        compositionStart();

        const finalCanvas = await createCompositeCanvas(foregroundImg, elementToCapture);
        
        const exportStart = timer('4. 导出最终图像');
        const finalDataUrl = finalCanvas.toDataURL(settings.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png', settings.imageQuality);
        exportStart();

        mainProcessStart();
        return finalDataUrl;
    } catch (error) {
        captureLogger.error('截图主流程失败:', error);
        throw error;
    }
}


// --- 插件初始化与UI ---

async function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) return resolve();
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`脚本加载失败: ${src}`));
        document.head.appendChild(script);
    });
}

function getPluginSettings() {
    extension_settings[PLUGIN_ID] = extension_settings[PLUGIN_ID] || {};
    return { ...defaultSettings, ...extension_settings[PLUGIN_ID] };
}

function initLongScreenshotUI() {
    $('#long_screenshot_start_button, #long_screenshot_capture_button, #long_screenshot_cancel_button').remove();
    const startButton = $('<div id="long_screenshot_start_button" class="menu_button"><i class="fa-solid fa-scroll"></i><span class="menu_button_text"> 长截图</span></div>');
    $('#chat_menu_buttons').append(startButton);
    startButton.on('click', () => {
        $('body').addClass('long-screenshot-selecting');
        $('#chat .mes').addClass('selectable-message');
        startButton.hide();
        const captureButton = $('<div id="long_screenshot_capture_button" class="menu_button"><i class="fa-solid fa-camera"></i><span class="menu_button_text"> 截取</span></div>');
        const cancelButton = $('<div id="long_screenshot_cancel_button" class="menu_button"><i class="fa-solid fa-times"></i><span class="menu_button_text"> 取消</span></div>');
        $('#chat_menu_buttons').append(captureButton, cancelButton);
        cancelButton.on('click', () => {
            $('body').removeClass('long-screenshot-selecting');
            $('#chat .mes').removeClass('selectable-message selected-for-screenshot');
            captureButton.remove();
            cancelButton.remove();
            startButton.show();
        });
        captureButton.on('click', async () => {
            const selectedElements = Array.from(document.querySelectorAll('.selected-for-screenshot'));
            if (selectedElements.length === 0) {
                toastr.warning("请至少选择一条消息。");
                return;
            }
            selectedElements.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
            const icon = captureButton.find('i');
            const originalClass = icon.attr('class');
            icon.attr('class', 'fa-solid fa-spinner fa-spin');
            try {
                const dataUrl = await captureLongScreenshot(selectedElements);
                const link = document.createElement('a');
                const extension = dataUrl.substring('data:image/'.length, dataUrl.indexOf(';'));
                link.download = `SillyTavern_Long_${new Date().toISOString().replace(/[:.T-]/g, '').slice(0, 14)}.${extension}`;
                link.href = dataUrl;
                link.click();
            } catch (error) {
                captureLogger.error('长截图失败:', error);
                toastr.error("长截图失败，请查看控制台获取更多信息。");
            } finally {
                icon.attr('class', originalClass);
                cancelButton.trigger('click');
            }
        });
    });
    $(document).on('click', '.selectable-message', function() { $(this).toggleClass('selected-for-screenshot'); });
    const styles = `
        .long-screenshot-selecting #chat { cursor: pointer; }
        .selectable-message { transition: background-color 0.2s; }
        .selected-for-screenshot { background-color: rgba(0, 150, 255, 0.3) !important; }
    `;
    $('head').append(`<style>${styles}</style>`);
}

function addScreenshotButtonToMessage(messageElement) {
    if (!messageElement || typeof messageElement.querySelector !== 'function' || messageElement.querySelector(`.${config.buttonClass}`)) return;
    const buttonsContainer = messageElement.querySelector('.mes_block .mes_buttons');
    if (!buttonsContainer) return;
    const screenshotButton = document.createElement('div');
    screenshotButton.innerHTML = '<i class="fa-solid fa-camera"></i>';
    screenshotButton.className = `${config.buttonClass} mes_button interactable`;
    screenshotButton.title = '点击截图';
    Object.assign(screenshotButton.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
    });
    screenshotButton.addEventListener('click', async (event) => {
        event.preventDefault(); event.stopPropagation();
        if (screenshotButton.classList.contains('loading')) return;
        const icon = screenshotButton.querySelector('i');
        const originalClass = icon.className;
        icon.className = 'fa-solid fa-spinner fa-spin';
        screenshotButton.classList.add('loading');
        try {
            const chatContainer = document.querySelector(config.chatContentSelector);
            const formSheld = document.querySelector('#form_sheld');
            const messageHeight = messageElement.getBoundingClientRect().height;
            const unitHeight = chatContainer.clientHeight - (formSheld ? formSheld.offsetHeight : 0);
            
            let dataUrl;
            if (messageHeight > unitHeight) {
                captureLogger.info('消息高度大于单位高度，执行长截图（平铺背景）模式...');
                dataUrl = await captureLongScreenshot([messageElement]);
            } else {
                captureLogger.info('消息高度小于等于单位高度，执行单消息（精确裁剪）模式...');
                dataUrl = await captureElementWithModernLib(messageElement);
            }

            const link = document.createElement('a');
            const extension = dataUrl.substring('data:image/'.length, dataUrl.indexOf(';'));
            link.download = `SillyTavern_${new Date().toISOString().replace(/[:.T-]/g, '').slice(0, 14)}.${extension}`;
            link.href = dataUrl;
            link.click();

        } catch (error) {
            captureLogger.error('消息截图失败:', error);
            toastr.error('截图失败，请查看控制台获取更多信息。');
        } finally {
            icon.className = originalClass;
            screenshotButton.classList.remove('loading');
        }
    });
    const extraButtonsContainer = buttonsContainer.querySelector('.extraMesButtons');

    if (extraButtonsContainer) {
        buttonsContainer.insertBefore(screenshotButton, extraButtonsContainer);
    } else {
        buttonsContainer.appendChild(screenshotButton);
	}
}

function installScreenshotButtons() {
    document.querySelectorAll(`.${config.buttonClass}`).forEach(btn => btn.remove());
    const chatContentEl = document.querySelector(config.chatContentSelector);
    if (!chatContentEl) {
        captureLogger.warn('未找到聊天容器，1秒后重试...');
        setTimeout(installScreenshotButtons, 1000);
        return;
    }
    chatContentEl.querySelectorAll(config.messageSelector).forEach(addScreenshotButtonToMessage);
    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) {
                    if (node.matches(config.messageSelector)) {
                        addScreenshotButtonToMessage(node);
                    } else if (typeof node.querySelectorAll === 'function') {
                        node.querySelectorAll(config.messageSelector).forEach(addScreenshotButtonToMessage);
                    }
                }
            }
        }
    });
    observer.observe(chatContentEl, { childList: true, subtree: true });
}

jQuery(async () => {
    try {
        captureLogger.info('插件初始化...');
        const libPromise = loadScript(`/scripts/extensions/third-party/${PLUGIN_ID}/modern-screenshot.umd.js`);
        
        // --- 修改：初始化新的FontManager ---
        fontManager.init().catch(err => captureLogger.error("字体管理器初始化失败:", err));
        // --- 修改结束 ---

        await libPromise;
        if (!window.modernScreenshot?.domToDataUrl) throw new Error('Modern Screenshot 库加载失败！');
        window.domToDataUrl = window.modernScreenshot.domToDataUrl;
        let settingsHtml = '';
        try {
            settingsHtml = await renderExtensionTemplateAsync(`third-party/${PLUGIN_ID}`, 'settings');
        } catch (ex) {
            captureLogger.error('加载设置模板失败, 使用备用模板。', ex);
            settingsHtml = `<div id="${PLUGIN_ID}-settings"><h2>${PLUGIN_NAME} Settings</h2><p>Failed to load settings panel.</p></div>`;
        }
        $('#extensions_settings_content').append(settingsHtml);
        const settings = getPluginSettings();
        const settingsForm = $('#extensions_settings_content');
        settingsForm.find('#st_h2c_screenshotScale').val(settings.screenshotScale);
        settingsForm.find('#st_h2c_imageFormat').val(settings.imageFormat);
        settingsForm.find('#st_h2c_imageQuality').val(settings.imageQuality).prop('disabled', settings.imageFormat !== 'jpeg');
        settingsForm.find('#st_h2c_autoInstallButtons').prop('checked', settings.autoInstallButtons);
        settingsForm.find('#st_h2c_debugOverlay').prop('checked', settings.debugOverlay);
        settingsForm.on('change', 'select, input', () => {
            invalidateUnitBackgroundCache(); // --- 优化1：当任何设置改变时，使缓存失效 ---
            const newSettings = {
                screenshotScale: parseFloat(settingsForm.find('#st_h2c_screenshotScale').val()) || defaultSettings.screenshotScale,
                imageFormat: settingsForm.find('#st_h2c_imageFormat').val(),
                imageQuality: parseFloat(settingsForm.find('#st_h2c_imageQuality').val()) || defaultSettings.imageQuality,
                autoInstallButtons: settingsForm.find('#st_h2c_autoInstallButtons').prop('checked'),
                debugOverlay: settingsForm.find('#st_h2c_debugOverlay').prop('checked'),
            };
            extension_settings[PLUGIN_ID] = newSettings;
            saveSettingsDebounced();
            settingsForm.find('#st_h2c_imageQuality').prop('disabled', newSettings.imageFormat !== 'jpeg');
            if (newSettings.autoInstallButtons) {
                installScreenshotButtons();
            } else {
                document.querySelectorAll(`.${config.buttonClass}`).forEach(btn => btn.remove());
            }
        });
        if (settings.autoInstallButtons) {
            installScreenshotButtons();
        }
        initLongScreenshotUI();

        // --- 优化1：设置ResizeObserver以自动使背景缓存失效 ---
        const chatContainer = document.querySelector(config.chatContentSelector);
        if (chatContainer) {
            const resizeObserver = new ResizeObserver(() => {
                captureLogger.info('检测到窗口/容器尺寸变化。');
                invalidateUnitBackgroundCache();
            });
            resizeObserver.observe(chatContainer);
        }

        captureLogger.info('插件初始化完成。');
    } catch (error) {
        captureLogger.error('插件初始化过程中发生严重错误:', error);
    }
});