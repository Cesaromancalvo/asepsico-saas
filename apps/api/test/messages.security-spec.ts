import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MessagesService } from '../src/messages/messages.service';

const owner:any={sub:'o1',workspaceId:'w1',role:'OWNER'};
const therapist:any={sub:'t1',workspaceId:'w1',role:'THERAPIST'};
const assistant:any={sub:'a1',workspaceId:'w1',role:'ASSISTANT'};

function mock(){
  return {
    patient:{findFirst:jest.fn()},
    clinicalProcess:{findFirst:jest.fn(),findMany:jest.fn()},
    conversation:{findMany:jest.fn(),findFirst:jest.fn(),upsert:jest.fn(),update:jest.fn()},
    message:{findMany:jest.fn(),updateMany:jest.fn(),create:jest.fn()},
    notification:{createMany:jest.fn()},
    auditLog:{create:jest.fn()},
  } as any;
}

describe('Structured messages security and persistence',()=>{
  it('blocks administrative assistants from clinical messages',async()=>{
    const p=mock();
    await expect(new MessagesService(p).list('w1',assistant)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('scopes therapist conversations to assigned patients and returns unread count',async()=>{
    const p=mock();
    p.conversation.findMany.mockResolvedValue([{id:'c1',messages:[],_count:{messages:2}}]);
    p.message.findMany.mockResolvedValue([{conversationId:'c1'},{conversationId:'c1'}]);
    const rows=await new MessagesService(p).list('w1',therapist);
    expect(p.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({workspaceId:'w1',patient:expect.objectContaining({clinicalProcesses:{some:{therapistId:'t1'}}})})}));
    expect(rows[0].unreadCount).toBe(2);
  });

  it('does not expose a conversation from another workspace',async()=>{
    const p=mock();p.conversation.findFirst.mockResolvedValue(null);
    await expect(new MessagesService(p).thread('w1',owner,'foreign')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('notifies patient without copying clinical message body',async()=>{
    const p=mock();
    p.conversation.findFirst.mockResolvedValue({id:'c1',workspaceId:'w1',patientId:'p1',status:'OPEN'});
    p.patient.findFirst.mockResolvedValue({id:'p1'});
    p.message.create.mockResolvedValue({id:'m1'});
    p.conversation.update.mockResolvedValue({});
    p.notification.createMany.mockResolvedValue({count:1});
    await new MessagesService(p).send('w1',owner,'c1',{body:'Contenido clínico sensible'} as any);
    const row=p.notification.createMany.mock.calls[0][0].data[0];
    expect(row.body).toBe('Tienes un nuevo mensaje de tu profesional.');
    expect(row.body).not.toContain('Contenido clínico');
    expect(row.dedupeKey).toBe('message:m1:patient');
  });

  it('notifies only assigned active therapists after patient reply',async()=>{
    const p=mock();
    p.conversation.findFirst.mockResolvedValue({id:'c1',workspaceId:'w1',patientId:'p1',status:'OPEN',patientCanReply:true});
    p.message.create.mockResolvedValue({id:'m2'});
    p.conversation.update.mockResolvedValue({});
    p.clinicalProcess.findMany.mockResolvedValue([{therapistId:'t1'},{therapistId:'t1'}]);
    p.notification.createMany.mockResolvedValue({count:1});
    await new MessagesService(p).portalSend({workspaceId:'w1',patientId:'p1'},{body:'Necesito comentar algo'} as any);
    const rows=p.notification.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({userId:'t1',body:'Un paciente ha enviado un mensaje.',actionUrl:'/messages?patientId=p1'}));
  });

  it('rejects patient replies when professional has closed the channel',async()=>{
    const p=mock();p.conversation.findFirst.mockResolvedValue({id:'c1',status:'OPEN',patientCanReply:false});
    await expect(new MessagesService(p).portalSend({workspaceId:'w1',patientId:'p1'},{body:'hola'} as any)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects incomplete or unsafe attachment metadata',async()=>{
    const p=mock();
    await expect(new MessagesService(p).portalSend({workspaceId:'w1',patientId:'p1'},{body:'hola',attachmentName:'x.exe'} as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(new MessagesService(p).portalSend({workspaceId:'w1',patientId:'p1'},{body:'hola',attachmentName:'x.exe',attachmentKey:'private/x',mimeType:'application/x-msdownload'} as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});
