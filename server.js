require('dotenv').config();
const express=require('express');
const path=require('path');
const crypto=require('crypto');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const helmet=require('helmet');
const cors=require('cors');
const rateLimit=require('express-rate-limit');
const multer=require('multer');
const {Pool}=require('pg');
const {z}=require('zod');

const app=express();
const PORT=Number(process.env.PORT||3000);
const JWT_SECRET=process.env.JWT_SECRET||'dev-only-change-me';
const pool=new Pool({connectionString:process.env.DATABASE_URL||'postgresql://postgres:postgres@localhost:5432/continuityai'});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:Number(process.env.MAX_UPLOAD_MB||5)*1024*1024},fileFilter:(req,file,cb)=>{const ok=['.txt','.md','.markdown','.csv','.json'].includes(path.extname(file.originalname).toLowerCase());cb(ok?null:new Error('Unsupported file type'),ok)}});
app.use(helmet({contentSecurityPolicy:false}));
app.use(cors({origin:process.env.CORS_ORIGIN||true,credentials:false}));
app.use(express.json({limit:'1mb'}));
app.use(rateLimit({windowMs:15*60*1000,max:300,standardHeaders:true,legacyHeaders:false}));

const demoEmail='demo@continuityai.app', demoPassword='Demo@123456';
function tokenFor(u){return jwt.sign({sub:u.id,email:u.email},JWT_SECRET,{expiresIn:'12h'});}
function auth(req,res,next){try{const h=req.headers.authorization||'';if(!h.startsWith('Bearer '))return res.status(401).json({error:'Authentication required'});req.user=jwt.verify(h.slice(7),JWT_SECRET);next()}catch(e){return res.status(401).json({error:'Invalid or expired session'})}}
function err(res,e,code=400){console.error(e);return res.status(code).json({error:e.publicMessage||e.message||'Request failed'});}
async function q(text,params=[]){return pool.query(text,params)}
async function log(projectId,userId,action,details={}){await q('INSERT INTO audit_logs(project_id,user_id,action,details) VALUES($1,$2,$3,$4)',[projectId,userId,action,details]);}

const itemSchema=z.object({type:z.string().min(1),title:z.string().min(1),summary:z.string().default(''),confidence:z.number().min(0).max(1),owner:z.string().nullable().optional(),due_date:z.string().nullable().optional(),severity:z.string().nullable().optional(),impact:z.string().nullable().optional(),mitigation:z.string().nullable().optional(),evidence:z.array(z.object({sourceId:z.string(),location:z.string(),quote:z.string().min(1)})).min(1)});
const aiSchema=z.object({items:z.array(itemSchema),gaps:z.array(z.string()).default([])});

function chunksForSource(s){return s.content.split(/\r?\n/).map((x,i)=>({location:`line ${i+1}`,content:x.trim()})).filter(x=>x.content).slice(0,400)}



function demoExtract(sources) {
  const items = [];
  const gaps = [];

  const add = (type, title, summary, source, line, extra = {}) => {
    items.push({
      type,
      title,
      summary,
      confidence: 0.85,
      owner: extra.owner || null,
      due_date: extra.due_date || null,
      severity: extra.severity || null,
      impact: extra.impact || null,
      mitigation: extra.mitigation || null,
      evidence: [{
        sourceId: source.id,
        location: line.location,
        quote: line.content.slice(0, 500)
      }]
    });
  };

  const seen = new Set();

  for (const source of sources) {
    const lines = chunksForSource(source);

    for (const line of lines) {
      const text = line.content;
      const lower = text.toLowerCase();

      // Ignore very short or irrelevant lines.
      if (text.length < 8) continue;

      // Decisions
      if (
        /\b(decision|decided|agreed|we will use|we will not|chosen|selected|approved|adopted)\b/i.test(text)
      ) {
        add(
          'decision',
          'Project decision',
          text,
          source,
          line
        );
      }

      // Tasks with explicit status.
      if (
        /\b(done|completed|pending|in progress|in-progress|not started|assigned|ongoing)\b/i.test(text) &&
        /\b(task|authentication|database|security|deployment|testing|integration|design|development|backup|email|payment|refund|monitoring|documentation|api|frontend|backend)\b/i.test(text)
      ) {
        const ownerMatch = text.match(/\b(?:owner|assigned to|assignee)\s*[:=-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);

        add(
          'task',
          'Project task',
          text,
          source,
          line,
          { owner: ownerMatch ? ownerMatch[1] : null }
        );
      }

      // Risks
      if (
        /\b(risk|risky|may fail|could fail|vulnerable|unverified|not tested|not configured|not connected|not approved|incomplete|uncertain|potential issue)\b/i.test(text)
      ) {
        add(
          'risk',
          'Identified project risk',
          text,
          source,
          line,
          {
            severity: /\b(critical|high|major)\b/i.test(text) ? 'high' : 'medium',
            impact: 'Requires review by the incoming project owner.'
          }
        );
      }

      // Blockers
      if (
        /\b(blocked|blocking|waiting for|waiting on|cannot proceed|unable to proceed|depends on approval)\b/i.test(text)
      ) {
        add(
          'blocker',
          'Project blocker',
          text,
          source,
          line,
          { severity: 'high' }
        );
      }

      // Milestones and dates
      if (
        /\b(launch|release|beta|deadline|milestone|delivery|go-live|review)\b/i.test(text) &&
        /\b\d{1,2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:next week|next month|end of month)\b/i.test(text)
      ) {
        const dateMatch = text.match(/\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i);

        add(
          'milestone',
          'Project milestone',
          text,
          source,
          line,
          { due_date: dateMatch ? dateMatch[0] : null }
        );
      }

      // Open questions and knowledge gaps.
      if (
        /\?/.test(text) ||
        /\b(TODO|TBD|not decided|not recorded|unknown|who owns|owner not assigned|needs confirmation|not yet determined|awaiting confirmation)\b/i.test(text)
      ) {
        const gap = text.replace(/^[-*\s]+/, '');

        if (!seen.has(gap)) {
          gaps.push(gap);
          seen.add(gap);
        }

        add(
          'question',
          'Open project question',
          text,
          source,
          line
        );
      }
    }
  }

  return {
    items,
    gaps: [...new Set(gaps)].slice(0, 30)
  };
}



async function aiExtract(sources){
 if(!process.env.AI_API_KEY)return demoExtract(sources);
 const sourceText=sources.map(s=>`SOURCE_ID: ${s.id}\nSOURCE: ${s.name}\n${s.content.slice(0,12000)}`).join('\n\n---\n\n');
 const system=`You are ContinuityAI's evidence-grounded extraction engine. Extract only facts supported by the supplied sources. Never invent. Every item must include at least one exact supporting quote and sourceId. Detect changes/conflicts only when supported. Return JSON matching {items:[{type,title,summary,confidence,owner,due_date,severity,impact,mitigation,evidence:[{sourceId,location,quote}]}],gaps:[string]}. confidence 0..1. Keep quotes short and exact.`;
 const r=await fetch(`${process.env.AI_BASE_URL||'https://api.openai.com/v1'}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${process.env.AI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.AI_MODEL||'gpt-4.1-mini',temperature:0,response_format:{type:'json_object'},messages:[{role:'system',content:system},{role:'user',content:sourceText}]})});
 if(!r.ok)throw Object.assign(new Error(`AI provider returned ${r.status}`),{publicMessage:'AI extraction failed. Please retry or use Demo Project.'});
 const data=await r.json();const parsed=JSON.parse(data.choices?.[0]?.message?.content||'{}');return aiSchema.parse(parsed);
}
async function requireProject(req,res,next){const id=req.params.id;const r=await q('SELECT p.* FROM projects p JOIN project_members pm ON pm.project_id=p.id WHERE p.id=$1 AND pm.user_id=$2',[id,req.user.sub]);if(!r.rowCount)return res.status(404).json({error:'Project not found'});req.project=r.rows[0];next()}
function health(stats){const evidence=Number(stats.items)?Math.min(100,Math.round(Number(stats.evidenced)/Number(stats.items)*100)):100;let score=100;score-=Math.min(25,Number(stats.open_conflicts)*8);score-=Math.min(20,Number(stats.open_gaps)*4);score-=Math.min(15,Number(stats.unverified)*2);score-=Math.min(10,Number(stats.unassigned)*2);score=Math.max(0,Math.round((score+evidence)/2));return {score,evidence_coverage:evidence,open_conflicts:Number(stats.open_conflicts),knowledge_gaps:Number(stats.open_gaps),unverified:Number(stats.unverified),unassigned:Number(stats.unassigned)};}
async function projectBundle(id){
 const [items,ev,conf,gaps,audit,sources]=await Promise.all([q('SELECT * FROM knowledge_items WHERE project_id=$1 ORDER BY created_at DESC',[id]),q(`SELECT ke.*,s.name source_name FROM knowledge_evidence ke JOIN sources s ON s.id=ke.source_id JOIN knowledge_items k ON k.id=ke.knowledge_id WHERE k.project_id=$1`,[id]),q('SELECT * FROM conflicts WHERE project_id=$1 ORDER BY created_at DESC',[id]),q('SELECT * FROM knowledge_gaps WHERE project_id=$1 ORDER BY created_at DESC',[id]),q('SELECT a.*,u.display_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.project_id=$1 ORDER BY a.created_at DESC LIMIT 50',[id]),q('SELECT id,name,source_type,origin,status,created_at FROM sources WHERE project_id=$1 ORDER BY created_at',[id])]);
 const evidenceBy={};ev.rows.forEach(e=>(evidenceBy[e.knowledge_id]??=[]).push(e));items.rows.forEach(i=>i.evidence=evidenceBy[i.id]||[]);
 const s=items.rows;const stats={items:s.length,evidenced:s.filter(i=>i.evidence.length).length,open_conflicts:conf.rows.filter(c=>c.status==='open').length,open_gaps:gaps.rows.filter(g=>g.status==='open').length,unverified:s.filter(i=>i.status!=='verified').length,unassigned:s.filter(i=>!i.owner).length};
 return {items:s,conflicts:conf.rows,gaps:gaps.rows,audit:audit.rows,sources:sources.rows,health:health(stats)};
}

app.get('/health',(req,res)=>res.json({ok:true,service:'continuityai',time:new Date().toISOString()}));
app.post('/api/auth/login',rateLimit({windowMs:10*60*1000,max:20}),async(req,res)=>{try{const {email,password}=req.body||{};if(!email||!password)return res.status(400).json({error:'Email and password are required'});const r=await q('SELECT * FROM users WHERE lower(email)=lower($1)',[email]);if(!r.rowCount||!(await bcrypt.compare(password,r.rows[0].password_hash)))return res.status(401).json({error:'Invalid credentials'});const u=r.rows[0];res.json({token:tokenFor(u),user:{id:u.id,email:u.email,name:u.display_name}})}catch(e){err(res,e,500)}});
app.post('/api/auth/demo',async(req,res)=>{try{let r=await q('SELECT * FROM users WHERE email=$1',[demoEmail]);if(!r.rowCount){const hash=await bcrypt.hash(demoPassword,12);r=await q('INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING *',[demoEmail,hash,'Demo Reviewer']);}const u=r.rows[0];res.json({token:tokenFor(u),user:{id:u.id,email:u.email,name:u.display_name}})}catch(e){err(res,e,500)}});
app.get('/api/projects',auth,async(req,res)=>{try{const r=await q(`SELECT p.*,COUNT(DISTINCT s.id)::int source_count,COUNT(DISTINCT k.id)::int knowledge_count,COUNT(DISTINCT c.id) FILTER(WHERE c.status='open')::int open_conflicts FROM projects p JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$1 LEFT JOIN sources s ON s.project_id=p.id LEFT JOIN knowledge_items k ON k.project_id=p.id LEFT JOIN conflicts c ON c.project_id=p.id GROUP BY p.id ORDER BY p.updated_at DESC`,[req.user.sub]);res.json({projects:r.rows})}catch(e){err(res,e,500)}});
app.post('/api/projects',auth,async(req,res)=>{try{const {name,description='',role='Incoming Engineer'}=req.body||{};if(!name||name.length>120)return res.status(400).json({error:'Project name is required and must be under 120 characters'});const r=await q('INSERT INTO projects(name,description,role,created_by) VALUES($1,$2,$3,$4) RETURNING *',[name.trim(),String(description).slice(0,1000),role,req.user.sub]);const p=r.rows[0];await q('INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)',[p.id,req.user.sub,'owner']);await log(p.id,req.user.sub,'project.created',{name:p.name});res.status(201).json({project:p})}catch(e){err(res,e,500)}});
app.get('/api/projects/:id',auth,requireProject,async(req,res)=>{try{res.json({project:req.project,bundle:await projectBundle(req.project.id)})}catch(e){err(res,e,500)}});
app.post('/api/projects/:id/sources',auth,requireProject,upload.array('files',20),async(req,res)=>{try{const files=req.files||[];if(!files.length)return res.status(400).json({error:'No files supplied'});for(const f of files){const content=f.buffer.toString('utf8');const ins=await q('INSERT INTO sources(project_id,name,source_type,content,origin) VALUES($1,$2,$3,$4,$5) RETURNING id',[req.project.id,f.originalname,path.extname(f.originalname).slice(1).toLowerCase()||'text',content,'upload']);const sid=ins.rows[0].id;for(const c of chunksForSource({content}))await q('INSERT INTO source_chunks(source_id,location,content) VALUES($1,$2,$3)',[sid,c.location,c.content]);await log(req.project.id,req.user.sub,'source.added',{source:f.originalname});}res.status(201).json(await projectBundle(req.project.id))}catch(e){err(res,e,400)}});

app.delete('/api/projects/:id/sources/:sourceId',auth,requireProject,async(req,res)=>{
  const client=await pool.connect();

  try{
    await client.query('BEGIN');

    const source=await client.query(
      'SELECT * FROM sources WHERE id=$1 AND project_id=$2',
      [req.params.sourceId,req.project.id]
    );

    if(!source.rowCount){
      await client.query('ROLLBACK');
      return res.status(404).json({error:'Source not found'});
    }

    const s=source.rows[0];

    // Protect verified knowledge from silent destruction.
    const verified=await client.query(`
      SELECT DISTINCT k.id,k.title
      FROM knowledge_items k
      JOIN knowledge_evidence ke ON ke.knowledge_id=k.id
      WHERE ke.source_id=$1
        AND k.project_id=$2
        AND k.status='verified'
    `,[s.id,req.project.id]);

    if(verified.rowCount){
      await client.query('ROLLBACK');

      return res.status(409).json({
        error:`This source supports ${verified.rowCount} verified knowledge item${verified.rowCount===1?'':'s'}. Verify another source before removing it.`,
        protectedItems:verified.rows.map(x=>x.title)
      });
    }

    // Find unverified knowledge supported by this source.
    const affected=await client.query(`
      SELECT DISTINCT k.id,k.title
      FROM knowledge_items k
      JOIN knowledge_evidence ke ON ke.knowledge_id=k.id
      WHERE ke.source_id=$1
        AND k.project_id=$2
        AND k.status='unverified'
    `,[s.id,req.project.id]);

    const affectedIds=affected.rows.map(x=>x.id);

    // Remove evidence belonging to this source.
    await client.query(
      'DELETE FROM knowledge_evidence WHERE source_id=$1',
      [s.id]
    );

    // Remove knowledge items that now have no evidence.
    if(affectedIds.length){
      const remaining=await client.query(`
        SELECT k.id
        FROM knowledge_items k
        WHERE k.id = ANY($1::uuid[])
          AND NOT EXISTS (
            SELECT 1
            FROM knowledge_evidence ke
            WHERE ke.knowledge_id=k.id
          )
      `,[affectedIds]);

      const removableIds=remaining.rows.map(x=>x.id);

      if(removableIds.length){
        await client.query(
          'DELETE FROM conflicts WHERE knowledge_id = ANY($1::uuid[])',
          [removableIds]
        );

        await client.query(
          'DELETE FROM knowledge_items WHERE id = ANY($1::uuid[])',
          [removableIds]
        );
      }
    }

    // Remove source chunks and source itself.
    await client.query(
      'DELETE FROM source_chunks WHERE source_id=$1',
      [s.id]
    );

    await client.query(
      'DELETE FROM sources WHERE id=$1 AND project_id=$2',
      [s.id,req.project.id]
    );

    await client.query(
      'UPDATE projects SET version=version+1,updated_at=now() WHERE id=$1',
      [req.project.id]
    );

    await client.query(
      `INSERT INTO audit_logs(project_id,user_id,action,details)
       VALUES($1,$2,$3,$4)`,
      [
        req.project.id,
        req.user.sub,
        'source.removed',
        {
          sourceId:s.id,
          source:s.name,
          removedKnowledge:affected.rows.map(x=>x.title)
        }
      ]
    );

    await client.query('COMMIT');

    res.json({
      ok:true,
      message:`${s.name} removed successfully`,
      removedKnowledge:affected.rows.map(x=>x.title)
    });

  }catch(e){
    await client.query('ROLLBACK');
    err(res,e,400);
  }finally{
    client.release();
  }
});


app.post('/api/projects/:id/analyze',auth,requireProject,async(req,res)=>{try{const src=await q('SELECT * FROM sources WHERE project_id=$1 ORDER BY created_at',[req.project.id]);if(!src.rowCount)return res.status(400).json({error:'Add at least one source before analysis'});await q("UPDATE sources SET status='processing',updated_at=now() WHERE project_id=$1",[req.project.id]);let extracted;try{extracted=await aiExtract(src.rows)}catch(e){await q("UPDATE sources SET status='ready',updated_at=now() WHERE project_id=$1",[req.project.id]);return err(res,e,502)}
  // Keep existing knowledge; only replace unverified extraction records for a clean re-analysis.
  await q('DELETE FROM knowledge_evidence WHERE knowledge_id IN (SELECT id FROM knowledge_items WHERE project_id=$1 AND status=\'unverified\')',[req.project.id]);
  await q("DELETE FROM knowledge_items WHERE project_id=$1 AND status='unverified'",[req.project.id]);
  const sourceIds=new Set(src.rows.map(s=>s.id));
  for(const item of extracted.items){const safeEv=item.evidence.filter(e=>sourceIds.has(e.sourceId));if(!safeEv.length)continue;const kr=await q(`INSERT INTO knowledge_items(project_id,type,title,summary,status,confidence,owner,due_date,severity,impact,mitigation) VALUES($1,$2,$3,$4,'unverified',$5,$6,$7,$8,$9,$10) RETURNING id`,[req.project.id,item.type,item.title,item.summary||'',item.confidence,item.owner||null,item.due_date||null,item.severity||null,item.impact||null,item.mitigation||null]);for(const e of safeEv)await q('INSERT INTO knowledge_evidence(knowledge_id,source_id,location,quote) VALUES($1,$2,$3,$4)',[kr.rows[0].id,e.sourceId,e.location,e.quote]);}
  for(const g of extracted.gaps.slice(0,30)){const exists=await q("SELECT 1 FROM knowledge_gaps WHERE project_id=$1 AND title=$2 AND status='open'",[req.project.id,g]);if(!exists.rowCount)await q('INSERT INTO knowledge_gaps(project_id,title) VALUES($1,$2)',[req.project.id,g.slice(0,300)]);}
  await detectConflicts(req.project.id);await q("UPDATE sources SET status='processed',updated_at=now() WHERE project_id=$1",[req.project.id]);await q('UPDATE projects SET version=version+1,updated_at=now() WHERE id=$1',[req.project.id]);await log(req.project.id,req.user.sub,'project.analyzed',{mode:process.env.AI_API_KEY?'ai':'demo-fallback',items:extracted.items.length});res.json(await projectBundle(req.project.id));
 }catch(e){err(res,e,500)}});
async function detectConflicts(projectId){const items=(await q('SELECT * FROM knowledge_items WHERE project_id=$1 ORDER BY created_at',[projectId])).rows;for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){const a=items[i],b=items[j];if(a.type!==b.type)continue;const dateConflict=a.due_date&&b.due_date&&a.due_date.toLowerCase()!==b.due_date.toLowerCase();const statusConflict=/complete|done/i.test(a.summary+a.title)&&/pending|blocked|unresolved|not/i.test(b.summary+b.title)||/complete|done/i.test(b.summary+b.title)&&/pending|blocked|unresolved|not/i.test(a.summary+a.title);if(dateConflict||statusConflict){const exists=await q('SELECT 1 FROM conflicts WHERE project_id=$1 AND ((knowledge_id=$2) OR (knowledge_id=$3)) AND status=\'open\'',[projectId,a.id,b.id]);if(!exists.rowCount)await q('INSERT INTO conflicts(project_id,knowledge_id,title,previous_value,new_value) VALUES($1,$2,$3,$4,$5)',[projectId,a.id,`${a.title} may conflict with newer evidence`,{title:a.title,summary:a.summary,due_date:a.due_date},{title:b.title,summary:b.summary,due_date:b.due_date}]);}}}
app.get('/api/projects/:id/knowledge',auth,requireProject,async(req,res)=>{try{const b=await projectBundle(req.project.id);const s=(req.query.search||'').toLowerCase();const type=req.query.type;if(s)b.items=b.items.filter(i=JSON.stringify(i).toLowerCase().includes(s));if(type)b.items=b.items.filter(i=>i.type.toLowerCase()===type.toLowerCase());res.json({items:b.items})}catch(e){err(res,e,500)}});
app.get('/api/projects/:id/conflicts',auth,requireProject,async(req,res)=>{try{res.json({conflicts:(await projectBundle(req.project.id)).conflicts})}catch(e){err(res,e,500)}});
app.post('/api/conflicts/:id/resolve',auth,async(req,res)=>{try{const {resolution,note=''}=req.body||{};if(!['accept_previous','accept_new','manual','defer'].includes(resolution))return res.status(400).json({error:'Invalid resolution'});const r=await q('SELECT c.* FROM conflicts c JOIN project_members pm ON pm.project_id=c.project_id AND pm.user_id=$2 WHERE c.id=$1',[req.params.id,req.user.sub]);if(!r.rowCount)return res.status(404).json({error:'Conflict not found'});const c=r.rows[0];if(resolution==='defer')return res.json({ok:true,conflict:c});await q("UPDATE conflicts SET status='resolved',resolution=$1,resolved_by=$2,resolved_at=now() WHERE id=$3",[resolution+': '+note,req.user.sub,c.id]);if(c.knowledge_id)await q("UPDATE knowledge_items SET status='verified',verified_by=$1,verified_at=now(),updated_at=now() WHERE id=$2",[req.user.sub,c.knowledge_id]);await log(c.project_id,req.user.sub,'conflict.resolved',{conflictId:c.id,resolution,note});res.json({ok:true})}catch(e){err(res,e,500)}});
app.post('/api/knowledge/:id/verify',auth,async(req,res)=>{try{const r=await q('SELECT k.* FROM knowledge_items k JOIN project_members pm ON pm.project_id=k.project_id AND pm.user_id=$2 WHERE k.id=$1',[req.params.id,req.user.sub]);if(!r.rowCount)return res.status(404).json({error:'Knowledge item not found'});await q("UPDATE knowledge_items SET status='verified',verified_by=$1,verified_at=now(),updated_at=now() WHERE id=$2",[req.user.sub,req.params.id]);await log(r.rows[0].project_id,req.user.sub,'knowledge.verified',{knowledgeId:req.params.id});res.json({ok:true})}catch(e){err(res,e,500)}});
app.post('/api/projects/:id/refresh',auth,requireProject,async(req,res)=>{try{await q('UPDATE projects SET version=version+1,updated_at=now() WHERE id=$1',[req.project.id]);await log(req.project.id,req.user.sub,'project.refreshed',{});await detectConflicts(req.project.id);res.json(await projectBundle(req.project.id))}catch(e){err(res,e,500)}});
app.post('/api/projects/:id/demo-seed',auth,requireProject,async(req,res)=>{try{const demo=[['architecture_notes.md','md','# Payments\nDecision: we will not store card data ourselves; a hosted checkout is used.\nOrders API uses Node and PostgreSQL.\nRisk: payment retry may not be idempotent.'],['roadmap.md','md','# Roadmap\nLaunch target: 2 May.\nProduction deployment is blocked until the payment retry is fixed.'],['tasks.csv','csv','task,status,assignee\nAuthentication,Done,Rahul\nDatabase schema,Done,Rahul\nPayment retry fix,Done,Rahul\nSecurity testing,Pending,Meera\nDeployment,Pending,'],['meeting.md','md','Agreed: hosted checkout.\nQuestion: who owns the vendor contract renewal?\nPayment retry is still not idempotent.\nWe are aiming for launch on 15 April.']];for(const [name,type,content] of demo){const s=await q('INSERT INTO sources(project_id,name,source_type,content,origin) VALUES($1,$2,$3,$4,$5) RETURNING id',[req.project.id,name,type,content,'demo']);for(const c of chunksForSource({content}))await q('INSERT INTO source_chunks(source_id,location,content) VALUES($1,$2,$3)',[s.rows[0].id,c.location,c.content]);}await log(req.project.id,req.user.sub,'demo.seeded',{});res.json(await projectBundle(req.project.id))}catch(e){err(res,e,500)}});
app.get('/api/projects/:id/continuity-package',auth,requireProject,async(req,res)=>{try{const b=await projectBundle(req.project.id);const role=req.project.role;const packageData={project:req.project,health:b.health,executive_summary:`${req.project.name} currently has ${b.items.length} evidence-backed knowledge items, ${b.conflicts.filter(c=>c.status==='open').length} open conflicts and ${b.gaps.filter(g=>g.status==='open').length} open knowledge gaps.`,what_you_need_to_know:b.items.filter(i=>i.status==='verified'||i.confidence>=.8).slice(0,10),current_state:b.items.filter(i=>['task','blocker'].includes(i.type)),decisions:b.items.filter(i=>i.type==='decision'),risks:b.items.filter(i=>i.type==='risk'),gaps:b.gaps.filter(g=>g.status==='open'),recent_changes:(await q('SELECT * FROM knowledge_versions WHERE knowledge_id IN (SELECT id FROM knowledge_items WHERE project_id=$1) ORDER BY created_at DESC LIMIT 20',[req.project.id])).rows,next_steps:b.gaps.filter(g=>g.status==='open').slice(0,5).map(g=>`Resolve: ${g.title}`),evidence:b.items.flatMap(i=>i.evidence).slice(0,30),audit:b.audit,role};res.json({package:packageData})}catch(e){err(res,e,500)}});

// GitHub connector: real public API/token-backed sync; clearly surfaced as connected when it succeeds.
app.post('/api/integrations/github/sync',auth,requireProject,async(req,res)=>{try{const {owner,repo}=req.body||{};if(!owner||!repo)return res.status(400).json({error:'owner and repo are required'});const headers={'User-Agent':'ContinuityAI','Accept':'application/vnd.github+json'};if(process.env.GITHUB_TOKEN)headers.Authorization=`Bearer ${process.env.GITHUB_TOKEN}`;const base=`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;const rr=await fetch(base,{headers});if(!rr.ok)return res.status(502).json({error:`GitHub returned ${rr.status}. Check repository and token access.`});const data=await rr.json();const issues=await (await fetch(`${base}/issues?state=all&per_page=20`,{headers})).json();const commits=await (await fetch(`${base}/commits?per_page=20`,{headers})).json();const content=[`Repository: ${data.full_name}`,`Description: ${data.description||'none'}`,`Open issues: ${data.open_issues_count}`,`Stars: ${data.stargazers_count}`,...Array.isArray(issues)?issues.slice(0,20).map(x=>`Issue #${x.number}: ${x.title} [${x.state}]`):[],...Array.isArray(commits)?commits.slice(0,20).map(x=>`Commit ${x.sha.slice(0,7)}: ${x.commit.message.split('\n')[0]}`):[]].join('\n');await q('INSERT INTO sources(project_id,name,source_type,content,origin,external_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7)',[req.project.id,`${owner}/${repo} GitHub sync`,'github',content,'github',data.id,{owner,repo,updatedAt:new Date().toISOString()}]);await log(req.project.id,req.user.sub,'integration.github.synced',{owner,repo});res.json({ok:true,message:'GitHub activity imported as project evidence',repository:data.full_name})}catch(e){err(res,e,502)}});

app.use(express.static(path.join(__dirname,'public')));
app.use((req,res,next)=>req.path.startsWith('/api/')?res.status(404).json({error:'API route not found'}):res.sendFile(path.join(__dirname,'public','index.html')));
app.use((e,req,res,next)=>{if(e instanceof multer.MulterError)return res.status(400).json({error:e.code==='LIMIT_FILE_SIZE'?'File too large':'Upload failed'});err(res,e,500)});

async function bootstrap(){try{await q('SELECT 1');const fs=require('fs');const schema=fs.readFileSync(path.join(__dirname,'migrations/001_init.sql'),'utf8');await q(schema);const u=await q('SELECT id FROM users WHERE email=$1',[demoEmail]);if(!u.rowCount){const hash=await bcrypt.hash(demoPassword,12);await q('INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3)',[demoEmail,hash,'Demo Reviewer']);}app.listen(PORT,()=>console.log(`ContinuityAI listening on http://localhost:${PORT}`));}catch(e){console.error('Startup failed:',e);process.exit(1)}}
if(require.main===module)bootstrap();
module.exports={app,aiExtract,demoExtract,health};
