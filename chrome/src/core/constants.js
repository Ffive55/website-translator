/**
 * @file chrome/src/core/constants.js
 * 全局默认配置、Prompt 模板、运行期状态字典与页面常量
 */

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

