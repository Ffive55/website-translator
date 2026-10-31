/*******************************************************************************

    locals.js - 搭配用户脚本插件`GitHub 中文化插件`的页面匹配规则, 翻译忽略规则,
                词条库文件
    Copyright (C) 2016-2021 楼教主 (https://github.com/52cik)
    Copyright (C) 2021-当前 沙漠之子 (https://github.com/maboloshi)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.

    Home: https://github.com/maboloshi/github-chinese
*/

// Fixed handlers reviewed during the 2026-10-31 migration. Never generated from downloaded data.
(function(){
  'use strict';
  function bind(I18N){
    return {
      "h-915e386f18fd5a9819e758b723aa0e0dbdbbdfcace3fc4230e2e2a5eb49607fa": function (all, prefix, week, date1, month, date2, year) {
            var prefixKey = {
                "Updated "   : "更新于 ",
                "Commits on ": "提交于 ",
                "Joined on " : "加入于 ",
                //"Submitted ": "提交于 ", // 教育
            };
            var weekKey = {
                "Sun"  : "周日",
                "Mon"  : "周一",
                "Tue"  : "周二",
                "Wed"  : "周三",
                "Thu"  : "周四",
                "Fri"  : "周五",
                "Sat"  : "周六"
            };
            var monthKey = {
                "Jan": "1月",
                "Feb": "2月",
                "Mar": "3月",
                "Apr": "4月",
                "May": "5月",
                "Jun": "6月",
                "Jul": "7月",
                "Aug": "8月",
                "Sep": "9月",
                "Oct": "10月",
                "Nov": "11月",
                "Dec": "12月"
            };

            // 处理日期
            var date = date1 ? date1 : date2;
            var formattedDate = (year ? year + '年' : '') + monthKey[month.substring(0, 3)] + (date ? date + '日' : '');

            // 处理星期
            var formattedWeek = week ? '，' + weekKey[week.substring(0, 3)] : '';

            // 返回翻译结果
            return (prefixKey[prefix] ? prefixKey[prefix] : '') + formattedDate + formattedWeek;
        },
      "h-9dba11368068f7edf6fb3658325691427a653f7f16f4d96e62707b789d43dd71": function (all, prefix, count, unit, suffix) {
            if (all === 'now') {
                return '现在';
            }
            if (all === 'just now') {
                return '刚刚';
            }
            if (all === 'last month') {
                return '上个月';
            }
            if (all === 'yesterday') {
                return '昨天';
            }
            if (count[0] === 'a') {
                count = '1';
            } // a, an 修改为 1

            var unitKey = {second: '秒', minute: '分钟', hour: '小时', day: '天', month: '个月', year: '年'};

            if (suffix) {
                return (prefix === 'about' || prefix === 'almost' ? '大约 ' : prefix === 'less than' ? '不到 ' : '') + count + ' ' + unitKey[unit] + (prefix === 'over' ? '多之前' : '之前');
            } else {
                return count + ' ' + unitKey[unit] + (prefix === 'in' ? '之内' : '之前');
            }
        },
      "h-ce16d0e3fa64ee5afe688c346508e2bd901f04db7085138c2ab43fdd75032c31": function (all, prefix, minute, second) {
            all = minute ? minute + '分' + second + '秒' : second + '秒';
            return (prefix ? all + '之内' : all);
        },
      "h-f7f332fcbfbb280c0f69ed1fecf5c73422725a2acc91374fac9940349a14b89a": function (all, count, suffix) {
            var suffixKey = {y: '年', mo: '个月', h: '小时', d: '天', w: '周', m: '分钟', s: '秒'};

            return count + ' ' + suffixKey[suffix] + '之前';
        },
      "h-c2e4eca150a7929b3b04f581c4fe98f686be040d24dddae19b1b11fb0bef7adf": function (all, date1, week, month, year1, date2, year2) {
            var weekKey = {
                "Sun"  : "周日",
                "Mon"  : "周一",
                "Tue"  : "周二",
                "Wed"  : "周三",
                "Thu"  : "周四",
                "Fri"  : "周五",
                "Sat"  : "周六",
            };
            var monthKey = {
                "Jan": "1月",
                "Feb": "2月",
                "Mar": "3月",
                "Apr": "4月",
                "May": "5月",
                "Jun": "6月",
                "Jul": "7月",
                "Aug": "8月",
                "Sep": "9月",
                "Oct": "10月",
                "Nov": "11月",
                "Dec": "12月"
            };
            var date = date1 ? date1 : date2;
            var year = year1 ? year1 : year2;
            return (year ? year + '年' : '') + monthKey[month.substring(0, 3)] + (date ? date + '日' : '') + (week ? ', ' + weekKey[week.substring(0, 3)] : '');
        },
      "h-445463be0632d6fe4b158ce5ad15a19dbd4848713ce77ea8f673e02dbab7f25f": function (all, prefix, count, unit, suffix) {
            if (all === 'now') {
                return '现在';
            }
            if (all === 'just now') {
                return '刚刚';
            }
            if (all === 'last year') {
                return '最近 1 年';
            }
            if (all === 'last month') {
                return '上个月';
            }
            if (all === 'last week') {
                return '上周';
            }
            if (all === 'yesterday') {
                return '昨天';
            }
            if (count[0] === 'a') {
                count = '1';
            } // a, an 修改为 1

            unit = unit.replace(/s$/, '');
            var unitKey = {second: '秒', minute: '分钟', hour: '小时', day: '天', month: '个月', year: '年', week: '周'};

            if (suffix) {
                return (prefix === 'about' || prefix === 'almost' ? '大约 ' : prefix === 'less than' ? '不到 ' : '') + count + ' ' + unitKey[unit] + (prefix === 'over' ? '多之前' : '之前');
            } else {
                return count + ' ' + unitKey[unit] + (prefix === 'in' ? '之内' : '之前');
            }
        },
      "h-0722dbbd04ee857153777e15ce08ad22c0f9612269c275ec8f65726a4ddefbd5": (match, p1) => {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `该组织已由管理员于 ${translatedDate} 存档。不再维护。`;
        },
      "h-37764b54e66a773845a73f48c78f804cfb4683fabdd7fba93b64829fbe9856b8": function (all, reacted) {
            var reactedKey = {'thumbs up': "点赞", 'thumbs down': "点踩", laugh: "大笑", hooray: "欢呼", confused: "表示困惑", heart: "比心", rocket: "发送火箭", eyes: "表示关注"};

            return '您' + reactedKey[reacted];
        },
      "h-b2e5a7a6307ab2b9ab3a43cfa4b3dcbb9cb1f3056b68acd6b951a4b0df93c651": function (all, number, reacted) {
            var reactedKey = {'thumbs up': "点赞", 'thumbs down': "点踩", laugh: "大笑", hooray: "欢呼", confused: "表示困惑", heart: "比心", rocket: "发送火箭", eyes: "表示关注"};

            return number + ' 人' + reactedKey[reacted];
        },
      "h-15a1b5c54545336b2f99771832279c75938baca78d66608d46cf24ae12db7f9a": function(all, num, compare){
            var compareKey = {ahead: '早', behind: '晚'};

            return '- ' + compareKey[compare] + num + '小时';
        },
      "h-bffef37b8787a7208c2c1add20e6fbb6efc5a41413eb1f841620ab092d799f6d": (match, number, p1) => {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            //return optKey[opt] + `${translatedDate}`;
            return number === 'No' ? `${translatedDate}，无贡献` : `${translatedDate}，` + number + ` 次贡献`;
        },
      "h-37709d78cb90579aeb6e96228c967d54fea4f5ed613764bb1308af7b716931a2": function(all, m, d){
            var mKey = {
                "Jan": "1月",
                "Feb": "2月",
                "Mar": "3月",
                "Apr": "4月",
                "May": "5月",
                "Jun": "6月",
                "Jul": "7月",
                "Aug": "8月",
                "Sep": "9月",
                "Oct": "10月",
                "Nov": "11月",
                "Dec": "12月",
            };

            return mKey[m] + d + "日";
        },
      "h-80f65102ced575383cb740b365bdec2ff5be2a94856e5336f4f1ba148d6839b3": (match ,p1) => {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `赞助自 ${translatedDate}`;
        },
      "h-7509615022a8890026fb45d45e80660a4c689fde75e3cbdacb310198d1eebec5": (match, p1, p2) => {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedP1 = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            const translatedP2 = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p2);
            return `${translatedP1}-${translatedP2}用量。高级请求价格为 $0.04 / 个。`;
        },
      "h-563e9932c2e5c553118e97f2792beb2b7458fd2d63cdab10856d20f4f11e0aca": (match, p1) => {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `过去 45 天内每用户高级请求明细。${translatedDate} 日落`;
        },
      "h-7293ec6e766a68cf9f0b473837a69bd4d0bcd5e91846c5116bfd6d451fc8cf24": (match, p1, p2) => { // 概况下方小字，过于啰嗦直接省略
            //const translatedP1 = I18N["zh-CN"]["public"]["time-regexp"][p1] || p1;
            //const translatedP2 = I18N["zh-CN"]["public"]["time-regexp"][p2] || p2;
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedP1 = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            const translatedP2 = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p2);
            return `${translatedP1}-${translatedP2}`;
        },
      "h-9beb52dde860b8469b0842318c4a38f02b0e932271b94edf2bc80d9c17507b18": (match, p1, p2, p3) => {
                const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
                const translatedP1 = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
                const translatedP2 = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p2);
                return `统计时间段：${translatedP1}-${translatedP2}。本月配额将在${p3}天内重置。`;
            },
      "h-0eeabf7eebf004b084c9193f9f25fb0512f23f6f5ae148a7bed7d218e8da827d": (match, p1, p2, p3) => {
                switch (p1) {
                  case 'Today':
                    return '时间段：今天';
                  case 'Current month':
                    return '时间段：本月';
                  case 'Last month':
                    return '时间段：上个月';
                  case `This year (${p2})`:
                    return `时间段：今年（${p2}）`;
                  case `Last year (${p3})`:
                    return `时间段：去年（${p3}）`;
                  default:
                    return match;
                }
            },
      "h-6233f1a5c82dda8a5cd05b0eb5e7e3863401f31a8b7c56d8bf31eb67fe184b91": (match, p1) => {
                const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
                const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
                return `${translatedDate}（UTC时间）`;
            },
      "h-04130b62b8a2d9c2bf4a55a12ae35bdb17463ed954336cb4743988cff8544f92": (match, s1, p1) => {
                //const translatedP1 = I18N["zh-CN"]["public"]["time-regexp"][p1] || p1;
                //const translatedP2 = I18N["zh-CN"]["public"]["time-regexp"][p2] || p2;
                var s1Key = {'Usage': '用量','actions': '操作', 'codespaces': '代码空间', 'Codespaces storage': '代码空间存储', 'Codespaces compute 2-core': '代码空间 - 双核','Actions Windows': '操作 Windows', 'Actions Linux': '操作 Linux','Actions macOS 3-core': '操作 macOS 三核','Actions storage': "操作存储",'All other': '其他'};
                const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
                const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
                return `${translatedDate}` + s1Key[s1];// 星期几暂时省略
            },
      "h-aace7c052f8a7ac9a5da19bc2de9a5368cbbfcb28d7b7b6aaf6912b03abdc1b4": (match, p1, p2) => {
                // 运行规则：非12AM照搬，PM数字加12，12AM=0
                let hour = parseInt(p1, 10);
                if (p2 === "PM" && hour !== 12) {
                    hour += 12;
                } else if (p2 === "AM" && hour === 12) {
                    hour = 0;
                }
                return `${hour}:00`;
            },
      "h-02974e9b1920bbd40ab766482986d4d3ce4d4d38854c51dbc6159af6c869cde0": function(all , num, time) {
                var numKey = {"three": "三", "four": "四", "five": "五"}
                var timeKey = {"today": "今天","this month": "这个月","last month": "上个月","this year": "今年","last year": "去年"};
                return timeKey[time] + "排名前" + numKey[num] + "的仓库";
            },
      "h-c0b23fb4c349a256954c5d480980b571b007268b9b17d03ceea1d55bf6a63a7c": function(all, group) {
                var groupKey = {'None': '无','Product': '产品','SKU': 'SKU','Repository': '仓库', 'Models': '模型'};
                return '分组：' + groupKey[group];
            },
      "h-eb01f3aa00844484768d132d5aaeee0859aaec6e45a4a5a2cd0f4ab94b68acb3": (match, p1) => {
                const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
                const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
                return `${translatedDate}`; // 有标题作为上下文，直接省略，只剩日期
            },
      "h-2b02e22bc9c815f2661f4635e7224797c164c243c8bd90845c707f0713547b9b": (match, p1) => {
                const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
                const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
                return `直到 ${translatedDate}。`;
            },
      "h-27e0a022bc731d84ae57c95ca4418bcdd8ed9c3a601c52fdbed035c3bcce72cc": (match, p1) => {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `提交于 ${translatedDate}`;
        },
      "h-0769d225b56c8de8737a9a0c00b7833758bff986753dc34c07ad9202babc39c9": (match, p1, p2) => {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const dateAdded = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            const dateLastUsed = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p2);
            return `添加于 ${dateAdded} | 最后使用 ${dateLastUsed}`;
        },
      "h-8f012e9556c5314702b96fbe4e0320a3cd0318af7a6b5664caccf29859372c00": function(all, week, month, day, year){
            var weekKey = {
                "Sun"  : "周日",
                "Mon"  : "周一",
                "Tue"  : "周二",
                "Wed"  : "周三",
                "Thu"  : "周四",
                "Fri"  : "周五",
                "Sat"  : "周六"
            };
            var monthKey = {
                "Jan": "1月",
                "Feb": "2月",
                "Mar": "3月",
                "Apr": "4月",
                "May": "5月",
                "Jun": "6月",
                "Jul": "7月",
                "Aug": "8月",
                "Sep": "9月",
                "Oct": "10月",
                "Nov": "11月",
                "Dec": "12月"
            };

            return '有效期至 ' + year + '年' + monthKey[month] + day + '日，' + weekKey[week];
        },
      "h-b8b9776765f5120a6cad126bca2ee3be5410befc08d5251451d62b6d7379f2c6": (match, d , p1) => {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return d + `天（${translatedDate}）`;
        },
      "h-9ad2c6d5451c393dddd532f0d18af305bb48e33d7cead0a06ebc6025f4e885cc": (match, p1) => {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `此仓库已由所有者于${translatedDate}存档。它现在是只读的。`;
        },
      "h-6725827a931d70543df518a33d1d931d0e5360606983ea0759b87b78365f249a": function (all, reacted) {
            var reactedKey = {'thumbs up': "点赞", 'thumbs down': "点踩", laugh: "大笑", hooray: "欢呼", confused: "表示困惑", heart: "比心", rocket: "发送火箭", eyes: "表示关注"};

            return reactedKey[reacted];
        },
      "h-3c4f17af2ed2ed68a12c16ff15e237001f67864101aa604594338a0b4e594066": function(all, lic, num){
            var licKey = {'Unknown': '未知'};
            return licKey[lic] + '和另外' + num + '个许可证';
        },
      "h-079e5041d474a8bff1f21a07fc1a95809b8e61d86d3161955cefd09dc8817b61": (match, p1) => {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `提交于${translatedDate}`;
        },
      "h-33b77dc3808059dd22d8cf678e86072073854ee1934957f128e97ce0d9a7fef4": function (all, stat) {
            var statKey = {Open: '打开', Closed: '关闭', Locked: '锁定', Unlocked: '未锁定', Answered: '已答复', Unanswered: '未答复', " ,": "，"};

            return '筛选：' + statKey[stat];
        },
      "h-b8922285bad1ff11601f75ba6afaf87432ef7eb733d28cd9893af8b21dc4875d": (match, p1) => { // p1为(.+)
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `发布于 ${translatedDate} · 摘要`;
        },
      "h-04da1e59a976aa5b644b75c1b0de50de56cd6f2d85da5aa66c740c806fd8335f": (match, p1) => { // 受影响的分支 // BUG: 翻译不生效
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `初次检测 ${translatedDate}`;
        },
      "h-2b471b2c0b1b783dc70f493c57cb1c8c0298e12a3e30934dc727f32b99383081": function(all, user, cont){

            var contKey = {Commits: '提交', Additions: '添加数量', Deletions: '删除数量'};

            return user + ' 的' + contKey[cont];
        },
      "h-a7bb5bfae5df7f53190c54e2be0b45d2b6d4913a9fc06b4efb007a658d152384": (match, p1) => { // p1为(.+)
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `${translatedDate}当周`; // 无论如何都是星期一
        },
      "h-3769a1de5437d41d6322f22e4bc9569ffc740a18807e2a767719ea469db5c338": (match, p1, p2 ,p3) => { // 出现位置：具体某贡献者 - 贡献数柱形图日期，原文格式为 月-月 年
            const translatedP1 = I18N["zh-CN"]["public"]["static"][p1] || p1;
            const translatedP2 = I18N["zh-CN"]["public"]["static"][p2] || p2;
            return `${p3}年 ${translatedP1}-${translatedP2}`; // 此处修改格式为 年 月-月
        },
      "h-6263101703fee790ae66c12bfebbad78e5be75bbaab0aa8b3664efd74a6dbb37": function(all, d, m){
            var mKey = {
                "Jan": "1月",
                "Feb": "2月",
                "Mar": "3月",
                "Apr": "4月",
                "May": "5月",
                "Jun": "6月",
                "Jul": "7月",
                "Aug": "8月",
                "Sep": "9月",
                "Oct": "10月",
                "Nov": "11月",
                "Dec": "12月",
            };

            return mKey[m] + d + "日";
        },
      "h-b2a4611073db0eb50b48a6b601cf44e59e61b950ee979acbcc6c79abc1097a95": function(all, month, day){
            var monthKey = {
                "Jan": "1月",
                "Feb": "2月",
                "Mar": "3月",
                "Apr": "4月",
                "May": "5月",
                "Jun": "6月",
                "Jul": "7月",
                "Aug": "8月",
                "Sep": "9月",
                "Oct": "10月",
                "Nov": "11月",
                "Dec": "12月"
            };

            return '次提交本周，' + monthKey[month] + day + '日';
        },
      "h-e6c8de7d2db55e97d80850f4d9e8a76ddf142e061f052e979c4c4578af908986": (match, p1) => { // p1为(.+)
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `${translatedDate}当周` ; // 这里写翻译结果
        },
      "h-fc7c450a1f49313b8c54b3397ece404dbf3cb2bdcaee45e50e956afd42848f72": (match, p1) => {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `· 自动检测于 ${translatedDate}`;
        },
      "h-c31995248440c892ebbe2e63de2a3eb4bec2668e42719b3d7ea2e19c134f2b8d": function(all, type, num){
            var typeKey = {"Active": "活跃","Inactive": "不活跃","Network": "网络","Archived": "存档","Starred": "星标"};
            return typeKey[type] + ' ' + num;
        },
      "h-3d1dfb50c79ff91ae44241add14f068c52f372e79e55a53b96940e3a784b6545": (match, p1) => {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `邀请于${translatedDate}`;
        },
      "h-d69327370f66e5c5e6c2a9b6ef73788dc7d7f9810f241cb76f991bce016ecb69": (match, p1) => {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `最后使用${translatedDate}`;
        },
      "h-03ab3fb23084da5ee77b1f17943d9c7c43272e8e410b54d5d24eb9a3f3cf25ff": function(all, type, scope, period){
            var typeKey = {'minutes': '总分钟数', 'job runs': '作业运行总数'};
            var scopeKey = {'organization': '该组织', 'repository': '该仓库'};
            var periodKey = {
                "current week (mon-sun)": "本周（周一 ~ 周日）",
                "current month": "本月",
                "last month": "上个月",
                "last 30 days": "最近 30 天",
                "last 90 days": "最近 90 天",
                "last year": "最近一年",
                "custom": "自定义时间段",
            };
            return periodKey[period] + scopeKey[scope] + '所有工作流的' + typeKey[type];
        },
      "h-c76efc9d36fdb33d1a0a226c46c1ea145f950251ff6fbbc33dd51389c8cf164d": function(all, period){
            var periodKey = {
                "Current week (Mon-Sun)": "本周（周一 ~ 周日）",
                "Current month": "本月",
                "Last month": "上个月",
                "Last 30 days": "最近 30 天",
                "Last 90 days": "最近 90 天",
                "Last year": "最近一年",
                "Custom": "自定义",
            };
            return '范围：' + periodKey[period];
        },
      "h-6f8aa824df5ac85433ec8ef4cd4790f42bb80091b005db69b7fbb18749eab61d": function(all, type, period){
            var typeKey = {'Average run time of': '平均运行时长', 'Average queue time of': '平均等待时长', 'Failure rate across': '作业失败率', 'Total minutes used across failed': '作业失败次数'};
            var periodKey = {
                "current week (mon-sun)": "本周（周一 ~ 周日）",
                "current month": "本月",
                "last month": "上个月",
                "last 30 days": "最近 30 天",
                "last 90 days": "最近 90 天",
                "last year": "最近一年",
                "custom": "自定义时间段",
            };
            return periodKey[period] + '该仓库所有工作流程的' + typeKey[type];
        },
      "h-170be3566b0aa9005ba719d258ab57157d2a2b863b856ca96159a6a4cf344b4b": (match, p1, p2, min, p3) =>{
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);

            // 运行规则：非12AM照搬，PM数字加12，12AM=0
            let hour = parseInt(p2, 10);
            if (p3 === "PM" && hour !== 12) {
                hour += 12;
            } else if (p3 === "AM" && hour === 12) {
                hour = 0;
            }

            return `${translatedDate}${hour}:${min}`;
        },
      "h-3b603b943608e646bd251aa3e63618c7f088425c0805cb522aa3a52b4f1c59a7": (match, user, p1) => {
                const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
                const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
                return `您好，`+ user + `！您最近于${translatedDate}验证。您现在无需重新验证。从验证到享受学业福利之间可能会有一段等待时间。`;
            // return '您好，' + user + '！您最近于' + year + '年' + monthKey[month] + day + '日验证。您现在无需重新验证。从验证到享受学业福利之间可能会有一段等待时间。';
        },
      "h-fcc0b563e22271951760703bcfe91619b9431a3f6e0b2a066a004752c42d2d1a": (match, user, p1)=> {
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return `您好，`+ user + `！您最近于${translatedDate}学生验证。您现在无需重新验证。从验证到享受学业福利之间可能会有一段等待时间。`;
            //return '您好，' + user + '！您最近于' + year + '年' + monthKey[month] + day + '日学生验证。您现在无需重新验证。从验证到享受学业福利之间可能会有一段等待时间。';
        },
      "h-fdf982a147fc0118bf71ee378be233fb17b47b3d47dc240576b4671e6afbeaa9": (match, opt, p1) => { // p1为(.+)
            var optKey = {"Submitted": "提交于", "Verified since": "验证自",};
            const dateRegExp = I18N["zh-CN"]["public"]["time-regexp"];
            const translatedDate = dateRegExp.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), p1);
            return optKey[opt] + `${translatedDate}`;
        }
    };
  }
  if(typeof module!=='undefined')module.exports={bind};
  else globalThis.WTDictionaryHandlers={bind};
})();
