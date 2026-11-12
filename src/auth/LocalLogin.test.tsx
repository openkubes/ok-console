import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AuthEntry from './AuthEntry'

describe('ordinary ok-local login', () => {
  it('uses password login without exceptional-access reason or MFA claims', async () => {
    const authenticated = vi.fn()
    const login = vi.fn(async () => ({method:'local' as const,identity:'reader',source:'Local account',assurance:'Password',expiresIn:'15 minutes'}))
    render(<AuthEntry authMode="local" onAuthenticated={authenticated} onAuthenticateLocal={login}/>)
    expect(screen.queryByLabelText('Operational reason')).not.toBeInTheDocument()
    expect(screen.getByText(/password authentication without MFA/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Username'),{target:{value:'reader'}})
    fireEvent.change(screen.getByLabelText('Password'),{target:{value:'disposable-example-password'}})
    fireEvent.click(screen.getByRole('button',{name:'Sign in'}))
    await waitFor(()=>expect(authenticated).toHaveBeenCalledOnce())
    expect(screen.getByLabelText('Password')).toHaveValue('')
  })
  it('clears entered credentials and shows a generic failure', async () => {
    render(<AuthEntry authMode="local" onAuthenticated={vi.fn()} onAuthenticateLocal={async()=>{throw new Error('internal credential detail')}}/>)
    fireEvent.change(screen.getByLabelText('Username'),{target:{value:'reader'}})
    fireEvent.change(screen.getByLabelText('Password'),{target:{value:'disposable-example-password'}})
    fireEvent.click(screen.getByRole('button',{name:'Sign in'}))
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Local sign-in could not be completed.'))
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.queryByText('internal credential detail')).not.toBeInTheDocument()
  })
})
