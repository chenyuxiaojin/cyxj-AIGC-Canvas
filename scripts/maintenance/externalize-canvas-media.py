"""Offline, target-only migration. Requires verified backup, app stopped and ijson.
Streams SQLite BLOBs/UTF-16 IDB strings; only a single original image is decoded at once.
All drafts and historical snapshots are transformed independently; never replace one with another.
"""
import argparse, base64, collections, hashlib, io, json, os, sqlite3, struct, sys
from pathlib import Path
import ijson

P=argparse.ArgumentParser();P.add_argument('--database',required=True);P.add_argument('--indexeddb',required=True);P.add_argument('--media-root',required=True);P.add_argument('--evidence',required=True);P.add_argument('--project',required=True);P.add_argument('--apply',action='store_true');A=P.parse_args()
E=Path(A.evidence);E.mkdir(parents=True,exist_ok=True);ROOT=Path(A.media_root);TARGET=A.project
MANIFEST={};RECORDS=[];REVISIONS={}
def digest(b):return hashlib.sha256(b).hexdigest()
def encode(v):return json.dumps(v,ensure_ascii=False,separators=(',',':')).encode()
def store(data):
 header,b64=data.split(',',1);mime=header[5:].removesuffix(';base64');ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[mime]
 raw=base64.b64decode(b64,validate=True);sha=digest(raw);asset='asset-'+sha[:32];rel=f'owned/{asset}.{ext}';path=ROOT/rel
 ref={'assetId':asset,'storageKey':'local-ref:'+asset,'rootId':'project-media','relativePath':rel,'sha256':sha,'mimeType':mime,'bytes':len(raw),'fileName':asset+'.'+ext,'mode':'project_copy'}
 path.parent.mkdir(parents=True,exist_ok=True)
 if path.exists():assert hashlib.file_digest(path.open('rb'),'sha256').hexdigest()==sha
 else:
  with path.open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
 MANIFEST[sha]=ref
 return '@original-media-sha256:'+sha
class BlobReader(io.RawIOBase):
 def __init__(self,blob):self.blob=blob
 def readable(self):return True
 def readinto(self,b):
  data=self.blob.read(len(b));b[:len(data)]=data;return len(data)
def parse(blob,idb=False,legacy=False):
 if idb:
  header=blob.read(9);version,tag,length=struct.unpack('<IBI',header);assert version==15 and tag==16
  latin=bool(length&0x80000000);chars=length&0x7fffffff;assert len(blob)==9+chars*(1 if latin else 2)
  reader=io.TextIOWrapper(io.BufferedReader(BlobReader(blob)),encoding='latin1' if latin else 'utf-16-le')
 else:reader=blob
 builder=ijson.ObjectBuilder();occurrences=0
 for event,value in ijson.basic_parse(reader,use_float=True):
  if not legacy and event=='string' and value.startswith('data:image/'):
   value=store(value);occurrences+=1
  builder.event(event,value)
 if legacy:
  def mark(v):
   nonlocal occurrences
   if isinstance(v,dict):
    for k,x in list(v.items()):
     if isinstance(x,str) and x.startswith('data:image/'):v[k]=store(x);occurrences+=1
     else:mark(x)
   elif isinstance(v,list):
    for i,x in enumerate(v):
     if isinstance(x,str) and x.startswith('data:image/'):v[i]=store(x);occurrences+=1
     else:mark(x)
  for project in builder.value.get('state',{}).get('projects',[]):
   if project.get('id')==TARGET:mark(project)
 return builder.value,occurrences

def rewrite(value):
 changes=[]
 def walk(obj,path):
  if isinstance(obj,list):
   for i,v in enumerate(obj):walk(v,path+[i])
  elif isinstance(obj,dict):
   for k,v in list(obj.items()):
    if isinstance(v,str) and v.startswith('@original-media-sha256:'):
     ref=MANIFEST[v.split(':',1)[1]]
     changes.append({'path':path+[k],'sha256':ref['sha256'],'old_fields':{f:obj[f] for f in ['storageKey','localMedia'] if f in obj},'added_fields':[f for f in ['storageKey','localMedia'] if f not in obj]})
     obj[k]=ref['storageKey']
     if k=='content':obj['storageKey']=ref['storageKey'];obj['localMedia']=ref
    else:walk(v,path+[k])
 walk(value,[])
 return changes

def migrate(c,table,column,rowid,label,idb=False,legacy=False):
 with c.blobopen(table,column,rowid,readonly=True) as blob:
  old_bytes=len(blob);h=hashlib.sha256()
  while chunk:=blob.read(1024*1024):h.update(chunk)
  old_hash=h.hexdigest();blob.seek(0)
  if legacy:assert old_bytes < 64*1024*1024, "Legacy archive needs streaming project extraction"
  value,count=parse(blob,idb,legacy)
 if not count:return
 skeleton=encode(value);changes=rewrite(value)
 # Prove every unrelated field and all graph structure unchanged.
 restored=json.loads(encode(value))
 for change in reversed(changes):
  obj=restored
  for k in change['path'][:-1]:obj=obj[k]
  key=change['path'][-1];obj[key]='@original-media-sha256:'+change['sha256']
  if key=='content':
   for f in change['added_fields']:obj.pop(f,None)
   obj.update(change['old_fields'])
 assert encode(restored)==skeleton
 if idb:
  def revisions(v):
   if isinstance(v,dict):
    if '__desktopRevision' in v and v['__desktopRevision'] in REVISIONS:v['__desktopRevision']=REVISIONS[v['__desktopRevision']]
    for a in v.values():revisions(a)
   elif isinstance(v,list):
    for a in v:revisions(a)
  revisions(value)
 raw=encode(value);new_hash=digest(raw);REVISIONS[old_hash]=new_hash
 (E/(label+'.json')).write_bytes(raw)
 stored=struct.pack('<IBI',15,16,len(raw.decode().encode('utf-16-le'))//2)+raw.decode().encode('utf-16-le') if idb else raw.decode()
 if A.apply:
  c.execute(f'UPDATE {table} SET {column}=? WHERE rowid=?',(stored,rowid))
  if table=='canvas_version_history':c.execute('UPDATE canvas_version_history SET revision=?,bytes=? WHERE rowid=?',(new_hash,len(raw),rowid))
  check=c.execute(f'SELECT {column} FROM {table} WHERE rowid=?',(rowid,)).fetchone()[0];assert check==stored
 RECORDS.append({'label':label,'rowid':rowid,'old_bytes':old_bytes,'new_bytes':len(stored) if idb else len(raw),'old_sha256':old_hash,'new_sha256':new_hash,'occurrences':count,'structure_verified':True,'changes':changes})
 print(label,old_bytes,'->',len(raw),count,flush=True)

c=sqlite3.connect(A.database);c.execute('BEGIN IMMEDIATE')
for rowid, in c.execute('SELECT rowid FROM canvas_projects WHERE id=? AND deleted_at=""',(TARGET,)).fetchall():migrate(c,'canvas_projects','project_data',rowid,'project')
for table,col in [('canvas_version_history','snapshot'),('agent_operation_requests','response_json'),('canvas_commands','request_json'),('canvas_commands','result_json')]:
 for rowid, in c.execute(f'SELECT rowid FROM {table} WHERE project_id=? AND {col} IS NOT NULL',(TARGET,)).fetchall():migrate(c,table,col,rowid,f'{table}-{rowid}-{col}')
if A.apply:
 for old,new in REVISIONS.items():
  for column in ['base_revision','result_revision']:
   c.execute(f'UPDATE canvas_version_restores SET {column}=? WHERE project_id=? AND {column}=?',(new,TARGET,old))
 c.commit()
else:c.rollback()
c.close()
c=sqlite3.connect(A.indexeddb);c.create_collation('IDBKEY',lambda a,b:(a>b)-(a<b));c.execute('BEGIN IMMEDIATE')
for rowid,key in c.execute('SELECT recordID,cast(key as blob) FROM Records').fetchall():
 try:name=key[6:].decode('utf-16-le')
 except UnicodeDecodeError:continue
 if name=='infinite-canvas:canvas_store':migrate(c,'Records','value',rowid,'idb-legacy-'+str(rowid),True,True)
 if TARGET in name and name.startswith(('infinite-canvas:canvas_project:','infinite-canvas:save-journal:','infinite-canvas:save-archive:','infinite-canvas:recovery:')):
  migrate(c,'Records','value',rowid,'idb-'+str(rowid),True)
if A.apply:c.commit()
else:c.rollback()
c.close()
for ref in MANIFEST.values():assert hashlib.file_digest((ROOT/ref['relativePath']).open('rb'),'sha256').hexdigest()==ref['sha256']
(E/'migration-report.json').write_text(json.dumps({'project':TARGET,'applied':A.apply,'unique_images':len(MANIFEST),'media_bytes':sum(r['bytes'] for r in MANIFEST.values()),'records':RECORDS,'media':MANIFEST},ensure_ascii=False,indent=2))
print('verified images',len(MANIFEST),flush=True)
