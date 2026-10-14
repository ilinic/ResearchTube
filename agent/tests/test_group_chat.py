"""Real journal persistence, routing, recovery, bounds and loopback views."""
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

    async def send(self,text='Hello',sender=1,recipients=None,request='request_0123456789'):
        return await self.service.dispatch('send',dict(roomId=self.room_id,senderTabId=sender,text=text,requestId=request,**({} if recipients is None else {'recipientTabIds':recipients})))

    async def pending(self,after=-1):
        return (await self.service.dispatch('pending',dict(roomId=self.room_id,afterTabId=after)))['batches']

    async def test_broadcast_direct_idempotency_and_plain_text_history(self):
        receipt=await self.send(text='Кириллица\n<script>data</script>')
        self.assertEqual(receipt['recipientTabIds'],[2])
        self.assertEqual(await self.send(text='Кириллица\n<script>data</script>'),receipt)
        pending=await self.pending();self.assertEqual(pending[0]['tabId'],2)
        self.assertEqual(pending[0]['senderTabIds'],[1])
        history=await self.service.view(self.room_id)
        messages=[e for e in history['entries'] if e['kind']=='message']
        self.assertEqual(len(messages),1)
        self.assertNotIn('recipients',messages[0]);self.assertNotIn('chatPath',json.dumps(history))
        text=(self.root/'group-chats'/self.room_id/'history.txt').read_text()
        self.assertIn('Кириллица',text)
        self.assertIn('\\n<script>',text)
        for recipients in [[],[3],[1,1],[999]]:
            with self.assertRaises(agent.AgentApiError):await self.send(recipients=recipients,request='request_other00000')

    async def test_restart_recovers_queue_and_exact_conversation_guards(self):
        await self.send()
        self.service=GroupChatService(agent);self.room_id=None
        recovered=await self.sync()
        self.assertTrue(recovered['roomId'])
        batches=await self.pending();self.assertEqual(len(batches),1)
        await self.service.dispatch('delivery',dict(roomId=self.room_id,tabId=2,messageIds=batches[0]['messageIds'],state='attempting'))
        self.service=GroupChatService(agent)
        self.assertEqual(await self.pending(),[], 'uncertain in-flight sends must not replay after a crash')
        await self.send(request='request_different1')
        self.members[1]=member(2,path='/c/another')
        await self.sync()
        self.assertEqual(await self.pending(),[], 'new conversation must not receive old messages')

    async def test_events_views_independence_paging_filters_and_stop(self):
        for i in range(8): await self.send(text='Message '+str(i),request='request_'+str(i).zfill(10))
        latest=await self.service.view(self.room_id,dict(limit=3))
        self.assertEqual(len(latest['entries']),3);self.assertTrue(latest['hasOlder'])
        older=await self.service.view(self.room_id,dict(beforeId=latest['firstId'],limit=3))
        self.assertLess(older['lastId'],latest['firstId'])
        forward=await self.service.view(self.room_id,dict(afterId=older['lastId'],limit=3))
        self.assertEqual(forward['entries'],latest['entries'])
        before=len(await self.pending())
        await self.service.view(self.room_id);await self.service.view(self.room_id)
        self.assertEqual(len(await self.pending()),before,'views cannot consume notifications')
        self.members.append(member(4));await self.sync()
        self.assertTrue(any(e.get('event')=='participant_joined' and e.get('tabId')==4 for e in (await self.service.view(self.room_id))['entries']))
        await self.sync('stopped');self.assertEqual(await self.pending(),[])
        await self.sync();self.assertEqual(self.service.rooms[self.room_id].state,'stopped','recovery must not undo Stop')
        await self.sync(resume=True);self.assertEqual(self.service.rooms[self.room_id].state,'running')
        with self.assertRaises(agent.AgentApiError):await self.service.view(self.room_id,dict(afterId=0,beforeId=1))

    async def test_large_group_chunked_snapshot_has_no_participant_cap(self):
        self.members=[member(i) for i in range(1,252)]
        await self.sync()
        self.assertEqual(len(self.service.rooms[self.room_id].members),251)
        receipt=await self.send()
        self.assertEqual(receipt['recipientCount'],250)
        self.assertEqual(len(receipt['recipientTabIds']),200)
        self.assertEqual(len(await self.pending()),20)
        self.assertTrue(all(b['tabId']>20 for b in await self.pending(after=20)))

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
        messages=[e for e in records if e['kind']=='message']
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
                self.assertIn(b'200 OK',view);self.assertIn(b'Read-only',view)
                self.assertNotIn(b'Access-Control-Allow-Origin: *',view)
                history=await request('GET','/group-chat/'+self.room_id+'/entries?limit=2')
                self.assertIn(b'200 OK',history)
                rejected=await request('POST','/internal/group-chat/send',dict(roomId=self.room_id),origin='https://evil.test')
                self.assertIn(b'400 Bad Request',rejected)
                self.assertNotIn('innerHTML',VIEW_HTML)
                self.assertNotIn('<textarea',VIEW_HTML);self.assertNotIn('<input',VIEW_HTML)
            finally:server.close();await server.wait_closed()
