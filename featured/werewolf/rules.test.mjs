import assert from 'node:assert/strict'
import test from 'node:test'
import { newGame, pending, restoreState, submit, validate } from './rules.mjs'
import { BOARDS } from './roles.mjs'
import { observe, reveal } from './visibility.mjs'

const fixed = (humanRole = 'villager') => newGame({ humanRole, seed: 7103 })
const roleSeat = (state, role) => state.seats.find(player => player.role === role).id
const legacyId = '00000000-0000-4000-8000-000000000001'

function legacyState(seed, journal = []) {
  return restoreState({ version: 1, gameId: legacyId, seed, humanRole: 'villager', journal })
}

function resolvePhase(state, decide) {
  const phaseId = state.phase.id
  while (state.phase.id === phaseId && !state.winner) {
    const [action] = pending(state)
    assert.ok(action)
    state = submit(state, action, decide(action))
  }
  return state
}

function finishNight(state, target) {
  state = resolvePhase(state, () => ({ text: '夜间商议' }))
  state = resolvePhase(state, () => ({ target }))
  if (state.phase.kind === 'seer') state = resolvePhase(state, action => ({ target: action.targets[0] }))
  return state
}

function exile(state, target) {
  state = resolvePhase(state, () => ({ text: '' }))
  return resolvePhase(state, action => ({ target: action.targets.includes(target) ? target : action.targets[0] }))
}

test('valid role counts and independently dealt characters on all boards', () => {
  const expectedCounts = { 6: [2, 2, 1, 1, 0], 9: [3, 3, 1, 1, 1], 12: [4, 5, 1, 1, 1] }
  const roles = ['wolf', 'villager', 'seer', 'witch', 'hunter']
  for (const [board, counts] of Object.entries(expectedCounts)) {
    const size = Number(board)
    const roleOptions = [undefined, ...roles.filter((_, index) => counts[index])]
    const baseline = newGame({ seed: 44, size }).seats.map(player => [player.characterId, player.personality])
    for (const humanRole of roleOptions) {
      const state = newGame({ seed: 44, size, humanRole })
      assert.equal(state.seats.length, size)
      assert.deepEqual(roles.map(role => state.seats.filter(player => player.role === role).length), counts)
      assert.deepEqual(state.seats.map(player => [player.characterId, player.personality]), baseline)
      assert.equal(new Set(state.seats.map(player => player.characterId)).size, size)
      if (humanRole) assert.equal(state.seats[0].role, humanRole)
      const alternateAvatar = newGame({ seed: 44, size, humanRole, avatar: 'plain' })
      assert.notEqual(alternateAvatar.seats[0].characterId, state.seats[0].characterId)
      assert.deepEqual(alternateAvatar.seats.slice(1), state.seats.slice(1))
      assert.deepEqual(restoreState(JSON.parse(JSON.stringify(state))), state)
    }
  }
  assert.throws(() => newGame({ size: 6, humanRole: 'hunter' }))
  assert.throws(() => newGame({ size: 7 }))
  assert.throws(() => newGame({ size: '9' }))
  assert.throws(() => newGame({ avatar: ['plain'] }))
})

test('wolves, seer, and witch each receive distinct scoped facts', () => {
  let state = fixed()
  const wolf = roleSeat(state, 'wolf')
  const seer = roleSeat(state, 'seer')
  const witch = roleSeat(state, 'witch')
  const viewer = 1
  state = resolvePhase(state, () => ({ text: '绝密狼队消息' }))
  assert.equal(observe(state, wolf).self.teammates.length, 2)
  assert.equal(observe(state, wolf).seats.filter(player => player.role === 'wolf').length, 3)
  assert.equal(observe(state, wolf).privateEvents.filter(event => event.kind === 'wolf_chat').length, 3)
  assert.deepEqual(observe(state, viewer).privateEvents, [])
  assert.deepEqual(observe(state, viewer, pending(state)[0]).privateEvents, [])
  assert.equal(observe(state, viewer, pending(state)[0]).legal, null)
  assert.equal(observe(state, viewer).phase, 'night')
  assert.equal(observe(state, viewer).seats.filter(player => Object.hasOwn(player, 'role')).length, 1)
  assert.equal(reveal(state), null)
  state = resolvePhase(state, () => ({ target: viewer }))
  assert.equal(observe(state, seer).privateEvents.length, 0)
  assert.equal(observe(state, witch).legal, null)
  state = resolvePhase(state, () => ({ target: wolf }))
  assert.equal(observe(state, seer).privateEvents.at(-1).alignment, 'wolf')
  assert.equal(observe(state, witch).privateEvents.some(event => event.kind === 'inspect'), false)
  assert.equal(observe(state, witch).legal.victim, viewer)
  assert.equal(observe(state, witch).privateEvents.at(-1).target, viewer)
  assert.equal(observe(state, viewer).privateEvents.length, 0)
  assert.doesNotMatch(JSON.stringify(observe(state, viewer)), /绝密狼队消息|狼队选中|狼刀目标/)
  state = resolvePhase(state, () => ({ potion: 'pass' }))
  assert.equal(observe(state, witch).privateEvents.some(event => event.kind === 'witch_target'), false)
  assert.equal(observe(state, viewer).self.alive, false)
  assert.equal(reveal(state, { developer: true }).events.some(event => event.kind === 'wolf_kill'), true)
})

test('witch can self-save on the first night, cannot use both potions, or self-save later', () => {
  let state = finishNight(fixed('witch'), 1)
  let [action] = pending(state)
  assert.equal(action.canSave, true)
  assert.equal(action.targets.includes(1), false)
  assert.equal(validate(state, action, { potion: 'save', target: 1 }), false)
  const rescued = submit(state, action, { potion: 'save' })
  assert.equal(observe(rescued, 1).self.alive, true)
  assert.deepEqual(observe(rescued, 1).self.potions, { save: false, poison: true })
  const pass = submit(state, action, { potion: 'pass' })
  assert.equal(observe(pass, 1).self.alive, false)

  state = fixed('witch')
  const otherVillagers = state.seats.filter(player => player.role === 'villager').map(player => player.id)
  state = finishNight(state, otherVillagers[0])
  state = resolvePhase(state, () => ({ potion: 'pass' }))
  state = exile(state, otherVillagers[1])
  state = resolvePhase(state, () => ({ text: '' }))
  state = finishNight(state, 1)
  ;[action] = pending(state)
  assert.equal(state.day, 2)
  assert.equal(action.canSave, false)
  assert.equal(action.canPoison, true)
})

test('poison takes priority over the wolf kill and suppresses the hunter skill', () => {
  let state = fixed('witch')
  const hunter = roleSeat(state, 'hunter')
  state = finishNight(state, hunter)
  state = resolvePhase(state, () => ({ potion: 'poison', target: hunter }))
  assert.equal(state.phase.kind, 'day_discussion')
  assert.equal(observe(state, hunter).self.alive, false)
  assert.equal(observe(state, hunter).legal, null)
  const full = reveal(state, { developer: true }).events
  assert.deepEqual(full.filter(event => event.kind === 'night_death').map(event => event.cause), ['poison'])
})

test('hunter skill resolves before victory and its subject stays hidden until dawn', () => {
  let state = fixed('hunter')
  const wolves = state.seats.filter(player => player.role === 'wolf').map(player => player.id)
  const villagers = state.seats.filter(player => player.role === 'villager').map(player => player.id)
  state = finishNight(state, villagers[0])
  state = resolvePhase(state, () => ({ potion: 'pass' }))
  state = exile(state, villagers[1])
  state = resolvePhase(state, () => ({ text: '' }))
  state = finishNight(state, 1)
  state = resolvePhase(state, () => ({ potion: 'pass' }))
  assert.equal(state.phase.kind, 'night_hunter')
  assert.equal(state.winner, null)
  assert.equal(observe(state, wolves[0]).phase, 'night')
  assert.equal(observe(state, wolves[0]).seats[0].alive, true)
  assert.equal(observe(state, 1).phase, 'shoot')
  assert.equal(observe(state, 1).self.alive, false)
  state = submit(state, pending(state)[0], { target: wolves[0] })
  assert.equal(state.phase.kind, 'day_discussion')
  assert.equal(state.winner, null)
  const deaths = observe(state, wolves[1]).events.filter(event => event.day === 2 && event.kind === 'death')
  assert.deepEqual(deaths.map(event => event.seat), [1, wolves[0]])
})

test('a tied wolf ballot goes to the lowest target seat, even when submitted out of order', () => {
  let state = resolvePhase(fixed('wolf'), () => ({ text: '' }))
  const decisions = pending(state)
  const targets = decisions[0].targets.slice(0, decisions.length)
  for (const [index, action] of decisions.toReversed().entries()) {
    state = submit(state, action, { target: targets[index] })
  }
  assert.equal(observe(state, 1).privateEvents.at(-1).target, targets[0])
  assert.deepEqual(observe(state, 1).privateEvents.at(-1).votes.map(vote => vote.target), targets.toReversed())
})

test('exiled hunter gives a last word before shooting, and shot victims have no action', () => {
  let state = fixed('hunter')
  const wolf = roleSeat(state, 'wolf')
  state = finishNight(state, roleSeat(state, 'villager'))
  state = resolvePhase(state, () => ({ potion: 'pass' }))
  state = exile(state, 1)
  assert.equal(observe(state, 1).legal.kind, 'last_words')
  assert.equal(observe(state, wolf).speaker, 1)
  assert.equal(observe(state, 1).self.alive, false)
  state = submit(state, pending(state)[0], { text: '请记得我的表态。' })
  assert.equal(observe(state, 1).legal.kind, 'shoot')
  assert.equal(observe(state, wolf).legal, null)
  assert.equal(observe(state, wolf).speaker, undefined)
  state = submit(state, pending(state)[0], { target: wolf })
  assert.equal(observe(state, wolf).self.alive, false)
  assert.equal(observe(state, wolf).legal, null)
  const tail = observe(state, 1).events.slice(-4).map(event => event.kind)
  assert.deepEqual(tail, ['last_words', 'shoot', 'death', 'phase'])
})

test('legacy ballot ties preserve simultaneous results and spare the candidates', () => {
  let state = legacyState(7103)
  state = finishNight(state, roleSeat(state, 'villager'))
  state = resolvePhase(state, () => ({ potion: 'pass' }))
  state = resolvePhase(state, () => ({ text: '' }))
  const voters = pending(state)
  const [left, right] = voters.map(action => action.actor)
  const assignment = new Map(voters.map((action, i) => [action.actor, i === 1 || i > voters.length / 2 ? left : right]))
  state = submit(state, voters[0], { target: assignment.get(voters[0].actor) })
  assert.equal(observe(state, voters[1].actor).events.some(event => event.kind === 'votes'), false)
  state = resolvePhase(state, action => ({ target: assignment.get(action.actor) }))
  assert.equal(state.phase.kind, 'day_revote')
  assert.deepEqual(observe(state, left).legal.targets, [right])
  assert.equal(observe(state, left).events.filter(event => event.kind === 'votes').length, 1)
  state = resolvePhase(state, action => ({ target: assignment.get(action.actor) }))
  assert.equal(state.phase.kind, 'wolf_chat')
  assert.equal(state.day, 2)
  assert.equal(state.seats[left - 1].alive, true)
  assert.equal(state.seats[right - 1].alive, true)
})

test('candidates speak in table order, then independent eligible seats cast their revotes', () => {
  let state = fixed()
  state = finishNight(state, roleSeat(state, 'villager'))
  state = resolvePhase(state, () => ({ potion: 'pass' }))
  const ordinary = [...state.phase.actors]
  state = resolvePhase(state, () => ({ text: '' }))
  const voters = pending(state)
  const [left, right] = voters.map(action => action.actor)
  const targets = new Map(voters.map((action, index) => [action.actor, index === 1 || index > voters.length / 2 ? left : right]))
  state = submit(state, voters[0], { target: targets.get(voters[0].actor) })
  assert.equal(observe(state, right).events.some(event => event.kind === 'votes'), false)
  state = resolvePhase(state, action => ({ target: targets.get(action.actor) }))
  assert.equal(state.phase.kind, 'day_pk')
  const duel = observe(state, 1).events.at(-1)
  const expected = ordinary.filter(id => id === left || id === right)
  assert.deepEqual(duel.candidates, [left, right])
  assert.deepEqual(duel.order, expected)
  assert.equal(observe(state, 1).speaker, expected[0])
  assert.equal(pending(state)[0].kind, 'speak')
  state = submit(state, pending(state)[0], { text: '首位对决玩家发言。' })
  assert.deepEqual(restoreState(JSON.parse(JSON.stringify(state))), state)
  assert.equal(observe(state, 1).speaker, expected[1])
  state = submit(state, pending(state)[0], { text: '第二位对决玩家发言。' })
  assert.equal(state.phase.kind, 'day_revote')
  assert.equal(observe(state, 1).speaker, undefined)
  assert.deepEqual(observe(state, left).events.filter(event => event.pk).map(event => event.seat), expected)
  assert.equal(observe(state, left).legal, null)
  assert.equal(observe(state, right).legal, null)
  assert.ok(pending(state).every(action => action.kind === 'vote' && action.targets.join(',') === [left, right].join(',')))
  const secondVoters = pending(state).map(action => action.actor)
  assert.equal(secondVoters.length, voters.length - 2)
  state = resolvePhase(state, action => ({ target: secondVoters.indexOf(action.actor) < secondVoters.length / 2 ? left : right }))
  assert.equal(state.phase.kind, 'wolf_chat')
  assert.equal(state.day, 2)
  assert.equal(state.seats[left - 1].alive, true)
  assert.equal(state.seats[right - 1].alive, true)
})

test('a complete tie gives everyone a duel speech and skips the empty revote', () => {
  let state = fixed()
  state = finishNight(state, roleSeat(state, 'villager'))
  state = resolvePhase(state, () => ({ potion: 'pass' }))
  state = resolvePhase(state, () => ({ text: '' }))
  const voters = pending(state).map(action => action.actor)
  state = resolvePhase(state, action => ({ target: voters[(voters.indexOf(action.actor) + 1) % voters.length] }))
  assert.equal(state.phase.kind, 'day_pk')
  assert.equal(state.dayVote.candidates.length, voters.length)
  state = resolvePhase(state, action => ({ text: '轮到 ' + action.actor + ' 号。' }))
  assert.equal(state.phase.kind, 'wolf_chat')
  assert.equal(state.day, 2)
  assert.deepEqual(observe(state, 1).events.filter(event => event.revote).at(-1).votes, [])
  assert.equal(state.seats.filter(player => player.alive).length, voters.length)
})

test('invalid and repeated actions are rejected, and saves replay the authoritative journal', () => {
  let state = fixed('wolf')
  const [first] = pending(state)
  assert.equal(validate(state, first, { text: 'x'.repeat(first.maxLength + 1) }), false)
  assert.equal(validate(state, first, { text: 'hello', role: 'wolf', winner: 'wolf' }), false)
  assert.equal(validate(state, { ...first, actor: 8 }, { text: 'hello' }), false)
  assert.throws(() => submit(state, { ...first, phaseId: 'prior-phase' }, { text: 'hello' }))
  const previous = state
  state = submit(state, first, { text: 'hello' })
  assert.equal(previous.journal.length, 0)
  assert.equal(state.journal.length, 1)
  assert.throws(() => submit(state, first, { text: 'hello' }))
  const raw = JSON.parse(JSON.stringify(state))
  assert.deepEqual(restoreState(raw), state)
  assert.throws(() => restoreState({ ...raw, humanRole: ['wolf'] }))
  assert.throws(() => newGame({ humanRole: ['wolf'] }))
  raw.journal.push(raw.journal[0])
  assert.throws(() => restoreState(raw))
})

test('the same legal action protocol reaches a terminal and replayable game', () => {
  for (const [board, counts] of Object.entries(BOARDS)) {
    const size = Number(board)
    const roles = Object.keys(counts).filter(role => counts[role])
    for (const humanRole of roles) {
      let state = newGame({ size, humanRole, seed: 7103 })
      for (let attempts = 0; attempts < 300 && !state.winner; attempts++) {
        const [action] = pending(state)
        const payload = action.maxLength ? { text: '' }
          : action.kind === 'use_potion' ? { potion: 'pass' }
            : { target: action.targets[0] ?? null }
        state = submit(state, action, payload)
      }
      assert.ok(state.winner, size + ' seats, ' + humanRole)
      assert.deepEqual(pending(state), [])
      assert.equal(reveal(state).seats.length, size)
      assert.equal(observe(state, 1).seats.filter(player => Object.hasOwn(player, 'role')).length, size)
      assert.deepEqual(restoreState(JSON.parse(JSON.stringify(state))), state)
    }
  }
})

test('public evidence IDs reveal no differences in a hidden action history', () => {
  function playToSecondDay(seed) {
    let state = legacyState(seed)
    state = finishNight(state, 2)
    state = resolvePhase(state, () => ({ potion: 'pass' }))
    state = exile(state, 3)
    state = resolvePhase(state, () => ({ text: '' }))
    state = finishNight(state, 4)
    if (state.phase.kind === 'witch') state = resolvePhase(state, () => ({ potion: 'pass' }))
    assert.equal(state.phase.kind, 'day_discussion')
    return state
  }
  const earlyWitchDeath = playToSecondDay(0)
  const livingWitch = playToSecondDay(45)
  assert.notEqual(earlyWitchDeath.events.length, livingWitch.events.length)
  assert.deepEqual(observe(earlyWitchDeath, 1).events, observe(livingWitch, 1).events)
  const events = observe(livingWitch, 1).events
  assert.ok(events.every((event, index) => event.id === 'p:' + (index + 1)))
})

test('version 1 action journal replays with original cast and speaking order', () => {
  const journal = [
    [':1/3/wolf_chat', { text: '席位3' }],
    [':1/4/wolf_chat', { text: '席位4' }],
    [':1/7/wolf_chat', { text: '席位7' }],
    [':2/3/wolf_kill', { target: 1 }],
    [':2/4/wolf_kill', { target: 1 }],
    [':2/7/wolf_kill', { target: 1 }],
    [':3/2/inspect', { target: 1 }],
    [':4/5/use_potion', { potion: 'pass' }],
    [':5/2/speak', { text: '席位2' }],
    [':5/3/speak', { text: '席位3' }],
  ].map(([suffix, payload]) => ({ id: legacyId + suffix, payload }))
  const state = legacyState(7103, journal)
  assert.equal(state.version, 1)
  assert.deepEqual(state.seats.map(player => player.name), ['你', '阿岚', '青禾', '松声', '小满', '夜舟', '栗子', '北辰', '白露'])
  assert.deepEqual(state.seats.map(player => player.role), ['villager', 'seer', 'wolf', 'wolf', 'witch', 'villager', 'wolf', 'villager', 'hunter'])
  assert.equal(pending(state)[0].actor, 4)
  assert.equal(observe(state, 1).self.characterId, undefined)
  assert.deepEqual(restoreState(JSON.parse(JSON.stringify(state))), state)
})

test('version 2 action journal replays the original fully shuffled speaking order', () => {
  const journal = [
    [':1/7/wolf_chat', { text: '席位7' }],
    [':1/3/wolf_chat', { text: '席位3' }],
    [':1/4/wolf_chat', { text: '席位4' }],
    [':2/3/wolf_kill', { target: 1 }],
    [':2/4/wolf_kill', { target: 1 }],
    [':2/7/wolf_kill', { target: 1 }],
    [':3/2/inspect', { target: 1 }],
    [':4/5/use_potion', { potion: 'pass' }],
    [':5/2/speak', { text: '席位2' }],
    [':5/4/speak', { text: '席位4' }],
  ].map(([suffix, payload]) => ({ id: legacyId + suffix, payload }))
  let state = restoreState({ version: 2, gameId: legacyId, seed: 7103, humanRole: 'villager', size: 9, avatar: 'lumine', journal })
  const originalOrder = [2, 4, 3, 6, 9, 5, 8, 7]
  assert.equal(pending(state)[0].actor, 3)
  assert.deepEqual(state.phase.actors, originalOrder)
  assert.deepEqual(observe(state, 1).events.find(event => event.phase === 'day_discussion').order, originalOrder)
  assert.deepEqual(restoreState(JSON.parse(JSON.stringify(state))), state)
  state = resolvePhase(state, () => ({ text: '' }))
  const voters = pending(state).map(action => action.actor)
  state = resolvePhase(state, action => ({ target: voters[(voters.indexOf(action.actor) + 1) % voters.length] }))
  assert.equal(state.phase.kind, 'day_revote')
  assert.deepEqual(pending(state).map(action => action.actor), voters)
  assert.deepEqual(restoreState(JSON.parse(JSON.stringify(state))), state)
})

function seatsInDeclaredDirection(view, dawn) {
  assert.ok(['clockwise', 'counterclockwise'].includes(dawn.direction))
  const start = dawn.anchor ?? dawn.order[0]
  const count = view.seats.length
  const direction = dawn.direction === 'clockwise' ? 1 : -1
  return Array.from({ length: count }, (_, offset) => (start - 1 + offset * direction + count) % count + 1)
    .filter(id => view.seats[id - 1].alive)
}

test('seeded speaking orders resume and reveal only the permitted speaker', () => {
  let state = fixed('villager')
  const wolves = state.seats.filter(player => player.role === 'wolf').map(player => player.id)
  assert.deepEqual([...state.phase.actors].sort((a, b) => a - b), wolves)
  assert.notDeepEqual(state.phase.actors, wolves)
  const initial = pending(state)[0]
  assert.equal(observe(state, 1).speaker, undefined)
  assert.equal(observe(state, initial.actor).speaker, initial.actor)
  state = submit(state, initial, { text: '确认商议' })
  assert.deepEqual(restoreState(JSON.parse(JSON.stringify(state))), state)
  assert.deepEqual(state.phase.actors, fixed('villager').phase.actors)
  const victim = roleSeat(state, 'villager')
  state = finishNight(state, victim)
  state = resolvePhase(state, () => ({ potion: 'pass' }))
  const firstDay = observe(state, 1).events.find(event => event.phase === 'day_discussion')
  assert.deepEqual(firstDay.order, state.phase.actors)
  assert.equal(firstDay.anchor, victim)
  assert.deepEqual(firstDay.order, seatsInDeclaredDirection(observe(state, 1), firstDay))
  assert.equal(observe(state, 1).speaker, firstDay.order[0])
  assert.ok(!firstDay.order.includes(victim))
  const speech = pending(state)[0]
  state = submit(state, speech, { text: '第一个发言。' })
  assert.deepEqual(restoreState(JSON.parse(JSON.stringify(state))), state)
  assert.equal(observe(state, 1).speaker, firstDay.order[1])
})

test('a peaceful dawn chooses a living start, and a hunter victim can anchor a multiple-death dawn', () => {
  let state = finishNight(fixed('witch'), 1)
  state = resolvePhase(state, () => ({ potion: 'save' }))
  const peaceful = observe(state, 1)
  const dawn = peaceful.events.find(event => event.phase === 'day_discussion')
  assert.equal(dawn.anchor, undefined)
  assert.deepEqual(dawn.order, seatsInDeclaredDirection(peaceful, dawn))
  assert.equal(dawn.order.length, peaceful.seats.length)

  state = fixed('wolf')
  const hunter = roleSeat(state, 'hunter')
  const poisoned = roleSeat(state, 'villager')
  state = finishNight(state, hunter)
  state = resolvePhase(state, () => ({ potion: 'poison', target: poisoned }))
  state = submit(state, pending(state)[0], { target: 1 })
  const deadly = observe(state, 1)
  const followingDawn = deadly.events.find(event => event.phase === 'day_discussion')
  assert.equal(followingDawn.anchor, 1)
  assert.deepEqual(followingDawn.order, seatsInDeclaredDirection(deadly, followingDawn))
  assert.equal(followingDawn.order.length, deadly.seats.length - 3)
})

test('each scoped event sequence merges the public and private streams without hidden gaps', () => {
  let state = fixed('wolf')
  const villager = roleSeat(state, 'villager')
  state = finishNight(state, villager)
  state = resolvePhase(state, () => ({ potion: 'pass' }))
  const wolfView = observe(state, 1)
  const villageView = observe(state, villager)
  assert.deepEqual(wolfView.events.map(event => event.id), villageView.events.map(event => event.id))
  assert.ok(villageView.events.every((event, index) => event.sequence === index + 1))
  const chronology = wolfView.events.concat(wolfView.privateEvents).sort((left, right) => left.sequence - right.sequence)
  assert.ok(chronology.every((event, index) => event.sequence === index + 1))
  const dawn = wolfView.events.find(event => event.phase === 'day_discussion')
  assert.ok(wolfView.privateEvents.every(event => event.sequence < dawn.sequence))
})
