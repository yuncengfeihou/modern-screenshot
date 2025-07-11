// index.js (V18.1 - The Final Cleaned Version)

// --- START OF FILE ---

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
        console[level](`[${PLUGIN_NAME}] ${message}`, data || '');
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

// --- 字体处理核心 ---
let FONT_MAPPING = null;
let FONT_MAP_PREPARATION_PROMISE = null;

async function prepareFontMappingAsync() {
    if (FONT_MAP_PREPARATION_PROMISE) return FONT_MAP_PREPARATION_PROMISE;
    const promise = (async () => {
        captureLogger.info('开始构建字体映射表...');
        const styleElement = document.querySelector('#custom-style');
        if (!styleElement) {
            FONT_MAPPING = {};
            return;
        }
        const rawCss = styleElement.textContent || '';
        const importMatch = /@import\s+url\((['"]?)(.*?)\1\);/g.exec(rawCss);
        if (!importMatch) {
            FONT_MAPPING = {};
            return;
        }
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
    captureLogger.info(`文本需要 ${requiredFontUrls.size} 个字体分片，开始按需下载...`);
    const fontPromises = Array.from(requiredFontUrls).map(url =>
        fetch(url).then(res => res.blob()).then(blob => new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve({ url, dataUrl: reader.result });
            reader.readAsDataURL(blob);
        }))
    );
    const fontData = await Promise.all(fontPromises);
    const urlToDataUrlMap = new Map(fontData.map(d => [d.url, d.dataUrl]));
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

// --- 背景处理核心 ---
function findBackgroundElement() {
    const selectors = ['#bg_animation_container > div[id^="bg"]', '#background > div[id^="bg"]', '#bg1'];
    for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el && window.getComputedStyle(el).display !== 'none') return el;
    }
    return document.querySelector(config.chatContentSelector);
}

async function createBackgroundCanvas(backgroundStyle, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取Canvas 2D上下文');
    ctx.fillStyle = backgroundStyle.backgroundColor || '#1e1e1e';
    ctx.fillRect(0, 0, width, height);
    const bgMatch = backgroundStyle.backgroundImage.match(/url\((['"]?)(.*?)\1\)/);
    if (bgMatch && bgMatch[2]) {
        try {
            const bgUrl = new URL(bgMatch[2], window.location.href).href;
            const backgroundImg = await new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('背景图加载失败'));
                img.src = bgUrl;
            });
            const bgAspect = backgroundImg.width / backgroundImg.height;
            const canvasAspect = width / height;
            let sx, sy, sWidth, sHeight;
            if (bgAspect > canvasAspect) {
                sHeight = backgroundImg.height; sWidth = sHeight * canvasAspect;
                sx = (backgroundImg.width - sWidth) / 2; sy = 0;
            } else {
                sWidth = backgroundImg.width; sHeight = sWidth / canvasAspect;
                sx = 0; sy = (backgroundImg.height - sHeight) / 2;
            }
            ctx.drawImage(backgroundImg, sx, sy, sWidth, sHeight, 0, 0, width, height);
        } catch (e) {
            captureLogger.error('绘制背景图失败', e);
        }
    }
    return canvas;
}

// --- 主截图函数 ---
async function captureElementWithModernLib(elementToCapture) {
    captureLogger.info('截图流程开始 (V18.1)');
    try {
        await prepareFontMappingAsync();
        const textContent = elementToCapture.textContent || '';
        const subsettedCss = await getSubsettedFontCssAsync(textContent);
        const settings = getPluginSettings();
        const libOptions = {
            scale: settings.screenshotScale,
            backgroundColor: null,
            font: false,
            onCreateForeignObjectSvg: (svg) => {
                if (subsettedCss) {
                    const styleElement = document.createElement('style');
                    styleElement.textContent = subsettedCss;
                    let defs = svg.querySelector('defs');
                    if (!defs) { defs = document.createElement('defs'); svg.prepend(defs); }
                    defs.appendChild(styleElement);
                }
            },
            debug: settings.debugOverlay,
            workerUrl: `/scripts/extensions/third-party/${PLUGIN_ID}/worker.js`,
        };
        const messageDataUrl = await window.domToDataUrl(elementToCapture, libOptions);
        const backgroundElement = findBackgroundElement();
        if (backgroundElement) {
            captureLogger.info('检测到背景，开始后期合成...');
            const backgroundStyle = window.getComputedStyle(backgroundElement);
            return await new Promise((resolve, reject) => {
                const foregroundImg = new Image();
                foregroundImg.onload = async () => {
                    try {
                        const scale = settings.screenshotScale;
                        const padding = 40 * scale;
                        const finalWidth = foregroundImg.width + padding * 2;
                        const finalHeight = foregroundImg.height + padding * 2;
                        const backgroundCanvas = await createBackgroundCanvas(backgroundStyle, finalWidth, finalHeight);
                        const finalCtx = backgroundCanvas.getContext('2d');
                        finalCtx.drawImage(foregroundImg, padding, padding);
                        resolve(backgroundCanvas.toDataURL(settings.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png', settings.imageQuality));
                    } catch (e) {
                        reject(e);
                    }
                };
                foregroundImg.onerror = () => reject(new Error('前景图加载失败'));
                foregroundImg.src = messageDataUrl;
            });
        }
        return messageDataUrl;
    } catch (error) {
        captureLogger.error('截图失败:', error);
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

function addScreenshotButtonToMessage(messageElement) {
    if (!messageElement || typeof messageElement.querySelector !== 'function' || messageElement.querySelector(`.${config.buttonClass}`)) return;
    const buttonsContainer = messageElement.querySelector('.mes_block .mes_buttons');
    if (!buttonsContainer) return;
    const screenshotButton = document.createElement('div');
    screenshotButton.innerHTML = '<i class="fa-solid fa-camera"></i>';
    screenshotButton.className = `${config.buttonClass} mes_button interactable`;
    screenshotButton.title = '截图此消息';
    screenshotButton.addEventListener('click', async (event) => {
        event.preventDefault(); event.stopPropagation();
        if (screenshotButton.classList.contains('loading')) return;
        const icon = screenshotButton.querySelector('i');
        const originalClass = icon.className;
        icon.className = 'fa-solid fa-spinner fa-spin';
        screenshotButton.classList.add('loading');
        try {
            const dataUrl = await captureElementWithModernLib(messageElement);
            const link = document.createElement('a');
            const extension = dataUrl.substring('data:image/'.length, dataUrl.indexOf(';'));
            link.download = `SillyTavern_${new Date().toISOString().replace(/[:.T-]/g, '').slice(0, 14)}.${extension}`;
            link.href = dataUrl;
            link.click();
        } catch (error) {
            captureLogger.error('消息截图失败:', error);
        } finally {
            icon.className = originalClass;
            screenshotButton.classList.remove('loading');
        }
    });
    buttonsContainer.appendChild(screenshotButton);
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
        captureLogger.info('插件初始化完成。');
    } catch (error) {
        captureLogger.error('插件初始化过程中发生严重错误:', error);
    }
});

// --- END OF FILE ---