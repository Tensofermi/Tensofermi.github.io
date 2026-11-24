const speechKinds = new Set(['speak', 'wolf_chat', 'last_words']);
const deathKinds = new Set(['death', 'shoot']);

function seatName(view, id) {
  const seat = view.seats.find(candidate => candidate.id === id);
  return seat ? id + ' 号 ' + seat.name : id + ' 号';
}

function voteSummary(event) {
  const votes = new Map();
  for (const { target } of event.votes ?? []) {
    if (target != null) votes.set(target, (votes.get(target) ?? 0) + 1);
  }
  return Array.from(votes, ([target, count]) => ({ target, count }))
    .sort((left, right) => right.count - left.count || left.target - right.target)
    .map(({ target, count }) => target + ' 号 ' + count + ' 票').join(' · ');
}

function cueFor(events, view, privateChannel = false) {
  const event = events[0];
  if (!event) return null;
  if (speechKinds.has(event.kind)) {
    const subject = seatName(view, event.seat);
    const type = event.kind === 'last_words' ? '遗言' : privateChannel ? '狼队密语' : '发言';
    return { title: subject + ' · ' + type, detail: event.text, kind: 'speech', seat: event.seat, next: '读下一位', privateId: privateChannel ? event.id : undefined };
  }
  if (privateChannel) {
    return {
      title: '你的夜间记录', detail: events.map(item => item.text).join('\n'),
      kind: 'private', next: '查看私密记录', privateId: event.id,
    };
  }
  if (event.phase === 'day_discussion') {
    const order = event.order?.map(id => id + ' 号').join(' → ');
    const notes = events.slice(1).map(item => item.text);
    if (order) notes.push('发言顺序 ' + order);
    return { title: '第 ' + event.day + ' 天 · 天亮', detail: notes.join('\n'), kind: 'dawn', next: '查看天亮结果' };
  }
  if (event.phase === 'night') {
    const detail = event.day === 1 ? '先确认自己的身份。夜间只会显示你有权看到的消息。' : '桌上暂时安静下来。';
    return { title: '第 ' + event.day + ' 夜 · 入夜', detail, kind: 'night', next: '进入下一夜' };
  }
  if (event.phase === 'day_vote' || event.phase === 'day_revote') {
    return { title: event.phase === 'day_vote' ? '白天投票' : '平票加投', detail: event.text, kind: 'vote', next: '进入投票' };
  }
  if (event.kind === 'votes') {
    return { title: event.revote ? '加投结果' : '首轮票型', detail: voteSummary(event) || event.text, kind: 'vote', next: '查看票型' };
  }
  if (event.kind === 'result') {
    return { title: '终局', detail: event.text, kind: 'result', next: '揭晓终局' };
  }
  return {
    title: event.kind === 'shoot' ? '猎枪结算' : '放逐结果',
    detail: events.map(item => item.text).join('\n'), kind: 'resolution', next: '查看结算',
  };
}

function groupPublic(events) {
  const units = [];
  for (const event of events) {
    const last = units.at(-1);
    const first = last?.[0];
    if (first?.day === event.day && deathKinds.has(event.kind)
      && (first.phase === 'day_discussion' || (first.kind === 'shoot' && last.length === 1))) {
      last.push(event);
    } else units.push([event]);
  }
  return units;
}

function applyPublic(view, events) {
  const mark = events[0];
  const removed = new Set(events.filter(event => event.kind === 'death' && event.seat).map(event => event.seat));
  const seats = view.seats.map(seat => removed.has(seat.id) ? { ...seat, alive: false } : seat);
  const phase = mark.kind === 'result' ? 'over' : mark.phase ?? (mark.kind === 'last_words' ? 'last_words' : view.phase);
  return {
    ...view, seats, self: { ...view.self, alive: seats.find(seat => seat.id === view.self.id)?.alive ?? view.self.alive },
    phase, day: mark.day, speaker: speechKinds.has(mark.kind) ? mark.seat : undefined, legal: null,
    events: view.events.concat(events),
  };
}

function filterToSeen(view, checkpoint) {
  const publicEvents = view.events.slice(0, checkpoint.publicCount);
  const seenPrivate = new Set(checkpoint.privateIds);
  const privateEvents = view.privateEvents.filter(event => seenPrivate.has(event.id));
  const knownDead = new Set(publicEvents.filter(event => event.kind === 'death' && event.seat).map(event => event.seat));
  const allies = new Set(view.self.teammates ?? []);
  const seats = view.seats.map(({ role, ...seat }) => ({
    ...seat, alive: !knownDead.has(seat.id), ...((seat.id === view.self.id || allies.has(seat.id)) ? { role } : {}),
  }));
  const marker = publicEvents.at(-1);
  return {
    ...view, seats, self: { ...view.self, alive: !knownDead.has(view.self.id) },
    events: publicEvents, privateEvents, legal: null, speaker: undefined, winner: null,
    phase: checkpoint.phase, day: marker?.day ?? 1,
  };
}

const displayPhases = new Set(['night', 'day_discussion', 'day_vote', 'day_revote', 'last_words', 'shoot', 'over']);

export function validateCheckpoint(value) {
  return value && Number.isSafeInteger(value.publicCount) && value.publicCount >= 1
    && Array.isArray(value.privateIds) && value.privateIds.every(id => typeof id === 'string')
    && displayPhases.has(value.phase)
    ? {
      publicCount: value.publicCount, privateIds: value.privateIds, phase: value.phase,
      privateCueId: value.privateIds.includes(value.privateCueId) ? value.privateCueId : undefined,
    } : null;
}

export class Playback {
  constructor(view = null, checkpoint = null) {
    this.queue = [];
    this.latest = view;
    this.view = view;
    this.cue = null;
    if (!view) return;
    const seen = validateCheckpoint(checkpoint);
    if (seen && (seen.publicCount < view.events.length || view.privateEvents.some(event => !seen.privateIds.includes(event.id)))) {
      this.view = filterToSeen(view, { ...seen, publicCount: Math.min(seen.publicCount, view.events.length) });
      this.latest = this.view;
      this.push(view);
    }
    const privateCue = this.view.privateEvents.find(event => event.id === seen?.privateCueId);
    const unit = groupPublic(this.view.events).at(-1);
    this.cue = privateCue ? cueFor([privateCue], this.view, true) : cueFor(unit ?? [], this.view);
  }

  push(view, ownAction = false) {
    if (!this.latest) {
      this.latest = this.view = view;
      return;
    }
    const previous = this.latest;
    const seenPrivate = new Set(previous.privateEvents.map(event => event.id));
    const publicEvents = view.events.slice(previous.events.length);
    const privateEvents = view.privateEvents.filter(event => !seenPrivate.has(event.id));
    let snapshot = { ...previous, legal: null };
    for (const event of privateEvents) {
      snapshot = { ...snapshot, privateEvents: snapshot.privateEvents.concat(event) };
      this.queue.push({ view: snapshot, cue: cueFor([event], view, true) });
    }
    for (const events of groupPublic(publicEvents)) {
      snapshot = applyPublic(snapshot, events);
      this.queue.push({ view: snapshot, cue: cueFor(events, view) });
    }
    this.latest = view;
    const first = this.queue[0];
    if (ownAction && first?.cue.kind === 'speech' && first.cue.seat === view.self.id) this.advance();
    if (!this.queue.length) this.view = view;
  }

  advance() {
    const frame = this.queue.shift();
    if (!frame) return;
    this.view = this.queue.length ? frame.view : this.latest;
    this.cue = frame.cue;
  }

  skip() {
    if (this.queue.length) this.cue = this.queue.at(-1).cue;
    this.queue = [];
    this.view = this.latest;
  }

  checkpoint() {
    if (!this.view) return null;
    return {
      publicCount: this.view.events.length,
      privateIds: this.view.privateEvents.map(event => event.id),
      phase: this.view.phase,
      privateCueId: this.cue?.privateId,
    };
  }
}

export function readingTime(cue) {
  if (!cue) return 1800;
  return Math.min(24000, Math.max(4200, 1700 + Array.from(cue.detail).length * 105));
}

