'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { INVITABLE_ROLE_KEYS } from '@/lib/team/team-helpers'
import {
  inviteTeamMember,
  resendInvitation,
  revokeInvitation,
  setMemberRole,
  setMembershipActive,
} from './actions'

export type MemberRow = {
  userId: string
  name: string | null
  email: string | null
  roleKey: string
  isActive: boolean
  isSelf: boolean
}

export type InvitationRow = {
  id: string
  email: string
  roleKey: string
  status: 'pending' | 'expired' | 'revoked' | 'provisioning_failed' | 'accepted'
}

const ROLE_LABELS: Record<string, string> = {
  company_admin: 'Company Admin',
  gm: 'General Manager',
  ops_manager: 'Ops Manager',
  maintenance_coordinator: 'Maintenance Coordinator',
  inspector: 'Inspector',
  maintenance_tech: 'Maintenance Tech',
  inventory_manager: 'Inventory Manager',
  finance: 'Finance',
  auditor: 'Auditor',
  property_owner_viewer: 'Owner (Viewer)',
}

/**
 * Mobile-first team manager: stacked cards, no tables. All mutations go
 * through server actions that re-verify company_admin — nothing here is
 * authorization, only convenience.
 */
export function TeamManager({
  members,
  invitations,
}: {
  members: MemberRow[]
  invitations: InvitationRow[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [notice, setNotice] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [shareLink, setShareLink] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [roleKey, setRoleKey] = useState<string>('inspector')

  const run = (fn: () => Promise<{ ok: boolean; code: string; error?: string; shareLink?: string }>) =>
    startTransition(async () => {
      setNotice(null)
      setErrorMsg(null)
      setShareLink(null)
      const res = await fn()
      if (!res.ok) {
        setErrorMsg(res.error ?? 'Something went wrong.')
        return
      }
      if (res.shareLink) {
        setShareLink(res.shareLink)
        setNotice('New invite link ready — share it via WhatsApp. It works once.')
      } else {
        setNotice(
          res.code === 'already_member'
            ? 'That person is already an active member.'
            : res.code === 'added_existing'
              ? 'Existing account added to your company — they can log in now.'
              : res.code === 'pending_email'
                ? 'Invitation sent. They must open the email link to join — nothing is granted until then. If the email does not arrive, use Share link.'
                : 'Done.',
        )
      }
      router.refresh()
    })

  return (
    <div className="mt-5 space-y-6">
      {errorMsg ? (
        <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {errorMsg}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
          {notice}
        </p>
      ) : null}
      {shareLink ? (
        <div className="rounded-md border border-slate-300 bg-slate-50 p-3">
          <p className="break-all font-mono text-xs text-slate-700">{shareLink}</p>
          <button
            type="button"
            className="mt-2 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
            onClick={() => void navigator.clipboard?.writeText(shareLink)}
          >
            Copy link
          </button>
        </div>
      ) : null}

      <section className="rounded-lg border border-slate-200 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Invite a person</h2>
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault()
            run(() => inviteTeamMember({ email, roleKey }))
          }}
        >
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.co.za"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <select
            value={roleKey}
            onChange={(e) => setRoleKey(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            {INVITABLE_ROLE_KEYS.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r] ?? r}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Invite
          </button>
        </form>
      </section>

      {invitations.length > 0 ? (
        <section className="rounded-lg border border-slate-200 p-4">
          <h2 className="text-sm font-semibold text-slate-900">Pending invitations</h2>
          <ul className="mt-3 space-y-3">
            {invitations.map((inv) => (
              <li key={inv.id} className="rounded-md border border-slate-200 p-3">
                <p className="text-sm font-medium text-slate-900">{inv.email}</p>
                <p className="text-xs text-slate-500">
                  {ROLE_LABELS[inv.roleKey] ?? inv.roleKey} · {inv.status}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={pending || inv.status === 'revoked'}
                    onClick={() => run(() => resendInvitation({ invitationId: inv.id }))}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                  >
                    Share link
                  </button>
                  <button
                    type="button"
                    disabled={pending || inv.status === 'revoked'}
                    onClick={() => run(() => revokeInvitation({ invitationId: inv.id }))}
                    className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-lg border border-slate-200 p-4">
        <h2 className="text-sm font-semibold text-slate-900">
          Team members ({members.filter((m) => m.isActive).length} active)
        </h2>
        <ul className="mt-3 space-y-3">
          {members.map((m) => (
            <li key={m.userId} className="rounded-md border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-900">
                {m.name ?? m.email ?? m.userId}
                {m.isSelf ? <span className="text-slate-400"> (you)</span> : null}
              </p>
              <p className="text-xs text-slate-500">
                {m.email ?? '—'} · {m.isActive ? 'active' : 'deactivated'}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  value={m.roleKey}
                  disabled={pending}
                  onChange={(e) =>
                    run(() => setMemberRole({ userId: m.userId, roleKey: e.target.value }))
                  }
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                >
                  {INVITABLE_ROLE_KEYS.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r] ?? r}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(() => setMembershipActive({ userId: m.userId, active: !m.isActive }))
                  }
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                    m.isActive
                      ? 'border-red-300 text-red-700'
                      : 'border-emerald-300 text-emerald-700'
                  }`}
                >
                  {m.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
