(function () {
    const counterScriptUrl = "https://busuanzi.ibruce.info/busuanzi/2.3/busuanzi.pure.mini.js";
    const counterScriptId = "busuanzi-counter-script";
    const statsId = "visitor-stats";
    const styleId = "visitor-stats-style";
    const localHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

    function ensureStyle() {
        if (document.getElementById(styleId)) {
            return;
        }

        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = `
            .visitor-stats {
                margin-top: 8px;
                color: var(--muted, var(--md-footer-fg-color--lighter, #667085));
                font-size: 0.82rem;
                line-height: 1.6;
            }

            .md-footer-meta__inner .visitor-stats {
                width: 100%;
                margin-top: 0.4rem;
                opacity: 0.86;
            }
        `;
        document.head.appendChild(style);
    }

    function findFooter() {
        return document.querySelector(".site-footer")
            || document.querySelector(".md-footer-meta__inner")
            || document.querySelector("footer");
    }

    function ensureStatsContainer() {
        if (document.getElementById(statsId)) {
            return;
        }

        const footer = findFooter();
        if (!footer) {
            return;
        }

        const stats = document.createElement("p");
        stats.id = statsId;
        stats.className = "visitor-stats";
        stats.innerHTML = isLocalPreview()
            ? "本地预览不计数"
            : `
                <span id="busuanzi_container_site_pv">本站访问量 <span id="busuanzi_value_site_pv"></span></span>
                <span aria-hidden="true"> · </span>
                <span id="busuanzi_container_site_uv">访客数 <span id="busuanzi_value_site_uv"></span></span>
                <span aria-hidden="true"> · </span>
                <span id="busuanzi_container_page_pv">本页阅读 <span id="busuanzi_value_page_pv"></span></span>
            `;
        footer.appendChild(stats);
    }

    function isLocalPreview() {
        return localHosts.has(window.location.hostname);
    }

    function loadCounterScript() {
        if (isLocalPreview()) {
            return;
        }

        if (document.getElementById(counterScriptId)) {
            return;
        }

        const script = document.createElement("script");
        script.id = counterScriptId;
        script.async = true;
        script.src = counterScriptUrl;
        document.body.appendChild(script);
    }

    function init() {
        ensureStyle();
        ensureStatsContainer();
        loadCounterScript();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
        init();
    }
})();
