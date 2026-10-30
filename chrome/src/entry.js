/**
 * @file chrome/src/entry.js
 * 插件生命周期入口：环境嗅探、语言属性监听与首次启动初始化
 */

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

