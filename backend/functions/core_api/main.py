import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import struct
import time
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

from urllib.parse import quote, unquote

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from mangum import Mangum
from pydantic import BaseModel

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ---------------------------------------------------------------------------
# CONFIG - everything sensitive comes from the environment / Secrets Manager.
# NOTHING secret is stored in this file.
# ---------------------------------------------------------------------------
TABLE_NAME = os.environ.get('TABLE_NAME', 'BlueFit-Table')
AUTH_SECRET_ARN = os.environ.get('AUTH_SECRET_ARN')          # token-signing key (Secrets Manager)
# Firebase service-account JSON (Secrets Manager). Optional: when unset, push notifications are simply skipped.
FCM_SECRET_ARN = os.environ.get('FCM_SERVICE_ACCOUNT_SECRET_ARN')
# Websites / apps that may call this API from a browser. The production web app (also what iPhone
# users add to their home screen from Safari) and local development are always allowed.
DEFAULT_ORIGINS = ','.join([
    'http://localhost:3000',
    'http://localhost',
    'https://localhost',
    'capacitor://localhost',
    'https://bluefit-1g5.pages.dev',
])
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get('ALLOWED_ORIGINS', DEFAULT_ORIGINS).split(',') if o.strip()]

TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60   # a stolen token stops working after a week; active sessions slide forward daily
TOKEN_REFRESH_AFTER_SECONDS = 24 * 60 * 60   # the app asks for a fresh token once the current one is a day old
MAX_FAILED_LOGINS = 5                # lock the account after this many wrong passwords...
LOCK_SECONDS = 15 * 60               # ...for this long
MIN_PASSWORD_LENGTH = 8

app = FastAPI(title="The Blue Fit Core API", docs_url=None, redoc_url=None, openapi_url=None)

# Browsers may only call this API from the origins listed in ALLOWED_ORIGINS
# (API Gateway enforces the same list in production; see template.yaml).
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table(TABLE_NAME)
s3 = boto3.client('s3')
CLIENT_MEDIA_BUCKET = os.environ.get('CLIENT_MEDIA_BUCKET')

# ---------------------------------------------------------------------------
# SINGLE-TABLE LAYOUT  (table: BlueFit-Table, keys: PK + SK)
#
#   PK            SK                        what it is
#   CLIENT#<id>   PROFILE#BASELINE          athlete profile (role=CLIENT, coachId=COACH#<id>)
#   COACH#<id>    PROFILE#BASELINE          coach profile   (role=COACH)
#   ADMIN#<id>    PROFILE#BASELINE          admin profile   (role=ADMIN, created by scripts/create_admin.py)
#   CLIENT#<id>   CHECKIN#<iso-timestamp>   weekly check-in
#   CLIENT#<id>   TRAINING#<YYYY-MM-DD>#<n> a training task scheduled for that day
#   COACH#<id>    TEMPLATE#<templateId>     reusable workout/plan template
#   CLIENT#<id>   MSG#<iso-ts>#<n>          one chat message between a client and their coach
#   CLIENT#<id>   THREAD#META               chat read-markers + the client's unread counter
#   COACH#<id>    INBOX#<clientId>          the coach's inbox row for one client (last message + unread)
#   CLIENT#<id>   HEALTH#<YYYY-MM-DD>       daily steps / sleep / water / calories / heart-rate snapshot
# ---------------------------------------------------------------------------
PROFILE_SK = 'PROFILE#BASELINE'
ROLE_PREFIXES = {'CLIENT': 'CL', 'COACH': 'CH', 'ADMIN': 'AD'}   # CLIENT#CLS001, COACH#CHR001, ADMIN#ADH001
PROVISIONABLE_ROLES = {'CLIENT', 'COACH'}                          # admins are never created through the API
ADHERENCE_SCORES = {'strict': 100, 'mostly': 75, 'struggled': 40}
WORKOUT_QUALITIES = {'strong', 'maintained', 'weak'}

# Fields that may be written from a form, per role (anything else is ignored)
CLIENT_BASELINE_FIELDS = ('age', 'height', 'weight', 'activityLevel', 'primaryGoal', 'medicalNotes')
COACH_BASELINE_FIELDS = ('specialization',)

# Fields an admin may see in the user directory. Password hashes, lockout counters
# and health notes are NEVER part of this list.
ADMIN_VIEW_FIELDS = ('PK', 'SK', 'role', 'name', 'email', 'userCode', 'coachId', 'status',
                     'createdAt', 'onboardingCompleted', 'mustChangePassword',
                     'lastLoginAt', 'lastActiveAt', 'loginCount')

ONLINE_WINDOW_SECONDS = 150          # "online now" = heard from within 2.5 minutes (the app pings every 45 s while open)
ACTIVITY_TOUCH_SECONDS = 30          # write lastActiveAt at most once every 30 s per user

# Daily targets, shared by the athlete dashboard, the coach dashboard and the progress review
STEP_GOAL = 10000
SLEEP_GOAL = 8.0
HYDRATION_GOAL = 3.0
MESSAGE_MAX_LENGTH = 2000
IMPORT_MAX_TEMPLATES = 25
PROGRESS_ANGLES = ('front', 'side', 'back')
WEEKDAYS = ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')


# ----------------------------- generic helpers -----------------------------
def parse_decimals(obj):
    """DynamoDB returns Decimal; convert so JSON serialisation works."""
    if isinstance(obj, list):
        return [parse_decimals(i) for i in obj]
    elif isinstance(obj, dict):
        return {k: parse_decimals(v) for k, v in obj.items()}
    elif isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    return obj


def to_dynamo(obj):
    """DynamoDB rejects float and None: floats -> Decimal, None values dropped."""
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: to_dynamo(v) for k, v in obj.items() if v is not None}
    if isinstance(obj, list):
        return [to_dynamo(v) for v in obj]
    return obj


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


_ID_PATTERN = re.compile(r'^[A-Za-z0-9_-]{1,40}$')


def make_pk(role: str, raw: str) -> str:
    """'CHR001' -> 'COACH#CHR001'.  A full key ('COACH#CHR001', also URL-encoded) is accepted, but the
    entity type always comes from `role`: a caller can never turn an athlete id into a coach/admin key."""
    raw = unquote(str(raw or '')).strip()
    if '#' in raw:
        raw = raw.split('#', 1)[1]
    if not _ID_PATTERN.match(raw):
        raise HTTPException(status_code=400, detail="Invalid identifier.")
    return f"{role.upper()}#{raw}"


def short_id(pk: str) -> str:
    return pk.split('#', 1)[1] if '#' in pk else pk


def error_code(e: ClientError) -> str:
    return e.response.get('Error', {}).get('Code', '')


def scan_all(**kwargs) -> List[dict]:
    """Scan following LastEvaluatedKey so results are not cut off at 1 MB."""
    items: List[dict] = []
    while True:
        resp = table.scan(**kwargs)
        items.extend(resp.get('Items', []))
        last = resp.get('LastEvaluatedKey')
        if not last:
            return items
        kwargs['ExclusiveStartKey'] = last


def query_all(**kwargs) -> List[dict]:
    items: List[dict] = []
    while True:
        resp = table.query(**kwargs)
        items.extend(resp.get('Items', []))
        last = resp.get('LastEvaluatedKey')
        if not last:
            return items
        kwargs['ExclusiveStartKey'] = last


def all_profiles() -> List[dict]:
    """INTERNAL USE ONLY - contains password hashes. Never return this to a client."""
    return scan_all(FilterExpression=Attr('SK').eq(PROFILE_SK))


def get_profile(pk: str) -> Optional[dict]:
    return table.get_item(Key={'PK': pk, 'SK': PROFILE_SK}).get('Item')


def pick(source: dict, fields) -> dict:
    return {k: source[k] for k in fields if k in source}


# ------------------------- passwords (salted scrypt) -----------------------
def hash_password(raw: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(raw.encode('utf-8'), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(raw: str, stored: str) -> bool:
    try:
        scheme, salt_hex, digest_hex = stored.split('$')
        if scheme != 'scrypt':
            return False
        digest = hashlib.scrypt(raw.encode('utf-8'), salt=bytes.fromhex(salt_hex), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(digest, bytes.fromhex(digest_hex))
    except Exception:
        return False


# Used to burn the same CPU time when a login names an account that does not exist,
# so response time does not reveal which IDs are real.
_DUMMY_HASH = hash_password(secrets.token_hex(8))


def generate_temp_password() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"          # no 0/O/1/I to avoid misreads
    return "TBF-" + "".join(secrets.choice(alphabet) for _ in range(8))


def validate_new_password(pw: str) -> None:
    if len(pw) < MIN_PASSWORD_LENGTH:
        raise HTTPException(status_code=400, detail=f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")
    if len(pw) > 128:
        raise HTTPException(status_code=400, detail="Password is too long.")
    if not (re.search(r'[A-Za-z]', pw) and re.search(r'\d', pw)):
        raise HTTPException(status_code=400, detail="Password must contain letters and numbers.")


# ----------------------- session tokens (HS256, stdlib) --------------------
_signing_key: Optional[bytes] = None


def signing_key() -> bytes:
    """Key comes from Secrets Manager (auto-generated by template.yaml); AUTH_SECRET is for local tests only."""
    global _signing_key
    if _signing_key is None:
        local = os.environ.get('AUTH_SECRET')
        if local:
            key = local.encode('utf-8')
        elif AUTH_SECRET_ARN:
            key = boto3.client('secretsmanager').get_secret_value(SecretId=AUTH_SECRET_ARN)['SecretString'].encode('utf-8')
        else:
            raise RuntimeError("AUTH_SECRET_ARN is not configured")
        if len(key) < 32:
            raise RuntimeError("Token signing key is too short")
        _signing_key = key
    return _signing_key


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def issue_token(pk: str, role: str) -> str:
    now = int(time.time())
    header = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(',', ':')).encode())
    body = _b64(json.dumps({"sub": pk, "role": role, "iat": now, "exp": now + TOKEN_TTL_SECONDS}, separators=(',', ':')).encode())
    sig = _b64(hmac.new(signing_key(), f"{header}.{body}".encode(), hashlib.sha256).digest())
    return f"{header}.{body}.{sig}"


def verify_token(token: str) -> dict:
    key = signing_key()
    try:
        header_b64, body_b64, sig_b64 = token.split('.')
        if json.loads(_unb64(header_b64)).get('alg') != 'HS256':
            raise ValueError("bad alg")
        expected = hmac.new(key, f"{header_b64}.{body_b64}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(sig_b64)):
            raise ValueError("bad signature")
        claims = json.loads(_unb64(body_b64))
        if not isinstance(claims, dict):
            raise ValueError("bad claims")
        if not isinstance(claims.get('sub'), str) or claims.get('role') not in ROLE_PREFIXES:
            raise ValueError("bad claims")
        issued, expires = int(claims['iat']), int(claims['exp'])
        if issued > time.time() + 300:          # issued in the future: clock tampering or a forged header
            raise ValueError("bad iat")
        if expires <= issued:
            raise ValueError("bad exp")
        if expires < time.time():
            raise ValueError("expired")
        return claims
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired session. Please sign in again.")


# ------------------------------ authorization ------------------------------
def current_user(authorization: Optional[str] = Header(default=None)) -> dict:
    """Every protected route depends on this. Verifies the bearer token, then re-checks
    the account in DynamoDB so deleted/disabled users and old-password tokens stop working."""
    if not authorization or not authorization.lower().startswith('bearer '):
        raise HTTPException(status_code=401, detail="Authentication required.")
    claims = verify_token(authorization[7:].strip())
    profile = get_profile(claims.get('sub', ''))
    if not profile or profile.get('status') == 'INACTIVE':
        raise HTTPException(status_code=401, detail="Invalid or expired session. Please sign in again.")
    if int(claims.get('iat', 0)) < int(profile.get('pwdChangedAt', 0)):
        raise HTTPException(status_code=401, detail="Invalid or expired session. Please sign in again.")
    touch_activity(profile)
    return {"pk": profile['PK'], "role": profile.get('role'), "name": profile.get('name'),
            "iat": int(claims.get('iat', 0))}


def touch_activity(profile: dict) -> None:
    """Record 'last seen' for the admin Monitor. Throttled so it is at most one write a minute,
    and never allowed to break the request it rides on."""
    try:
        last = parse_iso(profile.get('lastActiveAt', ''))
        if last and (datetime.now(timezone.utc) - last).total_seconds() < ACTIVITY_TOUCH_SECONDS:
            return
        table.update_item(
            Key={'PK': profile['PK'], 'SK': PROFILE_SK},
            UpdateExpression="SET lastActiveAt = :t",
            ExpressionAttributeValues={':t': now_iso()},
        )
    except Exception:
        logger.warning('could not record activity for %s', profile.get('PK'))


def record_logout(pk: str) -> None:
    """Called on sign-out so the admin Monitor stops showing the person as 'online'."""
    try:
        table.update_item(
            Key={'PK': pk, 'SK': PROFILE_SK},
            UpdateExpression="SET lastLogoutAt = :t",
            ExpressionAttributeValues={':t': now_iso()},
        )
    except Exception:
        logger.warning('could not record logout for %s', pk)


def record_login(profile: dict) -> None:
    """Called when a session token is issued."""
    try:
        ts = now_iso()
        table.update_item(
            Key={'PK': profile['PK'], 'SK': PROFILE_SK},
            UpdateExpression="SET lastLoginAt = :t, lastActiveAt = :t, loginCount = :n",
            ExpressionAttributeValues={':t': ts, ':n': int(profile.get('loginCount', 0)) + 1},
        )
    except Exception:
        logger.warning('could not record login for %s', profile.get('PK'))


def is_coach_of(client_profile: Optional[dict], coach_pk: str) -> bool:
    """coachId is stored either as the full key (COACH#CHR001) or the bare id (CHR001)."""
    return bool(client_profile) and client_profile.get('coachId') in (coach_pk, short_id(coach_pk))


def require_roles(*roles: str):
    def dependency(user: dict = Depends(current_user)) -> dict:
        if user['role'] not in roles:
            raise HTTPException(status_code=403, detail="You do not have access to this resource.")
        return user
    return dependency


def authorize_coach_scope(user: dict, coach_pk: str) -> None:
    """A coach may only touch their own data; an admin may touch any coach's."""
    if user['role'] == 'ADMIN':
        return
    if user['role'] == 'COACH' and user['pk'] == coach_pk:
        return
    raise HTTPException(status_code=403, detail="You do not have access to this resource.")


def authorize_athlete_scope(user: dict, client_pk: str) -> None:
    """An athlete sees only their own data; their assigned coach and admins may also see it."""
    if user['role'] == 'ADMIN' or (user['role'] == 'CLIENT' and user['pk'] == client_pk):
        return
    if user['role'] == 'COACH':
        client = get_profile(client_pk)
        if client and client.get('coachId') in (user['pk'], short_id(user['pk'])):
            return
    raise HTTPException(status_code=403, detail="You do not have access to this resource.")


# --------------------------- domain helpers --------------------------------
def coach_clients(coach_pk: str) -> List[dict]:
    """Clients whose coachId is this coach (full key or bare id)."""
    return scan_all(
        FilterExpression=Attr('SK').eq(PROFILE_SK)
        & Attr('role').eq('CLIENT')
        & Attr('coachId').is_in([coach_pk, short_id(coach_pk)])
    )


def latest_checkins(client_pk: str, n: int = 4) -> List[dict]:
    resp = table.query(
        KeyConditionExpression=Key('PK').eq(client_pk) & Key('SK').begins_with('CHECKIN#'),
        ScanIndexForward=False,
        Limit=n,
    )
    return resp.get('Items', [])


def parse_iso(value: str) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def days_since(iso: Optional[str]) -> Optional[int]:
    dt = parse_iso(iso) if iso else None
    if not dt:
        return None
    return (datetime.now(timezone.utc).date() - dt.astimezone(timezone.utc).date()).days


def day_label(iso: Optional[str]) -> str:
    d = days_since(iso)
    if d is None:
        return 'No check-ins yet'
    return 'Today' if d <= 0 else 'Yesterday' if d == 1 else f'{d} days ago'


def time_ago(iso: Optional[str]) -> str:
    dt = parse_iso(iso) if iso else None
    if not dt:
        return ''
    secs = max(0, int((datetime.now(timezone.utc) - dt).total_seconds()))
    if secs < 60:
        return 'Just now'
    if secs < 3600:
        return f'{secs // 60}m ago'
    if secs < 86400:
        return f'{secs // 3600}h ago'
    return day_label(iso)


def adherence_score(value: Any) -> Optional[int]:
    """Check-in form sends strict/mostly/struggled; also accepts '85' or '85%'."""
    if value is None:
        return None
    v = str(value).strip().lower()
    if v in ADHERENCE_SCORES:
        return ADHERENCE_SCORES[v]
    m = re.match(r'^(\d+(?:\.\d+)?)\s*%?$', v)
    return min(100, round(float(m.group(1)))) if m else None


def utc_today() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%d')


def date_window(end_iso: str, days: int) -> List[str]:
    """`days` ISO dates ending at end_iso, oldest first."""
    end = datetime.strptime(end_iso, '%Y-%m-%d').date()
    return [(end - timedelta(days=n)).isoformat() for n in range(days - 1, -1, -1)]


def health_range(client_pk: str, start_iso: str, end_iso: str) -> Dict[str, dict]:
    """Daily health snapshots between two ISO dates (inclusive), keyed by date."""
    items = query_all(KeyConditionExpression=Key('PK').eq(client_pk)
                      & Key('SK').between(f"HEALTH#{start_iso}", f"HEALTH#{end_iso}"))
    return {i['SK'].split('#', 1)[1]: i for i in items}


def pct_of(value: Any, goal: float) -> Optional[int]:
    try:
        return round(min(float(value) / goal, 1.0) * 100)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def health_view(item: Optional[dict]) -> dict:
    item = item or {}
    return {k: item.get(k) for k in ('steps', 'sleepHours', 'calories', 'heartRate', 'hydration')}


def latest_health(client_pk: str):
    """Most recent daily snapshot from the last two days -> (date, item) or (None, {}).
    Looks one day ahead of UTC so a phone in a timezone that is already 'tomorrow' is included."""
    today = datetime.now(timezone.utc).date()
    rng = health_range(client_pk, (today - timedelta(days=1)).isoformat(), (today + timedelta(days=1)).isoformat())
    if not rng:
        return None, {}
    day = max(rng)
    return day, rng[day]


def summarize_client(profile: dict, with_health: bool = False):
    """Returns (row for the roster, meta used by the dashboard feed). Only safe fields leave here."""
    checkins = latest_checkins(profile['PK'], 4)
    scores = [s for s in (adherence_score(c.get('adherence')) for c in checkins) if s is not None]
    adherence = round(sum(scores) / len(scores)) if scores else 0
    last_ts = checkins[0]['SK'].split('#', 1)[1] if checkins else None
    days = days_since(last_ts)
    on_track = days is not None and days <= 7 and adherence >= 75
    row = {
        "id": short_id(profile['PK']),
        "name": profile.get('name') or 'Unnamed Athlete',
        "goal": profile.get('primaryGoal') or profile.get('goal') or 'Not set',
        "adherence": adherence,
        "lastCheckIn": day_label(last_ts),
        "status": 'on-track' if on_track else 'needs-attention',
    }
    if with_health:
        pres = profile_presence(profile)
        h_day, h_item = latest_health(profile['PK'])
        row.update({
            "presence": pres['presence'],
            "lastSeenAt": pres['lastSeenAt'],
            "stepsToday": h_item.get('steps'),
            "stepsDate": h_day,
            "stepGoal": STEP_GOAL,
            "unreadMessages": 0,
        })
    meta = {
        "lastTs": last_ts,
        "days": days,
        "weight": checkins[0].get('weight') if checkins else None,
        "latestScore": adherence_score(checkins[0].get('adherence')) if checkins else None,
    }
    return row, meta


def clean_text(value: Optional[str], limit: int) -> Optional[str]:
    if value is None:
        return None
    value = str(value).strip()
    if len(value) > limit:
        raise HTTPException(status_code=400, detail=f"Text is too long (max {limit} characters).")
    return value


def clean_exercises(exercises: Optional[List[Dict[str, Any]]]) -> Optional[List[Dict[str, str]]]:
    """Normalize imported/manual exercise rows without dropping workout instructions."""
    if exercises is None:
        return None
    if len(exercises) > 100:
        raise HTTPException(status_code=400, detail="Too many exercises (max 100).")

    fields = {
        'id': 100,
        'order': 20,
        'section': 100,
        'type': 100,
        'name': 150,
        'sets': 100,
        'reps': 100,
        'rest': 100,
        'tempo': 100,
        'weight': 100,
        'rpe': 100,
        'notes': 500,
    }

    cleaned: List[Dict[str, str]] = []
    for index, ex in enumerate(exercises, start=1):
        if not isinstance(ex, dict):
            raise HTTPException(status_code=400, detail=f"Exercise {index} must be an object.")
        row: Dict[str, str] = {}
        for key, limit in fields.items():
            value = ex.get(key, '')
            row[key] = clean_text(str(value), limit) or ''
        if not row['id']:
            row['id'] = str(index)
        if not row['order']:
            row['order'] = str(index)
        cleaned.append(row)
    return cleaned


def template_out(item: dict) -> dict:
    out = parse_decimals({
        "id": item['SK'].split('#', 1)[1],
        "title": item.get('title', ''),
        "description": item.get('description', ''),
        "activities": item.get('activities', ''),
        "workoutDays": item.get('workoutDays', ''),
        "goal": item.get('goal', ''),
        "exercises": item.get('exercises', []),
        "level": item.get('level', ''),
        "estimatedDuration": item.get('estimatedDuration', ''),
        "equipment": item.get('equipment', ''),
        "referenceImageKey": item.get('referenceImageKey', ''),
    })
    # Generate a short-lived presigned URL for the reference image if present
    if out.get('referenceImageKey') and CLIENT_MEDIA_BUCKET:
        try:
            out['referenceImageUrl'] = s3.generate_presigned_url(
                'get_object',
                Params={'Bucket': CLIENT_MEDIA_BUCKET, 'Key': out['referenceImageKey']},
                ExpiresIn=3600,
            )
        except Exception:
            out['referenceImageUrl'] = None
    else:
        out['referenceImageUrl'] = None
    return out


def clean_reference_key(owner_pk: str, value: Optional[str]) -> str:
    """A template's reference image must live in the owning coach's own media folder.
    Without this check a coach could point a template at any client's photo (for example via a
    hand-edited import file) and then open it through the template image viewer."""
    key = (clean_text(value, 500) or '')
    if key and (not key.startswith(f"coaches/{short_id(owner_pk)}/") or '..' in key.split('/')):
        raise HTTPException(status_code=400, detail="Invalid reference image.")
    return key


def find_template(template_id: str, coach_pk: Optional[str]) -> Optional[dict]:
    """Direct get_item when the coach is known, otherwise (admin only) a filtered scan."""
    sk = f"TEMPLATE#{unquote(template_id)}"
    if coach_pk:
        return table.get_item(Key={'PK': coach_pk, 'SK': sk}).get('Item')
    found = scan_all(FilterExpression=Attr('SK').eq(sk))
    return found[0] if found else None


def session_payload(profile: dict, with_token: bool) -> dict:
    """The ONLY shape in which a user record is returned after login."""
    out = {
        "PK": profile['PK'],
        "userCode": short_id(profile['PK']),
        "role": profile.get('role', 'CLIENT'),
        "name": profile.get('name', 'User'),
        "email": profile.get('email', ''),
        "mustChangePassword": bool(profile.get('mustChangePassword', False)),
        "onboardingCompleted": bool(profile.get('onboardingCompleted', True)),
    }
    if with_token:
        out["token"] = issue_token(profile['PK'], out["role"])
    return out


def find_login_profile(identifier: str, role: Optional[str]) -> Optional[dict]:
    ident = identifier.strip()
    if '@' in ident:
        found = scan_all(FilterExpression=Attr('SK').eq(PROFILE_SK) & Attr('email').eq(ident.lower()))
        return found[0] if len(found) == 1 else None
    code = short_id(ident).upper()
    candidates = [f"ADMIN#{code}"]
    if role and role.upper() in ('CLIENT', 'COACH'):
        candidates.insert(0, f"{role.upper()}#{code}")
    elif not role:
        candidates = [f"CLIENT#{code}", f"COACH#{code}", f"ADMIN#{code}"]
    for pk in candidates:
        profile = get_profile(pk)
        if profile:
            return profile
    return None


def register_login_failure(profile: dict) -> None:
    attempts = int(profile.get('failedAttempts', 0)) + 1
    locked_until = int(time.time()) + LOCK_SECONDS if attempts >= MAX_FAILED_LOGINS else 0
    table.update_item(
        Key={'PK': profile['PK'], 'SK': PROFILE_SK},
        UpdateExpression="SET failedAttempts = :n, lockedUntil = :l",
        ExpressionAttributeValues={':n': 0 if locked_until else attempts, ':l': locked_until},
    )


def clear_login_failures(profile: dict) -> None:
    if int(profile.get('failedAttempts', 0)) or int(profile.get('lockedUntil', 0)):
        table.update_item(
            Key={'PK': profile['PK'], 'SK': PROFILE_SK},
            UpdateExpression="SET failedAttempts = :z, lockedUntil = :z",
            ExpressionAttributeValues={':z': 0},
        )


def next_user_id(role: str, name: str) -> str:
    """CLIENT#CLS001, CLIENT#CLS002, COACH#CHR001 ... (role prefix + first letter of name + counter)."""
    prefix = ROLE_PREFIXES[role]
    letters = re.sub(r'[^A-Za-z]', '', name.strip())
    code_prefix = f"{prefix}{letters[0].upper() if letters else 'X'}"
    pattern = re.compile(rf"^{re.escape(role)}#{re.escape(code_prefix)}(\d+)$")
    highest = 0
    for profile in all_profiles():
        m = pattern.match(str(profile.get('PK', '')))
        if m:
            highest = max(highest, int(m.group(1)))
    return f"{role}#{code_prefix}{highest + 1:04d}"


# ------------------------------ request models -----------------------------
# Unknown fields in a request body are ignored, so a caller can never write
# arbitrary attributes (role, passwordHash, coachId...) into an item.
class LoginPayload(BaseModel):
    identifier: str
    password: str
    role: Optional[str] = None
    code: Optional[str] = None      # authenticator / backup code, admins with two-factor on


class DevicePayload(BaseModel):
    token: str
    platform: Optional[str] = None


class OnboardingPayload(BaseModel):
    name: str
    role: str
    email: str
    age: Optional[float] = None
    height: Optional[float] = None
    weight: Optional[float] = None
    activityLevel: Optional[str] = None
    primaryGoal: Optional[str] = None
    medicalNotes: Optional[str] = None
    specialization: Optional[str] = None
    onboardingCompleted: Optional[bool] = None


class CompleteSetupPayload(BaseModel):
    userId: str
    currentPassword: str
    newPassword: str
    age: Optional[float] = None
    height: Optional[float] = None
    weight: Optional[float] = None
    activityLevel: Optional[str] = None
    primaryGoal: Optional[str] = None
    medicalNotes: Optional[str] = None
    specialization: Optional[str] = None


class AssignPayload(BaseModel):
    coachId: str


class CheckinPayload(BaseModel):
    weight: float
    adherence: str
    workoutQuality: str
    clientId: Optional[str] = None      # ignored for athletes; the signed-in user is always used
    waist: Optional[float] = None
    notes: Optional[str] = None

class HealthMetricsPayload(BaseModel):
    steps: Optional[int] = None
    sleepHours: Optional[float] = None
    calories: Optional[int] = None
    heartRate: Optional[int] = None
    hydration: Optional[float] = None   # litres
    date: Optional[str] = None          # the phone's local date (YYYY-MM-DD); defaults to today in UTC
    source: Optional[str] = None        # 'device' (phone sensors) or 'manual' (typed in by the athlete)



class TemplatePayload(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    goal: Optional[str] = None
    workoutDays: Optional[str] = None
    activities: Optional[str] = None
    exercises: Optional[List[Dict[str, Any]]] = None
    level: Optional[str] = None
    estimatedDuration: Optional[str] = None
    equipment: Optional[str] = None
    referenceImageKey: Optional[str] = None



class ImportTemplatesPayload(BaseModel):
    templates: List[Dict[str, Any]]


class AssignTemplatePayload(BaseModel):
    clientId: str
    startDate: Optional[str] = None
    notes: Optional[str] = None


class ClientSchedulePayload(BaseModel):
    templateId: str
    startDate: str
    notes: Optional[str] = None


class ThreeDayLogPayload(BaseModel):
    meals: Dict[str, str] = {}


class ThreeDayPhotoUploadPayload(BaseModel):
    day: int
    meal: str
    fileName: str
    contentType: str


class ProgressPhotoUploadPayload(BaseModel):
    checkinId: str
    angle: str
    fileName: str
    contentType: str


class ProgressPhotoCompletePayload(BaseModel):
    checkinId: str
    angle: str
    objectKey: str
    originalFileName: Optional[str] = None


class WorkoutLogPayload(BaseModel):
    assignmentId: str
    date: Optional[str] = None
    completed: bool = True


class ThreeDayPhotoCompletePayload(BaseModel):
    day: int
    meal: str
    objectKey: str
    originalFileName: Optional[str] = None


THREE_DAY_MEALS = ('Breakfast', 'Brunch', 'Lunch', 'Snacks', 'Dinner')
THREE_DAY_DAYS = (1, 2, 3)
ALLOWED_IMAGE_TYPES = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/heif': '.heif',
}
MAX_CLIENT_PHOTO_BYTES = 10 * 1024 * 1024


def validate_three_day_day(day: int) -> None:
    if day not in THREE_DAY_DAYS:
        raise HTTPException(status_code=400, detail='Day must be 1, 2 or 3.')


def validate_three_day_meal(meal: str) -> str:
    clean = clean_text(meal, 30) or ''
    match = next((m for m in THREE_DAY_MEALS if m.lower() == clean.lower()), None)
    if not match:
        raise HTTPException(status_code=400, detail='Invalid meal.')
    return match


def three_day_log_item(client_pk: str, day: int) -> Optional[dict]:
    return table.get_item(Key={'PK': client_pk, 'SK': f'3DAYLOG#DAY{day}'}).get('Item')


def three_day_status(client_pk: str) -> dict:
    items = query_all(KeyConditionExpression=Key('PK').eq(client_pk) & Key('SK').begins_with('3DAY'))
    logs = {int(i['SK'][-1]): i for i in items if i['SK'].startswith('3DAYLOG#DAY') and i['SK'][-1:].isdigit()}
    photos_by_day: Dict[int, List[dict]] = {1: [], 2: [], 3: []}

    for item in items:
        if not item['SK'].startswith('3DAYPHOTO#DAY'):
            continue
        parts = item['SK'].split('#')
        if len(parts) != 3 or not parts[1].startswith('DAY'):
            continue
        try:
            day = int(parts[1][3:])
        except ValueError:
            continue
        if day not in photos_by_day:
            continue
        view_url = None
        if CLIENT_MEDIA_BUCKET:
            try:
                view_url = s3.generate_presigned_url(
                    'get_object',
                    Params={'Bucket': CLIENT_MEDIA_BUCKET, 'Key': item['objectKey']},
                    ExpiresIn=3600,
                )
            except ClientError:
                view_url = None
        photos_by_day[day].append({
            'id': item['SK'],
            'day': day,
            'meal': item.get('meal', ''),
            'originalFileName': item.get('originalFileName', ''),
            'contentType': item.get('contentType', ''),
            'objectKey': item.get('objectKey', ''),
            'uploadedAt': item.get('uploadedAt', item.get('createdAt', '')),
            'viewUrl': view_url,
        })

    output_days = []
    completed_count = 0
    started_count = 0
    for day in THREE_DAY_DAYS:
        meals = {m: str((logs.get(day) or {}).get('meals', {}).get(m, '')) for m in THREE_DAY_MEALS}
        has_meals = any(v.strip() for v in meals.values())
        photos = sorted(photos_by_day[day], key=lambda x: x.get('uploadedAt', ''))
        started = has_meals or bool(photos)
        status = 'COMPLETE' if started else 'NOT_STARTED'
        if started:
            started_count += 1
        if started:
            # A day is considered complete once it has at least one saved entry or photo.
            completed_count += 1
        output_days.append({
            'day': day,
            'status': status if status == 'COMPLETE' else ('IN_PROGRESS' if started else 'NOT_STARTED'),
            'meals': meals,
            'photos': photos,
        })

    if completed_count == 3:
        overall = 'COMPLETE'
    elif started_count > 0:
        overall = 'IN_PROGRESS'
    else:
        overall = 'NOT_STARTED'

    return {
        'onboardingCompleted': bool((get_profile(client_pk) or {}).get('onboardingCompleted', False)),
        'overallStatus': overall,
        'days': output_days,
    }


def check_range(label: str, value: Optional[float], low: float, high: float) -> None:
    if value is not None and not (low <= value <= high):
        raise HTTPException(status_code=400, detail=f"{label} must be between {low:g} and {high:g}.")


def baseline_fields(role: str, data: dict) -> dict:
    """Validated, allow-listed profile fields for the given role."""
    allowed = CLIENT_BASELINE_FIELDS if role == 'CLIENT' else COACH_BASELINE_FIELDS
    out = {k: data.get(k) for k in allowed if data.get(k) not in (None, '')}
    if role == 'CLIENT':
        check_range('Age', out.get('age'), 10, 100)
        check_range('Height (cm)', out.get('height'), 100, 250)
        check_range('Weight (kg)', out.get('weight'), 20, 400)
        for k, limit in (('activityLevel', 50), ('primaryGoal', 50), ('medicalNotes', 2000)):
            if k in out:
                out[k] = clean_text(out[k], limit)
    elif 'specialization' in out:
        out['specialization'] = clean_text(out['specialization'], 50)
    return out


# ------------------------ login throttle (per caller IP) -------------------
# Account lockout (MAX_FAILED_LOGINS) protects one account. This protects the endpoint itself: one caller
# cannot spray passwords across many accounts or hammer sign-in. Memory is per Lambda container, so API
# Gateway's stage throttle stays the outer, account-wide limit.
_RATE_LIMIT_MAX_KEYS = 5000
_rate_hits: Dict[str, List[float]] = {}


def client_ip(request: Any) -> str:
    headers = getattr(request, 'headers', None)
    forwarded = (headers.get('x-forwarded-for', '') if headers is not None else '') or ''
    if forwarded:
        return forwarded.split(',')[0].strip()[:64]
    scope_client = (getattr(request, 'scope', None) or {}).get('client')
    return (scope_client[0] if scope_client else '') or 'unknown'


def rate_limit(request: Request, bucket: str, limit: int, window: int) -> None:
    now = time.time()
    key = f"{bucket}:{client_ip(request)}"
    hits = [t for t in _rate_hits.get(key, []) if now - t < window]
    if len(hits) >= limit:
        raise HTTPException(status_code=429, detail='Too many attempts. Please wait a few minutes and try again.')
    hits.append(now)
    _rate_hits[key] = hits
    if len(_rate_hits) > _RATE_LIMIT_MAX_KEYS:      # keep the dict from growing without bound
        for stale in [k for k, v in _rate_hits.items() if not v or now - v[-1] > 3600]:
            _rate_hits.pop(stale, None)


def login_throttle(request: Request) -> None:
    rate_limit(request, 'login', 20, 300)


# -------------------------- admin two-factor (TOTP) -------------------------
# RFC 6238: 6 digits, 30-second step, SHA-1, one step of clock drift tolerated either way.
# The secret is returned once, when the admin sets the app up, and lives on their profile row.
MFA_ISSUER = 'The Blue Fit'
MFA_STEP_SECONDS = 30
MFA_DIGITS = 6
MFA_RECOVERY_CODES = 8


def _b32encode(raw: bytes) -> str:
    return base64.b32encode(raw).decode('ascii').rstrip('=')


def new_totp_secret() -> str:
    return _b32encode(secrets.token_bytes(20))


def totp_code(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + '=' * (-len(secret) % 8), casefold=True)
    digest = hmac.new(key, struct.pack('>Q', counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** MFA_DIGITS)).zfill(MFA_DIGITS)


def totp_matches(secret: Optional[str], code: Optional[str], at: Optional[float] = None) -> bool:
    if not secret:
        return False
    digits = re.sub(r'\D', '', str(code or ''))
    if len(digits) != MFA_DIGITS:
        return False
    step = int((at if at is not None else time.time()) // MFA_STEP_SECONDS)
    return any(hmac.compare_digest(totp_code(secret, step + drift), digits) for drift in (-1, 0, 1))


def _canonical_code(code: Optional[str]) -> str:
    return re.sub(r'[^0-9A-Za-z]', '', str(code or '')).upper()


def _hash_recovery(code: str) -> str:
    return hashlib.sha256(_canonical_code(code).encode('utf-8')).hexdigest()


def new_recovery_codes(count: int = MFA_RECOVERY_CODES) -> List[str]:
    """Backup codes, shown to the admin once; only their hashes are stored."""
    codes = []
    for _ in range(count):
        raw = secrets.token_hex(5).upper()
        codes.append(f'{raw[:5]}-{raw[5:]}')
    return codes


def _matching_recovery_hash(profile: dict, code: Optional[str]) -> Optional[str]:
    canonical = _canonical_code(code)
    if len(canonical) != 10:
        return None
    wanted = _hash_recovery(canonical)
    for stored in profile.get('mfaRecoveryHashes') or []:
        if hmac.compare_digest(str(stored), wanted):
            return str(stored)
    return None


def verify_mfa(profile: dict, code: Optional[str]) -> bool:
    """An authenticator code, or a backup code (backup codes work once)."""
    if totp_matches(profile.get('mfaSecret'), code):
        return True
    spent = _matching_recovery_hash(profile, code)
    if not spent:
        return False
    remaining = [h for h in (profile.get('mfaRecoveryHashes') or []) if str(h) != spent]
    table.update_item(
        Key={'PK': profile['PK'], 'SK': PROFILE_SK},
        UpdateExpression='SET mfaRecoveryHashes = :r',
        ExpressionAttributeValues={':r': remaining},
    )
    return True


def totp_uri(profile: dict, secret: str) -> str:
    label = quote(f"{MFA_ISSUER}:{profile.get('userCode') or short_id(profile['PK'])}")
    params = f"secret={secret}&issuer={quote(MFA_ISSUER)}&digits={MFA_DIGITS}&period={MFA_STEP_SECONDS}"
    return f"otpauth://totp/{label}?{params}"


class MfaCodePayload(BaseModel):
    code: str


class MfaDisablePayload(BaseModel):
    password: str
    code: str


@app.get("/admin/security")
def admin_security(user: dict = Depends(require_roles('ADMIN'))):
    profile = get_profile(user['pk']) or {}
    return {
        'mfaEnabled': bool(profile.get('mfaEnabled')),
        'mfaPending': bool(profile.get('mfaPendingSecret')),
        'recoveryCodesRemaining': len(profile.get('mfaRecoveryHashes') or []),
    }


@app.post("/admin/security/mfa/start")
def admin_mfa_start(user: dict = Depends(require_roles('ADMIN')), _throttle: None = Depends(login_throttle)):
    """Step 1: hand the admin a fresh key to type into their authenticator app."""
    profile = get_profile(user['pk'])
    if profile.get('mfaEnabled'):
        raise HTTPException(status_code=409, detail='Two-factor is already on. Turn it off before setting up another device.')
    secret = new_totp_secret()
    table.update_item(
        Key={'PK': profile['PK'], 'SK': PROFILE_SK},
        UpdateExpression='SET mfaPendingSecret = :s',
        ExpressionAttributeValues={':s': secret},
    )
    return {'secret': secret, 'otpauthUrl': totp_uri(profile, secret)}


@app.post("/admin/security/mfa/enable")
def admin_mfa_enable(payload: MfaCodePayload, user: dict = Depends(require_roles('ADMIN'))):
    """Step 2: a working code proves the app is set up. Backup codes are shown here, once."""
    profile = get_profile(user['pk'])
    pending = profile.get('mfaPendingSecret')
    if not pending:
        raise HTTPException(status_code=409, detail='Start the setup again - the setup key has expired.')
    if not totp_matches(pending, payload.code):
        raise HTTPException(status_code=400, detail='That code did not match. Check your phone clock and try the next code.')
    codes = new_recovery_codes()
    table.update_item(
        Key={'PK': profile['PK'], 'SK': PROFILE_SK},
        UpdateExpression='SET mfaEnabled = :y, mfaSecret = :s, mfaRecoveryHashes = :r, mfaPendingSecret = :e, mfaEnabledAt = :t',
        ExpressionAttributeValues={':y': True, ':s': pending, ':r': [_hash_recovery(c) for c in codes],
                                   ':e': '', ':t': now_iso()},
    )
    return {'mfaEnabled': True, 'recoveryCodes': codes}


@app.post("/admin/security/mfa/disable")
def admin_mfa_disable(payload: MfaDisablePayload, user: dict = Depends(require_roles('ADMIN'))):
    """Password plus a current code, so a walk-up attacker on an open session cannot switch it off."""
    profile = get_profile(user['pk'])
    if not profile.get('mfaEnabled'):
        raise HTTPException(status_code=409, detail='Two-factor is not switched on.')
    if not verify_password(payload.password, profile.get('passwordHash', '')):
        register_login_failure(profile)
        raise HTTPException(status_code=401, detail='Wrong password.')
    if not verify_mfa(profile, payload.code):
        raise HTTPException(status_code=400, detail='That authenticator code is not valid.')
    table.update_item(
        Key={'PK': profile['PK'], 'SK': PROFILE_SK},
        UpdateExpression='SET mfaEnabled = :n, mfaSecret = :e, mfaPendingSecret = :e, mfaRecoveryHashes = :r',
        ExpressionAttributeValues={':n': False, ':e': '', ':r': []},
    )
    return {'mfaEnabled': False}


# ----------------------------- app-level handlers --------------------------
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    # JSON API only: never render as a document or allow this response to be framed.
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    return response


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception):
    # Details go to CloudWatch only - callers never see internals (table names, ARNs, stack traces).
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Something went wrong. Please try again."})


# ------------------------------- public ------------------------------------
@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/auth/login")
def login(payload: LoginPayload, _throttle: None = Depends(login_throttle)):
    generic = HTTPException(status_code=401, detail="Invalid ID or password.")
    profile = find_login_profile(payload.identifier, payload.role)

    if not profile or not profile.get('passwordHash'):
        verify_password(payload.password, _DUMMY_HASH)          # equalise timing, reveal nothing
        raise generic

    if int(profile.get('lockedUntil', 0)) > int(time.time()):
        raise HTTPException(status_code=429, detail="Too many failed attempts. Please try again in a few minutes.")

    if not verify_password(payload.password, profile['passwordHash']):
        register_login_failure(profile)
        raise generic

    # The role toggle on the login screen must match the account (admins may use either)
    if payload.role and profile.get('role') != 'ADMIN' and payload.role.upper() != profile.get('role'):
        raise generic

    # Admins may switch on an authenticator app. The password is already correct at this point, so
    # asking for the code reveals nothing about the account, and a wrong code counts towards lockout.
    if profile.get('mfaEnabled'):
        if not str(payload.code or '').strip():
            raise HTTPException(status_code=401, detail="MFA_REQUIRED")
        if not verify_mfa(profile, payload.code):
            register_login_failure(profile)
            raise HTTPException(status_code=401, detail="That authenticator code is not valid. Try the next one.")
        profile = get_profile(profile['PK']) or profile   # a backup code is spent in the table

    clear_login_failures(profile)

    if profile.get('mustChangePassword'):
        # No session token until the temporary password has been replaced
        return session_payload(profile, with_token=False)
    record_login(profile)
    return session_payload(profile, with_token=True)


@app.post("/auth/complete-setup")
def complete_setup(payload: CompleteSetupPayload, _throttle: None = Depends(login_throttle)):
    """First login: replace the admin-issued temporary password and save baseline details."""
    # Coaches complete setup the same way; the entity type must be a provisionable one (never ADMIN).
    raw_id = unquote(str(payload.userId or '')).strip()
    role_prefix = raw_id.split('#', 1)[0] if '#' in raw_id else 'CLIENT'
    if role_prefix not in PROVISIONABLE_ROLES:
        raise HTTPException(status_code=400, detail="Invalid identifier.")
    pk = make_pk(role_prefix, raw_id)
    profile = get_profile(pk)
    generic = HTTPException(status_code=401, detail="Invalid ID or password.")

    if not profile or not profile.get('passwordHash'):
        verify_password(payload.currentPassword, _DUMMY_HASH)
        raise generic
    if int(profile.get('lockedUntil', 0)) > int(time.time()):
        raise HTTPException(status_code=429, detail="Too many failed attempts. Please try again in a few minutes.")
    if not verify_password(payload.currentPassword, profile['passwordHash']):
        register_login_failure(profile)
        raise generic
    if not profile.get('mustChangePassword'):
        raise HTTPException(status_code=409, detail="Setup has already been completed.")

    validate_new_password(payload.newPassword)
    if payload.newPassword == payload.currentPassword:
        raise HTTPException(status_code=400, detail="New password must be different from your temporary password.")

    role = profile.get('role', 'CLIENT')
    updates = {
        "passwordHash": hash_password(payload.newPassword),
        "mustChangePassword": False,
        "onboardingCompleted": True,
        "pwdChangedAt": int(time.time()) - 1,       # invalidates any token issued before this moment
        "failedAttempts": 0,
        "lockedUntil": 0,
        "updatedAt": now_iso(),
        **baseline_fields(role, payload.model_dump()),
    }
    updates = to_dynamo(updates)
    names = {f"#f{i}": k for i, k in enumerate(updates)}
    values = {f":v{i}": v for i, v in enumerate(updates.values())}
    expression = "SET " + ", ".join(f"#f{i} = :v{i}" for i in range(len(updates)))
    table.update_item(
        Key={'PK': pk, 'SK': PROFILE_SK},
        UpdateExpression=expression,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    fresh = get_profile(pk)
    record_login(fresh)
    return {"message": "Setup completed", "user": session_payload(fresh, with_token=True)}

@app.post("/auth/refresh")
def refresh_session(user: dict = Depends(current_user)):
    """Swap a still-valid token for a fresh 7-day one. The app calls this in the background so people
    who use it regularly are never asked to sign in again. Does not count as a new login."""
    profile = get_profile(user['pk'])
    if not profile or profile.get('mustChangePassword'):
        raise HTTPException(status_code=401, detail="Invalid or expired session. Please sign in again.")
    return session_payload(profile, with_token=True)


@app.post("/auth/logout")
def logout(user: dict = Depends(current_user)):
    """Marks the person as signed out so the Monitor stops showing them as online."""
    record_logout(user['pk'])
    return {"message": "Signed out"}


@app.post("/presence/ping")
def presence_ping(user: dict = Depends(current_user)):
    """Heartbeat sent by the open app every ~45 s. Authenticating already refreshes 'last seen';
    the reply carries the unread-message count for the navigation badge."""
    return {"serverTime": now_iso(), "unreadMessages": unread_message_count(user)}


# ---------------------------------------------------------------------------
# PUSH NOTIFICATIONS (Firebase Cloud Messaging, HTTP v1)
#
#   CLIENT#<id> / COACH#<id>   DEVICE#<sha256(token)[:32]>   one row per signed-in phone
#   DEVICE#<sha256(token)[:32]> OWNER                        which user currently owns that phone token
#
# The OWNER row exists so that when a different person signs in on the same phone, the previous
# person's row is removed and they stop receiving the new user's notifications.
# Sending is best-effort: a push failure must never fail the request (e.g. sending a chat message).
# ---------------------------------------------------------------------------
MAX_DEVICES_PER_USER = 5
DEVICE_PLATFORMS = {'android', 'ios', 'web'}
_fcm_state: Dict[str, Any] = {}


def _device_id(token: str) -> str:
    return hashlib.sha256(token.encode('utf-8')).hexdigest()[:32]


@app.post("/devices/register")
def register_device(payload: DevicePayload, user: dict = Depends(require_roles('CLIENT', 'COACH'))):
    """The app sends its FCM token after the user allows notifications. Safe to call on every launch."""
    token = (payload.token or '').strip()
    if not (20 <= len(token) <= 4096) or any(c.isspace() for c in token):
        raise HTTPException(status_code=400, detail="Invalid device token.")
    platform = (payload.platform or 'android').lower()
    if platform not in DEVICE_PLATFORMS:
        raise HTTPException(status_code=400, detail="Invalid platform.")

    did = _device_id(token)
    owner_key = {'PK': f"DEVICE#{did}", 'SK': 'OWNER'}
    previous = (table.get_item(Key=owner_key).get('Item') or {}).get('ownerPk')
    if previous and previous != user['pk']:
        table.delete_item(Key={'PK': previous, 'SK': f"DEVICE#{did}"})

    # Keep only the newest few phones per person
    mine = query_all(KeyConditionExpression=Key('PK').eq(user['pk']) & Key('SK').begins_with('DEVICE#'))
    others = sorted((d for d in mine if d['SK'] != f"DEVICE#{did}"), key=lambda d: d.get('updatedAt', ''))
    for stale in others[:max(0, len(others) - (MAX_DEVICES_PER_USER - 1))]:
        table.delete_item(Key={'PK': user['pk'], 'SK': stale['SK']})
        table.delete_item(Key={'PK': f"DEVICE#{stale['SK'][7:]}", 'SK': 'OWNER'})

    table.put_item(Item=to_dynamo({'PK': user['pk'], 'SK': f"DEVICE#{did}", 'type': 'DEVICE', 'token': token,
                                   'platform': platform, 'updatedAt': now_iso()}))
    table.put_item(Item={**owner_key, 'ownerPk': user['pk'], 'updatedAt': now_iso()})
    return {"message": "Device registered"}


@app.post("/devices/unregister")
def unregister_device(payload: DevicePayload, user: dict = Depends(require_roles('CLIENT', 'COACH'))):
    """Called on sign-out so the next person on this phone (or nobody) receives its notifications."""
    did = _device_id((payload.token or '').strip())
    table.delete_item(Key={'PK': user['pk'], 'SK': f"DEVICE#{did}"})
    owner_key = {'PK': f"DEVICE#{did}", 'SK': 'OWNER'}
    if (table.get_item(Key=owner_key).get('Item') or {}).get('ownerPk') == user['pk']:
        table.delete_item(Key=owner_key)
    return {"message": "Device removed"}


def _fcm_post(token: str, message: dict) -> int:
    """POST one message to FCM. Returns the HTTP status (isolated so tests can replace it)."""
    import urllib3
    from google.auth.transport.urllib3 import Request as GoogleRequest
    from google.oauth2 import service_account

    if 'creds' not in _fcm_state:
        info = json.loads(boto3.client('secretsmanager').get_secret_value(SecretId=FCM_SECRET_ARN)['SecretString'])
        _fcm_state['project'] = info['project_id']
        _fcm_state['http'] = urllib3.PoolManager(timeout=urllib3.Timeout(connect=2, read=3))
        _fcm_state['creds'] = service_account.Credentials.from_service_account_info(
            info, scopes=['https://www.googleapis.com/auth/firebase.messaging'])
    creds = _fcm_state['creds']
    if not creds.valid:
        creds.refresh(GoogleRequest(_fcm_state['http']))
    res = _fcm_state['http'].request(
        'POST', f"https://fcm.googleapis.com/v1/projects/{_fcm_state['project']}/messages:send",
        body=json.dumps({"message": {**message, "token": token}}).encode('utf-8'),
        headers={'Authorization': f"Bearer {creds.token}", 'Content-Type': 'application/json'})
    if res.status != 200:
        # FCM explains itself in the body (SENDER_ID_MISMATCH, UNREGISTERED, API not enabled...). Keep it for CloudWatch.
        logger.warning('FCM replied %s: %s', res.status, (res.data or b'')[:300])
    return res.status


def push_to_user(pk: str, title: str, body: str, data: Optional[Dict[str, str]] = None, tag: Optional[str] = None) -> int:
    """Send a notification to every phone the person is signed in on. Never raises. Returns how many were accepted."""
    if not FCM_SECRET_ARN:
        logger.info('push skipped: FCM_SERVICE_ACCOUNT_SECRET_ARN is not set on the Lambda')
        return 0
    delivered = 0
    try:
        devices = query_all(KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('DEVICE#'))
        if not devices:
            logger.info('push skipped: no phone registered for %s', pk)
        for dev in devices:
            message = {
                "notification": {"title": title[:60], "body": body[:140]},
                "data": {k: str(v) for k, v in (data or {}).items()},
                "android": {"priority": "HIGH",
                            "notification": {"channel_id": "messages", **({"tag": tag} if tag else {})}},
            }
            try:
                status = _fcm_post(dev['token'], message)
            except Exception:
                logger.warning('push failed for %s', pk, exc_info=True)
                continue
            if status == 200:
                delivered += 1
            elif status == 404:       # FCM: the app was uninstalled / token retired
                table.delete_item(Key={'PK': pk, 'SK': dev['SK']})
                table.delete_item(Key={'PK': f"DEVICE#{dev['SK'][7:]}", 'SK': 'OWNER'})
            else:
                logger.warning('push rejected (%s) for %s', status, pk)
        if devices:
            logger.info('push to %s: %s of %s phones accepted', pk, delivered, len(devices))
    except Exception:
        logger.warning('push skipped for %s', pk, exc_info=True)
    return delivered


# -------------------------------- admin ------------------------------------
@app.get("/admin/users")
def get_users(user: dict = Depends(require_roles('ADMIN'))):
    return parse_decimals([pick(p, ADMIN_VIEW_FIELDS) for p in all_profiles()])


@app.post("/admin/onboarding")
def save_onboarding(payload: OnboardingPayload, user: dict = Depends(require_roles('ADMIN'))):
    role = payload.role.strip().upper()
    if role not in PROVISIONABLE_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of {sorted(PROVISIONABLE_ROLES)}")

    name = clean_text(payload.name, 100)
    email = (clean_text(payload.email, 200) or '').lower()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required.")
    if not re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', email):
        raise HTTPException(status_code=400, detail="A valid email address is required.")
    if any(str(p.get('email', '')).lower() == email for p in all_profiles()):
        raise HTTPException(status_code=409, detail="That email is already registered.")

    temp_password = generate_temp_password()
    now = now_iso()
    base = {
        "SK": PROFILE_SK,
        "role": role,
        "name": name,
        "email": email,
        "status": "ACTIVE",
        "passwordHash": hash_password(temp_password),
        "mustChangePassword": True,
        "onboardingCompleted": bool(payload.onboardingCompleted),
        "pwdChangedAt": int(time.time()) - 1,
        "createdAt": now,
        "updatedAt": now,
        **baseline_fields(role, payload.model_dump()),
    }

    for _ in range(3):                                  # retry if two admins provision at the same instant
        user_id = next_user_id(role, name)
        try:
            table.put_item(
                Item=to_dynamo({**base, "PK": user_id, "userCode": short_id(user_id)}),
                ConditionExpression='attribute_not_exists(PK)',
            )
            break
        except ClientError as e:
            if error_code(e) != 'ConditionalCheckFailedException':
                raise
    else:
        raise HTTPException(status_code=409, detail="Could not allocate a unique ID, please retry.")

    # The temporary password exists in plain text ONLY in this response. Only its hash is stored.
    return {
        "message": "Provisioned successfully",
        "userId": user_id,
        "userCode": short_id(user_id),
        "tempPassword": temp_password,
        "role": role,
        "name": name,
    }


@app.get("/admin/dashboard/stats")
def get_admin_dashboard(user: dict = Depends(require_roles('ADMIN'))):
    profiles = all_profiles()
    generated_diets = len(scan_all(FilterExpression=Attr('SK').begins_with('DIET#')))
    online = sum(1 for u in profiles if u.get('role') != 'ADMIN' and profile_presence(u)['presence'] == 'ONLINE')
    return {
        "stats": [
            {"label": 'Total Users', "value": str(len(profiles)), "icon": 'Users', "glowColor": 'var(--text-primary)'},
            {"label": 'Active Coaches', "value": str(sum(1 for u in profiles if u.get('role') == 'COACH')), "icon": 'Shield', "glowColor": '#60A5FA'},
            {"label": 'Generated Diets', "value": str(generated_diets), "icon": 'Utensils', "glowColor": 'var(--accent-gold)'},
            {"label": 'Online Now', "value": str(online), "icon": 'Activity', "glowColor": 'var(--accent-green)', "isPulse": True},
        ]
    }


def _age_seconds(iso: Optional[str]) -> Optional[int]:
    dt = parse_iso(iso) if iso else None
    return max(0, int((datetime.now(timezone.utc) - dt).total_seconds())) if dt else None


def _presence(last_seen: Optional[str], ever_logged_in: bool, signed_out: bool = False) -> str:
    """ONLINE (heard from in the last 2.5 min) / TODAY (<24 h) / RECENT (<7 d) / INACTIVE / NEVER (has not signed in yet).
    Someone who pressed Sign Out is never ONLINE, even if their last request was seconds ago."""
    if not ever_logged_in and not last_seen:
        return 'NEVER'
    age = _age_seconds(last_seen)
    if age is None:
        return 'INACTIVE'
    if age <= ONLINE_WINDOW_SECONDS and not signed_out:
        return 'ONLINE'
    if age <= 86400:
        return 'TODAY'
    if age <= 7 * 86400:
        return 'RECENT'
    return 'INACTIVE'


def profile_presence(profile: dict) -> Dict[str, Any]:
    """Presence for one profile, using the same rules as the Monitor (used by chat headers too)."""
    active = profile.get('lastActiveAt') or profile.get('lastLoginAt')
    logout = profile.get('lastLogoutAt')
    signed_out = bool(logout) and (not active or str(active) <= str(logout))
    seen = max([x for x in (profile.get('lastActiveAt'), profile.get('lastLoginAt')) if x], default=None)
    return {
        'presence': _presence(seen, bool(profile.get('lastLoginAt')) or bool(seen), signed_out),
        'lastSeenAt': seen,
        'signedOut': signed_out,
    }


@app.get("/admin/monitor")
def get_admin_monitor(user: dict = Depends(require_roles('ADMIN'))):
    """Live roster for the admin Monitor page: every client and coach with sign-in and activity status."""
    profiles = all_profiles()
    names = {p['PK']: p.get('name') or short_id(p['PK']) for p in profiles}
    # One light pass over the table (only the few fields needed) instead of a query per user.
    rows = scan_all(
        FilterExpression=Attr('SK').begins_with('CHECKIN#') | Attr('SK').begins_with('WORKOUTLOG#')
        | Attr('SK').begins_with('SCHEDULE#') | Attr('SK').begins_with('TEMPLATE#') | Attr('SK').begins_with('3DAY')
        | Attr('SK').begins_with('HEALTH#') | Attr('SK').begins_with('MSG#'),
        ProjectionExpression='PK, SK, steps, completedAt, #st, sender',
        ExpressionAttributeNames={'#st': 'status'},
    )
    per: Dict[str, Dict[str, Any]] = {}

    def bucket_for(pk: str) -> Dict[str, Any]:
        return per.setdefault(pk, {'checkins': [], 'workouts': [], 'workoutStamps': [], 'schedules': 0,
                                   'templates': 0, 'threeDay': 0, 'health': {}, 'messagesSent': 0})

    for r in rows:
        bucket = bucket_for(r['PK'])
        kind, _, rest = r['SK'].partition('#')
        if kind == 'CHECKIN':
            bucket['checkins'].append(rest)
        elif kind == 'WORKOUTLOG':
            bucket['workouts'].append(rest.split('#', 1)[0])
            if r.get('completedAt'):
                bucket['workoutStamps'].append(r['completedAt'])
        elif kind == 'SCHEDULE':
            if r.get('status', 'ACTIVE') == 'ACTIVE':          # a cancelled plan is not an assigned plan
                bucket['schedules'] += 1
        elif kind == 'TEMPLATE':
            bucket['templates'] += 1
        elif kind.startswith('3DAY'):
            bucket['threeDay'] += 1
        elif kind == 'HEALTH':
            bucket['health'][rest] = r.get('steps')
        elif kind == 'MSG':
            if r.get('sender') == 'CLIENT':
                bucket['messagesSent'] += 1

    events: List[dict] = []
    now_ts = int(time.time())
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    week_ago = (datetime.now(timezone.utc) - timedelta(days=6)).strftime('%Y-%m-%d')
    clients, coaches = [], []
    summary = {'totalClients': 0, 'totalCoaches': 0, 'onlineNow': 0, 'activeToday': 0, 'neverSignedIn': 0,
               'inactive7d': 0, 'unassignedClients': 0, 'lockedAccounts': 0, 'disabledAccounts': 0}

    def base(p: dict, b: dict) -> dict:
        last_checkin = max(b['checkins']) if b['checkins'] else None
        last_workout = max(b['workouts']) if b['workouts'] else None
        pres = profile_presence(p)
        seen = [x for x in (pres['lastSeenAt'], last_checkin) if x]
        last_seen = max(seen) if seen else None
        ever = bool(p.get('lastLoginAt')) or bool(last_seen)
        presence = _presence(last_seen, ever, pres['signedOut'] and last_seen == pres['lastSeenAt'])
        locked = int(p.get('lockedUntil', 0) or 0) > now_ts
        disabled = p.get('status') == 'INACTIVE'
        summary['onlineNow'] += presence == 'ONLINE'
        summary['activeToday'] += presence in ('ONLINE', 'TODAY')
        summary['neverSignedIn'] += presence == 'NEVER'
        summary['inactive7d'] += presence == 'INACTIVE'
        summary['lockedAccounts'] += locked
        summary['disabledAccounts'] += disabled
        for ts, kind in ((p.get('lastLoginAt'), 'login'), (last_checkin, 'checkin')):
            if ts:
                events.append({'type': kind, 'userId': short_id(p['PK']), 'name': p.get('name') or '', 'role': p.get('role'), 'at': ts})
        return {
            'id': short_id(p['PK']), 'pk': p['PK'], 'name': p.get('name') or 'Unnamed',
            'email': p.get('email', ''), 'role': p.get('role'),
            'accountStatus': 'DISABLED' if disabled else 'LOCKED' if locked else 'ACTIVE',
            'presence': presence, 'lastSeenAt': last_seen, 'signedOut': pres['signedOut'],
            'lastLoginAt': p.get('lastLoginAt'), 'lastLogoutAt': p.get('lastLogoutAt'),
            'loginCount': int(p.get('loginCount', 0) or 0),
            'createdAt': p.get('createdAt'), 'pendingFirstLogin': bool(p.get('mustChangePassword')),
            'lastCheckInAt': last_checkin, 'lastWorkoutDate': last_workout,
        }

    empty = {'checkins': [], 'workouts': [], 'workoutStamps': [], 'schedules': 0, 'templates': 0,
             'threeDay': 0, 'health': {}, 'messagesSent': 0}
    coach_clients_map: Dict[str, List[dict]] = {}
    for p in profiles:
        b = per.get(p['PK'], empty)
        role = p.get('role')
        if role == 'CLIENT':
            row = base(p, b)
            coach_ref = p.get('coachId') or ''
            coach_pk = make_pk('COACH', coach_ref) if coach_ref else ''
            steps_today = b['health'].get(today)
            row.update({
                'coachId': short_id(coach_pk) if coach_pk else None,
                'coachName': names.get(coach_pk) if coach_pk else None,
                'workoutsThisWeek': len({d for d in b['workouts'] if d >= week_ago}),
                'checkinsTotal': len(b['checkins']),
                'plansAssigned': b['schedules'],
                'threeDayEntries': b['threeDay'],
                'onboardingCompleted': bool(p.get('onboardingCompleted', False)),
                'stepsToday': steps_today,
                'messagesSent': b['messagesSent'],
            })
            summary['totalClients'] += 1
            summary['unassignedClients'] += 0 if coach_pk else 1
            clients.append(row)
            if coach_pk:
                coach_clients_map.setdefault(coach_pk, []).append(row)
        elif role == 'COACH':
            coaches.append((p, b))
            summary['totalCoaches'] += 1

    coach_rows = []
    for p, b in coaches:
        row = base(p, b)
        mine = coach_clients_map.get(p['PK'], [])
        row.update({
            'clientCount': len(mine),
            'clientsOnlineNow': sum(1 for c in mine if c['presence'] == 'ONLINE'),
            'clientsNeedingAttention': sum(1 for c in mine if c['presence'] in ('INACTIVE', 'NEVER')),
            'templates': b['templates'],
            'specialization': p.get('specialization', ''),
        })
        coach_rows.append(row)

    # Workout events use the real completion time (not just the date) so they sort correctly with logins and check-ins.
    for p in profiles:
        if p.get('role') != 'CLIENT':
            continue
        stamps = per.get(p['PK'], empty)['workoutStamps']
        if stamps:
            events.append({'type': 'workout', 'userId': short_id(p['PK']), 'name': p.get('name') or '',
                           'role': 'CLIENT', 'at': max(stamps)})
    events.sort(key=lambda e: e['at'], reverse=True)

    clients.sort(key=lambda c: (c['lastSeenAt'] or ''), reverse=True)
    coach_rows.sort(key=lambda c: (c['lastSeenAt'] or ''), reverse=True)
    return parse_decimals({
        'generatedAt': now_iso(),
        'summary': summary,
        'clients': clients,
        'coaches': coach_rows,
        'recentEvents': events[:25],
    })


@app.get("/admin/system-status")
def get_system_status(user: dict = Depends(require_roles('ADMIN'))):
    profiles = all_profiles()
    return {
        "users": len(profiles),
        "coaches": sum(1 for u in profiles if u.get('role') == 'COACH'),
        "clients": sum(1 for u in profiles if u.get('role') == 'CLIENT'),
        "status": "ok",
    }


@app.delete("/admin/users/{userId}")
def delete_user(userId: str, user: dict = Depends(require_roles('ADMIN'))):
    pk = unquote(userId).strip()
    if '#' not in pk:
        raise HTTPException(status_code=400, detail="userId must be a full key such as CLIENT#CLS001")
    if pk.split('#', 1)[0] == 'ADMIN':
        raise HTTPException(status_code=403, detail="Admin accounts cannot be deleted from here.")
    if pk.split('#', 1)[0] not in PROVISIONABLE_ROLES or not _ID_PATTERN.match(pk.split('#', 1)[1]):
        raise HTTPException(status_code=400, detail="Invalid userId.")
    try:
        table.delete_item(
            Key={'PK': pk, 'SK': PROFILE_SK},
            ConditionExpression='attribute_exists(PK)',
        )
    except ClientError as e:
        if error_code(e) == 'ConditionalCheckFailedException':
            raise HTTPException(status_code=404, detail="User not found.")
        raise
    return {"message": f"User {pk} deleted successfully"}


class AdminUserUpdatePayload(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None
    status: Optional[str] = None
    age: Optional[float] = None
    height: Optional[float] = None
    weight: Optional[float] = None
    activityLevel: Optional[str] = None
    primaryGoal: Optional[str] = None
    medicalNotes: Optional[str] = None
    specialization: Optional[str] = None


@app.put("/admin/users/{userId}")
def update_user(userId: str, payload: AdminUserUpdatePayload, user: dict = Depends(require_roles('ADMIN'))):
    """Admin-only user edit. Role and userCode remain immutable here."""
    pk = unquote(userId).strip()
    if '#' not in pk or pk.split('#', 1)[0] not in PROVISIONABLE_ROLES or not _ID_PATTERN.match(pk.split('#', 1)[1]):
        raise HTTPException(status_code=400, detail="userId must be a full key such as CLIENT#CLS001")
    profile = get_profile(pk)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found.")
    if profile.get('role') == 'ADMIN':
        raise HTTPException(status_code=403, detail="Admin accounts cannot be edited from here.")

    data = payload.model_dump(exclude_unset=True)
    updates: Dict[str, Any] = {}

    if 'name' in data:
        name = clean_text(data.get('name'), 100)
        if not name:
            raise HTTPException(status_code=400, detail="Name is required.")
        updates['name'] = name

    if 'email' in data:
        email = (clean_text(data.get('email'), 200) or '').lower()
        if not re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', email):
            raise HTTPException(status_code=400, detail="A valid email address is required.")
        if any(str(p.get('PK')) != pk and str(p.get('email', '')).lower() == email for p in all_profiles()):
            raise HTTPException(status_code=409, detail="That email is already registered.")
        updates['email'] = email

    if 'status' in data:
        status = str(data.get('status') or '').strip().upper()
        if status not in {'ACTIVE', 'INACTIVE'}:
            raise HTTPException(status_code=400, detail="Status must be ACTIVE or INACTIVE.")
        updates['status'] = status

    baseline = baseline_fields(profile.get('role', 'CLIENT'), data)
    updates.update(baseline)

    if not updates:
        raise HTTPException(status_code=400, detail="No changes provided.")

    updates['updatedAt'] = now_iso()
    updates = to_dynamo(updates)
    names = {f"#f{i}": k for i, k in enumerate(updates)}
    values = {f":v{i}": v for i, v in enumerate(updates.values())}
    expression = "SET " + ", ".join(f"#f{i} = :v{i}" for i in range(len(updates)))

    table.update_item(
        Key={'PK': pk, 'SK': PROFILE_SK},
        UpdateExpression=expression,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )

    fresh = get_profile(pk)
    return {"message": "User updated successfully", "user": pick(fresh or {}, ADMIN_VIEW_FIELDS)}


@app.post("/admin/users/{userId}/reset-password")
def reset_user_password(userId: str, user: dict = Depends(require_roles('ADMIN'))):
    """Generate a new temporary password, require change on next login, and revoke old sessions."""
    pk = unquote(userId).strip()
    if '#' not in pk or pk.split('#', 1)[0] not in PROVISIONABLE_ROLES or not _ID_PATTERN.match(pk.split('#', 1)[1]):
        raise HTTPException(status_code=400, detail="userId must be a full key such as CLIENT#CLS001")
    profile = get_profile(pk)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found.")
    if profile.get('role') == 'ADMIN':
        raise HTTPException(status_code=403, detail="Admin passwords cannot be reset from here.")

    temp_password = generate_temp_password()
    table.update_item(
        Key={'PK': pk, 'SK': PROFILE_SK},
        UpdateExpression=(
            "SET passwordHash = :h, mustChangePassword = :m, "
            "pwdChangedAt = :p, failedAttempts = :f, lockedUntil = :l, updatedAt = :u"
        ),
        ExpressionAttributeValues={
            ':h': hash_password(temp_password),
            ':m': True,
            ':p': int(time.time()) - 1,
            ':f': 0,
            ':l': 0,
            ':u': now_iso(),
        },
    )

    return {
        "message": "Temporary password generated successfully.",
        "userId": pk,
        "userCode": short_id(pk),
        "tempPassword": temp_password,
    }


@app.put("/admin/users/{clientId}/assign")
def assign_coach(clientId: str, payload: AssignPayload, user: dict = Depends(require_roles('ADMIN'))):
    client_pk = make_pk('CLIENT', clientId)
    coach_pk = make_pk('COACH', payload.coachId)

    coach = get_profile(coach_pk)
    if not coach or coach.get('role') != 'COACH':
        raise HTTPException(status_code=404, detail="Coach not found.")
    client = get_profile(client_pk)
    if not client or client.get('role') != 'CLIENT':
        raise HTTPException(status_code=404, detail="Client not found.")

    previous = client.get('coachId')
    if previous and make_pk('COACH', previous) != coach_pk:
        # the former coach no longer sees this client in their inbox
        table.delete_item(Key={'PK': make_pk('COACH', previous), 'SK': inbox_sk(client_pk)})

    response = table.update_item(
        Key={'PK': client_pk, 'SK': PROFILE_SK},
        UpdateExpression="SET coachId = :c, updatedAt = :u",
        ExpressionAttributeValues={':c': coach_pk, ':u': now_iso()},
        ReturnValues="UPDATED_NEW",
    )
    return {"message": "Coach assigned successfully", "updated": parse_decimals(response.get('Attributes'))}


# ------------------------------- coach -------------------------------------
# NOTE: the /coach/templates/... routes are declared before /coach/{coachId}/... on purpose.
def template_owner(user: dict, coach_id: Optional[str]) -> Optional[str]:
    """Coaches are always pinned to their own templates; admins may name a coach (or search all)."""
    if user['role'] == 'COACH':
        return user['pk']
    return make_pk('COACH', coach_id) if coach_id else None


@app.get("/coach/templates/{templateId}")
def get_template(templateId: str, coachId: Optional[str] = None, user: dict = Depends(require_roles('COACH', 'ADMIN'))):
    item = find_template(templateId, template_owner(user, coachId))
    if not item:
        raise HTTPException(status_code=404, detail="Template not found.")
    return template_out(item)


@app.put("/coach/templates/{templateId}")
def update_template(templateId: str, payload: TemplatePayload, coachId: Optional[str] = None,
                    user: dict = Depends(require_roles('COACH', 'ADMIN'))):
    item = find_template(templateId, template_owner(user, coachId))
    if not item:
        raise HTTPException(status_code=404, detail="Template not found.")

    changes = payload.model_dump(exclude_unset=True)
    for key, limit in (('title', 100), ('description', 500), ('goal', 50), ('workoutDays', 50), ('activities', 50)):
        if key in changes:
            changes[key] = clean_text(changes[key], limit)
    for key, limit in (('level', 50), ('estimatedDuration', 50), ('equipment', 200)):
        if key in changes:
            changes[key] = clean_text(changes[key], limit)
    if 'referenceImageKey' in changes:
        changes['referenceImageKey'] = clean_reference_key(item['PK'], changes['referenceImageKey'])
    if 'exercises' in changes:
        changes['exercises'] = clean_exercises(changes['exercises'])

    item.update(to_dynamo(changes))
    if changes.get('exercises') is not None and 'activities' not in changes:
        item['activities'] = f"{len(changes['exercises'])} Exercises"
    item['updatedAt'] = now_iso()
    table.put_item(Item=item)
    return template_out(item)


@app.get("/coach/{coachId}/templates")
def get_coach_templates(coachId: str, user: dict = Depends(require_roles('COACH', 'ADMIN'))):
    coach_pk = make_pk('COACH', coachId)
    authorize_coach_scope(user, coach_pk)
    items = query_all(KeyConditionExpression=Key('PK').eq(coach_pk) & Key('SK').begins_with('TEMPLATE#'))
    return {"templates": [template_out(i) for i in items]}


def build_template_item(coach_pk: str, data: dict) -> dict:
    """Validate form/import data and build the DynamoDB item for a new template."""
    exercises = clean_exercises(data.get('exercises')) or []
    now = now_iso()
    return to_dynamo({
        "PK": coach_pk,
        "SK": f"TEMPLATE#tpl_{uuid.uuid4().hex[:8]}",
        "type": "TEMPLATE",
        "title": clean_text(data.get('title'), 100) or 'Untitled Template',
        "description": clean_text(data.get('description'), 500) or '',
        "goal": clean_text(data.get('goal'), 50) or 'Maintenance',
        "workoutDays": clean_text(data.get('workoutDays'), 50) or '',
        "activities": clean_text(data.get('activities'), 50) or f"{len(exercises)} Exercises",
        "exercises": exercises,
        "level": clean_text(data.get('level'), 50) or '',
        "estimatedDuration": clean_text(data.get('estimatedDuration'), 50) or '',
        "equipment": clean_text(data.get('equipment'), 200) or '',
        "referenceImageKey": clean_reference_key(coach_pk, data.get('referenceImageKey')),
        "createdAt": now,
        "updatedAt": now,
    })


@app.post("/coach/{coachId}/templates")
def create_template(coachId: str, payload: TemplatePayload, user: dict = Depends(require_roles('COACH', 'ADMIN'))):
    coach_pk = make_pk('COACH', coachId)
    authorize_coach_scope(user, coach_pk)
    item = build_template_item(coach_pk, payload.model_dump(exclude_unset=True))
    table.put_item(Item=item)
    return template_out(item)


# ---- bulk import of templates from JSON files ----
# Field names other tools / spreadsheets commonly use, mapped to the ones the app stores.
_TEMPLATE_KEYS = {
    'title': ('title', 'name', 'program', 'plan', 'template'),
    'description': ('description', 'summary', 'overview', 'about'),
    'goal': ('goal', 'objective', 'focus'),
    'level': ('level', 'difficulty', 'experience'),
    'workoutDays': ('workoutdays', 'workout_days', 'days', 'schedule', 'weekdays'),
    'estimatedDuration': ('estimatedduration', 'estimated_duration', 'duration', 'time'),
    'equipment': ('equipment', 'gear'),
}
_EXERCISE_KEYS = {
    'name': ('name', 'exercise', 'exercise_name', 'movement', 'title'),
    'sets': ('sets', 'set', 'num_sets'),
    'reps': ('reps', 'rep', 'repetitions', 'reps_time', 'reps/time', 'time'),
    'rest': ('rest', 'rest_time', 'rest_period'),
    'tempo': ('tempo',),
    'weight': ('weight', 'load'),
    'rpe': ('rpe',),
    'notes': ('notes', 'note', 'cues', 'instructions', 'comments', 'coach_notes'),
    'section': ('section', 'block', 'group', 'phase'),
    'type': ('type', 'category', 'kind'),
}


def _pick_value(source: dict, names: tuple) -> str:
    lowered = {str(k).strip().lower(): v for k, v in source.items()}
    for name in names:
        value = lowered.get(name)
        if value is None or value == '' or value == []:
            continue
        if isinstance(value, (list, tuple)):
            value = ' / '.join(str(v).strip() for v in value if str(v).strip())
        return str(value).strip()
    return ''


def normalize_import_template(raw: Any) -> tuple:
    """One imported JSON object -> (clean template data, warnings).  Raises ValueError with a readable reason.
    Over-long text is shortened rather than rejected, so a good file is not refused over one long note."""
    if not isinstance(raw, dict):
        raise ValueError("Not a template object.")
    lowered = {str(k).strip().lower(): v for k, v in raw.items()}
    rows = next((lowered[k] for k in ('exercises', 'workout', 'movements', 'items') if isinstance(lowered.get(k), list)), None)
    if not rows:
        raise ValueError("No exercises found.")
    warnings: List[str] = []
    limits = {'title': 100, 'description': 500, 'goal': 50, 'level': 50, 'workoutDays': 50, 'estimatedDuration': 50, 'equipment': 200}
    data: Dict[str, Any] = {key: _pick_value(raw, names)[:limits[key]] for key, names in _TEMPLATE_KEYS.items()}
    ex_limits = {'name': 150, 'sets': 100, 'reps': 100, 'rest': 100, 'tempo': 100, 'weight': 100, 'rpe': 100,
                 'notes': 500, 'section': 100, 'type': 100}
    exercises = []
    for index, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            warnings.append(f"Row {index} skipped (not an object).")
            continue
        ex = {key: _pick_value(row, names)[:ex_limits[key]] for key, names in _EXERCISE_KEYS.items()}
        if not ex['name']:
            warnings.append(f"Row {index} skipped (no exercise name).")
            continue
        exercises.append(ex)
    if not exercises:
        raise ValueError("No exercises with a name found.")
    if len(exercises) > 100:
        warnings.append("Only the first 100 exercises were kept.")
        exercises = exercises[:100]
    for i, ex in enumerate(exercises, start=1):
        ex['order'] = str(i)
        ex['id'] = str(i)
    data['exercises'] = exercises
    data['activities'] = f"{len(exercises)} Exercises"
    return data, warnings


@app.post("/coach/{coachId}/templates/import")
def import_templates(coachId: str, payload: ImportTemplatesPayload,
                     user: dict = Depends(require_roles('COACH', 'ADMIN'))):
    """Create several templates at once from parsed JSON. Each is checked on its own: a bad one is
    reported back and skipped, the good ones are still saved."""
    coach_pk = make_pk('COACH', coachId)
    authorize_coach_scope(user, coach_pk)
    if not payload.templates:
        raise HTTPException(status_code=400, detail="The file contains no templates.")
    if len(payload.templates) > IMPORT_MAX_TEMPLATES:
        raise HTTPException(status_code=400, detail=f"Import at most {IMPORT_MAX_TEMPLATES} templates at a time.")

    created, skipped = [], []
    for index, raw in enumerate(payload.templates, start=1):
        label = _pick_value(raw, _TEMPLATE_KEYS['title']) if isinstance(raw, dict) else ''
        try:
            data, warnings = normalize_import_template(raw)
            item = build_template_item(coach_pk, data)
            table.put_item(Item=item)
            created.append({**template_out(item), 'warnings': warnings})
        except ValueError as exc:
            skipped.append({'index': index, 'title': label or f"Template {index}", 'reason': str(exc)})
        except HTTPException as exc:
            skipped.append({'index': index, 'title': label or f"Template {index}", 'reason': str(exc.detail)})
    return {"created": created, "skipped": skipped}


@app.get("/coach/{coachId}/clients")
def get_coach_clients(coachId: str, user: dict = Depends(require_roles('COACH', 'ADMIN'))):
    coach_pk = make_pk('COACH', coachId)
    authorize_coach_scope(user, coach_pk)
    inbox = {r['SK']: r for r in query_all(KeyConditionExpression=Key('PK').eq(coach_pk) & Key('SK').begins_with('INBOX#'))}
    rows = []
    for p in coach_clients(coach_pk):
        row = summarize_client(p, with_health=True)[0]
        row['unreadMessages'] = int(inbox.get(inbox_sk(p['PK']), {}).get('unread', 0) or 0)
        rows.append(row)
    rows.sort(key=lambda r: r['name'].lower())
    return parse_decimals({"clients": rows})


@app.get("/coach/{coachId}/dashboard")
def get_coach_dashboard(coachId: str, user: dict = Depends(require_roles('COACH', 'ADMIN'))):
    """Coach overview. Every number comes from what clients actually recorded in the last 7 days:
    check-ins (adherence), daily health snapshots (steps / sleep / water) and workout logs."""
    coach_pk = make_pk('COACH', coachId)
    authorize_coach_scope(user, coach_pk)

    clients = coach_clients(coach_pk)
    today = utc_today()
    days = date_window(today, 7)
    window_end = (datetime.strptime(today, '%Y-%m-%d').date() + timedelta(days=1)).isoformat()

    total = len(clients)
    checked_in = 0
    adherence_scores: List[int] = []
    step_pcts: List[int] = []
    step_values: List[float] = []
    sleep_pcts: List[int] = []
    water_pcts: List[int] = []
    planned_total = done_total = 0
    day_steps: Dict[str, List[int]] = {d: [] for d in days}
    day_work: Dict[str, Dict[str, int]] = {d: {'planned': 0, 'done': 0} for d in days}
    roster: List[dict] = []
    events: List[dict] = []
    online_now = 0

    for profile in clients:
        row, meta = summarize_client(profile)
        pk = profile['PK']
        if meta['days'] is not None and meta['days'] <= 7:
            checked_in += 1
        for c in latest_checkins(pk, 7):
            s = adherence_score(c.get('adherence'))
            if s is not None:
                adherence_scores.append(s)

        health = health_range(pk, days[0], window_end)
        for d, item in health.items():
            if item.get('steps') is not None:
                p = pct_of(item['steps'], STEP_GOAL)
                if p is not None:
                    step_pcts.append(p)
                    step_values.append(float(item['steps']))
                    if d in day_steps:
                        day_steps[d].append(p)
            if item.get('sleepHours') is not None:
                p = pct_of(item['sleepHours'], SLEEP_GOAL)
                if p is not None:
                    sleep_pcts.append(p)
            if item.get('hydration') is not None:
                p = pct_of(item['hydration'], HYDRATION_GOAL)
                if p is not None:
                    water_pcts.append(p)

        schedules = [i for i in query_all(KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('SCHEDULE#'))
                     if i.get('status', 'ACTIVE') == 'ACTIVE']
        logs = {i['SK']: i for i in query_all(KeyConditionExpression=Key('PK').eq(pk) & Key('SK').begins_with('WORKOUTLOG#'))}
        wk = workout_summary(schedules, logs, today)
        planned_total += wk['planned']
        done_total += wk['done']
        for w in wk['week']:
            if w['date'] in day_work:
                day_work[w['date']]['planned'] += w['planned']
                day_work[w['date']]['done'] += w['done']
        for log in logs.values():
            if log.get('completedAt'):
                events.append({'ts': log['completedAt'], 'client': row['name'], 'id': row['id'],
                               'action': 'Completed a workout', 'status': 'completed'})

        pres = profile_presence(profile)
        online_now += pres['presence'] == 'ONLINE'
        h_day = max(health) if health else None
        h_item = health.get(h_day, {}) if h_day else {}
        sevens = [float(health[d]['steps']) for d in days if d in health and health[d].get('steps') is not None]
        roster.append({
            **row,
            'presence': pres['presence'],
            'lastSeenAt': pres['lastSeenAt'],
            'stepsToday': h_item.get('steps'),
            'stepsDate': h_day,
            'stepsAvg7d': round(sum(sevens) / len(sevens)) if sevens else None,
            'sleepHours': h_item.get('sleepHours'),
            'hydration': h_item.get('hydration'),
            'workoutsDone7d': wk['done'],
            'workoutsPlanned7d': wk['planned'],
            'workoutCompletion': wk['completion'],
        })
        if meta['lastTs']:
            weight = f" • {parse_decimals(meta['weight'])} kg" if meta['weight'] is not None else ''
            events.append({'ts': meta['lastTs'], 'client': row['name'], 'id': row['id'],
                           'action': f"Submitted weekly check-in{weight}",
                           'status': 'completed' if (meta['latestScore'] or 0) >= 75 else 'alert'})

    def avg(values: List[int]) -> Optional[int]:
        return round(sum(values) / len(values)) if values else None

    active = sum(1 for p in clients if p.get('status', 'ACTIVE') != 'INACTIVE')
    retention = f"{round(100 * active / total)}%" if total else '0%'
    workout_completion = round(100 * done_total / planned_total) if planned_total else None
    sleep_consistency = avg(sleep_pcts)
    hydration = avg(water_pcts)
    adherence = avg(adherence_scores)
    steps_pct = avg(step_pcts)
    avg_steps = round(sum(step_values) / len(step_values)) if step_values else None

    weekly = []
    for d in days:
        w = day_work[d]
        weekly.append({
            'date': d,
            'stepsPct': avg(day_steps[d]),
            'workoutPct': round(100 * w['done'] / w['planned']) if w['planned'] else None,
        })

    events.sort(key=lambda e: e['ts'], reverse=True)
    activity = [{"id": f"{e['id']}-{i}", "client": e['client'], "action": e['action'], "status": e['status'],
                 "time": time_ago(e['ts'])} for i, e in enumerate(events[:10])]
    roster.sort(key=lambda r: (0 if r['status'] == 'needs-attention' else 1, r['name'].lower()))

    def stat(label: str, value: Any, icon: str, color: str) -> dict:
        return {"label": label, "name": label, "value": value, "icon": icon, "glowColor": color}

    return parse_decimals({
        "stats": [
            stat("Active Clients", str(total), "Users", "#4facfe"),
            stat("Weekly Check-ins", f"{checked_in}/{total}", "CheckCircle2", "#E5B869"),
            stat("Client Retention", retention, "TrendingUp", "#00E27B"),
            stat("Workout Completion", workout_completion, "Dumbbell", "#5B8CFF"),
            stat("Sleep Consistency", sleep_consistency, "Moon", "#8B7CFF"),
            stat("Hydration", hydration, "Droplets", "#55B7FF"),
            stat("Adherence", adherence, "Activity", "#62C7A5"),
            stat("Steps", steps_pct, "Footprints", "#A08CFF"),
        ],
        "summary": {
            "activeClients": total,
            "onlineNow": online_now,
            "workoutCompletion": workout_completion,
            "sleepConsistency": sleep_consistency,
            "hydration": hydration,
            "adherence": adherence,
            "stepsPct": steps_pct,
            "avgSteps": avg_steps,
            "stepGoal": STEP_GOAL,
        },
        "weekly": weekly,
        "clients": roster,
        "recentActivity": activity,
    })


# ------------------------------- messaging ---------------------------------
# One conversation per client, between that client and the coach they are assigned to.
# Admins are deliberately NOT part of conversations (coach/client chats are private).
class MessagePayload(BaseModel):
    text: str
    clientMsgId: Optional[str] = None


THREAD_META_SK = 'THREAD#META'


def inbox_sk(client_pk: str) -> str:
    return f"INBOX#{short_id(client_pk)}"


def thread_access(user: dict, client_id: str):
    """Resolve a conversation and make sure the caller belongs to it.
    Returns (client_pk, client_profile, coach_pk or None)."""
    client_pk = make_pk('CLIENT', client_id)
    if user['role'] not in ('CLIENT', 'COACH'):
        raise HTTPException(status_code=403, detail="You do not have access to this conversation.")
    if user['role'] == 'CLIENT' and user['pk'] != client_pk:
        raise HTTPException(status_code=403, detail="You do not have access to this conversation.")
    client = get_profile(client_pk)
    if not client or client.get('role') != 'CLIENT':
        raise HTTPException(status_code=404, detail="Conversation not found.")
    coach_ref = client.get('coachId')
    coach_pk = make_pk('COACH', coach_ref) if coach_ref else None
    if user['role'] == 'COACH' and coach_pk != user['pk']:
        raise HTTPException(status_code=403, detail="You do not have access to this conversation.")
    return client_pk, client, coach_pk


def message_out(item: dict, viewer_role: str) -> dict:
    return {
        'id': item['SK'],
        'clientMsgId': item.get('clientMsgId') or None,
        'sender': item.get('sender'),
        'senderName': item.get('senderName', ''),
        'text': item.get('text', ''),
        'createdAt': item.get('createdAt', ''),
        'mine': item.get('sender') == viewer_role,
    }


def unread_message_count(user: dict) -> int:
    """Unread messages for the navigation badge. Never allowed to break the request it rides on."""
    try:
        if user['role'] == 'CLIENT':
            meta = table.get_item(Key={'PK': user['pk'], 'SK': THREAD_META_SK}).get('Item') or {}
            return int(meta.get('clientUnread', 0) or 0)
        if user['role'] == 'COACH':
            rows = query_all(KeyConditionExpression=Key('PK').eq(user['pk']) & Key('SK').begins_with('INBOX#'))
            return sum(int(r.get('unread', 0) or 0) for r in rows)
    except Exception:
        logger.warning('could not count unread messages for %s', user.get('pk'))
    return 0


def peer_summary(profile: Optional[dict], role: str) -> Optional[dict]:
    if not profile:
        return None
    return {'id': short_id(profile['PK']), 'name': profile.get('name') or 'Unnamed', 'role': role,
            **profile_presence(profile)}


@app.get("/messages/threads")
def list_threads(user: dict = Depends(require_roles('CLIENT', 'COACH'))):
    """CLIENT: their single conversation with their coach.  COACH: one row per assigned client, newest first."""
    if user['role'] == 'CLIENT':
        client = get_profile(user['pk']) or {}
        coach_ref = client.get('coachId')
        coach = get_profile(make_pk('COACH', coach_ref)) if coach_ref else None
        meta = table.get_item(Key={'PK': user['pk'], 'SK': THREAD_META_SK}).get('Item') or {}
        last = latest_message(user['pk'])
        return parse_decimals({'threads': [{
            'clientId': short_id(user['pk']),
            'peer': peer_summary(coach, 'COACH'),
            'unread': int(meta.get('clientUnread', 0) or 0),
            'lastMessageAt': last.get('createdAt') if last else None,
            'lastMessageText': (last or {}).get('text', '')[:140],
            'lastSender': (last or {}).get('sender'),
        }]})

    inbox = {r['SK']: r for r in query_all(KeyConditionExpression=Key('PK').eq(user['pk']) & Key('SK').begins_with('INBOX#'))}
    rows = []
    for p in coach_clients(user['pk']):
        box = inbox.get(inbox_sk(p['PK']), {})
        rows.append({
            'clientId': short_id(p['PK']),
            'peer': peer_summary(p, 'CLIENT'),
            'unread': int(box.get('unread', 0) or 0),
            'lastMessageAt': box.get('lastMessageAt'),
            'lastMessageText': box.get('lastMessageText', ''),
            'lastSender': box.get('lastSender'),
        })
    rows.sort(key=lambda r: ((r['lastMessageAt'] or ''), (r['peer'] or {}).get('name', '').lower()), reverse=True)
    return parse_decimals({'threads': rows})


def latest_message(client_pk: str) -> Optional[dict]:
    resp = table.query(KeyConditionExpression=Key('PK').eq(client_pk) & Key('SK').begins_with('MSG#'),
                       ScanIndexForward=False, Limit=1)
    items = resp.get('Items', [])
    return items[0] if items else None


def mark_thread_read(role: str, client_pk: str, ts: str) -> None:
    """Reset the reader's unread counter and move their read-marker (drives the 'Seen' tick)."""
    if role == 'CLIENT':
        table.update_item(Key={'PK': client_pk, 'SK': THREAD_META_SK},
                          UpdateExpression="SET clientUnread = :z, lastClientReadAt = :t",
                          ExpressionAttributeValues={':z': 0, ':t': ts})
    else:
        table.update_item(Key={'PK': client_pk, 'SK': THREAD_META_SK},
                          UpdateExpression="SET lastCoachReadAt = :t",
                          ExpressionAttributeValues={':t': ts})


@app.get("/messages/{clientId}")
def get_messages(clientId: str, after: Optional[str] = None, before: Optional[str] = None,
                 limit: int = 60, markRead: bool = True,
                 user: dict = Depends(require_roles('CLIENT', 'COACH'))):
    """Messages of one conversation, oldest first.
    default: the latest `limit`;  after=<createdAt>: only newer ones (used for polling);  before=<createdAt>: older page."""
    client_pk, client, coach_pk = thread_access(user, clientId)
    limit = max(1, min(int(limit), 100))
    has_more = False
    if after:
        if not parse_iso(after):
            raise HTTPException(status_code=400, detail="Invalid 'after' value.")
        items = table.query(KeyConditionExpression=Key('PK').eq(client_pk) & Key('SK').between(f"MSG#{after}", "MSG#~"),
                            Limit=200).get('Items', [])
    else:
        if before:
            if not parse_iso(before):
                raise HTTPException(status_code=400, detail="Invalid 'before' value.")
            cond = Key('PK').eq(client_pk) & Key('SK').between("MSG#", f"MSG#{before}")
        else:
            cond = Key('PK').eq(client_pk) & Key('SK').begins_with('MSG#')
        items = table.query(KeyConditionExpression=cond, ScanIndexForward=False, Limit=limit + 1).get('Items', [])
        has_more = len(items) > limit
        items = list(reversed(items[:limit]))

    meta = table.get_item(Key={'PK': client_pk, 'SK': THREAD_META_SK}).get('Item') or {}
    viewer = user['role']
    if markRead:
        try:
            if viewer == 'CLIENT':
                if int(meta.get('clientUnread', 0) or 0) > 0:
                    mark_thread_read('CLIENT', client_pk, now_iso())
            else:
                box = table.get_item(Key={'PK': user['pk'], 'SK': inbox_sk(client_pk)}).get('Item') or {}
                if int(box.get('unread', 0) or 0) > 0:
                    table.update_item(Key={'PK': user['pk'], 'SK': inbox_sk(client_pk)},
                                      UpdateExpression="SET unread = :z", ExpressionAttributeValues={':z': 0})
                    mark_thread_read('COACH', client_pk, now_iso())
        except Exception:
            logger.warning('could not mark thread read for %s', user['pk'])

    if viewer == 'CLIENT':
        peer = peer_summary(get_profile(coach_pk) if coach_pk else None, 'COACH')
        peer_read = meta.get('lastCoachReadAt')
    else:
        peer = peer_summary(client, 'CLIENT')
        peer_read = meta.get('lastClientReadAt')
    return parse_decimals({
        'messages': [message_out(i, viewer) for i in items],
        'peer': peer,
        'peerLastReadAt': peer_read,
        'hasMore': has_more,
        'canSend': bool(coach_pk),
        'serverTime': now_iso(),
    })


@app.post("/messages/{clientId}")
def send_message(clientId: str, payload: MessagePayload, user: dict = Depends(require_roles('CLIENT', 'COACH'))):
    client_pk, client, coach_pk = thread_access(user, clientId)
    if not coach_pk:
        raise HTTPException(status_code=409, detail="You do not have a coach assigned yet.")
    text = (payload.text or '').strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")
    if len(text) > MESSAGE_MAX_LENGTH:
        raise HTTPException(status_code=400, detail=f"Message is too long (max {MESSAGE_MAX_LENGTH} characters).")

    ts = now_iso()
    sender = user['role']
    item = to_dynamo({
        'PK': client_pk,
        'SK': f"MSG#{ts}#{uuid.uuid4().hex[:6]}",
        'type': 'MESSAGE',
        'sender': sender,
        'senderPk': user['pk'],
        'senderName': user.get('name') or '',
        'coachId': coach_pk,
        'text': text,
        'clientMsgId': clean_text(payload.clientMsgId, 64) or None,
        'createdAt': ts,
    })
    table.put_item(Item=item)

    preview = text[:140]
    box_key = {'PK': coach_pk, 'SK': inbox_sk(client_pk)}
    box_values = {':c': short_id(client_pk), ':n': client.get('name') or '', ':t': ts, ':x': preview, ':s': sender}
    if sender == 'CLIENT':
        table.update_item(Key={'PK': client_pk, 'SK': THREAD_META_SK},
                          UpdateExpression="SET lastMessageAt = :t, lastClientReadAt = :t, clientUnread = :z",
                          ExpressionAttributeValues={':t': ts, ':z': 0})
        table.update_item(Key=box_key,
                          UpdateExpression="SET clientId = :c, clientName = :n, lastMessageAt = :t, lastMessageText = :x, lastSender = :s ADD unread :one",
                          ExpressionAttributeValues={**box_values, ':one': 1})
    else:
        table.update_item(Key={'PK': client_pk, 'SK': THREAD_META_SK},
                          UpdateExpression="SET lastMessageAt = :t, lastCoachReadAt = :t ADD clientUnread :one",
                          ExpressionAttributeValues={':t': ts, ':one': 1})
        table.update_item(Key=box_key,
                          UpdateExpression="SET clientId = :c, clientName = :n, lastMessageAt = :t, lastMessageText = :x, lastSender = :s, unread = :z",
                          ExpressionAttributeValues={**box_values, ':z': 0})

    # Tell the other person's phone(s), even when the app is closed. Best-effort: never blocks the send.
    if sender == 'CLIENT':
        push_to_user(coach_pk, client.get('name') or 'New message', preview,
                     {'type': 'message', 'url': f"/coach/messages?client={short_id(client_pk)}"}, tag=f"msg-{short_id(client_pk)}")
    else:
        push_to_user(client_pk, user.get('name') or 'Your coach', preview,
                     {'type': 'message', 'url': '/client/messages'}, tag=f"msg-{short_id(client_pk)}")
    return {'message': message_out(item, sender)}


@app.post("/messages/{clientId}/read")
def mark_messages_read(clientId: str, user: dict = Depends(require_roles('CLIENT', 'COACH'))):
    client_pk, _client, _coach_pk = thread_access(user, clientId)
    ts = now_iso()
    if user['role'] == 'COACH':
        table.update_item(Key={'PK': user['pk'], 'SK': inbox_sk(client_pk)},
                          UpdateExpression="SET unread = :z", ExpressionAttributeValues={':z': 0})
    mark_thread_read(user['role'], client_pk, ts)
    return {'message': 'Marked as read'}


# -------------------------- client check status ----------------------------
@app.get("/athlete/{athleteId}/check-status")
def get_athlete_check_status(athleteId: str, user: dict = Depends(require_roles('CLIENT'))):
    client_pk = make_pk('CLIENT', athleteId)
    authorize_athlete_scope(user, client_pk)
    return parse_decimals(three_day_status(client_pk))


@app.put("/athlete/check-status/3-day-log/{day}")
def save_three_day_log(day: int, payload: ThreeDayLogPayload, user: dict = Depends(require_roles('CLIENT'))):
    client_pk = user['pk']
    validate_three_day_day(day)
    cleaned_meals: Dict[str, str] = {}
    for meal, value in payload.meals.items():
        valid_meal = validate_three_day_meal(meal)
        cleaned_meals[valid_meal] = clean_text(value, 2000) or ''

    ts = now_iso()
    table.put_item(Item=to_dynamo({
        'PK': client_pk,
        'SK': f'3DAYLOG#DAY{day}',
        'type': 'THREE_DAY_LOG',
        'day': day,
        'meals': cleaned_meals,
        'updatedAt': ts,
        'createdAt': ts,
    }))
    status = three_day_status(client_pk)['days'][day - 1]['status']
    return {'message': '3-day log saved', 'day': day, 'status': status}


@app.post("/athlete/check-status/photos/upload-url")
def create_three_day_photo_upload(payload: ThreeDayPhotoUploadPayload, user: dict = Depends(require_roles('CLIENT'))):
    client_pk = user['pk']
    validate_three_day_day(payload.day)
    meal = validate_three_day_meal(payload.meal)
    if not CLIENT_MEDIA_BUCKET:
        raise HTTPException(status_code=503, detail='Photo storage is not configured.')
    if payload.contentType not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail='Unsupported image type.')

    original_name = clean_text(payload.fileName, 180) or 'photo'
    ext = ALLOWED_IMAGE_TYPES[payload.contentType]
    object_key = (
        f"clients/{short_id(client_pk)}/3-day-log/"
        f"day-{payload.day}/{meal.lower()}-{uuid.uuid4().hex}{ext}"
    )

    try:
        post = s3.generate_presigned_post(
            Bucket=CLIENT_MEDIA_BUCKET,
            Key=object_key,
            Fields={'Content-Type': payload.contentType},
            Conditions=[
                {'Content-Type': payload.contentType},
                ['content-length-range', 1, MAX_CLIENT_PHOTO_BYTES],
                ['starts-with', '$key', f'clients/{short_id(client_pk)}/3-day-log/day-{payload.day}/{meal.lower()}-'],
            ],
            ExpiresIn=300,
        )
    except ClientError:
        raise HTTPException(status_code=503, detail='Unable to prepare photo upload.')

    # Store no secret or URL in DynamoDB until the upload is confirmed.
    return {
        'uploadUrl': post['url'],
        'fields': post['fields'],
        'objectKey': object_key,
        'expiresIn': 300,
        'fileName': original_name,
    }


@app.post("/athlete/check-status/photos/complete")
def complete_three_day_photo(payload: ThreeDayPhotoCompletePayload, user: dict = Depends(require_roles('CLIENT'))):
    client_pk = user['pk']
    validate_three_day_day(payload.day)
    meal = validate_three_day_meal(payload.meal)
    if not CLIENT_MEDIA_BUCKET:
        raise HTTPException(status_code=503, detail='Photo storage is not configured.')

    prefix = f"clients/{short_id(client_pk)}/3-day-log/day-{payload.day}/{meal.lower()}-"
    if not payload.objectKey.startswith(prefix):
        raise HTTPException(status_code=403, detail='You do not have access to this upload.')

    try:
        head = s3.head_object(Bucket=CLIENT_MEDIA_BUCKET, Key=payload.objectKey)
    except ClientError:
        raise HTTPException(status_code=400, detail='Uploaded photo could not be verified.')

    content_type = head.get('ContentType', '')
    size = int(head.get('ContentLength', 0))
    if content_type not in ALLOWED_IMAGE_TYPES or size <= 0 or size > MAX_CLIENT_PHOTO_BYTES:
        raise HTTPException(status_code=400, detail='Uploaded photo failed validation.')

    ts = now_iso()
    item = to_dynamo({
        'PK': client_pk,
        'SK': f'3DAYPHOTO#DAY{payload.day}#{meal.upper()}',
        'type': 'THREE_DAY_PHOTO',
        'day': payload.day,
        'meal': meal,
        'objectKey': payload.objectKey,
        'contentType': content_type,
        'size': size,
        'originalFileName': clean_text(payload.originalFileName, 180) or payload.objectKey.rsplit('/', 1)[-1],
        'uploadedAt': ts,
        'createdAt': ts,
    })
    table.put_item(Item=item)

    return {
        'message': 'Photo saved',
        'photo': {
            'id': item['SK'],
            'day': payload.day,
            'meal': meal,
            'originalFileName': item['originalFileName'],
            'contentType': content_type,
            'uploadedAt': ts,
        },
    }


@app.get("/coach/{coachId}/clients/{clientId}/check-status")
def get_coach_client_check_status(coachId: str, clientId: str, user: dict = Depends(require_roles('COACH'))):
    coach_pk = make_pk('COACH', coachId)
    client_pk = make_pk('CLIENT', clientId)
    authorize_coach_scope(user, coach_pk)
    client = get_profile(client_pk)
    if not client or client.get('role') != 'CLIENT':
        raise HTTPException(status_code=404, detail='Client not found.')
    if user['role'] == 'COACH' and client.get('coachId') not in (user['pk'], short_id(user['pk'])):
        raise HTTPException(status_code=403, detail='You do not have access to this resource.')
    return parse_decimals(three_day_status(client_pk))


# ------------------------------- athlete -----------------------------------
def schedule_days(spec: str) -> Optional[set]:
    """'Mon / Wed / Fri' -> {0, 2, 4};  'Mon-Fri' -> {0..4}.  Empty or unreadable -> None (no fixed weekdays)."""
    text = (spec or '').lower()
    found = set()
    for a, b in re.findall(r'\b([a-z]{3})[a-z]*\s*(?:-|–|—|to)\s*([a-z]{3})[a-z]*\b', text):
        if a in WEEKDAYS and b in WEEKDAYS:
            i, j = WEEKDAYS.index(a), WEEKDAYS.index(b)
            found.update(range(i, j + 1) if i <= j else list(range(i, 7)) + list(range(0, j + 1)))
    found.update(WEEKDAYS.index(w) for w in (t.strip()[:3] for t in re.split(r'[^a-z]+', text)) if w in WEEKDAYS)
    return found or None


def workout_summary(schedules: List[dict], logs: Dict[str, dict], day: str) -> dict:
    """Today's sessions from the assigned plans, plus the last-7-days completion numbers."""
    today = datetime.strptime(day, '%Y-%m-%d').date()
    today_rows, planned, done = [], 0, 0
    week: Dict[str, Dict[str, int]] = {}
    for offset in range(7):
        d = today - timedelta(days=offset)
        d_iso = d.isoformat()
        week[d_iso] = {'planned': 0, 'done': 0}
        for sched in schedules:
            if (sched.get('startDate') or '0000-00-00') > d_iso:
                continue
            days = schedule_days(sched.get('workoutDays', ''))
            if days is not None and d.weekday() not in days:
                continue
            logged = f"WORKOUTLOG#{d_iso}#{sched['assignmentId']}" in logs
            planned += 1
            done += 1 if logged else 0
            week[d_iso]['planned'] += 1
            week[d_iso]['done'] += 1 if logged else 0
            if offset == 0:
                count = len(sched.get('exercises') or [])
                bits = [f"{count} exercises" if count else None, sched.get('estimatedDuration') or None]
                today_rows.append({
                    "id": f"SCHEDULE#{sched['assignmentId']}",
                    "assignmentId": sched['assignmentId'],
                    "title": sched.get('templateTitle') or 'Workout',
                    "subtitle": ' · '.join(b for b in bits if b) or 'Assigned workout',
                    "statusText": 'completed' if logged else 'pending',
                    "statusColor": 'green' if logged else 'gold',
                })
    return {"today": today_rows, "done": done, "planned": planned,
            "completion": round(100 * done / planned) if planned else None,
            "week": [{"date": d, **week[d]} for d in sorted(week)]}


@app.put("/athlete/workouts/log")
def log_workout(payload: WorkoutLogPayload, user: dict = Depends(require_roles('CLIENT'))):
    """Mark an assigned workout done (or not done) for a day. Feeds Today's training and the Workout tracker."""
    client_pk = user['pk']
    day = payload.date or datetime.now(timezone.utc).strftime('%Y-%m-%d')
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', day):
        raise HTTPException(status_code=400, detail='Invalid date.')
    sched = table.get_item(Key={'PK': client_pk, 'SK': f'SCHEDULE#{payload.assignmentId}'}).get('Item')
    if not sched or sched.get('status', 'ACTIVE') != 'ACTIVE':
        raise HTTPException(status_code=404, detail='Workout plan not found.')
    sk = f'WORKOUTLOG#{day}#{payload.assignmentId}'
    if payload.completed:
        ts = now_iso()
        table.put_item(Item=to_dynamo({
            'PK': client_pk, 'SK': sk, 'type': 'WORKOUT_LOG', 'assignmentId': payload.assignmentId,
            'date': day, 'completedAt': ts, 'createdAt': ts,
        }))
    else:
        table.delete_item(Key={'PK': client_pk, 'SK': sk})
    return {'message': 'Workout updated', 'date': day, 'assignmentId': payload.assignmentId, 'completed': payload.completed}


@app.get("/athlete/{athleteId}/dashboard")
def get_athlete_dashboard(athleteId: str, date: Optional[str] = None, user: dict = Depends(current_user)):
    """Today's training. The browser passes its LOCAL date (?date=YYYY-MM-DD) so the
    'today' a user in India sees is not shifted by the server running in UTC."""
    client_pk = make_pk('CLIENT', athleteId)
    authorize_athlete_scope(user, client_pk)
    day = date if date and re.match(r'^\d{4}-\d{2}-\d{2}$', date) else utc_today()
    items = query_all(
        KeyConditionExpression=Key('PK').eq(client_pk) & Key('SK').begins_with(f"TRAINING#{day}")
    )
    # Also pull today's health snapshot (best-effort: don't fail if missing)
    health: dict = {}
    try:
        h = table.get_item(Key={'PK': client_pk, 'SK': f"HEALTH#{day}"})
        health = h.get('Item') or {}
    except Exception:
        pass

    schedules = [i for i in query_all(
        KeyConditionExpression=Key('PK').eq(client_pk) & Key('SK').begins_with('SCHEDULE#')
    ) if i.get('status', 'ACTIVE') == 'ACTIVE']
    logs = {i['SK']: i for i in query_all(
        KeyConditionExpression=Key('PK').eq(client_pk) & Key('SK').begins_with('WORKOUTLOG#')
    )}
    workout = workout_summary(schedules, logs, day)

    today_training = [
        {
            "id": i['SK'],
            "title": i.get('title', ''),
            "subtitle": i.get('subtitle', ''),
            "statusText": i.get('statusText', 'pending'),
            "statusColor": i.get('statusColor', 'gold'),
        }
        for i in items
    ] + workout['today']

    # Last 7 days (ending on the athlete's own "today") for the weekly-rhythm bars
    days = date_window(day, 7)
    week_health = health_range(client_pk, days[0], day)
    by_date = {w['date']: w for w in workout['week']}
    weekly = []
    for d in days:
        w = by_date.get(d, {'planned': 0, 'done': 0})
        weekly.append({
            "date": d,
            "workoutPct": round(100 * w['done'] / w['planned']) if w['planned'] else None,
            "stepsPct": pct_of(week_health.get(d, {}).get('steps'), STEP_GOAL),
        })

    out = {
        "date": day,
        "todayTraining": today_training,
        "assignedSchedules": [_schedule_out(i) for i in schedules],
        "steps": health.get('steps'),
        "stepGoal": STEP_GOAL,
        "sleepHours": health.get('sleepHours'),
        "sleepGoal": SLEEP_GOAL,
        "calories": health.get('calories'),
        "hydration": health.get('hydration'),
        "hydrationGoal": HYDRATION_GOAL,
        "heartRate": health.get('heartRate'),
        "healthSource": health.get('source'),
        "healthUpdatedAt": health.get('updatedAt'),
        "workoutsThisWeek": workout['done'],
        "weekly": weekly,
    }
    if health.get('sleepHours') is not None:
        out["recovery"] = pct_of(health.get('sleepHours'), SLEEP_GOAL)      # readiness = how much of the sleep target was met
    if workout['completion'] is not None:
        out["workoutCompletion"] = workout['completion']
    return parse_decimals(out)


@app.post("/athlete/checkin")
def save_checkin(payload: CheckinPayload, user: dict = Depends(require_roles('CLIENT'))):
    client_pk = user['pk']                                  # always the signed-in athlete
    if payload.clientId and make_pk('CLIENT', payload.clientId) != client_pk:
        raise HTTPException(status_code=403, detail="You can only submit your own check-in.")

    check_range('Weight (kg)', payload.weight, 20, 500)
    check_range('Waist (cm)', payload.waist, 20, 300)
    if payload.adherence not in ADHERENCE_SCORES:
        raise HTTPException(status_code=400, detail="Invalid adherence value.")
    if payload.workoutQuality not in WORKOUT_QUALITIES:
        raise HTTPException(status_code=400, detail="Invalid workout quality value.")

    ts = now_iso()
    item = to_dynamo({
        "PK": client_pk,
        "SK": f"CHECKIN#{ts}",
        "type": "CHECKIN",
        "weight": payload.weight,
        "waist": payload.waist,
        "adherence": payload.adherence,
        "workoutQuality": payload.workoutQuality,
        "notes": clean_text(payload.notes, 2000) or None,
        "createdAt": ts,
    })
    table.put_item(Item=item)
    return {"message": "Check-in saved", "checkinId": item['SK']}




def validate_progress_angle(angle: str) -> str:
    clean = (clean_text(angle, 20) or '').lower()
    if clean not in PROGRESS_ANGLES:
        raise HTTPException(status_code=400, detail='Angle must be front, side or back.')
    return clean


def progress_key_prefix(client_pk: str, checkin_id: str, angle: str) -> str:
    stamp = re.sub(r'\D', '', checkin_id.split('#', 1)[-1])
    return f"clients/{short_id(client_pk)}/progress/{stamp}/{angle}-"


def own_checkin(client_pk: str, checkin_id: str) -> dict:
    if not checkin_id.startswith('CHECKIN#'):
        raise HTTPException(status_code=400, detail='Invalid check-in.')
    item = table.get_item(Key={'PK': client_pk, 'SK': checkin_id}).get('Item')
    if not item:
        raise HTTPException(status_code=404, detail='Check-in not found.')
    return item


@app.post("/athlete/checkin/photos/upload-url")
def create_progress_photo_upload(payload: ProgressPhotoUploadPayload, user: dict = Depends(require_roles('CLIENT'))):
    client_pk = user['pk']
    angle = validate_progress_angle(payload.angle)
    own_checkin(client_pk, payload.checkinId)
    if not CLIENT_MEDIA_BUCKET:
        raise HTTPException(status_code=503, detail='Photo storage is not configured.')
    if payload.contentType not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail='Unsupported image type.')
    prefix = progress_key_prefix(client_pk, payload.checkinId, angle)
    object_key = f"{prefix}{uuid.uuid4().hex}{ALLOWED_IMAGE_TYPES[payload.contentType]}"
    try:
        post = s3.generate_presigned_post(
            Bucket=CLIENT_MEDIA_BUCKET,
            Key=object_key,
            Fields={'Content-Type': payload.contentType},
            Conditions=[
                {'Content-Type': payload.contentType},
                ['content-length-range', 1, MAX_CLIENT_PHOTO_BYTES],
                ['starts-with', '$key', prefix],
            ],
            ExpiresIn=300,
        )
    except ClientError:
        raise HTTPException(status_code=503, detail='Unable to prepare photo upload.')
    return {'uploadUrl': post['url'], 'fields': post['fields'], 'objectKey': object_key, 'expiresIn': 300}


@app.post("/athlete/checkin/photos/complete")
def complete_progress_photo(payload: ProgressPhotoCompletePayload, user: dict = Depends(require_roles('CLIENT'))):
    client_pk = user['pk']
    angle = validate_progress_angle(payload.angle)
    own_checkin(client_pk, payload.checkinId)
    if not CLIENT_MEDIA_BUCKET:
        raise HTTPException(status_code=503, detail='Photo storage is not configured.')
    if not payload.objectKey.startswith(progress_key_prefix(client_pk, payload.checkinId, angle)):
        raise HTTPException(status_code=403, detail='You do not have access to this upload.')
    try:
        head = s3.head_object(Bucket=CLIENT_MEDIA_BUCKET, Key=payload.objectKey)
    except ClientError:
        raise HTTPException(status_code=400, detail='Uploaded photo could not be verified.')
    content_type = head.get('ContentType', '')
    size = int(head.get('ContentLength', 0))
    if content_type not in ALLOWED_IMAGE_TYPES or size <= 0 or size > MAX_CLIENT_PHOTO_BYTES:
        raise HTTPException(status_code=400, detail='Uploaded photo failed validation.')
    ts = now_iso()
    item = to_dynamo({
        'PK': client_pk,
        'SK': f"PROGRESSPHOTO#{payload.checkinId.split('#', 1)[1]}#{angle.upper()}",
        'type': 'PROGRESS_PHOTO',
        'checkinId': payload.checkinId,
        'angle': angle,
        'objectKey': payload.objectKey,
        'contentType': content_type,
        'size': size,
        'originalFileName': clean_text(payload.originalFileName, 180) or payload.objectKey.rsplit('/', 1)[-1],
        'uploadedAt': ts,
    })
    table.put_item(Item=item)
    return {'message': 'Photo saved', 'angle': angle, 'objectKey': payload.objectKey}


@app.get("/coach/{coachId}/clients/{clientId}/progress")
def get_client_progress(coachId: str, clientId: str, user: dict = Depends(require_roles('COACH', 'ADMIN'))):
    """Progress Review: real check-in history + progress photos for one assigned client."""
    coach_pk = make_pk('COACH', coachId)
    authorize_coach_scope(user, coach_pk)
    client_pk = make_pk('CLIENT', clientId)
    client = get_profile(client_pk)
    if not client or client.get('role') != 'CLIENT':
        raise HTTPException(status_code=404, detail='Client not found.')
    if user['role'] == 'COACH' and not is_coach_of(client, user['pk']):
        raise HTTPException(status_code=403, detail='You do not have access to this resource.')

    checkins = latest_checkins(client_pk, 12)                 # newest first
    photos = {}
    for p in query_all(KeyConditionExpression=Key('PK').eq(client_pk) & Key('SK').begins_with('PROGRESSPHOTO#')):
        photos.setdefault(p.get('checkinId', ''), []).append(
            {'angle': p.get('angle', ''), 'objectKey': p.get('objectKey', ''), 'uploadedAt': p.get('uploadedAt', '')})

    history = []
    for c in reversed(checkins):                              # oldest -> newest for charts
        history.append({
            'id': c['SK'],
            'date': c['SK'].split('#', 1)[1],
            'weight': c.get('weight'),
            'waist': c.get('waist'),
            'adherence': c.get('adherence'),
            'adherenceScore': adherence_score(c.get('adherence')),
            'workoutQuality': c.get('workoutQuality'),
            'notes': c.get('notes') or '',
            'photos': sorted(photos.get(c['SK'], []), key=lambda x: x['angle']),
        })
    weights = [h['weight'] for h in history if h['weight'] is not None]
    scores = [h['adherenceScore'] for h in history if h['adherenceScore'] is not None]

    # ---- daily activity: steps / sleep / water / calories / heart-rate, last 14 days ----
    today = utc_today()
    days = date_window(today, 14)
    window_end = (datetime.strptime(today, '%Y-%m-%d').date() + timedelta(days=1)).isoformat()
    snapshots = health_range(client_pk, days[0], window_end)
    health = [{'date': d, **health_view(snapshots.get(d)), 'source': snapshots.get(d, {}).get('source')}
              for d in sorted(set(days) | set(snapshots))][-14:]
    recent = health[-7:]

    def mean(key: str) -> Optional[float]:
        vals = [float(h[key]) for h in recent if h.get(key) is not None]
        return round(sum(vals) / len(vals), 1) if vals else None

    latest_day = max((h['date'] for h in health if h.get('steps') is not None), default=None)
    latest_snap = snapshots.get(latest_day, {}) if latest_day else {}
    avg_steps = mean('steps')

    schedules = [i for i in query_all(KeyConditionExpression=Key('PK').eq(client_pk) & Key('SK').begins_with('SCHEDULE#'))
                 if i.get('status', 'ACTIVE') == 'ACTIVE']
    logs = {i['SK']: i for i in query_all(KeyConditionExpression=Key('PK').eq(client_pk) & Key('SK').begins_with('WORKOUTLOG#'))}
    wk = workout_summary(schedules, logs, today)
    pres = profile_presence(client)

    return parse_decimals({
        'client': {'id': short_id(client_pk), 'name': client.get('name') or 'Unnamed Athlete',
                   'goal': client.get('primaryGoal') or client.get('goal') or 'Not set'},
        'profile': {
            'email': client.get('email', ''),
            'age': client.get('age'),
            'height': client.get('height'),
            'startWeight': client.get('weight'),
            'activityLevel': client.get('activityLevel'),
            'primaryGoal': client.get('primaryGoal') or client.get('goal'),
            'medicalNotes': client.get('medicalNotes') or '',
            'memberSince': client.get('createdAt'),
            'onboardingCompleted': bool(client.get('onboardingCompleted', False)),
            **pres,
        },
        'checkins': history,
        'health': health,
        'activity': {
            'stepsLatest': latest_snap.get('steps'),
            'stepsLatestDate': latest_day,
            'stepsAvg7d': round(avg_steps) if avg_steps is not None else None,
            'stepGoal': STEP_GOAL,
            'sleepAvg7d': mean('sleepHours'),
            'sleepGoal': SLEEP_GOAL,
            'hydrationAvg7d': mean('hydration'),
            'hydrationGoal': HYDRATION_GOAL,
            'caloriesAvg7d': round(mean('calories')) if mean('calories') is not None else None,
            'heartRateAvg7d': round(mean('heartRate')) if mean('heartRate') is not None else None,
            'daysWithData': sum(1 for h in recent if h.get('steps') is not None),
            'workoutsDone7d': wk['done'],
            'workoutsPlanned7d': wk['planned'],
            'workoutCompletion7d': wk['completion'],
            'lastSyncAt': latest_snap.get('updatedAt'),
            'source': latest_snap.get('source'),
        },
        'summary': {
            'weightChange': round(float(weights[-1]) - float(weights[0]), 1) if len(weights) > 1 else None,
            'averageAdherence': round(sum(scores) / len(scores), 1) if scores else None,
            'totalCheckins': len(history),
        },
    })


def store_health_snapshot(client_pk: str, payload: HealthMetricsPayload, source: str) -> str:
    """Validate and write one day's health snapshot. Shared by the signed-in app and by the
    token-based iPhone/Apple Health ingest. Returns the day that was written."""
    today = utc_today()
    day = today
    if payload.date:
        if not re.match(r'^\d{4}-\d{2}-\d{2}$', payload.date):
            raise HTTPException(status_code=400, detail="Invalid date.")
        try:
            gap = abs((datetime.strptime(payload.date, '%Y-%m-%d').date() - datetime.strptime(today, '%Y-%m-%d').date()).days)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date.")
        if gap > 1:          # the phone's "today" can differ from UTC by at most a day
            raise HTTPException(status_code=400, detail="Health data can only be saved for today.")
        day = payload.date

    check_range('Steps', payload.steps, 0, 200000)
    check_range('Sleep (hours)', payload.sleepHours, 0, 24)
    check_range('Calories', payload.calories, 0, 20000)
    check_range('Heart rate', payload.heartRate, 20, 250)
    check_range('Water (litres)', payload.hydration, 0, 15)

    update_map: Dict[str, Any] = {}
    if payload.steps is not None:
        update_map['steps'] = int(payload.steps)
    if payload.sleepHours is not None:
        update_map['sleepHours'] = Decimal(str(round(payload.sleepHours, 2)))
    if payload.calories is not None:
        update_map['calories'] = int(payload.calories)
    if payload.heartRate is not None:
        update_map['heartRate'] = int(payload.heartRate)
    if payload.hydration is not None:
        update_map['hydration'] = Decimal(str(round(payload.hydration, 2)))

    if not update_map:
        raise HTTPException(status_code=400, detail="No health metrics provided.")

    update_map['updatedAt'] = now_iso()
    update_map['type'] = 'HEALTH_SNAPSHOT'
    update_map['source'] = source

    set_parts = [f"#{k} = :{k}" for k in update_map]
    expr_names = {f"#{k}": k for k in update_map}
    expr_values = {f":{k}": to_dynamo(v) for k, v in update_map.items()}

    table.update_item(
        Key={'PK': client_pk, 'SK': f"HEALTH#{day}"},
        UpdateExpression="SET " + ", ".join(set_parts),
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
    )
    return day


@app.put("/athlete/health-metrics")
def save_health_metrics(payload: HealthMetricsPayload, user: dict = Depends(require_roles('CLIENT'))):
    """Store one day's steps / sleep / water / calories / heart-rate for the signed-in athlete.
    Values come either from the phone's health sensors or are typed in by the athlete.
    The coach sees the same numbers."""
    source = 'manual' if payload.source == 'manual' else 'device'
    day = store_health_snapshot(user['pk'], payload, source)
    return {"message": "Health metrics saved", "date": day}


# ---------------------------------------------------------------------------
# APPLE HEALTH (iPhone) SYNC
#
# Safari / home-screen web apps CANNOT read Apple Health: HealthKit exists only for native apps.
# The only no-install route is an iOS Shortcut that reads Health and POSTs it here. So that the
# athlete never has to log in inside a Shortcut (or paste a password / short-lived session token),
# each athlete gets a personal *sync key*:
#   - it can ONLY write that athlete's own daily health snapshot (nothing else, no reading),
#   - only its SHA-256 hash is stored, the key itself is shown once,
#   - it can be revoked / regenerated at any time from the app.
# Key format:  bfh.<athleteId>.<secret>   (the id lets us look the hash up by PK without a GSI)
# ---------------------------------------------------------------------------
HEALTH_SYNC_SK = 'HEALTHSYNC#KEY'
HEALTH_SYNC_PREFIX = 'bfh'


def _sync_hash(secret: str) -> str:
    return hashlib.sha256(secret.encode('utf-8')).hexdigest()


def _lenient_number(value: Any) -> Optional[float]:
    """Shortcuts often sends numbers as text ('8,421', '8421 count', '7.5 hr'). Take the first number."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    if isinstance(value, str):
        m = re.search(r'-?\d[\d,]*\.?\d*', value.strip())
        if not m:
            return None
        try:
            return float(m.group(0).replace(',', ''))
        except ValueError:
            return None
    return None


@app.post("/athlete/health-sync/key")
def create_health_sync_key(user: dict = Depends(require_roles('CLIENT'))):
    """Create (or replace) the athlete's personal Apple Health sync key. Shown once."""
    secret = secrets.token_urlsafe(32)
    token = f"{HEALTH_SYNC_PREFIX}.{short_id(user['pk'])}.{secret}"
    table.put_item(Item={
        'PK': user['pk'], 'SK': HEALTH_SYNC_SK, 'type': 'HEALTH_SYNC_KEY',
        'keyHash': _sync_hash(secret), 'createdAt': now_iso(),
    })
    return {"key": token, "createdAt": now_iso()}


@app.get("/athlete/health-sync/status")
def health_sync_status(user: dict = Depends(require_roles('CLIENT'))):
    item = table.get_item(Key={'PK': user['pk'], 'SK': HEALTH_SYNC_SK}).get('Item')
    if not item:
        return {"enabled": False}
    return {"enabled": True, "createdAt": item.get('createdAt'), "lastUsedAt": item.get('lastUsedAt')}


@app.delete("/athlete/health-sync/key")
def revoke_health_sync_key(user: dict = Depends(require_roles('CLIENT'))):
    table.delete_item(Key={'PK': user['pk'], 'SK': HEALTH_SYNC_SK})
    return {"message": "Apple Health sync key revoked."}


@app.post("/health-sync/ingest")
async def health_sync_ingest(request: Request, authorization: Optional[str] = Header(default=None)):
    """Called by the iPhone Shortcut. Auth is the athlete's sync key (Authorization: Bearer bfh.<id>.<secret>).
    Body (all optional, numbers may be text): steps, sleepHours | sleepMinutes, calories, heartRate, hydration, date."""
    rate_limit(request, 'sync', 120, 60)
    denied = HTTPException(status_code=401, detail="Invalid sync key. Open the app and create a new one.")
    if not authorization or not authorization.lower().startswith('bearer '):
        raise denied
    parts = authorization[7:].strip().split('.', 2)
    if len(parts) != 3 or parts[0] != HEALTH_SYNC_PREFIX or not parts[1] or not parts[2]:
        raise denied
    client_pk = make_pk('CLIENT', parts[1])
    item = table.get_item(Key={'PK': client_pk, 'SK': HEALTH_SYNC_SK}).get('Item')
    if not item or not hmac.compare_digest(str(item.get('keyHash', '')), _sync_hash(parts[2])):
        raise denied
    profile = get_profile(client_pk)
    if not profile or profile.get('status') == 'INACTIVE' or profile.get('role') != 'CLIENT':
        raise denied

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body must be JSON.")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object.")

    def num(*names):
        for n in names:
            v = _lenient_number(body.get(n))
            if v is not None:
                return v
        return None

    steps, calories, hr = num('steps'), num('calories', 'activeEnergy'), num('heartRate')
    sleep_h = num('sleepHours')
    if sleep_h is None:
        mins = num('sleepMinutes')
        sleep_h = mins / 60.0 if mins is not None else None
    water = num('hydration', 'waterLitres')
    date_val = body.get('date')
    payload = HealthMetricsPayload(
        steps=int(round(steps)) if steps is not None else None,
        sleepHours=round(sleep_h, 2) if sleep_h is not None else None,
        calories=int(round(calories)) if calories is not None else None,
        heartRate=int(round(hr)) if hr is not None else None,
        hydration=round(water, 2) if water is not None else None,
        date=str(date_val).strip()[:10] if isinstance(date_val, str) and date_val.strip() else None,
    )
    day = store_health_snapshot(client_pk, payload, 'apple-health')
    try:
        table.update_item(Key={'PK': client_pk, 'SK': HEALTH_SYNC_SK},
                          UpdateExpression="SET lastUsedAt = :t", ExpressionAttributeValues={':t': now_iso()})
    except Exception:
        logger.warning('could not record sync-key use for %s', client_pk)
    return {"message": "Synced", "date": day}


@app.get("/athlete/{athleteId}/health-metrics")
def get_health_metrics(athleteId: str, date: Optional[str] = None, user: dict = Depends(current_user)):
    """Return the stored health snapshot for a day (default: today).
    Athletes see only their own data; coaches see only their assigned clients."""
    client_pk = make_pk('CLIENT', athleteId)
    if user.get('role') == 'CLIENT':
        authorize_athlete_scope(user, client_pk)
    elif user.get('role') == 'COACH':
        if not is_coach_of(get_profile(client_pk), user['pk']):
            raise HTTPException(status_code=403, detail="Not your client.")
    else:
        raise HTTPException(status_code=403, detail="Forbidden.")

    day = date if date and re.match(r'^\d{4}-\d{2}-\d{2}$', date) else utc_today()
    try:
        snapshot = table.get_item(Key={'PK': client_pk, 'SK': f"HEALTH#{day}"}).get('Item') or {}
    except Exception:
        snapshot = {}
    return parse_decimals({
        "date": day,
        **health_view(snapshot),
        "updatedAt": snapshot.get('updatedAt'),
        "source": snapshot.get('source'),
    })


# ---------------------------------------------------------------------------
# TEMPLATE IMAGE VIEWER  (presigned URL for viewing reference image in iframe)
# ---------------------------------------------------------------------------

@app.get("/coach/templates/{templateId}/image-view")
def get_template_image_view(
    templateId: str,
    coachId: Optional[str] = None,
    user: dict = Depends(require_roles('COACH', 'ADMIN')),
):
    """Return a short-lived presigned URL for viewing the template reference image."""
    item = find_template(templateId, template_owner(user, coachId))
    if not item:
        raise HTTPException(status_code=404, detail='Template not found.')
    key = item.get('referenceImageKey', '')
    if key and not key.startswith(f"coaches/{short_id(item['PK'])}/"):
        key = ''   # legacy record pointing outside the coach's own folder: never sign it
    if not key or not CLIENT_MEDIA_BUCKET:
        raise HTTPException(status_code=404, detail='No reference image for this template.')
    try:
        url = s3.generate_presigned_url(
            'get_object',
            Params={'Bucket': CLIENT_MEDIA_BUCKET, 'Key': key},
            ExpiresIn=3600,
        )
    except ClientError:
        raise HTTPException(status_code=503, detail='Could not generate image URL.')
    return {'viewUrl': url, 'objectKey': key}


# ---------------------------------------------------------------------------
# ASSIGN TEMPLATE TO CLIENT  (creates a client schedule from a template)
# ---------------------------------------------------------------------------

@app.post("/coach/{coachId}/templates/{templateId}/assign")
def assign_template_to_client(
    coachId: str,
    templateId: str,
    payload: AssignTemplatePayload,
    user: dict = Depends(require_roles('COACH', 'ADMIN')),
):
    """Assign a template to a client – creates a CLIENT schedule record."""
    coach_pk = make_pk('COACH', coachId)
    authorize_coach_scope(user, coach_pk)

    template_item = find_template(templateId, coach_pk)
    if not template_item:
        raise HTTPException(status_code=404, detail='Template not found.')

    # Verify the client belongs to this coach
    client_pk = make_pk('CLIENT', payload.clientId)
    client_profile = get_profile(client_pk)
    if not client_profile or client_profile.get('role') != 'CLIENT':
        raise HTTPException(status_code=404, detail='Client not found.')
    if not is_coach_of(client_profile, coach_pk):
        raise HTTPException(status_code=403, detail='This client is not assigned to you.')

    start_date = payload.startDate or now_iso()[:10]
    assignment_id = f'asgn_{uuid.uuid4().hex[:8]}'
    now = now_iso()

    # Snapshot the template exercises into the assignment
    schedule_item = to_dynamo({
        'PK': client_pk,
        'SK': f'SCHEDULE#{assignment_id}',
        'type': 'CLIENT_SCHEDULE',
        'assignmentId': assignment_id,
        'templateId': templateId,
        'templateTitle': template_item.get('title', ''),
        'coachId': coach_pk,
        'startDate': start_date,
        'notes': clean_text(payload.notes, 500) or '',
        'exercises': template_item.get('exercises', []),
        'workoutDays': template_item.get('workoutDays', ''),
        'goal': template_item.get('goal', ''),
        'level': template_item.get('level', ''),
        'estimatedDuration': template_item.get('estimatedDuration', ''),
        'equipment': template_item.get('equipment', ''),
        'referenceImageKey': template_item.get('referenceImageKey', ''),
        'status': 'ACTIVE',
        'createdAt': now,
        'updatedAt': now,
    })
    table.put_item(Item=schedule_item)

    return {
        'message': 'Template assigned successfully.',
        'assignmentId': assignment_id,
        'clientId': payload.clientId,
        'startDate': start_date,
    }


@app.get("/coach/{coachId}/clients/{clientId}/schedules")
def get_client_schedules(
    coachId: str,
    clientId: str,
    user: dict = Depends(require_roles('COACH', 'ADMIN')),
):
    """Coach: list all schedules assigned to a specific client."""
    coach_pk = make_pk('COACH', coachId)
    authorize_coach_scope(user, coach_pk)

    client_pk = make_pk('CLIENT', clientId)
    client_profile = get_profile(client_pk)
    if not client_profile or client_profile.get('role') != 'CLIENT':
        raise HTTPException(status_code=404, detail='Client not found.')
    if not is_coach_of(client_profile, coach_pk):
        raise HTTPException(status_code=403, detail='This client is not assigned to you.')

    items = query_all(
        KeyConditionExpression=Key('PK').eq(client_pk) & Key('SK').begins_with('SCHEDULE#')
    )
    return {'schedules': [_schedule_out(i) for i in items]}


def _schedule_out(item: dict) -> dict:
    """Serialize a CLIENT_SCHEDULE DynamoDB item for API responses."""
    out = parse_decimals({
        'assignmentId': item.get('assignmentId', ''),
        'templateId': item.get('templateId', ''),
        'templateTitle': item.get('templateTitle', ''),
        'startDate': item.get('startDate', ''),
        'notes': item.get('notes', ''),
        'exercises': item.get('exercises', []),
        'workoutDays': item.get('workoutDays', ''),
        'goal': item.get('goal', ''),
        'level': item.get('level', ''),
        'estimatedDuration': item.get('estimatedDuration', ''),
        'equipment': item.get('equipment', ''),
        'referenceImageKey': item.get('referenceImageKey', ''),
        'status': item.get('status', 'ACTIVE'),
        'createdAt': item.get('createdAt', ''),
    })
    if out.get('referenceImageKey') and CLIENT_MEDIA_BUCKET:
        try:
            out['referenceImageUrl'] = s3.generate_presigned_url(
                'get_object',
                Params={'Bucket': CLIENT_MEDIA_BUCKET, 'Key': out['referenceImageKey']},
                ExpiresIn=3600,
            )
        except Exception:
            out['referenceImageUrl'] = None
    else:
        out['referenceImageUrl'] = None
    return out


@app.get("/athlete/{athleteId}/schedules")
def get_athlete_schedules(
    athleteId: str,
    user: dict = Depends(require_roles('CLIENT')),
):
    """Client: list their own active schedules."""
    client_pk = user['pk']
    authorize_athlete_scope(user, client_pk)

    items = query_all(
        KeyConditionExpression=Key('PK').eq(client_pk) & Key('SK').begins_with('SCHEDULE#')
    )
    active = [i for i in items if i.get('status', 'ACTIVE') == 'ACTIVE']
    return {'schedules': [_schedule_out(i) for i in active]}


@app.get("/athlete/{athleteId}/schedules/{assignmentId}")
def get_athlete_schedule_detail(
    athleteId: str,
    assignmentId: str,
    user: dict = Depends(require_roles('CLIENT')),
):
    """Client: get full detail of one schedule."""
    client_pk = user['pk']
    authorize_athlete_scope(user, client_pk)

    result = table.get_item(Key={'PK': client_pk, 'SK': f'SCHEDULE#{assignmentId}'})
    item = result.get('Item')
    if not item:
        raise HTTPException(status_code=404, detail='Schedule not found.')
    return _schedule_out(item)


# ---------------------------------------------------------------------------
# S3 IMAGE VIEWER  (presigned URL for any S3 image the coach/client owns)
# ---------------------------------------------------------------------------

@app.get("/media/view")
def get_media_view_url(
    objectKey: str,
    user: dict = Depends(require_roles('CLIENT', 'COACH', 'ADMIN')),
):
    """Return a presigned view URL for a media object the caller is authorised to see."""
    if not CLIENT_MEDIA_BUCKET:
        raise HTTPException(status_code=503, detail='Media storage is not configured.')

    # Authorisation: the object key must be scoped to the caller's own ID
    pk = user['pk']
    caller_short = short_id(pk)
    role = user.get('role', '')

    allowed_prefixes = []
    if role == 'CLIENT':
        allowed_prefixes = [f'clients/{caller_short}/']
    elif role == 'COACH':
        allowed_prefixes = [f'coaches/{caller_short}/']
        parts = unquote(objectKey).split('/')
        if len(parts) > 2 and parts[0] == 'clients':
            # a coach may open photos that belong to a client assigned to them
            if is_coach_of(get_profile(make_pk('CLIENT', parts[1])), pk):
                allowed_prefixes.append(f'clients/{parts[1]}/')
    elif role == 'ADMIN':
        allowed_prefixes = ['clients/', 'coaches/']  # admins can view any media

    decoded_key = unquote(objectKey)
    if '..' in decoded_key.split('/') or not any(decoded_key.startswith(p) for p in allowed_prefixes):
        raise HTTPException(status_code=403, detail='Access denied to this media object.')

    try:
        url = s3.generate_presigned_url(
            'get_object',
            Params={'Bucket': CLIENT_MEDIA_BUCKET, 'Key': decoded_key},
            ExpiresIn=3600,
        )
    except ClientError:
        raise HTTPException(status_code=503, detail='Could not generate view URL.')

    return {'viewUrl': url, 'objectKey': decoded_key}


# ---------------------------------------------------------------------------
# ADMIN STORAGE CLEANUP
# Re-compresses old photos to WebP to save S3 space. Scope: 3-day meal log photos and coach template
# reference images (weekly progress photos are never touched). Safety rules:
#   * the browser never sends keys: the server finds the candidates itself from the database,
#   * each photo is converted, written, verified, the database re-pointed, and only then is the original deleted,
#   * any failure leaves the original in place and flags the item so it is not retried endlessly,
#   * work is done in small time-boxed batches (Lambda/API Gateway time limits); the admin screen repeats the call.
# ---------------------------------------------------------------------------

CLEANUP_MIN_DAYS = 7
CLEANUP_DEFAULT_DAYS = 15
CLEANUP_BATCH_SECONDS = 8.0          # Lambda timeout is 15 s, API Gateway 30 s
CLEANUP_MAX_SOURCE_BYTES = 25 * 1024 * 1024
WEBP_QUALITY = 82
WEBP_MAX_EDGE = 2000                 # long edge in px; plenty for review and before/after comparison
CLEANUP_CATEGORIES = ('mealPhotos', 'templateImages')


def cleanup_now() -> datetime:
    return datetime.now(timezone.utc)


def convert_to_webp(data: bytes) -> bytes:
    """Decode (JPEG / PNG / WebP / HEIC), honour phone rotation, cap the size, encode WebP."""
    import io
    from PIL import Image, ImageOps
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
    except Exception:
        pass
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)
    if max(img.size) > WEBP_MAX_EDGE:
        img.thumbnail((WEBP_MAX_EDGE, WEBP_MAX_EDGE), Image.LANCZOS)
    if img.mode not in ('RGB', 'RGBA'):
        img = img.convert('RGBA' if 'transparency' in img.info else 'RGB')
    out = io.BytesIO()
    img.save(out, 'WEBP', quality=WEBP_QUALITY, method=4)
    return out.getvalue()


def _webp_key(key: str) -> str:
    base, dot, ext = key.rpartition('.')
    return (base if dot and '/' not in ext else key) + '.webp'


def _parse_dt(value: Any) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _clean_cleanup_args(days: Any, categories: Any):
    try:
        days = int(days)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail='Days must be a whole number.')
    if days < CLEANUP_MIN_DAYS or days > 3650:
        raise HTTPException(status_code=400, detail=f'Days must be between {CLEANUP_MIN_DAYS} and 3650.')
    cats = [c for c in (categories or []) if c in CLEANUP_CATEGORIES]
    if not cats:
        raise HTTPException(status_code=400, detail='Choose at least one category.')
    return days, list(dict.fromkeys(cats))


def _cleanup_candidates(days: int, categories: List[str], retry_failed: bool = False) -> dict:
    """Everything old enough that is not already WebP. Returns lists plus how many are parked after a failure."""
    cutoff = cleanup_now() - timedelta(days=days)
    out = {'mealPhotos': [], 'templateImages': [], 'parkedFailed': 0, 'cutoff': cutoff.isoformat()}

    def parked(item):
        if item.get('cleanupError') and not retry_failed:
            out['parkedFailed'] += 1
            return True
        return bool(item.get('cleanupCheckedAt'))  # already looked at: converted, or no saving possible

    if 'mealPhotos' in categories:
        for it in scan_all(FilterExpression=Attr('SK').begins_with('3DAYPHOTO#')):
            key = str(it.get('objectKey') or '')
            when = _parse_dt(it.get('uploadedAt') or it.get('createdAt'))
            if not key or key.lower().endswith('.webp') or not when or when > cutoff or parked(it):
                continue
            out['mealPhotos'].append({'kind': 'mealPhotos', 'pk': it['PK'], 'sk': it['SK'], 'key': key, 'field': 'objectKey', 'size': int(it.get('size') or 0)})

    if 'templateImages' in categories:
        tpls = [t for t in scan_all(FilterExpression=Attr('type').eq('TEMPLATE')) if t.get('referenceImageKey')]
        todo = [t for t in tpls if not str(t['referenceImageKey']).lower().endswith('.webp') and not parked(t)]

        def head(t):
            try:
                h = s3.head_object(Bucket=CLIENT_MEDIA_BUCKET, Key=t['referenceImageKey'])
                return t, h
            except ClientError:
                return t, None
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=8) as pool:
            for t, h in pool.map(head, todo):
                if not h or h['LastModified'] > cutoff:
                    continue
                out['templateImages'].append({'kind': 'templateImages', 'pk': t['PK'], 'sk': t['SK'], 'key': t['referenceImageKey'], 'field': 'referenceImageKey', 'size': int(h.get('ContentLength') or 0)})
    return out


def _convert_one(c: dict) -> dict:
    """Convert a single photo. Returns {'status': 'converted'|'nogain'|'failed', ...}. Never raises."""
    key, ts = c['key'], now_iso()
    new_key = _webp_key(key)
    try:
        head = s3.head_object(Bucket=CLIENT_MEDIA_BUCKET, Key=key)
        before = int(head.get('ContentLength') or 0)
        if before <= 0 or before > CLEANUP_MAX_SOURCE_BYTES:
            raise ValueError('file size is outside the allowed range')
        data = s3.get_object(Bucket=CLIENT_MEDIA_BUCKET, Key=key)['Body'].read()
        webp = convert_to_webp(data)
    except Exception as e:  # unreadable / unsupported file: flag it, keep the original
        reason = 'Original is missing' if isinstance(e, ClientError) and error_code(e) in ('404', 'NoSuchKey', 'NotFound') else f'Could not convert ({type(e).__name__})'
        table.update_item(Key={'PK': c['pk'], 'SK': c['sk']}, UpdateExpression='SET cleanupError = :e, cleanupErrorAt = :t', ExpressionAttributeValues={':e': reason, ':t': ts})
        return {'status': 'failed', 'key': key, 'reason': reason}

    after = len(webp)
    if after >= before:  # re-encoding would not help: keep as-is, mark so it is not offered again
        table.update_item(Key={'PK': c['pk'], 'SK': c['sk']}, UpdateExpression='SET cleanupCheckedAt = :t, cleanupNote = :n', ExpressionAttributeValues={':t': ts, ':n': 'No saving possible'})
        return {'status': 'nogain', 'key': key, 'before': before, 'after': before}

    try:
        s3.put_object(Bucket=CLIENT_MEDIA_BUCKET, Key=new_key, Body=webp, ContentType='image/webp', Metadata={'converted-from': key.rsplit('/', 1)[-1][:200]})
        check = s3.head_object(Bucket=CLIENT_MEDIA_BUCKET, Key=new_key)
        if int(check.get('ContentLength') or 0) != after:
            raise ValueError('stored size does not match')
        field = c['field']
        names = {'#f': field}
        vals = {':n': new_key, ':o': key, ':t': ts, ':b': before}
        if c['kind'] == 'mealPhotos':
            expr = 'SET #f = :n, contentType = :ct, #sz = :a, originalObjectKey = :o, originalSize = :b, cleanupCheckedAt = :t, convertedAt = :t REMOVE cleanupError'
            names['#sz'] = 'size'; vals[':ct'] = 'image/webp'; vals[':a'] = after
        else:
            expr = 'SET #f = :n, originalObjectKey = :o, originalSize = :b, cleanupCheckedAt = :t, convertedAt = :t REMOVE cleanupError'
        table.update_item(Key={'PK': c['pk'], 'SK': c['sk']}, UpdateExpression=expr, ExpressionAttributeNames=names,
                          ExpressionAttributeValues=vals, ConditionExpression='#f = :o')
        if c['kind'] == 'templateImages':  # plans already assigned to clients keep their own copy of the key
            for dup in scan_all(FilterExpression=Attr('referenceImageKey').eq(key)):
                table.update_item(Key={'PK': dup['PK'], 'SK': dup['SK']}, UpdateExpression='SET referenceImageKey = :n',
                                  ExpressionAttributeValues={':n': new_key})
    except Exception as e:
        # roll the new file back; the original and the database record are untouched (or still point at the original)
        try:
            s3.delete_object(Bucket=CLIENT_MEDIA_BUCKET, Key=new_key)
        except ClientError:
            pass
        changed = isinstance(e, ClientError) and error_code(e) == 'ConditionalCheckFailedException'
        reason = 'Changed while converting; skipped' if changed else f'Could not save ({type(e).__name__})'
        if not changed:
            table.update_item(Key={'PK': c['pk'], 'SK': c['sk']}, UpdateExpression='SET cleanupError = :e, cleanupErrorAt = :t', ExpressionAttributeValues={':e': reason, ':t': ts})
        return {'status': 'failed', 'key': key, 'reason': reason}

    warning = None
    try:  # only now is the original removed
        s3.delete_object(Bucket=CLIENT_MEDIA_BUCKET, Key=key)
    except ClientError:
        warning = 'Converted, but the original could not be deleted'
    return {'status': 'converted', 'key': key, 'newKey': new_key, 'before': before, 'after': after, 'warning': warning}


class CleanupRunPayload(BaseModel):
    days: int = CLEANUP_DEFAULT_DAYS
    categories: List[str] = list(CLEANUP_CATEGORIES)
    runId: Optional[str] = None
    retryFailed: bool = False


@app.get("/admin/cleanup/preview")
def cleanup_preview(days: int = CLEANUP_DEFAULT_DAYS, categories: str = ','.join(CLEANUP_CATEGORIES), retryFailed: bool = False,
                    user: dict = Depends(require_roles('ADMIN'))):
    """Dry run: what a cleanup would touch. Changes nothing."""
    if not CLIENT_MEDIA_BUCKET:
        raise HTTPException(status_code=503, detail='Photo storage is not configured.')
    days, cats = _clean_cleanup_args(days, categories.split(','))
    found = _cleanup_candidates(days, cats, retryFailed)
    summary = {}
    for cat in cats:
        rows = found[cat]
        summary[cat] = {'count': len(rows), 'bytes': sum(r['size'] for r in rows)}
    total_bytes = sum(v['bytes'] for v in summary.values())
    return {
        'days': days, 'cutoff': found['cutoff'], 'categories': summary,
        'total': {'count': sum(v['count'] for v in summary.values()), 'bytes': total_bytes,
                  'estimatedSavedBytes': int(total_bytes * 0.6)},  # typical JPEG -> WebP saving; real figures come after the run
        'parkedFailed': found['parkedFailed'],
    }


@app.post("/admin/cleanup/run")
def cleanup_run(payload: CleanupRunPayload, user: dict = Depends(require_roles('ADMIN'))):
    """Convert one time-boxed batch. The admin screen calls this repeatedly until `remaining` is 0."""
    if not CLIENT_MEDIA_BUCKET:
        raise HTTPException(status_code=503, detail='Photo storage is not configured.')
    days, cats = _clean_cleanup_args(payload.days, payload.categories)
    run_id = re.sub(r'[^a-zA-Z0-9-]', '', payload.runId or '')[:40] or uuid.uuid4().hex[:12]
    started = time.monotonic()
    found = _cleanup_candidates(days, cats, payload.retryFailed)
    queue = [c for cat in cats for c in found[cat]]

    stats = {'converted': 0, 'nogain': 0, 'failed': 0, 'bytesBefore': 0, 'bytesAfter': 0}
    errors: List[dict] = []
    handled = 0
    for c in queue:
        if time.monotonic() - started > CLEANUP_BATCH_SECONDS:
            break
        r = _convert_one(c)
        handled += 1
        if r['status'] == 'converted':
            stats['converted'] += 1; stats['bytesBefore'] += r['before']; stats['bytesAfter'] += r['after']
            if r.get('warning'):
                errors.append({'file': r['key'].rsplit('/', 1)[-1], 'reason': r['warning']})
        elif r['status'] == 'nogain':
            stats['nogain'] += 1
        else:
            stats['failed'] += 1; errors.append({'file': r['key'].rsplit('/', 1)[-1], 'reason': r['reason']})

    remaining = max(0, len(queue) - handled)
    ts = now_iso()
    try:
        table.update_item(
            Key={'PK': 'SYSTEM#CLEANUP', 'SK': f'RUN#{run_id}'},
            UpdateExpression='SET #st = if_not_exists(#st, :t), #up = :t, #d = :d, #c = :c, #ad = :a, #rm = :r ADD #cv :cv, #fl :fl, #ng :ng, #bb :bb, #ba :ba',
            ExpressionAttributeNames={'#st': 'startedAt', '#up': 'updatedAt', '#d': 'days', '#c': 'cats', '#ad': 'adminCode', '#rm': 'remaining',
                                      '#cv': 'converted', '#fl': 'failed', '#ng': 'nogain', '#bb': 'bytesBefore', '#ba': 'bytesAfter'},
            ExpressionAttributeValues={':t': ts, ':d': days, ':c': ','.join(cats), ':a': user.get('userCode') or short_id(user['pk']), ':r': remaining,
                                       ':cv': stats['converted'], ':fl': stats['failed'], ':ng': stats['nogain'], ':bb': stats['bytesBefore'], ':ba': stats['bytesAfter']},
        )
    except ClientError:
        logger.exception('cleanup history write failed')
    return {'runId': run_id, **stats, 'handled': handled, 'remaining': remaining, 'done': remaining == 0, 'errors': errors[:25]}


@app.get("/admin/cleanup/history")
def cleanup_history(user: dict = Depends(require_roles('ADMIN'))):
    rows = query_all(KeyConditionExpression=Key('PK').eq('SYSTEM#CLEANUP') & Key('SK').begins_with('RUN#'))
    rows.sort(key=lambda r: str(r.get('startedAt', '')), reverse=True)
    keep = ('startedAt', 'updatedAt', 'days', 'cats', 'adminCode', 'converted', 'failed', 'nogain', 'bytesBefore', 'bytesAfter', 'remaining')
    return {'runs': [parse_decimals({'runId': r['SK'].split('#', 1)[1], **{k: r.get(k) for k in keep}}) for r in rows[:15]]}


# ---------------------------------------------------------------------------
# APPEARANCE POLICY (admin decides which of the five themes clients and coaches may use)
# Stored as one item. The app reads its own role's slice and clamps the person's saved theme to it.
# Keep APPEARANCE_THEME_IDS in step with THEMES in src/lib/look.ts.
# ---------------------------------------------------------------------------

APPEARANCE_THEME_IDS = ('noir', 'volt', 'forest', 'iron', 'carbon')
APPEARANCE_ROLES = ('CLIENT', 'COACH')
APPEARANCE_KEY = {'PK': 'SYSTEM#SETTINGS', 'SK': 'APPEARANCE'}
# Styles from before the five-theme update, and the theme each one became. Used only to migrate
# settings an admin saved under the old screen, so their intent survives the change.
LEGACY_STYLE_THEMES = {
    'original': 'noir', 'glass': 'noir', 'vintage': 'iron', 'oldgym': 'iron',
    'moderngym': 'volt', 'navy': 'carbon', 'forest': 'forest', 'coral': 'volt', 'liquidcarbon': 'carbon',
}


def default_role_appearance() -> dict:
    return {'allowCustomize': True, 'themes': list(APPEARANCE_THEME_IDS), 'defaultTheme': 'noir', 'resetCounter': 0}


def _pick_theme_ids(raw: Any, label: str) -> List[str]:
    if not isinstance(raw, list):
        raise HTTPException(status_code=400, detail=f'{label}: expected a list.')
    bad = [x for x in raw if x not in APPEARANCE_THEME_IDS]
    if bad:
        raise HTTPException(status_code=400, detail=f'{label}: unknown option "{str(bad[0])[:30]}".')
    ids = [x for x in APPEARANCE_THEME_IDS if x in raw]  # keeps canonical order, drops duplicates
    if not ids:
        raise HTTPException(status_code=400, detail=f'{label}: allow at least one theme.')
    return ids


def normalize_role_appearance(raw: Any, previous: dict, label: str) -> dict:
    if not isinstance(raw, dict):
        raise HTTPException(status_code=400, detail=f'{label}: invalid settings.')
    themes = _pick_theme_ids(raw.get('themes'), f'{label} themes')
    default_theme = raw.get('defaultTheme')
    if default_theme not in themes:
        raise HTTPException(status_code=400, detail=f'{label}: the default theme must be one of the allowed themes.')
    return {
        'allowCustomize': bool(raw.get('allowCustomize', True)),
        'themes': themes,
        'defaultTheme': default_theme,
        'resetCounter': int(previous.get('resetCounter', 0)) + (1 if raw.get('resetNow') else 0),
    }


def migrate_role_appearance(stored: dict) -> dict:
    """Settings saved before the five-theme update held style / palette / scene lists. Keep the admin's
    intent: the themes those styles map onto stay allowed, and the old default style picks the default."""
    old_defaults = stored.get('defaults') or {}
    themes = []
    for style in stored.get('styles') or []:
        theme = LEGACY_STYLE_THEMES.get(style)
        if theme and theme not in themes:
            themes.append(theme)
    themes = [t for t in APPEARANCE_THEME_IDS if t in themes] or list(APPEARANCE_THEME_IDS)
    wanted = LEGACY_STYLE_THEMES.get(old_defaults.get('style'))
    return {
        'allowCustomize': bool(stored.get('allowCustomize', True)),
        'themes': themes,
        'defaultTheme': wanted if wanted in themes else themes[0],
        'resetCounter': int(stored.get('resetCounter', 0) or 0),
    }


def load_appearance_policy() -> dict:
    item = table.get_item(Key=APPEARANCE_KEY).get('Item') or {}
    roles = {}
    for role in APPEARANCE_ROLES:
        stored = (item.get('roles') or {}).get(role)
        # 'themes' alone is ambiguous: the old screen also had a dark/light "themes" list.
        base = stored if isinstance(stored, dict) and 'defaultTheme' in stored else \
            (migrate_role_appearance(stored) if isinstance(stored, dict) else default_role_appearance())
        merged = {**default_role_appearance(), **base}
        merged['themes'] = [t for t in APPEARANCE_THEME_IDS if t in merged['themes']] or list(APPEARANCE_THEME_IDS)
        if merged['defaultTheme'] not in merged['themes']:
            merged['defaultTheme'] = merged['themes'][0]
        roles[role] = parse_decimals(merged)
    return {'roles': roles, 'updatedAt': item.get('updatedAt'), 'updatedBy': item.get('updatedBy')}


class AppearancePolicyPayload(BaseModel):
    roles: Dict[str, Dict[str, Any]]


@app.get("/settings/appearance")
def get_my_appearance_policy(user: dict = Depends(require_roles('CLIENT', 'COACH', 'ADMIN'))):
    """The caller's own slice. Admins are never restricted (policy is None)."""
    role = user.get('role')
    pol = load_appearance_policy()
    return {'role': role, 'policy': pol['roles'].get(role), 'updatedAt': pol['updatedAt']}


@app.get("/admin/settings/appearance")
def admin_get_appearance_policy(user: dict = Depends(require_roles('ADMIN'))):
    return load_appearance_policy()


@app.put("/admin/settings/appearance")
def admin_save_appearance_policy(payload: AppearancePolicyPayload, user: dict = Depends(require_roles('ADMIN'))):
    current = load_appearance_policy()['roles']
    unknown = [r for r in payload.roles if r not in APPEARANCE_ROLES]
    if unknown:
        raise HTTPException(status_code=400, detail='Unknown role.')
    roles = {}
    for role in APPEARANCE_ROLES:
        label = 'Clients' if role == 'CLIENT' else 'Coaches'
        if role in payload.roles:
            roles[role] = normalize_role_appearance(payload.roles[role], current[role], label)
        else:
            roles[role] = current[role]
    ts = now_iso()
    table.put_item(Item=to_dynamo({**APPEARANCE_KEY, 'type': 'SETTINGS', 'roles': roles, 'updatedAt': ts,
                                   'updatedBy': user.get('userCode') or short_id(user['pk'])}))
    return load_appearance_policy()


# Wrap the FastAPI app with Mangum to bridge it to AWS Lambda
handler = Mangum(app)
