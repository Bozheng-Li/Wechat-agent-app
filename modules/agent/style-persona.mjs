/**
 * Compose a persona from measured habits. Every rule below is derived from the
 * profile numbers, so the same code works for any speaker; nothing is copied
 * from their messages.
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pct = value => Math.round(value);

export const WARMTH = ['terse', 'balanced', 'warm'];

function lengthBand(profile, warmth) {
  const { p25, p75 } = profile.length;
  const lowBase = clamp(Math.round(p25), 2, 24);
  // 保守的说话人把下限压得太低会显得冷，按档位抬地板；上限跟着地板走，区间才不会倒挂。
  const floor = warmth === 'warm' ? 6 : warmth === 'balanced' ? 4 : 2;
  const low = clamp(Math.max(floor, lowBase), 2, 24);
  const high = clamp(Math.max(Math.round(p75), low + 2), low + 2, 80);
  return { low, high };
}

function commaList(values) {
  if (!values.length) return '';
  if (values.length === 1) return values[0];
  return values.slice(0, -1).join('、') + '和' + values.at(-1);
}

export function composeStylePersona(profile, { name = '助手', warmth = 'balanced' } = {}) {
  if (!WARMTH.includes(warmth)) throw new Error('warmth 只能是 terse、balanced 或 warm');
  if (!profile || !profile.messages) throw new Error('缺少说话方式统计，无法生成人设');

  const band = lengthBand(profile, warmth);
  const { share, punctuation: mark, register, bursts, particles, extras } = profile;
  const says = [], avoids = [];

  const lengthLine = share.long < 8
    ? `一条消息一般 ${band.low} 到 ${band.high} 个字。只有交代步骤、贴代码、解释原因时才写长。`
    : share.long > 35
      ? `一条消息通常 ${band.low} 到 ${band.high} 个字，需要说清楚时可以更长。`
      : `一条消息大多在 ${band.low} 到 ${band.high} 个字之间，偶尔长一些。`;
  says.push(lengthLine);

  if (share.veryShort > 20) says.push('应声可以更短，一两个字就够：行、好、是、知道了。');

  if (mark.period < 25) says.push('句子说完就停在那个字上，不加句号。');
  else if (mark.period > 65) says.push('一句话说完会加句号，标点保持完整。');
  if (mark.none > 60) says.push('很多句子不带任何标点，直接发出去。');

  if (mark.exclaim < 8) avoids.push('不用感叹号');
  if (mark.tilde < 5) avoids.push('不用波浪号');
  if (extras.emoji < 5) avoids.push('不用表情符号');
  if (mark.ellipsis < 5) avoids.push('不用省略号');

  if (bursts.averageMessages >= 1.6)
    says.push(`习惯把一件事拆成几条发，中间不解释。一次差不多 ${Math.round(bursts.averageMessages)} 条。`);
  else says.push('通常一条消息说完一件事，很少连着刷屏。');

  const used = Object.entries(particles).filter(([, value]) => value >= 8).map(([value]) => value);
  const absent = Object.entries(particles).filter(([, value]) => value < 2).map(([value]) => value);
  if (used.length) says.push(`语气词可以用${commaList(used)}，但不要每句都挂。`);
  if (absent.length >= 4) avoids.push(`句尾不用${commaList(absent.slice(0, 4))}`);

  if (register.coarse >= 6)
    says.push('关系熟的时候会用糙字当语气。只用于起哄、吐槽事情和吐槽自己，不针对对方的长相、家人、身体和处境。');
  else avoids.push('不说粗口和网络脏话');
  if (register.soften >= 10) says.push('偶尔会带一点软语气，但不会每句都撒娇。');

  // 句子普遍短的人，真正需要禁的是"附赠内容"，不是字数。
  if (share.short + share.veryShort > 55) {
    avoids.push('不总结对方说过的话', '不主动给建议、方案和下一步',
      '不解释自己的理由', '不用比喻或金句收尾');
  }
  if (mark.question < 6) avoids.push('不句句反问或追问');
  if (share.medium + share.long < 30) avoids.push('不把一句话拆成三段说');

  const serious = warmth === 'terse'
    ? ['生病、丧事、事故、分手这类话题，把玩笑收掉，句子照样短。']
    : ['生病、丧事、事故、分手这类话题，把玩笑和糙字都收掉，但不要只剩一两个字，要给一个具体的落点。'];

  const lines = [
    `# ${name} 的说话方式`,
    '',
    '这页写的是节奏和习惯，不是台词。照着这个节奏说，不要背句子。',
    '',
    '## 长度和节奏',
    ...says.map(value => '- ' + value),
    '',
    '## 认真的时候',
    ...serious.map(value => '- ' + value),
    '',
    '## 不做的',
    ...avoids.map(value => '- ' + value),
    '',
    '## 依据',
    `- 统计自 ${profile.messages} 条发言（可信度 ${profile.confidence}）。`,
    `- 长度中位 ${profile.length.median} 字，四分之一在 ${profile.length.p25} 字以内；句号结尾占 ${pct(mark.period)}%，问号占 ${pct(mark.question)}%。`,
  ];
  return lines.join('\n');
}
