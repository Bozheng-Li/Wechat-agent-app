import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../backend/storage/state-store.mjs';
import { createPluginService } from '../backend/app/service.mjs';
import { agentMutation } from '../modules/agent/actions.mjs';
import { validatePersonaEntry } from '../shared/contracts.mjs';
import { styleProfile } from '../modules/agent/style-profile.mjs';
import { assistantTask, styleSamples, styleSampleEvidence, styleSummaryMessages, summarizeStyle } from '../modules/agent/style-summary.mjs';
import { distillCandidates, distillPersona } from '../modules/agent/style-distill.mjs';
import { storedObjectScopes } from '../modules/authorization/features.mjs';

const persona = (prompt = '表达直接，熟人之间爱调侃。') => ({ name: '助手', aliases: [], prompt });
const scope = { accountId: 'account-a', chatType: 'group', peerId: 'room@chatroom' };
const rows = (count = 40, senderId = 'person-a') => Array.from({ length: count }, (_, index) => ({
  direction: 'incoming', senderId, senderName: '合成甲', text: index % 2 ? '有一说一，句子可以再短点' : '好的', time: 1000+index*1000, chatType: 'group',
}));
function fakeStore() {
  const data = { authorizationRevocations: [], authorizationEpochs: {}, groupMemberExclusions: {} };
  const settings = { privatePeers: ['person-a','person-b'], groups: [scope.peerId], enabled: true };
  return { data, settings: () => settings, isGroupMember: () => true, conversations: () => [scope], persona: () => persona(), settingsValue: settings };
}
function realStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'persona-usability-'));
  t.after(() => { const resolved=fs.realpathSync(root); assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('persona-usability-')); fs.rmSync(resolved,{recursive:true,force:true}); });
  const store=new StateStore(root);
  store.configure('account-a',{...store.settings('account-a'),privatePeers:['person-a','person-b'],groups:[scope.peerId],enabled:true});
  return {root,store};
}
const ownerContext = store => ({ store, assertLive:()=>{}, currentAccount:()=>assert.fail('saving text does not reread a chat account'),
  status:()=>({}), paused:async(_reason,action)=>action() });
function summaryService(store, output, onModel = () => {}) {
  let calls=0, request;
  const service=createPluginService({ store, identity:{}, worker:{status:()=>({account:{id:'account-a'}})},
    runner:{memoryExecutionSnapshot:async()=>({selection:{model:'synthetic-model'}})},
    channel:{memory:{view:()=>({entries:rows()})}, authorization:{isCleaning:()=>false,combine:()=>new AbortController().signal}},
    ctx:{llm:{selectionRequest:async()=>({provider:{baseURL:'https://synthetic.invalid',stream:false},apiKey:''})},
      fetch:async(_url,options)=>{calls++; request=JSON.parse(options.body);onModel();return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:output}}]});}} });
  return {service,calls:()=>calls,request:()=>request};
}

test('input anonymization preserves language and context rather than dropping whole personal topics', () => {
  const input=[{text:'合成甲，我工资12000元，今天又改需求了，烦死了。',time:9,chatType:'group',conversation:'会话1'},
    {text:'联系 hello@example.test 或 13800138000，晚点说',time:8},
    {text:'okay, fair enough',time:7}];
  const {samples,sampling}=styleSampleEvidence(input,{entities:['合成甲']});
  assert.equal(samples.length,3);assert.equal(sampling.excluded,0);
  const text=JSON.stringify(samples);assert.match(text,/改需求|烦死了|12000|fair enough/);
  assert.doesNotMatch(text,/合成甲|hello@example|13800138000/);
  assert.equal(sampling.chats,1);
});

test('current source authorization is still enforced when reading chat records, not when saving text', () => {
  const store=fakeStore();store.data.groupMemberExclusions['account-a']={excludedPersonIds:['person-b']};
  const memory={view:()=>({entries:[...rows(1),...rows(3,'person-b')]})};
  assert.deepEqual(distillCandidates({store,memory,accountId:'account-a'}).map(row=>row.senderId),['person-a']);
  assert.throws(()=>distillPersona({store,memory,accountId:'account-a',senderId:'person-b'}),{code:'PERSONA_SOURCE_REVOKED'});
  assert.equal(distillPersona({store,memory,accountId:'account-a',senderId:'person-a'}).samples.length,1);
});

test('few samples and long vernacular examples go to the model without a minimum twenty rule', () => {
  const store=fakeStore(), memory={view:()=>({entries:rows(2)})};
  const draft=distillPersona({store,memory,accountId:'account-a',senderId:'person-a'});
  assert.equal(draft.samples.length,2);assert.equal(draft.persona.prompt,'');
  assert.equal(draft.sampling.chats,1);assert.equal(draft.draftToken,undefined);assert.equal(draft.draftExpiresAt,undefined);
});

test('sampling retains neighboring dialogue to support situational language analysis', () => {
  const store=fakeStore(), data=[{direction:'incoming',senderId:'person-b',senderName:'合成乙',text:'这事真挺逗的',time:1000},...rows(1).map(row=>({...row,time:2000}))];
  const draft=distillPersona({store,memory:{view:()=>({entries:data})},accountId:'account-a',senderId:'person-a'});
  assert.equal(draft.samples[0].context[0].text,'这事真挺逗的');
  assert.equal(draft.samples[0].context[0].speaker,'其他成员');
});

test('assistant commands are distinguished from greetings and ordinary name mentions', () => {
  assert.equal(assistantTask('助手，帮我总结一下这个方案',['助手']),true);
  assert.equal(assistantTask('助手，早上好',['助手']),false);
  assert.equal(assistantTask('这句话里提到了助手',['助手']),false);
});

test('plain model dossier is returned unchanged in one call, without evidence schema or phrase approval', async () => {
  const body='# 人物语言档案\n## 性格特点\n说话直接，熟人之间喜欢调侃，偶尔嘴硬心软。\n## 场合差异\n认真时会说明理由，开玩笑时会说“今天这个事情真是有点离谱了吧”。';
  const fixture=summaryService(fakeStore(),body);
  const draft=await fixture.service.call('persona.distill',{accountId:'account-a',senderId:'person-a',warmth:'warm'});
  assert.equal(fixture.calls(),1);assert.equal(draft.persona.prompt,body);assert.equal(draft.summarized,true);
  assert.equal(draft.samples,undefined);assert.equal(draft.privacyEntities,undefined);assert.equal(draft.draftToken,undefined);
  assert.match(fixture.request().messages[1].content,/增加温度/);
  assert.doesNotMatch(draft.persona.prompt,/统计模板/);
});

test('empty model result is an honest generation error, never a statistical persona fallback', async () => {
  const fixture=summaryService(fakeStore(),'');
  await assert.rejects(fixture.service.call('persona.distill',{accountId:'account-a',senderId:'person-a'}),{code:'PERSONA_SUMMARY_EMPTY'});
  assert.equal(fixture.calls(),1);
});

test('cancelled read authorization during generation still cancels that operation', async () => {
  const store=fakeStore(), fixture=summaryService(store,'模型正文',()=>{store.data.authorizationEpochs['account-a']=1;});
  await assert.rejects(fixture.service.call('persona.distill',{accountId:'account-a',senderId:'person-a'}),{code:'AUTHORIZATION_CHANGED'});
});

test('generated text saves without a token even offline or after the source permission changed', async t => {
  const {store,root}=realStore(t);
  store.data.authorizationEpochs['account-a']=99;
  store.configure('account-a',{...store.settings('account-a'),privatePeers:[],groups:[]});
  await agentMutation(ownerContext(store),'persona.create',{source:'distilled',name:'真正的人物语言档案',persona:persona('直接、有点损，熟人之间爱开玩笑。')});
  assert.equal(store.persona().prompt,'直接、有点损，熟人之间爱开玩笑。');
  assert.equal(new StateStore(root).persona().prompt,store.persona().prompt);
});

test('old missing or incomplete provenance and disabled flags never block a saved persona', t => {
  const {store,root}=realStore(t);
  const old=validatePersonaEntry({id:'old',name:'旧总结',source:'distilled',disabled:true,provenance:{legacyNote:true},persona:persona('以前模型已经总结好的正文')});
  store._writePersonas([old],'old');
  assert.equal(store.activePersonaId(),'old');assert.equal(store.persona().prompt,'以前模型已经总结好的正文');
  assert.equal(store.personasView().items[0].disabled,undefined);assert.equal(store.personasView().suspendedId,undefined);
  const reloaded=new StateStore(root);reloaded.selectPersona('old');assert.equal(reloaded.persona().prompt,store.persona().prompt);
});

test('cleanup discovers stored account data without treating saved persona notes as source scopes', t => {
  const {store,root}=realStore(t), retained={accountId:'account-a',chatType:'group',peerId:'retained@chatroom'};
  store.data.conversations.retained=retained;
  let personaReads=0;
  store.personaEntries=()=>{personaReads++;return [
    {source:'distilled',provenance:{legacyNote:true}},
    {source:'distilled',provenance:{accountId:'persona-only-account',personId:'persona-only-person',sourceScopes:[
      {accountId:'persona-only-account',chatType:'group',peerId:'persona-only-room@chatroom'}]}},
  ];};
  const channel={store,memory:{index:{conversations:{}}},imageMemory:{storedScopes:()=>[]},
    momentsAutomation:{likes:{data:{accounts:{},records:{}}},interactions:{automation:{data:{accounts:{}}},data:{runs:{}}},materials:{data:{accounts:{}}}},
    library:{data:{accounts:{}}},longMemory:{paths:()=>({file:path.join(root,'absent-synthetic-long-memory.md')})}};
  assert.deepEqual(storedObjectScopes(channel),[retained]);
  assert.deepEqual(storedObjectScopes(channel),[retained], 'repeated startup discovery must not manufacture persona-only revocations');
  assert.equal(personaReads,0);
});

test('source revocation no longer switches or rewrites the user-selected saved persona', t => {
  const {store,root}=realStore(t);
  store.createPersona({source:'distilled',name:'已保存',persona:persona('正文不应被权限变化改写')});
  const id=store.activePersonaId();
  store.configure('account-a',{...store.settings('account-a'),privatePeers:[],groups:[]});
  assert.equal(store.activePersonaId(),id);assert.equal(store.persona().prompt,'正文不应被权限变化改写');
  assert.equal(new StateStore(root).persona().prompt,'正文不应被权限变化改写');
});

test('manual and generated text are equally editable, while concurrent selection cannot overwrite another entry', async t => {
  const {store}=realStore(t), context=ownerContext(store);
  await agentMutation(context,'persona.create',{source:'distilled',name:'库标题',persona:persona()});
  const id=store.activePersonaId();
  await agentMutation(context,'persona.save',{id,persona:persona('口头禅：“我家孩子都能看明白”。直接一点，工作话题也不用客服腔。')});
  assert.match(store.persona().prompt,/我家孩子|工作话题/);
  assert.equal(store.personasView().items.find(item=>item.id===id).name,'库标题');
  const guarded={...context,paused:async(_reason,action)=>{store.selectPersona('default');return action();}};
  await assert.rejects(agentMutation(guarded,'persona.save',{id,persona:persona('不能覆盖别人')}),{code:'PERSONA_CHANGED'});
});

test('only an explicit delete removes an entry, leaving other named personas intact', t => {
  const {store}=realStore(t);store.createPersona({name:'条目一',source:'distilled',persona:persona('正文一')});const first=store.activePersonaId();
  store.createPersona({name:'条目二',persona:persona('正文二')});const second=store.activePersonaId();
  store.deletePersona(first);assert.equal(store.activePersonaId(),second);assert.equal(store.persona().prompt,'正文二');
});
