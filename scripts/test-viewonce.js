// View-once messages E2E (see AGENTS.md verification conventions).
// Expects the dev server (PORT, default 3210) plus the dev Postgres, like
// scripts/test-stories.js.
const { Client } = require('pg');
const BASE='http://localhost:3210';
// The window is a clock, so the test moves it in the database instead of
// waiting 30 real seconds (the same trick scripts/test-stories.js uses for the
// 24h story reaper).
const PGC={host:process.env.PGHOST||'localhost',port:Number(process.env.PGPORT||5432),user:process.env.PGUSER||'campfire',password:process.env.PGPASSWORD||'localdevpass1234',database:process.env.PGDATABASE||'campfire'};
let fails=0; const ok=(c,l,e)=>{if(c)console.log('  ✓ '+l);else{fails++;console.log('  ✗ '+l+(e!==undefined?'  '+JSON.stringify(e).slice(0,260):''));}};
async function req(m,p,{token,body,form}={}){const h={};if(token)h.Authorization='Bearer '+token;let pl;if(form)pl=form;else if(body!==undefined){h['Content-Type']='application/json';pl=JSON.stringify(body);}const r=await fetch(BASE+p,{method:m,headers:h,body:pl});let d=null;try{d=await r.json();}catch{}return{status:r.status,data:d};}
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGNgGAWDHjAyMDD8J1czIyMjA1KQEUwGAGZ3A0FyYw0eAAAAAElFTkSuQmCC','base64');
(async()=>{
  const tag=Date.now().toString(36).slice(-5);
  const A=await req('POST','/api/register',{body:{username:'wa'+tag,displayName:'VO A',password:'passw0rd!x'}});
  const B=await req('POST','/api/register',{body:{username:'wb'+tag,displayName:'VO B',password:'passw0rd!x'}});
  const C=await req('POST','/api/register',{body:{username:'wc'+tag,displayName:'VO C',password:'passw0rd!x'}});
  const D=await req('POST','/api/register',{body:{username:'wd'+tag,displayName:'VO D',password:'passw0rd!x'}});
  const ta=A.data.token,tb=B.data.token,tc=C.data.token,td=D.data.token;
  for (const uname of ['wb'+tag,'wc'+tag]) { await req('POST','/api/friends',{token:ta,body:{username:uname}}); }
  await req('POST','/api/friends/'+A.data.user.id+'/accept',{token:tb});
  await req('POST','/api/friends/'+A.data.user.id+'/accept',{token:tc});

  console.log('\n[1] upload + send to two friends → separate DMs');
  const fd=new FormData(); fd.append('file',new Blob([PNG],{type:'image/png'}),'vo.png');
  let r=await req('POST','/api/upload/viewonce',{token:ta,form:fd});
  ok(r.status===200 && /^\/uploads\/viewonce\//.test(r.data.url),'view-once upload lands in viewonce/',r.data);
  const url=r.data.url;
  r=await req('POST','/api/dm/viewonce',{token:ta,body:{url,mime:r.data.mime,kind:'image',caption:'look',userIds:[B.data.user.id,C.data.user.id]}});
  ok(r.status===200 && r.data.sent===2,'sent to both friends',r.data);
  const threads=r.data.threadIds;
  ok(new Set(threads).size===2,'two separate 1:1 threads');
  r=await req('POST','/api/dm/viewonce',{token:ta,body:{url,mime:'image/png',kind:'image',userIds:[D.data.user.id]}});
  ok(r.status===403,'non-friends are skipped',r.data);

  console.log('\n[2] the media is locked until opened');
  ok((await fetch(BASE+url)).status===403,'bare URL is refused');
  ok((await fetch(BASE+url+'?t=deadbeef.99999999999999.abc')).status===403,'forged ticket refused');
  const key=url.split('?')[0].replace('/uploads/','');
  const listB=(await req('GET','/api/dms/'+threads[0]+'/messages?limit=10',{token:tb})).data;
  const voMsg=listB.messages.find(m=>m.viewOnce);
  ok(!!voMsg,'recipient sees the view-once message',listB.messages.length);
  ok(voMsg.viewOnce.state==='unopened' && voMsg.viewOnce.kind==='image','state + shape exposed',voMsg.viewOnce);
  ok(voMsg.attachments.length===0,'no attachment URL leaks before opening',voMsg.attachments);
  ok(JSON.stringify(voMsg).indexOf(key)===-1,'the storage key is nowhere in the payload');

  console.log('\n[3] open → view → replay → consumed');
  r=await req('POST','/api/dm/'+voMsg.id+'/viewonce/open',{token:tb});
  ok(r.status===200 && /[?&]t=/.test(r.data.url),'recipient gets a signed ticket',{s:r.status, u:(r.data.url||'').slice(0,60)});
  ok(Number(r.data.replayWindowMs)>0,'the open answer carries the window length',r.data.replayWindowMs);
  const signed=r.data.url;
  ok((await fetch(BASE+signed)).status===200,'signed URL serves the media');
  ok((await fetch(BASE+signed+'x')).status===403,'tampered signature refused');
  r=await req('POST','/api/dm/'+voMsg.id+'/viewonce/open',{token:ta});
  ok(r.status===403 && r.data.error==='own_message','the sender cannot open their own view-once');
  r=await req('POST','/api/dm/'+voMsg.id+'/viewonce/open',{token:td});
  ok(r.status===404 || r.status===403,'a stranger cannot open it',r.status);
  r=await req('POST','/api/dm/'+voMsg.id+'/viewonce/consume',{token:tb});
  ok(r.status===200 && r.data.state==='replayable' && !r.data.deleted,'first close leaves the replay',r.data.state);
  const until=Number(r.data.replayUntil)||0;
  ok(until>Date.now()+20000 && until<=Date.now()+31000,'and puts the replay on a ~30s clock',until-Date.now());
  ok((await fetch(BASE+url)).status===403,'still locked at rest');
  const seen=async(tok)=>((await req('GET','/api/dms/'+threads[0]+'/messages?limit=10',{token:tok})).data.messages.find(m=>m.id===voMsg.id)||{}).viewOnce||{};
  const voB=await seen(tb);
  ok(voB.state==='replayable' && Number(voB.replayUntil)===until,'the reader sees the window',voB);
  const voA=await seen(ta);
  ok(Number(voA.replayUntil)===until,'and the sender sees it too, so both cards run one countdown',voA);
  r=await req('POST','/api/dm/'+voMsg.id+'/viewonce/open',{token:tb});
  ok(r.status===200,'replay can be opened inside the window');
  r=await req('POST','/api/dm/'+voMsg.id+'/viewonce/consume',{token:tb});
  ok(r.status===200 && r.data.state==='consumed' && r.data.deleted===true,'second close consumes + deletes',r.data.state);
  const after=(await req('GET','/api/dms/'+threads[0]+'/messages?limit=10',{token:tb})).data.messages.find(m=>m.id===voMsg.id);
  ok(after.viewOnce.state==='consumed' && after.attachments.length===0,'tombstone only, no media',after.viewOnce);
  r=await req('POST','/api/dm/'+voMsg.id+'/viewonce/open',{token:tb});
  ok(r.status===403 && r.data.error==='already_opened','cannot reopen after consume',r.data);

  console.log('\n[4] unopened items do not expire');
  const other=(await req('GET','/api/dms/'+threads[1]+'/messages?limit=10',{token:tc})).data.messages.find(m=>m.viewOnce);
  ok(!!other && other.viewOnce.state==='unopened','the second friend still has it unopened');
  ok(Number(other.viewOnce.replayUntil)===0,'and has no window open yet',other.viewOnce);
  r=await req('POST','/api/dm/'+other.id+'/viewonce/open',{token:tc});
  ok(r.status===200,'and can still open it (no expiry clocks)');
  await req('POST','/api/dm/'+other.id+'/viewonce/consume',{token:tc});

  console.log('\n[5] a replay window nobody comes back for');
  const fdLate=new FormData(); fdLate.append('file',new Blob([PNG],{type:'image/png'}),'late.png');
  const lateUp=(await req('POST','/api/upload/viewonce',{token:ta,form:fdLate})).data;
  r=await req('POST','/api/dm/viewonce',{token:ta,body:{url:lateUp.url,mime:lateUp.mime,kind:'image',caption:'late',userIds:[B.data.user.id]}});
  ok(r.status===200,'a third view-once is on its way',r.data);
  const lateThread=r.data.threadIds[0];
  // The B thread already carries the earlier item plus this one, so pick the
  // card by its own caption rather than "the view-once message".
  const lateList=async()=>((await req('GET','/api/dms/'+lateThread+'/messages?limit=20',{token:tb})).data.messages.find(m=>m.viewOnce&&m.content==='late')||{});
  const lateMsg=await lateList();
  ok(!!lateMsg.id,'the recipient has the new card',lateMsg.viewOnce);
  const lateOpen=await req('POST','/api/dm/'+lateMsg.id+'/viewonce/open',{token:tb});
  const lateSigned=String(lateOpen.data.url||'');
  ok((await fetch(BASE+lateSigned)).status===200,'first view served');
  await req('POST','/api/dm/'+lateMsg.id+'/viewonce/consume',{token:tb});
  // Lapse the window by a second and ask for the replay anyway.
  const dbc=new Client(PGC); await dbc.connect();
  await dbc.query('UPDATE dm_messages SET view_once_replay_until = $1 WHERE id = $2',[Date.now()-1000,lateMsg.id]);
  await dbc.end();
  const lapsed=await lateList();
  ok(lapsed.viewOnce.state==='consumed','a lapsed window READS as opened (masked at read time)',lapsed.viewOnce);
  r=await req('POST','/api/dm/'+lateMsg.id+'/viewonce/open',{token:tb});
  ok(r.status===403&&r.data.error==='replay_expired','and the replay is refused as too late',r.data);
  // The bytes outlive the window by a whole ticket lifetime so a replay that
  // started in the last second of the window can finish watching; backdate past
  // that and let the sweeper collect them.
  const dbc2=new Client(PGC); await dbc2.connect();
  await dbc2.query('UPDATE dm_messages SET view_once_replay_until = $1 WHERE id = $2',[Date.now()-11*60*1000,lateMsg.id]);
  const t0=Date.now();
  let reaped=false;
  while (Date.now()-t0 < 45000) {
    await new Promise((s)=>setTimeout(s,1500));
    const row=(await dbc2.query('SELECT view_once_state FROM dm_messages WHERE id = $1',[lateMsg.id])).rows[0];
    const atts=(await dbc2.query('SELECT count(*)::int AS n FROM dm_attachments WHERE message_id = $1',[lateMsg.id])).rows[0];
    if (row && row.view_once_state==='consumed' && atts && atts.n===0) { reaped=true; break; }
  }
  await dbc2.end();
  ok(reaped,'the sweeper closes a window nobody replayed and takes the bytes');
  ok((await fetch(BASE+lateSigned)).status!==200,'and the signed URL stops serving them');

  console.log('\n[6] validation');
  r=await req('POST','/api/dm/viewonce',{token:ta,body:{url:'/uploads/files/abc.png',mime:'image/png',userIds:[B.data.user.id]}});
  ok(r.status===400,'files/ URLs are refused (must be viewonce/)',r.data);
  r=await req('POST','/api/dm/viewonce',{token:ta,body:{url,mime:'image/png',userIds:[]}});
  ok(r.status===400,'needs at least one recipient',r.data);
  const fd2=new FormData(); fd2.append('file',new Blob([Buffer.from('hello')],{type:'text/plain'}),'n.txt');
  r=await req('POST','/api/upload/viewonce',{token:ta,form:fd2});
  ok(r.status===400,'non-media rejected for view-once',r.data);

  console.log('\n[7] story → private view-once DM (individual recipients)');
  const fs3=new FormData(); fs3.append('file',new Blob([PNG],{type:'image/png'}),'story.png');
  const stUp=(await req('POST','/api/upload',{token:ta,form:fs3})).data;
  ok(/^\/uploads\/files\//.test(stUp.url||''),'story media goes to files/',stUp.url);
  const st=((await req('POST','/api/stories',{token:ta,body:{url:stUp.url,mime:stUp.mime,kind:'image',caption:'sunset',friends:true,durationMs:5000}})).data||{}).story;
  ok(!!(st&&st.id),'story posted',!!st);
  r=await req('POST','/api/dm/viewonce',{token:ta,body:{storyId:st.id,userIds:[B.data.user.id]}});
  ok(r.status===200&&r.data.sent===1,'author sends their live story to a friend as a view-once DM',r.data);
  const stThread=r.data.threadIds[0];
  const stMsgs=(await req('GET','/api/dms/'+stThread+'/messages?limit=20',{token:tb})).data.messages;
  // The DM thread is reused across sends, so pick THIS story's card by caption.
  const voStory=[...stMsgs].reverse().find(m=>m.viewOnce&&m.content==='sunset');
  ok(!!voStory&&voStory.viewOnce.state==='unopened'&&voStory.viewOnce.kind==='image','recipient gets an unopened view-once card',voStory&&voStory.viewOnce);
  ok(voStory.attachments.length===0&&JSON.stringify(voStory).indexOf('viewonce/')===-1,'the gated copy is never exposed in the payload',voStory.attachments);
  const stStatus=(await fetch(BASE+stUp.url)).status;
  ok(stStatus===200||stStatus===423,'the story itself is untouched (files/ copy still there)',stStatus);
  r=await req('POST','/api/dm/'+voStory.id+'/viewonce/open',{token:tb});
  const copyUrl=String(r.data&&r.data.url||'');
  ok(r.status===200&&/^\/uploads\/viewonce\//.test(copyUrl),'opens through the viewonce/ gate (bytes copied per recipient)',copyUrl.slice(0,64));
  ok((await fetch(BASE+copyUrl)).status===200,'the copy serves with its ticket');
  ok((await fetch(BASE+copyUrl.split('?')[0])).status===403,'and is locked without one');
  await req('POST','/api/dm/'+voStory.id+'/viewonce/consume',{token:tb});
  const stGone=await req('POST','/api/dm/'+voStory.id+'/viewonce/consume',{token:tb});
  ok(stGone.status===200&&stGone.data.state==='consumed'&&stGone.data.deleted===true,'replay spent → media deleted, story unaffected',stGone.data);
  const copyKey=copyUrl.split('?')[0];
  const copyStatus=(await fetch(BASE+copyKey+'?t='+copyUrl.split('?t=')[1])).status;
  ok(copyStatus!==200,'the consumed copy no longer serves',copyStatus);
  r=await req('POST','/api/dm/viewonce',{token:tb,body:{storyId:st.id,userIds:[C.data.user.id]}});
  ok(r.status===404,'only the author can send a story privately',r.data);
  r=await req('POST','/api/dm/viewonce',{token:ta,body:{storyId:'nope',userIds:[B.data.user.id]}});
  ok(r.status===404,'unknown story refused',r.data);
  r=await req('POST','/api/dm/viewonce',{token:ta,body:{storyId:st.id,userIds:[D.data.user.id]}});
  ok(r.status===403,'non-friends are still skipped for story sends',r.data);

  console.log(fails?`\nFAILURES: ${fails}\n`:'\nVIEW-ONCE API TESTS PASSED\n');
  process.exit(fails?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
