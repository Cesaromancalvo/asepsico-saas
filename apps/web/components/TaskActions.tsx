'use client';

/** Estados de una tarea terapéutica (mismos valores que la API). */
export type TaskStatus='DRAFT'|'PENDING'|'IN_PROGRESS'|'SUBMITTED'|'CHANGES_REQUESTED'|'COMPLETED'|'CANCELLED';

type TaskActionsProps={task:{status:TaskStatus};busy:boolean;onAssign:()=>void;onRemoveDraft:()=>void;onComplete:()=>void;onRequestChanges:()=>void;onReopen:()=>void;onCancel:()=>void};

/** Acción principal (botón primario, ancho completo en móvil) y secundarias debajo, según el estado. */
export default function TaskActions({task,busy,onAssign,onRemoveDraft,onComplete,onRequestChanges,onReopen,onCancel}:TaskActionsProps){
 const s=task.status;
 const primary=s==='DRAFT'?{label:'Asignar',run:onAssign}:s==='SUBMITTED'?{label:'Completar tras revisión',run:onComplete}:null;
 const secondary:Array<{label:string;run:()=>void;danger?:boolean}>=[];
 if(s==='DRAFT')secondary.push({label:'Eliminar borrador',run:onRemoveDraft,danger:true});
 if(s==='SUBMITTED')secondary.push({label:'Solicitar cambios',run:onRequestChanges});
 if(s==='COMPLETED')secondary.push({label:'Reabrir',run:onReopen});
 if(!['DRAFT','COMPLETED','CANCELLED'].includes(s))secondary.push({label:'Cancelar tarea',run:onCancel,danger:true});
 if(!primary&&!secondary.length)return null;
 return <div className="task-card-actions">
  {primary&&<button type="button" className="button task-action-primary" disabled={busy} onClick={primary.run}>{busy?'Guardando…':primary.label}</button>}
  {secondary.length>0&&<div className="task-card-actions-secondary">{secondary.map(a=><button type="button" key={a.label} className={`task-action-secondary${a.danger?' danger':''}`} disabled={busy} onClick={a.run}>{a.label}</button>)}</div>}
 </div>;
}
