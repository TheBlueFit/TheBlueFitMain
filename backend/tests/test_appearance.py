"""Appearance policy: five themes only (plus migration from the old style/palette screen).
Run: python3 test_appearance.py"""
import copy, time
from harness import main as M, TABLE, HTTPException

ok = bad = 0
def check(label, cond):
    global ok, bad
    print(("  PASS  " if cond else "  FAIL  ") + label); ok += bool(cond); bad += (not cond)
def status_of(fn, *a, **k):
    try: fn(*a, **k)
    except HTTPException as e: return e.status_code
    return 200

TABLE.put_item({"PK": "ADMIN#AP1", "SK": M.PROFILE_SK, "role": "ADMIN", "name": "A", "userCode": "AP1", "status": "ACTIVE", "pwdChangedAt": int(time.time()) - 5})
TABLE.put_item({"PK": "CLIENT#AC1", "SK": M.PROFILE_SK, "role": "CLIENT", "name": "C", "status": "ACTIVE", "pwdChangedAt": int(time.time()) - 5})
admin = {"pk": "ADMIN#AP1", "role": "ADMIN", "userCode": "AP1"}
client = {"pk": "CLIENT#AC1", "role": "CLIENT"}

print("== defaults ==")
pol = M.get_my_appearance_policy(client)["policy"]
check("all five themes offered by default", pol["themes"] == ["noir", "volt", "forest", "iron", "carbon"])
check("Cinematic Noir is the default theme", pol["defaultTheme"] == "noir")
check("people may choose their theme by default", pol["allowCustomize"] is True)
check("no style / palette / scene options remain", set(pol) == {"allowCustomize", "themes", "defaultTheme", "resetCounter"})

print("== admin saves ==")
full = M.admin_get_appearance_policy(admin)
roles = copy.deepcopy(full["roles"])
roles["CLIENT"].update({"themes": ["volt", "forest", "noir"], "defaultTheme": "volt"})
saved = M.admin_save_appearance_policy(M.AppearancePolicyPayload(roles=roles), admin)
check("client themes saved", saved["roles"]["CLIENT"]["themes"] == ["noir", "volt", "forest"])
check("client default saved", saved["roles"]["CLIENT"]["defaultTheme"] == "volt")
check("coach untouched", saved["roles"]["COACH"]["defaultTheme"] == "noir")
check("client reads the new slice", M.get_my_appearance_policy(client)["policy"]["defaultTheme"] == "volt")

print("== validation ==")
bad_roles = copy.deepcopy(roles); bad_roles["CLIENT"]["themes"] = ["noir", "disco"]
check("unknown theme rejected", status_of(M.admin_save_appearance_policy, M.AppearancePolicyPayload(roles=bad_roles), admin) == 400)
bad_roles = copy.deepcopy(roles); bad_roles["CLIENT"]["themes"] = []
check("empty theme list rejected", status_of(M.admin_save_appearance_policy, M.AppearancePolicyPayload(roles=bad_roles), admin) == 400)
bad_roles = copy.deepcopy(roles); bad_roles["CLIENT"]["themes"] = ["noir"]; bad_roles["CLIENT"]["defaultTheme"] = "volt"
check("default must be one of the allowed themes", status_of(M.admin_save_appearance_policy, M.AppearancePolicyPayload(roles=bad_roles), admin) == 400)
bad_roles = copy.deepcopy(roles); bad_roles["CLIENT"]["themes"] = "noir"
check("themes must be a list", status_of(M.admin_save_appearance_policy, M.AppearancePolicyPayload(roles=bad_roles), admin) == 400)

print("== reset counter ==")
reset_roles = copy.deepcopy(M.admin_get_appearance_policy(admin)["roles"])
before = reset_roles["CLIENT"]["resetCounter"]
reset_roles["CLIENT"]["resetNow"] = True
after = M.admin_save_appearance_policy(M.AppearancePolicyPayload(roles=reset_roles), admin)["roles"]["CLIENT"]["resetCounter"]
check("resetNow bumps the counter", after == before + 1)
check("resetNow is not stored", "resetNow" not in M.admin_get_appearance_policy(admin)["roles"]["CLIENT"])

print("== settings saved by the old screen ==")
TABLE.put_item({**M.APPEARANCE_KEY, "type": "SETTINGS", "updatedAt": "x", "roles": {"CLIENT": {
    "allowCustomize": True, "styles": ["oldgym", "navy"], "palettes": ["sepia"], "scenes": ["auto"], "themes": ["dark"],
    "allowMotionToggle": True, "allowVibrancy": True, "resetCounter": 2,
    "defaults": {"style": "navy", "palette": "azure", "scene": "auto", "theme": "dark", "motion": "on", "vibrancy": 100}}}})
old = M.get_my_appearance_policy(client)["policy"]
check("old styles map onto themes", old["themes"] == ["iron", "carbon"])
check("old default style picks the default theme", old["defaultTheme"] == "carbon")
check("reset counter preserved", old["resetCounter"] == 2)
check("old settings no longer leak style keys", "styles" not in old and "defaults" not in old)

print("== customisation switched off ==")
off = copy.deepcopy(M.admin_get_appearance_policy(admin)["roles"])
off["CLIENT"].update({"allowCustomize": False, "themes": ["forest"], "defaultTheme": "forest"})
M.admin_save_appearance_policy(M.AppearancePolicyPayload(roles=off), admin)
forced = M.get_my_appearance_policy(client)["policy"]
check("locked role still receives a theme list", forced["allowCustomize"] is False and forced["themes"] == ["forest"])

print("== mascot brand switch ==")
check("the mascot is on by default", M.admin_get_appearance_policy(admin)["mascot"] is True)
check("clients read the mascot switch", M.get_my_appearance_policy(client)["mascot"] is True)
check("the sign-in screen can read it before sign-in", M.get_public_branding()["mascot"] is True)

mascot_roles = copy.deepcopy(M.admin_get_appearance_policy(admin)["roles"])
off = M.admin_save_appearance_policy(M.AppearancePolicyPayload(roles=mascot_roles, mascot=False), admin)
check("the admin can switch the mascot off", off["mascot"] is False)
check("the public sign-in screen follows the admin", M.get_public_branding()["mascot"] is False)
check("saving themes alone keeps the mascot off",
      M.admin_save_appearance_policy(M.AppearancePolicyPayload(roles=mascot_roles), admin)["mascot"] is False)
check("the mascot can be switched back on",
      M.admin_save_appearance_policy(M.AppearancePolicyPayload(roles=mascot_roles, mascot=True), admin)["mascot"] is True)
check("the theme policy is untouched by the mascot switch", M.get_my_appearance_policy(client)["policy"]["themes"] == ["forest"])

print(f"\n{ok} passed, {bad} failed"); raise SystemExit(1 if bad else 0)
