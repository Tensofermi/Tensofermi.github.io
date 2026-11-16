const $ = id => document.getElementById(id);
const LABEL = {prompt:'prompt',cot:'CoT',call:'call',observation:'observation',message:'message',format:'格式 / 控制',mixed:'跨片段'};
const COLORS = {prompt:'var(--prompt)',cot:'var(--cot)',call:'var(--call)',observation:'var(--observation)',message:'var(--message)',format:'var(--format)',mixed:'var(--mixed)'};
const PAGE = 800;
let preview = null, activeRecord = null, tokenPage = 0, selectedToken = null, controller = null, busy = false;
let pendingCompaction = null;
let modelCatalog = [];
let agentTools = [];
let imported=null, renderedTokenCount=0, selectedElement=null, editTarget=null, inputScope='draft';
function currentModel(){return modelCatalog.find(m=>m.id===$('model').value);}
function chooseModel(id){if(id&&modelCatalog.some(m=>m.id===id))$('model').value=id;const m=currentModel();if(!m)return;
  $('context-limit').textContent=m.context_window.toLocaleString()+' 上限';
  $('model-description').textContent=m.reconstruction?`${m.format} · 使用该模型公开的格式与 tokenizer 在本机重建；API usage 单独作为服务端证据。`:`${m.format} · 缺少可核实的该服务模型格式，当前只记录实际 API JSON 与 usage。`;
  $('format-source').hidden=!m.format_source;if(m.format_source)$('format-source').href=m.format_source;
  $('prefix-helper').hidden=m.provider!=='deepseek-official';$('generated-details').hidden=!m.reconstruction;
  $('one-token').textContent=m.provider==='deepseek-official'?'预测 1 token':'生成 1 token';
  $('settings-note').textContent=m.thinking_control==='deepseek'?'思考与强度会成为 API 的 thinking、reasoning_effort；官方 V4.1 编码器也会写入前缀。':'强度传 reasoning_effort；关闭思考时传 enable_thinking=false。';
  $('evidence-boundary').textContent=m.reconstruction?'彩色 token 是该模型公开参考文件在本机重建；API 未返回服务端实际逐 token 序列。若本地计数与 API usage 不同，不应把这张图视为服务端实收。':'该模型路由未提供可核实的逐 token 格式；只展示实际请求 JSON 与 API usage。';
  localStorage.setItem('trajectory-model',m.id);pendingCompaction=null;preview=null;clearOutput();
}

function notice(message, kind='') { $('notice').textContent = message; $('notice').className = 'notice ' + kind; }
function formatted(v) { return JSON.stringify(v, null, 2); }
function parseEditor(id, expected) {
  let value;
  try { value = JSON.parse($(id).value || (expected === 'array' ? '[]' : 'null')); }
  catch (e) { throw Error(id + ' JSON 格式错误：' + e.message); }
  if (expected === 'array' && !Array.isArray(value)) throw Error(id + ' 必须是 JSON 数组');
  return value;
}
function payload() {
  const value = {model:$('model').value,messages:parseEditor('messages','array'), tools:parseEditor('tools','array'),
    thinking:$('thinking').value === 'true', effort:$('effort').value,
    max_tokens:Number($('max-tokens').value)};
  if(pendingCompaction && JSON.stringify([value.model,value.messages,value.tools,value.thinking,value.effort])===pendingCompaction.signature)
    value.compaction_draft_id=pendingCompaction.id;
  return value;
}
async function api(path, body) {
  const response = await slateFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let data;
  try { data = await response.json(); } catch { throw Error('服务器未返回 JSON'); }
  if (!response.ok) throw Error(data.error || '请求失败');
  return data;
}
function node(tag, className='', value='') { const e=document.createElement(tag); if(className)e.className=className; if(value)e.textContent=value; return e; }
function renderTrajectory(messages=null,record=null){
  const box=$('trajectory-flow');box.replaceChildren();
  $('flow-scope').textContent=record?`已保存调用 #${record.id.slice(0,8)} · 下列输入曾提交，末条模型回复是该次响应。`:'当前可编辑 messages · 下一次调用的草稿，尚未发送。';
  if(!messages)try{messages=parseEditor('messages','array');}catch(e){box.append(node('p','empty',e.message));return;}
  for(const [index,message] of messages.entries()){
    const role=message.role||'未知角色';
    const item=node('article','flow-item '+role);
    const header=node('div','flow-header');
    header.append(node('strong','',`${index+1}. ${role}`));
    if(message._record_id)header.append(node('span','flow-record',`API 回复 #${message._record_id.slice(0,8)}`));
    if(message._origin)header.append(node('span','flow-origin',message._origin));
    item.append(header);
    if(message.content)item.append(node('pre','flow-text',typeof message.content==='string'?message.content:formatted(message.content)));
    if(message.reasoning_content){
      const status=record?(record.api_request?.messages?.[index]?.reasoning_content?'当次请求包含此字段':'本次模型响应；是否进入后续请求须看后续记录'):'下次请求将包含此字段';
      item.append(node('div','flow-label cot',`CoT · reasoning_content（${status}）`),node('pre','flow-text cot',message.reasoning_content));
    }
    if(message._observed_reasoning_content){item.append(node('div','flow-label cot','CoT · 仅本地观察，不进入 API'),node('pre','flow-text cot',message._observed_reasoning_content));}
    for(const call of message.tool_calls||[]){
      item.append(node('div','flow-label call',`call · ${call.function?.name||'tool'} · ${call.id||'无 ID'}`),
        node('pre','flow-text call',call.function?.arguments||''));
    }
    if(message.tool_call_id)item.append(node('div','flow-label observation',`observation 对应 call ID：${message.tool_call_id}`));
    box.append(item);
  }
  box.append(node('div','flow-next',record?'→ 当次调用在模型回复处结束；下一次调用的实际输入请看后续记录。':'→ 当前编辑区构成下一次推理的输入草稿；尚未发送'));
}
function sampleChat() {
  $('messages').value = formatted([
    {role:'system',content:'你是一位耐心的数学老师。请简洁地回答问题。',_origin:'用户编写的系统提示'},
    {role:'user',content:'17×23 等于多少？',_origin:'用户输入'}]);
  $('tools').value='[]'; $('thinking').value='true'; $('effort').value='high';
  preview=null; activeRecord=null; pendingCompaction=null; clearOutput(); notice('对话示例已载入；正在重建石板。');
}
function sampleAgent() {
  $('messages').value=formatted([
    {role:'system',content:'你是数学助教。算术请先使用 add_numbers，再向用户解释结果。',_origin:'示例系统提示'},
    {role:'user',content:'请使用工具计算 17 + 23，再解释如何验算。',_origin:'示例用户消息'}]);
  $('tools').value=formatted(agentTools);
  $('thinking').value='true';$('effort').value='high';preview=null;activeRecord=null;pendingCompaction=null;clearOutput();
  notice('Agent 示例已载入。点「▶ Agent 回合」后，网站会在本机执行工具并把 observation 发回模型，连接 DeepSeek 后，每轮请求会保存在当前浏览器。');
}
function clearOutput() { $('reasoning-output').textContent='—';$('message-output').textContent='—';$('call-output').hidden=true;$('candidates').hidden=true;$('finish').textContent='尚未调用';$('generation-status').textContent='点击「连续生成」后，这里会显示调用进度与结果。';$('adopt').disabled=true;$('adopt').textContent='把模型回答加入历史';$('raw-json').textContent='尚未有调用记录。';$('generated-grid').replaceChildren();$('provider-count').textContent='—'; }
function setBusy(value,canStop=false){busy=value;$('generate').disabled=value;$('one-token').disabled=value;$('agent-run').disabled=value;$('stop').disabled=!value||!canStop;}
function showOutput(){ $('output-card').scrollIntoView({behavior:'smooth',block:'start'}); }

function renderInput(data, scope='draft') {
  imported=null;preview=data; tokenPage=0; selectedToken=null;selectedElement=null;inputScope=scope;
  $('exit-import').hidden=true;$('generate').disabled=busy;$('one-token').disabled=busy;$('agent-run').disabled=busy;
  $('import-warning').hidden=true;$('template-reference-open').hidden=true;
  $('add-user').disabled=false;$('add-tool').disabled=false;
  $('slab-title').textContent='当前推理输入';
  renderTrajectory();
  $('provider-count').textContent='—';
  $('input-scope').textContent=scope==='record'?'本次已发送的请求输入快照；下方 API 用量属于这次调用。':scope==='inflight'?'本次请求已经提交，正在等待模型响应。':scope==='next'?'下一次调用的草稿，尚未发送；刚完成那次调用的输入可从下方记录查看。':'当前可编辑消息的下一次调用草稿，尚未发送。';
  const known=data.count!=null;
  $('view-mode').querySelector('option[value="tokens"]').disabled=!known;
  if(!known)$('view-mode').value='text';
  $('local-count').textContent=known?data.count.toLocaleString():'未知';
  $('context-percent').textContent=known?(100*data.count/data.context_window).toFixed(3)+'%':'等待 API usage';
  $('next-index').textContent=data.next_position!=null?'#'+data.next_position.toLocaleString():'未知';
  $('continuation-index').textContent=data.next_position!=null?'token #'+data.next_position.toLocaleString()+' · 字符偏移 '+data.next_char.toLocaleString():'服务端续写位置未公开';
  $('evidence').textContent=known?'官方参考 · '+data.model_format:(data.evidence==='draft_only'?'仅编辑草稿 · ':'仅 API JSON · ')+data.model_format;
  $('token-caption').textContent=known?'点击任意 token 查看 ID、分词片段、归属与来源':'服务端 token ID 不可见；下方显示将提交的结构化 JSON';
  const order=['prompt','cot','call','observation','message','format','mixed'];
  $('composition').replaceChildren();$('breakdown').replaceChildren();
  for (const kind of order) {
    const count=data.counts[kind]||0;if (!count)continue;
    const bar=node('span');bar.style.width=(count/data.count*100)+'%';bar.style.background=COLORS[kind];bar.title=LABEL[kind]+' '+count; $('composition').append(bar);
    const summary=node('span');const strong=node('b','',LABEL[kind]);summary.append(strong,document.createTextNode(count.toLocaleString()+' · '+(100*count/data.count).toFixed(1)+'%'));$('breakdown').append(summary);
  }
  if(known)renderPage();else{$('token-grid').replaceChildren(node('pre','api-only-json',formatted(data.api_request||{messages:data.request_messages,tools:data.request_tools})));$('page-range').textContent='—';$('page-label').textContent='—';$('prev-page').disabled=true;$('next-page').disabled=true;}
  renderStoneMode();$('edit-selection').disabled=true;
  $('token-inspector').replaceChildren(node('div','inspector-empty',known?'点击石板上的任意 token 查看归属。':'此模型的真实 token ID 未由 API 提供。'));
}
function renderPage() {
  const tokens=preview?.tokens||[];
  renderedTokenCount=0;$('token-grid').replaceChildren();
  if(!tokens.length){$('token-grid').append(node('p','empty','无 token'));$('load-sentinel').hidden=true;return;}
  appendMoreTokens();
}
function appendMoreTokens(){
  if(imported||!preview?.tokens?.length)return;
  const tokens=preview.tokens,start=renderedTokenCount,end=Math.min(start+PAGE,tokens.length);
  const fragment=document.createDocumentFragment();
  for (const token of tokens.slice(start,end)) {
    const text=token.text||token.piece||'∅';
    const b=node('button','token '+token.kind,text.replaceAll('\n','↵').replaceAll('\t','⇥'));
    b.type='button';b.title='#'+token.index+' · ID '+token.id+' · '+token.sources.join(' / ');
    if(selectedToken===token.index)b.classList.add('selected');
    b.addEventListener('click',()=>inspectToken(token,b));fragment.append(b);
  }
  $('token-grid').append(fragment);renderedTokenCount=end;
  $('page-range').textContent=`已展开 ${end.toLocaleString()} / ${tokens.length.toLocaleString()} tokens`;
  $('load-sentinel').hidden=end>=tokens.length||$('view-mode').value!=='tokens';
}
function inspectToken(token,element=null) {
  selectedToken=token.index;
  if(selectedElement)selectedElement.classList.remove('selected');
  selectedElement=element;if(element)element.classList.add('selected');
  const box=$('token-inspector');box.replaceChildren();
  box.append(node('div','big-piece',token.text?.replaceAll('\n','↵')||token.piece||'∅'));
  const dl=node('dl');
  const entries=[['位置','#'+token.index],['Token ID',String(token.id)],['Tokenizer piece',token.piece],
    ['分类',LABEL[token.kind]||token.kind],['贡献片段',(token.contributors||[]).map(x=>LABEL[x]||x).join(' / ')],
    ['来源',(token.sources||[]).join('\n')],['字符范围',token.start==null?(token.range_label||'响应字段重新分词'):`${token.start}–${token.end}`],
    ['证据',token.evidence|| (token.start==null?'本机重新分词 API 响应字段':'官方参考编码器本地重建')]];
  for(const [name,value] of entries){dl.append(node('dt','',name),node('dd','',value||'—'));}box.append(dl);
  const match=!imported&&inputScope!=='record'&&(token.sources||[]).join(' ').match(/messages\[(\d+)\]\.(content|reasoning_content)/);
  editTarget=match?{index:Number(match[1]),field:match[2]}:null;
  $('edit-selection').disabled=!editTarget;
}
let importObserver=null;
function renderStoneMode(){
  if(!imported&&importObserver){importObserver.disconnect();importObserver=null;}
  const tokenMode=$('view-mode').value==='tokens';
  $('token-grid').hidden=Boolean(imported)||!tokenMode;
  $('slab-text').hidden=Boolean(imported)||tokenMode;
  $('import-grid').hidden=!imported;
  if(imported){renderImported();return;}
  if(!tokenMode){
    const raw=preview?.prompt||formatted(preview?.api_request||{messages:preview?.request_messages,tools:preview?.request_tools});
    $('slab-text').textContent=raw;
    $('page-range').textContent=preview?.prompt?`${new TextEncoder().encode(raw).length.toLocaleString()} UTF-8 bytes · ${raw.length.toLocaleString()} 字符`:'API JSON · 未知服务端文本';
  }else if(preview?.tokens){
    $('page-range').textContent=`已展开 ${renderedTokenCount.toLocaleString()} / ${preview.tokens.length.toLocaleString()} tokens`;
  }
  $('load-sentinel').hidden=!tokenMode||renderedTokenCount>=(preview?.tokens?.length||0);
}
function showImport(data){
  if(data.model_key&&modelCatalog.some(m=>m.id===data.model_key))chooseModel(data.model_key);
  imported={...data,tokenCache:new Map()};preview=null;activeRecord=null;selectedToken=null;selectedElement=null;editTarget=null;
  clearOutput();$('generate').disabled=true;$('one-token').disabled=true;$('agent-run').disabled=true;$('edit-selection').disabled=true;
  $('add-user').disabled=true;$('add-tool').disabled=true;
  $('exit-import').hidden=false;$('slab-title').textContent='轨迹事件字段 · '+(data.trajectory_id||'未命名');
  $('model-description').textContent='已载入 '+data.source+'；下方是文件中实际可见的事件字段。';
  $('input-scope').textContent=`${data.schema} · ${data.model_name} · ${data.note}`;
  $('evidence').textContent='事件字段 · 未套用 chat template';
  $('import-warning').hidden=false;
  $('import-warning').textContent='这里逐项展示 trajectory.json 的原始事件字段，只对字段正文重新分词；因此不会出现 chat template 控制 token。文件缺少逐次请求快照，无法核实模型当时的完整前缀。';
  $('template-reference-open').hidden=!(data.tokenizer_available&&data.reference_messages?.length);
  $('template-reference-open').textContent=`查看 ${currentModel()?.label||data.model_name} 模板参考`;
  $('local-count').textContent='—';$('provider-count').textContent='—';$('context-percent').textContent='—';$('next-index').textContent='—';
  $('continuation-index').textContent='文件未提供逐次完整请求；未知';
  $('token-caption').textContent=data.tokenizer_available?'token 块是此模型 tokenizer 对各事件文字的重新分词；不是模型实收 prompt。':'此模型缺少可核实的 tokenizer；只展示事件原文。';
  $('evidence-boundary').textContent=data.note;
  $('composition').replaceChildren();$('breakdown').replaceChildren();$('token-inspector').replaceChildren(node('div','inspector-empty','点击已重分词的事件 token 查看来源。'));
  $('view-mode').querySelector('option[value="tokens"]').disabled=!data.tokenizer_available;
  if(!data.tokenizer_available)$('view-mode').value='text';
  $('generation-status').textContent='导入视图只读；退出导入后可继续编辑消息。';
  renderStoneMode();$('import-dialog').close();notice(`已读取前 ${data.loaded_steps} / ${data.total_steps} 步；模型 ${data.model_name}。`,'good');
}
async function openTemplateReference(){
  if(!imported?.reference_messages?.length||!imported.model_key)return;
  const source=imported,button=$('template-reference-open');button.disabled=true;button.textContent='正在渲染模板…';
  try{
    const result=await api('/api/preview',{model:source.model_key,messages:source.reference_messages,
      tools:[],thinking:true,effort:source.reference_effort||'high',max_tokens:1});
    if(imported!==source)return;
    if(!result.prompt)throw Error('该模型没有可核实的本地模板输出');
    $('template-scope').textContent=`只将本轨迹开头的 ${source.reference_messages.length} 条 system/user 字段送入公开模板；工具定义为空，思考强度 ${source.reference_effort||'high'}。这是格式演示，不是历史调用的实收前缀，不能补出压缩、隐藏提示或服务端版本。`;
    const markers=result.prompt.match(/<｜System｜>|<｜User｜>|<｜Assistant｜>|<think>|<\/think>/g)||[];
    $('template-markers').textContent=markers.join(' → ');
    $('template-count').textContent=`${result.count?.toLocaleString()??'未知'} 个本地参考 token · ${result.model_format}`;
    $('template-text').textContent=result.prompt;$('template-dialog').showModal();
  }catch(e){notice('模板参考生成失败：'+e.message,'error');}
  finally{button.disabled=false;button.textContent=`查看 ${currentModel()?.label||source.model_name} 模板参考`;}
}
function renderImported(){
  if(importObserver){importObserver.disconnect();importObserver=null;}
  const box=$('import-grid');box.replaceChildren();
  if(!imported)return;
  const tokenMode=$('view-mode').value==='tokens'&&imported.tokenizer_available;
  if(tokenMode){importObserver=new IntersectionObserver(entries=>{
    for(const entry of entries){
      const item=entry.target;
      if(entry.isIntersecting&&!item.classList.contains('tokens-loaded')&&!item.classList.contains('tokens-loading'))tokenizeImported(Number(item.dataset.index),item);
      else if(!entry.isIntersecting&&item.classList.contains('tokens-loaded'))collapseImported(item);
    }
  },{rootMargin:'700px'});}
  appendImportedCards(0,tokenMode);
  
}
function appendImportedCards(start,tokenMode){
  const box=$('import-grid'),fragment=document.createDocumentFragment(),pending=[];
  for(let index=start;index<imported.segments.length;index++){
    const segment=imported.segments[index];
    const item=node('article','import-segment '+segment.kind);item.dataset.index=index;
    const header=node('header');header.append(node('strong','',segment.title),node('span','',segment.origin+` [${segment.char_start}:${segment.char_end}]`+(segment.call_id?' · '+segment.call_id:'')));item.append(header);
    if(tokenMode){item.append(node('div','pending','滚动到这里后按该模型 tokenizer 重分词…'));pending.push(item);}
    else item.append(node('pre','',segment.text));
    fragment.append(item);
  }
  box.append(fragment);for(const item of pending)importObserver.observe(item);
}
function collapseImported(item){
  const header=item.querySelector('header');
  item.style.height=item.offsetHeight+'px';
  item.replaceChildren(header,node('div','collapsed-summary','token 已暂时收起；滚动回这里会从缓存恢复。'));
  item.classList.remove('tokens-loaded');
}
async function tokenizeImported(index,item){
  if(!imported||!item.isConnected)return;
  item.classList.add('tokens-loading');
  const source=imported,segment=source.segments[index];
  try{
    let tokens=source.tokenCache.get(index);
    if(!tokens){const result=await api('/api/tokenize-field',{model:source.model_key,text:segment.text});tokens=result.tokens;source.tokenCache.set(index,tokens);}
    if(imported!==source||!item.isConnected||$('view-mode').value!=='tokens')return;
    const rect=item.getBoundingClientRect();
    if(rect.bottom < -700 || rect.top > window.innerHeight+700)return;
    const fragment=document.createDocumentFragment();
    for(const [position,token] of tokens.entries()){
      const piece=token.text??token.piece??'∅';const b=node('button','token '+segment.kind,piece.replaceAll(' ','␠').replaceAll('\n','↵').replaceAll('\t','⇥'));b.type='button';
      b.title=`字段 token #${position} · ID ${token.id} · ${segment.origin}`;
      b.addEventListener('click',()=>inspectToken({...token,index:position,kind:segment.kind,text:piece,sources:[`${segment.origin} [${segment.char_start}:${segment.char_end}]`,...(segment.call_id?['tool call ID '+segment.call_id]:[])],contributors:[segment.kind],start:token.start==null?null:segment.char_start+token.start,end:token.end==null?null:segment.char_start+token.end,range_label:'导入字段重新分词',evidence:'导入轨迹事件字段的本机重新分词；不是模型实收 token'},b));
      fragment.append(b);
    }
    item.querySelector('.pending')?.remove();item.querySelector('.collapsed-summary')?.remove();item.append(fragment);
    item.classList.add('tokens-loaded');
  }catch(e){const pending=item.isConnected&&item.querySelector('.pending');if(pending)pending.textContent='字段分词失败：'+e.message;}
  finally{item.classList.remove('tokens-loading');}
}
function openEdit(){
  if(!editTarget)return;
  try{const messages=parseEditor('messages','array');const {index,field}=editTarget;
    if(!messages[index]||typeof messages[index][field]!=='string')throw Error('片段已变化，请重建石板后再选');
    $('edit-source').textContent=`messages[${index}].${field} · 云 API 模式只修改消息字段；格式控制 token 由服务端处理。`;
    $('edit-content').value=messages[index][field];$('edit-dialog').showModal();
  }catch(e){notice(e.message,'error');}
}
function saveEdit(){
  try{const messages=parseEditor('messages','array');const {index,field}=editTarget;
    messages[index][field]=$('edit-content').value;$('messages').value=formatted(messages);$('edit-dialog').close();refreshDraft('next','已修改消息字段并重建石板。');
  }catch(e){notice(e.message,'error');}
}
async function importLocal(file){
  if(!file)return;
  try{if(file.size>12*1024*1024)throw Error('文件超过 12 MB。');const data=JSON.parse(await file.text());const result=await api('/api/import-trajectory',{data,source:file.name});showImport(result);}
  catch(e){$('import-status').textContent='本机文件导入失败：'+e.message;}
  finally{$('local-import').value='';}
}
function renderGenerated(tokens) {
  const grid=$('generated-grid');grid.replaceChildren();
  for(const token of (tokens||[]).slice(0,300)){
    const b=node('button','token '+token.kind,(token.text||token.piece||'∅').replaceAll('\n','↵'));b.type='button';b.title='本机重新分词 · ID '+token.id;
    b.addEventListener('click',()=>inspectToken(token));grid.append(b);
  }
  if((tokens||[]).length>300)grid.append(node('span','empty',`仅显示前 300 / ${tokens.length} 个重新分词 token`));
}
function renderCandidates(record) {
  const c=$('candidates');c.replaceChildren();
  const logs=record?.response?.choices?.[0]?.logprobs;
  const candidates=(logs?.content?.[0]||logs?.reasoning_content?.[0])?.top_logprobs;
  if(!candidates?.length){c.hidden=true;return;}c.hidden=false;c.append(node('strong','','API 返回的下一 token 候选（ID 未提供）'));
  for(const x of candidates){const row=node('div','candidate');row.append(node('span','',JSON.stringify(x.token)),node('span','',(Math.exp(x.logprob)*100).toFixed(3)+'% · logp '+x.logprob.toFixed(3)));c.append(row);}
}
function renderRecord(record) {
  if(!record||!record.type){
    activeRecord=null;
    $('finish').textContent='无记录';$('raw-json').textContent='本次回合没有完成任何 API 调用；没有可展示的记录。';
    renderGenerated(null);$('generated-grid').replaceChildren();
    return;
  }
  activeRecord=record;
  chooseModel(record.model_key||'deepseek-official/deepseek-flash');
  if(record.type==='compaction_draft'){
    $('messages').value=formatted(record.after_messages);$('tools').value=formatted(record.after_tools||[]);
    $('thinking').value=String(record.after_thinking);$('effort').value=record.after_effort||'high';
    pendingCompaction={id:record.id,signature:JSON.stringify([record.after_model||$('model').value,record.after_messages,record.after_tools||[],record.after_thinking,record.after_effort||'high'])};
    renderComparison(record);notice(record.submitted_call_id?'此压缩草稿已关联后续调用 #'+record.submitted_call_id.slice(0,8):'压缩对照草稿已打开；只有后续 API 调用才能证明 after_messages 已提交。');return;
  }
  renderInput(record.input,'record');
  const recorded=appendResponse(record,record.input_with_local_origins||record.api_request?.messages||[]);
  renderTrajectory(recorded.messages,record);
  $('provider-count').textContent=record.usage?.prompt_tokens?.toLocaleString()||'未返回';
  const mismatch=record.input?.count!=null&&record.usage?.prompt_tokens!=null&&record.input.count!==record.usage.prompt_tokens;
  if(mismatch)$('evidence').textContent='本地参考 · 与 API 用量不一致';
  if(record.input?.count==null&&record.usage?.prompt_tokens!=null)$('context-percent').textContent=(100*record.usage.prompt_tokens/record.input.context_window).toFixed(3)+'% · API';
  const msg=record.response?.choices?.[0]?.message||{};
  $('reasoning-output').textContent=msg.reasoning_content||'—';$('message-output').textContent=msg.content||'—';
  const calls=msg.tool_calls||[];$('call-output').hidden=!calls.length;$('call-output').querySelector('pre').textContent=calls.length?formatted(calls):'';
  $('finish').textContent=record.finish_reason||'中断 / 未知';
  const visible=Boolean(msg.content||msg.reasoning_content||calls.length);
  $('generation-status').textContent=(visible?`已完成 · ${record.model} · ${(record.elapsed_ms/1000).toFixed(2)} 秒 · 输出 ${record.usage?.completion_tokens??'未知'} token。`:'调用已完成，但没有可见正文；若只生成 1 token，它可能落在思考或控制部分。点击「连续生成」可看完整回答。')+(mismatch?' 注意：参考输入数与 API 用量不同，彩色图不是服务端实收序列。':'');
  $('adopt').textContent='把模型回答加入历史';$('adopt').disabled=!record.response?.choices?.length;
  $('raw-json').textContent=formatted({record_id:record.id,created_at:record.created_at,endpoint_url:record.endpoint_url||record.endpoint_path,
    request:record.api_request,response:record.response,usage:record.usage,evidence:record.evidence});
  renderGenerated(record.generated?.tokens);renderCandidates(record);
  if(record.compaction_draft_id)pendingCompaction=null;
  notice(`已保存推理 #${record.id.slice(0,8)} · ${record.model}。API 报告输入 ${record.usage?.prompt_tokens??'未知'} token；本地重建 ${record.input?.count??'不可用'} token。${mismatch?'两者不一致，不能把本地图视为服务端实收序列。':''}`,mismatch?'mismatch':'good');
  loadHistory();
}
let draftVersion = 0;
async function refreshDraft(scope='draft',message=''){
  const version=++draftVersion;
  let p;try{p=payload();}catch(e){notice(e.message,'error');return;}
  notice('正在重建石板…');
  try{const data=await api('/api/preview',p);if(version!==draftVersion)return;renderInput(data,scope);notice(message||data.warning,message?'good':'');}
  catch(e){if(version!==draftVersion)return;renderInput({evidence:'draft_only',count:null,counts:{},context_window:currentModel()?.context_window||1,next_position:null,next_char:null,model_format:'参考重建失败',request_messages:p.messages,request_tools:p.tools,tokens:[]},scope);notice((message?message+'；':'')+'参考重建失败：'+e.message,'error');}
}
async function showPreview(){await refreshDraft();}
function sameDraft(submitted){try{const current=payload();return JSON.stringify([current.model,current.messages,current.tools,current.thinking,current.effort])===JSON.stringify([submitted.model,submitted.messages,submitted.tools,submitted.thinking,submitted.effort]);}catch{return false;}}
function appendResponse(record, baseMessages){
  const response=record.response?.choices?.[0]?.message||{};
  const source=record.model+' API response #'+record.id.slice(0,8);
  const messages=structuredClone(baseMessages);
  if(messages.some(message=>message._record_id===record.id||message._origin===source))return {messages,changed:false,reason:'这条回复已在 messages 中，无需重复追加。'};
  if(!response.content&&!response.reasoning_content&&!response.tool_calls?.length)return {messages,changed:false,reason:'本次没有可见回复字段，因此没有可安全追加的 assistant 消息。'};
  const existing=messages.at(-1);
  const assistant=existing?.role==='assistant'&&existing.prefix?existing:{role:'assistant',content:''};
  assistant.content=(assistant.content||'')+(response.content||'');
  if(response.reasoning_content){
    const field=record.provider==='deepseek-official'||record.api_request?.tools?.length?'reasoning_content':'_observed_reasoning_content';
    assistant[field]=(assistant[field]||'')+response.reasoning_content;
  }
  if(response.tool_calls?.length)assistant.tool_calls=response.tool_calls.map(call=>({id:call.id,type:call.type||'function',function:{name:call.function?.name||'',arguments:call.function?.arguments||''}}));
  assistant._origin=source;assistant._record_id=record.id;
  if(existing!==assistant)messages.push(assistant);
  if(assistant.prefix&&(record.finish_reason==='stop'||response.tool_calls?.length))delete assistant.prefix;
  return {messages,changed:true,reason:response.tool_calls?.length?'模型工具调用已加入 messages；请手动回填工具结果，再继续推理。':'模型回复已自动加入 messages；上方显示下一次调用草稿。'};
}
async function advanceAfterGeneration(record,submitted,unchanged){
  if(!unchanged){notice('生成期间编辑区发生变化；为避免覆盖你的修改，未自动追加。可用「把模型回答加入历史」手动加入。','error');return;}
  const result=appendResponse(record,submitted.messages);
  if(!result.changed){notice(result.reason,'good');return;}
  $('messages').value=formatted(result.messages);
  $('adopt').disabled=true;$('adopt').textContent='已自动加入历史';
  const completedStatus=$('generation-status').textContent;
  $('generation-status').textContent=completedStatus+' 正在更新下一轮输入…';
  await refreshDraft('next',result.reason);
  $('generation-status').textContent=completedStatus+' 回复已自动加入消息 JSON；石板已切换到下一轮草稿。';
}
async function invokeOne(){if(busy)return;try{const p=payload();p.max_tokens=1;setBusy(true);$('generation-status').textContent='正在请求 1 个 token…';showOutput();notice('正在请求所选模型生成 1 token…');const record=await api('/api/call',p);const unchanged=sameDraft(p);renderRecord(record);await advanceAfterGeneration(record,p,unchanged);showOutput();}catch(e){$('generation-status').textContent='调用失败：'+e.message;notice(e.message,'error');}finally{setBusy(false);}}
async function invokeStream(){
  if(busy)return;
  let p;try{p=payload();}catch(e){notice(e.message,'error');return;}
  controller=new AbortController();setBusy(true,true);const started=Date.now();let received=0;
  const clock=setInterval(()=>{$('generation-status').textContent=`正在生成 · ${(Date.now()-started)/1000|0} 秒 · 已收到 ${received} 字符`},250);
  $('reasoning-output').textContent='等待模型输出…';$('message-output').textContent='等待模型输出…';$('finish').textContent='生成中';$('generation-status').textContent='正在连接模型…';notice('已提交请求，正在等待首个流式片段…');showOutput();
  try{
    const response=await slateFetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p),signal:controller.signal});
    if(!response.ok){const x=await response.json();throw Error(x.error||'API 请求失败');}
    const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='',done=false;
    while(!done){const result=await reader.read();if(result.done)break;buffer+=decoder.decode(result.value,{stream:true});let cut;
      while((cut=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,cut);buffer=buffer.slice(cut+1);if(!line)continue;const event=JSON.parse(line);
        if(event.type==='start'){renderInput(event.input,'inflight');notice('推理中 · '+(event.input.count==null?'等待 API 输入用量':`本地重建输入 ${event.input.count} tokens`));}
        if(event.type==='chunk')for(const choice of event.chunk.choices||[]){const d=choice.delta||{};if(d.reasoning_content){if($('reasoning-output').textContent==='等待模型输出…')$('reasoning-output').textContent='';$('reasoning-output').textContent+=d.reasoning_content;received+=d.reasoning_content.length;}if(d.content){if($('message-output').textContent==='等待模型输出…')$('message-output').textContent='';$('message-output').textContent+=d.content;received+=d.content.length;}if(d.tool_calls?.length)$('generation-status').textContent='模型正在生成工具调用…';}
        if(event.type==='error')throw Error(event.error);
        if(event.type==='done'){const unchanged=sameDraft(p);renderRecord(event.record);await advanceAfterGeneration(event.record,p,unchanged);showOutput();done=true;break;}
      }
    }
    if(!done){$('generation-status').textContent='连接结束，但完成记录未返回。请检查下方本机调用记录。';notice('流已结束但未收到完成记录；可从下方本机调用记录检查已保存的部分结果。','error');}
  }catch(e){$('generation-status').textContent=e.name==='AbortError'?'已停止。已完成的记录可在历史中查看。':'调用失败：'+e.message;notice(e.name==='AbortError'?'已停止本轮生成。':e.message,'error');setTimeout(loadHistory,700);}
  finally{clearInterval(clock);controller=null;setBusy(false);}
}
async function invokeAgent(){
  if(busy)return;
  let p;try{p=payload();}catch(e){notice(e.message,'error');return;}
  controller=new AbortController();setBusy(true,true);
  $('finish').textContent='Agent 运行中';$('generation-status').textContent='正在启动 Agent 回合…';notice('Agent 回合已提交：每一轮都是真实 API 调用，工具在本机执行。');showOutput();
  let done=false;
  try{
    const response=await slateFetch('/api/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...p,max_iterations:4}),signal:controller.signal});
    if(!response.ok){const x=await response.json();throw Error(x.error||'API 请求失败');}
    const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
    while(true){const result=await reader.read();if(result.done)break;buffer+=decoder.decode(result.value,{stream:true});let cut;
      while((cut=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,cut);buffer=buffer.slice(cut+1);if(!line)continue;const event=JSON.parse(line);
        if(event.type==='iteration_start')$('generation-status').textContent=`Agent 第 ${event.iteration}/${event.max_iterations} 轮 · 请求模型…`;
        if(event.type==='model_done')$('generation-status').textContent=`Agent 第 ${event.iteration}/${event.max_iterations} 轮 · 模型已返回（记录 #${String(event.record_id).slice(0,8)}）`;
        if(event.type==='tools_selected')$('generation-status').textContent=`Agent 第 ${event.iteration}/${event.max_iterations} 轮 · 模型选择 ${event.count} 个工具调用，本机执行中…`;
        if(event.type==='tool_result')$('generation-status').textContent=`Agent 第 ${event.iteration}/${event.max_iterations} 轮 · ${event.name} ${event.success?'完成':'失败'} · ${event.characters.toLocaleString()} 字符`;
        if(event.type==='error')throw Error(event.error);
        if(event.type==='done'){done=true;
          renderRecord(event.record);
          const unchanged=sameDraft(p);
          if(unchanged){
            $('messages').value=formatted(event.messages);$('tools').value=formatted(event.tools);
            await refreshDraft('next',`Agent 回合完成（${event.iterations} 轮）；工具结果已由本机执行并加入下一次调用草稿。`+(event.error?` 注意：${event.error}`:''));
            $('generation-status').textContent=`Agent 回合完成 · ${event.iterations} 轮${event.error?' · '+event.error:''}`;
          }else{
            notice('Agent 运行期间编辑区被修改；完整轨迹已保存在本机调用记录，未自动覆盖编辑区。','error');
            $('generation-status').textContent='Agent 回合完成，但编辑区已被修改；请从本机调用记录查看完整轨迹。';
          }
          loadHistory();showOutput();break;}
      }
    }
    if(!done&&!controller?.signal?.aborted)$('generation-status').textContent='Agent 回合中断；已完成轮次保存在本机调用记录。';
  }catch(e){$('generation-status').textContent=e.name==='AbortError'?'已停止 Agent 回合。已完成轮次保存在本机调用记录。':'Agent 回合失败：'+e.message;notice(e.message,'error');setTimeout(loadHistory,700);}
  finally{controller=null;setBusy(false);}
}
async function adopt(){
  if(!activeRecord?.response?.choices?.length)return;
  try{const result=appendResponse(activeRecord,parseEditor('messages','array'));
    if(!result.changed){notice(result.reason);return;}
    $('messages').value=formatted(result.messages);$('adopt').disabled=true;$('adopt').textContent='已加入历史';
    await refreshDraft('next',result.reason);
  }catch(e){notice(e.message,'error');}
}
function openToolDialog(){
  try{const messages=parseEditor('messages','array');const answered=new Set(messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id));
    const calls=messages.flatMap(m=>m.role==='assistant'?m.tool_calls||[]:[]).filter(call=>!answered.has(call.id));
    if(!calls.length)throw Error('没有待回填的工具调用。先生成工具调用，或自行编辑 messages。');
    $('tool-call-id').replaceChildren();
    for(const item of calls){const opt=node('option','',`${item.function?.name||'tool'} · ${item.id||'无 ID'}`);opt.value=item.id||'';$('tool-call-id').append(opt);}
    $('pending-tools').textContent=`还有 ${calls.length} 个调用待回填。按调用 ID 分别填写真实工具结果；网站不会执行命令。`;$('tool-dialog').showModal();
  }catch(e){notice(e.message,'error');}
}
function saveTool(){
  try{const messages=parseEditor('messages','array');const callId=$('tool-call-id').value;if(!callId)throw Error('所选调用没有 ID，无法回填');
    if(messages.some(m=>m.role==='tool'&&m.tool_call_id===callId))throw Error('此工具调用 ID 已回填，不可重复添加');
    messages.push({role:'tool',tool_call_id:callId,content:$('tool-result').value,_origin:'用户手动回填工具结果'});
    $('messages').value=formatted(messages);$('tool-dialog').close();refreshDraft('next','observation 已加入消息；石板已更新下一次调用草稿。');
  }catch(e){notice(e.message,'error');}
}
async function loadHistory(){try{const data=await slateFetch('/api/history').then(r=>r.json());const list=$('history');list.replaceChildren();$('history-total').textContent=data.records.length;
  if(!data.records.length)list.append(node('p','empty','还没有调用记录'));
  for(const item of data.records){const b=node('button',item.id===activeRecord?.id?'active':'');b.type='button';const agentLabel=item.agent?` · Agent 轮 ${item.agent.iteration}/${item.agent.max_iterations}`:'';b.append(node('strong','',item.type==='compaction_draft'?'压缩对照草稿':'推理 · '+(item.model||'')+agentLabel),node('span','',`${item.created_at?.slice(0,19).replace('T',' ')||''} · ${item.prompt_tokens??item.local_tokens??'—'} tokens`));b.addEventListener('click',async()=>{try{const r=await slateFetch('/api/record/'+item.id);if(!r.ok)throw Error('记录读取失败');renderRecord(await r.json());}catch(e){notice(e.message,'error');}});list.append(b);}
}catch(e){notice('历史记录加载失败：'+e.message,'error');}}
function renderComparison(record){
  const box=$('comparison');box.replaceChildren();
  if(record.submitted_call_id)box.append(node('p','meta',`已提交于推理调用 #${record.submitted_call_id.slice(0,8)}；上方调用记录保存了当时的实际 API JSON。`));
  for(const [name,input] of [['压缩前 · 原始轨迹',record.before],['压缩后 · 摘要＋保留原文',record.after]]){
    const panel=node('div');panel.append(node('strong','',name),node('div','meta',input.count==null?'仅 API 消息；序列化 token 未知':`${input.count.toLocaleString()} 本地重建 tokens · ${((input.count/input.context_window)*100).toFixed(3)}% 窗口`),node('pre','',input.prompt||formatted({messages:input.request_messages,tools:input.request_tools})));box.append(panel);
  }
}
function prepareCompaction(){try{
  if(!activeRecord||activeRecord.type!=='inference')throw Error('请先选择一条推理调用作为压缩前轨迹。');
  const original=activeRecord.input_with_local_origins||[];
  const system=original.filter(m=>m.role==='system').map(m=>({...m,_origin:'压缩后保留原系统提示'}));
  const recent=original.filter(m=>m.role!=='system').slice(-2).map(m=>({...m,_origin:'压缩后保留原文 · '+(m._origin||m.role)}));
  const summary={role:'user',content:'【压缩摘要草稿：请在这里准确概括先前轨迹，不能把未发生的工具调用写成事实。】',_origin:'用户编写的压缩摘要'};
  $('messages').value=formatted([...system,summary,...recent]);
  notice('已准备“摘要＋最近两条原文”的草稿。请修改摘要；保存对照后再发起下一次推理。');
}catch(e){notice(e.message,'error');}}
async function compare(){try{if(!activeRecord||activeRecord.type!=='inference')throw Error('请先从下方本机调用记录选择一条推理调用，作为压缩前的快照。');
  const p=payload();const record=await api('/api/compaction',{model:p.model,before_record_id:activeRecord.id,after:p.messages,tools:p.tools,thinking:p.thinking,effort:p.effort});pendingCompaction={id:record.id,signature:JSON.stringify([p.model,p.messages,p.tools,p.thinking,p.effort])};renderComparison(record);notice('压缩对照草稿已保存。继续生成时，新请求会关联这份草稿与实际提交的消息。','good');loadHistory();
}catch(e){notice(e.message,'error');}}
function addUser(){try{const messages=parseEditor('messages','array');messages.push({role:'user',content:$('new-user-text').value,_origin:'用户输入'});$('messages').value=formatted(messages);$('user-dialog').close();$('new-user-text').value='';refreshDraft('next','用户消息已加入历史；石板已更新下一次调用草稿。');}catch(e){notice(e.message,'error');}}
function setPrefix(){try{const messages=parseEditor('messages','array');const text=$('free-prefix').value;
  if(!text)throw Error('请先输入待续写文本');
  const last=messages.at(-1);
  if(last?.role==='assistant'&&last.prefix){last.content=text;last._origin='用户编辑的未完成前缀';}
  else{if(last?.role!=='user')throw Error('自由续写前请让最后一条消息为 user；也可直接编辑 JSON');messages.push({role:'assistant',content:text,prefix:true,_origin:'用户编辑的未完成前缀'});}
  $('messages').value=formatted(messages);$('thinking').value='false';refreshDraft('next','已设置未完成 assistant 前缀；下一次调用走 DeepSeek Beta。');
}catch(e){notice(e.message,'error');}}
async function initialize(){
  $('theme').addEventListener('click',()=>{const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;localStorage.setItem('trajectory-theme',next);$('theme').textContent=next==='dark'?'☀':'☾';});
  const theme=localStorage.getItem('trajectory-theme')||'dark';document.documentElement.dataset.theme=theme;$('theme').textContent=theme==='dark'?'☀':'☾';
  try{const result=await slateFetch('/api/models').then(r=>r.json());modelCatalog=result.models||[];agentTools=result.agent_tools||[];
    const optgroup=node('optgroup');optgroup.label='DeepSeek';
    for(const m of modelCatalog){const option=node('option','',`${m.label}${m.reconstruction?' · 官方参考 token':' · API'}${m.listed===false?' · 当前不可用':''}`);option.value=m.id;option.disabled=!m.configured||m.listed===false;optgroup.append(option);}
    $('model').append(optgroup);
    chooseModel(localStorage.getItem('trajectory-model')||result.default);
    $('model').addEventListener('change',()=>{chooseModel();activeRecord=null;showPreview();});
  }catch(e){notice('模型目录加载失败：'+e.message,'error');return;}
  $('sample-chat').onclick=()=>{sampleChat();showPreview();};$('sample-agent').onclick=()=>{sampleAgent();showPreview();};$('new-session').onclick=()=>{sampleChat();showPreview();};$('preview').onclick=showPreview;$('one-token').onclick=invokeOne;$('generate').onclick=invokeStream;$('agent-run').onclick=invokeAgent;$('stop').onclick=()=>controller?.abort();
  $('adopt').onclick=adopt;$('add-user').onclick=()=>{$('user-dialog').showModal();};$('save-user').onclick=addUser;$('add-tool').onclick=openToolDialog;$('save-tool').onclick=saveTool;$('prepare-compaction').onclick=prepareCompaction;$('compare').onclick=compare;$('set-prefix').onclick=setPrefix;
  $('edit-selection').onclick=openEdit;$('save-edit').onclick=saveEdit;
  $('template-reference-open').onclick=openTemplateReference;
  $('view-mode').value=localStorage.getItem('trajectory-view-mode')||'tokens';
  $('view-mode').onchange=()=>{localStorage.setItem('trajectory-view-mode',$('view-mode').value);renderStoneMode();};
  const font=Number(localStorage.getItem('trajectory-font-size'))||13;$('font-size').value=String(Math.max(10,Math.min(22,font)));
  function updateFont(){const value=$('font-size').value;$('token-card').style.setProperty('--slab-font',value+'px');$('font-size-value').textContent=value;localStorage.setItem('trajectory-font-size',value);}
  $('font-size').oninput=updateFont;updateFont();
  new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)&&!imported&&$('view-mode').value==='tokens')appendMoreTokens();},{rootMargin:'800px'}).observe($('load-sentinel'));
  $('import-open').onclick=()=>{$('import-status').textContent='';$('import-dialog').showModal();};
  $('local-import').onchange=()=>importLocal($('local-import').files[0]);
  $('exit-import').onclick=()=>{imported=null;chooseModel();showPreview();};
  $('messages').addEventListener('input',()=>renderTrajectory());
  sampleChat();loadHistory();
  await showPreview();
}
initialize();
