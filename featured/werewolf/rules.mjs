import { PERSONALITIES, ROLES, SEAT_NAMES, SPEECH_LIMITS } from './roles.mjs'

const SAVE_VERSION = 1
const HUMAN = 1
const PENDING_ACTIONS = Object.freeze({
  wolf_chat: 'wolf_chat',
  wolf_kill: 'wolf_kill',
  seer: 'inspect',
  witch: 'use_potion',
  night_hunter: 'shoot',
  day_discussion: 'speak',
  day_vote: 'vote',
  day_revote: 'vote',
  last_words: 'last_words',
  day_hunter: 'shoot',
})
const SIMULTANEOUS = new Set(['wolf_kill', 'day_vote', 'day_revote'])
const ROLE_DECK = Object.entries(ROLES).flatMap(([role, definition]) => Array(definition.count).fill(role))

function shuffle(items, seed) {
  const result = [...items]
  let entropy = seed >>> 0
  for (let index = result.length - 1; index > 0; index--) {
    entropy = (entropy + 0x9e3779b9) >>> 0
    let sample = Math.imul(entropy ^ (entropy >>> 16), 0x21f0aaad)
    sample = Math.imul(sample ^ (sample >>> 15), 0x735a2d97)
    const random = (sample ^ (sample >>> 15)) >>> 0
    const other = Math.floor((random / 2 ** 32) * (index + 1))
    ;[result[index], result[other]] = [result[other], result[index]]
  }
  return result
}

function seat(state, id) {
  return state.seats[id - 1]
}

function alive(state, filter = () => true) {
  return state.seats.filter(player => player.alive && filter(player)).map(player => player.id)
}

function playerName(state, id) {
  return id === HUMAN ? '1 号（你）' : id + ' 号 ' + seat(state, id).name
}

function append(state, visibility, kind, text, fields = {}) {
  state.events.push({
    id: state.events.length + 1,
    day: state.day,
    kind,
    text,
    ...fields,
    visibility,
  })
}

function makeGame(gameId, seed, humanRole) {
  const roles = shuffle(ROLE_DECK, seed ^ 0x7342eb01)
  if (humanRole) {
    const selected = roles.indexOf(humanRole)
    ;[roles[0], roles[selected]] = [roles[selected], roles[0]]
  }
  const personalities = shuffle(PERSONALITIES, seed ^ 0x3917df20)
  const state = {
    version: SAVE_VERSION,
    gameId,
    seed,
    humanRole,
    day: 1,
    winner: null,
    seats: SEAT_NAMES.map((name, index) => ({
      id: index + 1, name, alive: true, role: roles[index],
      personality: { ...personalities[index] },
    })),
    events: [],
    journal: [],
    potions: { save: true, poison: true },
    hunterUsed: false,
    phaseSerial: 0,
    phase: null,
    night: null,
    dayVote: { candidates: [], exile: null },
  }
  startNight(state)
  return state
}

export function newGame({ humanRole = null, seed = crypto.getRandomValues(new Uint32Array(1))[0] } = {}) {
  const specified = humanRole !== null && humanRole !== ''
  if (specified && (typeof humanRole !== 'string' || !Object.hasOwn(ROLES, humanRole))) throw new Error('未知身份')
  if (!Number.isSafeInteger(seed) || seed < 0 || seed >= 2 ** 32) throw new Error('随机种子须为无符号 32 位整数')
  return makeGame(crypto.randomUUID(), seed, humanRole || null)
}

function setPhase(state, kind, actors = []) {
  state.phase = {
    id: state.gameId + ':' + ++state.phaseSerial,
    kind,
    actors,
    responses: {},
  }
  if (kind !== 'over' && !actors.length) finishPhase(state)
}

function startNight(state) {
  state.dayVote = { candidates: [], exile: null }
  state.night = { target: null, poison: null, saved: false, deaths: [] }
  append(state, 'public', 'phase', '第 ' + state.day + ' 夜。', { phase: 'night' })
  setPhase(state, 'wolf_chat', alive(state, player => player.role === 'wolf'))
}

function startDay(state) {
  append(state, 'public', 'phase', '第 ' + state.day + ' 天，天亮了。', { phase: 'day_discussion' })
  const deaths = state.night.deaths
  if (!deaths.length) append(state, 'public', 'death', '昨夜无人出局。', { seats: [] })
  for (const death of deaths) {
    if (death.cause === 'shot') {
      append(state, 'public', 'shoot', playerName(state, death.from) + ' 开枪带走了 ' + playerName(state, death.id) + '。', {
        seat: death.from, target: death.id,
      })
    }
    append(state, 'public', 'death', playerName(state, death.id) + ' 昨夜出局。', { seat: death.id })
  }
  state.night = null
  if (finishIfWon(state)) return
  const firstSeat = (state.day - 1) % state.seats.length + 1
  const order = alive(state).sort((left, right) =>
    ((left - firstSeat + state.seats.length) % state.seats.length)
    - ((right - firstSeat + state.seats.length) % state.seats.length))
  setPhase(state, 'day_discussion', order)
}

function finishDay(state) {
  if (finishIfWon(state)) return
  state.day++
  startNight(state)
}

function finishIfWon(state) {
  const wolves = alive(state, player => player.role === 'wolf').length
  const villagers = alive(state).length - wolves
  if (wolves && wolves < villagers) return false
  state.winner = wolves ? 'wolf' : 'village'
  append(state, 'public', 'result', wolves ? '狼人阵营获胜。' : '好人阵营获胜。', { winner: state.winner })
  setPhase(state, 'over')
  return true
}

function nextAction(state, actor) {
  const kind = PENDING_ACTIONS[state.phase.kind]
  const phaseId = state.phase.id
  const action = { id: phaseId + '/' + actor + '/' + kind, phaseId, actor, kind, targets: [], allowPass: false }
  if (Object.hasOwn(SPEECH_LIMITS, kind)) return { ...action, maxLength: SPEECH_LIMITS[kind], allowPass: true }
  if (kind === 'wolf_kill') return { ...action, targets: alive(state, player => player.role !== 'wolf') }
  if (kind === 'use_potion') {
    const victim = state.night.target
    return { ...action, allowPass: true, victim, canSave: state.potions.save && victim !== null && (actor !== victim || state.day === 1),
      canPoison: state.potions.poison && alive(state, player => player.id !== actor).length > 0,
      targets: state.potions.poison ? alive(state, player => player.id !== actor) : [],
    }
  }
  const eligible = kind === 'vote' && state.phase.kind === 'day_revote' ? state.dayVote.candidates : alive(state)
  const targets = eligible.filter(id => id !== actor)
  return { ...action, targets, allowPass: kind === 'shoot' || targets.length === 0 }
}

export function pending(state) {
  if (state.winner) return []
  const actors = state.phase.actors.filter(actor => !Object.hasOwn(state.phase.responses, actor))
  const open = SIMULTANEOUS.has(state.phase.kind) ? actors : actors.slice(0, 1)
  return open.map(actor => nextAction(state, actor))
}

function accepts(action, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const keys = Object.keys(payload)
  if (action.maxLength) {
    return keys.length === 1 && keys[0] === 'text' && typeof payload.text === 'string'
      && Array.from(payload.text.trim()).length <= action.maxLength
  }
  if (action.kind === 'use_potion') {
    if (payload.potion === 'poison') {
      return keys.length === 2 && keys.includes('potion') && keys.includes('target')
        && action.canPoison && action.targets.includes(payload.target)
    }
    return keys.length === 1 && keys[0] === 'potion'
      && (payload.potion === 'pass' || (payload.potion === 'save' && action.canSave))
  }
  return keys.length === 1 && keys[0] === 'target'
    && (action.targets.includes(payload.target) || (payload.target === null && action.allowPass))
}

function currentAction(state, action) {
  if (!action || action.phaseId !== state.phase.id) return undefined
  return pending(state).find(candidate => candidate.id === action.id
    && candidate.actor === action.actor && candidate.kind === action.kind)
}

export function validate(state, action, payload) {
  const actual = currentAction(state, action)
  return actual ? accepts(actual, payload) : false
}

function recordSpeech(state, action, payload) {
  if (!action.maxLength) return
  const audience = action.kind === 'wolf_chat' ? alive(state, player => player.role === 'wolf') : 'public'
  const text = payload.text || '略过发言。'
  append(state, audience, action.kind, text, { seat: action.actor })
}

function applyAction(state, action, payload) {
  state.phase.responses[action.actor] = payload
  state.journal.push({ id: action.id, payload })
  recordSpeech(state, action, payload)
  if (state.phase.actors.length === Object.keys(state.phase.responses).length) finishPhase(state)
}

function canonicalPayload(action, payload) {
  return action.maxLength ? { text: payload.text.trim() } : { ...payload }
}

export function submit(state, action, payload) {
  const actual = currentAction(state, action)
  if (!actual || !accepts(actual, payload)) throw new Error('行动已过期、重复或不符合规则')
  const next = structuredClone(state)
  applyAction(next, actual, canonicalPayload(actual, payload))
  return next
}

function ballots(state) {
  return state.phase.actors.map(actor => ({ actor, target: state.phase.responses[actor].target }))
}

function leaders(votes) {
  const counts = new Map()
  for (const { target } of votes) {
    if (target !== null) counts.set(target, (counts.get(target) || 0) + 1)
  }
  const top = Math.max(0, ...counts.values())
  return [...counts.keys()].filter(id => counts.get(id) === top).sort((left, right) => left - right)
}

function wolfVote(state) {
  const votes = ballots(state)
  const target = leaders(votes)[0]
  state.night.target = target
  append(state, [...state.phase.actors], 'wolf_kill', '狼队选中 ' + playerName(state, target) + '。', { target, votes })
  setPhase(state, 'seer', alive(state, player => player.role === 'seer'))
}

function checkSeer(state) {
  const actor = state.phase.actors[0]
  if (actor) {
    const target = state.phase.responses[actor].target
    const alignment = ROLES[seat(state, target).role].alignment
    append(state, [actor], 'inspect', '查验 ' + playerName(state, target) + '，对方属于' + (alignment === 'wolf' ? '狼人' : '好人') + '阵营。', {
      seat: actor, target, alignment,
    })
  }
  const witches = alive(state, player => player.role === 'witch' && (state.potions.poison
    || (state.potions.save && (state.day === 1 || player.id !== state.night.target))))
  setPhase(state, 'witch', witches)
}

function usePotion(state) {
  const actor = state.phase.actors[0]
  if (!actor) return
  const response = state.phase.responses[actor]
  const victim = state.night.target
  append(state, 'recap', 'witch_target', '女巫得知狼刀目标是 ' + playerName(state, victim) + '。', { seat: actor, target: victim })
  if (response.potion === 'save') {
    state.potions.save = false
    state.night.saved = true
    append(state, [actor], 'use_potion', '解药救了 ' + playerName(state, victim) + '。', { seat: actor, target: victim, potion: 'save' })
  }
  if (response.potion === 'poison') {
    state.potions.poison = false
    state.night.poison = response.target
    append(state, [actor], 'use_potion', '使用毒药，目标是 ' + playerName(state, response.target) + '。', {
      seat: actor, target: response.target, potion: 'poison',
    })
  }
  if (response.potion === 'pass') append(state, [actor], 'use_potion', '本夜未用药。', { seat: actor, potion: 'pass' })
}

function resolveNight(state) {
  const { saved, target, poison } = state.night
  const casualties = new Map()
  if (target !== null && !saved) casualties.set(target, 'wolf')
  if (poison !== null) casualties.set(poison, 'poison')
  const entries = [...casualties.entries()].sort(([left], [right]) => left - right)
  for (const [id, cause] of entries) {
    seat(state, id).alive = false
    state.night.deaths.push({ id, cause })
    append(state, 'recap', 'night_death', playerName(state, id) + (cause === 'poison' ? ' 因中毒出局。' : ' 因狼刀出局。'), { seat: id, cause })
  }
  const hunter = entries.find(([id, cause]) => cause === 'wolf' && seat(state, id).role === 'hunter')
  if (hunter && !state.hunterUsed) setPhase(state, 'night_hunter', [hunter[0]])
  else startDay(state)
}

function resolveShot(state, night) {
  const actor = state.phase.actors[0]
  const target = state.phase.responses[actor].target
  state.hunterUsed = true
  if (target === null) {
    append(state, [actor], 'shoot', '猎人选择不开枪。', { seat: actor, target })
    return
  }
  seat(state, target).alive = false
  if (night) state.night.deaths.push({ id: target, cause: 'shot', from: actor })
  else {
    append(state, 'public', 'shoot', playerName(state, actor) + ' 开枪带走了 ' + playerName(state, target) + '。', { seat: actor, target })
    append(state, 'public', 'death', playerName(state, target) + ' 被猎人带走。', { seat: target })
  }
}

function resolveDayVote(state, revote) {
  const votes = ballots(state)
  append(state, 'public', 'votes', revote ? '加投结果。' : '首轮投票结果。', { votes, revote })
  const top = leaders(votes)
  if (top.length > 1 && !revote) {
    state.dayVote.candidates = top
    append(state, 'public', 'phase', '平票候选 ' + top.join('、') + ' 号进入加投。', { phase: 'day_revote', candidates: top })
    setPhase(state, 'day_revote', alive(state))
    return
  }
  if (top.length !== 1) {
    append(state, 'public', 'death', '本轮无人被放逐。', { seats: [] })
    finishDay(state)
    return
  }
  const exile = top[0]
  seat(state, exile).alive = false
  state.dayVote.exile = exile
  append(state, 'public', 'death', playerName(state, exile) + ' 被投票放逐。', { seat: exile })
  setPhase(state, 'last_words', [exile])
}

function finishPhase(state) {
  switch (state.phase.kind) {
    case 'wolf_chat':
      setPhase(state, 'wolf_kill', alive(state, player => player.role === 'wolf'))
      return
    case 'wolf_kill':
      wolfVote(state)
      return
    case 'seer':
      checkSeer(state)
      return
    case 'witch':
      usePotion(state)
      resolveNight(state)
      return
    case 'night_hunter':
      resolveShot(state, true)
      startDay(state)
      return
    case 'day_discussion':
      append(state, 'public', 'phase', '开始放逐投票。', { phase: 'day_vote' })
      setPhase(state, 'day_vote', alive(state))
      return
    case 'day_vote':
      resolveDayVote(state, false)
      return
    case 'day_revote':
      resolveDayVote(state, true)
      return
    case 'last_words': {
      const exile = state.dayVote.exile
      if (seat(state, exile).role === 'hunter' && !state.hunterUsed) setPhase(state, 'day_hunter', [exile])
      else finishDay(state)
      return
    }
    case 'day_hunter':
      resolveShot(state, false)
      finishDay(state)
      return
    default:
      throw new Error('无法结算该阶段')
  }
}

/** Recreate authoritative state from the deal and validated actions. */
export function restoreState(raw) {
  if (!raw || raw.version !== SAVE_VERSION || typeof raw.gameId !== 'string'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(raw.gameId)
    || !Number.isSafeInteger(raw.seed) || raw.seed < 0 || raw.seed >= 2 ** 32
    || (raw.humanRole !== null && (typeof raw.humanRole !== 'string' || !Object.hasOwn(ROLES, raw.humanRole)))
    || !Array.isArray(raw.journal)) throw new Error('无法读取这个版本的存档')
  const state = makeGame(raw.gameId, raw.seed, raw.humanRole)
  for (const record of raw.journal) {
    const action = pending(state).find(candidate => candidate.id === record?.id)
    if (!action || !accepts(action, record.payload)) throw new Error('存档包含无效行动')
    applyAction(state, action, canonicalPayload(action, record.payload))
  }
  return state
}
