export const ROLES = Object.freeze({
  wolf: {
    name: '狼人',
    description: '知道其他狼人的身份。每夜与狼队商议，再选择一名好人袭击。',
    count: 3,
    alignment: 'wolf',
  },
  villager: {
    name: '村民',
    description: '通过发言和投票寻找狼人。',
    count: 3,
    alignment: 'village',
  },
  seer: {
    name: '预言家',
    description: '每夜查验一名其他存活玩家，得知对方是好人还是狼人。',
    count: 1,
    alignment: 'village',
  },
  witch: {
    name: '女巫',
    description: '全局各有一瓶解药和毒药。解药救当夜狼刀目标，毒药使一名其他存活玩家出局。',
    count: 1,
    alignment: 'village',
  },
  hunter: {
    name: '猎人',
    description: '若被狼刀或投票放逐，可以开枪带走一名存活玩家。',
    count: 1,
    alignment: 'village',
  },
})

export const BOARDS = Object.freeze({
  6: Object.freeze({ wolf: 2, villager: 2, seer: 1, witch: 1, hunter: 0 }),
  9: Object.freeze({ wolf: 3, villager: 3, seer: 1, witch: 1, hunter: 1 }),
  12: Object.freeze({ wolf: 4, villager: 5, seer: 1, witch: 1, hunter: 1 }),
})

export const RULES = [
  ['开局', '可选 6、9、12 人局。你占一个席位，其他席位由 AI 扮演。身份与人物独立分配。旧存档沿用开局时的规则。'],
  ['入夜', '狼人随机决定商议顺序，每位活狼发言一次，再同时选刀。票数最多的好人成为目标，平票时取座号最小的一位。随后预言家查验，再由女巫决定是否用药。'],
  ['用药', '女巫首夜可以用解药自救。每夜至多用一瓶药，各瓶药全局只能用一次。毒药与狼刀命中同一人时，按中毒处理。'],
  ['天亮', '夜间出局人数和席位在天亮时一起公布。狼刀与毒药先按座号同时登记，之后才结算猎人开枪。中毒的猎人无法开枪。'],
  ['白天发言', '本桌没有警长。主持人每天抽一个方向，沿圆桌逐席发言，跳过出局席位。昨夜有人出局时，从其中最小号旁的第一位活人开始；平安夜就从一名随机抽中的活人开始。'],
  ['放逐与平票', '所有存活玩家同时投票，落票后统一公开，不能投自己。首轮最高票并列时，候选人按照当天原顺序各发言一次，再由台下存活玩家给候选人投票。再次平票或没有台下选民时，无人出局。'],
  ['遗言与开枪', '被放逐者可留一次遗言。若是猎人，遗言后决定是否开枪。夜间出局和枪击出局均没有遗言。'],
  ['胜负', '死亡和技能连锁处理完再判断胜负。场上没有狼人时好人胜。仍有狼人且人数达到或超过存活好人数时，狼人胜。'],
  ['身份保密', '出局时展示席位，不公开身份。若猎人开枪，放逐或天亮公告会显示该枪击。终局公开全部身份和夜间行动。'],
]

export const SPEECH_LIMITS = Object.freeze({ speak: 320, wolf_chat: 140, last_words: 240 })

const temperament = [
  ['直截了当', '较高', '先定疑点，再找反证'],
  ['温和简洁', '较低', '比较不同人的时间线'],
  ['条理清楚', '中等', '重视承诺和投票的一致性'],
  ['带一点反问', '中等', '反复追踪同一处矛盾'],
  ['谨慎克制', '较低', '保留两种并行解释'],
  ['快节奏、少铺垫', '较高', '劝票前明确表态'],
  ['爱举小例子', '中等', '比较对同一件事的不同描述'],
  ['语气沉稳', '较低', '从投票组合反推关系'],
  ['说话直接、愿意改口', '较高', '先提假设，再随新证据调整'],
]

export const PERSONALITIES = temperament.map(([tone, risk, habit]) => ({ tone, risk, habit }))
export const SEAT_NAMES = ['你', '阿岚', '青禾', '松声', '小满', '夜舟', '栗子', '北辰', '白露']
