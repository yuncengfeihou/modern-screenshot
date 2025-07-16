self.onmessage = async (event) => {
    const { type, cssUrl } = event.data;

    if (type !== 'DOWNLOAD_FONT') {
        return;
    }

    try {
        // 1. 获取包含 @font-face 规则的 CSS 文件
        const cssContent = await fetch(cssUrl).then(res => {
            if (!res.ok) throw new Error(`无法获取字体CSS: ${res.status} ${res.statusText}`);
            return res.text();
        });

        // 2. 从 CSS 中解析出 @font-face 规则和字体文件 URL
        const fontFaceRegex = /@font-face\s*{([^}]*)}/g;
        const fontFaceMatch = fontFaceRegex.exec(cssContent);
        if (!fontFaceMatch) {
            throw new Error('在CSS中未找到 @font-face 规则。');
        }
        
        const fontFaceBlock = fontFaceMatch[1];
        const urlRegex = /url\((['"]?)(.*?)\1\)/;
        const urlMatch = fontFaceBlock.match(urlRegex);
        if (!urlMatch) {
            throw new Error('在@font-face规则中未找到字体文件的URL。');
        }

        const fontFileUrl = new URL(urlMatch[2], cssUrl).href;
        const originalCssRule = `@font-face {${fontFaceBlock}}`;
        const originalUrlToken = urlMatch[0]; // 完整的 url(...)

        // 3. 下载完整的字体文件
        const fontBlob = await fetch(fontFileUrl).then(res => {
            if (!res.ok) throw new Error(`无法下载字体文件: ${res.status} ${res.statusText}`);
            return res.blob();
        });

        // 4. 将字体 Blob 转换为 DataURL
        const fontDataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(fontBlob);
        });

        // 5. 将处理好的数据发送回主线程
        self.postMessage({
            status: 'success',
            payload: {
                cssUrl: cssUrl,
                fontFaceCss: originalCssRule.replace(originalUrlToken, `url("${fontDataUrl}")`),
            },
        });

    } catch (error) {
        self.postMessage({
            status: 'error',
            payload: {
                cssUrl: cssUrl,
                message: error.message,
            },
        });
    }
};