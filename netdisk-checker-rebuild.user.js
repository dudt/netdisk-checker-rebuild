// ==UserScript==
// @name         网盘有效性检查【重构版】
// @namespace    https://github.com/dudt/netdisk-checker-rebuild
// @version      2026.10.27.4
// @icon         https://pan.baidu.com/ppres/static/images/favicon.ico
// @author       dudt (基于 Leon406 原版重构)
// @license      AGPL-3.0-or-later
// @match        *://*/*
// @description  网盘助手,自动识别并检查链接状态,自动填写密码并跳转。现已支持 ✅百度网盘 ✅蓝奏云 ✅腾讯微云 ✅阿里云盘 ✅天翼云盘 ✅123网盘 ✅迅雷云盘 ✅夸克网盘 ✅奶牛网盘 ✅文叔叔 ✅115网盘 ✅移动彩云
// @connect      lanzoue.com
// @connect      lanzoux.com
// @connect      lanzoui.com
// @connect      lanzouv.com
// @connect      lanzov.com
// @connect      lanzn.com
// @connect      baidu.com
// @connect      weiyun.com
// @connect      aliyundrive.com
// @connect      alipan.com
// @connect      cloud.189.cn
// @connect      123pan.com
// @connect      123pan.cn
// @connect      123684.com
// @connect      123865.com
// @connect      123912.com
// @connect      quark.cn
// @connect      xunlei.com
// @connect      cowtransfer.com
// @connect      wenshushu.cn
// @connect      115cdn.com
// @connect      115.com
// @exclude      *://baike.baidu.com/*
// @exclude      *://github.com/marketplace/*
// @require      https://cdn.jsdmirror.cn/ajax/libs/jquery/3.7.1/jquery.min.js
// @require      https://cdn.jsdmirror.cn/ajax/libs/findAndReplaceDOMText/0.4.6/findAndReplaceDOMText.min.js
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_openInTab
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @homepageURL  https://github.com/dudt/netdisk-checker-rebuild
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    var manifest = {
        "autofill": true,
        "debugId": "1p4fyOm",
        "logger_level": 3,
        "maxConcurrency": 4,      // 最大并发检查请求数，防止卡顿与接口限流
        "maxCheckAttempts": 1,    // 同一条链接最多检查次数：1 = 只查一次就停止
        "retryDelay": 60000,      // 失败后多久才允许重试（毫秒）
        "scanPasses": 4,          // 打开页面后补扫几次（等懒加载内容）
        "scanInterval": 1500,     // 补扫间隔（毫秒）
        "observeDOM": true,       // 是否监听后续 DOM 变化（懒加载/无限滚动需要）
        "observeTimeout": 30000,  // 监听最多持续多久后自动关闭，防止任何形式的无限循环
        "options_page": "https://github.com/dudt/netdisk-checker-rebuild#readme"
    };
    var passMap = {};
    // 修复原版末尾多出 "|" 导致匹配所有空字符串的严重性能 Bug，并移除 /g 避免正则状态位错乱
    var panRule = /(?:lanzou|lanzov|lanzn|115|baidu|weiyun|aliyundrive|alipan|123pan|123865|123684|123912|189|quark|caiyun|xunlei|cowtransfer|wss|wenshushu|anxia)/i;
    var excludingPwdHosts = ["pan.baidu.com", "baike.baidu.com"];

    function getQuery(param) {
        return new URLSearchParams(location.search).get(param);
    }

    var container = (function () {
        var obj = {
            defines: {},
            modules: {}
        };

        obj.define = function (name, requires, callback) {
            name = obj.processName(name);
            obj.defines[name] = {
                requires: requires,
                callback: callback
            };
        };

        obj.require = function (name, cache) {
            if (typeof cache == "undefined") {
                cache = true;
            }

            name = obj.processName(name);
            if (cache && obj.modules.hasOwnProperty(name)) {
                return obj.modules[name];
            } else if (obj.defines.hasOwnProperty(name)) {
                var requires = obj.defines[name].requires;
                var callback = obj.defines[name].callback;
                var module = obj.use(requires, callback);
                cache && obj.register(name, module);
                return module;
            }
        };

        obj.use = function (requires, callback) {
            var module = {
                exports: undefined
            };
            var params = obj.buildParams(requires, module);
            var result = callback.apply(this, params);
            if (typeof result != "undefined") {
                return result;
            } else {
                return module.exports;
            }
        };

        obj.register = function (name, module) {
            name = obj.processName(name);
            obj.modules[name] = module;
        };

        obj.buildParams = function (requires, module) {
            var params = [];
            requires.forEach(function (name) {
                params.push(obj.require(name));
            });
            params.push(obj.require);
            params.push(module.exports);
            params.push(module);
            return params;
        };

        obj.processName = function (name) {
            return name.toLowerCase();
        };

        return {
            define: obj.define,
            use: obj.use,
            register: obj.register,
            modules: obj.modules
        };
    })();

    /**
     * 配置网盘参数
     **/
    container.define("constant", ["logger", "http"], function (logger, http) {
        return {
            baidu: {
                reg: /(?:https?:\/\/)?\b(e?yun|pan)\.baidu\.com\/s\/([\w\-]{5,})(?!\.)/i,
                replaceReg: /(?:https?:\/\/)?(?:e?yun|pan)\.baidu\.com\/s\/([\w\-]{5,})(?!\.)/gi,
                prefix: "https://pan.baidu.com/s/",
                checkFun: (shareId, callback) => {
                    let url = shareId.includes("http") ? shareId : "https://pan.baidu.com/s/" + shareId;
                    logger.info("baidu checkFun", url, shareId);
                    http.ajax({
                        type: "get",
                        url: url,
                        success: (response) => {
                            let state = 1;
                            if (!response) {
                                state = 0;
                            } else if (response.includes("过期时间：")) {
                                state = 1;
                            } else if (response.includes("输入提取")) {
                                state = 2;
                            } else if (response.includes("不存在") || response.includes("已失效") || response.includes("已经被取消")) {
                                state = -1;
                            }
                            callback && callback({ state: state });
                        },
                        error: function () {
                            callback && callback({ state: 0 });
                        }
                    });
                }
            },
            baidu2: {
                reg: /(?:https?:\/\/)?\b(e?yun|pan)\.baidu\.com\/(?:share|wap)\/init\?surl=([\w\-]{5,})(?!\.)/i,
                replaceReg: /(?:https?:\/\/)?(?:e?yun|pan)\.baidu\.com\/(?:share|wap)\/init\?surl=([\w\-]{5,})(?!\.)/gi,
                prefix: "https://pan.baidu.com/share/init?surl=",
                checkFun: (shareId, callback) => {
                    let url = shareId.includes("http") ? shareId : "https://pan.baidu.com/share/init?surl=" + shareId;
                    logger.info("baidu2 checkFun", url, shareId);
                    http.ajax({
                        type: "get",
                        url: url,
                        success: (response) => {
                            let state = 1;
                            if (!response) {
                                state = 0;
                            } else if (response.includes("过期时间：")) {
                                state = 1;
                            } else if (response.includes("输入提取")) {
                                state = 2;
                            } else if (response.includes("已失效") || response.includes("不存在") || response.includes("已经被取消")) {
                                state = -1;
                            }
                            callback && callback({ state: state });
                        },
                        error: function () {
                            callback && callback({ state: 0 });
                        }
                    });
                }
            },
            weiyun: {
                reg: /(?:https?:\/\/)?\bshare\.weiyun\.com\/([\w\-]{7,})(?!\.)/i,
                replaceReg: /(?:https?:\/\/)?share\.weiyun\.com\/([\w\-]{7,})(?!\.)/gi,
                prefix: "https://share.weiyun.com/",
                checkFun: (shareId, callback) => {
                    let url = shareId.includes("http") ? shareId : "https://share.weiyun.com/" + shareId;
                    http.ajax({
                        type: "get",
                        url: url,
                        success: (response) => {
                            let state = 0;
                            if (!response) {
                                state = 0;
                            } else if (response.includes("已删除")
                                || response.includes("违反相关法规")
                                || response.includes("已过期")
                                || response.includes("已经删除")
                                || response.includes("目录无效")) {
                                state = -1;
                            } else if (response.includes('"need_pwd":null') && response.includes('"pwd":""')) {
                                state = 1;
                            } else if (response.includes('"need_pwd":1') || response.includes('"pwd":"')) {
                                state = 2;
                            }
                            callback && callback({ state: state });
                        },
                        error: function () {
                            callback && callback({ state: 0 });
                        }
                    });
                }
            },
            lanzou: {
                reg: /(?:https?:\/\/)?(?:[\w\-]+\.)?\b(?:lanzou[a-z]?|lanzov|lanzn)\.com\/([\w\-]{6,})(?!\.)(?:\/)?/i,
                replaceReg: /(?:https?:\/\/)?(?:[\w\-]+\.)?(?:lanzou[a-z]?|lanzov|lanzn)\.com\/([\w\-]{6,})(?!\.)(?:\/)?/gi,
                aTagRepalce: [/(?:[\w\-]+\.)?(?:lanzou[a-z]?|lanzov|lanzn)\.com/, "leon.lanzoue.com"],
                prefix: "https://leon.lanzoue.com/",
                checkFun: (shareId, callback) => {
                    let url = shareId.includes("http") ? shareId : "https://leon.lanzoue.com/" + shareId;
                    http.ajax({
                        type: "get",
                        url: url,
                        success: (response) => {
                            let state = 1;
                            if (!response) {
                                state = 0;
                            } else if (response.includes("输入密码")) {
                                state = 2;
                            } else if (response.includes("来晚啦") || response.includes("不存在") || response.includes("链接失效")) {
                                state = -1;
                            }
                            callback && callback({ state: state });
                        },
                        error: function () {
                            callback && callback({ state: 0 });
                        }
                    });
                }
            },
            aliyun: {
                reg: /(?:https?:\/\/)?(?:www\.)?ali(?:pan|yundrive)\.com\/s\/([\w\-]{8,})(?![.\/])/i,
                replaceReg: /(?:https?:\/\/)?(?:www\.)?ali(?:pan|yundrive)\.com\/s\/([\w\-]{8,})(?![.\/])/gi,
                prefix: "https://www.alipan.com/s/",
                checkFun: (shareId, callback) => {
                    logger.info("aliyun id ", shareId);
                    http.ajax({
                        type: "post",
                        url: "https://api.aliyundrive.com/adrive/v3/share_link/get_share_by_anonymous",
                        data: JSON.stringify({ share_id: shareId }),
                        headers: { "Content-Type": "application/json" },
                        dataType: "json",
                        success: (response) => {
                            let rsp = typeof response === "string" ? (() => { try { return JSON.parse(response); } catch (e) { return null; } })() : response;
                            let state = 1;
                            if (!rsp) {
                                state = 0;
                            } else if (rsp['code'] && rsp['code'].indexOf("ShareLink") > -1) {
                                state = -1;
                            } else if (rsp['code'] || (rsp['file_count'] !== undefined && rsp['file_count'] == 0)) {
                                state = 0;
                            }
                            callback && callback({ state: state });
                        },
                        error: function () {
                            callback && callback({ state: 0 });
                        }
                    });
                }
            },
            aliyun2: {
                reg: /(?:https?:\/\/)?(?:www\.)?ali(?:pan|yundrive)\.com\/t\/([\w\-]{8,})(?![.\/])/i,
                replaceReg: /(?:https?:\/\/)?(?:www\.)?ali(?:pan|yundrive)\.com\/t\/([\w\-]{8,})(?![.\/])/gi,
                prefix: "https://www.alipan.com/t/",
                checkFun: (shareId, callback) => {
                    logger.info("aliyun2 id ", shareId);
                    http.ajax({
                        type: "post",
                        url: "https://api.aliyundrive.com/adrive/v1/share/getByAnonymous?share_id=" + shareId,
                        data: JSON.stringify({ share_id: shareId }),
                        headers: { "Content-Type": "application/json" },
                        dataType: "json",
                        success: (response) => {
                            let rsp = typeof response === "string" ? (() => { try { return JSON.parse(response); } catch (e) { return null; } })() : response;
                            let state = 1;
                            if (!rsp) {
                                state = 0;
                            } else if (rsp['code'] && (rsp['code'].includes("Exceed") || rsp['code'].includes("Share"))) {
                                state = -1;
                            }
                            callback && callback({ state: state });
                        },
                        error: function () {
                            callback && callback({ state: 0 });
                        }
                    });
                }
            },
            pan123: {
                reg: /(?:h?ttps?:\/\/)?(?:www\.)?\b(?:123pan\.(?:com|cn)|(?:pan123|123865|123684|123912)\.com)\/s\/([\w\-]{6,})\b/i,
                replaceReg: /(?:h?ttps?:\/\/)?(?:www\.)?(?:123pan\.(?:com|cn)|(?:123865|123684|123912)\.com)\/s\/([\w\-]{6,})(\.html)?\b/gi,
                aTagRepalce: [/(?:www\.)?(?:123865|123684|123912|123pan)\.(?:com|cn)/, "www.123pan.com"],
                prefix: "https://www.123pan.com/s/",
                checkFun: (shareId, callback) => {
                    logger.info("Pan123 check id " + shareId);
                    http.ajax({
                        type: "get",
                        url: "https://www.123pan.com/api/share/info?shareKey=" + shareId,
                        success: (response) => {
                            let state = 1;
                            if (!response) {
                                state = 0;
                            } else {
                                try {
                                    let rsp = typeof response == "string" ? JSON.parse(response) : response;
                                    if ((typeof response === "string" && response.includes("分享页面不存在")) || rsp.code != 0) {
                                        state = -1;
                                    } else if (rsp.data && rsp.data.HasPwd) {
                                        state = 2;
                                    }
                                } catch (e) {
                                    state = 0;
                                }
                            }
                            callback && callback({ state: state });
                        },
                        error: function () {
                            callback && callback({ state: 0 });
                        }
                    });
                }
            },
            ty189: {
                reg: /(?:https?:\/\/)?cloud\.189\.cn\/(?:t\/|web\/share\?code=)([\w\-]{8,})(?!\.)/i,
                replaceReg: /(?:https?:\/\/)?cloud\.189\.cn\/(?:t\/|web\/share\?code=)([\w\-]{8,})(?!\.)/gi,
                prefix: "https://cloud.189.cn/t/",
                aTagRepalce: [/\/web\/share\?code=/, "/t/"],
                checkFun: (shareId, callback) => {
                    http.ajax({
                        type: "post",
                        url: "https://api.cloud.189.cn/open/share/getShareInfoByCodeV2.action",
                        data: { shareCode: shareId },
                        success: (response) => {
                            let state = 1;
                            if (!response) {
                                state = 0;
                            } else if (response.includes("ShareInfoNotFound")
                                || response.includes("ShareNotFound")
                                || response.includes("FileNotFound")
                                || response.includes("ShareExpiredError")
                                || response.includes("ShareAuditNotPass")) {
                                state = -1;
                            } else if (response.includes("needAccessCode")) {
                                state = 2;
                            }
                            callback && callback({ state: state });
                        },
                        error: () => callback && callback({ state: 0 })
                    });
                }
            },
            quark: {
                reg: /(?:https?:\/\/)?\bpan\.quark\.cn\/s\/([\w\-]{8,})(?!\.)/i,
                replaceReg: /(?:https?:\/\/)?pan\.quark\.cn\/s\/([\w\-]{8,})(?!\.)/gi,
                prefix: "https://pan.quark.cn/s/",
                checkFun: (shareId, callback) => {
                    logger.info("Quark check id " + shareId);
                    http.ajax({
                        type: "post",
                        data: JSON.stringify({ pwd_id: shareId, passcode: "" }),
                        headers: { "Content-Type": "application/json" },
                        url: "https://drive-h.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc",
                        success: (response) => {
                            if (!response) {
                                callback && callback({ state: 0 });
                                return;
                            }
                            let rsp;
                            try {
                                rsp = typeof response == "string" ? JSON.parse(response) : response;
                            } catch (e) {
                                callback && callback({ state: 0 });
                                return;
                            }
                            let state = 0;
                            if (!rsp || !rsp.message) {
                                callback && callback({ state: 0 });
                                return;
                            }
                            if (rsp.message.includes("需要提取码")) {
                                callback && callback({ state: 2 });
                            } else if (rsp.message.includes("ok") && rsp.data && rsp.data.stoken) {
                                var token = rsp.data.stoken.replace(/\+/g, '%2B').replace(/\"/g, '%22').replace(/\'/g, '%27').replace(/\//g, '%2F');
                                http.ajax({
                                    type: "get",
                                    url: "https://drive-h.quark.cn/1/clouddrive/share/sharepage/detail?pwd_id=" + shareId + "&stoken=" + token + "&_fetch_share=1",
                                    success: (response2) => {
                                        let state2 = 0;
                                        try {
                                            let rsp2 = typeof response2 == "string" ? JSON.parse(response2) : response2;
                                            if (rsp2 && rsp2.data && rsp2.data.share) {
                                                if (rsp2.data.share.status == 1) {
                                                    state2 = rsp2.data.share.partial_violation ? 11 : 1;
                                                } else if (rsp2.data.share.status == 3) {
                                                    state2 = rsp2.data.share.partial_violation ? -1 : 1;
                                                } else if (rsp2.data.share.status > 1) {
                                                    state2 = -1;
                                                }
                                            }
                                        } catch (e) {
                                            state2 = 0;
                                        }
                                        callback && callback({ state: state2 });
                                    },
                                    error: function () {
                                        callback && callback({ state: 0 });
                                    }
                                });
                            } else {
                                callback && callback({ state: -1 });
                            }
                        },
                        error: function () {
                            callback && callback({ state: 0 });
                        }
                    });
                }
            },
            xunlei: {
                reg: /(?:https?:\/\/)?\bpan\.xunlei\.com\/s\/([\w\-]{20,})(?!\.)/i,
                replaceReg: /(?:https?:\/\/)?pan\.xunlei\.com\/s\/([\w\-]{20,})(?!\.)/gi,
                prefix: "https://pan.xunlei.com/s/",
                checkFun: (shareId, callback) => {
                    logger.info("checkXunlei id", shareId);
                    http.ajax({
                        type: "post",
                        data: JSON.stringify({
                            client_id: "Xqp0kJBXWhwaTpB6",
                            device_id: "925b7631473a13716b791d7f28289cad",
                            action: "get:/drive/v1/share",
                            meta: {
                                package_name: "pan.xunlei.com",
                                client_version: "1.45.0",
                                captcha_sign: "1.fe2108ad808a74c9ac0243309242726c",
                                timestamp: "1645241033384"
                            }
                        }),
                        headers: { "Content-Type": "application/json" },
                        url: "https://xluser-ssl.xunlei.com/v1/shield/captcha/init",
                        success: (response) => {
                            let rsp;
                            try {
                                rsp = typeof response === "string" ? JSON.parse(response) : response;
                            } catch (e) {
                                callback && callback({ state: 0 });
                                return;
                            }
                            if (!rsp || !rsp.captcha_token) {
                                callback && callback({ state: 0 });
                                return;
                            }
                            let token = rsp.captcha_token;
                            http.ajax({
                                type: "get",
                                url: "https://api-pan.xunlei.com/drive/v1/share?share_id=" + shareId.replace("https://pan.xunlei.com/s/", ""),
                                headers: {
                                    "x-captcha-token": token,
                                    "x-client-id": "Xqp0kJBXWhwaTpB6",
                                    "x-device-id": "925b7631473a13716b791d7f28289cad",
                                },
                                success: (response2) => {
                                    let state = 1;
                                    if (!response2) {
                                        state = 0;
                                    } else if (response2.includes("NOT_FOUND")
                                        || response2.includes("SENSITIVE_RESOURCE")
                                        || response2.includes("EXPIRED")) {
                                        state = -1;
                                    } else if (response2.includes("PASS_CODE_EMPTY")) {
                                        state = 2;
                                    }
                                    callback && callback({ state: state });
                                },
                                error: function () {
                                    callback && callback({ state: 0 });
                                }
                            });
                        },
                        error: function () {
                            callback && callback({ state: 0 });
                        }
                    });
                }
            },
            nainiu: {
                reg: /(?:https?:\/\/)?(?:[\w\-]+\.)?\bcowtransfer\.com\/s\/([\w\-]{10,})(?!\.)/i,
                replaceReg: /(?:https?:\/\/)?(?:[\w\-]+\.)?cowtransfer\.com\/s\/([\w\-]{10,})(?!\.)/gi,
                prefix: "https://cowtransfer.com/s/",
                checkFun: (shareId, callback) => {
                    logger.info("nainiu check id", shareId);
                    http.ajax({
                        type: "get",
                        url: "https://cowtransfer.com/core/api/transfer/share?uniqueUrl=" + shareId,
                        success: (response) => {
                            let state = 1;
                            if (!response) {
                                state = 0;
                            } else {
                                try {
                                    let rsp = typeof response == "string" ? JSON.parse(response) : response;
                                    if (rsp.code != "0000") {
                                        state = -1;
                                    } else if (rsp.data && rsp.data.needPassword) {
                                        state = 2;
                                    }
                                } catch (e) {
                                    state = 0;
                                }
                            }
                            callback && callback({ state: state });
                        },
                        error: function () {
                            callback && callback({ state: 0 });
                        }
                    });
                }
            },
            wenshushu: {
                reg: /(?:https?:\/\/)?\b(?:t\.wss\.ink|wss1\.cn|www\.wenshushu\.cn|ws28\.cn)\/f\/([\w\-]{8,})(?!\.)/i,
                replaceReg: /(?:https?:\/\/)?(?:t\.wss\.ink|wss1\.cn|www\.wenshushu\.cn|ws28\.cn)\/f\/([\w\-]{8,})(?!\.)/gi,
                prefix: "https://www.wenshushu.cn/f/",
                checkFun: (shareId, callback) => {
                    logger.info("wenshushu id", shareId);
                    http.ajax({
                        type: "post",
                        url: "https://www.wenshushu.cn/ap/task/mgrtask",
                        data: JSON.stringify({ tid: shareId }),
                        headers: {
                            "Content-Type": "application/json",
                            "x-token": "wss:7pmakczzw6i"
                        },
                        dataType: "json",
                        success: (response) => {
                            let rsp = typeof response === "string" ? (() => { try { return JSON.parse(response); } catch (e) { return null; } })() : response;
                            let state = 1;
                            if (!rsp) {
                                state = 0;
                            } else if (rsp.code != 0) {
                                state = -1;
                            }
                            callback && callback({ state: state });
                        },
                        error: function () {
                            callback && callback({ state: 0 });
                        }
                    });
                }
            },
            pan115: {
                reg: /(?:h?ttps?:\/\/)?(?:www\.)?\b(?:115|anxia|115cdn)\.com\/s\/([\w\-]{8,})(?!\.)/i,
                replaceReg: /(?:h?ttps?:\/\/)?(?:www\.)?(?:115|anxia|115cdn)\.com\/s\/([\w\-]{8,})(?!\.)/gi,
                aTagRepalce: [/115\.com/, "115cdn.com"],
                prefix: "https://115cdn.com/s/",
                checkFun: (shareId, callback) => {
                    logger.info("Pan115 check id " + shareId);
                    shareId = shareId.replace("https://115cdn.com/s/", "");
                    http.ajax({
                        type: "get",
                        url: "https://115cdn.com/webapi/share/snap?share_code=" + shareId + "&receive_code=",
                        success: (response) => {
                            let state = 0;
                            if (response) {
                                try {
                                    let rsp = typeof response == "string" ? JSON.parse(response) : response;
                                    if (rsp.state) {
                                        state = 1;
                                    } else if (rsp.error && rsp.error.includes("访问码")) {
                                        state = 2;
                                    } else if (rsp.error && (rsp.error.includes("不存在或已被删除") || rsp.error.includes("分享已取消"))) {
                                        state = -1;
                                    }
                                } catch (e) {
                                    state = 0;
                                }
                            }
                            callback && callback({ state: state });
                        },
                        error: function () {
                            callback && callback({ state: 0 });
                        }
                    });
                }
            }
        };
    });

    /** step 2 auto_fill **/
    container.define("auto_fill", ["checkManage"], function (checkManage) {
        var obj = {
            run() {
                this.autoFillPassword();
                return false;
            },
            opt: {
                baidu: {
                    reg: /((?:https?:\/\/)?(?:yun|pan)\.baidu\.com\/(?:s\/\w*(((-)?\w*)*)?|share\/\S{4,}))/,
                    host: /(pan|yun)\.baidu\.com/,
                    input: ['#accessCode', '.share-access-code'],
                    button: ['#submitBtn', '.share-access .g-button'],
                    name: '百度网盘'
                },
                aliyun: {
                    reg: /((?:https?:\/\/)?(?:(?:www\.)?(?:aliyundrive|alipan)\.com\/s|alywp\.net)\/[A-Za-z0-9]+)/,
                    host: /www\.(?:aliyundrive|alipan)\.com|alywp\.net/,
                    input: ['.ant-input[placeholder="请输入提取码"]', 'form .ant-input', 'input[name="pwd"]'],
                    button: ['.button--fep7l', 'button[type="submit"]'],
                    name: '阿里云盘'
                },
                weiyun: {
                    reg: /((?:https?:\/\/)?share\.weiyun\.com\/[A-Za-z0-9]+)/,
                    host: /share\.weiyun\.com/,
                    input: ['.mod-card-s input[type=password]', 'input.pw-input'],
                    button: ['.mod-card-s .btn-main', '.pw-btn-wrap button.btn'],
                    name: '微云'
                },
                lanzou: {
                    reg: /((?:https?:\/\/)?(?:[A-Za-z0-9\-.]+)?(?:lanzou[a-z]?|lanzov|lanzn)\.com\/[A-Za-z0-9_\-]+)/,
                    host: /(?:[A-Za-z0-9.\-]+)?(?:lanzou[a-z]?|lanzov|lanzn)\.com/,
                    input: ['#pwd'],
                    button: ['.passwddiv-btn', '#sub'],
                    name: '蓝奏云'
                },
                tianyi: {
                    reg: /((?:https?:\/\/)?cloud\.189\.cn\/(?:t\/|web\/share\?code=)?[A-Za-z0-9]+)/,
                    host: /cloud\.189\.cn/,
                    input: ['.access-code-item #code_txt', 'input.access-code-input'],
                    button: ['.access-code-item .visit', '.button'],
                    name: '天翼云盘'
                },
                xunlei: {
                    reg: /((?:https?:\/\/)?pan\.xunlei\.com\/s\/[\w-]{10,})/,
                    host: /pan\.xunlei\.com/,
                    input: ['.pass-input-wrap .td-input__inner'],
                    button: ['.pass-input-wrap .td-button'],
                    name: '迅雷云盘'
                },
                pan123: {
                    reg: /((?:https?:\/\/)?(?:www\.)?(?:123pan\.(?:com|cn)|(?:123684|123865|123912)\.com)\/s\/[\w-]{6,})/,
                    host: /(?:www\.)?(?:123pan\.(?:com|cn)|(?:123684|123865|123912)\.com)/,
                    input: ['.ca-fot input', '.appinput .appinput', 'input.ant-input'],
                    button: ['.ca-fot button', '.appinput button', 'button.ant-btn-primary'],
                    name: '123云盘'
                },
                pan115: {
                    reg: /((?:https?:\/\/)?(115|anxia|115cdn)\.com\/s\/[\w-]{6,})/,
                    host: /(115|anxia|115cdn)\.com/,
                    input: ['.form-decode input'],
                    button: ['.form-decode .button', '.form-decode .submit a'],
                    name: '115'
                },
                quark: {
                    reg: /((?:https?:\/\/)?pan\.quark\.cn\/s\/[\w-]{6,})/,
                    host: /pan\.quark\.cn/,
                    input: ['.ant-input[placeholder="请输入提取码，不区分大小写"]', '.ant-input'],
                    button: ['button[type="button"]', '.ant-btn-primary'],
                    name: 'quark'
                },
            },
            panDetect() {
                let hostname = location.hostname;
                for (let name in this.opt) {
                    let val = this.opt[name];
                    if (val.host.test(hostname)) {
                        return name;
                    }
                }
                return '';
            },
            isHidden(el) {
                try {
                    return el.offsetParent === null;
                } catch (e) {
                    return false;
                }
            },
            sleep(time) {
                return new Promise((resolve) => setTimeout(resolve, time));
            },
            queryFirst(selectors) {
                for (let i = 0; i < selectors.length; i++) {
                    let el = document.querySelector(selectors[i]);
                    if (el) return el;
                }
                return null;
            },
            autoFillPassword() {
                let query = getQuery('pwd');
                let hash = location.hash.slice(1).replace("/list/share", "");
                let pwd = query || hash;
                let panType = this.panDetect();
                let val = this.opt[panType];
                if (!val) return;
                if (!pwd) {
                    let shareId = window.location.pathname.substring(window.location.pathname.lastIndexOf("/") + 1);
                    if (shareId === "init") {
                        shareId = getQuery('surl');
                    }
                    let item = checkManage.getItem(panType, shareId);
                    if (!item && panType === "baidu") {
                        item = checkManage.getItem("baidu2", shareId);
                    }
                    if (item) {
                        pwd = item.pwd;
                    }
                }
                pwd && this.doFillAction(val.input, val.button, pwd);
            },
            doFillAction(inputSelector, buttonSelector, pwd) {
                let maxTime = 10;
                // 用 once 守卫：填过就不再填，避免 SPA 重渲染时反复触发同一次自动填充/点击
                let filled = false;
                let ins = setInterval(() => {
                    maxTime--;
                    if (filled) {
                        clearInterval(ins);
                        return;
                    }
                    let input = this.queryFirst(inputSelector);
                    let button = this.queryFirst(buttonSelector);

                    if (input && !this.isHidden(input)) {
                        filled = true;
                        clearInterval(ins);
                        let lastValue = input.value;
                        input.value = pwd;
                        let event = new Event('input', { bubbles: true });
                        let tracker = input._valueTracker;
                        if (tracker) {
                            tracker.setValue(lastValue);
                        }
                        input.dispatchEvent(event);

                        this.sleep(1000).then(() => {
                            button && button.click();
                        });
                    } else if (maxTime <= 0) {
                        clearInterval(ins);
                    }
                }, 800);
            }
        };

        return obj;
    });

    container.define("gm", [], function () {
        var obj = {
            ready: function (callback) {
                if (typeof GM_getValue != "undefined") {
                    callback && callback();
                } else {
                    setTimeout(function () {
                        obj.ready(callback);
                    }, 100);
                }
            }
        };
        return obj;
    });

    /** common **/
    container.define("gmDao", [], function () {
        var obj = { items: {} };

        obj.get = function (name) {
            return GM_getValue(name);
        };
        obj.set = function (name, item) {
            GM_setValue(name, item);
        };
        obj.remove = function (name) {
            GM_deleteValue(name);
        };
        return obj;
    });

    container.define("ScopeDao", [], function () {
        return function (dao, scope) {
            var obj = {
                items: {},
                syncTimer: null
            };

            obj.get = function (name) {
                return obj.items[name];
            };

            obj.getAll = function () {
                return obj.items;
            };

            obj.set = function (name, item) {
                obj.items[name] = item;
                obj.syncDebounced();
            };

            obj.remove = function (name) {
                delete obj.items[name];
                obj.syncDebounced();
            };

            obj.init = function () {
                var items = dao.get(scope);
                if (items instanceof Object) {
                    // 自动清理超过 7 天的旧缓存，防止存储无限膨胀导致序列化卡顿
                    var now = Date.now();
                    var maxAge = 7 * 86400 * 1000;
                    var cleaned = false;
                    for (var k in items) {
                        if (items[k] && items[k].check_time && (now - items[k].check_time > maxAge)) {
                            delete items[k];
                            cleaned = true;
                        }
                    }
                    obj.items = items;
                    if (cleaned) {
                        obj.syncDebounced();
                    }
                }
            };

            // 防抖批量写入：避免几百个链接同时完成时连续同步调用 GM_setValue 阻塞主线程
            obj.syncDebounced = function () {
                if (obj.syncTimer) clearTimeout(obj.syncTimer);
                obj.syncTimer = setTimeout(function () {
                    obj.syncTimer = null;
                    dao.set(scope, obj.items);
                }, 500);
            };

            obj.init();
            return obj;
        };
    });

    // 网络请求库 GM_xmlhttpRequest
    container.define("http", ["logger"], function (logger) {
        return {
            ajax: function (option) {
                var details = {
                    method: option.type,
                    url: option.url,
                    responseType: option.dataType,
                    timeout: option.timeout || 10000,
                    onload: function (result) {
                        option.success && option.success(result.response);
                    },
                    onerror: function (result) {
                        option.error && option.error(result.error);
                    },
                    ontimeout: function () {
                        option.error && option.error("timeout");
                    }
                };

                if (option.data instanceof Object) {
                    if (option.data instanceof FormData) {
                        details.data = option.data;
                    } else {
                        var formData = new FormData();
                        for (var i in option.data) {
                            formData.append(i, option.data[i]);
                        }
                        details.data = formData;
                    }
                } else {
                    details.data = option.data;
                }

                if (option.headers) {
                    details.headers = option.headers;
                }

                logger.debug("xmlhttpRequest", details);
                GM_xmlhttpRequest(details);
            }
        };
    });

    // 日志库
    container.define("logger", [], function () {
        var obj = {
            constant: {
                DEBUG: 0,
                INFO: 1,
                WARN: 2,
                ERROR: 3,
                NONE: 4
            }
        };

        obj.debug = function () { obj.log(obj.constant.DEBUG, ...arguments); };
        obj.info = function () { obj.log(obj.constant.INFO, ...arguments); };
        obj.warn = function () { obj.log(obj.constant.WARN, ...arguments); };
        obj.error = function () { obj.log(obj.constant.ERROR, ...arguments); };
        obj.d = function () { obj.log(obj.constant.NONE, ...arguments); };
        obj.log = function () {
            if (arguments[0] < manifest["logger_level"]) {
                return false;
            }
            console.log(...Array.from(arguments).slice(1).filter(data => data));
        };

        return obj;
    });

    container.define("appRunner", ["logger", "$"], function (logger, $, require) {
        var obj = {};

        obj.run = function (appList) {
            $(function () {
                obj.runAppList(appList);
            });
        };

        obj.runAppList = function (appList) {
            var url = location.href;
            $(document).ready(function () {
                if (excludingPwdHosts.indexOf(location.host) == -1) {
                    setTimeout(() => $("div[href]").removeAttr("href"), 5000);
                    // 避免使用 $("body").clone(true) 深度克隆全页 DOM
                    var rawText = (document.body ? document.body.textContent : "")
                        .replaceAll("如遇到有带x的提取码请手打输入", "提取码");
                    // 使用非贪婪且限制长度的匹配，防止在长文本页发生正则灾难性回溯
                    var pwdReg = /(?:baidu\.com|lanzou[a-z]?\.com|lanzov\.com|lanzn\.com|weiyun\.com|189\.cn|115\.com|115cdn\.com|aliyundrive\.com|alipan\.com|123pan\.(?:com|cn)|(?:123684|123865|123912)\.com|quark\.cn|xunlei\.com)\/[^\s"<>]{3,120}?(?:\s*[\(（]?(?:(?:提取|访问|訪問|密)[码碼]|Code:)\s*[:：﹕=]?\s*|[\?&](?:pwd|password)=|#)([a-zA-Z\d]{4,8})/gi;
                    var match;
                    while ((match = pwdReg.exec(rawText)) !== null) {
                        let full = match[0]
                            .replace("/web/share?code=", "/")
                            .replace("/share/init?surl=", "/");
                        let r = /\/([\w\-]{4,})(?:\.html)?[\s\S]*?([a-zA-Z\d]{4,8})$/i.exec(full);
                        if (r) {
                            passMap[r[1]] = r[2];
                        }
                    }

                    // 百度知道 网盘链接解析
                    var baiduZhidaos = document.querySelectorAll(".ikqb-reply-yun");
                    for (let baiduZhidao of baiduZhidaos) {
                        var bdcode = baiduZhidao.getAttribute('data-code');
                        var bdlink = baiduZhidao.getAttribute('data-href');
                        if (bdcode && bdlink) {
                            passMap[bdlink.substring(bdlink.lastIndexOf("/") + 1)] = bdcode;
                        }
                    }

                    var discourseLinks = document.querySelectorAll("a.inline-onebox,a.onebox");
                    for (let link of discourseLinks) {
                        if (panRule.test(link.href) || link.textContent.includes("请输入提取码")) {
                            let r = /提取码:\s*(\w+)\b/i.exec(link.parentElement ? link.parentElement.textContent : "");
                            if (!r) continue;
                            let bdcode = r[1];
                            let bdlink = link.href;
                            passMap[bdlink.substring(bdlink.lastIndexOf("/") + 1)] = bdcode;
                            if (bdcode && link.href.indexOf("pwd=") === -1) {
                                let linker = link.href.indexOf("?") > -1 ? "&" : "?";
                                link.href = link.href + linker + "pwd=" + bdcode;
                            }
                        }
                    }
                }
                for (let i in appList) {
                    var app = appList[i];
                    if (!obj.matchApp(url, app)) {
                        continue;
                    }
                    if (require(app.name).run() == true) {
                        break;
                    }
                }
            });
        };

        obj.matchApp = function (url, app) {
            var match = false;
            app.matchs && app.matchs.forEach(function (item) {
                if (item == "*" || (url && url.match(item))) {
                    match = true;
                }
            });
            return match;
        };

        return obj;
    });

    /** custom **/
    container.define("factory", ["gmDao", "ScopeDao"], function (gmDao, ScopeDao) {
        var obj = { daos: {} };
        obj.getStorageDao = () => obj.getDao("storage", () => ScopeDao(gmDao, "$storage"));
        obj.getCheckDao = () => obj.getDao("check", () => ScopeDao(gmDao, "$check"));
        obj.getDao = function (key, createFunc) {
            if (!obj.daos.hasOwnProperty(key)) {
                obj.daos[key] = createFunc();
            }
            return obj.daos[key];
        };
        return obj;
    });

    // 网盘状态icon资源
    container.define("resource", [], function () {
        var obj = {};
        obj.getErrorIcon = () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACYAAAAmCAYAAACoPemuAAACm0lEQVR4Xu2Xv47TQBDGfSf+iGQdCSS4gpKr4I6TvQl0lLwEb0HFS9BQ09JR8wQ0UNDQIihAoCsgdhJfOHF3ZsaSrfG36/U6cVIgPumnKPbM7Hh2Z70Ogv/aotI4fJPqcDrXYT4fE/S7oN+ZDpczrb4u9PAx+mxEeRDspFH4jgbO0w7kD0b5/L66hfF6URqpV10TQrii9HCXMPbK4oA4yHqoFzhGJ2XjQWQG7YdEhz9xPC9lR4OIpu4CA/ZJEodfcNxWYZBNQQ//FsduVP9ryk1+GFzHHAzNYvUaHTcNdzvmURPd3UWnPvCZgUQPn2E+lWgnf48OSKKv3ilsPRtDVsO1D/4eO6rmcsRBWGcT00ZyAoPRa+o72kjm++qmtK+Ehg1cSJ+m5DApujZFGxM1lT6Fklh9NA3tnE+wEvX7WFm6lmIMG5ltOunGDA1dcKWkPyfL17FSSce40reQT+dYqE0rnyLkf2qmXxYfJ9K/EJ+n0MgHrFyp1GtNmWCcVStWkD+ESml1ijbe3BvdkLFWTmxpW7BBc7e2gXH4KTM0asPsPnVW/++3CUukfxnkBxq5wEqV3YdrjhsCfV1I30LTSD1CoyYwqdRc6F6bMPJnUl+rldDQhjl99s0TK5d6TOs0Gj6VPpXanowbRNq3bZ74hjhtiU/GO9K+0uJguIfGElmt1Jy+Jqppben8T6WdVXz8sDhVcHL0Xv2G111wTP4QxusSzMNQroPL6LQF/M79tHZeWpw3Aq87HN+pZIUNtysL3TGpUvRhcozB+oKTyu8GV3BMb/FHKQZdF+f5vouyw4FuaXVvaIl8wPhri7aK53z8xcE8+YzxetfJ0bXb9OTLtr3pnF/g8egJzdsuxtiajg+CPTrk7dvfKf+Q/gIqVFE2PCWqFwAAAABJRU5ErkJggg==";
        obj.getSuccessIcon = () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACYAAAAmCAYAAACoPemuAAACrUlEQVR4Xt2Yu2sUQRzHV/BFxNzMXhEQkRAEJbd763+gnYIWVjYitrYBC8FaSzttFBs7LQQLMdnZ3SSKWFhoYWFvOl+IoImJ5283Znf2O7PPmz3QL3zIcff9PZidnUcs63/V4Nm07QTskhvaC8PAvuoIfu7Y0tQh9E1EjmD3qIn1YWiP6G8xESHsNYw3qtlodv9wmavFa+Kt9keu35vDvGNpGPAnWKgtruDrmL+V3IBvYfKxoSkwEPYZrFVPI2uXt6JJahAn4texbKW6bmoHJ+xdwNqFooBNTNAlWF8rmlMPMLBzoorm5h9ae5WgSSHYXewnFb3K5t/AuoQlo6aYTRLvEhU7BW1nt7EnGi32CI0GebVThz5/0fye4C1rRo1W9w00GkGw93KdOZ/3FI+E7E1UNcxtoDn7Dus4Pj+LvlyMzxYydwdvIzW1khXY1syidaDGAGSnEc+3T2sMKiG/QWvOYTrKqL9JUFNvpX5Soa+A71mAYJc1hhx0EPSlGhTDP6En8QX8jeyLlYyUxlvARhroBPyKxgDwO1KtRPR9rjk3YEvoqfn4ZDbTYFoqzmsMeQoWQGr487aHp0uCLCVPBW5g/0iD531+BA1FSDVT0ZwL8LuGjy+FpsLHXCI0FFK14VqtHl+Gz0QuWXJxQFMRFc0p/gaciqzdmOwDmkrRzLm2j08GcyZCUyXSyLnPe7z145OQ+0nlrarGOnhNpkEJg5fTNvaUKL73oXlSxIOC/eSEAZPi6FNrH/aiyMRcaYIn2GPsQSs3ZCcxuDOEvYX1S0Ur8DUliWHiuyvWrSU34hcxmUF+Y73GMj3n6BSS33bGEe3698dt8MSL/iheiDG3EVGDt+LbDBYtg+brz+PiYB9zdSa6B96kwmvEN+LX3xGN/+/xNTmfvbb2YMw/rz8ZKxg+Um5CmgAAAABJRU5ErkJggg==";
        obj.getLockIcon = () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACYAAAAmCAYAAACoPemuAAABwUlEQVR4Xu1XvUoDQRA+0EoMub+oJBpv9wQLFSzsbASfwc4nsLMwcffERPEJbH0BQXwG2zQWEmttRIuA2Ch2Ohs4vMzueUncjRDug6/Zmdnvy85m99aycuQYIzi0XnWr9RU8/i/wKLv3aPTlUY4IY4S94HzjcEK+KptR0yH8HNcbgVNlm1g8iy5hj3ge7cCiom1OwC5LwcGcHTTs4kK04YcNyZxDDs/wXNoAe+qzR5DwZ5wTA1q4i83hHD0o7U33CIVHmUIu4afJGmhpC+f8GSBykRQpl5tTOEcF8QOMrhr8/d/jycUewvE0uJRfGTUGAm3YYy1BWL07HE9Dkda24zowpr+VRuCFx93NaoIujTpYry/Asj8ke2yE8/sVrJsJ6O2HNJFmwgW+hnUzMZix7oX8ChygxrQxdATMED4r5aTQqLFChXlSLWE3OE9Fo8Ysa2dCruUM56lo1Jgd8HVc61L2hvNUNGpM0LK2JuM6OOmvcTyNxo1B7m1c5y81FXE1c2MCubH++PPk8sXFL8XVHIEx+PztvhX5Ex7/jSMxNgyHMgbnUQdPpJs2iRaxbib85VpB/YzXQz880f8dnyPHuOIbV69cHR4KWOMAAAAASUVORK5CYII=";
        obj.getOtherIcon = () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACYAAAAmCAYAAACoPemuAAAD5UlEQVR4Xr2YT2jTUBzHMxR0wmDaNXndxIk6EA9TEPQo/rns5MHtJjK2JrHrhhcRBP/cRHYTFMXDQBAVdhVBBGEHDx48iHhQEQ8DFYS5Jenabd3i71eX9uXbpE3S6gce697vb977vT+JoiTAVZSOwlhPr2WIT+v5jLt8UbgONdsUboH+rk5k3JUJ4Vq6pv8a6+lC+7Zjm+nhNQrKCcRpnLxjimfor2VKo+kBJyBg3MY+LFN7i/4TUcrVB8BgPJW2ITbo/zX+zdOJemhTzHf3Y6xIcB1xraBTbpv9s4uGuh/tZGxTm+JpRPta0x6iTUPcEWVL0NQVc/y06mHUb8b8yO7OyqgG+LQN7T3qhxKUFDl4hXpxoQfuDJpmx1BfoG4dQUPv6OkjqNcKgaOXTZ1CvSo0KnUGPA2o1w7KE/DwlCzXNeopTlbVMKliTt2HemFY+b7UgpHZ40ykhTt1YBvKg1jJ+WdnjZJFnbq6sgxtBnUQ2tnH3Mn6qee2wf165hzaIBj3u9G7oypc1NUzsrBETyLZBkL71rxsw1sI12d9catzaCtjG+pdeKhCVYjOSk32Jzojr3i6/MQoXzZSx2V/KEdw1Lz+DrmTz0LZKAh55aLMgxbSm1ry6m2Uy1immJFzcAwxrfwe7+6XO6nNoiEi6a6jzIPq72otkPYU5TK8WOQcVnkRYK1YRuogGiaBpvub55OOLhPlSFmaBd7nfB1B9ZIEOgOveT65flEeBOl+lQfItwtHddIISuqDHID3R9QJgnTv+RILWxFJKMu3EboGobwRli4uhyZGv8toEBXfGUtXbpQ3g2xyvsTkqawUXUJa9WHr4oYvMfkymLT4HVO7VHWqa09QHgWyfe1LDK85aBAFKvDBJTNznlshmzmK8ihUzlY5D37FkjtorifR6H9QkHLgJBWX3vvkxHhfQ6N/jW3uOuQbHFP8PfhxOt3RvdvBtinuTWUrjfZJ7I8CXp2qpw+/rciCJBttzV77gbJG8HuAHLtuVeNG6w4pkW6hzPKFVF/VjusjBhiXVvgtnwJ1zskKcUeNjyK6viy4Qff2ECy6RDYcLQ/MPlSxDRSyqbNyLG6hNxs335VCZf5qg3qtUtTFCYxDF8ufqOeDFB6gEX+/QL2k0JQ/Rv+Ry4a/e6Fx5fuXod1B3TiQn3X0G7tc6PXtOTqpJGjypyTx6MtQtHdHJ7tzEPcpr0UeKcQZ1057XwqD2ubG/JGSneajzDK1cfp7nabrJZ8g+Pblb9pnjBcLXv7NvpHFaTx1S6PpAYyTmOERZQs5LmGgqI0TohKYRr9thQLdD6sbuVW+1xriHSV1DH004w9PygmOZFyzWwAAAABJRU5ErkJggg==";
        obj.getPartialIcon = () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAHhlWElmTU0AKgAAAAgABAEaAAUAAAABAAAAPgEbAAUAAAABAAAARgEoAAMAAAABAAIAAIdpAAQAAAABAAAATgAAAAAAAADYAAAAAQAAANgAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAAADCgAwAEAAAAAQAAADAAAAAAVrtQ3wAAAAlwSFlzAAAhOAAAITgBRZYxYAAABb9JREFUaAXtWd9vG0UQ3t3z2aljN0nlNKVSlLaEuCEQUfIACIQET5UQBSRStS8IIfHGW976lH8g/wBIiCd+KEhAEVKfICCkgsBUBBwnURuIUpGmTohaO45j+27Z75xDe3t79jnEiIic5NzM7OzMN3t7ezMTQg6vwxX4f6+AsZ/hT05OskzmzjEWT/XFjFR/pCM1aMZS/TEz1W10puJHzJRx5cpbOzMzM3y//NJ/amhsbMz8ZbHwICE0TWySJpzHG9qktEQYWSCELzw6lLyVyWSqDfWbDO45AADPLm4/adu1ZwgnsSZ+9MOU7DAW+XZk6Mh3ew2k5QA457Sz8+FzFrWe45wk9chak1JKCgY3vtramrtBKW1pe7UUwMjISHRpufqKZZPh1iCG0zYYnTszEPk0m81Wws0QGzesYk/PWFepWrzMbX4iYA5nhK5Qg85zxldNmxf6+uwCdNfWWLLKaJLa9AFu8bM24f1CrPVNGb0TNxMfbG5m7gX48Yi1RjwagnHAV7be5NxOqGMCR41S9v3ROLuez2eL/nG/pLd3JHG/ZD8l7D0hXuaIqiHsFePRznfCBNH0GMW2Wfuz/JrY+8dURwYjuXg0+X7x/uxcqZQP/diha1XXl44mTv1s80q3eJd6vbZ5tMarp88+dGI2n89b3jEvx7ysl8MLiz2v2zaMGV9uFxc/Clql8fFxI5ZMp/ED7bVc5zAXNmBLHYfPpeXay8Cgjsl8w8F4fPjxGrEuyBNAR5nxcbGY+1WVuzwAf/7F7Ou7e10c+3TlxRdG35ueng5czURi+JGKbb3q2nDvEWJcLZVyP7m8eteuDJRwzq9tlC8J0nPGY7VKxdwPqiGZv7ViDYmVe9qViXOxa3Hp7h9WZWPDlan3SmX9rhk7bot5p+UxTvnJx0ZP/bi6umrLcpcO3EL4SKnnPPZ8uZj7xp0cdDcs//dBJ1PnwzZ8yHJgABZZJtPaALD6zhdW1hSnTYeZvOYRtYGp+6A12TSwAJMsc2ltAE5uo6QHOCqDXljX2H7c4QO+PLYElnq+5ZE6jDYAJzHz6nKc815R+7hdX0pKIZJFzeULACmxk1VKyjhFwn6kpGl7JuELPj0GRKbrYPMIiTjhlGtq6sMeNSVGeqCotZ31+RRpuoNN8ewLoGr4TxDkNsq8trM6nzpsvgCMqj8AJGZtR6w40PnUYfMFYDN/AG5WqfhoK6vzqcPmC6CtqNpg3BcAs4lvuyCfb8V3jRnbqr5OpurIvM6nDpsvAMv0B4BiRDbejD7e3bWEMtHVAw2Zy4e563zqsPmKCdMihR3FAyopIfpNEQeyt29f306l0m8Xy3QMSokOnoEscIJmgNrkpCoGtrIi9D2BiYlLmwStD+lCGSixocj19YVCuTg/gx/oUJMkJW6JFo18CUwONlkmaG09EE2mXyIWPyfp8q5Oc+rf+hqj5Ly3VZ3w4DPojUph4TMJk0P6nkBdgYvGk+eiqGE9kiZMmIosyMSuL2VxfZic6doA0DETz8bzKqAAR3Ef5FSWuxWZ2HqX8UN1FlRWyvNAw0e92JdGBBYHkyRySW1FhurH7OijwtAZV1HcGQrwWmUjK8m05F4qMtcQjSRFHUz6XB53ZkS+Xvl9VnuIaJ8AJqHdJx+FkKGh1ZEYfhZ0Oy7YVptmwAAsQf4CA0CvEu0+daJtW8+jAFflMn/h/OhNOR0GDZmso9KwCduqHBga9U2VF8U7HS2NeDJ9UV0VaKG4b1QfY89fvTY7CF2Ab9SRwMprwYtWY6kwP92oX9owADhHY+vmcu0NXW8IBThq2L2Wmnhhy9XCed0CocU4OBB5t1mftGkACOK/3FoMFcDfQRzU5i4CwNX+9jrJnRkwP2m2bepo6n9DPwF3El7sA/sPDjcI3A/sv5jkINxADuQ/+dRAwKNvg9YHugcowN0aFpUUihHk80iJhZ62UauzeSg7XIHDFWi8An8B0+Xbcz5Btc4AAAAASUVORK5CYII=";
        obj.getStyleText = () => ".one-pan-tip { cursor: pointer;}" +
            ".one-pan-tip::before {background-position: center;background-size: 100% 100%;background-repeat: no-repeat;box-sizing: border-box;width: 1em;height: 1em;margin: 0 1px .15em 1px;vertical-align: middle;display: inline-block;}" +
            ".one-pan-tip-success::before {content: '';background-image: url(" + obj.getSuccessIcon() + ")}" +
            ".one-pan-tip-error {text-decoration: line-through;}" +
            ".one-pan-tip-error::before {content: '';background-image: url(" + obj.getErrorIcon() + ")}" +
            ".one-pan-tip-partial::before {content: '';background-image: url(" + obj.getPartialIcon() + ")}" +
            ".one-pan-tip-other::before {content: '';background-image: url(" + obj.getOtherIcon() + ")}" +
            ".one-pan-tip-lock::before{content: '';background-image: url(" + obj.getLockIcon() + ")}";
        return obj;
    });

    // 检测网盘链接
    container.define("api", ["logger", "constant"], function (logger, constant) {
        return {
            checkLinkLocal: function (shareSource, shareId, callback) {
                logger.info("checkLinkLocal", shareSource, shareId);
                var rule = constant[shareSource];
                if (rule && typeof rule["checkFun"] === "function") {
                    rule["checkFun"](shareId, callback);
                } else {
                    callback({ state: 0 });
                }
            }
        };
    });

    // 重构后的并发队列与缓存管理器：真正限制并发数 + 相同链接合并请求 + 内存直接读取
    container.define("checkManage", ["logger", "factory", "api"], function (logger, factory, api) {
        var obj = {
            runningCount: 0,
            maxConcurrency: manifest["maxConcurrency"] || 4,
            queues: [],
            inflight: {},   // key -> [callbacks]：同一时刻同一条链接只发一次请求
            memo: {},       // key -> { state, attempts, nextAt, done }：本页内存状态，决定“还查不查”
            okTTL: 86400 * 1000,   // 有明确结果（有效/需密码/已失效/部分违规）：1 天内不再查
            retryDelay: manifest["retryDelay"] || 60000, // 失败(状态 0)后的重试间隔
            maxAttempts: (manifest["maxCheckAttempts"] > 0 ? manifest["maxCheckAttempts"] : 1), // 同一条链接最多查几次
            taskTimeout: 20000     // 单个任务最长占用并发槽时间，防止队列被卡死
        };

        obj.activeQueue = function () {
            while (obj.runningCount < obj.maxConcurrency && obj.queues.length > 0) {
                var task = obj.queues.shift();
                obj.runningCount++;
                obj.executeTask(task);
            }
        };

        obj.executeTask = function (task) {
            var done = false;
            var timer = setTimeout(function () {
                // 兜底：某个 checkFun 既不回调也不报错时，别让并发槽永久被占住
                finish({ state: 0 });
            }, obj.taskTimeout);

            function finish(res) {
                if (done) return;
                done = true;
                clearTimeout(timer);
                obj.runningCount--;
                try {
                    task.callback && task.callback(res);
                } catch (e) {
                    logger.error(e);
                }
                // 稍微让出主线程，避免密集回调卡顿 UI
                setTimeout(obj.activeQueue, 20);
            }

            try {
                // 走“只执行、不再判定”的通道：入队前已经 reserve 过，
                // 若再走 checkLink 的 shouldSkip 就会被自己挡掉
                obj.runCheck(task.share_source, task.share_id, task.pwd, finish);
            } catch (err) {
                logger.error(err);
                finish({ state: 0 });
            }
        };

        /**
         * 决定这条链接现在还要不要发起请求。
         * 返回 true 表示可以直接用 memo 里的结果回复调用方，不再请求。
         */
        obj.shouldSkip = function (key, now) {
            var m = obj.memo[key];
            if (!m) return false;
            // 已拿到明确结果，或重试次数已用完：本页生命周期内不再请求
            if (m.done) return true;
            // 上次失败但还没到重试时间：先沿用旧结果，到点才允许再查
            return now < m.nextAt;
        };

        obj.checkLinkAsync = function (shareSource, shareId, pwd, bearTime, callback) {
            let key = obj.buildShareKey(shareSource, shareId);
            let ttl = bearTime || obj.okTTL;
            let now = Date.now();

            // 0) 已经在排队/请求中：挂上去等同一个结果，绝不再发一次
            //    这一步必须在 shouldSkip 之前，否则 pending 状态会被误判成“已查完”
            if (obj.inflight[key]) {
                obj.inflight[key].push(callback);
                return;
            }

            // 1) 本页已经查过：直接回放结果
            if (obj.shouldSkip(key, now)) {
                callback && callback({ state: obj.memo[key].state });
                return;
            }

            // 2) 持久化缓存命中（仅明确结果）：直接回调，不进入异步队列
            let item = obj.getItem(shareSource, shareId);
            if (item && item.check_time && (item.check_state < 0 || (item.check_state >= 1 && (now - item.check_time < ttl)))) {
                obj.memo[key] = { state: item.check_state, attempts: 1, nextAt: 0, done: true, pending: false };
                callback && callback({ state: item.check_state });
                return;
            }

            // 3) 入队前就先落账：这一步是关键。
            //    以前只在请求返回后才写 memo，只要请求没回来（超时、被拦、页面重渲染），
            //    下一次扫描就会重新入队 —— 于是同一条链接被无限请求。
            //    现在只要发过一次，就再也没有第二次。
            obj.reserve(key);

            obj.inflight[key] = [callback];
            obj.queues.push({
                share_source: shareSource,
                share_id: shareId,
                bear_time: ttl,
                pwd: pwd,
                callback: function (res) {
                    let cbs = obj.inflight[key] || [];
                    delete obj.inflight[key];
                    for (let i = 0; i < cbs.length; i++) {
                        cbs[i] && cbs[i](res);
                    }
                }
            });
            obj.activeQueue();
        };

        /**
         * 在入队的那一刻就登记。返回 false 表示这条链接不该再发请求。
         * 这是“一条链接只查一次”的硬保证：不依赖回调是否真的回来。
         *
         * maxCheckAttempts = 1（默认）时，第一次 reserve 就把 done 置真，
         * 之后无论请求成功、失败、超时、还是页面反复重渲染，都不会再发第二次。
         */
        obj.reserve = function (key) {
            var m = obj.memo[key];
            var used = m ? m.attempts : 0;
            if (m && (m.done || used >= obj.maxAttempts)) return false;

            var attempts = used + 1;
            var last = attempts >= obj.maxAttempts;
            obj.memo[key] = {
                state: m ? m.state : 0,
                attempts: attempts,
                nextAt: last ? 0 : Date.now() + obj.retryDelay,
                done: last,
                pending: true
            };
            return true;
        };

        // 记录一次真实请求的结果。只更新状态，不改变“已经查过几次”这个事实。
        obj.record = function (key, state) {
            state = Number(state) || 0;
            var prev = obj.memo[key] || { attempts: 1, done: true };
            obj.memo[key] = {
                state: state,
                attempts: prev.attempts || 1,
                nextAt: prev.nextAt || 0,
                done: prev.done,
                pending: false
            };
        };

        obj.checkLink = function (shareSource, shareId, pwd, bearTime, callback) {
            let key = obj.buildShareKey(shareSource, shareId);
            let now = Date.now();

            if (obj.shouldSkip(key, now)) {
                callback && callback({ state: obj.memo[key].state });
                return;
            }

            let item = obj.getItem(shareSource, shareId);
            bearTime = bearTime || obj.okTTL;
            if (item && item.check_time && (item.check_state < 0 || (item.check_state >= 1 && (now - item.check_time < bearTime)))) {
                obj.memo[key] = { state: item.check_state, attempts: 1, nextAt: 0, done: true };
                callback && callback({ state: item.check_state });
            } else {
                obj.reserve(key);
                obj.runCheck(shareSource, shareId, pwd, callback);
            }
        };

        /**
         * 只负责真正发请求，不做任何“要不要查”的判断。
         * 调用方必须先 reserve()，避免重复入队。
         */
        obj.runCheck = function (shareSource, shareId, pwd, callback) {
            let key = obj.buildShareKey(shareSource, shareId);

            // 持久化缓存里已有明确结果时直接复用，不再发请求
            let item = obj.getItem(shareSource, shareId);
            if (item && item.check_time && (item.check_state < 0 || (item.check_state >= 1 && (Date.now() - item.check_time < obj.okTTL)))) {
                obj.record(key, item.check_state);
                callback && callback({ state: item.check_state });
                return;
            }

            api.checkLinkLocal(shareSource, shareId, function (res) {
                let state = (res instanceof Object && res.state != undefined) ? res.state : 0;
                if (state != 0) {
                    obj.setItem(shareSource, shareId, state, pwd);
                }
                obj.record(key, state);
                callback && callback(res || { state: 0 });
            });
        };

        // 直接从内存 DAO 读取，不再每次调用 GM_getValue("$check") 反序列化
        obj.getItem = function (shareSource, shareId) {
            let key = obj.buildShareKey(shareSource, shareId);
            return obj.getDao().get(key);
        };

        obj.setItem = function (shareSource, shareId, checkState, pwd) {
            pwd = (pwd == undefined || pwd === "undefined") ? "" : pwd;
            obj.getDao().set(obj.buildShareKey(shareSource, shareId), obj.buildItem(shareId, shareSource, checkState, pwd));
        };

        obj.buildItem = function (shareId, shareSource, checkState, pwd) {
            return {
                share_id: shareId,
                share_source: shareSource,
                check_state: checkState,
                pwd: pwd,
                check_time: Date.now()
            };
        };

        obj.buildShareKey = function (shareSource, shareId) {
            return shareSource + "#" + shareId;
        };

        obj.getDao = function () {
            return factory.getCheckDao();
        };

        return obj;
    });

    container.define("core", ["resource", "$"], function (resource, $) {
        var obj = {};
        obj.appendStyle = function () {
            var styleText = resource.getStyleText();
            if (typeof GM_addStyle === "function") {
                try {
                    GM_addStyle(styleText);
                    return;
                } catch (e) {}
            }
            $("<style></style>").text(styleText).appendTo($("head"));
        };

        obj.ready = function (callback) {
            obj.appendStyle();
            callback && callback();
        };

        return obj;
    });

    /** step 2 app_check_url **/
    container.define("app_check_url", ["constant", "checkManage", "findAndReplaceDOMText", "$", "logger"], function (constant, checkManage, findAndReplaceDOMText, $, logger) {
        var obj = {
            scanTimer: null,
            observer: null,
            scanning: false,
            stopped: false,
            pendingRoots: new Set(),
            claims: {}   // "source#id" -> tip 元素
        };

        // 只认真正含网盘域名的超链接，避免 GitHub 这类页面每次 DOM 变动都整块重扫
        var PAN_LINK_SELECTOR = 'a[href*="pan.baidu.com"],a[href*="yun.baidu.com"],a[href*="eyun.baidu.com"],' +
            'a[href*="lanzou"],a[href*="lanzov"],a[href*="lanzn"],a[href*="lanpv"],a[href*="lanzb"],a[href*="lanzoo"],' +
            'a[href*="aliyundrive.com"],a[href*="alipan.com"],a[href*="weiyun.com"],a[href*="115.com"],a[href*="115cdn.com"],' +
            'a[href*="anxia.com"],a[href*="123pan.com"],a[href*="123pan.cn"],a[href*="123684.com"],a[href*="123865.com"],' +
            'a[href*="123912.com"],a[href*="cloud.189.cn"],a[href*="pan.quark.cn"],a[href*="pan.xunlei.com"],' +
            'a[href*="cowtransfer.com"],a[href*="wenshushu.cn"],a[href*="wss1.cn"],a[href*="ws28.cn"],a[href*="wss.ink"]';

        // 全页范围内，这条链接是否已经有活着的 tip
        obj.liveTip = function (key) {
            var el = obj.claims[key];
            if (el && el.isConnected) return el;
            if (el) delete obj.claims[key];
            return null;
        };

        obj.registerTip = function (key, el) {
            obj.claims[key] = el;
        };

        /**
         * 把一个多余的 tip 还原成普通文字。
         * 只清标记，绝不改动父节点结构 —— 否则会把页面原有的 <a> 拆掉。
         */
        obj.unmarkTip = function (tipEl) {
            if (!tipEl) return;
            tipEl.removeAttribute("one-tip-mark");
            tipEl.removeAttribute("one-id");
            tipEl.removeAttribute("one-pwd");
            tipEl.removeAttribute("one-source");
            tipEl.className = "";
        };

        // 全页是否已经有这条链接的提示（DOM 是唯一事实来源）
        obj.hasTip = function (shareSource, shareId) {
            var key = shareSource + "#" + shareId;
            if (obj.liveTip(key)) return true;
            var esc = String(shareId).replace(/["\\]/g, "\\$&");
            return !!document.querySelector('.one-pan-tip[one-id="' + esc + '"]');
        };

        /**
         * 扫描前把已有 tip 的文字临时冻结成零宽字符。
         * 这是“标记过的链接绝不会被再次匹配”的硬保证：
         * 不管从哪个节点开始扫、正则怎么回溯，tip 内部的文字都不含链接了。
         */
        obj.freezeTips = function (rootEl) {
            var tips = rootEl.querySelectorAll ? rootEl.querySelectorAll(".one-pan-tip") : [];
            var saved = [];
            for (var i = 0; i < tips.length; i++) {
                saved.push([tips[i], tips[i].textContent]);
                tips[i].textContent = "\u200b";
            }
            return saved;
        };

        obj.restoreTips = function (saved) {
            for (var i = 0; i < saved.length; i++) {
                if (saved[i][0].isConnected) saved[i][0].textContent = saved[i][1];
            }
        };

        obj.run = function () {
            if (!document.body) return false;

            // 打开页面：先扫一次，再补几次延迟扫描（等懒加载），然后进入监听模式。
            // 监听有硬性时限（observeTimeout），到点自动断开，
            // 保证任何情况下都不会出现“无限扫描 → 无限创建提示”。
            obj.runMatch(document.body);

            var passes = manifest["scanPasses"] || 4;
            var delay = manifest["scanInterval"] || 1500;
            for (var i = 1; i <= passes; i++) {
                (function (n) {
                    setTimeout(function () {
                        if (obj.stopped) return;
                        obj.runMatch(document.body);
                        if (n === passes) obj.observeDOM();
                    }, delay * n);
                })(i);
            }
            return false;
        };

        // 停止后续一切扫描与监听
        obj.stop = function () {
            if (obj.stopped) return;
            obj.stopped = true;
            if (obj.scanTimer) {
                clearTimeout(obj.scanTimer);
                obj.scanTimer = null;
            }
            if (obj.observer) {
                obj.observer.disconnect();
                obj.observer = null;
            }
            logger.info("netdiskChecker: 已停止扫描与监听");
        };

        /**
         * 监听后续 DOM 变化（懒加载 / 无限滚动需要）。
         * 两条硬约束，确保不会自我循环：
         *   1) 只处理「新增节点里含网盘链接」的情况，自己造的 tip/包装 <a> 一律忽略；
         *   2) 有硬超时，到点自动断开。
         */
        obj.observeDOM = function () {
            if (obj.observer || obj.stopped || !manifest["observeDOM"]) return;

            obj.observer = new MutationObserver(function (mutations) {
                if (obj.stopped) return;
                var hasNewNodes = false;
                for (var i = 0; i < mutations.length; i++) {
                    var added = mutations[i].addedNodes;
                    for (var j = 0; j < added.length; j++) {
                        var node = added[j];
                        if (node.nodeType !== 1) continue;
                        // 自己生成的节点不算新内容
                        if (node.classList && node.classList.contains("one-pan-tip")) continue;
                        if (node.hasAttribute && (node.hasAttribute("one-tip-mark") || node.hasAttribute("one-link-mark"))) continue;
                        // 只认真正含网盘链接的节点
                        var hitPanLink = node.querySelector && node.querySelector(PAN_LINK_SELECTOR);
                        if (hitPanLink || panRule.test(node.textContent || "")) {
                            obj.pendingRoots.add(node);
                            hasNewNodes = true;
                        }
                    }
                }
                if (hasNewNodes) {
                    if (obj.scanTimer) clearTimeout(obj.scanTimer);
                    obj.scanTimer = setTimeout(function () {
                        obj.scanTimer = null;
                        if (obj.stopped) return;
                        var roots = Array.from(obj.pendingRoots);
                        obj.pendingRoots.clear();
                        roots.forEach(function (root) {
                            if (root.isConnected) obj.runMatch(root);
                        });
                    }, 600);
                }
            });
            obj.observer.observe(document.body, { childList: true, subtree: true });

            // 硬超时：到点无论如何都断开
            var timeout = manifest["observeTimeout"] || 30000;
            setTimeout(obj.stop, timeout);
        };

        obj.runMatch = function (rootEl) {
            rootEl = rootEl || document.body;
            if (obj.scanning) return;   // 防重入：自己改 DOM 触发的回调不再嵌套扫描
            obj.scanning = true;
            var frozen = null;
            try {
                // 扫描期间把已有 tip 的文字冻结，任何正则都匹配不到它们
                frozen = obj.freezeTips(document.body);
                obj.doMatch(rootEl);
            } catch (e) {
                logger.error(e);
            } finally {
                if (frozen) obj.restoreTips(frozen);
                obj.scanning = false;
            }
        };

        obj.doMatch = function (rootEl) {
            rootEl = rootEl || document.body;
            var rootText = rootEl.textContent || "";

            // 1. 纯文本链接转超链接。
            //    不需要“整块只扫一次”的标记：replaceTextAsLink 里用
            //    filterElements 让已生成的 tip 完全不可见，重复扫描不会重复造节点。
            //    （用标记反而会漏掉后续懒加载出来的内容。）
            if (panRule.test(rootText)) {
                for (var rule in constant) {
                    constant[rule]["replaceReg"].lastIndex = 0;
                    if (constant[rule]["replaceReg"].test(rootText)) {
                        constant[rule]["replaceReg"].lastIndex = 0;
                        obj.replaceTextAsLink(rootEl, constant[rule]["replaceReg"], rule, function (match) {
                            return match[1];
                        });
                    }
                }
            }

            // 2. 补超链接 ATTR
            var aTags = rootEl.querySelectorAll ? rootEl.querySelectorAll("a:not([one-link-mark])") : [];
            for (var i = 0; i < aTags.length; i++) {
                var aEl = aTags[i];
                var href = aEl.getAttribute("href");
                if (!href || !panRule.test(href)) {
                    continue;
                }
                href = href.replace("#list/path=%2F", "");
                for (var ruleName in constant) {
                    if (constant[ruleName]["reg"].test(href) && !aEl.querySelector(".one-pan-tip")) {
                        aEl.setAttribute("one-link-mark", "yes");
                        if (aEl.classList.contains("LinkCard")) {
                            break;
                        }
                        var node = obj.createOneSpanNode(href, ruleName, aEl);
                        $(aEl).wrapInner(node);
                        break;
                    }
                }
            }

            // 3. 检查链接状态并加上超链接
            var tips = rootEl.querySelectorAll ? rootEl.querySelectorAll(".one-pan-tip:not([one-tip-mark])") : [];
            for (var k = 0; k < tips.length; k++) {
                let tipEl = tips[k];
                // 已在检查中/已检查完的节点直接跳过
                if (tipEl.hasAttribute("one-tip-mark")) continue;
                let $this = $(tipEl);
                tipEl.setAttribute("one-tip-mark", "yes");
                let shareSource = tipEl.getAttribute("one-source");
                let shareId = tipEl.getAttribute("one-id");
                let pwd = tipEl.getAttribute("one-pwd");

                let parentNode = tipEl.parentNode;
                let shareUrl = obj.buildShareUrl(shareId, shareSource, pwd, tipEl);
                pwd = tipEl.getAttribute("one-pwd");

                if (parentNode && parentNode.nodeName != "A") {
                    $this.wrap('<a href="' + shareUrl + '" target="_blank" one-link-mark="yes"></a>');
                } else if (parentNode && constant[shareSource] && constant[shareSource]["aTagRepalce"]) {
                    let replacePair = constant[shareSource]["aTagRepalce"];
                    parentNode.href = shareUrl.replace(replacePair[0], replacePair[1]);
                } else if (parentNode) {
                    parentNode.href = shareUrl;
                }

                obj.applyState($this, null);
                // 请求由 checkManage 统一去重：同一条链接全页只发一次，
                // 多个提示节点各自拿到同一份结果。
                checkManage.checkLinkAsync(shareSource, shareId, pwd, 0, (response) => {
                    obj.applyState($this, response);
                });
            }
        };

        /**
         * 从 href 解析出 { key, shareId }。
         * 不能直接取 reg 的第一个捕获组：百度正则的第 1 组是 "pan"（域名），id 在第 2 组。
         * 这里改用和 createOneSpanNode 完全一致的解析路径，避免误判。
         */
        obj.parseShare = function (raw, shareSource) {
            if (!raw) return null;
            var rule = constant[shareSource];
            if (!rule) return null;

            // 用非全局正则取最后一次匹配，避免 lastIndex 状态污染
            var reg = new RegExp(rule.reg.source, rule.reg.flags.replace("g", ""));
            var m = reg.exec(raw);
            if (!m) return null;

            // 依次尝试各个捕获组，取第一个像 shareId 的（长度 >= 4 且不是纯域名片段）
            var id = "";
            for (var i = m.length - 1; i >= 1; i--) {
                var g = m[i];
                if (!g) continue;
                if (/^(pan|yun|eyun|www|share|s|t|init)$/i.test(g)) continue;
                if (g.length < 4) continue;
                id = g;
                break;
            }
            if (!id) return null;

            // 与 createOneSpanNode 保持一致：长链接取 ?surl= 之后的值
            var mm = /https?:\/\/.*\/(?:init\?surl=)?([\w-]+)(?:(?:[\?&]pwd=|#)(\w+))?/i.exec(raw);
            if (mm && mm[1] && mm[1].length >= 4) id = mm[1];

            return { key: shareSource + "#" + id, shareSource: shareSource, shareId: id };
        };

        // 状态 -> 图标 class。先清掉旧状态，避免同一个节点被追加多个状态 class
        obj.applyState = function ($this, response) {
            $this.removeClass("one-pan-tip-success one-pan-tip-error one-pan-tip-partial one-pan-tip-other one-pan-tip-lock");
            if (!response) return;
            if (response.state == 2) {
                $this.addClass("one-pan-tip-lock");
            } else if (response.state == 1) {
                $this.addClass("one-pan-tip-success");
            } else if (response.state == 11) {
                $this.addClass("one-pan-tip-partial");
            } else if (response.state == -1) {
                $this.addClass("one-pan-tip-error");
            } else {
                $this.addClass("one-pan-tip-other");
            }
        };

        obj.replaceTextAsLink = function (containerEl, shareMatch, shareSource, getShareId) {
            // 一次匹配可能横跨多个文本节点，库会为每个片段各调一次 replace。
            // 这里按 match.index 记账：首个片段生成 tip（含完整链接），其余片段清空，
            // 保证「一次匹配 = 一个 tip、链接文字只出现一次」。
            var seen = {};

            findAndReplaceDOMText(containerEl, {
                preset: 'prose',
                find: shareMatch,
                replace: function (portion, match) {
                    var idx = match.index;

                    if (!seen[idx]) {
                        var host = portion.node.parentElement;
                        var insideTip = !!(host && host.closest && host.closest(".one-pan-tip"));
                        seen[idx] = {
                            replace: !insideTip && (match[0] || "").indexOf("/") > -1,
                            shareId: getShareId(match),
                            done: false
                        };
                    }
                    if (!seen[idx].replace) return portion.text;

                    if (!seen[idx].done) {
                        seen[idx].done = true;
                        var node = obj.createOneSpanNode(seen[idx].shareId, shareSource, portion.node.parentNode);
                        node.textContent = obj.buildShowText(seen[idx].shareId, shareSource);
                        return node;
                    }
                    // 剩余片段已包含在上面那个 tip 里，删掉避免文字重复
                    return "";
                },

                /**
                 * 关键修复：让已生成的 tip 对匹配器完全不可见。
                 *
                 * 之前只用 forceContext 把 tip 当作“独立上下文”，
                 * 但库对该上下文内部仍会递归扫描 —— tip 里的链接文字每轮都被重新匹配，
                 * 于是旁边再生成一个新 tip，下一轮两个都参与匹配……
                 * 这就是「每 0.5 秒多一个、无上限」的真正原因。
                 *
                 * filterElements 返回 false 时，该元素整体被跳过（内容不参与匹配）。
                 */
                filterElements: function (el) {
                    if (el.classList && el.classList.contains("one-pan-tip")) return false;
                    if (el.hasAttribute && el.hasAttribute("one-tip-mark")) return false;
                    var NON_PROSE = findAndReplaceDOMText.NON_PROSE_ELEMENTS || {};
                    return !NON_PROSE.hasOwnProperty(el.nodeName.toLowerCase());
                }
            });
        };

        // 仅在当前链接及附近父节点文本中查找提取码，避免读取全页 innerText 触发强制重排
        obj.findNearbyCode = function (shareId, contextEl) {
            if (passMap[shareId]) return passMap[shareId];
            var tag = (contextEl && contextEl.tagName === "A") ? contextEl : document.querySelector("a[href*='" + shareId + "']");
            if (tag) {
                var regHref = /(?:pwd=|password=|#)([a-zA-Z\d]{4,8})/i;
                try {
                    var mmHref = regHref.exec(decodeURIComponent(tag.href));
                    if (mmHref && mmHref[1]) return mmHref[1];
                } catch (e) {}
                var regText = /(?:(?:提取|访问|訪問|密)[码碼]|Code:)\s*[:：﹕=]?\s*([a-zA-Z\d]{4,8})/i;
                var mmText = regText.exec(tag.textContent || "");
                if (mmText && mmText[1]) return mmText[1];
            }
            var cur = contextEl || tag;
            for (var depth = 0; depth < 3 && cur && cur !== document.body; depth++) {
                var localText = cur.textContent || "";
                if (localText.length < 1500) {
                    var escaped = shareId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    var localReg = new RegExp(escaped + "[\\s\\S]{0,120}?(?:(?:提取|访问|訪問|密)[码碼]|Code:|pwd=|#)\\s*[:：﹕=]?\\s*([a-zA-Z\\d]{4,8})", "i");
                    var mLocal = localReg.exec(localText);
                    if (mLocal && mLocal[1] && mLocal[1] !== "undefined" && mLocal[1] !== "Code") {
                        passMap[shareId] = mLocal[1];
                        return mLocal[1];
                    }
                }
                cur = cur.parentElement;
            }
            return "";
        };

        obj.createOneSpanNode = function (shareId, shareSource, contextEl) {
            var m = /https?:\/\/.*\/(?:init\?surl=)?([\w-]+)(?:(?:[\?&]pwd=|#)(\w+))?/i.exec(shareId);
            shareId = (m && m[1]) || (shareId.includes("http") ? shareId.replace(/^.*?([\w-]+$)/i, "$1") : shareId);
            var code = (m && m[2]) || passMap[shareId] || obj.findNearbyCode(shareId, contextEl) || "";

            var node = document.createElementNS(document.lookupNamespaceURI(null) || "http://www.w3.org/1999/xhtml", "span");
            node.setAttribute("class", "one-pan-tip");
            node.setAttribute("one-id", shareId);
            node.setAttribute("one-pwd", code);
            node.setAttribute("one-source", shareSource);
            return node;
        };

        obj.buildShareUrl = function (shareId, shareSource, pwd, contextEl) {
            var m = /https?:\/\/.*\/([\w-]+)(?:(?:\?pwd=|#)(\w+))?/i.exec(shareId);
            shareId = (m && m[1]) || (shareId.includes("http") ? shareId.replace(/^.*?([\w-]+$)/i, "$1") : shareId);
            let code = (m && m[2]) || pwd || passMap[shareId] || "";
            if (!code || code == "undefined" || code == "Code") {
                code = obj.findNearbyCode(shareId, contextEl);
                if (code && contextEl) {
                    contextEl.setAttribute("one-pwd", code);
                }
            }

            let appendCode = (shareSource == "ty189" || shareSource == "pan123") ? "#" : "?pwd=";
            if (!code || code == "undefined") {
                code = "";
            } else {
                code = appendCode + code;
            }
            let shareUrl = constant[shareSource]["prefix"] + shareId + code;
            if (shareUrl.includes("/share/init?surl=")) {
                shareUrl = shareUrl.replace("/share/init?surl=", "/s/1");
            }
            return shareUrl;
        };

        obj.buildShowText = function (shareId, shareSource) {
            return constant[shareSource]["prefix"] + shareId;
        };

        return obj;
    });

    // step 1 入口app
    container.define("app", ["appRunner"], function (appRunner) {
        let funcs = [{ name: "app_check_url", matchs: ["*"] }];
        if (manifest["autofill"]) {
            funcs.push({
                name: "auto_fill",
                matchs: [
                    /(pan|yun)\.baidu\.com/,
                    /www\.(?:aliyundrive|alipan)\.com|alywp\.net/,
                    /share\.weiyun\.com/,
                    /(?:[A-Za-z0-9.\-]+)?(?:lanzou[a-z]?|lanzov|lanzn)\.com/,
                    /cloud\.189\.cn/,
                    /pan\.xunlei\.com/,
                    /pan\.quark\.cn/,
                    /(?:www\.)?(?:123pan\.(?:com|cn)|(?:123684|123865|123912)\.com)/,
                    /115\.com/,
                    /anxia\.com/,
                    /115cdn\.com/,
                ]
            });
        }
        return {
            run: function () {
                appRunner.run(funcs);
            }
        };
    });

    // lib
    container.define("$", [], () => window.$);
    container.define("findAndReplaceDOMText", [], () => typeof findAndReplaceDOMText != "undefined" ? findAndReplaceDOMText : window.findAndReplaceDOMText);
    // 入口
    container.use(["gm", "core", "app"], (gm, core, app) => gm.ready(() => core.ready(app.run)));
})();
