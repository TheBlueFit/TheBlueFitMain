"use client";

import React, { useEffect, useState } from "react";
import { Check, Copy, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { AdminSecurityStatus, dashboardAPI } from "@/services/api";

const card: React.CSSProperties = {
  background: "var(--bg-input)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-md)",
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const input: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  background: "rgb(var(--well-rgb) / 0.4)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm)",
  color: "var(--text-primary)",
  fontSize: 14,
  outline: "none",
};

/**
 * Admin → Security: two-factor for the administrator's own account.
 * Password alone gets nobody in once this is on; the authenticator app supplies the second factor.
 */
export default function AdminSecurity() {
  const [status, setStatus] = useState<AdminSecurityStatus | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [busy, setBusy] = useState<null | "start" | "enable" | "disable">(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () =>
    dashboardAPI
      .getAdminSecurity()
      .then(setStatus)
      .catch((e: any) => setMsg({ ok: false, text: e?.message || "Could not load security settings." }));

  useEffect(() => {
    load();
  }, []);

  const start = async () => {
    setBusy("start");
    setMsg(null);
    setRecovery(null);
    try {
      const res = await dashboardAPI.startAdminMfa();
      setSecret(res.secret);
      setOtpauthUrl(res.otpauthUrl);
      setMsg({ ok: true, text: "Add the key below to your authenticator app, then enter the code it shows." });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || "Could not start two-factor setup." });
    } finally {
      setBusy(null);
    }
  };

  const enable = async () => {
    setBusy("enable");
    setMsg(null);
    try {
      const res = await dashboardAPI.enableAdminMfa(code.trim());
      setRecovery(res.recoveryCodes);
      setSecret(null);
      setOtpauthUrl(null);
      setCode("");
      setMsg({ ok: true, text: "Two-factor is on. Save the backup codes below somewhere safe." });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || "Could not switch two-factor on." });
    } finally {
      setBusy(null);
    }
  };

  const disable = async () => {
    setBusy("disable");
    setMsg(null);
    try {
      await dashboardAPI.disableAdminMfa(password, disableCode.trim());
      setPassword("");
      setDisableCode("");
      setRecovery(null);
      setMsg({ ok: true, text: "Two-factor is off. Your password alone signs you in again." });
      await load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || "Could not switch two-factor off." });
    } finally {
      setBusy(null);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setMsg({ ok: false, text: "Copying failed — select the text and copy it by hand." });
    }
  };

  if (!status) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary)" }}>
        {msg ? <div className="error-banner">{msg.text}</div> : "Loading security settings…"}
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div className="section-header" style={{ marginBottom: 8 }}>
        <h2 style={{ fontSize: 16 }}>Security</h2>
      </div>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55, marginBottom: 16 }}>
        Protect the admin account with an authenticator app (Google Authenticator, Authy, 1Password…). Once it is
        on, your password alone cannot open this dashboard.
      </p>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ShieldCheck size={18} color={status.mfaEnabled ? "var(--success, #4ade80)" : "var(--text-secondary)"} />
            <div>
              <strong style={{ fontSize: 14, color: "var(--text-primary)" }}>Authenticator app</strong>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                {status.mfaEnabled
                  ? `On · ${status.recoveryCodesRemaining} backup code${status.recoveryCodesRemaining === 1 ? "" : "s"} left`
                  : "Off — your password is the only step"}
              </div>
            </div>
          </div>
          {!status.mfaEnabled && !secret && (
            <button type="button" className="btn-primary" onClick={start} disabled={busy !== null} style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
              {busy === "start" ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Set up
            </button>
          )}
        </div>

        {secret && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid var(--border-subtle)", paddingTop: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 }}>
                Type this key into your authenticator app (or use the otpauth link)
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <code style={{ fontSize: 14, letterSpacing: 1, padding: "10px 12px", borderRadius: 10, background: "rgb(var(--well-rgb) / 0.6)", border: "1px solid var(--border-subtle)", wordBreak: "break-all" }}>
                  {secret}
                </code>
                <button type="button" className="btn-secondary" onClick={() => copy(secret)} style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 6 }}>
                  {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
                </button>
              </div>
              {otpauthUrl && (
                <a href={otpauthUrl} style={{ display: "inline-block", marginTop: 8, fontSize: 12, color: "var(--accent-gold)" }}>
                  Open in your authenticator app
                </a>
              )}
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-secondary)" }}>Code shown by the app</label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                maxLength={6}
                style={{ ...input, marginTop: 6 }}
              />
            </div>
            <button type="button" className="btn-primary" onClick={enable} disabled={busy !== null || code.trim().length < 6} style={{ padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              {busy === "enable" ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Turn on two-factor
            </button>
          </div>
        )}

        {recovery && (
          <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 12 }}>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>
              Backup codes — each works once if you lose your phone. They are shown only now.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
              {recovery.map((c) => (
                <code key={c} style={{ fontSize: 13, padding: "8px 10px", borderRadius: 8, background: "rgb(var(--well-rgb) / 0.6)", border: "1px solid var(--border-subtle)", textAlign: "center" }}>
                  {c}
                </code>
              ))}
            </div>
            <button type="button" className="btn-secondary" onClick={() => copy(recovery.join("\n"))} style={{ marginTop: 10, padding: "8px 12px", display: "flex", alignItems: "center", gap: 6 }}>
              <Copy size={14} /> Copy all
            </button>
          </div>
        )}

        {status.mfaEnabled && (
          <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Switch it off: confirm with your password and a current code.</div>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" style={input} />
            <input value={disableCode} onChange={(e) => setDisableCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="Authenticator or backup code" maxLength={12} style={input} />
            <button type="button" className="btn-secondary" onClick={disable} disabled={busy !== null || !password || !disableCode.trim()} style={{ padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              {busy === "disable" ? <Loader2 size={14} className="animate-spin" /> : null} Turn off two-factor
            </button>
          </div>
        )}

        {msg && (
          <div style={{ fontSize: 12, color: msg.ok ? "var(--text-secondary)" : "var(--danger)" }}>{msg.text}</div>
        )}
      </div>
    </div>
  );
}
