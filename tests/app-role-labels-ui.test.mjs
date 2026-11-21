import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { rolldown } from 'rolldown';

const root=path.resolve(import.meta.dirname,'..');
const hooks=`let states=[],refs=[],effects=[],queue=[],s=0,r=0,e=0;
export function begin(){s=0;r=0;e=0;queue=[];}
export function useState(initial){const i=s++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],value=>states[i]=typeof value==='function'?value(states[i]):value];}
export function useRef(initial){const i=r++;return refs[i]??={current:initial};}
export function useEffect(run,deps){const i=e++,old=effects[i];if(!old||!deps||deps.some((x,j)=>x!==old.deps[j]))queue.push(()=>{old?.cleanup?.();effects[i]={deps,cleanup:run()};});}
export function flush(){for(const run of queue)run();queue=[];}
export function cleanup(){for(const effect of effects)effect?.cleanup?.();effects=[];states=[];refs=[];queue=[];}
export const useMemo=fn=>fn();export const useCallback=fn=>fn;export const memo=fn=>fn;export const useSyncExternalStore=(_subscribe,read)=>read();
export const Fragment='fragment';export function jsx(type,props){return {type,props};}export const jsxs=jsx;
export function createElement(type,props,...children){return {type,props:{...props,children}};}export default {createElement};`;
const entry=`export {RoleCardsPage} from ${JSON.stringify(path.join(root,'frontend/pages/memory/role-cards-page.jsx'))};export {begin,flush,cleanup} from 'fake-react';`;
const build=await rolldown({input:'virtual:labels-ui',platform:'node',plugins:[{name:'labels-hooks',
  resolveId:id=>id==='virtual:labels-ui'?id:['react','react/jsx-runtime','fake-react'].includes(id)?'fake-react':null,
  load:id=>id==='virtual:labels-ui'?entry:id==='fake-react'?hooks:null}]});
let api;
try{const {output}=await build.generate({format:'esm'});api=await import('data:text/javascript;base64,'+Buffer.from(output[0].code).toString('base64'));}
finally{await build.close();}
const nodes=node=>Array.isArray(node)?node.flatMap(nodes):!node||typeof node!=='object'?[]:[node,...nodes(node.props?.children)];
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const rolePeople=[{personId:'group-person',name:'group-person',aliases:[],encounters:[],filledFields:1,preview:{addressAs:'阿宁'}}];
const roleSnapshot={accountId:'synthetic-owner',source:'wechat-role-labels-live',membershipComplete:true,
  contacts:[{id:'group-person',name:'微信备注',remark:'微信备注',nickname:'微信昵称',labelIds:['1']}],
  labels:[{id:'1',name:'合成标签',userIds:['group-person'],memberCount:1}]};
const selectedDialog=tree=>nodes(tree).find(node=>node.props?.['data-testid']==='role-card-dialog');
function pageFixture(t){
  const intervals=new Set(),state={people:structuredClone(rolePeople),errors:[]},calls=[];
  t.mock.method(globalThis,'setInterval',fn=>{intervals.add(fn);return fn;});
  t.mock.method(globalThis,'clearInterval',fn=>intervals.delete(fn));
  const status={account:{id:'synthetic-owner'},online:true,momentsAudienceReady:true,
    settings:{privatePeers:[],groups:['authorized-room@chatroom']},authorization:{pendingCount:0,members:{syncedAt:1}}};
  const rpc=async(endpoint,payload,signal)=>{calls.push({endpoint,payload});signal?.throwIfAborted();
    if(endpoint==='memory.role.list')return structuredClone(state);
    if(endpoint==='memory.role.labels')return structuredClone(roleSnapshot);
    return {personId:payload.personId,card:{label:'',addressAs:'阿宁'},encounters:[]};};
  const render=()=>{api.begin();const tree=api.RoleCardsPage({rpc,status,onNavigate(){}});api.flush();return tree;};
  const open=tree=>nodes(tree).find(node=>node.props?.person?.personId==='group-person').props.onOpen({currentTarget:{isConnected:false}});
  t.after(()=>api.cleanup());
  return {state,status,calls,render,open,refresh:async()=>{for(const refresh of intervals)await refresh();await settle();}};
}

test('labels still load once on opening/reconnect and manually refresh, without polling scans',async t=>{
  t.after(()=>api.cleanup());const calls=[];
  const status={account:{id:'synthetic-owner'},online:true,momentsAudienceReady:true,settings:{privatePeers:[]}};
  const rpc=async(endpoint)=>{calls.push(endpoint);return endpoint==='memory.role.list'?{people:[]}:
    {accountId:'synthetic-owner',source:'wechat-role-labels-live',membershipComplete:true,contacts:[],labels:[]};};
  const render=()=>{api.begin();const tree=api.RoleCardsPage({rpc,status,onNavigate(){}});api.flush();return tree;};
  render();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(name=>name==='memory.role.labels').length,1);
  for(let i=0;i<5;i++)render();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(name=>name==='memory.role.labels').length,1,'render/poll refreshes must not restart a scan');
  status.online=false;render();status.online=true;render();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(name=>name==='memory.role.labels').length,2);
  const tree=render();await nodes(tree).find(node=>node.props?.['aria-label']==='刷新微信标签').props.onClick();
  assert.equal(calls.filter(name=>name==='memory.role.labels').length,3);
  assert(!calls.includes('moments.audience'),'role gallery never requests the whole address book');
});

test('polling tracks the newly selected card and preserves its draft on read errors',async t=>{
  const f=pageFixture(t);f.render();await settle();let tree=f.render();f.open(tree);f.render();await settle();tree=f.render();
  assert(selectedDialog(tree));
  assert.equal(nodes(tree).find(node=>node.props?.id==='wa-role-dialog-title').props.children,'微信备注');
  let details=nodes(tree).find(node=>typeof node.props?.onEdit==='function');details.props.onEdit();tree=f.render();
  details=nodes(tree).find(node=>typeof node.props?.onEdit==='function');details.props.onChange('addressAs','保留编辑草稿');f.render();
  f.state.people=[];f.state.errors=['合成读取错误'];await f.refresh();tree=f.render();
  assert(selectedDialog(tree),'a partial error list is not proof of revocation');
  assert.equal(nodes(tree).find(node=>typeof node.props?.onEdit==='function').props.draft.addressAs,'保留编辑草稿');
  f.state.errors=[];await f.refresh();tree=f.render();
  assert.equal(selectedDialog(tree),undefined,'the original polling callback must read the current selection from a ref');
});

test('authorization changes refresh cards without treating a group-only card as revoked or rescanning tags',async t=>{
  const f=pageFixture(t);f.render();await settle();let tree=f.render();f.open(tree);f.render();await settle();
  const before=f.calls.filter(call=>call.endpoint==='memory.role.list').length;
  f.status.settings.privatePeers=['unrelated-private-person'];f.render();await settle();tree=f.render();
  assert(f.calls.filter(call=>call.endpoint==='memory.role.list').length>before);
  assert(selectedDialog(tree),'group grants are represented by the backend list, not the private-peer array');
  assert.equal(f.calls.filter(call=>call.endpoint==='memory.role.labels').length,1);
  f.state.people=[];f.status.settings.groups=[];f.status.authorization.members.syncedAt=2;f.render();await settle();tree=f.render();
  assert.equal(selectedDialog(tree),undefined);
});
