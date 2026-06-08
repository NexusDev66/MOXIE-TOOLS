'use client';

import { useActionState } from 'react';
import { sendMagicLink, type LoginState } from './actions';

const initial: LoginState = {};

export function LoginForm() {
  const [state, action, pending] = useActionState(sendMagicLink, initial);

  return (
    <form action={action} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium mb-1">
          邮箱
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="admin@example.com"
          disabled={pending}
          className="w-full px-3 py-2 rounded-md border border-border bg-card focus:outline-none focus:ring-2 focus:ring-foreground/20"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="w-full px-4 py-2 rounded-md bg-foreground text-background font-medium disabled:opacity-50"
      >
        {pending ? '发送中…' : '发送 magic link'}
      </button>
      {state.error && <p className="text-sm text-rose-500">{state.error}</p>}
      {state.ok && state.message && (
        <p className="text-sm text-emerald-600">{state.message}</p>
      )}
    </form>
  );
}
