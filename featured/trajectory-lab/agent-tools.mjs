export const TOOL_PREFERENCES_EVENT = 'trajectory-lab:tool-preferences';
export const SLATE_HANDOFF_KEY = 'trajectory-lab:chat-draft';
export const SLATE_URL = '/featured/trajectory-lab/';
export const CHAT_URL = '/featured/tools/chat/';
export const TRAJECTORY_URL = SLATE_URL + 'trajectory.html';
const storageKey = 'trajectory-lab:tools';
let preferences = { mode: 'automatic', enabled: [] };
const fields = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const number = { type: 'number' };
const enumeration = (values) => ({ type: 'string', enum: values });
const boundedInteger = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const operations = ['add', 'subtract', 'multiply', 'divide', 'power', 'modulo'];
const searchTopics = ['general', 'news'];
const searchPeriods = ['day', 'week', 'month', 'year'];
const dayMillis = 86_400_000;
function text(value, label, maximum, trim = false) {
    if (typeof value !== 'string' || value.length > maximum)
        throw new Error(label + '须为不超过 ' + maximum + ' 字符的文本。');
    return trim ? value.trim() : value;
}
function finite(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(label + '须为有限数值。');
    return value;
}
function integer(value, low, high) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high)
        throw new Error('整数超出允许范围。');
    return value;
}
function calendarDate(value, label) {
    const date = text(value, label, 10);
    const timestamp = Date.parse(date + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
        throw new Error(label + '须为有效的 YYYY-MM-DD 日期。');
    }
    return { date, timestamp };
}
function currencyCode(value, label) {
    const code = text(value, label, 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(code))
        throw new Error(label + '须为三字母货币代码，例如 CNY。');
    return code;
}
const units = {
    m: ['length', 1, 0], km: ['length', 1000, 0], cm: ['length', 0.01, 0], mi: ['length', 1609.344, 0], ft: ['length', 0.3048, 0],
    kg: ['mass', 1, 0], g: ['mass', 0.001, 0], lb: ['mass', 0.45359237, 0], oz: ['mass', 0.028349523125, 0],
    C: ['temperature', 1, 273.15], F: ['temperature', 5 / 9, 273.15 - 32 * 5 / 9], K: ['temperature', 1, 0],
    'km/h': ['speed', 1 / 3.6, 0], 'm/s': ['speed', 1, 0], mph: ['speed', 0.44704, 0],
};
function unit(value) {
    if (typeof value !== 'string' || !Object.hasOwn(units, value))
        throw new Error('请选择支持的单位。');
    return units[value];
}
async function getJson(base, query, signal, request) {
    const url = new URL(base);
    url.search = new URLSearchParams(query).toString();
    const response = await fetch(url, { ...request, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) });
    if (!response.ok)
        throw new Error('数据源暂不可用（HTTP ' + response.status + '）。');
    return response.json();
}
const catalog = [
    { id: 'add_numbers', label: '计算器', description: '两个数的加减乘除、幂或取余。operation 缺省时相加。',
        parameters: fields({ a: number, b: number, operation: enumeration(operations) }, ['a', 'b']),
        run: ({ a, b, operation = 'add' }) => {
            const x = finite(a, 'a'), y = finite(b, 'b');
            const results = {
                add: () => x + y, subtract: () => x - y, multiply: () => x * y,
                divide: () => x / y, power: () => x ** y, modulo: () => x % y,
            };
            if (typeof operation !== 'string' || !Object.hasOwn(results, operation))
                throw new Error('未知的计算方式。');
            return { result: finite(results[operation](), '计算结果') };
        } },
    { id: 'convert_units', label: '单位换算', description: '换算长度、重量、温度和速度。温度使用 C、F、K。',
        parameters: fields({ value: number, from: enumeration(Object.keys(units)), to: enumeration(Object.keys(units)) }, ['value', 'from', 'to']),
        run: ({ value, from, to }) => {
            const [fromKind, fromScale, fromOffset] = unit(from);
            const [toKind, toScale, toOffset] = unit(to);
            if (fromKind !== toKind)
                throw new Error('请选择同类单位。');
            const base = finite(value, '输入值') * fromScale + fromOffset;
            if (fromKind === 'temperature' && base < -1e-9)
                throw new Error('温度不能低于绝对零度。');
            return { result: finite((base - toOffset) / toScale, '换算结果'), unit: to };
        } },
    { id: 'current_time', label: '时间与时区', description: '获取当前时间。可指定 IANA 时区，例如 Asia/Shanghai。',
        parameters: fields({ timezone: string }),
        run: ({ timezone }) => {
            const date = new Date();
            const timeZone = timezone === undefined ? Intl.DateTimeFormat().resolvedOptions().timeZone : text(timezone, '时区', 100, true);
            return { iso: date.toISOString(), timezone: timeZone, local: new Intl.DateTimeFormat('zh-CN', {
                    timeZone, dateStyle: 'full', timeStyle: 'long',
                }).format(date) };
        } },
    { id: 'date_difference', label: '日期计算', description: '计算结束日期减开始日期的日历天数。输入格式 YYYY-MM-DD，支持闰年。',
        parameters: fields({ start_date: string, end_date: string }, ['start_date', 'end_date']),
        run: ({ start_date, end_date }) => {
            const start = calendarDate(start_date, '开始日期'), end = calendarDate(end_date, '结束日期');
            return { start_date: start.date, end_date: end.date, days: (end.timestamp - start.timestamp) / dayMillis };
        } },
    { id: 'text_stats', label: '文本统计', description: '统计文本字符、字节、行数和分词段数。',
        parameters: fields({ text: string }, ['text']),
        run: (args) => {
            const value = text(args.text, '文本', 25_000);
            return { characters: Array.from(value).length, utf8_bytes: new TextEncoder().encode(value).length,
                lines: value ? value.split(/\r\n|\r|\n/).length : 0,
                words: [...new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(value)].filter(part => part.isWordLike).length };
        } },
    { id: 'inspect_json', label: 'JSON 检查', description: '校验 JSON，返回顶层类型和整理后的内容。',
        parameters: fields({ json: string }, ['json']),
        run: ({ json }) => {
            const value = JSON.parse(text(json, 'JSON', 12_000));
            const formatted = JSON.stringify(value, null, 2);
            return { type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
                formatted: formatted.slice(0, 9_000), truncated: formatted.length > 9_000 };
        } },
    { id: 'roll_dice', label: '投骰子', description: '随机投 1–20 枚骰子，每枚可设 2–100 面。',
        parameters: fields({ count: boundedInteger(1, 20), sides: boundedInteger(2, 100) }, ['count', 'sides']),
        run: ({ count, sides }) => {
            const n = integer(count, 1, 20), faces = integer(sides, 2, 100);
            const random = new Uint32Array(1);
            const limit = Math.floor(2 ** 32 / faces) * faces;
            const rolls = Array.from({ length: n }, () => {
                do {
                    crypto.getRandomValues(random);
                } while (random[0] >= limit);
                return random[0] % faces + 1;
            });
            return { rolls, total: rolls.reduce((sum, value) => sum + value, 0), sides: faces };
        } },
    { id: 'web_search', label: '网页搜索', description: '用 Tavily 搜索公开网页或新闻，返回标题、摘要和原文链接。无需额外 Key，受服务限流。',
        network: true, parameters: fields({ query: string, topic: enumeration(searchTopics), time_range: enumeration(searchPeriods), limit: boundedInteger(1, 8) }, ['query']),
        run: async ({ query, topic = 'general', time_range, limit = 5 }, signal) => {
            const value = text(query, '搜索词', 400, true);
            if (!value)
                throw new Error('请输入搜索词。');
            if (topic !== 'general' && topic !== 'news')
                throw new Error('请选择公开网页或新闻。');
            if (time_range !== undefined && !searchPeriods.some(period => period === time_range))
                throw new Error('搜索时段须为 day、week、month 或 year。');
            const maxResults = integer(limit, 1, 8);
            const data = await getJson('https://api.tavily.com/search', {}, signal, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tavily-Access-Mode': 'keyless' },
                body: JSON.stringify({ query: value, topic, time_range, max_results: maxResults, search_depth: 'basic', include_raw_content: false }),
            });
            if (!Array.isArray(data.results))
                throw new Error('Tavily 未返回搜索结果。');
            const results = data.results.filter(item => /^https?:\/\//i.test(item.url)).slice(0, maxResults).map(item => ({
                title: item.title?.slice(0, 240), url: item.url, excerpt: item.content?.slice(0, 750), published_date: item.published_date,
            }));
            return { source: 'Tavily', query: value, topic, results };
        } },
    { id: 'search_publications', label: '文献检索', description: '按标题、作者或关键词搜索 Crossref，返回出版信息和 DOI 链接。',
        network: true, parameters: fields({ query: string, limit: boundedInteger(1, 8) }, ['query']),
        run: async ({ query, limit = 5 }, signal) => {
            const value = text(query, '搜索词', 300, true);
            if (!value)
                throw new Error('请输入搜索词。');
            const rows = integer(limit, 1, 8);
            const data = await getJson('https://api.crossref.org/works', {
                'query.bibliographic': value, rows: String(rows), select: 'DOI,title,author,published,container-title,type',
            }, signal);
            if (!Array.isArray(data.message?.items))
                throw new Error('Crossref 未返回文献检索结果。');
            const results = data.message.items.slice(0, rows).map(work => ({
                title: work.title?.[0]?.slice(0, 350), doi: work.DOI, url: 'https://doi.org/' + work.DOI.split('/').map(encodeURIComponent).join('/'),
                authors: work.author?.slice(0, 4).map(author => author.name || [author.given, author.family].filter(Boolean).join(' ')),
                year: work.published?.['date-parts']?.[0]?.[0], venue: work['container-title']?.[0], type: work.type,
            }));
            return { source: 'Crossref', query: value, results };
        } },
    { id: 'convert_currency', label: '参考汇率换算', description: '用 Frankfurter 的每日参考汇率换算货币。使用三字母货币代码，可指定历史日期。',
        network: true, parameters: fields({ amount: number, from: string, to: string, date: string }, ['amount', 'from', 'to']),
        run: async ({ amount, from, to, date }, signal) => {
            const value = finite(amount, '金额'), base = currencyCode(from, '原币种'), quote = currencyCode(to, '目标币种');
            const requestedDate = date === undefined ? undefined : calendarDate(date, '汇率日期').date;
            if (base === quote)
                return { amount: value, from: base, to: quote, rate: 1, result: value, date: requestedDate };
            const data = await getJson('https://api.frankfurter.dev/v2/rates', {
                base, quotes: quote, ...(requestedDate ? { date: requestedDate } : {}),
            }, signal);
            const rate = Array.isArray(data) ? data.find(item => item.base === base && item.quote === quote) : undefined;
            if (!rate || !Number.isFinite(rate.rate) || rate.rate <= 0)
                throw new Error('找不到该货币对的参考汇率。');
            return { source: 'Frankfurter', amount: value, from: base, to: quote, date: rate.date, rate: rate.rate,
                result: finite(value * rate.rate, '换算结果') };
        } },
    { id: 'wiki_search', label: '维基百科搜索', description: '搜索中文或英文维基百科，返回标题、摘要和来源链接。',
        network: true, parameters: fields({ query: string, language: enumeration(['zh', 'en']) }, ['query']),
        run: async ({ query, language = 'zh' }, signal) => {
            if (language !== 'zh' && language !== 'en')
                throw new Error('维基百科语言须为 zh 或 en。');
            const value = text(query, '搜索词', 300, true);
            if (!value)
                throw new Error('请输入搜索词。');
            const domain = language === 'zh' ? 'https://zh.wikipedia.org' : 'https://en.wikipedia.org';
            const data = await getJson(domain + '/w/api.php', {
                origin: '*', format: 'json', action: 'query', list: 'search', srsearch: value, srlimit: '5',
            }, signal);
            if (!Array.isArray(data.query?.search))
                throw new Error('维基百科未返回搜索结果。');
            const results = data.query.search.map(item => ({
                title: item.title, excerpt: item.snippet.replace(/<[^>]*>/g, '').slice(0, 420),
                url: domain + '/?curid=' + encodeURIComponent(item.pageid),
            }));
            return { source: domain, results };
        } },
    { id: 'current_weather', label: '城市天气', description: '通过 Open-Meteo 查询城市当前温度、湿度、降水和风速。',
        network: true, parameters: fields({ city: string, country_code: string }, ['city']),
        run: async ({ city, country_code }, signal) => {
            const name = text(city, '城市名', 100, true);
            if (!name)
                throw new Error('请输入城市名。');
            const query = { name, count: '3', language: 'zh', format: 'json' };
            if (country_code !== undefined) {
                const code = text(country_code, '国家代码', 2, true).toUpperCase();
                if (!/^[A-Z]{2}$/.test(code))
                    throw new Error('国家代码须为两位字母。');
                query.countryCode = code;
            }
            const locations = await getJson('https://geocoding-api.open-meteo.com/v1/search', query, signal);
            const place = locations.results?.[0];
            if (!place)
                throw new Error('找不到城市，可尝试英文名或指定国家代码。');
            const data = await getJson('https://api.open-meteo.com/v1/forecast', {
                latitude: String(place.latitude), longitude: String(place.longitude), timezone: 'auto',
                current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
            }, signal);
            if (!data.current)
                throw new Error('天气数据源未返回当前天气。');
            return { source: 'https://open-meteo.com/', location: place, timezone: data.timezone,
                current: data.current, units: data.current_units,
                alternative_locations: locations.results?.slice(1).map(item => ({ name: item.name, country: item.country, area: item.admin1 })) };
        } },
];
const byId = new Map(catalog.map(tool => [tool.id, tool]));
export const isBrowserTool = (name) => byId.has(name);
export function toolPreferences() {
    try {
        const data = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
        if (data)
            preferences = { mode: data.mode === 'manual' ? 'manual' : 'automatic',
                enabled: [...new Set(Array.isArray(data.enabled) ? data.enabled.filter(id => byId.has(id)) : [])] };
    }
    catch { /* Use this page's settings when storage is unavailable. */ }
    return { ...preferences, enabled: [...preferences.enabled] };
}
export function selectedToolDefinitions(enabled) {
    const ids = new Set(enabled);
    return catalog.filter(tool => ids.has(tool.id)).map(tool => ({
        type: 'function', function: { name: tool.id, description: tool.description, parameters: tool.parameters },
    }));
}
function element(tag, value) {
    const node = document.createElement(tag);
    if (value !== undefined)
        node.textContent = value;
    return node;
}
function dialogFrame(title) {
    const dialog = element('dialog');
    dialog.className = 'lab-tools-dialog';
    dialog.setAttribute('aria-label', title);
    const form = element('form');
    form.append(element('h2', title));
    dialog.append(form);
    return { dialog, form };
}
function dialogActions(cancel, finish) {
    const row = element('div');
    row.className = 'lab-tool-actions';
    const close = element('button', cancel);
    const submit = element('button', finish);
    close.type = 'button';
    submit.type = 'submit';
    row.append(close, submit);
    return { row, close };
}
export function openToolPreferences(selected) {
    const before = toolPreferences();
    const initial = new Set(selected ?? before.enabled);
    const { dialog, form } = dialogFrame('工具列表');
    const mode = element('fieldset');
    mode.append(element('legend', '工具返回方式'));
    const manual = element('input');
    for (const choice of ['automatic', 'manual']) {
        const radio = choice === 'manual' ? manual : element('input');
        radio.type = 'radio';
        radio.name = 'tool-mode';
        radio.value = choice;
        radio.checked = choice === before.mode;
        const label = element('label');
        label.append(radio, document.createTextNode(choice === 'automatic' ? '浏览器自动执行' : '人类输入返回'));
        mode.append(label);
    }
    form.append(mode);
    const selectedInputs = new Map();
    for (const network of [false, true]) {
        const group = element('fieldset');
        group.append(element('legend', network ? '联网工具' : '本机工具'));
        if (network)
            group.append(element('p', '自动执行联网工具时，浏览器会将查询所需的参数发送给对应的数据源。'));
        for (const tool of catalog.filter(entry => Boolean(entry.network) === network)) {
            const check = element('input');
            check.type = 'checkbox';
            check.checked = initial.has(tool.id);
            const label = element('label');
            label.className = 'lab-tool-option';
            const copy = element('span');
            copy.append(element('strong', tool.label), element('small', tool.description));
            label.append(check, copy);
            group.append(label);
            selectedInputs.set(tool.id, check);
        }
        form.append(group);
    }
    const actions = dialogActions('取消', '应用工具');
    form.append(actions.row);
    return new Promise(resolve => {
        let result = null;
        actions.close.onclick = () => dialog.close();
        form.onsubmit = event => {
            event.preventDefault();
            result = { mode: manual.checked ? 'manual' : 'automatic',
                enabled: [...selectedInputs].filter(([, input]) => input.checked).map(([id]) => id) };
            preferences = result;
            try {
                localStorage.setItem(storageKey, JSON.stringify(result));
            }
            catch { /* Keep this page's selection. */ }
            window.dispatchEvent(new Event(TOOL_PREFERENCES_EVENT));
            dialog.close();
        };
        dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
        document.body.append(dialog);
        dialog.showModal();
    });
}
function manualResult(call, signal) {
    const { dialog, form } = dialogFrame('输入工具返回');
    form.append(element('p', call.function.name), element('pre', call.function.arguments || '{}'));
    const label = element('label', '工具返回文本');
    const input = element('textarea');
    input.required = true;
    input.autofocus = true;
    input.rows = 5;
    input.maxLength = 32_000;
    label.append(input);
    const actions = dialogActions('停止本轮', '提交工具返回');
    form.append(label, actions.row);
    return new Promise((resolve, reject) => {
        let result;
        const stop = () => dialog.close();
        actions.close.onclick = stop;
        form.onsubmit = event => {
            event.preventDefault();
            if (!input.value.trim())
                return;
            result = input.value;
            dialog.close();
        };
        dialog.addEventListener('close', () => {
            signal.removeEventListener('abort', stop);
            dialog.remove();
            if (result !== undefined && !signal.aborted)
                resolve(result);
            else
                reject(new DOMException('工具回填已停止。', 'AbortError'));
        }, { once: true });
        signal.addEventListener('abort', stop, { once: true });
        document.body.append(dialog);
        dialog.showModal();
    });
}
export async function resolveToolCall(call, mode, enabled, signal) {
    signal.throwIfAborted();
    const tool = byId.get(call.function.name);
    if (!enabled.has(call.function.name))
        return { callId: call.id, content: JSON.stringify({ error: '这个工具未启用。' }),
            execution: mode, success: false };
    if (mode === 'manual')
        return { callId: call.id, content: await manualResult(call, signal), execution: mode };
    try {
        if (!tool)
            throw new Error('这是自定义工具，请选择手动回填。');
        const args = JSON.parse(call.function.arguments || '{}');
        if (!args || typeof args !== 'object' || Array.isArray(args))
            throw new Error('工具参数须为 JSON 对象。');
        const result = await tool.run(args, signal);
        signal.throwIfAborted();
        return { callId: call.id, content: JSON.stringify(result), execution: mode, success: true };
    }
    catch (error) {
        signal.throwIfAborted();
        return { callId: call.id, content: JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 400) : '工具执行失败。' }),
            execution: mode, success: false };
    }
}
export function toolTurnMessages(turn, includeReasoning = true) {
    const ordered = turn.calls.map(call => turn.results.find(result => result.callId === call.id));
    if (ordered.some(result => !result))
        return [];
    return [{ role: 'assistant', content: turn.content || null, tool_calls: turn.calls,
            ...(turn.reasoning && includeReasoning ? { reasoning_content: turn.reasoning } : {}) },
        ...ordered.map(result => ({ role: 'tool', tool_call_id: result.callId, content: result.content }))];
}
