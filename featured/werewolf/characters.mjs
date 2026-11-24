function character(id, name, icon, accent, tone, risk, habit, voice) {
  return Object.freeze({ id, name, icon, accent, personality: Object.freeze({ tone, risk, habit, voice }) });
}

// 牌桌性格与台词是原创写法。辨识方向参考各角色的官方简介。
// Genshin: https://genshin.hoyoverse.com/en/news/detail/113484
// https://genshin.hoyoverse.com/en/character/liyue
// https://genshin.hoyoverse.com/en/character/inazuma
// https://genshin.hoyoverse.com/en/character/NODKRAI
// https://genshin.hoyoverse.com/en/character/mondstadt
// Star Rail: https://hsr.hoyoverse.com/zh-cn/character?charIndex=13&worldIndex=5
// Honkai Impact 3rd: https://honkaiimpact3.hoyoverse.com/strategy/character/detail/102737
export const CHARACTERS = Object.freeze([
  character('furina', '芙宁娜', '◒', '#8ecbff', '愿意站出来主持讨论，偶尔用舞台语气', '中等', '擅长追问说辞转折处的动机', '这一幕总要有人开口。{target}，你最想先听谁解释？'),
  character('hutao', '胡桃', '✣', '#ffa58d', '轻快俏皮，常用简短反问', '较高', '把模糊表态变成可以当场回答的小问题', '我准备记在纸上啦。{target}，这一票你究竟打算投给谁？'),
  character('firefly', '流萤', '✧', '#a6e0af', '真诚克制，谈到行动时很直接', '中等', '重视当事人能否说明选择以及改票条件', '{target}，我想听你的真实判断。现在这张票，什么证据会让你改投？'),
  character('elysia', '爱丽希娅', '✿', '#ffb0d6', '友好，主动邀请沉默的人说话', '中等', '比较大家如何讲同一件事', '{target}，轮到我问一个小问题啦。现在你最希望大家听懂哪一点？'),
  character('zhongli', '钟离', '◆', '#edc67c', '沉稳，常用完整短句陈述前因后果', '较低', '分辨承诺、实际投票与事后解释', '我想先核对一件事。{target}，你的判断基于桌上的哪条记录？'),
  character('raiden', '雷电将军', 'ϟ', '#d2b8ff', '言简意赅，要求明确责任与后续行动', '中等', '提取相互矛盾的承诺并要求取舍', '{target}，请亮明你的选择。给出一条足以改变你投票的依据。'),
  character('kafka', '卡芙卡', '✦', '#e8a8d1', '从容，倾向于等人主动暴露理由', '较高', '观察谁跟随意见，以及意见改变的时机', '{target}，先按你的节奏说吧。桌上哪句话，让你现在愿意把票投出去？'),
  character('silverwolf', '银狼', '⌗', '#9fbaff', '短句，习惯把判断说成可验证的假设', '较高', '寻找最省时间的反例并检查票型', '我来做个小测试。{target}，哪条消息一改，你的整个推断就得重来？'),
  character('sandrone', '桑多涅', '⬡', '#c9c6ad', '冷静挑剔，对含糊的说法没耐心', '较低', '拆开论据的先后关系，寻找缺失的一步', '{target}，把你的推断分成两步。哪一步有已发生的事可以验证？'),
  character('columbina', '哥伦比亚', '☾', '#f6c4df', '放轻声音，用短句点出别人略过的地方', '较低', '留意前后说法之间的停顿和遗漏', '我想问个容易漏过的问题。{target}，哪个疑点你还没有想明白？'),
  character('venti', '温迪', '♪', '#a8e5ce', '轻松，擅长把尖锐的问题问得不僵', '中等', '从不同玩家的版本里找共同事实', '{target}，不如挑一件桌上其他人也能作证的事，给大家讲讲？'),
]);

export const HUMAN_AVATARS = Object.freeze({
  lumine: character('lumine', '荧', '✶', '#f6d695', '简洁', '由玩家决定', '由玩家决定', ''),
  plain: character('plain', '你', '○', '#ddd3b8', '由玩家决定', '由玩家决定', '由玩家决定', ''),
});

const byId = new Map([...CHARACTERS, ...Object.values(HUMAN_AVATARS)].map(item => [item.id, item]));
const byName = new Map(CHARACTERS.map(item => [item.name, item]));
export const characterById = id => byId.get(id) ?? null;

const followups = {
  furina: ['先把这一幕停住。{target}，想清楚再告诉我，谁的说法最不可信？', '今晚把重点放到{target}。明天台面上的票各自讲通。', '把这句带出去。再问问{target}，到底准备相信谁？'],
  hutao: ['问句简单的。{target}，只能保一个人，你保谁？', '商量好就出手。今晚我点{target}，白天可别替我抢话。', '别放过这个问号。{target}，记得把你的票说清楚。'],
  firefly: ['如果我漏听了一句，请现在帮我补全。{target}，你的理由是什么？', '我倾向先处理{target}。明天我们的投票理由得各自说得过去。', '我只能说到这里了。请让{target}把自己的决定讲完。'],
  elysia: ['我还想多听一个人的意见。{target}，哪位的话能说服你？', '我先提{target}。大家也说说各自想选谁，别急着跟我的建议。', '别急着结束讨论呀。{target}，可以再讲一次你的理由吗？'],
  zhongli: ['{target}，说说你最早就有的判断。若有改变，请说明缘由。', '我提议选{target}。明日若遭追问，从各自真实做过的事说起。', '我的票已经留下。再核对{target}的承诺与行动，便可继续分辨。'],
  raiden: ['请回答一个具体问题。{target}，如果你要改票，什么证据才足够？', '聚焦一人。建议{target}，其余意见请直接提出。', '请继续核查{target}的选择。交代完依据，再作决定。'],
  kafka: ['{target}，我愿意先听你一句。你会拿什么证据来让大家相信你？', '我选{target}。那些白天已经说出口的意见，暂时让它们保持原样。', '让讨论继续吧。我想看看{target}会把刚才的话接到哪里。'],
  silverwolf: ['给判断加个回滚条件吧。{target}，你最需要别人证实哪一条？', '先切{target}这个点。明天票型如果变了，记一下谁先转向。', '把{target}的判断记下来。下一轮实际出的票，正好能测它。'],
  sandrone: ['{target}，我先只问第一步。你的前提来自你亲眼看见的哪一条记录？', '在一名目标上统一行动。我的首选是{target}，如果反对，请给替代目标。', '我的答案到这里。请检查{target}的解释里是不是漏了一步。'],
  columbina: ['我想听听另一边。{target}，哪个人的沉默让你愿意继续追问？', '我想选{target}。明天先听别人把没说完的话说完。', '好像还剩一个问题。请在天亮以后，问问{target}真正相信谁。'],
  venti: ['先挑一句桌上都听见的。{target}，你愿意用哪句支持自己的投票？', '我先唱个起头，建议今晚选{target}。我想听听你们接下来的主意。', '这段先停一停。下一轮请记得问{target}，愿意跟哪一张票。'],
};

export function characterLine(player, target, kind, turn) {
  const selected = characterById(player.characterId) ?? byName.get(player.name);
  const variants = selected && followups[selected.id];
  if (!variants) return null;
  const text = kind === 'wolf_chat' ? variants[1] : kind === 'last_words' ? variants[2]
    : turn % 2 ? selected.personality.voice : variants[0];
  return text.replaceAll('{target}', target);
}
