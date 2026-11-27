"""Per-conversation plans and shared skills; all mutations run in the existing outbox transaction."""
import json
import re
import time

PREFIX = "-- RT_AGENT_PLAN_V1\n"
READS = frozenset(("plan_read","plan_status","agent_memory_read","agent_memory_history","skill_list","skill_read","skill_history"))
WRITES = frozenset(("plan_edit","plan_pause","agent_memory_write","skill_create","skill_update"))
PRIVATE_READS = frozenset(("__plan_scan","__plan_peek"))
PRIVATE_WRITES = frozenset(("__plan_transition",))
MAX_SAFE = 9007199254740991

def ensure(con):
    for sql in (
        """CREATE TABLE IF NOT EXISTS _rt_internal_plans (
        chat_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
        idle_anchor TEXT, idle_since INTEGER, current_id INTEGER, goal TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT '', skill_ids TEXT NOT NULL DEFAULT '[]', memory_version INTEGER NOT NULL DEFAULT 0)""",
        """CREATE TABLE IF NOT EXISTS _rt_internal_plan_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, position INTEGER NOT NULL,
        prompt TEXT NOT NULL, delay_seconds INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued',
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, result TEXT NOT NULL DEFAULT '',
        anchor TEXT, marker TEXT, FOREIGN KEY(chat_id) REFERENCES _rt_internal_plans(chat_id))""",
        "CREATE INDEX IF NOT EXISTS _rt_internal_plan_order ON _rt_internal_plan_tasks(chat_id,status,position,id)",
        """CREATE TABLE IF NOT EXISTS _rt_internal_skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL,
        content TEXT NOT NULL, owner_chat_id TEXT, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS _rt_internal_skill_versions (
        skill_id INTEGER NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
        content TEXT NOT NULL, editor_chat_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(skill_id,version))""",
        """CREATE TABLE IF NOT EXISTS _rt_internal_agent_conversations (
        conversation_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, active INTEGER NOT NULL,
        created_at INTEGER NOT NULL, FOREIGN KEY(agent_id) REFERENCES _rt_internal_plans(chat_id))""",
        "CREATE UNIQUE INDEX IF NOT EXISTS _rt_internal_active_conversation ON _rt_internal_agent_conversations(agent_id) WHERE active=1",
        """CREATE TABLE IF NOT EXISTS _rt_internal_agent_memory_versions (
        chat_id TEXT NOT NULL, version INTEGER NOT NULL, goal TEXT NOT NULL, state TEXT NOT NULL,
        skill_ids TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(chat_id,version))"""
    ):
        con.execute(sql)

def bad(message):
    # Imported lazily to avoid a cycle with the shared outbox.
    try:
        from .scheduled_memory import fail
    except ImportError:
        from scheduled_memory import fail
    fail("PLAN_INVALID",message)

def conflict(message):
    try:
        from .scheduled_memory import fail
    except ImportError:
        from scheduled_memory import fail
    fail("PLAN_CONFLICT",message)

def now():
    return int(time.time()*1000)

def integer(v, minimum=0, maximum=MAX_SAFE):
    if type(v) is not int or not minimum<=v<=maximum:
        bad("Expected an integer in the supported range.")
    return v

def text(v, size=16000, required=False):
    if not isinstance(v,str) or len(v.encode("utf-8"))>size or required and not v.strip():
        bad("Invalid or oversized text; nothing was truncated.")
    return v

def chat(a):
    v=a.get("chat_id")
    if not isinstance(v,str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}",v):
        bad("A verified saved conversation ID is required.")
    return v

def row(con,sql,args=()):
    cur=con.execute(sql,args)
    v=cur.fetchone()
    return dict(zip((d[0] for d in cur.description),v)) if v is not None else None

def rows(con,sql,args=()):
    cur=con.execute(sql,args)
    names=[d[0] for d in cur.description]
    return [dict(zip(names,v)) for v in cur]

def resolve_agent(con,c,write=False):
    binding=row(con,"SELECT agent_id,active FROM _rt_internal_agent_conversations WHERE conversation_id=?",(c,))
    if binding:
        if write and not binding["active"]: conflict("Conversation retired; use its active successor.")
        return binding["agent_id"]
    return c

def active_conversation(con,c):
    binding=row(con,"SELECT conversation_id FROM _rt_internal_agent_conversations WHERE agent_id=? AND active=1",(c,))
    return binding["conversation_id"] if binding else c

def plan(con,c,create=False):
    if create:
        con.execute("INSERT OR IGNORE INTO _rt_internal_plans(chat_id) VALUES (?)",(c,))
        if not row(con,"SELECT conversation_id FROM _rt_internal_agent_conversations WHERE agent_id=? LIMIT 1",(c,)):
            con.execute("INSERT INTO _rt_internal_agent_conversations VALUES(?,?,1,?)",(c,c,now()))
    return row(con,"SELECT * FROM _rt_internal_plans WHERE chat_id=?",(c,))

def task(con,c,i):
    return row(con,"SELECT * FROM _rt_internal_plan_tasks WHERE chat_id=? AND id=?",(c,i))

def head(con,c):
    return row(con,"SELECT * FROM _rt_internal_plan_tasks WHERE chat_id=? AND status='queued' ORDER BY position,id LIMIT 1",(c,))

def snapshot(con,c):
    p=plan(con,c)
    if not p:
        return {"chat_id":c,"agent_id":c,"version":0,"paused":False,"current":None,"next":None,"idle_since":None,"idle_anchor":None,"goal":"","state":"","skill_ids":[],"memory_version":0,"skills":[]}
    p["agent_id"]=c
    p["chat_id"]=active_conversation(con,c)
    p["paused"]=bool(p["paused"])
    p["current"]=task(con,c,p.pop("current_id")) if p["current_id"] is not None else None
    p.pop("current_id",None)
    p["next"]=head(con,c)
    p["skill_ids"]=json.loads(p["skill_ids"])
    p["skills"]=[s for i in p["skill_ids"] if (s:=row(con,"SELECT id,name,version FROM _rt_internal_skills WHERE id=?",(i,)))]
    return p

def page(items,limit,offset):
    # Page size is a transport limit only; the underlying queues have no item count limit.
    result=[]
    used=0
    for item in items:
        n=len(json.dumps(item,ensure_ascii=False).encode("utf-8"))
        if len(result)>=limit or result and used+n>80000:
            break
        result.append(item);used+=n
    return {"items":result,"next_offset":offset+len(result) if len(items)>len(result) else None}

def read(con,name,a):
    limit=integer(a.get("limit",10),1,100)
    offset=integer(a.get("offset",0))
    if name=="__plan_scan":
        ids=a.get("chat_ids",[])
        if not isinstance(ids,list) or len(ids)>200: bad("Invalid scan batch.")
        result=[]
        for c in ids:
            c=chat({"chat_id":c})
            agent=resolve_agent(con,c)
            if active_conversation(con,agent)!=c: continue
            if row(con,"SELECT 1 AS active FROM _rt_internal_plans p WHERE p.chat_id=? AND p.paused=0 AND (p.current_id IS NOT NULL OR EXISTS (SELECT 1 FROM _rt_internal_plan_tasks t WHERE t.chat_id=p.chat_id AND t.status='queued'))",(agent,)):
                result.append(c)
        return {"chat_ids":result}
    if name=="__plan_peek" or name in ("plan_status","plan_read"):
        conversation=chat(a)
        c=resolve_agent(con,conversation)
        p=snapshot(con,c)
        p["retired"]=p["chat_id"]!=conversation
        if name=="plan_read":
            history=a.get("history",False)
            items=rows(con,"SELECT * FROM _rt_internal_plan_tasks WHERE chat_id=? AND "+("status IN ('finished','skipped','cancelled')" if history else "status IN ('queued','claimed','dispatching','sent')")+" ORDER BY "+("id DESC" if history else "position,id")+" LIMIT ? OFFSET ?",(c,limit+1,offset))
            # Avoid duplicating large text in queue pages.
            p={k:v for k,v in p.items() if k not in ("next","current","goal","state")}
            p.update(page(items,limit,offset))
        return p
    if name=="agent_memory_read":
        p=snapshot(con,resolve_agent(con,chat(a)))
        return {k:p[k] for k in ("chat_id","agent_id","goal","state","skill_ids","skills","memory_version")}
    if name=="agent_memory_history":
        return page(rows(con,"SELECT * FROM _rt_internal_agent_memory_versions WHERE chat_id=? ORDER BY version DESC LIMIT ? OFFSET ?",(resolve_agent(con,chat(a)),limit+1,offset)),limit,offset)
    if name=="skill_list":
        q=text(a.get("query",""),512)
        return page(rows(con,"SELECT id,name,description,owner_chat_id,version,created_at,updated_at FROM _rt_internal_skills WHERE instr(lower(name||' '||description),lower(?))>0 OR ?='' ORDER BY id LIMIT ? OFFSET ?",(q,q,limit+1,offset)),limit,offset)
    if name=="skill_read":
        i=integer(a.get("id"),1)
        v=a.get("version")
        return {"skill":row(con,"SELECT * FROM _rt_internal_skills WHERE id=?",(i,)) if v is None else row(con,"SELECT * FROM _rt_internal_skill_versions WHERE skill_id=? AND version=?",(i,integer(v,1)))}
    if name=="skill_history":
        return page(rows(con,"SELECT skill_id,version,name,description,editor_chat_id,updated_at FROM _rt_internal_skill_versions WHERE skill_id=? ORDER BY version DESC LIMIT ? OFFSET ?",(integer(a.get("id"),1),limit+1,offset)),limit,offset)
    bad("Unknown read tool.")

def encode(name,a):
    if name not in WRITES|PRIVATE_WRITES or not isinstance(a,dict):
        bad("Unknown plan mutation.")
    try:
        payload=PREFIX+json.dumps([name,a],ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False)
        size=len(payload.encode("utf-8"))
    except (ValueError,TypeError,UnicodeError):
        bad("Invalid plan mutation payload.")
    if size>32768: bad("Mutation exceeds 32 KiB; split the batch.")
    return payload

def decode(payload):
    try:
        name,a=json.loads(payload[len(PREFIX):])
    except (ValueError,TypeError):
        bad("Invalid plan payload.")
    if encode(name,a)!=payload: bad("Invalid plan payload.")
    return name,a

def mutate(con,name,a,operation_id):
    ensure(con)
    t=now()
    if name in ("skill_create","skill_update"):
        actor=a.get("actor")
        if actor is not None: text(actor,128,True)
        if name=="skill_create":
            n=text(a.get("name"),200,True);d=text(a.get("description",""),2000);body=text(a.get("content"),16000,True)
            i=con.execute("INSERT INTO _rt_internal_skills(name,description,content,owner_chat_id,version,created_at,updated_at) VALUES(?,?,?,?,1,?,?)",(n,d,body,actor,t,t)).lastrowid
            v=1
        else:
            i=integer(a.get("id"),1)
            s=row(con,"SELECT * FROM _rt_internal_skills WHERE id=?",(i,))
            if not s or s["version"]!=integer(a.get("expected_version"),1): conflict("Skill changed; read and merge before updating.")
            n=text(a.get("name",s["name"]),200,True);d=text(a.get("description",s["description"]),2000);body=text(a.get("content",s["content"]),16000,True)
            v=s["version"]+1
            con.execute("UPDATE _rt_internal_skills SET name=?,description=?,content=?,version=?,updated_at=? WHERE id=?",(n,d,body,v,t,i))
        con.execute("INSERT INTO _rt_internal_skill_versions VALUES(?,?,?,?,?,?,?)",(i,v,n,d,body,actor,t))
        return {"id":i,"version":v}
    conversation=chat(a)
    c=resolve_agent(con,conversation,write=True)
    p=plan(con,c,True)
    if name=="agent_memory_write":
        if p["memory_version"]!=integer(a.get("expected_version")): conflict("Agent memory changed; reread.")
        g=text(a.get("goal",p["goal"]),8000);s=text(a.get("state",p["state"]),16000)
        ids=a.get("skill_ids",json.loads(p["skill_ids"]))
        if not isinstance(ids,list) or len(ids)>100 or len(ids)!=len(set(integer(i,1) for i in ids)): bad("Invalid skill IDs.")
        for i in ids:
            if not row(con,"SELECT id FROM _rt_internal_skills WHERE id=?",(i,)): bad("Skill does not exist.")
        v=p["memory_version"]+1;j=json.dumps(ids,separators=(",",":"))
        con.execute("UPDATE _rt_internal_plans SET goal=?,state=?,skill_ids=?,memory_version=? WHERE chat_id=?",(g,s,j,v,c))
        con.execute("INSERT INTO _rt_internal_agent_memory_versions VALUES(?,?,?,?,?,?)",(c,v,g,s,j,t))
        return {"version":v}
    if name=="plan_pause":
        if type(a.get("paused")) is not bool: bad("paused must be boolean.")
        if p["version"]!=integer(a.get("expected_version")): conflict("Plan changed; reread.")
        con.execute("UPDATE _rt_internal_plans SET paused=?,version=version+1,idle_anchor=NULL,idle_since=NULL WHERE chat_id=?",(int(a["paused"]),c))
        return {"version":p["version"]+1,"paused":a["paused"]}
    if name=="plan_edit":
        if p["version"]!=integer(a.get("expected_version")): conflict("Plan changed; reread.")
        actions=a.get("actions")
        if not isinstance(actions,list) or not actions: bad("Provide edit actions.")
        added=[]
        for op in actions:
            if not isinstance(op,dict): bad("Invalid edit.")
            kind=op.get("op")
            if kind=="clear":
                con.execute("UPDATE _rt_internal_plan_tasks SET status='cancelled',finished_at=? WHERE chat_id=? AND status='queued'",(t,c))
                continue
            if kind=="add":
                prompt=text(op.get("prompt"),16000,True)
                delay=integer(op.get("delay_seconds",0),0,MAX_SAFE//1000)
                count=row(con,"SELECT count(*) AS n FROM _rt_internal_plan_tasks WHERE chat_id=? AND status='queued'",(c,))["n"]
                pos=integer(op.get("position",count),0,count)
                con.execute("UPDATE _rt_internal_plan_tasks SET position=position+1 WHERE chat_id=? AND status='queued' AND position>=?",(c,pos))
                added.append(con.execute("INSERT INTO _rt_internal_plan_tasks(chat_id,position,prompt,delay_seconds,created_at) VALUES(?,?,?,?,?)",(c,pos,prompt,delay,t)).lastrowid)
                continue
            i=integer(op.get("id"),1)
            item=task(con,c,i)
            if not item: conflict("Task not found.")
            if kind=="result":
                if item["status"] not in ("claimed","dispatching","sent","finished"): conflict("No executed task to record.")
                con.execute("UPDATE _rt_internal_plan_tasks SET result=? WHERE id=?",(text(op.get("result"),16000),i))
                continue
            if kind in ("retry","skip"):
                if not p["paused"] or p["current_id"]!=i or item["status"] not in ("claimed","dispatching","sent"): conflict("Pause the plan and reconcile the current task first.")
                if kind=="retry": con.execute("UPDATE _rt_internal_plan_tasks SET position=position+1 WHERE chat_id=? AND status='queued'",(c,))
                con.execute("UPDATE _rt_internal_plan_tasks SET status=?,position=0,marker=NULL,anchor=NULL,started_at=NULL,finished_at=? WHERE id=?",("queued" if kind=="retry" else "skipped",None if kind=="retry" else t,i))
                con.execute("UPDATE _rt_internal_plans SET current_id=NULL WHERE chat_id=?",(c,))
                p["current_id"]=None
                continue
            if item["status"]!="queued": conflict("Only waiting tasks can be edited.")
            old=item["position"]
            if kind=="delete":
                con.execute("UPDATE _rt_internal_plan_tasks SET status='cancelled',finished_at=? WHERE id=?",(t,i))
                con.execute("UPDATE _rt_internal_plan_tasks SET position=position-1 WHERE chat_id=? AND status='queued' AND position>?",(c,old))
            elif kind=="update":
                prompt=text(op.get("prompt",item["prompt"]),16000,True);delay=integer(op.get("delay_seconds",item["delay_seconds"]),0,MAX_SAFE//1000)
                count=row(con,"SELECT count(*) AS n FROM _rt_internal_plan_tasks WHERE chat_id=? AND status='queued'",(c,))["n"]
                pos=integer(op.get("position",old),0,count-1)
                if pos<old: con.execute("UPDATE _rt_internal_plan_tasks SET position=position+1 WHERE chat_id=? AND status='queued' AND position>=? AND position<?",(c,pos,old))
                elif pos>old: con.execute("UPDATE _rt_internal_plan_tasks SET position=position-1 WHERE chat_id=? AND status='queued' AND position>? AND position<=?",(c,old,pos))
                con.execute("UPDATE _rt_internal_plan_tasks SET position=?,prompt=?,delay_seconds=? WHERE id=?",(pos,prompt,delay,i))
            else: bad("Unknown edit operation.")
        # Normalize positions after retry/skip and preserve the original idle deadline for edits.
        con.execute("""WITH ordered AS (SELECT id,row_number() OVER(ORDER BY position,id)-1 AS p FROM _rt_internal_plan_tasks WHERE chat_id=? AND status='queued')
                    UPDATE _rt_internal_plan_tasks SET position=(SELECT p FROM ordered WHERE ordered.id=_rt_internal_plan_tasks.id)
                    WHERE chat_id=? AND status='queued'""",(c,c))
        con.execute("UPDATE _rt_internal_plans SET version=version+1 WHERE chat_id=?",(c,))
        return {"version":p["version"]+1,"added_ids":added}
    if name!="__plan_transition": bad("Unknown mutation.")
    kind=a.get("action")
    if p["version"]!=integer(a.get("version")): conflict("Plan changed.")
    if p["paused"]: conflict("Plan paused.")
    current=task(con,c,p["current_id"]) if p["current_id"] is not None else None
    anchor=text(a.get("anchor",""),512)
    if kind=="rollover":
        successor=chat({"chat_id":a.get("successor")})
        if successor==conversation or plan(con,successor) or row(con,"SELECT 1 FROM _rt_internal_agent_conversations WHERE conversation_id=?",(successor,)): conflict("Successor already has an agent.")
        if active_conversation(con,c)!=conversation: conflict("Conversation already replaced.")
        if current:
            # A not-yet-dispatched claim is safe to requeue; a possibly sent task
            # must be reconciled rather than blindly re-executed.
            con.execute("UPDATE _rt_internal_plan_tasks SET position=position+1 WHERE chat_id=? AND status='queued'",(c,))
            if current["status"]=="claimed":
                con.execute("UPDATE _rt_internal_plan_tasks SET status='queued',position=0,anchor=NULL,marker=NULL,started_at=NULL WHERE id=?",(current["id"],))
            else:
                con.execute("UPDATE _rt_internal_plan_tasks SET status='skipped',finished_at=? WHERE id=?",(t,current["id"]))
                prompt="Reconcile previous task #"+str(current["id"])+" in the retired conversation. Its execution may be incomplete or already committed. Read history and durable results; do not repeat external effects blindly. Original task: "+current["prompt"]
                prompt=prompt.encode("utf-8")[:16000].decode("utf-8","ignore")
                con.execute("INSERT INTO _rt_internal_plan_tasks(chat_id,position,prompt,delay_seconds,created_at) VALUES(?,0,?,0,?)",(c,prompt,t))
        con.execute("UPDATE _rt_internal_agent_conversations SET active=0 WHERE agent_id=?",(c,))
        con.execute("INSERT INTO _rt_internal_agent_conversations VALUES(?,?,1,?)",(successor,c,t))
        con.execute("UPDATE _rt_internal_plans SET current_id=NULL,idle_anchor=NULL,idle_since=NULL,version=version+1 WHERE chat_id=?",(c,))
        return {"agent_id":c,"chat_id":successor,"previous_chat_id":conversation}
    if kind=="observe":
        if current: conflict("Current task has not finished.")
        if not anchor: bad("Idle observation requires an anchor.")
        if p["idle_anchor"]!=anchor:
            con.execute("UPDATE _rt_internal_plans SET idle_anchor=?,idle_since=?,version=version+1 WHERE chat_id=?",(anchor,t,c))
        return {"observed":True}
    if kind=="busy":
        if not current and p["idle_since"] is not None:
            con.execute("UPDATE _rt_internal_plans SET idle_anchor=NULL,idle_since=NULL,version=version+1 WHERE chat_id=?",(c,))
        return {"observed":True}
    i=integer(a.get("id"),1)
    if kind=="claim":
        h=head(con,c)
        if current or not h or h["id"]!=i or p["idle_anchor"]!=anchor or p["idle_since"] is None or t-p["idle_since"]<h["delay_seconds"]*1000: conflict("Task is no longer due.")
        marker=text(a.get("marker"),128,True)
        con.execute("UPDATE _rt_internal_plan_tasks SET status='claimed',anchor=?,marker=?,started_at=? WHERE id=?",(anchor,marker,t,i))
        con.execute("UPDATE _rt_internal_plan_tasks SET position=position-1 WHERE chat_id=? AND status='queued' AND position>?",(c,h["position"]))
        con.execute("UPDATE _rt_internal_plans SET current_id=?,version=version+1 WHERE chat_id=?",(i,c))
        return {"claimed":True}
    if not current or current["id"]!=i or current["marker"]!=a.get("marker"): conflict("Reservation changed.")
    status=current["status"]
    if kind=="dispatch" and status=="claimed":
        con.execute("UPDATE _rt_internal_plan_tasks SET status='dispatching' WHERE id=?",(i,))
    elif kind=="undispatch" and status=="dispatching":
        con.execute("UPDATE _rt_internal_plan_tasks SET status='claimed' WHERE id=?",(i,))
    elif kind=="sent" and status in ("claimed","dispatching","sent"):
        con.execute("UPDATE _rt_internal_plan_tasks SET status='sent' WHERE id=?",(i,))
    elif kind=="release" and status=="claimed":
        con.execute("UPDATE _rt_internal_plan_tasks SET position=position+1 WHERE chat_id=? AND status='queued'",(c,))
        con.execute("UPDATE _rt_internal_plan_tasks SET status='queued',position=0,marker=NULL,anchor=NULL,started_at=NULL WHERE id=?",(i,))
        con.execute("UPDATE _rt_internal_plans SET current_id=NULL WHERE chat_id=?",(c,))
    elif kind=="finish" and status in ("claimed","dispatching","sent") and anchor:
        con.execute("UPDATE _rt_internal_plan_tasks SET status='finished',finished_at=? WHERE id=?",(t,i))
        con.execute("UPDATE _rt_internal_plans SET current_id=NULL,idle_anchor=?,idle_since=? WHERE chat_id=?",(anchor,t,c))
        # Recompact pending positions after the previous task leaves the queue.
        con.execute("""WITH ordered AS (SELECT id,row_number() OVER(ORDER BY position,id)-1 AS p FROM _rt_internal_plan_tasks WHERE chat_id=? AND status='queued')
                    UPDATE _rt_internal_plan_tasks SET position=(SELECT p FROM ordered WHERE ordered.id=_rt_internal_plan_tasks.id) WHERE chat_id=? AND status='queued'""",(c,c))
    else: conflict("Invalid or uncertain task transition.")
    con.execute("UPDATE _rt_internal_plans SET version=version+1 WHERE chat_id=?",(c,))
    return {"status":kind}
