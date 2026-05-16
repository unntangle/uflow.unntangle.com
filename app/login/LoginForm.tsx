'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail, Lock, Eye, EyeOff } from 'lucide-react';
import { crmFetch, crmPath } from '../lib/client-fetch';

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await crmFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed.');
        return;
      }
      // Server returns { redirect: '/artist' } etc. Prefix /crm in
      // local dev (no-op on the subdomain) so the router navigates
      // to the correct path.
      const target = data.redirect || '/';
      router.push(crmPath(target));
      router.refresh();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="crm-login-form">
      {/* Email */}
      <div className="crm-login-field">
        <label className="crm-login-label" htmlFor="email">
          Email address
        </label>
        <div className="crm-login-input-wrap">
          <Mail
            size={16}
            strokeWidth={1.75}
            className="crm-login-input-icon"
            aria-hidden="true"
          />
          <input
            id="email"
            type="email"
            className="crm-login-input"
            placeholder="you@company.com"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>

      {/* Password (with show/hide toggle) */}
      <div className="crm-login-field">
        <label className="crm-login-label" htmlFor="password">
          Password
        </label>
        <div className="crm-login-input-wrap">
          <Lock
            size={16}
            strokeWidth={1.75}
            className="crm-login-input-icon"
            aria-hidden="true"
          />
          <input
            id="password"
            type={showPassword ? 'text' : 'password'}
            className="crm-login-input"
            placeholder="••••••••"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {/* Reveal toggle. We swap the icon (not a separate
              "Show"/"Hide" label) so the field stays compact. */}
          <button
            type="button"
            className="crm-login-input-toggle"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? (
              <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Row: Remember me + Forgot password.
          "Forgot password" is a mailto for now — there's no
          reset flow yet, and a dead link would be worse than
          one that opens an email draft to the admin. */}
      <div className="crm-login-row">
        <label className="crm-login-check">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>Remember me</span>
        </label>
        <a
          className="crm-login-forgot"
          href="mailto:hello@unntangle.com?subject=uFLOW%20password%20reset"
        >
          Forgot password?
        </a>
      </div>

      {error && <div className="crm-login-error">{error}</div>}

      <button
        type="submit"
        className="crm-login-submit"
        disabled={loading}
      >
        {loading ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
