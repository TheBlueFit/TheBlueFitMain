import os, io, json, time, urllib.request, urllib.error, subprocess, sys, random
os.environ.update(AWS_ACCESS_KEY_ID='test', AWS_SECRET_ACCESS_KEY='test', AWS_DEFAULT_REGION='us-east-1')
import boto3
from PIL import Image
from datetime import datetime, timezone, timedelta
import pillow_heif
EP='http://127.0.0.1:5555'; API='http://127.0.0.1:8788'; BUCKET='bluefit-test-media'
s3=boto3.client('s3', endpoint_url=EP); t=boto3.resource('dynamodb', endpoint_url=EP).Table('BlueFit-Table')
try: s3.create_bucket(Bucket=BUCKET)
except Exception as e: pass
passed=failed=0
def check(label, cond, extra=''):
    global passed, failed
    if cond: passed+=1; print('  PASS ', label)
    else: failed+=1; print('  FAIL ', label, extra)
def call(method, path, body=None, token=None, expect=200):
    req=urllib.request.Request(API+path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type':'application/json', **({'Authorization':f'Bearer {token}'} if token else {})})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or '{}')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or '{}')
def login(u,p): return call('POST','/auth/login',{'identifier':u,'password':p})[1]['token']
admin=login('ADH0001','AdminPass12345'); client=login('CLS0001','Passw0rd!2345')
prof={i['userCode']:i for i in t.scan()['Items'] if i.get('SK')=='PROFILE#BASELINE' and i.get('userCode')}
cpk=prof['CLS0001']['PK']; coach_pk=prof['CHC0001']['PK']; cshort=cpk.split('#')[1]; chs=coach_pk.split('#')[1]

def photo_bytes(fmt, size=(3000,2000), orient=None):
    img=Image.new('RGB',size); px=img.load(); random.seed(1)
    for y in range(0,size[1],4):
        for x in range(0,size[0],4):
            for dx in range(4):
                for dy in range(4):
                    if x+dx<size[0] and y+dy<size[1]: px[x+dx,y+dy]=(random.randint(0,255),(x*255)//size[0],(y*255)//size[1])
    b=io.BytesIO()
    if fmt=='HEIC': pillow_heif.from_pillow(img).save(b, quality=90)
    elif fmt=='JPEG':
        ex=Image.Exif(); 
        if orient: ex[0x0112]=orient
        img.save(b,'JPEG',quality=95, exif=ex)
    else: img.save(b,fmt)
    return b.getvalue()

old=(datetime.now(timezone.utc)).isoformat(timespec='milliseconds')            # 30 days old in the test server's clock
new=(datetime.now(timezone.utc)+timedelta(days=25)).isoformat(timespec='milliseconds')  # 5 days old
def meal(day, name, data, ct, uploaded=old, ext='jpg'):
    key=f'clients/{cshort}/3-day-log/day-{day}/{name}.{ext}'
    s3.put_object(Bucket=BUCKET, Key=key, Body=data, ContentType=ct)
    t.put_item(Item={'PK':cpk,'SK':f'3DAYPHOTO#DAY{day}#{name.upper()}','type':'THREE_DAY_PHOTO','day':day,'meal':name,'objectKey':key,'contentType':ct,'size':len(data),'uploadedAt':uploaded,'createdAt':uploaded})
    return key
k1=meal(1,'breakfast',photo_bytes('JPEG',orient=6),'image/jpeg')
k2=meal(1,'lunch',photo_bytes('PNG',(1600,1000)),'image/png',ext='png')
k3=meal(2,'dinner',photo_bytes('HEIC',(2400,1600)),'image/heic',ext='heic')
k4=meal(2,'snacks',b'this is not an image','image/jpeg')
k5=meal(3,'brunch',photo_bytes('JPEG',(1200,800)),'image/jpeg',uploaded=new)
k6=meal(3,'lunch',photo_bytes('JPEG',(1200,800)),'image/webp',ext='webp')
tkey=f'coaches/{chs}/templates/ref1.jpg'; s3.put_object(Bucket=BUCKET,Key=tkey,Body=photo_bytes('JPEG',(2200,1500)),ContentType='image/jpeg')
t.put_item(Item={'PK':coach_pk,'SK':'TEMPLATE#tpl_cleanup1','type':'TEMPLATE','title':'Cleanup test','referenceImageKey':tkey,'exercises':[],'updatedAt':old,'createdAt':old})
t.put_item(Item={'PK':cpk,'SK':'ASSIGNEDPLAN#cleanup1','type':'ASSIGNED','referenceImageKey':tkey})
before_total=sum(s3.head_object(Bucket=BUCKET,Key=k)['ContentLength'] for k in (k1,k2,k3,tkey))
print('== permissions & validation')
check('client cannot preview (403)', call('GET','/admin/cleanup/preview?days=15',token=client)[0]==403)
check('days below minimum rejected (400)', call('GET','/admin/cleanup/preview?days=3',token=admin)[0]==400)
check('no category rejected (400)', call('POST','/admin/cleanup/run',{'days':15,'categories':['progress']},admin)[0]==400)
print('== preview (dry run)')
st,pv=call('GET','/admin/cleanup/preview?days=15',token=admin)
check('preview ok', st==200, pv)
check('meal candidates = 4 (3 good + 1 corrupt)', pv['categories']['mealPhotos']['count']==4, pv)
check('template candidates = 1', pv['categories']['templateImages']['count']==1, pv)
check('recent photo and .webp not offered', pv['total']['count']==5, pv)
check('preview changed nothing', all(s3.head_object(Bucket=BUCKET,Key=k) for k in (k1,k2,k3,tkey)))
print('== run')
rid='test-run-1'; tot={'converted':0,'failed':0,'nogain':0}; errors=[]; calls=0
while True:
    st,r=call('POST','/admin/cleanup/run',{'days':15,'categories':['mealPhotos','templateImages'],'runId':rid},admin); calls+=1
    if st!=200: print(r); break
    for k in tot: tot[k]+=r[k]
    errors+=r['errors']
    if r['done'] or calls>10: break
check('converted 4 (3 meals + 1 template)', tot['converted']==4, tot)
check('corrupt file failed, flagged, not retried forever', tot['failed']==1 and calls<=3, (tot,calls))
def exists(k):
    try: s3.head_object(Bucket=BUCKET,Key=k); return True
    except Exception: return False
w1=k1.rsplit('.',1)[0]+'.webp'; w2=k2.rsplit('.',1)[0]+'.webp'; w3=k3.rsplit('.',1)[0]+'.webp'; wt=tkey.rsplit('.',1)[0]+'.webp'
check('originals deleted', not any(exists(k) for k in (k1,k2,k3,tkey)))
check('webp copies exist as image/webp', all(s3.head_object(Bucket=BUCKET,Key=k)['ContentType']=='image/webp' for k in (w1,w2,w3,wt)))
after_total=sum(s3.head_object(Bucket=BUCKET,Key=k)['ContentLength'] for k in (w1,w2,w3,wt))
print(f'   bytes before {before_total:,} -> after {after_total:,} ({100-after_total*100//before_total}% smaller)')
check('storage shrank', after_total<before_total)
im=Image.open(io.BytesIO(s3.get_object(Bucket=BUCKET,Key=w1)['Body'].read())); print('   rotated+capped size', im.size, im.format)
check('EXIF rotation honoured + capped at 2000px', im.format=='WEBP' and im.size[0]<im.size[1] and max(im.size)<=2000)
im3=Image.open(io.BytesIO(s3.get_object(Bucket=BUCKET,Key=w3)['Body'].read())); check('HEIC iPhone photo converted', im3.format=='WEBP')
d1=t.get_item(Key={'PK':cpk,'SK':'3DAYPHOTO#DAY1#BREAKFAST'})['Item']
check('DB record re-pointed (key, type, size, audit fields)', d1['objectKey']==w1 and d1['contentType']=='image/webp' and int(d1['size'])==s3.head_object(Bucket=BUCKET,Key=w1)['ContentLength'] and d1['originalObjectKey']==k1 and 'convertedAt' in d1, d1)
check('template re-pointed', t.get_item(Key={'PK':coach_pk,'SK':'TEMPLATE#tpl_cleanup1'})['Item']['referenceImageKey']==wt)
check('assigned plan copy re-pointed too', t.get_item(Key={'PK':cpk,'SK':'ASSIGNEDPLAN#cleanup1'})['Item']['referenceImageKey']==wt)
check('corrupt original kept + flagged', exists(k4) and 'cleanupError' in t.get_item(Key={'PK':cpk,'SK':'3DAYPHOTO#DAY2#SNACKS'})['Item'])
check('recent photo untouched', exists(k5) and t.get_item(Key={'PK':cpk,'SK':'3DAYPHOTO#DAY3#BRUNCH'})['Item']['objectKey']==k5)
check('existing webp untouched', exists(k6))
print('== after')
st,pv2=call('GET','/admin/cleanup/preview?days=15',token=admin)
check('nothing left to convert; 1 parked', pv2['total']['count']==0 and pv2['parkedFailed']==1, pv2)
st,pv3=call('GET','/admin/cleanup/preview?days=15&retryFailed=true',token=admin)
check('retryFailed offers the parked one again', pv3['total']['count']==1, pv3)
st,r=call('POST','/admin/cleanup/run',{'days':15,'categories':['mealPhotos','templateImages']},admin)
check('re-run is a no-op', r['converted']==0 and r['done'], r)
st,h=call('GET','/admin/cleanup/history',token=admin)
run=[x for x in h['runs'] if x['runId']==rid]
check('history recorded the run totals', st==200 and run and run[0]['converted']==4 and run[0]['failed']==1 and run[0]['bytesAfter']<run[0]['bytesBefore'], h)
st,v=call('GET','/media/view?objectKey='+urllib.request.quote(wt,safe=''),token=admin)
data=urllib.request.urlopen(v['viewUrl']).read(); check('webp opens through the normal media viewer', data[:4]==b'RIFF' and data[8:12]==b'WEBP')
print(f'\n{passed} passed, {failed} failed')
sys.exit(1 if failed else 0)
