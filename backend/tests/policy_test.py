import json, urllib.request, urllib.error, sys
API='http://127.0.0.1:8788'
passed=failed=0
def check(l,c,x=''):
    global passed,failed
    if c: passed+=1; print('  PASS ',l)
    else: failed+=1; print('  FAIL ',l,x)
def call(m,p,b=None,t=None):
    r=urllib.request.Request(API+p,method=m,data=json.dumps(b).encode() if b is not None else None,headers={'Content-Type':'application/json',**({'Authorization':f'Bearer {t}'} if t else {})})
    try:
        with urllib.request.urlopen(r) as x: return x.status,json.loads(x.read() or '{}')
    except urllib.error.HTTPError as e: return e.code,json.loads(e.read() or '{}')
L=lambda u,p: call('POST','/auth/login',{'identifier':u,'password':p})[1]['token']
adm=L('ADH0001','AdminPass12345'); cli=L('CLS0001','Passw0rd!2345'); coach=L('CHC0001','Passw0rd!2345')
print('== defaults')
st,r=call('GET','/settings/appearance',t=cli); check('client gets default policy (everything allowed)', st==200 and r['policy']['allowCustomize'] and len(r['policy']['styles'])==8 and r['policy']['defaults']['style']=='original', r)
st,r=call('GET','/settings/appearance',t=adm); check('admin is never restricted (policy null)', st==200 and r['policy'] is None, r)
check('unauthenticated rejected', call('GET','/settings/appearance')[0] in (401,403))
check('client cannot read admin settings', call('GET','/admin/settings/appearance',t=cli)[0]==403)
st,full=call('GET','/admin/settings/appearance',t=adm); check('admin reads both roles', st==200 and set(full['roles'])=={'CLIENT','COACH'})
print('== validation')
def role(**kw):
    b=json.loads(json.dumps(full['roles']['CLIENT'])); b.update(kw); return b
check('unknown style rejected', call('PUT','/admin/settings/appearance',{'roles':{'CLIENT':role(styles=['original','neon'])}},adm)[0]==400)
check('empty list rejected', call('PUT','/admin/settings/appearance',{'roles':{'CLIENT':role(palettes=[])}},adm)[0]==400)
check('default must be allowed', call('PUT','/admin/settings/appearance',{'roles':{'CLIENT':role(styles=['original','glass'],defaults={**full['roles']['CLIENT']['defaults'],'style':'oldgym'})}},adm)[0]==400)
check('unknown role rejected', call('PUT','/admin/settings/appearance',{'roles':{'ADMIN':role()}},adm)[0]==400)
check('client cannot save', call('PUT','/admin/settings/appearance',{'roles':{'CLIENT':role()}},cli)[0]==403)
print('== save & read back')
pol=role(styles=['original','glass'],palettes=['classic','ocean'],scenes=['auto','off'],themes=['dark'],allowMotionToggle=False,allowVibrancy=False,defaults={'style':'glass','palette':'ocean','scene':'off','theme':'dark','motion':'off','vibrancy':80})
st,r=call('PUT','/admin/settings/appearance',{'roles':{'CLIENT':pol}},adm); check('admin saves client policy', st==200 and r['roles']['CLIENT']['styles']==['original','glass'] and r['updatedBy']=='ADH0001', r)
st,r=call('GET','/settings/appearance',t=cli); p=r['policy']
check('client sees restricted policy + defaults', p['styles']==['original','glass'] and p['themes']==['dark'] and not p['allowMotionToggle'] and p['defaults']['palette']=='ocean' and p['defaults']['vibrancy']==80, r)
st,r=call('GET','/settings/appearance',t=coach); check('coach policy untouched (all allowed)', len(r['policy']['styles'])==8, r)
st,r=call('PUT','/admin/settings/appearance',{'roles':{'CLIENT':{**pol,'resetNow':True}}},adm); check('reset counter increments', r['roles']['CLIENT']['resetCounter']==1, r['roles']['CLIENT'])
st,r=call('PUT','/admin/settings/appearance',{'roles':{'COACH':role(allowCustomize=False)}},adm); check('coach customisation can be switched off; client slice kept', st==200 and r['roles']['COACH']['allowCustomize']==False and r['roles']['CLIENT']['styles']==['original','glass'], r)
call('PUT','/admin/settings/appearance',{'roles':{'CLIENT':role(),'COACH':role()}},adm)  # restore defaults
print(f'\n{passed} passed, {failed} failed'); sys.exit(1 if failed else 0)
