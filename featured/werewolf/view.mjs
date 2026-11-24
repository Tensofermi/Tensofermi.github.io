import { ROLES, RULES, SEAT_NAMES, SPEECH_LIMITS } from './roles.mjs'
import { completionEndpoint, DEFAULT_MODEL_SETTINGS } from './model.mjs'

const PHASE_NAMES = {
    night: '入夜', day_discussion: '白天发言', day_vote: '放逐投票', day_revote: '平票加投',
    shoot: '技能结算', last_words: '放逐结算', over: '牌局结束',
}

const EVENT_NAMES = {
    phase: '主持人', death: '出局公告', votes: '投票结果', speak: '桌上发言', last_words: '遗言',
    wolf_chat: '狼队商议', wolf_kill: '狼队落刀', inspect: '查验结果', witch_target: '狼刀信息',
    use_potion: '女巫用药', night_death: '夜间结算', shoot: '猎人行动', result: '终局',
}
const ACTION_NAMES = {
    speak: '轮到你发言', wolf_chat: '与狼队商议', last_words: '留下遗言',
    vote: '投出你的票', wolf_kill: '选择袭击目标', inspect: '选择查验目标', use_potion: '决定是否用药', shoot: '决定是否开枪',
}
const ACTION_HELP = {
    speak: '你可以质疑、辩护、跳身份，或说服其他席位跟票。',
    wolf_chat: '这段话只会送给狼队。商议结束后再选刀。',
    last_words: '这是你最后一次公开发言。',
    vote: '所有人落票后统一公开结果。',
    wolf_kill: '狼队统一统计选刀结果。',
    inspect: '你会单独收到查验结果。',
    shoot: '选择一名存活席位，或放弃开枪。',
}
const TARGET_CTA = { vote: '投票', wolf_kill: '确认选刀', inspect: '确认查验', shoot: '开枪', use_potion: '使用毒药' }
const NIGHT_EVENTS = new Set(['wolf_chat', 'wolf_kill', 'inspect', 'witch_target', 'use_potion', 'night_death'])
const LOCAL_SEATS = Array.from({ length: 9 }, (_, index) => ({
    id: index + 1, name: index === 0 ? '你' : (SEAT_NAMES[index] ?? '空席'), alive: true,
}))

function element(tag, content, className) {
    const node = document.createElement(tag)
    if (content !== undefined) node.textContent = content
    if (className) node.className = className
    return node
}

function text(node, content) {
    const value = String(content ?? '')
    if (node.textContent !== value) node.textContent = value
}

function option(label, value) {
    const node = element('option', label)
    node.value = value
    return node
}

function titleOf(role) {
    return ROLES[role]?.name ?? '未知身份'
}

function seatLabel(seats, id) {
    const player = seats.find(seat => seat.id === id)
    if (!player) return id == null ? '弃权' : id + ' 号'
    return player.id + ' 号 ' + player.name
}

function timelineEntry(event, seats, privately) {
    const row = element('article', undefined, 'feed-entry')
    if (privately) row.dataset.kind = 'private'
    const heading = element('div', undefined, 'event-heading')
    const byline = event.seat && ['speak', 'wolf_chat', 'last_words'].includes(event.kind)
        ? seatLabel(seats, event.seat) : (EVENT_NAMES[event.kind] ?? '牌局记录')
    heading.append(element('strong', byline))
    const category = NIGHT_EVENTS.has(event.kind) || event.phase === 'night' ? '夜' : '轮'
    heading.append(element('span', event.day ? '第 ' + event.day + ' ' + category + (privately ? ' · 私密' : '') : ''))
    row.append(heading, element('p', event.text))
    if (Array.isArray(event.votes) && event.votes.length) {
        const ballots = element('ul', undefined, 'vote-grid')
        ballots.setAttribute('aria-label', '逐席投票')
        for (const vote of event.votes) {
            const target = vote.target == null ? '弃权' : vote.target + ' 号'
            const item = element('li', vote.actor + ' 号 → ' + target)
            item.title = seatLabel(seats, vote.actor) + ' 投给 ' + seatLabel(seats, vote.target)
            ballots.append(item)
        }
        row.append(ballots)
    }
    return row
}

function resultLabel(winner) {
    if (winner === 'wolf') return '狼人阵营获胜'
    if (winner === 'village') return '好人阵营获胜'
    return '开发模式 · 当前牌局'
}

export function mount(root, handlers) {
    const get = id => root.querySelector('#' + id)
    const nodes = Object.fromEntries([
        'fast', 'speed-control', 'table', 'phase-label', 'phase-count', 'seats', 'role-panel', 'role-name',
        'role-state', 'role-desc', 'role-tools', 'turn-panel', 'turn-title', 'turn-help', 'turn-actions',
        'speech-form', 'speech', 'speech-count', 'speak', 'skip-speech', 'target-form', 'target', 'target-submit',
        'target-pass', 'potions', 'potion-save', 'potion-poison', 'skip', 'cancel', 'retry', 'use-local',
        'wait-actions', 'setup', 'setup-title', 'setup-form', 'mode-options', 'connection', 'base-url',
        'model', 'key', 'test', 'test-status', 'destination', 'setup-role', 'human-role', 'start', 'saved-controls',
        'resume', 'clear', 'back-setup', 'setup-status', 'archive', 'mode-label', 'archive-tabs', 'feed-private',
        'feed-recap', 'feed', 'archive-footer', 'stats', 'developer', 'developer-check', 'observations',
        'rules-dialog', 'rules-list', 'clear-dialog', 'new-game', 'reconnect', 'replace-notice',
    ].map(id => [id, get(id)]))
    const $ = id => nodes[id]
    let displayed = {}
    let activeFeed = 'public'
    let feedKey
    let observationKey
    let lastLegal
    let acceptedAction
    let selectedTarget
    let choosingPoison = false
    let pendingResume = false
    let configuringNew = false
    let previousView
    let lastWolfAction

    const radio = value => root.querySelector('input[name=mode][value=' + value + ']')
    $('base-url').value = DEFAULT_MODEL_SETTINGS.baseUrl
    $('model').value = DEFAULT_MODEL_SETTINGS.model
    for (const [id, role] of Object.entries(ROLES)) $('human-role').append(option(role.name, id))
    for (const [heading, explanation] of RULES) $('rules-list').append(element('dt', heading), element('dd', explanation))

    const seatElements = LOCAL_SEATS.map(({ id }, index) => {
        const item = element('li', undefined, 'seat')
        const angle = Math.PI / 2 + index * Math.PI * 2 / LOCAL_SEATS.length
        item.style.setProperty('--x', (50 + 38 * Math.cos(angle)) + '%')
        item.style.setProperty('--y', (50 + 39 * Math.sin(angle)) + '%')
        const button = element('button', undefined, 'seat-button')
        button.type = 'button'
        button.dataset.seat = id
        const number = element('span', id, 'seat-number')
        number.setAttribute('aria-hidden', 'true')
        const copy = element('span', undefined, 'seat-content')
        const name = element('span', undefined, 'seat-name')
        const note = element('span', undefined, 'seat-note')
        note.setAttribute('aria-hidden', 'true')
        copy.append(name, note)
        button.append(number, copy)
        item.append(button)
        $('seats').append(item)
        return { button, name, note }
    })

    function settings() {
        return {
            mode: radio('model').checked ? 'model' : 'local',
            humanRole: $('human-role').value || undefined,
            baseUrl: $('base-url').value,
            model: $('model').value,
            key: $('key').value,
        }
    }

    function updateSettings() {
        const model = radio('model').checked || pendingResume
        $('connection').hidden = !model
        for (const input of $('connection').querySelectorAll('input')) input.disabled = !model
        $('mode-options').hidden = pendingResume
        $('setup-role').hidden = pendingResume
        $('resume').hidden = !displayed.canResume || pendingResume || configuringNew
        $('clear').hidden = !displayed.hasSave || pendingResume
        $('back-setup').hidden = !(pendingResume || configuringNew)
        $('saved-controls').hidden = $('resume').hidden && $('clear').hidden && $('back-setup').hidden
        $('replace-notice').hidden = !displayed.hasSave || pendingResume
        text($('back-setup'), configuringNew ? '返回当前牌局' : '返回新开局')
        text($('setup-title'), pendingResume ? '恢复模型连接' : '选定你的牌局')
        text($('start'), pendingResume ? '连接并继续' : '入席开局')
        if (model) {
            try { text($('destination'), completionEndpoint($('base-url').value.trim())) }
            catch { text($('destination'), '请输入完整的兼容 API 地址。') }
        } else text($('destination'), '')
    }

    function availableTargets(legal) {
        if (!legal || !['vote', 'wolf_kill', 'inspect', 'shoot', 'use_potion'].includes(legal.kind)) return []
        if (legal.kind === 'use_potion' && !choosingPoison) return []
        return legal.targets ?? []
    }

    function actionDisabled() {
        return Boolean(displayed.busy || displayed.paused || displayed.playing
            || !displayed.view?.legal || acceptedAction === displayed.view.legal.id)
    }

    function showSeats(view) {
        const list = view?.seats ?? LOCAL_SEATS
        const available = availableTargets(view?.legal)
        const disabled = actionDisabled()
        list.forEach((seat, index) => {
            const { button, name, note } = seatElements[index]
            const isSelf = seat.id === view?.self.id || (!view && seat.id === 1)
            const target = !disabled && available.includes(seat.id)
            const labels = [isSelf ? '你' : '', seat.role ? titleOf(seat.role) : '', seat.alive ? '' : '出局'].filter(Boolean)
            text(name, seat.name)
            text(note, labels.join(' · ') || (view ? '在席' : '候场'))
            button.setAttribute('aria-label', [seat.id + ' 号 ' + seat.name, ...labels].join('，'))
            button.disabled = !target
            button.dataset.target = target
            button.dataset.self = isSelf
            button.dataset.out = !seat.alive
            button.dataset.active = view?.legal?.actor === seat.id
            if (target) button.setAttribute('aria-pressed', String(seat.id === selectedTarget))
            else button.removeAttribute('aria-pressed')
        })
    }

    function showRole(view) {
        if (!view) return
        const { self } = view
        text($('role-name'), titleOf(self.role))
        text($('role-state'), self.alive ? '在席' : '已出局')
        text($('role-desc'), ROLES[self.role]?.description)
        let tools = ''
        if (self.potions) {
            tools = '解药 ' + (self.potions.save ? '可用' : '已用') + ' · 毒药 ' + (self.potions.poison ? '可用' : '已用')
        } else if (self.teammates?.length) {
            tools = '你的狼队友 · ' + self.teammates.map(id => seatLabel(view.seats, id)).join('、')
        } else if (self.role === 'seer') {
            const latest = view.privateEvents.findLast(event => event.kind === 'inspect')
            if (latest) tools = '最近一次查验 · ' + latest.text
        }
        $('role-tools').hidden = !tools
        text($('role-tools'), tools)
    }

    function showTargets(view) {
        const legal = view.legal
        const target = $('target')
        const available = availableTargets(legal)
        const key = JSON.stringify([legal?.id, available])
        if (target.dataset.options !== key) {
            target.replaceChildren(option('请选择', ''), ...available.map(id => option(seatLabel(view.seats, id), id)))
            target.dataset.options = key
        }
        target.value = available.includes(selectedTarget) ? String(selectedTarget) : ''
        target.disabled = actionDisabled()
        $('target-submit').disabled = actionDisabled() || !target.value
        $('target-submit').textContent = TARGET_CTA[legal?.kind] ?? '确认'
        $('target-pass').hidden = !legal?.allowPass || legal.kind === 'use_potion'
        $('target-pass').disabled = actionDisabled()
    }

    function updateSpeech() {
        const speech = $('speech')
        const limit = displayed.view?.legal?.maxLength ?? SPEECH_LIMITS[displayed.view?.legal?.kind]
        if (!limit) return
        const codePoints = Array.from(speech.value)
        if (codePoints.length > limit) speech.value = codePoints.slice(0, limit).join('')
        text($('speech-count'), Math.min(codePoints.length, limit) + ' / ' + limit)
        $('speak').disabled = actionDisabled() || !speech.value.trim()
    }

    function showTurn(view, model) {
        const legal = view.legal
        const winner = view.winner
        if (lastLegal !== legal?.id) {
            lastLegal = legal?.id
            acceptedAction = undefined
            $('speech').value = ''
            selectedTarget = undefined
            choosingPoison = false
        }
        const speaking = Boolean(legal && Object.hasOwn(SPEECH_LIMITS, legal.kind))
        const potion = legal?.kind === 'use_potion'
        $('speech-form').hidden = !speaking
        $('target-form').hidden = !legal || speaking || (potion && !choosingPoison)
        $('potions').hidden = !potion
        $('turn-actions').hidden = !legal
        $('skip').hidden = !model.playing
        $('cancel').hidden = !model.busy || model.paused || Boolean(winner)
        $('retry').hidden = !model.paused || model.busy || model.resumeNeedsKey || Boolean(winner)
        $('reconnect').hidden = !model.paused || model.busy || !model.canResume || Boolean(winner)
        text($('reconnect'), model.resumeNeedsKey ? '重新连接模型' : '从存档恢复')
        $('use-local').hidden = !(handlers.useLocal && model.paused && !model.busy && model.mode === 'model' && !winner)
        $('new-game').hidden = model.busy || model.playing || (!winner && !model.paused)
        $('wait-actions').hidden = [...$('wait-actions').children].every(child => child.hidden)
        const wait = view.self.alive ? '等待桌上行动' : '旁观余下牌局'
        text($('turn-title'), winner ? resultLabel(winner) : model.paused ? '牌局已暂停'
            : legal ? ACTION_NAMES[legal.kind] ?? '轮到你行动' : wait)
        let help = legal ? ACTION_HELP[legal.kind] : ''
        if (potion) help = legal.victim ? seatLabel(view.seats, legal.victim) + ' 是你看到的狼刀目标。每夜可用一瓶药。' : '每夜可用一瓶药。'
        if (winner) help = '复盘记录揭晓了所有身份、夜间行动和投票。'
        else if (!help && view.phase === 'night') help = '天亮后统一公布夜间结果。'
        else if (!help) help = '你可以阅读已公开的发言和投票。'
        text($('turn-help'), model.status || help)
        if (speaking) {
            $('speech').maxLength = 2 * (legal.maxLength ?? SPEECH_LIMITS[legal.kind])
            $('speech').placeholder = legal.kind === 'wolf_chat' ? '你会给狼队怎样的建议？' : '你想让这一桌听到什么？'
            $('speech').disabled = actionDisabled()
            text($('speak'), legal.kind === 'last_words' ? '留下遗言' : legal.kind === 'wolf_chat' ? '告诉狼队' : '公开发言')
            $('skip-speech').hidden = !legal.allowPass
            $('skip-speech').disabled = actionDisabled()
            updateSpeech()
        }
        if (potion) {
            $('potion-save').disabled = actionDisabled() || !legal.canSave
            $('potion-poison').disabled = actionDisabled() || !legal.canPoison
            $('potions').querySelector('[data-command=pass]').disabled = actionDisabled()
            $('potion-poison').setAttribute('aria-expanded', String(choosingPoison))
        }
        showTargets(view)
    }

    function showArchive(view, model) {
        const canReview = Boolean(model.recap && (view.winner || model.developer))
        const hasPrivate = Boolean(view.privateEvents?.length || view.legal?.kind === 'wolf_chat')
        $('feed-private').hidden = !hasPrivate
        text($('feed-private'), '我的私密记录' + (view.privateEvents.length ? ' · ' + view.privateEvents.length : ''))
        $('feed-recap').hidden = !canReview
        if (view.legal?.kind === 'wolf_chat' && lastWolfAction !== view.legal.id) {
            lastWolfAction = view.legal.id
            activeFeed = 'private'
        }
        if (view.winner && !previousView?.winner && canReview) activeFeed = 'recap'
        if ((activeFeed === 'recap' && !canReview) || (activeFeed === 'private' && !hasPrivate)) activeFeed = 'public'
        for (const tab of $('archive-tabs').querySelectorAll('[data-feed]')) {
            tab.setAttribute('aria-pressed', String(tab.dataset.feed === activeFeed))
        }

        text($('mode-label'), model.mode === 'model' ? '模型对局' : '规则机器人 · 本地试玩')
        const feed = $('feed')
        const recap = activeFeed === 'recap'
        const events = recap ? model.recap.events.filter(event => event.kind !== 'speak') : activeFeed === 'private' ? view.privateEvents : view.events
        const key = JSON.stringify([activeFeed, recap ? model.recap.seats : null, events])
        if (feedKey !== key) {
            const changedTab = feed.dataset.active !== activeFeed
            const followLatest = feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 52
            const currentScroll = feed.scrollTop
            feed.dataset.active = activeFeed
            feedKey = key
            const content = document.createDocumentFragment()
            if (recap) {
                content.append(element('h3', resultLabel(model.recap.winner), 'recap-summary'))
                const seats = element('ul', undefined, 'recap-seats')
                seats.setAttribute('aria-label', '全部身份')
                for (const seat of model.recap.seats) seats.append(element('li', seatLabel(model.recap.seats, seat.id) + ' · ' + titleOf(seat.role)))
                content.append(seats)
            }
            if (events.length) {
                for (const event of events) content.append(timelineEntry(event, view.seats, activeFeed === 'private' || (recap && !event.public)))
            } else {
                content.append(element('p', activeFeed === 'private' ? '你的私密消息将在这里出现。' : '公开发言与投票结果将在这里出现。', 'feed-empty'))
            }
            feed.replaceChildren(content)
            feed.scrollTop = changedTab && recap ? 0 : (changedTab || followLatest ? feed.scrollHeight : currentScroll)
        }

        $('archive-footer').hidden = false
        $('developer').hidden = false
        $('developer-check').checked = model.developer
        const usage = canReview ? model.usage : null
        $('stats').hidden = !usage
        if (usage) {
            const count = usage.calls ?? 0
            const tokens = [
                ['输入', usage.inputTokens, usage.reportedInputCalls],
                ['输出', usage.outputTokens, usage.reportedOutputCalls],
                ['合计', usage.totalTokens, usage.reportedTotalCalls],
            ].filter(([, value, reports]) => reports || (reports == null && value > 0))
              .map(([name, value]) => name + ' ' + value.toLocaleString() + ' tokens')
            const tokenSummary = tokens.length ? ' · ' + tokens.join(' · ') : ''
            const coverage = usage.reportedCalls && usage.reportedCalls !== count
                ? '（' + usage.reportedCalls + ' 次有用量返回）'
                : count && !usage.reportedCalls ? ' · 服务未返回 token 用量' : ''
            const fallbacks = usage.fallbacks ? ' · 兜底 ' + usage.fallbacks + ' 次' : ''
            text($('stats'), '模型调用 ' + count + ' 次' + tokenSummary + coverage + fallbacks)
        }
        const observations = canReview ? model.observations : null
        const observationsKey = JSON.stringify(observations)
        if (observationKey !== observationsKey) {
            observationKey = observationsKey
            $('observations').replaceChildren()
            for (const [id, record] of Object.entries(observations ?? {})) {
                const info = element('details')
                info.append(element('summary', seatLabel(view.seats, Number(id)) + ' · 最近一次模型观察'))
                info.addEventListener('toggle', () => {
                    const existing = info.querySelector('pre')
                    if (info.open && !existing) info.append(element('pre', JSON.stringify(record, null, 2)))
                    else if (!info.open) existing?.remove()
                })
                $('observations').append(info)
            }
        }
    }

    function render(model) {
        displayed = model
        const view = model.view
        const active = Boolean(view && !configuringNew)
        $('setup').hidden = active
        $('archive').hidden = !active
        $('role-panel').hidden = !active
        $('turn-panel').hidden = !active
        $('speed-control').hidden = !active
        $('fast').checked = Boolean(model.fast)
        if (active) {
            if (!previousView) {
                $('key').value = ''
                activeFeed = 'public'
                lastWolfAction = undefined
                if (view.winner && model.recap) activeFeed = 'recap'
            }
            pendingResume = false
            const night = view.phase === 'night' || (view.phase === 'shoot' && view.legal?.kind === 'shoot'
                && !view.events.some(event => event.day === view.day && event.phase === 'day_discussion'))
            $('table').dataset.light = night ? 'night' : 'day'
            const marker = view.phase === 'night' ? '第 ' + view.day + ' 夜' : PHASE_NAMES[view.phase] ?? '正在结算'
            text($('phase-label'), marker)
            text($('phase-count'), (night ? '' : '第 ' + view.day + ' 天 · ') + view.seats.filter(seat => seat.alive).length + ' 人在席')
            showRole(view)
            showTurn(view, model)
            showArchive(view, model)
        } else {
            if (previousView && !view) {
                configuringNew = false
                activeFeed = 'public'
                acceptedAction = undefined
                lastLegal = undefined
                $('speech').value = ''
                $('key').value = ''
                $('observations').replaceChildren()
                $('feed').replaceChildren()
                observationKey = undefined
                feedKey = undefined
            }
            $('table').dataset.light = 'lobby'
            text($('phase-label'), '等待入席')
            text($('phase-count'), '9 个席位')
            text($('setup-status'), model.status)
            text($('test-status'), model.testStatus)
            $('test').disabled = Boolean(model.testing)
            text($('test'), model.testing ? '正在测试连接…' : '测试连接')
            updateSettings()
        }
        showSeats(active ? view : null)
        previousView = active ? view : null
    }

    function submit(payload) {
        const legal = displayed.view?.legal
        if (!legal || actionDisabled()) return
        acceptedAction = legal.id
        showTurn(displayed.view, displayed)
        showSeats(displayed.view)
        const reject = () => {
            if (acceptedAction !== legal.id) return
            acceptedAction = undefined
            render(displayed)
        }
        try {
            const result = handlers.action(payload, legal.id)
            if (result === false) reject()
            else if (result?.then) result.then(value => { if (value === false) reject() }, reject)
        } catch {
            reject()
        }
    }

    $('setup-form').addEventListener('submit', event => {
        event.preventDefault()
        const config = settings()
        const before = displayed.view
        const wasChoosing = configuringNew
        const wasResuming = pendingResume
        configuringNew = false
        if (wasResuming) handlers.resume(config)
        else handlers.start(config)
        if (wasChoosing && displayed.view === before && displayed.status) {
            configuringNew = true
            pendingResume = wasResuming
            $('key').value = config.key
            render(displayed)
        }
    })
    $('mode-options').addEventListener('change', updateSettings)
    $('base-url').addEventListener('input', updateSettings)
    $('speech').addEventListener('input', updateSpeech)
    $('speech-form').addEventListener('submit', event => {
        event.preventDefault()
        const value = $('speech').value.trim()
        if (value) submit({ text: value })
    })
    $('target').addEventListener('change', () => {
        selectedTarget = Number($('target').value) || undefined
        showTargets(displayed.view)
        showSeats(displayed.view)
    })
    $('target-form').addEventListener('submit', event => {
        event.preventDefault()
        if (!selectedTarget) return
        submit(displayed.view?.legal?.kind === 'use_potion' ? { potion: 'poison', target: selectedTarget } : { target: selectedTarget })
    })
    $('fast').addEventListener('change', event => handlers.setFast(event.target.checked))
    $('developer-check').addEventListener('change', event => handlers.setDeveloper(event.target.checked))
    $('clear-dialog').addEventListener('close', event => {
        if (event.target.returnValue === 'clear') {
            configuringNew = false
            pendingResume = false
            handlers.clear()
        }
    })
    root.addEventListener('click', event => {
        const button = event.target.closest?.('button')
        if (!button || button.disabled) return
        if (button.dataset.feed) {
            activeFeed = button.dataset.feed
            render(displayed)
        }
        if (button.dataset.seat && displayed.view?.legal) {
            const id = Number(button.dataset.seat)
            if (availableTargets(displayed.view.legal).includes(id)) {
                selectedTarget = id
                showTargets(displayed.view)
                showSeats(displayed.view)
            }
        }
        switch (button.dataset.command) {
            case 'skip-speech': submit({ text: '' }); break
            case 'pass': submit(displayed.view?.legal?.kind === 'use_potion' ? { potion: 'pass' } : { target: null }); break
            case 'save-potion': submit({ potion: 'save' }); break
            case 'choose-poison':
                choosingPoison = !choosingPoison
                selectedTarget = undefined
                showTurn(displayed.view, displayed)
                showSeats(displayed.view)
                if (choosingPoison) $('target').focus()
                break
            case 'rules': $('rules-dialog').showModal(); break
            case 'clear':
                $('clear-dialog').returnValue = ''
                $('clear-dialog').showModal()
                break
            case 'test': handlers.test(settings()); break
            case 'retry': handlers.retry(); break
            case 'cancel': handlers.cancel(); break
            case 'skip': handlers.skipPlayback?.(); break
            case 'use-local': handlers.useLocal?.(); break
            case 'new-game':
                configuringNew = true
                radio(displayed.mode === 'model' ? 'model' : 'local').checked = true
                render(displayed)
                $('start').focus()
                break
            case 'resume':
                if (displayed.resumeNeedsKey) {
                    pendingResume = true
                    configuringNew = Boolean(displayed.view)
                    radio('model').checked = true
                    $('base-url').value = displayed.savedConnection?.baseUrl ?? DEFAULT_MODEL_SETTINGS.baseUrl
                    $('model').value = displayed.savedConnection?.model ?? DEFAULT_MODEL_SETTINGS.model
                    $('key').value = ''
                    render(displayed)
                    $('key').focus()
                } else handlers.resume()
                break
            case 'back-setup':
                pendingResume = false
                configuringNew = false
                $('key').value = ''
                render(displayed)
                break
        }
    })

    showSeats(null)
    return { render }
}
