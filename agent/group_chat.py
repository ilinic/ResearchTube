"""Workspace-backed group journal. Views are read-only; Chrome owns membership."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import time
from datetime import datetime, timezone

ROOM = re.compile(r'gc_[A-Za-z0-9_-]{22}')
STATES = {'starting', 'running', 'idle', 'stopped', 'failed'}
TERMINAL = {'sent', 'read', 'unavailable', 'uncertain'}


def public(entry):
    result = {key: entry[key] for key in ('id', 'time', 'kind', 'event', 'senderTabId', 'recipientTabIds', 'text', 'tabId', 'role', 'title', 'url', 'state') if key in entry}
    if 'recipientTabIds' in result:
        result['recipientCount'] = len(result['recipientTabIds'])
        result['recipientTabIds'] = result['recipientTabIds'][:200]
    return result


class Journal:
    def __init__(self, path, records=()):
        self.path = path
        self.index = []
        self.members = {}
        self.deliveries = {}
        self.requests = {}
        self.state = 'starting'
        self.owner = None
        self.chrome_group_id = None
        self.last = 0
        for offset, length, record in records:
            self.apply(record, offset, length)

    def apply(self, record, offset, length):
        if type(record.get('id')) is not int or record['id'] != self.last + 1:
            raise ValueError('Invalid journal sequence')
        self.last = record['id']
        if record['kind'] == 'created':
            self.owner, self.chrome_group_id = record['owner'], record['chromeGroupId']
        elif record['kind'] == 'delivery':
            for message_id in record['messageIds']:
                key = (message_id, record['tabId'])
                if key in self.deliveries:
                    self.deliveries[key]['state'] = record['state']
        else:
            self.index.append((record['id'], offset, length))
            if record.get('requestId'):
                self.requests[record['requestId']] = (record['id'], record['requestFingerprint'])
            if record.get('event') == 'participant_left':
                self.members.pop(record['tabId'], None)
            elif record.get('member'):
                self.members[record['member']['tabId']] = record['member']
            if record.get('event') == 'group_state': self.state = record['state']
            for recipient in record.get('recipients', []):
                self.deliveries[(record['id'], recipient['tabId'])] = dict(recipient, state='pending', senderTabId=record.get('senderTabId'))

    def append(self, record):
        record = dict(record, id=self.last + 1, time=datetime.now(timezone.utc).isoformat(timespec='milliseconds'))
        data = (json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
        # Flush before acknowledging a message or starting any Composer insertion.
        with self.path.open('ab') as stream:
            offset = stream.tell()
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        self.apply(record, offset, len(data))
        return record

    def records(self, after=None, before=None, limit=50, addressed_to=None):
        indexes = (self.index if before is None and after is not None else reversed(self.index))
        output, used = [], 0
        with self.path.open('rb') as stream:
            for number, offset, length in indexes:
                if after is not None and number <= after or before is not None and number >= before: continue
                stream.seek(offset)
                record = json.loads(stream.read(length))
                if addressed_to is not None and record['kind'] == 'message' and addressed_to not in record['recipientTabIds'] and record.get('senderTabId') != addressed_to: continue
                item = public(record)
                cost = len(json.dumps(item, ensure_ascii=False))
                if output and used + cost > 32000: break
                output.append(item); used += cost
                if len(output) >= limit: break
        if after is None: output.reverse()
        return dict(entries=output, firstId=output[0]['id'] if output else None,
                    lastId=output[-1]['id'] if output else after, latestId=self.last,
                    hasOlder=bool(output and any(i[0] < output[0]['id'] for i in self.index)))


class GroupChatService:
    def __init__(self, host):
        self.host, self.root = host, None
        self.rooms, self.snapshots = {}, {}
        self.lock = asyncio.Lock()

    def fail(self, message, code='GROUP_CHAT_INVALID'):
        raise self.host.AgentApiError(code, message)

    def root_path(self):
        return self.host.WorkspacePathResolver().resolve_destination('group-chats', field_name='group chat', error_code='GROUP_CHAT_IO').physical_path

    def load(self):
        root = self.root_path()
        if root == self.root: return
        rooms = {}
        if root.exists():
            for directory in root.iterdir():
                if not ROOM.fullmatch(directory.name): continue
                path = self.host.WorkspacePathResolver().resolve_destination(f'group-chats/{directory.name}/history.txt', field_name='group chat', error_code='GROUP_CHAT_IO').physical_path
                room = Journal(path)
                with path.open('rb') as stream:
                    while True:
                        offset = stream.tell(); line = stream.readline()
                        if not line: break
                        if not line.endswith(b'\n'):
                            self.fail('The group journal is incomplete; preserve it for recovery.', 'GROUP_CHAT_IO')
                        room.apply(json.loads(line), offset, len(line))
                if room.owner is None: self.fail('Invalid group journal.', 'GROUP_CHAT_IO')
                interrupted = {}
                for (message_id, tab_id), delivery in room.deliveries.items():
                    if delivery['state'] == 'attempting': interrupted.setdefault(tab_id, []).append(message_id)
                for tab_id, ids in interrupted.items():
                    for offset in range(0,len(ids),50):
                        room.append(dict(kind='delivery',tabId=tab_id,messageIds=ids[offset:offset+50],state='uncertain'))
                    room.append(dict(kind='event',event='notification_failed',text=f'Notification to GPT tab {tab_id} was interrupted; automatic replay is suppressed. Messages remain in the journal.',recipientTabIds=[]))
                rooms[directory.name] = room
        self.root, self.rooms = root, rooms

    def room(self, room_id):
        if not isinstance(room_id, str) or not ROOM.fullmatch(room_id) or room_id not in self.rooms:
            self.fail('This group journal is unavailable.', 'GROUP_CHAT_NOT_FOUND')
        # Independently revalidate the complete path before each operation.
        self.host.WorkspacePathResolver().resolve_destination(f'group-chats/{room_id}/history.txt', field_name='group chat', error_code='GROUP_CHAT_IO')
        return self.rooms[room_id]

    @staticmethod
    def eligible(member):
        return member['role'] == 'chatgpt' and bool(re.fullmatch(r'(?:/g/[A-Za-z0-9_-]+)?/c/[A-Za-z0-9_-]+', member.get('chatPath', '')))

    def recipients(self, room, ids=None, sender=None):
        ids = [i for i, m in room.members.items() if self.eligible(m) and i != sender] if ids is None else ids
        if not isinstance(ids, list) or any(type(i) is not int or i < 0 for i in ids) or len(set(ids)) != len(ids): self.fail('Recipients must be distinct GPT tab IDs.')
        result = []
        for tab_id in ids:
            member = room.members.get(tab_id)
            if member is None or not self.eligible(member): self.fail('Every recipient must be a saved GPT conversation in this group.')
            result.append(dict(tabId=tab_id, chatPath=member['chatPath']))
        return result

    def snapshot(self, payload):
        allowed = {'chromeGroupId', 'owner', 'roomId', 'snapshotId', 'offset', 'members', 'complete', 'state', 'fresh', 'resume'}
        if set(payload) - allowed: self.fail('Invalid group snapshot fields.')
        gid, owner, sid = payload.get('chromeGroupId'), payload.get('owner'), payload.get('snapshotId')
        if type(gid) is not int or gid < 0 or not isinstance(owner, str) or not re.fullmatch(r'[a-z0-9_-]{1,64}', owner) or not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{10,64}', sid): self.fail('Invalid group identity.')
        offset, members = payload.get('offset'), payload.get('members')
        if type(offset) is not int or offset < 0 or not isinstance(members, list) or len(members) > 40 or type(payload.get('complete')) is not bool or payload.get('state') not in STATES: self.fail('Invalid group snapshot page.')
        clean = []
        for m in members:
            if not isinstance(m, dict) or set(m) != {'tabId', 'role', 'title', 'url', 'chatPath'} or type(m['tabId']) is not int or m['tabId'] < 0 or m['role'] not in {'chatgpt', 'site'} or any(not isinstance(m[k], str) or len(m[k]) > n for k,n in [('title',200),('url',600),('chatPath',200)]): self.fail('Invalid group participant.')
            if m['chatPath'] and not re.fullmatch(r'(?:/g/[A-Za-z0-9_-]+)?/c/[A-Za-z0-9%:_-]+', m['chatPath']): self.fail('Invalid conversation identity.')
            clean.append(dict(m))
        now = time.monotonic()
        self.snapshots = {k:v for k,v in self.snapshots.items() if now - v['at'] < 60}
        key = (owner, gid, sid)
        if offset == 0:
            if len(self.snapshots) >= 100: self.fail('Too many incomplete snapshots.')
            self.snapshots[key] = dict(at=now, members=[], roomId=payload.get('roomId'), state=payload['state'], fresh=payload.get('fresh') is True, resume=payload.get('resume') is True)
        pending = self.snapshots.get(key)
        if not pending or offset != len(pending['members']) or pending['state'] != payload['state']: self.fail('Restart the group snapshot at offset zero.')
        pending['members'].extend(clean)
        if not payload['complete']: return {'accepted': True}
        del self.snapshots[key]
        all_members = pending['members']
        if len({m['tabId'] for m in all_members}) != len(all_members): self.fail('Duplicate group participants.')
        room_id = pending['roomId']
        if room_id:
            room = self.room(room_id)
            if room.owner != owner or room.chrome_group_id != gid: self.fail('Group identity mismatch.')
        else:
            candidates = [] if pending['fresh'] else [(i,r) for i,r in self.rooms.items() if r.owner == owner and r.chrome_group_id == gid and any(
                self.eligible(m) and r.members.get(m['tabId'], {}).get('chatPath') == m['chatPath'] for m in all_members)]
            if candidates: room_id, room = candidates[-1]
            else:
                room_id = 'gc_' + secrets.token_urlsafe(16)
                path = self.host.WorkspacePathResolver().resolve_destination(f'group-chats/{room_id}/history.txt', field_name='group chat', error_code='GROUP_CHAT_IO').physical_path
                path.parent.mkdir(parents=True, exist_ok=False)
                room = Journal(path)
                room.append(dict(kind='created', owner=owner, chromeGroupId=gid))
                self.rooms[room_id] = room
        next_members = {m['tabId']:m for m in all_members}
        # Membership changes wake agents; ordinary title/navigation updates only log.
        for tab_id, old in list(room.members.items()):
            if tab_id not in next_members:
                routes = self.recipients(room, sender=tab_id) if room.state == 'running' else []
                routes = [r for r in routes if next_members.get(r['tabId'],{}).get('chatPath') == r['chatPath']]
                room.append(dict(kind='event', event='participant_left', tabId=tab_id, role=old['role'], title=old['title'], text='Participant left the group.', recipients=routes, recipientTabIds=[r['tabId'] for r in routes]))
        for tab_id, member in next_members.items():
            old = room.members.get(tab_id)
            if member != old:
                routes = self.recipients(room, sender=tab_id) if old is None and room.state == 'running' else []
                routes = [r for r in routes if next_members.get(r['tabId'],{}).get('chatPath') == r['chatPath']]
                room.append(dict(kind='event', event='participant_changed' if old else 'participant_joined', **{k:member[k] for k in ('tabId','role','title','url')}, member=member, text='Participant changed.' if old else 'Participant joined the group.', recipients=routes, recipientTabIds=[r['tabId'] for r in routes]))
        if room.state in {'stopped','failed'} and pending['state'] == 'running' and not pending['resume']:
            pending['state'] = room.state
        if room.state != pending['state']:
            room.append(dict(kind='event', event='group_state', state=pending['state'], text='Group state: ' + pending['state'], recipientTabIds=[]))
        return dict(roomId=room_id, latestId=room.last, state=room.state)

    def action(self, action, payload):
        if action == 'ready':
            if payload: self.fail('Ready takes no arguments.')
            return {'available': True}
        if action == 'sync': return self.snapshot(payload)
        room_id = payload.get('roomId'); room = self.room(room_id)
        if action == 'send':
            if set(payload) - {'roomId','senderTabId','recipientTabIds','text','requestId'}: self.fail('Unknown message fields.')
            sender = payload.get('senderTabId')
            if type(sender) is not int or sender < 0: self.fail('Invalid sender tab ID.')
            member = room.members.get(sender)
            if member is None or not self.eligible(member) or room.state != 'running': self.fail('The sender must be a live saved GPT participant in a running group.')
            text, request = payload.get('text'), payload.get('requestId')
            if not isinstance(text,str) or not text.strip() or len(text) > 12000 or not isinstance(request,str) or not re.fullmatch(r'[A-Za-z0-9_-]{10,64}',request): self.fail('A message needs text and a unique request ID.')
            if payload.get('recipientTabIds') == []: self.fail('Omit recipients for broadcast; an explicit list must be nonempty.')
            fingerprint = hashlib.sha256(json.dumps([sender,text,payload.get('recipientTabIds')],ensure_ascii=False,separators=(',',':')).encode('utf-8')).hexdigest()
            if request in room.requests:
                previous_id,previous_fingerprint = room.requests[request]
                if previous_fingerprint != fingerprint: self.fail('Request ID already belongs to another message.')
                record = room.records(after=previous_id-1, limit=1)['entries'][0]
                if record['text'] != text or record['senderTabId'] != sender: self.fail('Request ID already belongs to another message.')
                return dict(messageId=record['id'], recipientTabIds=record['recipientTabIds'][:200], recipientCount=record.get('recipientCount',len(record['recipientTabIds'])), status='recorded')
            recipients = self.recipients(room, payload.get('recipientTabIds'), sender)
            record = room.append(dict(kind='message', senderTabId=sender, recipientTabIds=[r['tabId'] for r in recipients], recipients=recipients, text=text, requestId=request, requestFingerprint=fingerprint))
            return dict(messageId=record['id'], recipientTabIds=record['recipientTabIds'][:200], recipientCount=record.get('recipientCount',len(record['recipientTabIds'])), status='recorded')
        if action == 'read':
            if set(payload)-{'roomId','afterId','beforeId','limit','chatTabId','addressedOnly'}: self.fail('Unknown history fields.')
            after, before, limit = payload.get('afterId'), payload.get('beforeId'), payload.get('limit',50)
            if after is not None and before is not None or any(v is not None and (type(v) is not int or v < 0) for v in (after,before)) or type(limit) is not int or not 1 <= limit <= 100: self.fail('Invalid history cursor or page size.')
            if payload.get('addressedOnly') is not None and type(payload['addressedOnly']) is not bool: self.fail('Invalid history filter.')
            result = room.records(after,before,limit,payload.get('chatTabId') if payload.get('addressedOnly') else None)
            result['participants'] = [{k:m[k] for k in ('tabId','role','title','url')} for m in list(room.members.values())[:200]]
            result['totalParticipants'] = len(room.members)
            return result
        if action == 'pending':
            if set(payload)-{'roomId','afterTabId'}: self.fail('Invalid pending query.')
            if room.state != 'running': return {'batches':[]}
            after = payload.get('afterTabId',-1)
            if type(after) is not int: self.fail('Invalid pending cursor.')
            batches = {}
            for (message_id,tab_id), delivery in room.deliveries.items():
                if tab_id <= after or delivery['state'] != 'pending': continue
                m = room.members.get(tab_id)
                if not m or not self.eligible(m) or m['chatPath'] != delivery['chatPath']: continue
                batch = batches.setdefault(tab_id, dict(tabId=tab_id,chatPath=delivery['chatPath'],messageIds=[],senderTabIds=[]))
                if len(batch['messageIds']) < 50:
                    batch['messageIds'].append(message_id)
                    if delivery.get('senderTabId') is not None and delivery['senderTabId'] not in batch['senderTabIds']: batch['senderTabIds'].append(delivery['senderTabId'])
            return {'batches':[batches[i] for i in sorted(batches)[:20]]}
        if action == 'delivery':
            if set(payload) != {'roomId','tabId','messageIds','state'} or payload['state'] not in TERMINAL|{'attempting','pending'} or type(payload['tabId']) is not int or not isinstance(payload['messageIds'],list) or not 1 <= len(payload['messageIds']) <= 50: self.fail('Invalid delivery update.')
            if any(type(i) is not int or i < 1 for i in payload['messageIds']) or len(set(payload['messageIds'])) != len(payload['messageIds']): self.fail('Invalid message IDs.')
            for message_id in payload['messageIds']:
                d = room.deliveries.get((message_id,payload['tabId']))
                if d is None or d['state'] in TERMINAL: self.fail('Delivery is missing or already terminal.')
                if payload['state'] == 'attempting' and d['state'] != 'pending': self.fail('Delivery already being attempted.')
            room.append(dict(kind='delivery', tabId=payload['tabId'], messageIds=payload['messageIds'], state=payload['state']))
            if payload['state'] in {'uncertain','unavailable'}:
                room.append(dict(kind='event',event='notification_failed',text=f"Notification to GPT tab {payload['tabId']}: {payload['state']}. Entries: " + ', '.join(map(str,payload['messageIds'])) + '. Messages remain in the journal.',recipientTabIds=[]))
            return {'accepted':True}
        self.fail('Unknown group chat operation.')

    async def dispatch(self, action, payload):
        if not isinstance(payload,dict): self.fail('A group chat request must be an object.')
        async with self.lock:
            def work():
                self.load()
                return self.action(action,payload)
            operation = asyncio.create_task(asyncio.to_thread(work))
            try:
                return await asyncio.shield(operation)
            except asyncio.CancelledError:
                # A file thread cannot be cancelled. Retain serialization until
                # its write finishes, including when the caller disconnects.
                await asyncio.gather(operation, return_exceptions=True)
                raise
            except self.host.AgentApiError: raise
            except (OSError, ValueError, KeyError, TypeError):
                self.root = None
                self.fail('The group journal could not be read or safely saved. Preserve its files and check Workspace access.', 'GROUP_CHAT_IO')

    async def view(self, room_id, query=None):
        return await self.dispatch('read',dict(roomId=room_id,**(query or {})))


VIEW_HTML = r'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ResearchTube · Group chat</title>
<style>body{font:15px system-ui;background:#111827;color:#e5e7eb;max-width:1000px;margin:24px auto;padding:0 20px}header{position:sticky;top:0;background:#111827;padding:12px 0;border-bottom:1px solid #374151}h1{font-size:22px;margin:0}#status,#participants,.meta{color:#9ca3af;font-size:13px}article{padding:15px 0;border-bottom:1px solid #263244}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}button{background:#374151;color:white;border:0;padding:9px 14px;border-radius:6px;cursor:pointer}.event{opacity:.8}</style>
<header><h1>ResearchTube · Group chat</h1><p>Read-only activity journal</p><div id="participants"></div><div id="status">Connecting…</div></header><p><button id="older">Load older entries</button></p><main id="messages"></main>
<script>
'use strict';const base=location.pathname.replace(/\/$/,''),messages=document.getElementById('messages'),status=document.getElementById('status'),older=document.getElementById('older');let first=null,last=null,busy=false;
function draw(e){const a=document.createElement('article');a.className=e.kind;const h=document.createElement('div');h.className='meta';h.textContent='#'+e.id+' · '+e.time+' · '+(e.kind==='message'?'GPT '+e.senderTabId+' → '+(e.recipientTabIds.join(', ')||'no other GPT participants'):e.event+(e.tabId==null?'':' · tab '+e.tabId));const p=document.createElement('pre');p.textContent=e.text+(e.title?'\n'+e.title:'')+(e.url?'\n'+e.url:'');a.append(h,p);return a;}
async function load(previous=false){if(busy)return;busy=true;const nearBottom=innerHeight+scrollY>=document.body.scrollHeight-100,oldHeight=document.body.scrollHeight;try{const q=new URLSearchParams();if(previous&&first!==null)q.set('beforeId',first);else if(last!==null)q.set('afterId',last);const r=await fetch(base+'/entries?'+q,{cache:'no-store'});if(!r.ok)throw Error('Local Agent unavailable');const data=await r.json(),fragment=document.createDocumentFragment();for(const e of data.entries)fragment.append(draw(e));if(previous)messages.prepend(fragment);else messages.append(fragment);if(data.entries.length){first=first===null?data.firstId:Math.min(first,data.firstId);last=last===null?data.lastId:Math.max(last,data.lastId);}older.hidden=!data.hasOlder&&previous||first===null;document.getElementById('participants').textContent=data.participants.map(p=>p.role+' '+p.tabId+': '+p.title).join(' · ')+(data.totalParticipants>data.participants.length?' · '+data.totalParticipants+' total':'');status.textContent='Connected · '+data.totalParticipants+' participants';if(previous)scrollBy(0,document.body.scrollHeight-oldHeight);else if(nearBottom)scrollTo(0,document.body.scrollHeight);}catch{status.textContent='Disconnected · reconnecting automatically';}finally{busy=false;}}
older.onclick=()=>load(true);load();setInterval(()=>load(),2000);
</script></html>'''
