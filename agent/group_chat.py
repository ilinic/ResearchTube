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


def public(entry):
    # Old addressed messages are publications too; routing remains private.
    return {key: entry[key] for key in ('id', 'time', 'senderTabId', 'text')}


class Journal:
    def __init__(self, path):
        self.path = path
        self.index = []
        self.members, self.requests, self.cursors = {}, {}, {}
        self.state, self.owner, self.chrome_group_id, self.last = 'starting', None, None, 0

    def apply(self, record, offset, length):
        if type(record.get('id')) is not int or record['id'] != self.last + 1:
            raise ValueError('Invalid journal sequence')
        self.last = record['id']
        if record['kind'] == 'created':
            self.owner, self.chrome_group_id = record['owner'], record['chromeGroupId']
        elif record['kind'] == 'board_cursor':
            self.cursors[(record['tabId'], record['chatPath'])] = record['lastReadId']
        elif record['kind'] == 'message':
            self.index.append((record['id'], offset, length, record['senderTabId']))
            if record.get('requestId'):
                self.requests[record['requestId']] = (record['id'], record['requestFingerprint'])
        elif record['kind'] == 'event':
            if record.get('event') == 'participant_left':
                self.members.pop(record['tabId'], None)
            elif record.get('member'):
                self.members[record['member']['tabId']] = record['member']
            if record.get('event') == 'group_state': self.state = record['state']
        # Legacy delivery/outbox records are retained on disk, never replayed.

    def append(self, record):
        record = dict(record, id=self.last + 1, time=datetime.now(timezone.utc).isoformat(timespec='milliseconds'))
        data = (json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
        with self.path.open('ab') as stream:
            offset = stream.tell()
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        self.apply(record, offset, len(data))
        return record

    @property
    def latest(self):
        return self.index[-1][0] if self.index else 0

    def summary(self, tab_id, chat_path):
        cursor = self.cursors.get((tab_id, chat_path), 0)
        return dict(unreadCount=sum(number > cursor and sender != tab_id for number, _, _, sender in self.index), latestId=self.latest)

    def records(self, after=None, before=None, limit=50):
        reverse = after is None
        indexes = reversed(self.index) if reverse else self.index
        output, used = [], 0
        with self.path.open('rb') as stream:
            for number, offset, length, _ in indexes:
                if after is not None and number <= after or before is not None and number >= before: continue
                stream.seek(offset)
                item = public(json.loads(stream.read(length)))
                cost = len(json.dumps(item, ensure_ascii=False).encode('utf-16-le')) // 2
                if len(output) >= limit or output and used + cost > 31000: break
                output.append(item); used += cost
        if reverse: output.reverse()
        first, last = (output[0]['id'], output[-1]['id']) if output else (None, after)
        return dict(entries=output, firstId=first, lastId=last, latestId=self.latest,
                    hasMore=bool(output and any(i[0] < first if reverse else i[0] > last for i in self.index)),
                    hasOlder=bool(output and any(i[0] < first for i in self.index)))


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

    def participant(self, room, payload, field='chatTabId'):
        tab_id, chat_path = payload.get(field), payload.get('chatPath')
        member = room.members.get(tab_id) if type(tab_id) is int else None
        if member is None or not self.eligible(member) or member['chatPath'] != chat_path:
            self.fail('This operation requires the exact saved GPT conversation in this group.')
        return tab_id, chat_path

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
        # Membership is internal state, never a Board publication or delivery.
        for tab_id, old in list(room.members.items()):
            if tab_id not in next_members:
                room.append(dict(kind='event', event='participant_left', tabId=tab_id, role=old['role'], title=old['title']))
        for tab_id, member in next_members.items():
            old = room.members.get(tab_id)
            if member != old:
                room.append(dict(kind='event', event='participant_changed' if old else 'participant_joined', member=member))
        if room.state in {'stopped','failed'} and pending['state'] == 'running' and not pending['resume']:
            pending['state'] = room.state
        if room.state != pending['state']:
            room.append(dict(kind='event', event='group_state', state=pending['state'], text='Group state: ' + pending['state']))
        return dict(roomId=room_id, latestId=room.last, state=room.state)

    def action(self, action, payload):
        if action == 'ready':
            if payload: self.fail('Ready takes no arguments.')
            return {'available': True}
        if action == 'sync': return self.snapshot(payload)
        room_id = payload.get('roomId'); room = self.room(room_id)
        if action == 'post':
            if set(payload) != {'roomId','senderTabId','chatPath','text','requestId'}: self.fail('Invalid Board publication fields.')
            sender, chat_path = self.participant(room, payload, 'senderTabId')
            if room.state != 'running': self.fail('Publish requires a running group.')
            text, request = payload['text'], payload['requestId']
            if not isinstance(text, str) or not text.strip() or len(text) > 12000 or not isinstance(request, str) or not re.fullmatch(r'[A-Za-z0-9_-]{10,64}', request): self.fail('A publication needs text and a unique request ID.')
            fingerprint = hashlib.sha256(json.dumps([sender,chat_path,text],ensure_ascii=False,separators=(',',':')).encode('utf-8')).hexdigest()
            if request in room.requests:
                previous_id, previous_fingerprint = room.requests[request]
                if previous_fingerprint != fingerprint: self.fail('Request ID already belongs to another publication.')
                return dict(messageId=previous_id, status='recorded')
            record = room.append(dict(kind='message', senderTabId=sender, text=text, requestId=request, requestFingerprint=fingerprint))
            return dict(messageId=record['id'], status='recorded')
        if action in {'read', 'view'}:
            allowed = {'roomId','afterId','beforeId','limit'} | ({'chatTabId','chatPath'} if action == 'read' else set())
            if set(payload) - allowed: self.fail('Unknown Board history fields.')
            after, before, limit = payload.get('afterId'), payload.get('beforeId'), payload.get('limit',50)
            if 'afterId' in payload and 'beforeId' in payload or any(key in payload and (type(payload[key]) is not int or payload[key] < 0) for key in ('afterId','beforeId')) or type(limit) is not int or not 1 <= limit <= 100: self.fail('Invalid history cursor or page size.')
            automatic = action == 'read' and 'afterId' not in payload and 'beforeId' not in payload
            if action == 'read':
                tab_id, chat_path = self.participant(room, payload)
                if automatic: after = room.cursors.get((tab_id,chat_path), 0)
            result = room.records(after,before,limit)
            if automatic and result['entries']:
                # Never acknowledge skipped/unreturned data. Cursor is durable before success.
                room.append(dict(kind='board_cursor',tabId=tab_id,chatPath=chat_path,lastReadId=result['lastId']))
            return result
        if action == 'summary':
            if set(payload) != {'roomId','chatTabId','chatPath'}: self.fail('Invalid Board summary fields.')
            return room.summary(*self.participant(room,payload))
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
        return await self.dispatch('view',dict(roomId=room_id,**(query or {})))


VIEW_HTML = r'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ResearchTube Board</title>
<style>body{font:15px system-ui;background:#111827;color:#e5e7eb;margin:0;padding:12px 20px;overflow-anchor:none}.meta{color:#9ca3af;font-size:12px}article{padding:10px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:5px 0}</style>
<main id="messages" aria-label="Shared research publications"></main>
<script>
'use strict';
const base=location.pathname.replace(/\/$/,''),messages=document.getElementById('messages');
let first=null,last=null,busy=false,hasOlder=false,initialized=false;
function draw(e){const a=document.createElement('article'),h=document.createElement('div'),p=document.createElement('pre');h.className='meta';h.textContent=e.time+' · GPT '+e.senderTabId;p.textContent=e.text;a.append(h,p);return a;}
async function load(previous=false){
 if(busy||previous&&(!hasOlder||first===null))return;
 busy=true;
 try{
  const q=new URLSearchParams();if(previous)q.set('beforeId',first);else if(last!==null)q.set('afterId',last);
  const r=await fetch(base+'/entries?'+q,{cache:'no-store'});if(!r.ok)throw Error('Board unavailable');
  const data=await r.json(),fragment=document.createDocumentFragment();
  const nearBottom=innerHeight+scrollY>=document.documentElement.scrollHeight-100,oldHeight=document.documentElement.scrollHeight,oldY=scrollY;
  for(const e of data.entries)fragment.append(draw(e));
  if(previous)messages.prepend(fragment);else messages.append(fragment);
  if(data.entries.length){first=first===null?data.firstId:Math.min(first,data.firstId);last=last===null?data.lastId:Math.max(last,data.lastId);}
  if(previous||!initialized)hasOlder=data.hasOlder;initialized=true;
  if(previous)scrollTo(0,oldY+document.documentElement.scrollHeight-oldHeight);
  else if(nearBottom)scrollTo(0,document.documentElement.scrollHeight);
 }catch{console.warn('ResearchTube Board temporarily unavailable; retrying.');return;}
 finally{busy=false;}
 if(hasOlder&&scrollY<100)queueMicrotask(()=>void load(true));
}
addEventListener('scroll',()=>{if(scrollY<100)void load(true);},{passive:true});
void load();setInterval(()=>void load(),2000);
</script></html>'''
