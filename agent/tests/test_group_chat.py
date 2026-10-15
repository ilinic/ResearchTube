"""Real Board persistence, passive unread cursors, legacy replay and views."""
import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from agent import researchtube_agent as agent
from agent.group_chat import GroupChatService, VIEW_HTML


def member(tab_id, role='chatgpt', path=None):
    return dict(tabId=tab_id,role=role,title='Participant '+str(tab_id),url='https://chatgpt.com/c/chat'+str(tab_id) if role=='chatgpt' else 'https://example.test/article',chatPath=path if path is not None else '/c/chat'+str(tab_id) if role=='chatgpt' else '')


class GroupChatTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.patch=patch.object(agent,'WORKSPACE_PATH',self.root);self.patch.start()
        self.service=GroupChatService(agent)
        self.sequence=0
        self.members=[member(1),member(2),member(3,'site')]
        self.room_id=None
        await self.sync()

    async def asyncTearDown(self):
        self.patch.stop();self.temp.cleanup()

    async def sync(self,state='running',fresh=False,resume=False,members=None):
        self.sequence+=1
        members=self.members if members is None else members
        result=None
        for offset in range(0,max(1,len(members)),8):
            result=await self.service.dispatch('sync',dict(owner='fixture',chromeGroupId=10,roomId=self.room_id,snapshotId='snapshot_'+str(self.sequence).zfill(10),offset=offset,members=members[offset:offset+8],complete=offset+8>=len(members),state=state,fresh=fresh,resume=resume))
        self.room_id=result['roomId'];return result

    async def send(self,text='Hello',sender=1,request='request_0123456789'):
        return await self.service.dispatch('post',dict(roomId=self.room_id,senderTabId=sender,chatPath=next(m['chatPath'] for m in self.members if m['tabId']==sender),text=text,requestId=request))

    async def read(self,tab_id=2,**options):
        return await self.service.dispatch('read',dict(roomId=self.room_id,chatTabId=tab_id,chatPath=next(m['chatPath'] for m in self.members if m['tabId']==tab_id),**options))

    async def summary(self,tab_id=2):
        return await self.service.dispatch('summary',dict(roomId=self.room_id,chatTabId=tab_id,chatPath=next(m['chatPath'] for m in self.members if m['tabId']==tab_id)))

    async def test_publication_idempotency_and_plain_text_history(self):
        text='Кириллица\n<script>data</script>'
        receipt=await self.send(text=text)
        self.assertEqual(await self.send(text=text),receipt)
        self.assertEqual(set(receipt),{'messageId','status'})
        history=await self.service.view(self.room_id)
        self.assertEqual(len(history['entries']),1)
        self.assertEqual(set(history['entries'][0]),{'id','time','senderTabId','text'})
        self.assertEqual(history['entries'][0]['text'],text)
        self.assertNotIn('chatPath',json.dumps(history))
        saved=(self.root/'group-chats'/self.room_id/'history.txt').read_text()
        self.assertIn('Кириллица',saved);self.assertIn('\\n<script>',saved)
        for action in ['send','pending','delivery']:
            with self.assertRaises(agent.AgentApiError):await self.service.dispatch(action,dict(roomId=self.room_id))
        with self.assertRaises(agent.AgentApiError):await self.send(text='changed')
        with self.assertRaises(agent.AgentApiError):await self.service.dispatch('post',dict(roomId=self.room_id,senderTabId=1,chatPath='/c/chat1',text='x',requestId='request_other00000',recipientTabIds=[2]))

    async def test_durable_per_conversation_cursor_and_own_post(self):
        for i in range(3):await self.send(text='Message '+str(i),request='request_'+str(i).zfill(10))
        self.assertEqual((await self.summary())['unreadCount'],3)
        self.assertEqual((await self.summary(1))['unreadCount'],0)
        first=await self.read(limit=2)
        self.assertEqual([e['text'] for e in first['entries']],['Message 0','Message 1']);self.assertTrue(first['hasMore'])
        await self.read(afterId=0);await self.read(beforeId=first['lastId'])
        self.assertEqual((await self.summary())['unreadCount'],1,'explicit cursors do not acknowledge')
        await self.send(sender=2,text='Own post',request='request_own0000000')
        self.assertEqual((await self.summary())['unreadCount'],1,'posting must not skip unread peers')
        await self.service.view(self.room_id)
        self.assertEqual((await self.summary())['unreadCount'],1,'viewing must not acknowledge')
        self.service=GroupChatService(agent)
        remaining=await self.read()
        self.assertEqual([e['text'] for e in remaining['entries']],['Message 2','Own post'])
        self.assertFalse(remaining['hasMore']);self.assertEqual((await self.summary())['unreadCount'],0)
        self.assertEqual((await self.read())['entries'],[])
        self.members[1]=member(2,path='/c/another');await self.sync()
        self.assertEqual(len((await self.read())['entries']),4,'new conversation gets its own initial cursor')

    async def test_events_are_internal_and_stop_survives_restart(self):
        for i in range(8):await self.send(text='Message '+str(i),request='request_'+str(i).zfill(10))
        latest=await self.service.view(self.room_id,dict(limit=3))
        self.assertEqual(len(latest['entries']),3);self.assertTrue(latest['hasOlder'])
        older=await self.service.view(self.room_id,dict(beforeId=latest['firstId'],limit=3))
        self.assertLess(older['lastId'],latest['firstId'])
        forward=await self.service.view(self.room_id,dict(afterId=older['lastId'],limit=3))
        self.assertEqual(forward['entries'],latest['entries'])
        self.members.append(member(4));await self.sync()
        self.assertEqual(len((await self.service.view(self.room_id))['entries']),8)
        self.assertEqual((await self.summary())['unreadCount'],8)
        await self.sync('stopped');self.service=GroupChatService(agent);self.room_id=None
        await self.sync();self.assertEqual(self.service.rooms[self.room_id].state,'stopped')
        with self.assertRaises(agent.AgentApiError):await self.send(request='request_stopped000')
        self.assertEqual(len((await self.read())['entries']),8,'history available while stopped')
        await self.sync(resume=True);self.assertEqual(self.service.rooms[self.room_id].state,'running')
        with self.assertRaises(agent.AgentApiError):await self.read(afterId=0,beforeId=1)

    async def test_legacy_logs_never_replay_or_rewrite_outbox(self):
        room=self.service.rooms[self.room_id]
        message=room.append(dict(kind='message',senderTabId=1,text='Legacy addressed publication',recipientTabIds=[2],recipients=[dict(tabId=2,chatPath='/c/chat2')]))
        room.append(dict(kind='delivery',tabId=2,messageIds=[message['id']],state='attempting'))
        room.append(dict(kind='event',event='notification_failed',text='Old failure',recipientTabIds=[]))
        original=room.path.read_bytes()
        self.service=GroupChatService(agent)
        history=await self.service.view(self.room_id)
        self.assertEqual(room.path.read_bytes(),original)
        self.assertEqual(len(history['entries']),1)
        self.assertEqual(history['entries'][0]['text'],'Legacy addressed publication')
        self.assertNotIn('recipient',json.dumps(history))
        await self.send(request='request_newboard00')
        added=room.path.read_bytes()[len(original):]
        self.assertNotIn(b'recipient',added);self.assertNotIn(b'delivery',added)

    async def test_large_group_and_actual_bounded_pagination(self):
        self.members=[member(i) for i in range(1,252)];await self.sync()
        self.assertEqual(len(self.service.rooms[self.room_id].members),251)
        for i in range(6):await self.send(text=('Long text 🐈 '+str(i))*700,request='request_'+str(i).zfill(10))
        seen=[]
        for _ in range(10):
            page=await self.read(limit=100)
            self.assertLess(len(json.dumps(page,ensure_ascii=False).encode('utf-16-le'))//2,32000)
            seen.extend(e['id'] for e in page['entries'])
            if not page['hasMore']:break
        self.assertEqual(len(seen),6);self.assertEqual(len(set(seen)),6)
        self.assertEqual((await self.summary())['unreadCount'],0)
        self.assertEqual((await self.summary(251))['unreadCount'],6)

    async def test_cursor_failure_is_explicit_and_participants_are_verified(self):
        await self.send()
        for action in ['summary','read']:
            for tab_id,path in [(2,'/c/not-the-same'),(999,'/c/chat2'),(3,'')]:
                with self.assertRaises(agent.AgentApiError):await self.service.dispatch(action,dict(roomId=self.room_id,chatTabId=tab_id,chatPath=path))
        with patch('agent.group_chat.os.fsync',side_effect=OSError('PRIVATE cursor path')):
            with self.assertRaises(agent.AgentApiError) as error:await self.read()
        self.assertEqual(error.exception.code,'GROUP_CHAT_IO');self.assertNotIn('PRIVATE',error.exception.message)
        # No acknowledgement response was returned; reloading remains safe.
        self.assertEqual((await self.service.view(self.room_id))['entries'][0]['text'],'Hello')

    async def test_heavily_escaped_publication_is_not_lost(self):
        text='prefix'+chr(1)*11990
        await self.send(text=text)
        result=await self.read()
        self.assertEqual(result['entries'][0]['text'],text)
        self.assertEqual((await self.summary())['unreadCount'],0)
        self.assertEqual((await self.read())['entries'],[])

    async def test_workspace_redirect_and_disk_failure_are_explicit(self):
        await self.send()
        with patch('agent.group_chat.os.fsync',side_effect=OSError('PRIVATE path')):
            with self.assertRaises(agent.AgentApiError) as error:await self.send(request='request_fs_failure')
        self.assertEqual(error.exception.code,'GROUP_CHAT_IO')
        self.assertNotIn('PRIVATE',error.exception.message)
        directory=self.root/'group-chats'/self.room_id
        directory.rename(self.root/'saved')
        directory.symlink_to(self.root/'saved',target_is_directory=True)
        with self.assertRaises(agent.AgentApiError):await self.service.view(self.room_id)

    async def test_cancelled_caller_does_not_release_an_active_file_write(self):
        room=self.service.rooms[self.room_id]
        original=room.append
        entered,release=threading.Event(),threading.Event()
        def append(record):
            if record.get('text')=='blocked':
                entered.set();release.wait(5)
            return original(record)
        with patch.object(room,'append',side_effect=append):
            first=asyncio.create_task(self.send(text='blocked',request='request_blocked123'))
            await asyncio.to_thread(entered.wait,2)
            first.cancel()
            second=asyncio.create_task(self.send(text='second',request='request_second1234'))
            await asyncio.sleep(0)
            self.assertFalse(first.done());self.assertFalse(second.done())
            release.set()
            with self.assertRaises(asyncio.CancelledError):await first
            await second
        records=(await self.service.view(self.room_id))['entries']
        messages=records
        self.assertEqual([e['text'] for e in messages],['blocked','second'])
        self.assertLess(messages[0]['id'],messages[1]['id'])

    async def test_loopback_view_is_read_only_and_rejects_web_writes(self):
        with patch.object(agent,'GROUP_CHAT',self.service):
            server=await asyncio.start_server(agent.handle_client,'127.0.0.1',0)
            async def request(method,path,payload=None,origin=None):
                reader,writer=await asyncio.open_connection('127.0.0.1',server.sockets[0].getsockname()[1])
                body=json.dumps(payload).encode() if payload is not None else b''
                header=f'{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {len(body)}\r\n'+(f'Origin: {origin}\r\n' if origin else '')+'\r\n'
                writer.write(header.encode()+body);await writer.drain();data=await reader.read();writer.close();await writer.wait_closed();return data
            try:
                view=await request('GET','/group-chat/'+self.room_id)
                self.assertIn(b'200 OK',view);self.assertIn(b'ResearchTube Board',view)
                self.assertNotIn(b'Access-Control-Allow-Origin: *',view)
                history=await request('GET','/group-chat/'+self.room_id+'/entries?limit=2')
                self.assertIn(b'200 OK',history)
                rejected=await request('POST','/internal/group-chat/send',dict(roomId=self.room_id),origin='https://evil.test')
                self.assertIn(b'400 Bad Request',rejected)
                self.assertNotIn('innerHTML',VIEW_HTML)
                self.assertNotIn('<textarea',VIEW_HTML);self.assertNotIn('<input',VIEW_HTML)
                for visible in ['<header','<h1','<button','position:sticky','position:fixed','recipientTabIds','participants']:
                    self.assertNotIn(visible,VIEW_HTML)
                self.assertIn('scrollY<100',VIEW_HTML)
                self.assertIn('messages.prepend',VIEW_HTML)
            finally:server.close();await server.wait_closed()
