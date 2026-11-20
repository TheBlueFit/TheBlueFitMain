"""Admin two-factor (TOTP): setup, the login gate, backup codes and turning it off.
Run: python3 test_mfa.py"""
import time
from harness import main as M, TABLE, HTTPException

ok = bad = 0
def check(label, cond):
    global ok, bad
    print(("  PASS  " if cond else "  FAIL  ") + label); ok += bool(cond); bad += (not cond)
def status_of(fn, *a, **k):
    try: fn(*a, **k)
    except HTTPException as e: return e.status_code
    return 200
def code_for(secret, offset=0):
    return M.totp_code(secret, int(time.time() // M.MFA_STEP_SECONDS) + offset)

ADMIN = "ADMIN#MF1"
TABLE.put_item({"PK": ADMIN, "SK": M.PROFILE_SK, "role": "ADMIN", "name": "Boss", "userCode": "MF1",
                "email": "boss@example.com", "status": "ACTIVE", "failedAttempts": 0, "lockedUntil": 0,
                "passwordHash": M.hash_password("AdminPass123"), "pwdChangedAt": int(time.time()) - 5})
CLIENT = "CLIENT#MF2"
TABLE.put_item({"PK": CLIENT, "SK": M.PROFILE_SK, "role": "CLIENT", "name": "Athlete", "userCode": "MF2",
                "status": "ACTIVE", "pwdChangedAt": int(time.time()) - 5})
admin = {"pk": ADMIN, "role": "ADMIN", "userCode": "MF1"}

def do_login(code=None):
    return M.login(M.LoginPayload(identifier="MF1", password="AdminPass123", role="ADMIN", code=code))

print("== before two-factor ==")
check("admin signs in with just a password", bool(do_login().get("token")))
check("status starts switched off", M.admin_security(admin) == {"mfaEnabled": False, "mfaPending": False, "recoveryCodesRemaining": 0})
check("a client cannot read admin security", status_of(M.require_roles("ADMIN"), {"pk": CLIENT, "role": "CLIENT"}) == 403)

print("== setup ==")
started = M.admin_mfa_start(admin)
secret = started["secret"]
check("setup returns a 32-character base32 key", len(secret) == 32 and secret.upper() == secret)
check("setup returns an otpauth URI for the admin", started["otpauthUrl"].startswith("otpauth://totp/") and secret in started["otpauthUrl"])
check("a wrong code does not switch it on", status_of(M.admin_mfa_enable, M.MfaCodePayload(code="000000"), admin) == 400)
check("still off after a wrong code", M.admin_security(admin)["mfaEnabled"] is False)
enabled = M.admin_mfa_enable(M.MfaCodePayload(code=code_for(secret)), admin)
check("a working code switches it on", enabled["mfaEnabled"] is True)
check("eight backup codes are handed out once", len(enabled["recoveryCodes"]) == 8)
check("status shows it on with 8 backup codes", M.admin_security(admin)["recoveryCodesRemaining"] == 8)
check("the secret is never returned by the status endpoint", "mfaSecret" not in M.admin_security(admin))
check("setting up twice is refused", status_of(M.admin_mfa_start, admin) == 409)
check("backup codes are stored only as hashes", all(len(h) == 64 and h == h.lower() for h in TABLE.d[(ADMIN, M.PROFILE_SK)]["mfaRecoveryHashes"]))

print("== login gate ==")
try:
    do_login()
    check("password alone is refused", False)
except HTTPException as e:
    check("password alone is refused", e.status_code == 401 and e.detail == "MFA_REQUIRED")
check("a wrong code is refused", status_of(do_login, "123456") == 401)
token = do_login(code_for(secret))["token"]
check("the right code gives a working session", M.current_user(authorization=f"Bearer {token}")["pk"] == ADMIN)
check("a drifted clock is still accepted", status_of(do_login, code_for(secret, -1)) == 200)

print("== backup codes ==")
backup = enabled["recoveryCodes"][0]
check("a backup code signs in", bool(do_login(backup).get("token")))
check("the same backup code cannot be reused", status_of(do_login, backup) == 401)
check("seven codes left after using one", M.admin_security(admin)["recoveryCodesRemaining"] == 7)
check("garbage is not treated as a backup code", status_of(do_login, "not-a-code") == 401)

print("== turning it off ==")
check("it cannot be switched off with the wrong password", status_of(M.admin_mfa_disable, M.MfaDisablePayload(password="nope", code=code_for(secret)), admin) == 401)
check("it needs a valid code as well", status_of(M.admin_mfa_disable, M.MfaDisablePayload(password="AdminPass123", code="000000"), admin) == 400)
check("password plus code switches it off", M.admin_mfa_disable(M.MfaDisablePayload(password="AdminPass123", code=code_for(secret)), admin)["mfaEnabled"] is False)
check("the secret and backup codes are cleared", not TABLE.d[(ADMIN, M.PROFILE_SK)].get("mfaSecret") and not TABLE.d[(ADMIN, M.PROFILE_SK)]["mfaRecoveryHashes"])
check("password-only login works again", bool(do_login().get("token")))

print(f"\n{ok} passed, {bad} failed")
raise SystemExit(1 if bad else 0)
