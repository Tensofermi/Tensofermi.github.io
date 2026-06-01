(() => {
  if (window.location.protocol !== "file:") {
    return;
  }

  const index = window.__MKDOCS_FILE_SEARCH_INDEX__;
  if (!index || !Array.isArray(index.docs)) {
    return;
  }

  const configElement = document.getElementById("__config");
  const mkdocsConfig = configElement ? JSON.parse(configElement.textContent || "{}") : {};
  const base = mkdocsConfig.base && mkdocsConfig.base !== "." ? mkdocsConfig.base : "";
  const resultNone = mkdocsConfig.translations?.["search.result.none"] || "没有找到符合条件的结果";
  const resultOne = mkdocsConfig.translations?.["search.result.one"] || "找到 1 个符合条件的结果";
  const resultOther = mkdocsConfig.translations?.["search.result.other"] || "# 个符合条件的结果";
  const placeholder = mkdocsConfig.translations?.["search.result.placeholder"] || "键入以开始搜索";

  const search = document.querySelector("[data-md-component='search']");
  const input = document.querySelector("[data-md-component='search-query']");
  const list = document.querySelector(".md-search-result__list");
  const meta = document.querySelector(".md-search-result__meta");
  const reset = document.querySelector(".md-search__form button[type='reset']");

  if (!search || !input || !list || !meta) {
    return;
  }

  search.setAttribute("data-md-file-search", "true");
  meta.textContent = placeholder;

  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();

  const escapeHtml = (value) =>
    String(value || "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);

  const pageHref = (location) => {
    const target = String(location || "index.html");
    return base ? `${base}/${target}` : target;
  };

  const makeSnippet = (text, terms) => {
    const source = String(text || "").replace(/\s+/g, " ").trim();
    if (!source) {
      return "";
    }

    const lower = normalize(source);
    let position = -1;
    for (const term of terms) {
      position = lower.indexOf(term);
      if (position >= 0) {
        break;
      }
    }

    const start = Math.max(0, position - 48);
    const end = Math.min(source.length, (position >= 0 ? position : 0) + 150);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < source.length ? "..." : "";
    return prefix + source.slice(start, end) + suffix;
  };

  const scoreEntry = (doc, terms, query) => {
    const title = normalize(doc.title);
    const text = normalize(doc.text);
    if (!terms.every((term) => title.includes(term) || text.includes(term))) {
      return 0;
    }

    let score = 1;
    if (title.includes(query)) score += 80;
    if (text.includes(query)) score += 20;
    for (const term of terms) {
      if (title.includes(term)) score += 25;
      if (text.includes(term)) score += 3;
    }
    return score;
  };

  const render = () => {
    const query = normalize(input.value);
    list.innerHTML = "";

    if (!query) {
      meta.textContent = placeholder;
      return;
    }

    const terms = query.split(" ").filter(Boolean);
    const results = index.docs
      .map((doc) => ({ doc, score: scoreEntry(doc, terms, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    meta.textContent = results.length === 0
      ? resultNone
      : results.length === 1
        ? resultOne
        : resultOther.replace("#", String(results.length));

    list.innerHTML = results.map(({ doc }) => {
      const title = doc.title || doc.location || "";
      const snippet = makeSnippet(doc.text, terms);
      return `
        <li class="md-search-result__item">
          <a href="${escapeHtml(pageHref(doc.location))}" class="md-search-result__link" tabindex="-1">
            <article class="md-search-result__article md-typeset">
              <h1>${escapeHtml(title)}</h1>
              ${snippet ? `<p>${escapeHtml(snippet)}</p>` : ""}
            </article>
          </a>
        </li>`;
    }).join("");
  };

  input.addEventListener("input", () => window.setTimeout(render, 0));
  input.addEventListener("focus", render);
  reset?.addEventListener("click", () => window.setTimeout(render, 0));
  input.form?.addEventListener("submit", (event) => event.preventDefault());

  if (input.value) {
    render();
  }
})();
