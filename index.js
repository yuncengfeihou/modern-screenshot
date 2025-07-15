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

// --- 字体处理核心 ---
let FONT_MAPPING = null;
let FONT_MAP_PREPARATION_PROMISE = null;

async function prepareFontMappingAsync() {
    if (FONT_MAP_PREPARATION_PROMISE) return FONT_MAP_PREPARATION_PROMISE;
    const promise = (async () => {
        captureLogger.info('开始构建字体映射表...');
        const styleElement = document.querySelector('#custom-style');
        if (!styleElement) { FONT_MAPPING = {}; return; }
        const rawCss = styleElement.textContent || '';
        const importMatch = /@import\s+url\((['"]?)(.*?)\1\);/g.exec(rawCss);
        if (!importMatch) { FONT_MAPPING = {}; return; }
        try {
            const cssUrl = importMatch[2];
            const cssContent = await fetch(cssUrl).then(res => res.text());
            const fontFaceRegex = /@font-face\s*{([^}]*)}/g;
            const unicodeRangeRegex = /unicode-range:\s*([^;]*);/;
            const urlRegex = /url\((['"]?)(.*?)\1\)/;
            const mapping = {};
            let match;
            while ((match = fontFaceRegex.exec(cssContent)) !== null) {
                const fontFaceBlock = match[1];
                const unicodeRangeMatch = fontFaceBlock.match(unicodeRangeRegex);
                const urlMatch = fontFaceBlock.match(urlRegex);
                if (unicodeRangeMatch && urlMatch) {
                    const ranges = unicodeRangeMatch[1];
                    const fontFileUrl = new URL(urlMatch[2], cssUrl).href;
                    ranges.split(',').forEach(range => {
                        range = range.trim().substring(2);
                        if (range.includes('-')) {
                            const [start, end] = range.split('-').map(hex => parseInt(hex, 16));
                            for (let i = start; i <= end; i++) { mapping[i] = fontFileUrl; }
                        } else {
                            mapping[parseInt(range, 16)] = fontFileUrl;
                        }
                    });
                }
            }
            FONT_MAPPING = mapping;
            captureLogger.info(`字体映射表构建完成！`);
        } catch (error) {
            captureLogger.error('构建字体映射表失败:', error);
            FONT_MAPPING = {};
        }
    })();
    FONT_MAP_PREPARATION_PROMISE = promise;
    return promise;
}

// --- 字体数据缓存 ---
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

async function getSubsettedFontCssAsync(text) {
    if (!FONT_MAPPING || Object.keys(FONT_MAPPING).length === 0) return '';

    const requiredFontUrls = new Set();
    for (const char of text) {
        const charCode = char.charCodeAt(0);
        if (FONT_MAPPING[charCode]) {
            requiredFontUrls.add(FONT_MAPPING[charCode]);
        }
    }

    if (requiredFontUrls.size === 0) return '';

    // --- 字体缓存逻辑 ---
    const urlsToFetch = [];
    const cachedDataUrls = [];
    for (const url of requiredFontUrls) {
        if (FONT_DATA_CACHE.has(url)) {
            cachedDataUrls.push({ url, dataUrl: FONT_DATA_CACHE.get(url) });
        } else {
            urlsToFetch.push(url);
        }
    }

    let fetchedFontData = [];
    if (urlsToFetch.length > 0) {
        captureLogger.info(`文本需要 ${requiredFontUrls.size} 个字体分片，其中 ${urlsToFetch.length} 个需下载，${cachedDataUrls.length} 个已缓存。`);
        const fontPromises = urlsToFetch.map(url =>
            fetch(url)
                .then(res => res.blob())
                .then(blob => new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        // 请求成功后，存入缓存
                        FONT_DATA_CACHE.set(url, reader.result);
                        resolve({ url, dataUrl: reader.result });
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                }))
        );
        fetchedFontData = await Promise.all(fontPromises);
    } else {
        captureLogger.info(`文本需要 ${requiredFontUrls.size} 个字体分片，全部命中缓存！`);
    }

    const allFontData = [...cachedDataUrls, ...fetchedFontData];
    const urlToDataUrlMap = new Map(allFontData.map(d => [d.url, d.dataUrl]));
    // --- 缓存逻辑结束 ---

    // 后续逻辑与之前相同
    const styleElement = document.querySelector('#custom-style');
    const rawCss = styleElement?.textContent || '';
    const importMatch = /@import\s+url\((['"]?)(.*?)\1\);/.exec(rawCss);
    if (!importMatch) return '';
    const cssUrl = importMatch[2];
    const cssContent = await fetch(cssUrl).then(res => res.text());
    const fontFaceRegex = /@font-face\s*{[^}]*}/g;
    const requiredCssRules = [];
    let match;
    while ((match = fontFaceRegex.exec(cssContent)) !== null) {
        const rule = match[0];
        const urlMatch = /url\((['"]?)(.*?)\1\)/.exec(rule);
        if (urlMatch) {
            const fontFileUrl = new URL(urlMatch[2], cssUrl).href;
            if (urlToDataUrlMap.has(fontFileUrl)) {
                requiredCssRules.push(rule.replace(urlMatch[0], `url("${urlToDataUrlMap.get(fontFileUrl)}")`));
            }
        }
    }
    const finalCss = requiredCssRules.join('\n');
    captureLogger.info(`已生成 ${requiredCssRules.length} 条内联@font-face规则。`);
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
            includeStyleProperties: STYLE_WHITELIST_ARRAY,
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
    const allTextContent = elementsToCapture.map(el => el.textContent || '').join('');
    
    const [subsettedCss, faCss] = await Promise.all([
        getSubsettedFontCssAsync(allTextContent),
        getFontAwesomeCssAsync(),
    ]);
    const combinedCss = `${subsettedCss}\n${faCss}`;
    
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
    const unitBgCanvas = await createUnitBackgroundAsync(scale);
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
    let currentY = 0;
    for (const element of elementsToCapture) {
        captureLogger.info(`正在处理消息: ${element.getAttribute('mesid') || '未知ID'}`);
        
        const foregroundDataUrl = await window.domToDataUrl(element, {
            scale: scale,
            font: false,
            includeStyleProperties: STYLE_WHITELIST_ARRAY,
			style: {
				margin: '0',
			},
            onCreateForeignObjectSvg: (svg) => {
                const quoteFixCss = 'q::before, q::after { content: none !important; }';
				
                const layoutFixCss = `
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
            workerUrl: `/scripts/extensions/third-party/${PLUGIN_ID}/worker.js`,
        });
        const foregroundImg = await loadImage(foregroundDataUrl);
        const offsetX = (finalWidth - foregroundImg.width) / 2;
        finalCtx.drawImage(foregroundImg, offsetX, currentY);
        currentY += element.getBoundingClientRect().height * scale;
        if (elementsToCapture.length > 1) {
            currentY += messageMargin * scale;
        }
    }
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
    try {
        const resourcePrepStart = timer('1. 字体与截图选项准备');
        await prepareFontMappingAsync();
        const textContent = elementToCapture.textContent || '';
        
        // --- 修改：同时获取聊天字体和 Font Awesome 字体 ---
        const [subsettedCss, faCss] = await Promise.all([
            getSubsettedFontCssAsync(textContent),
            getFontAwesomeCssAsync(), // 调用新函数
        ]);
        const combinedCss = `${subsettedCss}\n${faCss}`;
        // --- 修改结束 ---

        const settings = getPluginSettings();
        resourcePrepStart();
        const messageRenderStart = timer('2. 消息截图 (modern-screenshot)');
        
        // --- 优化2：应用样式白名单 ---
        const libOptions = {
            scale: settings.screenshotScale,
            font: false,
            includeStyleProperties: STYLE_WHITELIST_ARRAY, // 应用白名单
			style: {
				margin: '0',
			},
            onCreateForeignObjectSvg: (svg) => {
                const quoteFixCss = 'q::before, q::after { content: none !important; }';
				
                // --- 新增：最终的换行修复方案 ---
                const layoutFixCss = `
                    /* 方案A的语义修复：保证名字本身不换行 */
                    .name_text { 
                        white-space: nowrap !important; 
                    }
                    /* 方案B的物理修复：为父容器提供微小的“收缩”缓冲区，解决像素渲染差异 */
                    .ch_name { 
                        letter-spacing: -0.5px !important; 
                    }
				`;
                
                // --- 修改：使用合并后的CSS ---
                const finalCss = combinedCss + '\n' + quoteFixCss + '\n' + layoutFixCss;
                // --- 修改结束 ---
                
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
        const messageDataUrl = await window.domToDataUrl(elementToCapture, libOptions);
        messageRenderStart();
        const compositionStart = timer('3. 加载前景图并启动合成');
        return await new Promise((resolve, reject) => {
            const foregroundImg = new Image();
            foregroundImg.onload = async () => {
                try {
                    const finalCanvas = await createCompositeCanvas(foregroundImg, elementToCapture);
                    const exportStart = timer('4. 导出最终图像');
                    const finalDataUrl = finalCanvas.toDataURL(settings.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png', settings.imageQuality);
                    exportStart();
                    resolve(finalDataUrl);
                } catch (e) { reject(e); }
            };
            foregroundImg.onerror = () => reject(new Error('前景图(消息截图)加载失败'));
            foregroundImg.src = messageDataUrl;
            compositionStart();
        });
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
        display: 'flex',          // 使其成为flex容器
        alignItems: 'center',     // 垂直居中其内部的图标
        justifyContent: 'center', // 水平居中其内部的图标
        cursor: 'pointer',        // 确保鼠标指针是手型
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
        // 2. 如果找到了这个容器，就将截图按钮插入到它的前面。
        //    这能保证截图按钮在“编辑”之后，在“复制”等按钮之前。
        buttonsContainer.insertBefore(screenshotButton, extraButtonsContainer);
    } else {
        // 3. 作为备用方案，如果 .extraMesButtons 不存在（可能是旧版或特殊消息类型），
        //    我们回退到将按钮安全地追加到末尾，避免任何错误。
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
        prepareFontMappingAsync().catch(err => captureLogger.error("字体映射表预处理失败:", err));
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