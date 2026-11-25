import { BOARDS, ROLES, RULES, SPEECH_LIMITS } from './roles.mjs'
import { CHARACTERS, HUMAN_AVATARS, characterById } from './characters.mjs'
import { completionEndpoint, DEFAULT_MODEL_SETTINGS } from './model.mjs'
import { speakingOrderLabel } from './playback.mjs'
import { PORTRAITS } from './portraits.mjs'

const PHASE_NAMES = {
    night: '入夜', day_discussion: '白天发言', day_vote: '放逐投票', day_pk: '平票 PK', day_revote: '平票加投',
    shoot: '技能结算', last_words: '遗言', over: '牌局结束',
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
const SPEECH_EVENTS = new Set(['speak', 'wolf_chat', 'last_words'])
const BOARD_ROLE_NAMES = { wolf: '狼', villager: '民' }
const AVATAR_STORAGE = 'featured.werewolf.portraits-v1'
const AVATAR_FILE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_AVATAR_SIZE = 4 * 1024 * 1024
const allPortraits = [...Object.values(HUMAN_AVATARS), ...CHARACTERS]

function readPortraits() {
    try {
        const saved = JSON.parse(localStorage.getItem(AVATAR_STORAGE) ?? '{}')
        return new Map(allPortraits.flatMap(({ id }) => {
            const url = saved?.[id]
            return typeof url === 'string' && url.length <= 120000 && /^data:image\/(?:webp|png|jpeg);base64,[a-z\d+/]+=*$/i.test(url)
                ? [[id, url]] : []
        }))
    } catch { return new Map() }
}

async function decodePortrait(file) {
    if (!AVATAR_FILE_TYPES.has(file.type) || !file.size || file.size > MAX_AVATAR_SIZE) {
        throw new Error('请选择 4 MB 以内的 PNG、JPG 或 WebP 图片。')
    }
    const url = URL.createObjectURL(file)
    try {
        const image = new Image()
        image.src = url
        await image.decode()
        const { naturalWidth: width, naturalHeight: height } = image
        if (!width || !height || width * height > 16000000) throw new Error('请选用分辨率较低的图片。')
        const crop = Math.min(width, height)
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 128
        canvas.getContext('2d').drawImage(image, (width - crop) / 2, (height - crop) / 2, crop, crop, 0, 0, 128, 128)
        return canvas.toDataURL('image/webp', 0.86)
    } finally { URL.revokeObjectURL(url) }
}

function lobbySeats(size, avatar) {
    return Array.from({ length: size }, (_, index) => {
        const profile = index === 0 ? HUMAN_AVATARS[avatar] : CHARACTERS[index - 1]
        return { id: index + 1, name: profile.name, alive: true, characterId: profile.id }
    })
}

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

function actionTitle(view) {
    if (view.legal?.kind === 'speak' && view.phase === 'day_pk') return '轮到你做 PK 发言'
    return ACTION_NAMES[view.legal?.kind]
}

function timelineEntry(event, seats, privately, drawPortrait) {
    const row = element('article', undefined, 'feed-entry')
    if (privately) row.dataset.kind = 'private'
    const heading = element('div', undefined, 'event-heading')
    const speaker = SPEECH_EVENTS.has(event.kind) && seats.find(seat => seat.id === event.seat)
    const byline = element('div', undefined, 'event-byline')
    if (speaker) {
        const portrait = element('div', undefined, 'avatar')
        portrait.setAttribute('aria-hidden', 'true')
        drawPortrait(portrait, speaker)
        byline.append(portrait)
    }
    byline.append(element('strong', speaker ? seatLabel(seats, event.seat) : EVENT_NAMES[event.kind] ?? '牌局记录'))
    heading.append(byline)
    const category = NIGHT_EVENTS.has(event.kind) || event.phase === 'night' ? '夜' : '天'
    const stage = event.pk ? ' · PK 发言' : privately ? ' · 私密' : ''
    heading.append(element('span', event.day ? '第 ' + event.day + ' ' + category + stage : ''))
    row.append(heading, element('p', event.text))
    const order = speakingOrderLabel(event)
    if (order) row.append(element('p', order.replace('\n', '　')))
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
        'playback-speed', 'speed-control', 'table', 'phase-label', 'phase-count', 'seats', 'role-panel', 'role-name',
        'role-state', 'role-desc', 'role-tools', 'turn-panel', 'turn-title', 'turn-help', 'turn-actions',
        'speech-form', 'speech', 'speech-count', 'speak', 'skip-speech', 'target-form', 'target', 'target-submit',
        'target-pass', 'potions', 'potion-save', 'potion-poison', 'skip', 'cancel', 'retry', 'use-local',
        'wait-actions', 'setup', 'setup-title', 'setup-form', 'mode-options', 'connection', 'base-url',
        'model', 'key', 'test', 'test-status', 'destination', 'setup-role', 'human-role', 'start', 'saved-controls',
        'resume', 'clear', 'back-setup', 'setup-status', 'archive', 'mode-label', 'archive-tabs', 'feed-private',
        'feed-recap', 'feed', 'archive-footer', 'stats', 'developer', 'developer-check', 'observations',
        'rules-dialog', 'rules-title', 'rules-list', 'clear-dialog', 'new-game', 'reconnect', 'replace-notice',
        'board-size', 'lineup', 'human-avatar', 'human-avatar-preview', 'role-avatar', 'avatar-character', 'avatar-file',
        'avatar-image-preview', 'avatar-status', 'avatar-customize', 'restore-avatar', 'advance-playback', 'playback-avatar',
        'playback', 'playback-title', 'playback-detail', 'playback-actions', 'playback-count', 'invitation',
        'friends-dialog', 'friend-profile', 'friend-avatar', 'friend-name', 'friend-traits', 'friend-voice', 'friend-source',
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
    let friendChoices = []
    let renderedSize = 0
    let seatElements = []
    const portraits = readPortraits()
    const portraitSnapshots = new WeakMap()
    const portraitById = new Map(allPortraits.map(profile => [profile.id, profile]))

    const radio = value => root.querySelector('input[name=mode][value=' + value + ']')
    $('base-url').value = DEFAULT_MODEL_SETTINGS.baseUrl
    $('model').value = DEFAULT_MODEL_SETTINGS.model
    for (const profile of Object.values(HUMAN_AVATARS)) $('human-avatar').append(option(profile.name, profile.id))
    $('human-avatar').value = 'lumine'
    for (const profile of allPortraits) $('avatar-character').append(option(profile.name, profile.id))
    for (const [heading, explanation] of RULES) $('rules-list').append(element('dt', heading), element('dd', explanation))

    function drawPortrait(node, profile) {
        const custom = portraits.get(profile.id)
        const artwork = PORTRAITS[profile.id]
        const key = [profile.id, profile.icon, profile.accent, custom, artwork]
        const previous = portraitSnapshots.get(node)
        if (previous?.every((value, index) => value === key[index])) return
        portraitSnapshots.set(node, key)
        node.style.setProperty('--portrait', profile.accent || '#d9b987')
        delete node.dataset.portrait
        node.replaceChildren(profile.icon)
        const imageUrl = custom || artwork?.image
        if (!imageUrl) return
        const image = element('img')
        image.alt = ''
        if (!custom && artwork.position) {
            image.style.objectPosition = artwork.position
            image.style.transformOrigin = artwork.position
        }
        if (!custom && artwork.zoom) image.style.transform = 'scale(' + artwork.zoom + ')'
        const placeholder = node.firstChild
        image.addEventListener('load', () => {
            if (image.parentNode !== node) return
            node.dataset.portrait = 'ready'
            placeholder.remove()
        }, { once: true })
        image.addEventListener('error', () => image.remove(), { once: true })
        node.append(image)
        image.src = imageUrl
    }

    function drawSeatPortrait(node, seat) {
        const profile = seat.characterId && (portraitById.get(seat.characterId) ?? characterById(seat.characterId))
        drawPortrait(node, profile || { id: '', icon: Array.from(seat.name)[0] ?? '席' })
    }

    function allocateSeats(size) {
        if (size === renderedSize) return
        renderedSize = size
        $('table').dataset.size = size
        const seats = document.createDocumentFragment()
        seatElements = Array.from({ length: size }, (_, index) => {
            const id = index + 1
            const item = element('li', undefined, 'seat')
            const angle = Math.PI / 2 + index * Math.PI * 2 / size
            item.style.setProperty('--x', (50 + 38 * Math.cos(angle)) + '%')
            item.style.setProperty('--y', (50 + 39 * Math.sin(angle)) + '%')
            const button = element('button', undefined, 'seat-button')
            button.type = 'button'
            button.dataset.seat = id
            const token = element('span', undefined, 'seat-token')
            const portrait = element('span', undefined, 'avatar')
            const number = element('span', id, 'seat-number')
            token.setAttribute('aria-hidden', 'true')
            token.append(portrait, number)
            const copy = element('span', undefined, 'seat-content')
            const name = element('span', undefined, 'seat-name')
            const note = element('span', undefined, 'seat-note')
            note.setAttribute('aria-hidden', 'true')
            copy.append(name, note)
            button.append(token, copy)
            item.append(button)
            seats.append(item)
            return { button, name, note, portrait }
        })
        $('seats').replaceChildren(seats)
    }

    function updateBoardSetup() {
        const size = Number($('board-size').value)
        const role = $('human-role').value
        const choices = Object.entries(BOARDS[size]).filter(([, count]) => count > 0)
        $('human-role').replaceChildren(option('随机抽取', ''), ...choices.map(([id]) => option(titleOf(id), id)))
        $('human-role').value = choices.some(([id]) => id === role) ? role : ''
        drawPortrait($('human-avatar-preview'), HUMAN_AVATARS[$('human-avatar').value])
    }

    function lineup(size) {
        return Object.entries(BOARDS[size]).filter(([, count]) => count > 0)
            .map(([role, count]) => BOARD_ROLE_NAMES[role] ? count + ' ' + BOARD_ROLE_NAMES[role] : titleOf(role))
            .join(' · ')
    }

    function updateAvatarSetup() {
        const profile = portraitById.get($('avatar-character').value)
        if (!profile) return
        drawPortrait($('avatar-image-preview'), profile)
        $('restore-avatar').disabled = !portraits.has(profile.id)
    }

    function storePortrait(profile, data) {
        const next = new Map(portraits)
        if (data) next.set(profile.id, data)
        else next.delete(profile.id)
        localStorage.setItem(AVATAR_STORAGE, JSON.stringify(Object.fromEntries(next)))
        if (data) portraits.set(profile.id, data)
        else portraits.delete(profile.id)
        updateAvatarSetup()
        updateBoardSetup()
        render(displayed)
    }

    function showFriend() {
        const profile = friendChoices[Number($('friend-profile').value)]
        const artwork = profile && PORTRAITS[profile.id]
        const source = $('friend-source')
        source.hidden = !artwork
        $('friend-traits').replaceChildren()
        $('friend-voice').hidden = !profile?.personality.voice
        $('friend-avatar').hidden = !profile
        text($('friend-name'), profile?.name)
        if (!profile) return
        drawPortrait($('friend-avatar'), profile)
        const { tone, risk, habit, voice } = profile.personality
        for (const [heading, detail] of [['语气', tone], ['风险偏好', risk], ['观察习惯', habit]]) {
            if (detail) $('friend-traits').append(element('dt', heading), element('dd', detail))
        }
        if (voice) text($('friend-voice'), voice.replaceAll('{target}', '三号'))
        if (artwork) {
            source.href = artwork.source
            text(source, '头像原图 · ' + artwork.author)
        }
    }

    function openFriends() {
        const seats = configuringNew ? null : displayed.view?.seats
        friendChoices = seats ? seats.slice(1).map(seat => {
            return portraitById.get(seat.characterId) ?? {
                id: '', name: seat.name, icon: Array.from(seat.name)[0], personality: {},
            }
        }) : CHARACTERS
        const host = HUMAN_AVATARS.lumine
        if (!seats || seats[0]?.characterId === host.id) friendChoices = [...friendChoices, host]
        $('friend-profile').replaceChildren(...friendChoices.map((person, index) => option(person.name, index)))
        showFriend()
        $('friends-dialog').showModal()
    }

    function settings() {
        return {
            mode: radio('model').checked ? 'model' : 'local',
            size: Number($('board-size').value),
            avatar: $('human-avatar').value,
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
        $('avatar-customize').hidden = pendingResume
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
        const list = view?.seats ?? lobbySeats(Number($('board-size').value), $('human-avatar').value)
        allocateSeats(list.length)
        const cue = displayed.playbackCue
        const speaker = displayed.playing ? (cue?.kind === 'speech' ? cue.seat : undefined) : view?.speaker
        const speakerStatus = displayed.playing ? '正在回看此席发言' : '当前发言席'
        const available = availableTargets(view?.legal)
        const disabled = actionDisabled()
        list.forEach((seat, index) => {
            const { button, name, note, portrait } = seatElements[index]
            const isSelf = seat.id === view?.self.id || (!view && seat.id === 1)
            const target = !disabled && available.includes(seat.id)
            const labels = [isSelf ? '你' : '', seat.role ? titleOf(seat.role) : '', seat.alive ? '' : '出局'].filter(Boolean)
            text(name, seat.name)
            text(note, labels.join(' · ') || (view ? '在席' : '候场'))
            drawSeatPortrait(portrait, seat)
            button.setAttribute('aria-label', [seat.id + ' 号 ' + seat.name, ...labels, speaker === seat.id ? speakerStatus : ''].filter(Boolean).join('，'))
            button.disabled = !target
            button.dataset.target = target
            button.dataset.self = isSelf
            button.dataset.out = !seat.alive
            button.dataset.active = view?.legal?.actor === seat.id || speaker === seat.id
            if (target) button.setAttribute('aria-pressed', String(seat.id === selectedTarget))
            else button.removeAttribute('aria-pressed')
        })
    }

    function showRole(view) {
        if (!view) return
        const { self } = view
        drawSeatPortrait($('role-avatar'), self)
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
        $('cancel').hidden = !model.busy || model.paused || Boolean(winner)
        $('retry').hidden = !model.paused || model.busy || model.resumeNeedsKey || Boolean(winner)
        $('reconnect').hidden = !model.paused || model.busy || !model.canResume || Boolean(winner)
        text($('reconnect'), model.resumeNeedsKey ? '重新连接模型' : '从存档恢复')
        $('use-local').hidden = !(handlers.useLocal && model.paused && !model.busy && model.mode === 'model' && !winner)
        $('new-game').hidden = model.busy || model.playing || (!winner && !model.paused)
        $('wait-actions').hidden = [...$('wait-actions').children].every(child => child.hidden)
        const wait = view.self.alive ? '等待桌上行动' : '旁观余下牌局'
        text($('turn-title'), winner ? resultLabel(winner) : model.paused ? '牌局已暂停'
            : legal ? actionTitle(view) ?? '轮到你行动' : wait)
        let help = legal ? ACTION_HELP[legal.kind] : ''
        if (legal?.kind === 'speak' && view.phase === 'day_pk') help = '你可以回应首轮的票型，并向等候加投的玩家陈述理由。'
        if (potion) help = legal.victim ? seatLabel(view.seats, legal.victim) + ' 是你看到的狼刀目标。每夜可用一瓶药。' : '每夜可用一瓶药。'
        if (winner) help = '复盘记录揭晓了所有身份、夜间行动和投票。'
        else if (!help && view.phase === 'night') help = '天亮后统一公布夜间结果。'
        else if (!help) help = '你可以阅读已公开的发言和投票。'
        text($('turn-help'), model.status || help)
        if (speaking) {
            $('speech').maxLength = 2 * (legal.maxLength ?? SPEECH_LIMITS[legal.kind])
            $('speech').placeholder = legal.kind === 'wolf_chat' ? '你会给狼队怎样的建议？' : '你想让这一桌听到什么？'
            $('speech').disabled = actionDisabled()
            text($('speak'), legal.kind === 'last_words' ? '留下遗言' : legal.kind === 'wolf_chat' ? '告诉狼队'
                : view.phase === 'day_pk' ? '提交 PK 发言' : '公开发言')
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
                for (const event of events) content.append(timelineEntry(event, view.seats,
                    activeFeed === 'private' || (recap && !event.public), drawSeatPortrait))
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

    function showPlayback(view, model) {
        const cue = model.playbackCue
        const playing = Boolean(model.playing)
        const pending = Number(model.pendingFrames) || 0
        $('playback').dataset.running = playing
        $('playback').dataset.kind = playing ? cue?.kind ?? '' : view.winner ? 'result'
            : view.phase === 'night' ? 'night' : view.speaker ? 'speech' : ''
        $('playback-actions').hidden = !playing
        text($('advance-playback'), model.nextLabel || '继续')
        text($('playback-count'), pending ? pending + ' 条待读' : '')
        const speakerId = playing ? (cue?.kind === 'speech' ? cue.seat : undefined) : view.speaker
        const speaker = view.seats.find(seat => seat.id === speakerId)
        $('playback-avatar').hidden = !speaker
        if (speaker) drawSeatPortrait($('playback-avatar'), speaker)
        const stage = PHASE_NAMES[view.phase]
        const currentSpeaker = speaker && '轮到 ' + seatLabel(view.seats, speaker.id) + (view.phase === 'last_words'
            ? ' 留遗言' : view.phase === 'day_pk' ? ' 做 PK 发言' : ' 发言')
        const title = playing ? cue?.title || stage : view.winner ? resultLabel(view.winner)
            : actionTitle(view) || currentSpeaker || stage
        text($('playback-title'), title || '等待桌上行动')
        const order = playing ? '' : speakingOrderLabel(view.events.findLast(event => event.day === view.day && event.phase === view.phase))
        let detail = cue?.detail || ''
        if (!playing && cue) {
            const stageCue = (cue.kind === 'dawn' && view.phase === 'day_discussion')
                || (cue.kind === 'night' && view.phase === 'night') || (cue.kind === 'result' && view.winner)
            if (!stageCue) {
                const history = detail && '上一条 · ' + cue.title + '\n' + detail
                detail = [order, history].filter(Boolean).join('\n\n')
            }
        } else if (!playing) detail = order
        const previousDetail = $('playback-detail').textContent
        text($('playback-detail'), detail)
        $('playback-detail').hidden = !detail
        if (previousDetail !== detail) $('playback-detail').scrollTop = 0
    }

    function render(model) {
        displayed = model
        const view = model.view
        const active = Boolean(view && !configuringNew)
        $('setup').hidden = active
        $('archive').hidden = !active
        $('role-panel').hidden = !active
        $('turn-panel').hidden = !active
        $('speed-control').hidden = false
        $('playback-speed').value = model.speed ?? 'manual'
        $('playback').hidden = !active
        const size = active ? view.seats.length : Number($('board-size').value)
        text($('lineup'), size + ' 人局 · ' + lineup(size))
        text($('rules-title'), size + ' 人局规则')
        const avatarId = active ? view.self.characterId : $('human-avatar').value
        text($('invitation'), avatarId === 'lumine' ? '荧邀请朋友来玩狼人杀。' : '你邀请朋友来玩狼人杀。')
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
            showPlayback(view, model)
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
            text($('phase-count'), size + ' 个席位')
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
    $('board-size').addEventListener('change', () => { updateBoardSetup(); render(displayed) })
    $('human-avatar').addEventListener('change', () => { updateBoardSetup(); render(displayed) })
    $('avatar-character').addEventListener('change', () => { updateAvatarSetup(); text($('avatar-status'), '') })
    $('avatar-file').addEventListener('change', async event => {
        const file = event.target.files[0]
        if (!file) return
        const profile = portraitById.get($('avatar-character').value)
        event.target.value = ''
        try {
            storePortrait(profile, await decodePortrait(file))
            text($('avatar-status'), '已在本机更新 ' + profile.name + ' 的头像。')
        } catch (error) {
            text($('avatar-status'), error instanceof Error && error.name === 'Error' ? error.message : '图片无法读取或保存。')
        }
    })
    $('friend-profile').addEventListener('change', showFriend)
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
    $('playback-speed').addEventListener('change', event => handlers.setSpeed(event.target.value))
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
            case 'friends': openFriends(); break
            case 'restore-avatar': {
                const profile = portraitById.get($('avatar-character').value)
                try { storePortrait(profile, null); text($('avatar-status'), '已恢复 ' + profile.name + ' 的默认头像。') }
                catch { text($('avatar-status'), '浏览器无法清除这个头像。') }
                break
            }
            case 'clear':
                $('clear-dialog').returnValue = ''
                $('clear-dialog').showModal()
                break
            case 'test': handlers.test(settings()); break
            case 'retry': handlers.retry(); break
            case 'cancel': handlers.cancel(); break
            case 'skip': handlers.skipPlayback?.(); break
            case 'advance-playback': handlers.advancePlayback?.(); break
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

    updateBoardSetup()
    updateAvatarSetup()
    showSeats(null)
    return { render }
}
