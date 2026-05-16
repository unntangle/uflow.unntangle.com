'use client';

import { useRouter } from 'next/navigation';
import { crmFetch, crmPath } from '../lib/client-fetch';

type Props = {
  name: string;
  role: '3d_artist' | 'qa' | 'admin';
};

const roleLabel: Record<Props['role'], string> = {
  '3d_artist': '3D Artist',
  qa: 'QA Reviewer',
  admin: 'Admin',
};

export default function NavBar({ name, role }: Props) {
  const router = useRouter();
  async function logout() {
    await crmFetch('/api/auth/logout', { method: 'POST' });
    router.push(crmPath('/login'));
    router.refresh();
  }
  return (
    <nav className="crm-nav">
      <div className="crm-brand">
        <span className="crm-brand-dot" />
        Unntangle CRM
      </div>
      <div className="crm-nav-right">
        <div className="crm-nav-user">
          <strong>{name}</strong>
          <span>{roleLabel[role]}</span>
        </div>
        <button className="crm-logout" onClick={logout}>
          Log out
        </button>
      </div>
    </nav>
  );
}
