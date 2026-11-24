import assert from 'node:assert/strict'
import test from 'node:test'
import { newGame, pending, restoreState, submit, validate } from './rules.mjs'
import { ROLES } from './roles.mjs'
import { observe, reveal } from './visibility.mjs'

const fixed = (humanRole = 'villager') => newGame({ humanRole, seed: 7103 })
const roleSeat = (state, role) => state.seats.find(player => player.role === role).id

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

test('9 valid roles, with independent personality and role distributions', () => {
  const expected = ['hunter', 'seer', 'villager', 'villager', 'villager', 'witch', 'wolf', 'wolf', 'wolf']
  const roleOptions = [undefined, 'wolf', 'villager', 'seer', 'witch', 'hunter']
  const baseline = newGame({ seed: 44 }).seats.map(player => player.personality)
  for (const humanRole of roleOptions) {
    const state = newGame({ seed: 44, humanRole })
    assert.deepEqual(state.seats.map(player => player.role).sort(), expected)
    assert.deepEqual(state.seats.map(player => player.personality), baseline)
    if (humanRole) assert.equal(state.seats[0].role, humanRole)
  }
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
  assert.equal(observe(state, 1).self.alive, false)
  state = submit(state, pending(state)[0], { text: '请记得我的表态。' })
  assert.equal(observe(state, 1).legal.kind, 'shoot')
  assert.equal(observe(state, wolf).legal, null)
  state = submit(state, pending(state)[0], { target: wolf })
  assert.equal(observe(state, wolf).self.alive, false)
  assert.equal(observe(state, wolf).legal, null)
  const tail = observe(state, 1).events.slice(-4).map(event => event.kind)
  assert.deepEqual(tail, ['last_words', 'shoot', 'death', 'phase'])
})

test('initial and repeat ballot ties reveal simultaneous results and spare the candidates', () => {
  let state = fixed()
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
  for (const humanRole of Object.keys(ROLES)) {
    let state = fixed(humanRole)
    for (let attempts = 0; attempts < 200 && !state.winner; attempts++) {
      const [action] = pending(state)
      const payload = action.maxLength ? { text: '' }
        : action.kind === 'use_potion' ? { potion: 'pass' }
          : { target: action.targets[0] ?? null }
      state = submit(state, action, payload)
    }
    assert.ok(state.winner)
    assert.deepEqual(pending(state), [])
    assert.equal(reveal(state).seats.length, 9)
    assert.equal(observe(state, 1).seats.filter(player => Object.hasOwn(player, 'role')).length, 9)
    assert.deepEqual(restoreState(JSON.parse(JSON.stringify(state))), state)
  }
})

test('public evidence IDs reveal no differences in a hidden action history', () => {
  function playToSecondDay(seed) {
    let state = newGame({ seed, humanRole: 'villager' })
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
