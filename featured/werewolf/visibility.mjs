import { pending } from './rules.mjs'

function privateWitchVictim(state, actor, victim) {
  const name = state.seats[victim - 1].name
  return {
    id: 'witch:' + state.day,
    day: state.day,
    kind: 'witch_target',
    text: '今夜狼刀目标是 ' + victim + ' 号 ' + name + '。',
    seat: actor,
    target: victim,
  }
}

function copyEvent({ visibility: _visibility, ...event }, id) {
  return structuredClone({ ...event, id })
}

function publicEvents(state) {
  return state.events.filter(event => event.visibility === 'public')
    .map((event, index) => copyEvent(event, 'p:' + (index + 1)))
}

/**
 * The only observer allowed at the UI and agent boundaries. Empty pending phases
 * and actions belonging to others are omitted before any serialization.
 */
export function observe(state, seatId, action) {
  const player = state.seats[seatId - 1]
  if (!Number.isInteger(seatId) || !player) throw new Error('未知席位')
  const current = pending(state).find(candidate => candidate.actor === seatId)
  const legal = action === undefined ? current : current && action?.id === current.id ? current : undefined
  const night = state.night
  const wolves = player.role === 'wolf' ? state.seats.filter(other => other.id !== seatId && other.role === 'wolf') : []
  const teammates = wolves.map(other => other.id)
  const temporarilyPublicAlive = id => night?.deaths.some(death => death.id === id)
  const self = {
    id: seatId,
    name: player.name,
    role: player.role,
    alive: player.alive || (!!temporarilyPublicAlive(seatId) && legal?.kind !== 'shoot'),
    personality: { ...player.personality },
  }
  if (self.role === 'wolf') self.teammates = teammates
  if (self.role === 'witch') self.potions = { ...state.potions }
  let phase = state.phase.kind
  if (night) phase = legal?.kind === 'shoot' ? 'shoot' : 'night'
  else if (phase === 'day_hunter') phase = legal?.kind === 'shoot' ? 'shoot' : 'last_words'
  const privateEvents = state.events.filter(event => Array.isArray(event.visibility) && event.visibility.includes(seatId))
    .map((event, index) => copyEvent(event, 's:' + (index + 1)))
  if (legal?.kind === 'use_potion' && legal.victim !== null) privateEvents.push(privateWitchVictim(state, seatId, legal.victim))
  return {
    self,
    seats: state.seats.map(other => {
      const entry = {
        id: other.id,
        name: other.name,
        alive: other.id === seatId ? self.alive : other.alive || !!temporarilyPublicAlive(other.id),
      }
      if (other.id === seatId || teammates.includes(other.id) || state.winner) entry.role = other.role
      return entry
    }),
    day: state.day,
    phase,
    events: publicEvents(state),
    privateEvents,
    legal: legal ? structuredClone(legal) : null,
    winner: state.winner,
  }
}

export function reveal(state, { developer = false } = {}) {
  if (!state.winner && developer !== true) return null
  let publicIndex = 0
  return {
    seats: structuredClone(state.seats),
    events: state.events.map(event => {
      const isPublic = event.visibility === 'public'
      const id = isPublic ? 'p:' + ++publicIndex : 'r:' + event.id
      return { ...copyEvent(event, id), public: isPublic }
    }),
    winner: state.winner,
  }
}
