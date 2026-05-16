import { redirect } from 'next/navigation';
import { getSession } from '../lib/session';
import { dashboardPathFor } from '../lib/auth';
import LoginForm from './LoginForm';

// ============================================================
// Login page — single centered sign-in card.
//
// The split-screen marketing layout was dropped in favour of
// a focused, centered form that works the same on every viewport.
// ============================================================

// Server component: if already logged in, bounce to dashboard.
export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect(dashboardPathFor(session.role));

  return (
    <div className="crm-login-center">
      <div className="crm-login-form-inner">
        {/* Logo stack — mirrors the sidebar's brand mark so
            uFLOW reads consistently between the unauth and
            auth surfaces. */}
        <div className="crm-login-brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/uflow/uflow-logo.webp"
            alt="uFLOW"
            className="crm-login-brand-logo"
          />
          <span className="crm-login-brand-tagline">
            by <span className="crm-login-brand-tagline-accent">unntangle</span>
          </span>
        </div>

        <h1 className="crm-login-title">Sign in</h1>
        <p className="crm-login-sub">
          Welcome back. Enter your credentials to continue.
        </p>

        <LoginForm />
      </div>
    </div>
  );
}
