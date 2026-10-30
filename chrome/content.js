(function (window, document, undefined) {
    'use strict';

    // ==========================================================================
    // [Module] core/constants.js
    // ==========================================================================

    const STORAGE_DEFAULTS = { enable_extension: true };
    const FeatureSet = { ...STORAGE_DEFAULTS };

    const CONFIG = {
        LANG: 'zh-CN',
        // 站点域名 -> 类型映射
        PAGE_MAP: {
            'gist.github.com': 'gist',
            'www.githubstatus.com': 'status',
            'skills.github.com': 'skills',
            'education.github.com': 'education'
        },
        // 需要特殊处理的站点类型
        SPECIAL_SITES: ['gist', 'status', 'skills', 'education'],
        OBSERVER_CONFIG: {
            childList: true,
            subtree: true,
            characterData: true,
            attributeFilter: ['value', 'placeholder', 'aria-label', 'data-confirm']
        }
    };

    let pageConfig = {};
    let scheduleReactGlobalNavRefresh = () => {};
    let refreshPageObserver = () => {};
    let historyRefreshTimer = null;

    // ==========================================================================
    // [Module] core/text-filter.js
    // ==========================================================================

    function shouldSkipReadmeText(text) {
        if (!text) return true;
        if (text.length > 2000) return true;
        if (isMostlyCjkText(text)) return true;
        if (/^[0-9\s.,:;()\[\]{}+\-/*#@_`~!$%^&|<>="'\\]+$/.test(text)) return true;
        if (!/[A-Za-z]/.test(text)) return true;
        if (/[\u3400-\u9FFF]/.test(text) && !/[A-Za-z]{2,}/.test(text)) return true;
        return false;
    }

    function isLikelyTechnicalReadmeText(text, node = null) {
        const input = String(text || '').trim();
        const element = node?.parentElement;
        if (element?.closest('pre, code, kbd, samp, button, .snippet-clipboard-content')) {
            return true;
        }
        if (!input) return false;

        // 参数说明列表/表格中的单词键名（如 slug、tags、title、content）应保持原文，
        // 模型通常会原样返回，不能因此把 README 判为部分完成。
        if (/^[a-z][a-z0-9_-]{1,24}$/.test(input) && element?.closest('li, dt, table')) {
            return true;
        }

        // 有些 README 会把命令放在普通 p/div/span 中，不能只依赖 pre/code 标签判断。
        if (/^(?:[$>#]\s*)?(?:npm|pnpm|yarn|bun|node|python(?:3)?|pip(?:3)?|uv|go|cargo|docker(?:\s+compose)?|podman|kubectl|helm|git|gh|curl|wget|make|cmake|brew|apt(?:-get)?|apk|dnf|yum|ssh|chmod|chown|mkdir|cd|export|set)\b(?:\s|$)/i.test(input)
            || /^(?:\.\.?[\\/]|[A-Za-z]:[\\/])/.test(input)) {
            return true;
        }
        if (input.length > 120) return false;
        if (isLikelyOpaqueReadmeLabel(input, node)) return true;

        // 版本号、文件名和纯标识符通常不需要翻译；它们保持原文时不应把整篇 README 判为部分完成。
        if (/^[a-z]+\s+(?:version\s+)?v?\d+(?:\.\d+)+(?:[+._-][A-Za-z0-9]+)?[.!]?$/i.test(input)) {
            return true;
        }
        return false;
    }

    function isLikelyOpaqueReadmeLabel(text, node = null) {
        const input = String(text || '').trim();
        if (!input || input.length > 120 || /[\u3400-\u9FFF]/.test(input)) return false;

        const words = input.split(/\s+/).filter(Boolean);
        if (!words.length || words.length > 8) return false;

        const element = node?.parentElement;
        const isLink = Boolean(element?.closest('a[href]'));
        const isListLabel = Boolean(element?.closest('li, dt, code'));
        const isHeading = Boolean(element?.closest('h1, h2, h3, h4, h5, h6'));
        const isTableLink = isLink && Boolean(element?.closest('table'));
        const titleCaseWords = words.filter((word) => /^[A-Z][A-Za-z0-9]*$/.test(word));
        if (isTableLink && titleCaseWords.length === words.length) return true;

        // 普通句子不能因为首字母大写就被误判为产品名；这些词出现时仍需正常翻译。
        const sentenceWords = new Set([
            'a', 'an', 'and', 'are', 'as', 'at', 'about', 'build', 'by', 'can', 'changelog',
            'community', 'configure', 'contribute', 'contributing', 'documentation', 'download',
            'features', 'for', 'from', 'get', 'getting', 'guide', 'how', 'in', 'install',
            'installation', 'into', 'is', 'it', 'license', 'of', 'on', 'or', 'overview',
            'quick', 'resources', 'roadmap', 'run', 'security', 'start', 'started', 'support',
            'test', 'the', 'this', 'to', 'use', 'usage', 'using', 'with', 'what', 'when',
            'where', 'why',
        ]);
        const normalizedWords = words.map((word) => word.toLowerCase().replace(/^[([{]+|[)\]},.;:!?]+$/g, ''));
        if (normalizedWords.length === 1 && sentenceWords.has(normalizedWords[0])) return false;
        if (normalizedWords.some((word) => sentenceWords.has(word))
            && !/\([A-Z0-9]{2,}\)/.test(input)) return false;

        if (isHeading && words.length >= 2 && document.title.includes(input)) {
            return true;
        }
        const hasOpaquePattern = /[0-9_./+#@:-]/.test(input)
            || /[a-z][A-Z]/.test(input)
            || /\([A-Z0-9]{2,}\)/.test(input)
            || words.some((word) => /^[A-Z0-9]{2,}$/.test(word));
        if (hasOpaquePattern) return true;

        if ((isLink || isListLabel)
            && titleCaseWords.length === words.length
            && (words.some((word) => word.length > 2) || (isLink && words.length === 1 && !sentenceWords.has(normalizedWords[0])))) {
            return true;
        }

        // 外部链接中的单一标识通常是包名/库名/平台名（如 boto、X），而不是自然语言句子。
        return isLink && words.length === 1 && !sentenceWords.has(normalizedWords[0]) && /^[A-Za-z0-9-]+$/.test(input);
    }


    function isMostlyCjkText(text) {
        const input = String(text || '');
        const cjkCount = (input.match(/[\u3400-\u9FFF]/g) || []).length;
        if (!cjkCount) return false;

        const latinCount = (input.match(/[A-Za-z]/g) || []).length;
        if (!latinCount) return true;

        const latinWords = (input.match(/[A-Za-z]{2,}/g) || []).length;
        const cjkPunctuation = (input.match(/[\u3000-\u303F\uFF01-\uFF5E]/g) || []).length;

        // 若中文字符达到 8 个以上，且中文字数明显多于英文词数（技术名词混排常见场景），视为中文
        if (cjkCount >= 8 && cjkCount >= latinWords * 1.5) return true;
        // 中文标点加 6 个以上汉字也是明显的中文语句
        if (cjkCount >= 6 && cjkPunctuation > 0 && cjkCount >= latinWords) return true;

        return cjkCount >= 8 && cjkCount >= latinCount * 0.8;
    }

    function shouldSkipReadmeByLanguage(text, targetLang) {
        if (!/^zh(?:-|$)/i.test(String(targetLang || ''))) return false;

        const input = String(text || '').trim();
        if (input.length < 40) return false;

        const cjkCount = (input.match(/[\u3400-\u9FFF]/g) || []).length;
        if (cjkCount < 12) return false;

        const latinCount = (input.match(/[A-Za-z]/g) || []).length;
        if (!latinCount) return true;

        return cjkCount >= latinCount * 1.5;
    }


    function normalizeText(text) {
        return text.replace(/\xa0|[\s]+/g, ' ').trim();
    }

    /****************** Issue / PR 协作润色助手 ******************/

    // ==========================================================================
    // [Module] core/dom-observer.js
    // ==========================================================================

    // 初始化
    init().catch(err => {
        console.error('初始化失败:', err);
    });

    chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === 'refresh-page') {
            window.location.reload();
        }
    });

    async function loadFeatureSet() {
        const result = await chrome.storage.sync.get(STORAGE_DEFAULTS);
        Object.assign(FeatureSet, result);
    }

    function refreshCurrentPageTranslations() {
        if (!pageConfig.currentPageType || !document.body) return;
        traverseNode(document.body);
        transTitle();
        transBySelector();
        scheduleReactGlobalNavRefresh();
    }

    /**
     * Turbo 软导航后整页/片段可能被替换为未翻译英文，且返回时 react-partial
     * 往往已是 .loaded，hydration watcher 不会再触发。MutationObserver 也可能
     * 输给随后的 React reconcile。因此在 turbo:load 后做短延迟全量扫描。
     */
    function translateTurboSettledDom() {
        if (!FeatureSet.enable_extension || !pageConfig.currentPageType || !document.body) return;
        traverseNode(document.body);
        transTitle();
        transBySelector();
    }

    function scheduleTurboPageTranslation() {
        translateTurboSettledDom();
        scheduleReactGlobalNavRefresh();
        [80, 250, 800, 1800].forEach(delay => {
            window.setTimeout(translateTurboSettledDom, delay);
        });
    }

    function watchFeatureChanges() {
        chrome.storage.onChanged.addListener((changes,area)=>{
            if(area==='sync' && changes.enable_extension) FeatureSet.enable_extension=changes.enable_extension.newValue!==false;
        });
    }

    // 更新页面设置
    function updatePageConfig(currentPageChangeTrigger, force = false) {
        const newType = detectPageType();
        if (newType && (force || newType !== pageConfig.currentPageType)) {
            pageConfig = buildPageConfig(newType);
        }
    }

    function refreshAfterHistoryNavigation(trigger = '历史导航') {
        if (!FeatureSet.enable_extension || !document.body) return;

        updatePageConfig(trigger, true);
        refreshPageObserver();
        scheduleTurboPageTranslation();
    }

    function scheduleHistoryRefresh(event) {
        if (historyRefreshTimer !== null) window.clearTimeout(historyRefreshTimer);
        historyRefreshTimer = window.setTimeout(() => {
            historyRefreshTimer = null;
            refreshAfterHistoryNavigation(event?.type || '历史导航');
        }, 0);
    }

    // 构建页面设置 pageConfig 对象
    function buildPageConfig(pageType = pageConfig.currentPageType) {
        return {
            // 当前页面类型
            currentPageType: pageType,
            textCache: new Map(),
            // 页面标题静态词库
            titleStaticDict: {
                ...I18N[CONFIG.LANG].public.title.static,
                ...(I18N[CONFIG.LANG][pageType]?.title?.static || {})
            },
            // 页面标题正则词库
            titleRegexpRules: [
                ...I18N[CONFIG.LANG].public.title.regexp,
                ...(I18N[CONFIG.LANG][pageType]?.title?.regexp || [])
            ],
            // 静态词库
            staticDict: {
                ...I18N[CONFIG.LANG].public.static,
                ...(I18N[CONFIG.LANG][pageType]?.static || {})
            },
            // 正则词库
            regexpRules: [
                ...(I18N[CONFIG.LANG][pageType]?.regexp || []),
                ...I18N[CONFIG.LANG].public.regexp
            ],
            // 忽略突变元素选择器（字符串）
            ignoreMutationSelectors: [
                ...I18N.conf.ignoreMutationSelectorPage['*'],
                ...(I18N.conf.ignoreMutationSelectorPage[pageType] || [])
            ].join(', '),
            // 忽略元素选择器规则（字符串）
            ignoreSelectors: [
                ...I18N.conf.ignoreSelectorPage['*'],
                ...(I18N.conf.ignoreSelectorPage[pageType] || [])
            ].join(', '),
            // 字符数据监视开启规则（布尔值）
            characterData: I18N.conf.characterDataPage.includes(pageType),
            // CSS 选择器规则
            tranSelectors: [
                ...(I18N[CONFIG.LANG].public.selector || []),
                ...(I18N[CONFIG.LANG][pageType]?.selector || [])
            ],
        };
    }


    function watchUpdate() {
        // 缓存当前页面的 URL
        let previousURL = window.location.href;
        let observer = null;
        let observedBody = null;

        const handleUrlChange = () => {
            const currentURL = window.location.href;
            // 如果页面的 URL 发生变化
            if (currentURL !== previousURL) {
                previousURL = currentURL;
                updatePageConfig('DOM变化');
            }
        }

        // textarea 可能位于 header.GlobalNav 等忽略祖先下，但其 placeholder 和 aria-label
        // 仍是控件文案；value、子文本和 contenteditable 内容继续保持不翻译。
        const shouldTranslateTextareaChrome = (node, type, attributeName) => {
            if (node?.nodeType !== Node.ELEMENT_NODE || node.tagName !== 'TEXTAREA') return false;
            if (type === 'childList') return true;
            return type === 'attributes'
                && (attributeName === 'placeholder' || attributeName === 'aria-label');
        };

        const processMutations = mutations => {
            // 平铺突变记录并过滤需要处理的节点（链式操作）
            // 使用 mutations.flatMap 进行筛选突变:
            //   1. 针对`节点增加`突变，后期迭代翻译的对象调整为`addedNodes`中记录的新增节点，而不是`target`，此举大幅减少重复迭代翻译
            //   2. 对于其它`属性`和特定页面`文本节点`突变，仍旧直接处理`target`
            //   3. 使用`.filter()`筛选丢弃特定页面`特定忽略元素`内突变的节点
            mutations.flatMap(({ target, addedNodes, type, attributeName }) => {
                // 处理子节点添加的情况
                if (type === 'childList' && addedNodes.length > 0) {
                    return [...addedNodes].map(node => ({ node, type, attributeName })); // 将新增节点转换为数组
                }
                // 处理属性和文本内容变更的情况
                return (type === 'attributes' || (type === 'characterData' && pageConfig.characterData))
                    ? [{ node: target, type, attributeName }] // 否则，仅处理目标节点
                    : [];
            })
            // 过滤需要忽略的突变节点
            .filter(({ node, type, attributeName }) => {
                const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
                return shouldTranslateTextareaChrome(node, type, attributeName) || (element
                    && !element.closest?.(pageConfig.ignoreMutationSelectors)
                    && !isReactGlobalNavPortalNode(element));
            })
            // 处理每个变化
            .forEach(({ node }) =>
                // 递归遍历节点树进行处理
                traverseNode(node)
            );
        }

        // 监听 document.body 下 DOM 变化，用于处理节点变化
        const processMutationBatch = mutations => {
            if (!FeatureSet.enable_extension) return;
            handleUrlChange();
            if (pageConfig.currentPageType) processMutations(mutations);
        };

        const observeCurrentBody = () => {
            if (observer) observer.disconnect();
            observedBody = document.body;
            if (observedBody) observer.observe(observedBody, CONFIG.OBSERVER_CONFIG);
        };

        observer = new MutationObserver(processMutationBatch);
        observeCurrentBody();
        refreshPageObserver = () => {
            if (document.body !== observedBody) observeCurrentBody();
        };
    }

    /**
     * GitHub 的 SSR React 组件在 hydration 完成后才添加 loaded 类。
     * 在此之前改写文本会造成 hydration 失败，并让组件交互失效。
     */
    function watchReactHydration() {
        const handleLoadedReactRoot = element => {
            if (
                !FeatureSet.enable_extension
                || !pageConfig.currentPageType
                || !element.matches?.('react-app.loaded, react-partial.loaded')
            ) {
                return;
            }

            traverseNode(element);
        };

        const observer = new MutationObserver(mutations => {
            mutations.forEach(({ target, type }) => {
                if (type === 'attributes') handleLoadedReactRoot(target);
            });
        });

        observer.observe(document.body, {
            attributes: true,
            subtree: true,
            attributeFilter: ['class'],
        });

        // 避免组件恰好在观察器启动前完成 hydration 而漏翻译
        document.querySelectorAll('react-app.loaded, react-partial.loaded').forEach(handleLoadedReactRoot);
    }

    /**
     * traverseNode 函数：遍历指定的节点，并对节点进行翻译。
     * @param {Node} node - 需要遍历的节点。
     */
    function traverseNode(rootNode) {
        if (!FeatureSet.enable_extension) return;

        const handleTextNode = node => {
            if (node.length > 500) return;
            transElement(node, 'data');
        }

        // textarea 的文本子节点就是用户正在输入的内容，翻译它会直接篡改输入。
        // 这里单独拦文本节点，而不是把 textarea 放进 ignoreSelectors，
        // 否则 handleElement 里的 placeholder / value 属性翻译会被一并跳过。
        const isUserInputText = node => node.parentElement?.tagName === 'TEXTAREA';

        // 如果 rootNode 是文本节点，直接处理
        if (rootNode.nodeType === Node.TEXT_NODE) {
            if (!isUserInputText(rootNode)) handleTextNode(rootNode);
            return; // 文本节点没有子节点，直接返回
        }

        const treeWalker = document.createTreeWalker(
            rootNode,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
            node => {
                // 跳过用户输入内容
                if (node.nodeType === Node.TEXT_NODE) {
                    return isUserInputText(node)
                        ? NodeFilter.FILTER_REJECT
                        : NodeFilter.FILTER_ACCEPT;
                }
                // 跳过忽略的节点
                return node.matches?.(pageConfig.ignoreSelectors)
                    ? NodeFilter.FILTER_REJECT
                    : NodeFilter.FILTER_ACCEPT;
            },
        );

        const handleElement = node => {
            // 处理不同标签的元素属性翻译
            switch (node.tagName) {
                case 'RELATIVE-TIME': // 翻译时间元素
                    transTimeElement(node.shadowRoot);
                    return;

                case 'INPUT':
                case 'TEXTAREA': // 输入框 按钮 文本域
                    if (['button', 'submit', 'reset'].includes(node.type)) {
                        transElement(node.dataset, 'confirm'); // 翻译 浏览器 提示对话框
                        transElement(node, 'value');
                    } else {
                        transElement(node, 'placeholder');
                    }
                    transElement(node, 'ariaLabel');
                    break;

                case 'OPTGROUP':
                    transElement(node, 'label'); // 翻译 <optgroup> 的 label 属性
                    break;

                case 'BUTTON':
                    transElement(node, 'title'); // 翻译 浏览器 提示对话框
                    transElement(node.dataset, 'confirm'); // 翻译 浏览器 提示对话框 ok
                    transElement(node.dataset, 'confirmText'); // 翻译 浏览器 提示对话框 ok
                    transElement(node.dataset, 'confirmCancelText'); // 取消按钮 提醒
                    transElement(node, 'cancelConfirmText'); // 取消按钮 提醒
                    transElement(node.dataset, 'disableWith'); // 按钮等待提示
                    if (/tooltipped/.test(node.className)) transElement(node, 'ariaLabel');
                    break;

                case 'A':
                case 'SPAN':
                    transElement(node, 'title'); // title 属性
                    transElement(node.dataset, 'visibleText'); // 翻译 浏览器 提示对话框 ok
                    if (/tooltipped/.test(node.className)) transElement(node, 'ariaLabel');
                    break;

                default:
                    // 仅当 元素存在'tooltipped'样式 aria-label 才起效果
                    if (/tooltipped/.test(node.className)) transElement(node, 'ariaLabel'); // 带提示的元素，类似 tooltip 效果的
                    break;
            }
        }

        // TreeWalker 不会访问根节点；textarea 根节点仍需翻译控件文案，但不遍历输入内容。
        if (rootNode.nodeType === Node.ELEMENT_NODE && rootNode.tagName === 'TEXTAREA') {
            handleElement(rootNode);
            return;
        }

        // 预绑定处理函数提升性能
        const handlers = {
            [Node.ELEMENT_NODE]: handleElement,
            [Node.TEXT_NODE]: handleTextNode
        };

        let currentNode;
        while ((currentNode = treeWalker.nextNode())) {
            handlers[currentNode.nodeType]?.(currentNode);
        }
    }

    /**
     * detectPageType 函数：检测当前页面类型，基于URL、元素类名和meta信息。
     * @returns {string|boolean} 页面的类型，如'repository'、'dashboard'等，如果无法确定类型，那么返回 false。
     */

    // ==========================================================================
    // [Module] features/ui-localization.js
    // ==========================================================================

    // Share actual text writes with the generic collector; DOM mutations alone do not identify a translator.
    function readBuiltinText(node) {
        return globalThis.WTText ? globalThis.WTText.content(node) : node.textContent;
    }

    function writeBuiltinText(node, value) {
        if (globalThis.WTText) globalThis.WTText.writeContent(node, value, 'builtin');
        else node.textContent = value;
    }

    function isReactGlobalNavPortalNode(node) {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        if (element?.matches?.('#search-suggestions-dialog, [aria-label="Quick search"], [aria-label="Search suggestions"]')
            || element?.querySelector?.('#search-suggestions-dialog, [aria-label="Quick search"], [aria-label="Search suggestions"]')) {
            return true;
        }

        const portalRoot = element?.closest?.('#__primerPortalRoot__');
        if (!portalRoot) return false;

        const portal = element.closest?.('[data-component="Portal"]')
            || element.querySelector?.('[data-component="Portal"]')
            || portalRoot;
        if (portal.matches?.('#search-suggestions-dialog')
            || portal.querySelector?.('#search-suggestions-dialog')) return true;

        const referenceAttributes = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns'];
        const referenceElements = [
            portal,
            ...portal.querySelectorAll?.(
                referenceAttributes.map(attribute => `[${attribute}]`).join(', ')
            ) || [],
        ];

        for (const referenceElement of referenceElements) {
            for (const attribute of referenceAttributes) {
                const ids = referenceElement.getAttribute?.(attribute)?.split(/\s+/) || [];
                if (ids.some(id => document.getElementById(id)?.closest?.('header.GlobalNav'))) {
                    return true;
                }
            }
        }

        const portalIds = new Set([
            portal.id,
            ...Array.from(portal.querySelectorAll?.('[id]') || [], item => item.id),
        ].filter(Boolean));
        if (portalIds.size) {
            const headerReferences = document.querySelectorAll(
                'header.GlobalNav [aria-describedby], header.GlobalNav [aria-controls], header.GlobalNav [aria-owns]'
            );
            for (const headerReference of headerReferences) {
                for (const attribute of ['aria-describedby', 'aria-controls', 'aria-owns']) {
                    const ids = headerReference.getAttribute(attribute)?.split(/\s+/) || [];
                    if (ids.some(id => portalIds.has(id))) return true;
                }
            }
        }

        const hasControlledSurface = portal.matches?.('[role="menu"], [role="dialog"], [role="tooltip"]')
            || portal.querySelector?.('[role="menu"], [role="dialog"], [role="tooltip"]');
        return !!hasControlledSurface
            && !!document.activeElement?.closest?.('header.GlobalNav, qbsearch-input, #__primerPortalRoot__, [role="dialog"]');
    }

    function setupReactGlobalNavTranslation() {
        if (typeof document === 'undefined' || typeof window === 'undefined') return;

        const labels = I18N.conf.reactGlobalNavLabels || {};
        const dataContentLabelSelector = 'header.GlobalNav [data-component="text"][data-content]';
        const portalSurfaceSelector = [
            '#__primerPortalRoot__ [role="menu"]',
            '#__primerPortalRoot__ [role="dialog"]',
            '#__primerPortalRoot__ [role="tooltip"]',
            '#search-suggestions-dialog',
            '[aria-label="Quick search"]',
            '[aria-label="Search suggestions"]',
        ].join(', ');
        const searchSurfaceSelector = 'qbsearch-input';
        const searchModuleSelector = 'header.GlobalNav [class*="Search-module__"]';
        const unsafeTextSelector = [
            'textarea',
            '[contenteditable="true"]',
            'code',
            'pre',
            'kbd',
            'svg',
            'img',
            'canvas',
            'video',
        ].join(', ');
        const searchSelector = `${searchModuleSelector}, ${searchSurfaceSelector}, #__primerPortalRoot__ [role="dialog"]`;
        const translatableAttributeNames = ['title', 'aria-label', 'data-visible-text', 'placeholder'];
        const reactGlobalNavIdleMs = 700;
        const reactGlobalNavRetryMs = 400;
        let timer = null;
        let headerObserver = null;
        let lastReactGlobalNavMutationAt = Date.now();
        let lastReactGlobalNavPortalMutationAt = Date.now();
        const observedSurfaces = new WeakSet();

        function isReactGlobalNavSearchActive() {
            const active = document.activeElement;
            return !!active?.closest?.(searchSelector)
                || !!document.querySelector('#__primerPortalRoot__ [role="dialog"]');
        }

        function isReactGlobalNavSurfaceIdle(surfaceType = 'header') {
            const lastMutationAt = surfaceType === 'portal'
                ? lastReactGlobalNavPortalMutationAt
                : lastReactGlobalNavMutationAt;
            return Date.now() - lastMutationAt >= reactGlobalNavIdleMs;
        }

        function canTranslateReactGlobalNavHeader() {
            return document.readyState === 'complete'
                && isReactGlobalNavSurfaceIdle('header')
                && !isReactGlobalNavSearchActive();
        }

        function findStaticGlobalNavLabel(source) {
            const locale = I18N[CONFIG.LANG];
            if (!locale) return null;

            for (const section of Object.values(locale)) {
                const label = section?.static?.[source];
                if (typeof label === 'string' && label && label !== source) {
                    return label;
                }
            }

            return null;
        }

        function findRegexpGlobalNavLabel(source) {
            const locale = I18N[CONFIG.LANG];
            if (!locale) return null;

            for (const section of Object.values(locale)) {
                for (const [pattern, replacement] of section?.regexp || []) {
                    const match = source.match(pattern);
                    if (!match || match.index !== 0 || match[0] !== source) continue;

                    const label = source.replace(pattern, replacement);
                    if (label !== source) return label;
                }
            }

            return null;
        }

        function resolveReactGlobalNavLabel(source) {
            return labels[source] || findStaticGlobalNavLabel(source) || findRegexpGlobalNavLabel(source);
        }

        function normalizeReactGlobalNavText(text) {
            return text?.replace(/\s+/g, ' ').trim();
        }

        function translateReactGlobalNavText(text) {
            const source = normalizeReactGlobalNavText(text);
            return source ? resolveReactGlobalNavLabel(source) : null;
        }

        function translateReactGlobalNavElement(element, source) {
            const label = translateReactGlobalNavText(source ?? readBuiltinText(element));
            if (label && element.textContent !== label) {
                writeBuiltinText(element, label);
            }
        }

        function shouldSkipReactGlobalNavNode(node) {
            const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            if (!element) return true;
            if (element.closest?.(unsafeTextSelector)) return true;

            return false;
        }

        function translateReactGlobalNavAttributes(element) {
            translatableAttributeNames.forEach(attributeName => {
                const value = element.getAttribute?.(attributeName);
                const label = translateReactGlobalNavText(value);
                if (label && value !== label) {
                    element.setAttribute(attributeName, label);
                }
            });
        }

        function translateReactGlobalNavTextNode(node) {
            const source = readBuiltinText(node);
            const label = translateReactGlobalNavText(source);
            if (label) {
                writeBuiltinText(node, source.replace(source.trim(), label));
            }
        }

        function translateReactGlobalNavSurface(surface) {
            if (!FeatureSet.enable_extension || !surface) return;

            // textarea 只翻译控件文案，拒绝遍历子节点，避免改写用户输入内容。
            if (surface.nodeType === Node.ELEMENT_NODE && surface.tagName === 'TEXTAREA') {
                translateReactGlobalNavAttributes(surface);
                return;
            }

            if (shouldSkipReactGlobalNavNode(surface)) return;

            if (surface.nodeType === Node.ELEMENT_NODE) {
                translateReactGlobalNavAttributes(surface);
            }

            const walker = document.createTreeWalker(
                surface,
                NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
                {
                    acceptNode(node) {
                        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'TEXTAREA') {
                            translateReactGlobalNavAttributes(node);
                            return NodeFilter.FILTER_REJECT;
                        }
                        return shouldSkipReactGlobalNavNode(node)
                            ? NodeFilter.FILTER_REJECT
                            : NodeFilter.FILTER_ACCEPT;
                    }
                }
            );

            let node;
            while ((node = walker.nextNode())) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    translateReactGlobalNavAttributes(node);
                } else if (node.nodeType === Node.TEXT_NODE) {
                    translateReactGlobalNavTextNode(node);
                }
            }
        }

        // 顶部搜索按钮的占位文本把 <kbd> 混排在文字中间（Type <kbd>/</kbd> to search），
        // 逐个文本节点翻译会把词条拆碎，所以整体取译文后再按受保护片段回填。
        function translateReactGlobalNavSearchPlaceholder() {
            const placeholder = document.querySelector('header.GlobalNav [class*="Search-module__placeholder__"]');
            if (!placeholder) return;

            const label = translateReactGlobalNavText(readBuiltinText(placeholder));
            if (!label || normalizeReactGlobalNavText(placeholder.textContent) === label) return;

            const textNodeGroups = [[]];
            const protectedTexts = [];

            const collectNodes = node => {
                if (node.nodeType === Node.TEXT_NODE) {
                    textNodeGroups[textNodeGroups.length - 1].push(node);
                    return;
                }
                if (node.nodeType !== Node.ELEMENT_NODE) return;

                // 遇到 kbd 之类不可改写的元素，另起一段
                if (node.matches?.(unsafeTextSelector)) {
                    const protectedText = normalizeReactGlobalNavText(node.textContent);
                    if (protectedText) {
                        protectedTexts.push(protectedText);
                        textNodeGroups.push([]);
                    }
                    return;
                }
                node.childNodes.forEach(collectNodes);
            };
            placeholder.childNodes.forEach(collectNodes);

            // 用受保护片段把译文切段；切不出来说明词条和 DOM 对不上，直接放弃，别改坏
            const segments = [];
            let remaining = label;
            for (const protectedText of protectedTexts) {
                const index = remaining.indexOf(protectedText);
                if (index === -1) return;
                segments.push(remaining.slice(0, index));
                remaining = remaining.slice(index + protectedText.length);
            }
            segments.push(remaining);

            const hasNowhereToPut = segments.some((segment, index) =>
                normalizeReactGlobalNavText(segment) && !textNodeGroups[index]?.length);
            if (hasNowhereToPut) return;

            textNodeGroups.forEach((nodes, segmentIndex) => {
                nodes.forEach((node, nodeIndex) => {
                    writeBuiltinText(node, nodeIndex === 0 ? segments[segmentIndex] : '');
                });
            });
        }

        function translateReactGlobalNavHeader() {
            const header = document.querySelector('header.GlobalNav');
            if (!header) return true;
            if (!canTranslateReactGlobalNavHeader()) return false;

            document.querySelectorAll(dataContentLabelSelector).forEach(element => {
                if (!shouldSkipReactGlobalNavNode(element)) {
                    translateReactGlobalNavElement(element, element.getAttribute('data-content'));
                }
            });
            translateReactGlobalNavSurface(header);
            translateReactGlobalNavSearchPlaceholder();

            return true;
        }

        function isReactGlobalNavSearchPortal(surface) {
            return surface.matches?.('[role="dialog"]')
                || !!surface.querySelector?.('#search-suggestions-dialog, qbsearch-input, [role="dialog"]');
        }

        function translateReactGlobalNavPortals() {
            const surfaces = Array.from(document.querySelectorAll(portalSurfaceSelector))
                .filter(isReactGlobalNavPortalNode);
            if (!surfaces.length) return true;

            let searchPortalPending = false;
            surfaces.forEach(surface => {
                if (isReactGlobalNavSearchPortal(surface) && !isReactGlobalNavSurfaceIdle('portal')) {
                    searchPortalPending = true;
                    return;
                }
                translateReactGlobalNavSurface(surface);
            });

            return !searchPortalPending;
        }

        function translateReactGlobalNavLabels(options = { requireSettledHeader: true }) {
            if (!FeatureSet.enable_extension) return;
            observeReactGlobalNav();

            const headerTranslated = translateReactGlobalNavHeader();
            const portalsTranslated = translateReactGlobalNavPortals();

            if ((options.requireSettledHeader && !headerTranslated) || !portalsTranslated) {
                scheduleReactGlobalNavTranslation(reactGlobalNavRetryMs, options);
            }
        }

        function scheduleReactGlobalNavTranslation(delay = 800, options = {}) {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => translateReactGlobalNavLabels(options), delay);
        }

        function translateReactGlobalNavPortalsSoon() {
            if (!FeatureSet.enable_extension) return;

            const translatePortals = () => {
                observeReactGlobalNav();
                translateReactGlobalNavPortals();
            };

            window.requestAnimationFrame(translatePortals);
            [80, 200].forEach(delay => {
                window.setTimeout(translatePortals, delay);
            });
        }

        function scheduleReactGlobalNavSeries() {
            [800, 1600, 3000].forEach(delay => {
                window.setTimeout(translateReactGlobalNavLabels, delay);
            });
        }

        scheduleReactGlobalNavRefresh = scheduleReactGlobalNavSeries;

        function recordReactGlobalNavMutation(surface) {
            if (surface?.id === '__primerPortalRoot__' || surface?.closest?.('#__primerPortalRoot__')) {
                lastReactGlobalNavPortalMutationAt = Date.now();
                return;
            }

            lastReactGlobalNavMutationAt = Date.now();
        }

        function observeReactGlobalNav() {
            if (!headerObserver) {
                headerObserver = new MutationObserver(mutations => {
                    mutations.forEach(mutation => recordReactGlobalNavMutation(mutation.target));
                    translateReactGlobalNavPortals();
                    scheduleReactGlobalNavTranslation(reactGlobalNavRetryMs, { requireSettledHeader: true });
                });
            }

            [
                document.querySelector('header.GlobalNav'),
                document.querySelector('#__primerPortalRoot__'),
                document.querySelector('#search-suggestions-dialog'),
                document.querySelector('[aria-label="Quick search"]'),
                document.querySelector('[aria-label="Search suggestions"]'),
            ].forEach(surface => {
                if (!surface || observedSurfaces.has(surface)) return;

                observedSurfaces.add(surface);
                recordReactGlobalNavMutation(surface);
                headerObserver.observe(surface, {
                    childList: true,
                    subtree: true,
                    characterData: true,
                });
            });
        }

        function startReactGlobalNavTranslation() {
            observeReactGlobalNav();
            scheduleReactGlobalNavSeries();
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startReactGlobalNavTranslation, { once: true });
        } else {
            startReactGlobalNavTranslation();
        }

        window.addEventListener('turbo:load', scheduleReactGlobalNavSeries);
        window.addEventListener('urlchange', scheduleReactGlobalNavSeries);
        ['click', 'focusin', 'focusout', 'pointerover'].forEach(eventName => {
            document.addEventListener(eventName, () => {
                translateReactGlobalNavPortalsSoon();
                scheduleReactGlobalNavTranslation(reactGlobalNavRetryMs, { requireSettledHeader: true });
            }, true);
        });
    }

    /**
     * watchUpdate 函数：监视页面变化，根据变化的节点进行翻译
     */

    function detectPageType() {
        const url = new URL(window.location.href);
        const { PAGE_MAP, SPECIAL_SITES } = CONFIG;
        const { hostname, pathname } = url;

        // 基础配置 ===============================================
        const site = PAGE_MAP[hostname] || 'github'; // 通过站点映射获取基础类型
        const isLogin = document.body.classList.contains('logged-in');
        const metaLocation = document.head.querySelector('meta[name="analytics-location"]')?.content || '';

        // 页面特征检测 ============================================
        const isSession = document.body.classList.contains('session-authentication');
        const isHomepage = pathname === '/' && site === 'github';
        const isProfile = document.body.classList.contains('page-profile') || metaLocation === '/<user-name>';
        // analytics-location 带 data-turbo-transient，Turbo 软导航时可能暂时缺失。
        // 使用与当前 URL 一致的仓库元数据和两级路径结构兜底，避免仓库页整页跳过翻译。
        const repositoryNwo = document.head
            .querySelector('meta[name="octolytics-dimension-repository_nwo"]')
            ?.content?.trim() || '';
        const pathRepository = pathname.split('/').slice(1, 3).join('/');
        const hasRepositoryMetadata = hostname === 'github.com'
            && /^[^/]+\/[^/]+$/.test(repositoryNwo)
            && repositoryNwo.toLowerCase() === pathRepository.toLowerCase();
        const reservedFirstSegment = /^\/(?:home|dashboard|feed|copilot|spark|signup|account_verifications|login|logout|sessions?|password_reset|orgs|organizations|explore|topics|notifications|watching|stars|issues|pulls|repos|search|discussions|gist|sponsors|marketplace|apps|codespaces|developer|features|status|education|sitemap|mcp|settings|account|new|redeem|trending|collections|showcases|about|pricing|security|enterprise|customer-stories|site|support|learn|events|tools|edu|campus|git|contact|users|installations|billing|plans)\//i;
        const isRepository = /\/<user-name>\/<repo-name>/.test(metaLocation)
            || hasRepositoryMetadata
            || (site === 'github'
                && !reservedFirstSegment.test(pathname)
                && /^\/[^\/@?#]+\/[^\/@?#]+(?:\/|$)/.test(pathname));
        const isOrganization = /\/<org-login>/.test(metaLocation) || /^\/(?:orgs|organizations)/.test(pathname);

        // 正则配置 ================================================
        const { rePagePathRepo, rePagePathOrg, rePagePath } = I18N.conf;

        // 核心判断逻辑 ============================================
        let pageType;
        switch (true) { // 使用 switch(true) 模式处理多条件分支
            // 1. 登录相关页面
            case isSession:
                pageType = 'session-authentication';
                break;

            // 2. 特殊站点类型（gist/status/skills/education）
            case SPECIAL_SITES.includes(site):
                pageType = site;
                break;

            // 3. 个人资料页
            case isProfile:
                const tabParam = new URLSearchParams(url.search).get('tab');
                pageType = pathname.includes('/stars') ? 'page-profile/stars'
                         : tabParam ? `page-profile/${tabParam}`
                         : 'page-profile';
                break;

            // 4. 首页/仪表盘
            case isHomepage:
                pageType = isLogin ? 'dashboard' : 'homepage';
                break;

            // 5. 代码仓库页
            case isRepository:
                const repoMatch = pathname.match(rePagePathRepo);
                pageType = repoMatch ? `repository/${repoMatch[1]}` : 'repository';
                break;

            // 6. 组织页面
            case isOrganization:
                const orgMatch = pathname.match(rePagePathOrg);
                pageType = orgMatch ? `orgs/${orgMatch[1] || orgMatch.slice(-1)[0]}` : 'orgs';
                break;

            // 7. 默认处理逻辑
            default:
                const pathMatch = pathname.match(rePagePath);
                pageType = pathMatch ? (pathMatch[1] || pathMatch.slice(-1)[0]) : false;
        }

        // 词库校验 ================================================
        if (pageType === false || !I18N[CONFIG.LANG]?.[pageType]) {
            return false; // 明确返回 false 表示异常
        }

        return pageType;
    }

    /**
     * transTitle 函数：翻译页面标题
     */
    function transTitle() {
        if (!FeatureSet.enable_extension) return;
        const text = document.title; // 获取标题文本内容
        let translatedText = pageConfig.titleStaticDict[text] || '';
        if (!translatedText) {
            for (const [pattern, replacement] of pageConfig.titleRegexpRules) {
                translatedText = text.replace(pattern, replacement);
                if (translatedText !== text) break;
            }
        }
        if (translatedText) {
            document.title = translatedText;
        }
    }

    /**
     * transTimeElement 函数：翻译时间元素文本内容。
     * @param {Element} el - 需要翻译的元素。
     */
    function transTimeElement(el) {
        if (!FeatureSet.enable_extension || !el) return;

        // 时间文本形如 "on Jul 15"，中文语序里不需要这个 on。
        // 前面可能带空白，所以不能只匹配 /^on/，否则会残留成「打开于 on 7月15日」。
        // 同时只改承载文本的那个节点，避免用 el.textContent 赋值抹掉同级节点。
        const target = el.childNodes.length > 0 ? el.lastChild : el;
        const text = readBuiltinText(target);
        if (!text) return;

        const translatedText = text.replace(/^(\s*)on\b\s*/, '$1');
        if (translatedText !== text) {
            writeBuiltinText(target, translatedText);
        }
    }

    /**
     * transElement 函数：翻译指定元素的文本内容或属性。
     * @param {Element|DOMStringMap} el - 需要翻译的元素或元素的数据集 (node.dataset)。
     * @param {string} field - 需要翻译的属性名称或文本内容字段。
     */
    function transElement(el, field) {
        if (!FeatureSet.enable_extension) return false;
        const isText = field === 'data' && el.nodeType === 3;
        const attribute = ({placeholder:'placeholder',ariaLabel:'aria-label',title:'title'})[field];
        const text = globalThis.WTText && attribute && el.nodeType===1 ? WTText.sourceAttribute(el,attribute) : isText && globalThis.WTText ? globalThis.WTText.source(el) : el[field];
        if (!text) return false; // 当 text 为空时，退出函数

        const translatedText = transText(text); // 翻译后的文本
        if (translatedText) {
            if (isText && globalThis.WTText) globalThis.WTText.writeText(el, translatedText, 'builtin');
            else if(attribute && globalThis.WTText && el.nodeType===1)WTText.writeAttribute(el,attribute,translatedText,'builtin');
            else el[field] = translatedText; // 替换翻译后的内容
        }
    }

    /**
     * transText 函数：翻译文本内容。
     * @param {string} text - 需要翻译的文本内容。
     * @returns {string|boolean} 翻译后的文本内容，如果没有找到对应的翻译，那么返回 false。
     */
    function transText(text) {
        // 判断是否需要跳过翻译
        //  1. 检查内容是否为空或者仅包含空白字符或数字。
        //  2. 检查内容是否仅包含中文字符。
        //  3. 检查内容是否不包含英文字母和符号。
        const shouldSkip = text => /^[\s0-9]*$/.test(text) || /^[\u4e00-\u9fa5]+$/.test(text) || !/[a-zA-Z,.]/.test(text);
        if (shouldSkip(text)) return false;

        // 清理文本内容
        const trimmedText = text.trim(); // 去除首尾空格
        const cleanedText = trimmedText.replace(/\xa0|[\s]+/g, ' '); // 去除多余空白字符（包括 &nbsp; 空格 换行符）

        // 尝试获取翻译结果
        const translatedText = fetchTranslatedText(cleanedText);

        // 如果找到翻译并且不与清理后的文本相同，则返回替换后的结果
        if (translatedText && translatedText !== cleanedText) {
            return text.replace(trimmedText, translatedText); // 替换原字符，保留首尾空白部分
        }

        return false;
    }

    /**
     * fetchTranslatedText 函数：从特定页面的词库中获得翻译文本内容。
     * @param {string} text - 需要翻译的文本内容。
     * @returns {string|boolean} 翻译后的文本内容，如果没有找到对应的翻译，那么返回 false。
     */
    function fetchTranslatedText(text) {
        const cachedText = pageConfig.textCache.get(text);
        if (cachedText !== undefined) return cachedText;

        // 静态翻译
        let translatedText = pageConfig.staticDict[text]; // 默认翻译 公共部分

        if (typeof translatedText === 'string') {
            pageConfig.textCache.set(text, translatedText);
            return translatedText;
        }

        // 正则翻译
        for (const [pattern, replacement] of pageConfig.regexpRules) {
            translatedText = text.replace(pattern, replacement);
            if (translatedText !== text) {
                pageConfig.textCache.set(text, translatedText);
                return translatedText;
            }
        }

        pageConfig.textCache.set(text, false);
        return false; // 没有翻译条目
    }

    /**
     * transBySelector 函数：通过 CSS 选择器找到页面上的元素，并将其文本内容替换为预定义的翻译。
     */
    function transBySelector() {
        if (!FeatureSet.enable_extension) return;
        // 遍历每个翻译规则
        pageConfig.tranSelectors?.forEach(([selector, translatedText]) => {
            // 使用 CSS 选择器找到对应的元素
            const element = document.querySelector(selector);
            // 如果找到了元素，那么将其文本内容替换为翻译后的文本
            if (element) {
                writeBuiltinText(element, translatedText);
            }
        })

        // /copilot/agents 页面结构是动态渲染，使用强制替换兜底，避免分段命中失败
        applyCopilotAgentsOverrides();
    }

    function applyCopilotAgentsOverrides() {
        if (window.location.hostname !== 'github.com' || window.location.pathname !== '/copilot/agents') {
            return;
        }

        const setText = (selector, text) => {
            const el = document.querySelector(selector);
            if (el) writeBuiltinText(el, text);
        };

        setText('h2.Blankslate-Heading', 'Copilot 云端智能体处理例行任务，让您专注于核心工作');
        setText('p.Blankslate-Description', '将测试、依赖项升级、迁移和维护等工作交给智能体处理，节省您的时间。您可以通过 Copilot Chat、命令行、IDE 创建拉取请求，或直接将议题分配给 Copilot 来开始使用。');
        setText('.BannerDescription', '仅在付费计划中可用。试用 Copilot Pro，可免费 30 天。');

        // 兼容不同结构：链接文案可能被拆分或已部分翻译
        document.querySelectorAll('a').forEach((el) => {
            const text = (el.textContent || '').trim();
            if (/capabilities/i.test(text)) {
                writeBuiltinText(el, '查看 Copilot 云端智能体能力');
            }
        });

        // 试用按钮文案兜底
        document.querySelectorAll('button, a').forEach((el) => {
            const text = (el.textContent || '').trim();
            if (/^start\s+free\s+trial$/i.test(text)) {
                writeBuiltinText(el, '开始免费试用');
            }
        });
    }

    // ==========================================================================
    // [Module] entry.js
    // ==========================================================================

    /**
     * init 函数：初始化翻译功能。
     */
    let pageLifecycleStarted = false;

    function startPageLifecycle(reason) {
        if (pageLifecycleStarted || !document.body) return;
        pageLifecycleStarted = true;

        updatePageConfig(reason);
        if (FeatureSet.enable_extension && pageConfig.currentPageType) {
            traverseNode(document.body);
        }

        // 配置读取可能在 DOMContentLoaded 之后完成；此时仍需立即安装观察器并触发 界面 扫描。
        watchUpdate();
        watchReactHydration();
    }

    async function init() {
        if (typeof I18N === 'undefined') {
            throw new Error('词库文件 locals.js 未加载，脚本无法运行');
        }

        await loadFeatureSet();
        // 禁用 GitHub 时完全退出：不设置中文 lang，不启动正文翻译和页面观察器。
        // 重新启用由公共浏览器翻译保护脚本刷新页面后启动。
        if (globalThis.FixedSitePreferences) {
            await globalThis.FixedSitePreferences.ready;
            if (!globalThis.FixedSitePreferences.isEnabled()) return;
        }
        watchFeatureChanges();
        setupReactGlobalNavTranslation();

        // 设置中文环境
        if (FeatureSet.enable_extension) {
            document.documentElement.lang = CONFIG.LANG;
        }

        // 监测 HTML Lang 值, 设置中文环境
        new MutationObserver(() => {
            if (FeatureSet.enable_extension && document.documentElement.lang === 'en') {
                document.documentElement.lang = CONFIG.LANG;
            }
        }).observe(document.documentElement, { attributeFilter: ['lang'] });

        // 监听 Turbo 完成事件（延迟翻译）
        document.addEventListener('turbo:load', () => {
            updatePageConfig('turbo:load');
            if (!FeatureSet.enable_extension || !pageConfig.currentPageType) return;

            // 软导航后必须全量扫描；仅靠 title/selector 会漏掉仓库顶栏等 React 文案
            scheduleTurboPageTranslation();
        });
        document.addEventListener('turbo:render', () => refreshAfterHistoryNavigation('turbo:render'));
        document.addEventListener('turbo:frame-load', () => {
        });
        window.addEventListener('popstate', scheduleHistoryRefresh);
        window.addEventListener('pageshow', event => {
            if (event.persisted) scheduleHistoryRefresh(event);
        });

        // 首次页面翻译
        window.addEventListener('DOMContentLoaded', () => {
            startPageLifecycle('DOMContentLoaded');
        });

        // content script 在 document_start 注入后读取 storage 可能错过 DOMContentLoaded，
        // readyState 已经就绪时直接启动一次完整生命周期，避免 界面 永久不触发翻译。
        if (document.readyState !== 'loading') {
            startPageLifecycle('init:ready');
        }
    }

})(window, document);
