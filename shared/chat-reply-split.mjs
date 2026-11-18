/**
 * 分条发送协议：模型要分两条发，就在正文里插一个 SPLIT_MARK。
 * 发送层只认这个标记，不再根据换行、长度或行数去猜。
 *
 * 这样写多长、发几条完全由人设决定：啰嗦的人设不插标记，整段就是一条；
 * 话少的人设插标记，就真的发成几条。发送层不含任何"话少"的假设。
 */
export const SPLIT_MARK = '<SPLIT>';

const FENCE = /^\s*(`{3,}|~{3,})/u;

/**
 * 切分一条回复。围栏代码块里的标记不生效（那是被引用的字面内容，不是协议）。
 * 没有标记就是一条消息，里面的换行原样保留。
 */
export function splitChatReply(text) {
  const value = typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
  if (!value) return [];

  const messages = [];
  let current = [];
  let fence;

  for (const line of value.split('\n')) {
    if (fence) {
      current.push(line);
      const closing = FENCE.exec(line)?.[1];
      if (closing?.[0] === fence[0] && closing.length >= fence.length && line.trim() === closing) fence = undefined;
      continue;
    }
    let rest = line;
    while (true) {
      const opening = FENCE.exec(rest)?.[1];
      if (opening) { fence = opening; current.push(rest); break; }
      const mark = /<split>/iu.exec(rest);
      if (!mark) { current.push(rest); break; }
      if (mark.index) current.push(rest.slice(0, mark.index));
      messages.push(current.join('\n')); current = [];
      rest = rest.slice(mark.index + mark[0].length);
    }
  }
  messages.push(current.join('\n'));

  return messages.map(part => part.trim()).filter(Boolean);
}

/**
 * Turn one reply into the messages actually sent. The transport flattens
 * consecutive text segments into a single bubble, so each segment gets its own
 * send; mentions ride on the first one. Media also owns its own bubble.
 */
export function replySegments(message) {
  const mentions = message.filter(part => part.type === 'at');
  const body = message.filter(part => part.type !== 'at');
  if (!body.length) return [message];
  return body.map((part, index) => [...(index === 0 ? mentions : []), part]);
}
