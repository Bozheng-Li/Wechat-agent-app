import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

// Exercise the actual JSX handlers with a minimal synthetic hook host, without
// opening the running GUI, reading private data or rebuilding production bundles.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookSource = `let states=[], refs=[], si=0, ri=0;
export function begin(){si=0;ri=0;} export function values(){return states;}
export function useState(initial){const i=si++;if(!(i in states))states[i]=initial;return [states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];}
export function useRef(initial){const i=ri++;return refs[i]??=( {current:initial} );}
export function useEffect(){} export const Fragment='fragment';
export function jsx(type,props){return {type,props};} export const jsxs=jsx;
export function createElement(type,props,...children){return {type,props:{...props,children}};}
export default {createElement};`;
const entry = `export {PersonaChat} from ${JSON.stringify(path.join(root, 'frontend/pages/settings/persona-chat.jsx'))}; export {begin,values} from 'synthetic-react';`;
const build = await rolldown({ input: 'virtual:persona-ui', platform: 'node', plugins: [{ name: 'synthetic-react',
  resolveId: id => id === 'virtual:persona-ui' ? id : ['react', 'react/jsx-runtime', 'synthetic-react'].includes(id) ? 'synthetic-react' : null,
  load: id => id === 'virtual:persona-ui' ? entry : ['react', 'react/jsx-runtime', 'synthetic-react'].includes(id) ? hookSource : null,
}] });
let api;
try { const { output } = await build.generate({ format: 'esm' }); api = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`); }
finally { await build.close(); }
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object') return [];
  return [node, ...nodes(node.props?.children)];
}

test('trial renders SPLIT bubbles but sends one clean assistant turn as the next test history', async () => {
  const calls = [], draft = { name: '合成角色', aliases: '', prompt: '合成', personaMode: 'standard' };
  const rpc = async (_method, input) => { calls.push(input); return { text: '甲<SPLIT>乙', personaMode: 'standard' }; };
  const render = () => { api.begin(); return api.PersonaChat({ draft, rpc, disabled: false }); };
  let tree = render();
  nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: '你好' } });
  tree = render(); await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  tree = render();
  const bubbles = nodes(tree).filter(node => node.props?.['data-role'] === 'assistant');
  assert.equal(bubbles.length, 2); assert.equal(bubbles[0].props['data-turn'], bubbles[1].props['data-turn']);
  assert.deepEqual(bubbles.map(node => nodes(node).find(child => child.type === 'p').props.children), ['甲', '乙']);
  const rendered = JSON.stringify(tree); assert(rendered.includes('不发送到微信')); assert(rendered.includes('无微信回执'));
  nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: '再说说' } });
  tree = render(); await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls[1].messages, [{ role: 'user', content: '你好' }, { role: 'assistant', content: '甲\n乙' }]);
});
